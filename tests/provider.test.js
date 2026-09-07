import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderFetch, retryDelay } from '../lib/provider.js';
const search = 'https://api.search.tinyfish.ai?query=Giant';
const page = 'https://api.fetch.tinyfish.ai';
const ok = () => new Response(JSON.stringify({ results: [{ title: 'Giant', url: 'https://example.test' }] }));

test('reuses discovery responses but always fetches current page prices', async () => {
  let calls = 0;
  const provider = createProviderFetch(null, 'test', { fetchImpl: async () => { calls++; return ok(); } });
  await provider(search); await provider(search);
  assert.equal(calls, 1);
  await provider(page); await provider(page);
  assert.equal(calls, 3);
});
test('shared cached searches use no provider allowance across instances', async () => {
  const data = new Map(); let calls = 0; let reservations = 0;
  const redis = { get: async key => data.get(key), set: async (key, value) => data.set(key, value), eval: async () => { reservations++; return 0; } };
  const options = { fetchImpl: async () => { calls++; return ok(); } };
  await createProviderFetch(redis, 'key', options)(search);
  await createProviderFetch(redis, 'key', options)(search);
  assert.equal(calls, 1); assert.equal(reservations, 1);
});
test('duplicate concurrent searches share one request', async () => {
  let finish; let calls = 0;
  const provider = createProviderFetch(null, 'test', { fetchImpl: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  const first = provider(search); const second = provider(search);
  finish(ok());
  assert.deepEqual(await (await first).json(), await (await second).json());
  assert.equal(calls, 1);
});
test('local rolling allowance resets without making rejected requests', async () => {
  let time = 100000; let calls = 0;
  const provider = createProviderFetch(null, 'test', { now: () => time, fetchImpl: async () => { calls++; return ok(); } });
  for (let i = 0; i < 26; i++) assert.equal((await provider(page)).status, 200);
  const blocked = await provider(page);
  assert.equal(blocked.status, 429); assert.equal(calls, 26);
  assert.equal(blocked.headers.get('Retry-After'), '60');
  time += 60001;
  assert.equal((await provider(page)).status, 200); assert.equal(calls, 27);
});
test('provider Retry-After stops further calls, without caching the failure', async () => {
  let time = 100000; let calls = 0;
  const provider = createProviderFetch(null, 'test', { now: () => time, fetchImpl: async () => {
    calls++; return calls === 1 ? new Response('', { status: 429, headers: { 'Retry-After': '90' } }) : ok();
  } });
  await provider(search); await provider(search);
  assert.equal(calls, 1);
  time += 90001;
  assert.equal((await provider(search)).status, 200); assert.equal(calls, 2);
});
test('shared allowance waits briefly then reserves again before fetching', async () => {
  let time = 100000; let reservations = 0; let calls = 0;
  const redis = { eval: async () => ++reservations === 1 ? 2000 : 0 };
  const provider = createProviderFetch(redis, 'test', { now: () => time,
    sleep: async ms => { time += ms; }, fetchImpl: async () => { calls++; return ok(); } });
  assert.equal((await provider(page)).status, 200);
  assert.equal(time, 102000); assert.equal(reservations, 2); assert.equal(calls, 1);
});
test('Retry-After supports seconds, dates and absent headers', () => {
  assert.equal(retryDelay('90', 100000), 90000);
  assert.equal(retryDelay(new Date(190000).toUTCString(), 100000), 90000);
  assert.equal(retryDelay(null), 60000);
});
