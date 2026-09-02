// Serverless function (Vercel). Uses TinyFish's free Search API
// (https://docs.tinyfish.ai/search-api). Runs retailer checks concurrently
// (a few at a time) instead of one-by-one for speed, filters out
// implausible/noisy price matches, and caches results briefly in memory
// so repeat clicks on the same warm instance are instant.

const CONCURRENCY = 3;         // how many retailers to check at once
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Realistic NZD price ranges per category, used to reject obviously wrong
// matches (e.g. a "$5 off" coupon mistaken for the product price).
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

// Very small in-memory cache. Only helps within the same warm serverless
// instance (resets on cold start) — not a substitute for real caching,
// but free and reduces repeat load noticeably.
const cache = new Map();

function cacheKey(brand, name, retailerNames) {
  return `${brand}|${name}|${retailerNames.join(',')}`.toLowerCase();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Words that, if found right before a matched price, mean it's very
// likely NOT the product's actual price (a discount amount, shipping,
// a "was" price, etc).
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
  // Prefer the smallest plausible candidate — sale/current prices are
  // usually lower than "was" prices, and this also naturally skips
  // any stray larger unrelated numbers that slipped through.
  return Math.min(...candidates);
}

function extractPromo(text) {
  if (!text) return null;
  const codeMatch = text.match(/\bcode\s*[:\-]?\s*([A-Z0-9]{4,12})\b/i);
  if (codeMatch) return codeMatch[1].toUpperCase();
  return null;
}

async function searchOne(apiKey, retailer, brand, name, bounds) {
  const query = encodeURIComponent(`${retailer.domain} ${brand} ${name} price`);
  const url = `https://api.search.tinyfish.ai?query=${query}&location=NZ&language=en`;

  let resp;
  try {
    resp = await fetch(url, { headers: { 'X-API-Key': apiKey } });
  } catch (err) {
    return { retailer: retailer.name, price: 'Not found', in_stock: null, url: `https://${retailer.domain}`, promo_code: null, promo_details: null };
  }

  if (resp.status === 429) {
    return { retailer: retailer.name, price: 'Not found', in_stock: null, url: `https://${retailer.domain}`, promo_code: null, promo_details: 'Rate limited — try refreshing shortly.' };
  }
  if (!resp.ok) {
    return { retailer: retailer.name, price: 'Not found', in_stock: null, url: `https://${retailer.domain}`, promo_code: null, promo_details: null };
  }

  const data = await resp.json();
  const results = Array.isArray(data.results) ? data.results : [];
  const onDomain = results.filter(r => r.url && r.url.includes(retailer.domain));
  const pool = onDomain.length > 0 ? onDomain : results;

  let bestPrice = null;
  let bestResult = null;
  let promo = null;

  for (const r of pool) {
    const p = extractPrice(r.snippet, bounds) ?? extractPrice(r.title, bounds);
    if (p !== null && (bestPrice === null || p < bestPrice)) {
      bestPrice = p;
      bestResult = r;
    }
    if (!promo) promo = extractPromo(r.snippet);
  }

  if (!bestResult) bestResult = pool[0] || null;

  return {
    retailer: retailer.name,
    price: bestPrice !== null ? `NZ$${bestPrice.toFixed(2)}` : 'Not found',
    in_stock: null,
    url: (bestResult && bestResult.url) || `https://${retailer.domain}`,
    promo_code: promo,
    promo_details: promo ? 'Mentioned in search result snippet — verify at checkout.' : null,
    _priceNum: bestPrice
  };
}

// Runs async tasks with a concurrency cap instead of all-at-once or
// fully one-by-one.
async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runner() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  const runners = Array.from({ length: Math.min(limit, items.length) }, runner);
  await Promise.all(runners);
  return results;
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

  const results = await runWithConcurrency(retailers, CONCURRENCY, (retailer) =>
    searchOne(apiKey, retailer, brand, name, bounds)
  );

  const withPrices = results.filter(r => typeof r._priceNum === 'number');
  let cheapest = null;
  if (withPrices.length > 0) {
    cheapest = withPrices.reduce((a, b) => (a._priceNum <= b._priceNum ? a : b)).retailer;
  }

  const cleanResults = results.map(({ _priceNum, ...rest }) => rest);

  const payload = {
    results: cleanResults,
    cheapest_retailer: cheapest,
    note: 'Prices are extracted from live search-result snippets (free tier), filtered against a realistic price range for this category. Some listings may still show "Not found" or an off price — always confirm on the retailer\'s site.'
  };

  cache.set(key, { time: Date.now(), payload });

  res.status(200).json(payload);
}
