import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler } from '../api/lookup.js';
import { CACHE_VERSION } from '../lib/cache.js';
const product = { brand: 'Giant', name: 'Talon 29 3', catKey: 'mtb' };
const payload = { results: [{ retailer: 'Evo Cycles', status: 'verified', price_amount: 1099 }], complete: true };
const cached = { ...payload, schemaVersion: CACHE_VERSION, updatedAt: Date.now() };
function response() { return { headers: {}, setHeader(k,v) { this.headers[k] = v; }, status(s) { this.code = s; return this; }, json(v) { this.body = v; return this; } }; }
process.env.TINYFISH_API_KEY = 'test-only';
test('valid cache bypasses provider; force refresh bypasses cache', async () => {
  let calls = 0; const writes = [];
  const handler = createHandler({ redisFactory: () => ({ get: async () => cached, set: async (...args) => writes.push(args) }), lookup: async () => { calls++; return payload; } });
  const res = response(); await handler({ method: 'POST', body: product }, res);
  assert.equal(calls, 0); assert.equal(res.body.cached, true);
  const forced = response(); await handler({ method: 'POST', body: { ...product, force: true } }, forced);
  assert.equal(calls, 1); assert.equal(forced.body.cached, false); assert.equal(writes.length, 1);
});
test('failures do not overwrite an existing cache entry', async () => {
  let writes = 0;
  const handler = createHandler({ redisFactory: () => ({ set: async () => writes++ }), lookup: async () => ({ ...payload, complete: false }) });
  const res = response(); await handler({ method: 'POST', body: { ...product, force: true } }, res);
  assert.equal(writes, 0); assert.equal(res.body.complete, false);
});
test('legacy cache and failed cache reads fall back to live', async () => {
  for (const get of [async () => ({ ...cached, schemaVersion: 1 }), async () => { throw new Error('offline'); }]) {
    let calls = 0;
    const handler = createHandler({ redisFactory: () => ({ get, set: async () => {} }), lookup: async () => { calls++; return payload; } });
    const res = response(); await handler({ method: 'POST', body: product }, res);
    assert.equal(calls, 1); assert.equal(res.code, 200);
  }
});
test('invalid input never reaches the provider or cache', async () => {
  const handler = createHandler({ redisFactory: () => { throw new Error('Should not be used'); }, lookup: async () => { assert.fail('provider called'); } });
  for (const body of [{}, { ...product, brand: {} }, { ...product, name: 'unknown' }, { ...product, catKey: 'nutrition' }, { ...product, force: 'false' }]) {
    const res = response(); await handler({ method: 'POST', body }, res); assert.equal(res.code, 400);
  }
  const res = response(); await handler({ method: 'GET' }, res); assert.equal(res.code, 405);
});
test('unexpected provider errors return a useful failure response', async () => {
  const handler = createHandler({ redisFactory: () => null, lookup: async () => { throw new Error('internal'); } });
  const res = response(); await handler({ method: 'POST', body: product }, res);
  assert.equal(res.code, 503); assert.doesNotMatch(res.body.error, /internal/);
});
test('a rate-limited forced refresh preserves verified prices and their original timestamp', async () => {
  let writes = 0;
  const handler = createHandler({ redisFactory: () => ({ get: async () => cached, set: async () => writes++ }),
    lookup: async () => ({ complete: false, retryAfter: 45, results: [{ retailer: 'Evo Cycles', status: 'unavailable', error_code: 'rate_limited', price_amount: null }] }) });
  const res = response(); await handler({ method: 'POST', body: { ...product, force: true } }, res);
  assert.equal(res.body.results[0].price_amount, 1099);
  assert.equal(res.body.updatedAt, cached.updatedAt);
  assert.equal(res.body.refreshFailed, true); assert.equal(res.body.retryAfter, 45);
  assert.equal(writes, 0);
});
test('concurrent checks for the same product share one live lookup', async () => {
  let finish; let calls = 0;
  const handler = createHandler({ redisFactory: () => null, lookup: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  const a = response(); const b = response();
  const first = handler({ method: 'POST', body: product }, a);
  const second = handler({ method: 'POST', body: product }, b);
  await Promise.resolve(); finish(payload); await Promise.all([first, second]);
  assert.equal(calls, 1); assert.equal(a.body.results[0].price_amount, 1099); assert.deepEqual(a.body.results, b.body.results);
});
