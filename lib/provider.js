import { createHash, randomUUID } from 'node:crypto';

// A shared rolling window includes both manual checks and background refreshes.
// Leave headroom below TinyFish's default 30 requests/minute allowance.
export const RESERVE_REQUEST = `
local now = tonumber(ARGV[1])
local paused = tonumber(redis.call('GET', KEYS[2]) or '0')
if paused > now then return paused - now end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - 60000)
if redis.call('ZCARD', KEYS[1]) >= 26 then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  return math.max(1, tonumber(oldest[2]) + 60000 - now)
end
redis.call('ZADD', KEYS[1], now, ARGV[2])
redis.call('PEXPIRE', KEYS[1], 61000)
return 0`;

export function retryDelay(value, now = Date.now()) {
  if (!value) return 60000;
  const seconds = Number(value);
  return Math.max(1000, Number.isFinite(seconds) ? seconds * 1000 : (Date.parse(value) - now) || 60000);
}

export function createProviderFetch(redis, apiKey, { fetchImpl = fetch, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const prefix = `provider:v1:${createHash('sha256').update(apiKey).digest('hex').slice(0, 16)}`;
  const pending = new Map();
  const recent = new Map();
  let timestamps = [];
  let pausedUntil = 0;

  return async function providerFetch(url, init = {}) {
    const search = url.startsWith('https://api.search.tinyfish.ai?');
    const key = `${prefix}:search:${createHash('sha256').update(url).digest('hex')}`;
    const jsonResponse = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
    if (search) {
      const entry = recent.get(key);
      if (entry && entry.expires > now()) return jsonResponse(entry.data);
      try {
        const cached = redis && await redis.get(key);
        if (cached && Array.isArray(cached.results)) return jsonResponse(cached);
      } catch { /* Local pacing still applies during a cache outage. */ }
      if (pending.has(key)) return (await pending.get(key)).clone();
    }
    const task = (async () => {
      // Keep sufficient time for page retrieval within the function deadline.
      const waitDeadline = now() + 4000;
      while (true) {
        init.signal?.throwIfAborted();
        let delay;
        try {
          if (!redis) throw new Error('No shared cache');
          delay = Number(await redis.eval(RESERVE_REQUEST,
            [`${prefix}:requests`, `${prefix}:pause`], [now(), randomUUID()]));
          if (!Number.isFinite(delay)) throw new Error('Invalid reservation');
        } catch {
          timestamps = timestamps.filter(time => time > now() - 60000);
          delay = Math.max(0, pausedUntil - now(), timestamps.length >= 26 ? timestamps[0] + 60000 - now() : 0);
          if (!delay) timestamps.push(now());
        }
        if (!delay) break;
        if (now() + delay > waitDeadline) return new Response('', {
          status: 429, headers: { 'Retry-After': String(Math.ceil(delay / 1000)) }
        });
        await sleep(delay);
      }
      const response = await fetchImpl(url, init);
      if (response.status === 429) {
        const delay = retryDelay(response.headers?.get('Retry-After'), now());
        pausedUntil = Math.max(pausedUntil, now() + delay);
        try { if (redis) await redis.set(`${prefix}:pause`, pausedUntil, { px: delay }); } catch {}
      }
      if (search && response.ok) {
        try {
          const data = await response.clone().json();
          if (Array.isArray(data.results)) {
            const ttl = data.results.length ? 3600 : 300;
            // Cache discovery only; current prices still require page evidence.
            if (recent.size >= 500) recent.delete(recent.keys().next().value);
            recent.set(key, { data, expires: now() + ttl * 1000 });
            if (redis) await redis.set(key, data, { ex: ttl });
          }
        } catch {}
      }
      return response;
    })();
    if (search) pending.set(key, task);
    try { return (await task).clone(); } finally { if (search) pending.delete(key); }
  };
}
