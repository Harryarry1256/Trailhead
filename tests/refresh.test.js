import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../api/refresh-batch.js';
import { createHandler as createLookupHandler } from '../api/lookup.js';
import { PRODUCTS, cacheKeyFor } from '../lib/catalog.js';
import { CACHE_VERSION, CACHE_RETENTION_MS } from '../lib/cache.js';
process.env.REFRESH_SECRET = 'test-secret';
process.env.TINYFISH_API_KEY = 'test-key';
process.env.UPSTASH_REDIS_REST_URL = 'https://cache.test';
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
const req = { headers: { 'x-refresh-secret': 'test-secret' } };
const result = { complete: true, results: [{ retailer: 'Evo Cycles', status: 'verified', price_amount: 906.67 }] };
function response() { return { setHeader(){}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } }; }
function cache() {
  const entries = new Map(); const writes = [];
  return { entries, writes, get: async key => entries.get(key), set: async (key, value, options) => { entries.set(key, value); writes.push({ key, value, options }); } };
}
test('unauthorized requests never start a scheduled update', async () => {
  const handler = createHandler({ redisFactory: () => assert.fail('unauthorized cache access'), lookup: () => assert.fail('unauthorized provider access') });
  const res = response(); await handler({ headers: {} }, res); assert.equal(res.code, 401);
});
test('scheduled refresh replaces fresh snapshots and lookup reads that exact saved price', async () => {
  const redis = cache(); const product = PRODUCTS[0]; const key = cacheKeyFor(product.brand, product.name);
  redis.entries.set(key, JSON.stringify({ ...result, schemaVersion: CACHE_VERSION, updatedAt: Date.now() }));
  let calls = 0;
  const handler = createHandler({ redisFactory: () => redis, lookup: async () => { calls++; return result; } });
  const res = response(); await handler(req, res);
  assert.equal(calls, 1); assert.equal(res.code, 200); assert.equal(res.body.saved, true);
  assert.equal(redis.writes.find(w => w.key === key).options.ex, CACHE_RETENTION_MS / 1000);
  assert.equal(redis.entries.get('refresh:cursor'), 1);
  const saved = JSON.parse(redis.entries.get(key));
  const visible = response();
  await createLookupHandler({ redisFactory: () => redis })({ method: 'POST', body: { brand: product.brand, name: product.name, force: true } }, visible);
  assert.deepEqual(visible.body.results, saved.results);
  assert.equal(visible.body.updatedAt, saved.updatedAt); assert.equal(visible.body.cached, true);
});
test('a failed scheduled check leaves the old price and expiry untouched, and advances the cursor', async () => {
  const redis = cache(); const product = PRODUCTS[0]; const key = cacheKeyFor(product.brand, product.name);
  const previous = JSON.stringify({ ...result, schemaVersion: CACHE_VERSION, updatedAt: Date.now() - 10000 });
  redis.entries.set(key, previous);
  const handler = createHandler({ redisFactory: () => redis, lookup: async () => ({ complete: false, results: [{ status: 'unavailable', error_code: 'rate_limited' }] }) });
  const res = response(); await handler(req, res);
  assert.equal(res.code, 502); assert.equal(res.body.saved, false);
  assert.equal(redis.entries.get(key), previous); assert.equal(redis.entries.get('refresh:cursor'), 1);
  assert.deepEqual(redis.writes.map(w => w.key), ['refresh:cursor']);
});
test('a completed no-match result is stored until the next catalog pass, and cursor wraps', async () => {
  const redis = cache(); redis.entries.set('refresh:cursor', PRODUCTS.length - 1);
  const handler = createHandler({ redisFactory: () => redis, lookup: async () => ({ complete: true, results: [{ status: 'not_found' }] }) });
  const res = response(); await handler(req, res);
  assert.equal(res.body.saved, true); assert.equal(redis.entries.get('refresh:cursor'), 0);
  assert.equal(redis.writes[0].options.ex, 86400);
});
