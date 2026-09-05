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
//
// A relevance check guards both steps: a candidate is only trusted if it
// actually mentions the brand and product name. Without this, a weak
// search match (e.g. nothing genuinely stocked matching "PF 30 Gel") could
// fall back to an unrelated page on the same domain — exactly how wrong
// links like a pedals page showing up for an energy gel happened before.

const SEARCH_LIMIT = 20; // real free-tier limit is 30/min, kept a margin
const FETCH_LIMIT = 80;  // real free-tier limit is 150/min, kept a margin
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

// Guards against accepting a page that has nothing to do with the
// product just because it's on the right domain (e.g. a "PF 30 Gel"
// search returning a pedals page). Requires the brand AND a meaningful
// chunk of the product name's words to actually appear in the text.
function isRelevant(text, brand, name) {
  if (!text) return false;
  const lower = text.toLowerCase();
  if (!lower.includes(brand.toLowerCase())) return false;
  const nameTokens = name.toLowerCase().split(/\s+/).filter(t => t.length > 1);
  if (nameTokens.length === 0) return true;
  const matched = nameTokens.filter(t => lower.includes(t));
  // Raised from 40% — too loose, was letting a similar-but-different
  // variant/model through as if it were the exact product.
  const required = Math.max(nameTokens.length, Math.ceil(nameTokens.length * 0.75));
  return matched.length >= required;
}

// This was the real bug behind "links to a random unrelated section":
// checking whether a URL *contains* the domain name as a substring is
// not the same as checking whether it's actually *hosted on* that
// domain. A price-comparison site or redirect link can easily have
// "evocycles.co.nz" sitting in a query string or tracking parameter
// while the page itself is hosted somewhere else entirely. This checks
// the real hostname instead.
function isOnDomain(url, domain) {
  try {
    const host = new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
    const target = domain.replace(/^www\./i, '').toLowerCase();
    return host === target || host.endsWith('.' + target);
  } catch {
    return false;
  }
}

function extractPrice(text, bounds, preferEarliest, anchorText) {
  if (!text) return null;
  const scoped = preferEarliest ? text.slice(0, 6000) : text;
  const lower = scoped.toLowerCase();
  const re = /(?:NZ\$|\$)\s?([\d]{1,3}(?:,\d{3})*(?:\.\d{2})?)/g;
  let match;
  const candidates = [];
  while ((match = re.exec(scoped)) !== null) {
    const num = parseFloat(match[1].replace(/,/g, ''));
    if (isNaN(num)) continue;
    const before = scoped.slice(Math.max(0, match.index - 15), match.index);
    if (NOISE_BEFORE.test(before)) continue;
    if (bounds && (num < bounds[0] || num > bounds[1])) continue;
    candidates.push({ num, index: match.index });
  }
  if (candidates.length === 0) return null;
  if (!preferEarliest) return Math.min(...candidates.map(c => c.num));

  // Best signal: find where THIS specific product's name is actually
  // mentioned on the page, and prefer the price closest to it. This is
  // much more specific than "near any buy button" — related/upsell
  // widgets elsewhere on the page have their own buy buttons too, but
  // won't repeat this exact product's full name.
  if (anchorText) {
    let anchorIdx = lower.indexOf(anchorText.toLowerCase());
    if (anchorIdx === -1 && anchorText.includes(' ')) {
      // brand and name might not appear adjacent/in that exact order —
      // fall back to just the product name, which is usually distinctive
      // enough on its own (e.g. the page's actual title).
      const nameOnly = anchorText.split(' ').slice(1).join(' ');
      if (nameOnly) anchorIdx = lower.indexOf(nameOnly.toLowerCase());
    }
    if (anchorIdx !== -1) {
      let best = candidates[0];
      let bestDist = Infinity;
      for (const c of candidates) {
        const dist = Math.abs(c.index - anchorIdx);
        if (dist < bestDist) { bestDist = dist; best = c; }
      }
      return best.num;
    }
  }

  // Fall back to proximity to purchase language.
  const buySignals = ['add to cart', 'add to bag', 'buy now', 'add to basket'];
  const near = candidates.find(c => {
    const windowText = lower.slice(Math.max(0, c.index - 300), c.index + 300);
    return buySignals.some(s => windowText.includes(s));
  });
  return (near || candidates[0]).num;
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
// Only accepts a result if it's actually relevant to the product.
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
  const onDomain = results.filter(r => r.url && isOnDomain(r.url, retailer.domain));
  if (onDomain.length === 0) return { retailer, candidate: null };

  // Only trust results that actually mention this product.
  const relevant = onDomain.filter(r => isRelevant(`${r.title || ''} ${r.snippet || ''}`, brand, name));
  if (relevant.length === 0) return { retailer, candidate: null };

  // Require the URL to actually look like a specific product page — not
  // a homepage anchor link, category page, or brand-collection listing.
  // A relevant-but-wrong-shaped URL (e.g. site.com/#trek) is exactly how
  // clicks were landing on "a section of the site" instead of a real
  // product. If nothing here looks like a real product page, treat this
  // retailer as not found rather than guessing.
  const productLike = relevant.find(r => /\/(products?|shop)\/[a-z0-9][a-z0-9\-]{3,}/i.test(r.url));
  if (!productLike) return { retailer, candidate: null };
  return { retailer, candidate: productLike };
}

// Step 2: batch-fetch the real candidate pages and read prices off the
// actual content — but only if that fetched page also passes the
// relevance check (a redirect or stale index can still lead somewhere
// unrelated even after a relevant search match).
async function fetchAndExtract(apiKey, candidates, bounds, brand, name) {
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
    const pageIsRelevant = pageText && isRelevant(pageText.slice(0, 2000), brand, name);

    let price = pageIsRelevant ? extractPrice(pageText, bounds, true, `${brand} ${name}`) : null;
    let promo = pageIsRelevant ? extractPromo(pageText) : null;

    if (price === null) {
      // Fetched page wasn't usable/relevant — fall back to the search
      // snippet, which already passed its own relevance check.
      price = extractPrice(c.candidate.snippet, bounds, false) ?? extractPrice(c.candidate.title, bounds, false);
      if (!promo) promo = extractPromo(c.candidate.snippet);
    }

    out[c.retailer.name] = { price, promo };
  }
  return out;
}

export async function fetchLivePrices(apiKey, brand, name, catKey, retailers) {
  const bounds = CATEGORY_BOUNDS[catKey] || null;

  const candidates = await Promise.all(
    retailers.map(retailer => findCandidate(apiKey, retailer, brand, name))
  );

  const extracted = await fetchAndExtract(apiKey, candidates, bounds, brand, name);

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
    note: 'Prices are read from each retailer\'s actual live product page where possible, only when it genuinely matches the product searched for. Some listings will show "Not found" rather than risk showing an unrelated page. Always confirm on the retailer\'s site.'
  };
}
