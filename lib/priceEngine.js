// Shared live price-search logic — used by api/lookup.js (fallback for
// products not yet cached) and api/refresh-batch.js (the background job
// that keeps the cache warm). Talks to TinyFish's free Search API
// (https://docs.tinyfish.ai/search-api).

const MAX_REQUESTS_PER_WINDOW = 4;   // stay a little under TinyFish's ~5/min limit
const WINDOW_MS = 60 * 1000;

export const CATEGORY_BOUNDS = {
  mtb:          [300, 15000],
  road:         [400, 18000],
  ebike:        [1200, 18000],
  kids:         [100, 2500],
  helmets:      [25, 700],
  apparel:      [15, 600],
  parts:        [5, 4000],
  accessories:  [5, 4000],
  nutrition:    [2, 150]
};

const requestTimes = [];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function acquireSlot(maxWaitMs) {
  const deadline = Date.now() + maxWaitMs;
  while (true) {
    const now = Date.now();
    while (requestTimes.length && now - requestTimes[0] > WINDOW_MS) {
      requestTimes.shift();
    }
    if (requestTimes.length < MAX_REQUESTS_PER_WINDOW) {
      requestTimes.push(now);
      return true;
    }
    if (now >= deadline) return false;
    const waitMs = Math.min(WINDOW_MS - (now - requestTimes[0]) + 50, deadline - now);
    await sleep(Math.max(waitMs, 50));
  }
}

const NOISE_BEFORE = /(off|save|discount|shipping|delivery|was|freight|postage|rrp)\s*[:\-]?\s*$/i;

function extractPrice(text, bounds) {
  if (!text) return null;
  const re = /(?:NZ\$|\$)\s?([\d]{1,3}(?:,\d{3})*(?:\.\d{2})?)/g;
  let match;
  const candidates = [];
  while ((match = re.exec(text)) !== null) {
    const num = parseFloat(match[1].replace(/,/g, ''));
    if (isNaN(num)) continue;
    const before = text.slice(Math.max(0, match.index - 15), match.index);
    if (NOISE_BEFORE.test(before)) continue;
    if (bounds && (num < bounds[0] || num > bounds[1])) continue;
    candidates.push(num);
  }
  if (candidates.length === 0) return null;
  return Math.min(...candidates);
}

function extractPromo(text) {
  if (!text) return null;
  const codeMatch = text.match(/\bcode\s*[:\-]?\s*([A-Z0-9]{4,12})\b/i);
  return codeMatch ? codeMatch[1].toUpperCase() : null;
}

async function callTinyFish(apiKey, query) {
  const url = `https://api.search.tinyfish.ai?query=${encodeURIComponent(query)}&location=NZ&language=en`;
  return fetch(url, { headers: { 'X-API-Key': apiKey } });
}

async function searchOne(apiKey, retailer, brand, name, bounds) {
  const query = `${brand} ${name} price site:${retailer.domain}`;
  const notFound = { retailer: retailer.name, price: 'Not found', in_stock: null, url: `https://${retailer.domain}`, promo_code: null, promo_details: null };
  const rateLimited = { ...notFound, promo_details: 'Rate limited — try again shortly.' };

  const gotSlot = await acquireSlot(8000);
  if (!gotSlot) return rateLimited;

  let resp;
  try {
    resp = await callTinyFish(apiKey, query);
  } catch {
    return notFound;
  }

  if (resp.status === 429) {
    await sleep(3000);
    try {
      resp = await callTinyFish(apiKey, query);
    } catch {
      return rateLimited;
    }
    if (resp.status === 429) return rateLimited;
  }

  if (!resp.ok) return notFound;

  const data = await resp.json();
  const results = Array.isArray(data.results) ? data.results : [];
  const onDomain = results.filter(r => r.url && r.url.includes(retailer.domain));
  if (onDomain.length === 0) return notFound;

  let bestPrice = null;
  let bestResult = null;
  let promo = null;

  for (const r of onDomain) {
    const p = extractPrice(r.snippet, bounds) ?? extractPrice(r.title, bounds);
    if (p !== null && (bestPrice === null || p < bestPrice)) {
      bestPrice = p;
      bestResult = r;
    }
    if (!promo) promo = extractPromo(r.snippet);
  }
  if (!bestResult) bestResult = onDomain[0];

  return {
    retailer: retailer.name,
    price: bestPrice !== null ? `NZ$${bestPrice.toFixed(2)}` : 'Not found',
    in_stock: null,
    url: bestResult.url || `https://${retailer.domain}`,
    promo_code: promo,
    promo_details: promo ? 'Mentioned in search result snippet — verify at checkout.' : null,
    _priceNum: bestPrice
  };
}

// Runs a live search across all given retailers for one product and
// returns the same payload shape the frontend expects.
export async function fetchLivePrices(apiKey, brand, name, catKey, retailers) {
  const bounds = CATEGORY_BOUNDS[catKey] || null;
  const results = await Promise.all(
    retailers.map(retailer => searchOne(apiKey, retailer, brand, name, bounds))
  );
  const withPrices = results.filter(r => typeof r._priceNum === 'number');
  const cheapest = withPrices.length
    ? withPrices.reduce((a, b) => (a._priceNum <= b._priceNum ? a : b)).retailer
    : null;
  const cleanResults = results.map(({ _priceNum, ...rest }) => rest);

  return {
    results: cleanResults,
    cheapest_retailer: cheapest,
    note: 'Prices are extracted from live search-result snippets (free tier), filtered against a realistic price range and matched only to results on the retailer\'s own site. Always confirm on the retailer\'s site.'
  };
}
