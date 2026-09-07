import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { PRODUCTS, RETAILERS } from '../lib/catalog.js';
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/^import .*;$/m, '');
function setup() {
  const elements = new Map();
  const element = () => ({ innerHTML: '', textContent: '', classList: { add(){}, remove(){} }, listeners: {}, addEventListener(type, fn){ this.listeners[type] = fn; }, querySelectorAll(){ return []; } });
  const document = { addEventListener(){}, getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); }, createElement(){
    let value = ''; return { set textContent(v) { value = String(v).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }, get innerHTML(){ return value; } };
  } };
  const pending = [];
  const context = vm.createContext({ document, PRODUCTS, RETAILERS, AbortController, URL, setTimeout, clearTimeout, fetch: (url, init) => new Promise((resolve, reject) => pending.push({ resolve, reject, init })) });
  vm.runInContext(script, context);
  return { context, pending, elements };
}
const result = (amount = 1099) => ({ complete: true, results: [{ retailer: 'Evo Cycles', status: 'verified', price: `NZ$${amount}`, price_amount: amount }], updatedAt: Date.now() });
test('browser uses the shared catalog', () => {
  const { elements } = setup();
  assert.match(elements.get('resultCount').textContent, new RegExp(`^${PRODUCTS.length} products`));
  assert.equal((elements.get('grid').innerHTML.match(/class="product-card"/g) || []).length, PRODUCTS.length);
});
test('late results from previous product cannot overwrite current product', async () => {
  const { context, pending, elements } = setup();
  const first = vm.runInContext('runLookup(PRODUCTS[0])', context);
  const second = vm.runInContext('runLookup(PRODUCTS[1])', context);
  assert.equal(pending[0].init.signal.aborted, true);
  pending[1].resolve({ ok: true, json: async () => result(1599) }); await second;
  const current = elements.get('modalBody').innerHTML;
  assert.match(current, /Marlin 7/);
  pending[0].resolve({ ok: true, json: async () => result(1099) }); await first;
  assert.equal(elements.get('modalBody').innerHTML, current);
});
test('late errors and closing modal cannot overwrite a newer view', async () => {
  const { context, pending, elements } = setup();
  const first = vm.runInContext('runLookup(PRODUCTS[0])', context);
  vm.runInContext('closeModal()', context);
  const before = elements.get('modalBody').innerHTML;
  pending[0].reject(new Error('old failure')); await first;
  assert.equal(elements.get('modalBody').innerHTML, before);
});
test('retailer links reject foreign hosts and escape quoted attributes', () => {
  const { context, elements } = setup();
  context.testData = { ...result(), results: [{ ...result().results[0], url: 'https://evil.test/?evocycles.co.nz', product_title: '<script>bad</script>' }] };
  vm.runInContext('renderResults(PRODUCTS[0], testData)', context);
  assert.doesNotMatch(elements.get('modalBody').innerHTML, /href="https:\/\/evil|<script>/);
  assert.match(elements.get('modalBody').innerHTML, /&lt;script&gt;/);
});
test('stale saved results keep their price and show an age warning', () => {
  const { context, elements } = setup();
  context.testData = { ...result(), cached: true, stale: true };
  vm.runInContext('renderResults(PRODUCTS[0], testData)', context);
  assert.match(elements.get('modalBody').innerHTML, /NZ\$1099/);
  assert.match(elements.get('modalBody').innerHTML, /over six hours old/);
  assert.match(elements.get('modalBody').innerHTML, /Reload saved prices/);
  assert.doesNotMatch(elements.get('modalBody').innerHTML, /Check live now/);
});
test('a pending product is not presented as an out-of-stock or no-match result', () => {
  const { context, elements } = setup();
  context.testData = { pending: true, complete: false, results: [] };
  vm.runInContext('renderResults(PRODUCTS[0], testData)', context);
  assert.match(elements.get('modalBody').innerHTML, /Awaiting saved prices/);
  assert.match(elements.get('modalBody').innerHTML, /No saved retailer prices yet/);
  assert.doesNotMatch(elements.get('modalBody').innerHTML, /Just checked live|Check complete/);
});
test('reload reads the cache without a force flag', async () => {
  const { context, elements, pending } = setup();
  context.testData = { ...result(), cached: true };
  vm.runInContext('renderResults(PRODUCTS[0], testData)', context);
  const request = elements.get('retryBtn').listeners.click();
  assert.equal(JSON.parse(pending[0].init.body).force, undefined);
  pending[0].resolve({ ok: true, json: async () => ({ ...result(), cached: true }) });
  await request;
  assert.match(elements.get('modalBody').innerHTML, /Loaded from cache/);
});
