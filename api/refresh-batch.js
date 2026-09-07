// One product per invocation keeps search + page fetch within the 30s runtime.
import { Redis } from '@upstash/redis';
import { RETAILERS, PRODUCTS, cacheKeyFor } from '../lib/catalog.js';
import { fetchLivePrices } from '../lib/priceEngine.js';
import { CACHE_VERSION, cacheTtl, readCached } from '../lib/cache.js';
import { createProviderFetch } from '../lib/provider.js';

const CURSOR_KEY = 'refresh:cursor';
let providerFetch;

export default async function handler(req, res) {
  const secret = req.query?.secret || req.headers['x-refresh-secret'];
  if (!process.env.REFRESH_SECRET || secret !== process.env.REFRESH_SECRET) {
    return res.status(401).json({ error: 'Missing or invalid secret.' });
  }
  const apiKey = process.env.TINYFISH_API_KEY;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!apiKey || !url || !token) return res.status(503).json({ error: 'Refresh provider or cache is not configured.' });
  try {
    const redis = new Redis({ url, token, retry: false, signal: () => AbortSignal.timeout(1000) });
    const stored = Number(await redis.get(CURSOR_KEY));
    const cursor = Number.isInteger(stored) && stored >= 0 ? stored % PRODUCTS.length : 0;
    const product = PRODUCTS[cursor];
    const key = cacheKeyFor(product.brand, product.name);
    const cached = readCached(await redis.get(key));
    if (cached) {
      await redis.set(CURSOR_KEY, (cursor + 1) % PRODUCTS.length);
      return res.status(200).json({ skipped: 'Prices are still fresh', cursor });
    }
    providerFetch ||= createProviderFetch(redis, apiKey);
    const payload = await fetchLivePrices(apiKey, product.brand, product.name, product.cat, RETAILERS, { providerFetch });
    const ttl = cacheTtl(payload);
    if (ttl) {
      await redis.set(cacheKeyFor(product.brand, product.name), JSON.stringify({
        ...payload, schemaVersion: CACHE_VERSION, cached: true, updatedAt: Date.now()
      }), { ex: ttl });
    }
    // Advance even on a blocked retailer so one product cannot stall the catalog.
    const nextCursor = (cursor + 1) % PRODUCTS.length;
    await redis.set(CURSOR_KEY, nextCursor);
    return res.status(payload.complete ? 200 : 502).json({
      processed: [`${product.brand} ${product.name}`], saved: !!ttl,
      cursor, nextCursor, totalProducts: PRODUCTS.length,
      errors: payload.results.filter(r => r.status === 'unavailable' || r.status === 'unverified')
        .map(r => ({ retailer: r.retailer, status: r.status, error: r.error_code }))
    });
  } catch {
    return res.status(503).json({ error: 'Refresh failed. Check the cache and provider configuration.' });
  }
}
