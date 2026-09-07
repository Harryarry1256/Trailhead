import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../api/lookup.js';
import { CACHE_VERSION, MAX_CACHE_AGE_MS, CACHE_RETENTION_MS } from '../lib/cache.js';
const product = { brand: 'Giant', name: 'Talon 29 3', catKey: 'mtb' };
const payload = { results: [{ retailer: 'Evo Cycles', status: 'verified', price_amount: 906.67 }], complete: true };
const cached = { ...payload, schemaVersion: CACHE_VERSION, updatedAt: Date.now() };
function response() { return { headers: {}, setHeader(k,v) { this.headers[k] = v; }, status(s) { this.code = s; return this; }, json(v) { this.body = v; return this; } }; }
test('normal and legacy forced requests only read saved prices, even without a provider key', async () => {
  const previousKey = process.env.TINYFISH_API_KEY;
  delete process.env.TINYFISH_API_KEY;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { assert.fail('Visitors must never call the provider'); };
  try {
    const handler = createHandler({ redisFactory: () => ({ get: async () => cached, set: () => assert.fail('Visitor wrote to cache') }) });
    for (const force of [undefined, false, true]) {
      const res = response(); await handler({ method: 'POST', body: { ...product, force } }, res);
      assert.equal(res.code, 200); assert.equal(res.body.cached, true);
      assert.equal(res.body.results[0].price_amount, 906.67); assert.equal(res.body.updatedAt, cached.updatedAt);
      assert.equal(res.body.stale, false);
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.TINYFISH_API_KEY; else process.env.TINYFISH_API_KEY = previousKey;
  }
});
test('missing, legacy, corrupt, and expired entries await cron without starting a search', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { assert.fail('Cache misses must never call the provider'); };
  try {
    for (const value of [null, 'invalid', { ...cached, schemaVersion: 1 }, { ...cached, updatedAt: Date.now() - CACHE_RETENTION_MS - 1000 }]) {
      const handler = createHandler({ redisFactory: () => ({ get: async () => value }) });
      const res = response(); await handler({ method: 'POST', body: { ...product, force: true } }, res);
      assert.equal(res.code, 200); assert.equal(res.body.pending, true);
      assert.deepEqual(res.body.results, []); assert.equal(res.body.updatedAt, undefined);
    }
  } finally { globalThis.fetch = originalFetch; }
});
test('saved prices awaiting refresh retain the original amount and timestamp', async () => {
  const stale = { ...cached, updatedAt: Date.now() - MAX_CACHE_AGE_MS - 1000 };
  const handler = createHandler({ redisFactory: () => ({ get: async () => stale }) });
  const res = response(); await handler({ method: 'POST', body: product }, res);
  assert.equal(res.body.stale, true); assert.equal(res.body.results[0].price_amount, 906.67);
  assert.equal(res.body.updatedAt, stale.updatedAt);
});
test('cache outages return a useful error without falling back to paid searches', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { assert.fail('Cache outage must never call the provider'); };
  try {
    for (const redisFactory of [() => null, () => { throw new Error('secret'); }, () => ({ get: async () => { throw new Error('secret'); } })]) {
      const res = response(); await createHandler({ redisFactory })({ method: 'POST', body: product }, res);
      assert.equal(res.code, 503); assert.match(res.body.error, /Saved prices/);
      assert.doesNotMatch(res.body.error, /secret/);
    }
  } finally { globalThis.fetch = originalFetch; }
});
test('invalid input never reaches the cache', async () => {
  const handler = createHandler({ redisFactory: () => { assert.fail('Cache called'); } });
  for (const body of [{}, { ...product, brand: {} }, { ...product, name: 'unknown' }, { ...product, catKey: 'nutrition' }, { ...product, force: 'false' }]) {
    const res = response(); await handler({ method: 'POST', body }, res); assert.equal(res.code, 400);
  }
  const res = response(); await handler({ method: 'GET' }, res); assert.equal(res.code, 405);
});
