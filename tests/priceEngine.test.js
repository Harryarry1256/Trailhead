import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPrice, titleMatches, isProductUrl, fetchLivePrices } from '../lib/priceEngine.js';
const bounds = [2, 18000];
const retailer = { name: 'Evo Cycles', domain: 'evocycles.co.nz' };
const url = 'https://www.evocycles.co.nz/Product/602857/2025-giant-talon-29-3-frost-silver';
const title = '2025 Giant Talon 29 3 29" MTB - Frost Silver';
const page = { url, final_url: url, title, text: `# ${title}\n\n## 1099.00\n\n4 payments of $274.75\n\nADD TO CART\n\nRelated products\n$9.99` };
const json = data => ({ ok: true, json: async () => data });
function mockProvider({ search, pages = [page], errors = [], fetchError } = {}) {
  return async request => {
    if (request.startsWith('https://api.search.')) return search || json({ results: [{ title, url, snippet: '$99.99 code PRODUCT' }] });
    return fetchError || json({ results: pages, errors });
  };
}
const lookup = fetchImpl => fetchLivePrices('test-key', 'Giant', 'Talon 29 3', 'mtb', [retailer], { fetchImpl });

for (const [input, expected] of [
  ['$1099.00', 1099], ['$1,099.00', 1099], ['NZ$12999.99', 12999.99],
  ['## 1099.00', 1099], ['Price: 1099.00 NZD', 1099],
  ['$1099.00 or 4 payments of $274.75 with Afterpay', 1099],
  ['Was $1499.00\nNow $1099.00', 1099], ['~~$1499.00~~\n$1099.00', 1099],
  ['Regular price $1499\nSale price $1099', 1099],
  ['Shipping $25\n$1099\nSave $400', 1099],
  ['$1499\n$1099', null], ['4 fortnightly payments of $274.75', null],
  ['From $1099.00', null], ['$1099 - $1499', null],
  ['Member price $999', null], ['USD $1099.00', null],
  ['$1099.9', null], ['$12345.678', null], ['Code PRODUCT1234', null], ['US$ 1099', null], ['A$1099', null],
  ['$1099–1499', null], ['$50 shipping', null], ['Service plan $129 plus $129', null],
  ['${{variation.price.min}} ${{variation.price.max}}', null]
]) test(`extracts safely: ${input}`, () => assert.equal(extractPrice(input, bounds), expected));

test('model identity retains accents, word boundaries and electric plus', () => {
  assert.equal(titleMatches('Trek Emonda ALR 4', 'Trek', 'Émonda ALR 4'), true);
  assert.equal(titleMatches('Trek Marlin 70', 'Trek', 'Marlin 7'), false);
  assert.equal(titleMatches('Giant Explore E 3', 'Giant', 'Explore E+ 3'), false);
  assert.equal(titleMatches('Giro Fixture MIPS pad kit', 'Giro', 'Fixture MIPS'), false);
  assert.equal(titleMatches('Giant Talon 3 29" MTB - Panther', 'Giant', 'Talon 29 3'), true);
});
test('retailer URL validation excludes redirects, categories and staging', () => {
  assert.equal(isProductUrl(url, retailer.domain), true);
  for (const bad of ['https://prelive.evocycles.co.nz/Product/602857/bike',
    'https://evil.test/Product/602857/bike?retailer=evocycles.co.nz',
    'https://evocycles.co.nz/products/brand/giant', 'https://evocycles.co.nz/#talon',
    'http://evocycles.co.nz/Product/602857/bike']) assert.equal(isProductUrl(bad, retailer.domain), false);
});
test('reads the actual main product price, not snippet or related product', async () => {
  const result = await lookup(mockProvider());
  assert.equal(result.results[0].price_amount, 1099);
  assert.equal(result.results[0].product_title, title);
  assert.equal(result.results[0].promo_code, null);
  assert.equal(result.results[0].in_stock, null);
  assert.equal(result.cheapest_retailer, null);
  assert.equal(result.complete, true);
});
for (const status of [401, 402, 403, 404, 429, 500]) {
  test(`provider ${status} is unavailable, not a missing product`, async () => {
    const result = await lookup(mockProvider({ search: { ok: false, status } }));
    assert.equal(result.results[0].status, 'unavailable');
    assert.equal(result.results[0].price_amount, null);
    assert.equal(result.complete, false);
  });
}
test('successful empty search is distinguished from malformed response', async () => {
  assert.equal((await lookup(mockProvider({ search: json({ results: [] }) }))).results[0].status, 'not_found');
  assert.equal((await lookup(mockProvider({ search: json({ something: [] }) }))).results[0].status, 'unavailable');
});
for (const invalidPage of [
  { ...page, title: 'Giant Pedals' },
  { ...page, title: undefined },
  { ...page, final_url: 'https://evil.test/product/1234/bike' },
  { ...page, final_url: 'https://evocycles.co.nz/' },
  { ...page, text: '# Giant Pedals\n$1099\n## Related\nGiant Talon 29 3' },
  { ...page, text: `# ${title}\n$1099\n# Other bike\n$999` },
  { ...page, text: `# ${title}\nNo price is available.` }
]) test('invalid fetched page never falls back to a snippet price', async () => {
  const result = await lookup(mockProvider({ pages: [invalidPage] }));
  assert.equal(result.results[0].price_amount, null);
  assert.equal(result.complete, false);
});
test('fetch failures never become snippet prices or cached no-match results', async () => {
  const result = await lookup(mockProvider({ pages: [], errors: [{ url, error: 'bot_blocked' }] }));
  assert.equal(result.results[0].status, 'unavailable');
  assert.equal(result.results[0].error_code, 'bot_blocked');
});
test('a second candidate can recover from a stale first listing', async () => {
  const other = url.replace('602857', '602858');
  const result = await lookup(mockProvider({ search: json({ results: [{ title, url: other }, { title, url }] }) }));
  assert.equal(result.results[0].price_amount, 1099);
});
test('network errors and aborts are reported separately', async () => {
  for (const name of ['TypeError', 'TimeoutError']) {
    const result = await lookup(async () => { throw Object.assign(new Error(), { name }); });
    assert.equal(result.results[0].error_code, name === 'TimeoutError' ? 'timeout' : 'provider_unavailable');
  }
});
