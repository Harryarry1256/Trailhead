// Two concurrent products share provider pacing and the existing 30s runtime.
import { Redis } from '@upstash/redis';
import { RETAILERS, PRODUCTS, cacheKeyFor } from '../lib/catalog.js';
import { fetchLivePrices } from '../lib/priceEngine.js';
import { CACHE_VERSION, cacheTtl, readCached } from '../lib/cache.js';
import { createProviderFetch } from '../lib/provider.js';

const CURSOR_KEY = 'refresh:cursor';
const DISCOVERY_TTL = 7 * 24 * 60 * 60;
export const REFRESH_BATCH_SIZE = 2;
export function createHandler({ redisFactory = () => new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN,
  retry: false, signal: () => AbortSignal.timeout(1000)
}), lookup = fetchLivePrices, batchSize = REFRESH_BATCH_SIZE } = {}) {
  let providerFetch;
  return async function handler(req, res) {
    const secret = req.query?.secret || req.headers['x-refresh-secret'];
    if (!process.env.REFRESH_SECRET || secret !== process.env.REFRESH_SECRET) {
      return res.status(401).json({ error: 'Missing or invalid secret.' });
    }
    const apiKey = process.env.TINYFISH_API_KEY;
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!apiKey || !url || !token) return res.status(503).json({ error: 'Refresh provider or cache is not configured.' });
    try {
      const redis = redisFactory();
      const stored = Number(await redis.get(CURSOR_KEY));
      const cursor = Number.isInteger(stored) && stored >= 0 ? stored % PRODUCTS.length : 0;
      providerFetch ||= createProviderFetch(redis, apiKey);
      const batch = Array.from({ length: Math.min(batchSize, PRODUCTS.length) },
        (_, offset) => PRODUCTS[(cursor + offset) % PRODUCTS.length]);
      const outcomes = await Promise.all(batch.map(async product => {
        const key = cacheKeyFor(product.brand, product.name);
        const discoveryKey = `discovery:v1:${key}`;
        const [discovery, previous] = await Promise.all([
          redis.get(discoveryKey), redis.get(key)
        ]);
        const saved = readCached(previous, Date.now(), { allowStale: true });
        // false explicitly invalidates a removed page. A missing discovery
        // entry can be bootstrapped from the existing verified price cache.
        const knownListings = discovery === false ? [] :
          Array.isArray(discovery) ? discovery : saved?.results || [];
        const payload = await lookup(apiKey, product.brand, product.name, product.cat, RETAILERS,
          { providerFetch, knownListings });
        const ttl = cacheTtl(payload);
        if (payload.rediscover) {
          await redis.set(discoveryKey, false, { ex: DISCOVERY_TTL });
        } else if (ttl) {
          await redis.set(discoveryKey, payload.results.filter(r => r.status === 'verified'),
            { ex: DISCOVERY_TTL });
        }
        if (ttl) {
          await redis.set(key, JSON.stringify({
            ...payload, schemaVersion: CACHE_VERSION, cached: true, updatedAt: Date.now()
          }), { ex: ttl });
        }
        return { product, payload, saved: !!ttl };
      }));
      const nextCursor = (cursor + batch.length) % PRODUCTS.length;
      await redis.set(CURSOR_KEY, nextCursor);
      // A missing listing or provider timeout is a product-level result, not
      // a failed scheduler run. Complete products are saved and errors remain
      // visible in the response while the cursor advances.
      return res.status(200).json({
        processed: batch.map(p => `${p.brand} ${p.name}`),
        saved: outcomes.every(o => o.saved), savedCount: outcomes.filter(o => o.saved).length,
        partial: outcomes.some(o => !o.payload.complete),
        cursor, nextCursor, totalProducts: PRODUCTS.length,
        errors: outcomes.flatMap(o => o.payload.results
          .filter(r => r.status === 'unavailable' || r.status === 'unverified')
          .map(r => ({ product: `${o.product.brand} ${o.product.name}`,
            retailer: r.retailer, status: r.status, error: r.error_code })))
      });
    } catch {
      return res.status(503).json({ error: 'Refresh failed. Check the cache and provider configuration.' });
    }
  };
}
export default createHandler();
