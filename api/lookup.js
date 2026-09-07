import { Redis } from '@upstash/redis';
import { PRODUCTS, cacheKeyFor } from '../lib/catalog.js';
import { MAX_CACHE_AGE_MS, readCached } from '../lib/cache.js';

export function createHandler({ redisFactory = () => {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? new Redis({ url, token, retry: false, signal: () => AbortSignal.timeout(1000) }) : null;
} } = {}) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({ error: 'Use POST' });
    }
    // Accept force from older browser tabs, but never bypass the scheduled cache.
    const { brand, name, catKey, force } = req.body || {};
    if (typeof brand !== 'string' || typeof name !== 'string' ||
        (force !== undefined && typeof force !== 'boolean')) {
      return res.status(400).json({ error: 'Invalid product lookup request.' });
    }
    const product = PRODUCTS.find(p => p.brand === brand && p.name === name);
    if (!product || (catKey !== undefined && catKey !== product.cat)) {
      return res.status(400).json({ error: 'Choose a product from the catalog.' });
    }
    try {
      const redis = redisFactory();
      if (!redis) throw new Error('Cache not configured');
      const cached = readCached(await redis.get(cacheKeyFor(brand, name)), Date.now(), { allowStale: true });
      if (cached) return res.status(200).json({ ...cached, cached: true,
        stale: Date.now() - cached.updatedAt >= MAX_CACHE_AGE_MS });
      return res.status(200).json({ cached: false, pending: true, complete: false, results: [],
        note: 'Prices for this product are awaiting a scheduled update. Please check back later.' });
    } catch {
      return res.status(503).json({ error: 'Saved prices are temporarily unavailable. Please try again shortly.' });
    }
  };
}
export default createHandler();
