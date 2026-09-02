// Serverless function (Vercel). Uses TinyFish's free Search API
// (https://docs.tinyfish.ai/search-api).
//
// Important constraint this file works around: TinyFish's free tier is
// rate-limited to roughly 5 requests/minute. Firing 7 requests at once
// (one per retailer) blew through that limit, so some retailers silently
// got a 429 and came back wrong/empty — that's the "glitchy" behavior.
// Fix: a real rate limiter that paces requests to stay under the limit,
// plus one retry if a 429 slips through anyway.

const MAX_REQUESTS_PER_WINDOW = 4;   // stay a little under TinyFish's ~5/min limit
const WINDOW_MS = 60 * 1000;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes, per warm instance only

const CATEGORY_BOUNDS = {
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

// --- simple in-memory rate limiter (per warm serverless instance) ---
const requestTimes = [];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function acquireSlot() {
  while (true) {
    const now = Date.now();
    // drop timestamps older than the window
    while (requestTimes.length && now - requestTimes[0] > WINDOW_MS) {
      requestTimes.shift();
    }
    if (requestTimes.length < MAX_REQUESTS_PER_WINDOW) {
      requestTimes.push(now);
      return;
    }
    const waitMs = WINDOW_MS - (now - requestTimes[0]) + 50;
    await sleep(Math.max(waitMs, 50));
  }
}

// --- in-memory cache ---
const cache = new Map();
function cacheKey(brand, name, retailerNames) {
  return `${brand}|${name}|${retailerNames.join(',')}`.toLowerCase();
}

// --- price extraction ---
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
  // site: operator biases results to the retailer's own domain directly,
  // instead of relying only on post-hoc filtering.
  const query = `${brand} ${name} price site:${retailer.domain}`;
  const notFound = { retailer: retailer.name, price: 'Not found', in_stock: null, url: `https://${retailer.domain}`, promo_code: null, promo_details: null };

  await acquireSlot();
  let resp;
  try {
    resp = await callTinyFish(apiKey, query);
  } catch {
    return notFound;
  }

  if (resp.status === 429) {
    // one retry, after waiting for a fresh slot
    await acquireSlot();
    try {
      resp = await callTinyFish(apiKey, query);
    } catch {
      return { ...notFound, promo_details: 'Rate limited — try refreshing shortly.' };
    }
    if (resp.status === 429) {
      return { ...notFound, promo_details: 'Rate limited — try refreshing shortly.' };
    }
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Use POST' });
    return;
  }

  const apiKey = process.env.TINYFISH_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'Server is missing TINYFISH_API_KEY. Set it in your Vercel project settings.' });
    return;
  }

  const { brand, name, catKey, retailers } = req.body || {};
  if (!brand || !name || !Array.isArray(retailers) || retailers.length === 0) {
    res.status(400).json({ error: 'Missing brand, name, or retailers in request body.' });
    return;
  }

  const bounds = CATEGORY_BOUNDS[catKey] || null;
  const retailerNames = retailers.map(r => r.name);
  const key = cacheKey(brand, name, retailerNames);

  const cached = cache.get(key);
  if (cached && (Date.now() - cached.time) < CACHE_TTL_MS) {
    res.status(200).json(cached.payload);
    return;
  }

  // Requests are launched together, but each one internally waits its
  // turn at acquireSlot() — so this stays rate-limit-safe while letting
  // response parsing overlap.
  const results = await Promise.all(
    retailers.map(retailer => searchOne(apiKey, retailer, brand, name, bounds))
  );

  const withPrices = results.filter(r => typeof r._priceNum === 'number');
  const cheapest = withPrices.length
    ? withPrices.reduce((a, b) => (a._priceNum <= b._priceNum ? a : b)).retailer
    : null;

  const cleanResults = results.map(({ _priceNum, ...rest }) => rest);

  const payload = {
    results: cleanResults,
    cheapest_retailer: cheapest,
    note: 'Prices are extracted from live search-result snippets (free tier), filtered against a realistic price range and matched only to results on the retailer\'s own site. Always confirm on the retailer\'s site.'
  };

  cache.set(key, { time: Date.now(), payload });
  res.status(200).json(payload);
}
