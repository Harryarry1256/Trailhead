import test from 'node:test';
import assert from 'node:assert/strict';
import { cacheTtl, readCached, CACHE_VERSION, MAX_CACHE_AGE_MS, CACHE_RETENTION_MS } from '../lib/cache.js';
import { cacheKeyFor } from '../lib/catalog.js';
import { PRODUCTS } from '../lib/catalog.js';
const now = Date.now();
const good = { schemaVersion: CACHE_VERSION, complete: true, updatedAt: now, results: [{ status: 'verified' }] };
test('new namespace bypasses potentially incorrect legacy data', () => {
  assert.match(cacheKeyFor('Giant', 'Talon 29 3'), /^price:v2:/);
  assert.equal(readCached({ ...good, schemaVersion: 1 }), null);
});
test('failed and ambiguous results are not cached', () => {
  assert.equal(cacheTtl({ ...good, complete: false }), 0);
});
test('complete snapshots last between cron passes, with bounded stale retention', () => {
  assert.equal(cacheTtl(good), 86400);
  const empty = { ...good, results: [{ status: 'not_found' }] };
  assert.equal(cacheTtl(empty), 86400);
  assert.deepEqual(readCached(empty, now + 300000), empty);
  assert.equal(readCached(good, now + MAX_CACHE_AGE_MS), null);
  assert.deepEqual(readCached(JSON.stringify(good), now), good);
  assert.deepEqual(readCached(good, now + MAX_CACHE_AGE_MS, { allowStale: true }), good);
  assert.equal(readCached(good, now + CACHE_RETENTION_MS, { allowStale: true }), null);
});
test('corrupt and future-dated cache entries are ignored', () => {
  for (const value of [null, 'invalid', {}, { ...good, updatedAt: now + 1000 }, { ...good, updatedAt: undefined }]) {
    assert.equal(readCached(value, now), null);
  }
});

test('catalog keeps only the completed no-match removals and adds confirmed bike listings', () => {
  for (const removed of ['Contend 3', 'Scultura 400', 'Strattos S5']) {
    assert.equal(PRODUCTS.some(p => p.name === removed), false);
  }
  for (const added of ['Cascade 2 27.5', 'Cascade 3 29', 'Cascade 4 27.5', 'Cascade 4 29', 'Cascade 5 27.5', 'XTC Advanced 29 3', 'Marlin 5 Gen 3', 'Contend AR 2', 'Domane AL 2 Gen 4', 'Kalosi Lanes EVO LS']) {
    assert.equal(PRODUCTS.some(p => p.name === added), true);
  }
});
