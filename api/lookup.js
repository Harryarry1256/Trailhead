// Serverless function (Vercel). Uses TinyFish's free Search API
// (https://docs.tinyfish.ai/search-api) instead of a paid LLM call.
// Search and Fetch are free on TinyFish at any wallet balance, including $0 —
// but the free tier is rate-limited, so we query retailers one at a time
// with a small delay instead of firing all 7 requests at once.
//
// Get a free key (no credit card): https://agent.tinyfish.ai/api-keys

const DELAY_MS = 350; // spacing between requests to stay under free rate limits

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Pull a NZD-looking price out of a search snippet, e.g. "NZ$1,299.00" or "$899"
function extractPrice(text) {
  if (!text) return null;
  const match = text.match(/(?:NZ\$|\$)\s?([\d]{2,6}(?:,\d{3})*(?:\.\d{2})?)/);
  if (!match) return null;
  const num = parseFloat(match[1].replace(/,/g, ''));
  if (isNaN(num) || num < 1) return null;
  return num;
}

// Best-effort promo detection from snippet text — genuinely rare to find this way
function extractPromo(text) {
  if (!text) return null;
  const codeMatch = text.match(/\bcode\s*[:\-]?\s*([A-Z0-9]{4,12})\b/i);
  if (codeMatch) return codeMatch[1].toUpperCase();
  return null;
}

async function searchOne(apiKey, retailer, brand, name) {
  const query = encodeURIComponent(`${retailer.domain} ${brand} ${name} price`);
  const url = `https://api.search.tinyfish.ai?query=${query}&location=NZ&language=en`;

  const resp = await fetch(url, {
    headers: { 'X-API-Key': apiKey }
  });

  if (resp.status === 429) {
    return {
      retailer: retailer.name,
      price: 'Not found',
      in_stock: null,
      url: `https://${retailer.domain}`,
      promo_code: null,
      promo_details: 'Rate limited — try refreshing in a moment.'
    };
  }

  if (!resp.ok) {
    return {
      retailer: retailer.name,
      price: 'Not found',
      in_stock: null,
      url: `https://${retailer.domain}`,
      promo_code: null,
      promo_details: null
    };
  }

  const data = await resp.json();
  const results = Array.isArray(data.results) ? data.results : [];

  // Prefer a result that's actually on the retailer's own domain
  const best = results.find(r => r.url && r.url.includes(retailer.domain)) || results[0];

  if (!best) {
    return {
      retailer: retailer.name,
      price: 'Not found',
      in_stock: null,
      url: `https://${retailer.domain}`,
      promo_code: null,
      promo_details: null
    };
  }

  const priceNum = extractPrice(best.snippet) || extractPrice(best.title);
  const promo = extractPromo(best.snippet);

  return {
    retailer: retailer.name,
    price: priceNum !== null ? `NZ$${priceNum.toFixed(2)}` : 'Not found',
    in_stock: null,
    url: best.url || `https://${retailer.domain}`,
    promo_code: promo,
    promo_details: promo ? 'Mentioned in search result snippet — verify at checkout.' : null,
    _priceNum: priceNum
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

  const { brand, name, retailers } = req.body || {};

  if (!brand || !name || !Array.isArray(retailers) || retailers.length === 0) {
    res.status(400).json({ error: 'Missing brand, name, or retailers in request body.' });
    return;
  }

  const results = [];
  for (const retailer of retailers) {
    try {
      const r = await searchOne(apiKey, retailer, brand, name);
      results.push(r);
    } catch (err) {
      results.push({
        retailer: retailer.name,
        price: 'Not found',
        in_stock: null,
        url: `https://${retailer.domain}`,
        promo_code: null,
        promo_details: null
      });
    }
    await sleep(DELAY_MS);
  }

  const withPrices = results.filter(r => typeof r._priceNum === 'number');
  let cheapest = null;
  if (withPrices.length > 0) {
    cheapest = withPrices.reduce((a, b) => (a._priceNum <= b._priceNum ? a : b)).retailer;
  }

  const cleanResults = results.map(({ _priceNum, ...rest }) => rest);

  res.status(200).json({
    results: cleanResults,
    cheapest_retailer: cheapest,
    note: 'Prices are extracted from live search-result snippets (free tier), not a full page read — some listings may show "Not found" even if the product is in stock. Always confirm on the retailer\'s site.'
  });
}
