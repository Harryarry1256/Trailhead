// Serverless function (Vercel). This is what actually calls TinyFish —
// user traffic never does. An external free scheduler (e.g. cron-job.org,
// since Vercel's own Hobby cron only allows once/day) hits this route
// every few minutes. Each call processes ONE product from the catalog
// (4 retailer checks — exactly the rate-limit budget, so it never has to
// wait) and stores the result in Redis. It advances a cursor each time,
// cycling through the whole catalog on a rolling basis.
//
// With ~60 products and a call every 2 minutes, the full catalog
// refreshes roughly every 2 hours — plenty fresh for retail prices.
//
// Protected by a shared secret so randoms can't spam your TinyFish quota
// by hitting this URL directly.

import { Redis } from '@upstash/redis';
import { RETAILERS, PRODUCTS, cacheKeyFor } from '../lib/catalog.js';
import { fetchLivePrices } from '../lib/priceEngine.js';

const CURSOR_KEY = 'refresh:cursor';

const BATCH_SIZE = 5; // 5 products × 4 retailers = 20 calls/run, safely under the real 30/min limit

export default async function handler(req, res) {
  const secret = req.query?.secret || req.headers['x-refresh-secret'];
  if (!process.env.REFRESH_SECRET || secret !== process.env.REFRESH_SECRET) {
    res.status(401).json({ error: 'Missing or invalid secret.' });
    return;
  }

  const apiKey = process.env.TINYFISH_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Server is missing TINYFISH_API_KEY.' });
    return;
  }

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    res.status(500).json({ error: 'Server is missing UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN.' });
    return;
  }
  const redis = new Redis({ url, token });

  let cursor = 0;
  try {
    const stored = await redis.get(CURSOR_KEY);
    cursor = typeof stored === 'number' ? stored : parseInt(stored, 10) || 0;
  } catch {
    cursor = 0;
  }

  const processed = [];
  for (let i = 0; i < BATCH_SIZE; i++) {
    const product = PRODUCTS[(cursor + i) % PRODUCTS.length];
    const payload = await fetchLivePrices(apiKey, product.brand, product.name, product.cat, RETAILERS);
    const payloadWithMeta = { ...payload, cached: true, updatedAt: Date.now() };
    try {
      await redis.set(cacheKeyFor(product.brand, product.name), JSON.stringify(payloadWithMeta), { ex: 6 * 60 * 60 });
    } catch (err) {
      res.status(500).json({ error: `Refreshed but failed to save to cache: ${err.message}`, processed });
      return;
    }
    processed.push(`${product.brand} ${product.name}`);
  }

  const nextCursor = (cursor + BATCH_SIZE) % PRODUCTS.length;
  try {
    await redis.set(CURSOR_KEY, nextCursor);
  } catch (err) {
    res.status(500).json({ error: `Processed but failed to save cursor: ${err.message}`, processed });
    return;
  }

  res.status(200).json({ processed, cursor, nextCursor, totalProducts: PRODUCTS.length });
}
