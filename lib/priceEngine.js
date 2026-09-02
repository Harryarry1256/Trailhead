// Shared live price-search logic — used by api/lookup.js (fallback for
// products not yet cached) and api/refresh-batch.js (the background job
// that keeps the cache warm). Talks to TinyFish's free Search + Fetch
// APIs (https://docs.tinyfish.ai).
//
// Two-step approach, not just search-snippet guessing:
//   1. Search (site:domain filtered) to find each retailer's best
//      candidate product URL.
//   2. Fetch those URLs (batched — Fetch takes up to 10 URLs in ONE call)
//      to get the actual rendered page content, then read the price off
//      that real content instead of a search engine's summary text.
// Search snippets are often generic marketing copy or come from a
// category/listing page rather than the specific product, which is the
// main reason the snippet-only version kept getting prices wrong. Reading
// the real page is a meaningfully different (and better) source, not a
// bigger regex.
//
// Falls back to the search snippet only if a given URL's fetch fails.

// Real free-tier limits: Search 30/min, Fetch 150/min. Kept comfortably
// under both.
const SEARCH_LIMIT = 20;
const FETCH_LIMIT = 80;
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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createLimiter(maxPerWindow) {
  const times = [];
  return async function acquire(maxWaitMs) {
    const deadline = Date.now() + maxWaitMs;
    while (true) {
      const now = Date.now();
      while (times.length && now - times[0] > WINDOW_MS) times.shift();
      if (times.length < maxPerWindow) {
        times.push(now);
        return true;
      }
      if (now >= deadline) return false;
      const waitMs = Math.min(WINDOW_MS - (now - times[0]) + 50, deadline - now);
      await sleep(Math.max(waitMs, 50));
    }
  };
}

const acquireSearchSlot = createLimiter(SEARCH_LIMIT);
const acquireFetchSlot = createLimiter(FETCH_LIMIT);

const NOISE_BEFORE = /(off|save|discount|shipping|delivery|was|freight|postage|rrp)\s*[:\-]?\s*$/i;

// text: page content (or snippet) to scan. preferEarliest: true for full
// page reads (the real price is almost always near the top — later $
// mentions tend to be related/upsell items); false for short snippets
// where "smallest plausible number" worked better in practice.
function extractPrice(text, bounds, preferEarliest) {
  if (!text) return null;
  const scoped = preferEarliest ? text.slice(0, 4000) : text;
  const re = /(?:NZ\$|\$)\s?([\d]{1,3}(?:,\d{3})*(?:\.\d{2})?)/g;
  let match;
  const candidates = [];
  while ((match = re.exec(scoped)) !== null) {
    const num = parseFloat(match[1].replace(/,/g, ''));
    if (isNaN(num)) continue;
    const before = scoped.slice(Math.max(0, match.index - 15), match.index);
    if (NOISE_BEFORE.test(before)) continue;
    if (bounds && (num < bounds[0] || num > bounds[1])) continue;
    candidates.push(num);
  }
  if (candidates.length === 0) return null;
  return preferEarliest ? candidates[0] : Math.min(...candidates);
}

function extractPromo(text) {
  if (!text) return null;
  const codeMatch = text.match(/\bcode\s*[:\-]?\s*([A-Z0-9]{4,12})\b/i);
  return codeMatch ? codeMatch[1].toUpperCase() : null;
}

async function callSearch(apiKey, query) {
  const url = `https://api.search.tinyfish.ai?query=${encodeURIComponent(query)}&location=NZ&language=en`;
  return fetch(url, { headers: { 'X-API-Key': apiKey } });
}

async function callFetchBatch(apiKey, urls) {
  return fetch('https://api.fetch.tinyfish.ai', {
    method: 'POST',
    headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls, format: 'markdown' })
  });
}

// Step 1: find each retailer's best candidate product URL via search.
async function findCandidate(apiKey, retailer, brand, name) {
  const query = `${brand} ${name} price site:${retailer.domain}`;
  const gotSlot = await acquireSearchSlot(8000);
  if (!gotSlot) return { retailer, candidate: null, rateLimited: true };

  let resp;
  try {
    resp = await callSearch(apiKey, query);
  } catch {
    return { retailer, candidate: null };
  }
  if (resp.status === 429) {
    await sleep(3000);
    try { resp = await callSearch(apiKey, query); } catch { return { retailer, candidate: null }; }
  }
  if (!resp.ok) return { retailer, candidate: null };

  const data = await resp.json();
  const results = Array.isArray(data.results) ? data.results : [];
  const onDomain = results.filter(r => r.url && r.url.includes(retailer.domain));
  if (onDomain.length === 0) return { retailer, candidate: null };

  // Prefer a result that looks like an actual product page over a
  // category/search/listing page.
  const productLike = onDomain.find(r => /\/(products?|shop|collections?\/.+\/products?)\//i.test(r.url));
  return { retailer, candidate: productLike || onDomain[0] };
}

// Step 2: batch-fetch the real candidate pages and read prices off the
// actual content.
async function fetchAndExtract(apiKey, candidates, bounds) {
  const withUrls = candidates.filter(c => c.candidate && c.candidate.url);
  if (withUrls.length === 0) return {};

  const gotSlot = await acquireFetchSlot(8000);
  const pageByUrl = {};

  if (gotSlot) {
    try {
      const resp = await callFetchBatch(apiKey, withUrls.map(c => c.candidate.url));
      if (resp.ok) {
        const data = await resp.json();
        for (const r of (data.results || [])) {
          if (r.url && r.text) pageByUrl[r.url] = r.text;
        }
      }
    } catch {
      // fall through — extraction will just fall back to snippets below
    }
  }

  const out = {};
  for (const c of withUrls) {
    const pageText = pageByUrl[c.candidate.url];
    let price = pageText ? extractPrice(pageText, bounds, true) : null;
    let promo = pageText ? extractPromo(pageText) : null;
    let source = pageText ? 'page' : null;

    if (price === null) {
      // Fetch failed or found nothing usable — fall back to the search snippet.
      price = extractPrice(c.candidate.snippet, bounds, false) ?? extractPrice(c.candidate.title, bounds, false);
      if (!promo) promo = extractPromo(c.candidate.snippet);
      source = price !== null ? 'snippet' : null;
    }

    out[c.retailer.name] = { price, promo, source };
  }
  return out;
}

export async function fetchLivePrices(apiKey, brand, name, catKey, retailers) {
  const bounds = CATEGORY_BOUNDS[catKey] || null;

  const candidates = await Promise.all(
    retailers.map(retailer => findCandidate(apiKey, retailer, brand, name))
  );

  const extracted = await fetchAndExtract(apiKey, candidates, bounds);

  const results = candidates.map(c => {
    const notFoundUrl = `https://${c.retailer.domain}`;
    if (!c.candidate) {
      return {
        retailer: c.retailer.name,
        price: 'Not found',
        in_stock: null,
        url: notFoundUrl,
        promo_code: null,
        promo_details: c.rateLimited ? 'Rate limited — try again shortly.' : null,
        _priceNum: null
      };
    }
    const ex = extracted[c.retailer.name] || {};
    return {
      retailer: c.retailer.name,
      price: ex.price != null ? `NZ$${ex.price.toFixed(2)}` : 'Not found',
      in_stock: null,
      url: c.candidate.url || notFoundUrl,
      promo_code: ex.promo || null,
      promo_details: ex.promo ? 'Mentioned on the retailer\'s page — verify at checkout.' : null,
      _priceNum: ex.price != null ? ex.price : null
    };
  });

  const withPrices = results.filter(r => typeof r._priceNum === 'number');
  const cheapest = withPrices.length
    ? withPrices.reduce((a, b) => (a._priceNum <= b._priceNum ? a : b)).retailer
    : null;
  const cleanResults = results.map(({ _priceNum, ...rest }) => rest);

  return {
    results: cleanResults,
    cheapest_retailer: cheapest,
    note: 'Prices are read from each retailer\'s actual live product page where possible (falling back to search-result text if a page couldn\'t be read), filtered against a realistic price range for the category. Always confirm on the retailer\'s site.'
  };
}
