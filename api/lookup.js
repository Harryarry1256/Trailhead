import { Redis } from '@upstash/redis';
import { RETAILERS, PRODUCTS, cacheKeyFor } from '../lib/catalog.js';
import { fetchLivePrices } from '../lib/priceEngine.js';
import { CACHE_VERSION, cacheTtl, readCached } from '../lib/cache.js';
import { createProviderFetch } from '../lib/provider.js';

export function createHandler({ redisFactory = () => {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? new Redis({ url, token, retry: false, signal: () => AbortSignal.timeout(1000) }) : null;
}, lookup = fetchLivePrices } = {}) {
  let providerFetch;
  const pending = new Map();
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'Use POST' });
    }
    const { brand, name, catKey, force } = req.body || {};
    if (typeof brand !== 'string' || typeof name !== 'string' ||
        (force !== undefined && typeof force !== 'boolean')) {
      return res.status(400).json({ error: 'Invalid product lookup request.' });
    }
    const product = PRODUCTS.find(p => p.brand === brand && p.name === name);
    if (!product || (catKey !== undefined && catKey !== product.cat)) {
      return res.status(400).json({ error: 'Choose a product from the catalog.' });
    }
    let redis;
    try { redis = redisFactory(); } catch { redis = null; }
    const key = cacheKeyFor(brand, name);
    let cached;
    if (redis) {
      try {
        cached = readCached(await redis.get(key));
        if (cached && !force) return res.status(200).json({ ...cached, cached: true });
      } catch { /* A failed cache read may fall back to the live provider. */ }
    }
    const apiKey = process.env.TINYFISH_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'Price lookup is not configured. The site owner must check the search provider settings.' });
    try {
      providerFetch ||= createProviderFetch(redis, apiKey);
      if (!pending.has(key)) {
        const task = Promise.resolve().then(() => lookup(apiKey, brand, name, product.cat, RETAILERS, { providerFetch }));
        pending.set(key, task);
        task.finally(() => pending.delete(key)).catch(() => {});
      }
      const payload = await pending.get(key);
      // A failed forced refresh must not erase a still-valid verified price
      // or give the old price a new check timestamp.
      if (cached && payload.results.some(r => r.status === 'unavailable')) {
        const results = payload.results.map(row => {
          const previous = cached.results.find(r => r.retailer === row.retailer && r.status === 'verified');
          return row.status === 'unavailable' && previous ? previous : row;
        });
        if (results.some((row, i) => row !== payload.results[i])) {
          return res.status(200).json({ ...payload, results, schemaVersion: CACHE_VERSION,
            updatedAt: cached.updatedAt, cached: false, refreshFailed: true,
            retryAfter: payload.retryAfter || 60 });
        }
      }
      const result = { ...payload, schemaVersion: CACHE_VERSION, cached: false, updatedAt: Date.now() };
      const ttl = cacheTtl(payload);
      if (redis && ttl) {
        try { await redis.set(key, JSON.stringify(result), { ex: ttl }); } catch { /* Non-fatal. */ }
      }
      return res.status(200).json(result);
    } catch {
      return res.status(503).json({ error: 'Price lookup is temporarily unavailable. Please try again.' });
    }
  };
}
export default createHandler();
