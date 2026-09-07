import { Redis } from '@upstash/redis';
import { RETAILERS, PRODUCTS, cacheKeyFor } from '../lib/catalog.js';
import { fetchLivePrices } from '../lib/priceEngine.js';
import { CACHE_VERSION, cacheTtl, readCached } from '../lib/cache.js';

export function createHandler({ redisFactory = () => {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? new Redis({ url, token, retry: false, signal: () => AbortSignal.timeout(1000) }) : null;
}, lookup = fetchLivePrices } = {}) {
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
    if (redis && !force) {
      try {
        const cached = readCached(await redis.get(key));
        if (cached) return res.status(200).json({ ...cached, cached: true });
      } catch { /* A failed cache read may fall back to the live provider. */ }
    }
    const apiKey = process.env.TINYFISH_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'Price lookup is not configured. The site owner must check the search provider settings.' });
    try {
      const payload = await lookup(apiKey, brand, name, product.cat, RETAILERS);
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
