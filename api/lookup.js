// Serverless function (Vercel). Serves price comparisons primarily from
// a persistent cache (Upstash Redis, free tier), which is kept warm by
// api/refresh-batch.js running on a schedule. This is what lets the site
// handle many simultaneous visitors on TinyFish's free (heavily
// rate-limited) tier: user traffic reads the cache — fast, and never
// touches TinyFish's rate limit — while a separate background job is the
// only thing that actually calls TinyFish.
//
// If a product hasn't been cached yet (e.g. right after first deploy,
// before the background job has reached it), this falls back to a live
// lookup so the page still works, then saves that result for next time.

import { Redis } from '@upstash/redis';
import { RETAILERS, cacheKeyFor } from '../lib/catalog.js';
import { fetchLivePrices } from '../lib/priceEngine.js';

function getRedis() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST' });
    return;
  }

  const { brand, name, catKey, force } = req.body || {};
  if (!brand || !name) {
    res.status(400).json({ error: 'Missing brand or name in request body.' });
    return;
  }

  const redis = getRedis();
  const key = cacheKeyFor(brand, name);

  if (redis && !force) {
    try {
      const cached = await redis.get(key);
      if (cached) {
        // @upstash/redis auto-parses JSON values
        const payload = typeof cached === 'string' ? JSON.parse(cached) : cached;
        res.status(200).json({ ...payload, cached: true });
        return;
      }
    } catch (err) {
      // Cache read failed — fall through to a live lookup rather than error out.
    }
  }

  const apiKey = process.env.TINYFISH_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Server is missing TINYFISH_API_KEY. Set it in your Vercel project settings.' });
    return;
  }

  const payload = await fetchLivePrices(apiKey, brand, name, catKey, RETAILERS);
  const payloadWithMeta = { ...payload, cached: false, updatedAt: Date.now() };

  if (redis) {
    try {
      // 6 hour safety-net TTL — the background refresh job should
      // overwrite this well before it expires, but this stops permanently
      // stale data from lingering if the refresh job ever stops running.
      await redis.set(key, JSON.stringify(payloadWithMeta), { ex: 6 * 60 * 60 });
    } catch (err) {
      // Non-fatal — the user still gets their live result even if caching it fails.
    }
  }

  res.status(200).json(payloadWithMeta);
}
