// Only fetched, matching product pages can supply a price. Search snippets
// discover URLs; they are never evidence of a current price or promotion.
export const CATEGORY_BOUNDS = {
  mtb: [300, 15000], road: [400, 18000], ebike: [1200, 18000],
  kids: [100, 2500], helmets: [25, 700], apparel: [15, 600],
  parts: [5, 4000], accessories: [5, 4000], nutrition: [2, 150]
};

export function normalize(value) {
  return String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\+/g, ' plus ').replace(/%/g, ' percent ')
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}
const containsPhrase = (text, phrase) => (` ${normalize(text)} `).includes(` ${normalize(phrase)} `);

export function titleMatches(title, brand, name) {
  if (typeof title !== 'string' || !containsPhrase(title, brand)) return false;
  // A known retailer spelling of the same wheel size/model, not a fuzzy match.
  const names = name === 'Talon 29 3' ? [name, 'Talon 3 29'] : [name];
  if (!names.some(n => containsPhrase(title, n))) return false;
  // Accessories for a model are not the model itself.
  const accessories = /\b(spare|replacement|pad kit|pad set|visor|frame only|frameset)\b/i;
  if (accessories.test(title) && !accessories.test(name)) return false;
  return true;
}

export function isProductUrl(value, domain) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    // Do not accept prelive/staging hosts or retailer names in query strings.
    if (host !== domain.toLowerCase().replace(/^www\./, '')) return false;
    const path = decodeURIComponent(url.pathname);
    if (/\/(collections|categories|brands|search)(\/|$)/i.test(path) && !/\/products\/[^/]+\/?$/i.test(path)) return false;
    if (domain === 'evocycles.co.nz' || domain === 'hyperride.co.nz') {
      return /^\/products?\/\d+(?:\/[^/]+)?\/?$/i.test(path) ||
        /^\/products?\/[a-z0-9][a-z0-9-]{3,}\/?$/i.test(path);
    }
    if (domain === '99bikes.co.nz') return /^\/(?:collections\/[^/]+\/)?products?\/[^/]+\/?$/i.test(path);
    // Kiwivelo has also used flat .html product URLs. The fetched H1 must
    // still independently identify the product before any price is used.
    return /^\/(?:products?|product|shop)\/[^/]+|^\/[^/]+\.html$/i.test(path);
  } catch { return false; }
}

function productSection(text, brand, name) {
  if (typeof text !== 'string') return null;
  // TinyFish normally emits the product name as H1, but some retailer
  // templates are normalized as H2/H3. Accept any Markdown heading while
  // still requiring the heading itself to identify this exact product.
  const headings = [...text.matchAll(/^#{1,6}\s+(.+)$/gm)];
  let heading = headings.find(h => titleMatches(h[1], brand, name));
  // If the extractor returns a plain-text H1 instead of Markdown, anchor on
  // the first line that names this product. The exact title check remains in
  // force; this only changes how the content boundary is located.
  if (!heading) {
    let offset = 0;
    for (const line of text.split(/\n/)) {
      const cleaned = line.replace(/^\s*[->*#]+\s*/, '').trim();
      if (titleMatches(cleaned, brand, name)) {
        heading = { index: offset, 0: line, 1: cleaned };
        break;
      }
      offset += line.length + 1;
    }
  }
  if (!heading) return null;
  // Retailer pages normally contain several Markdown headings: the product
  // title, price, description, specifications and recommendations. The old
  // `headings.length === 1` check rejected every real page with more than one
  // section and left a valid product stuck at “Price unverified”. Keep the
  // matching product title as the anchor and read only its nearby content.
  const start = heading.index + heading[0].length;
  // Keep level-two price/subheading content; stop at the next top-level
  // section such as Description or Specifications.
  const rest = text.slice(start);
  const nextHeadingMatch = rest.match(/^#\s+(.+)$/m);
  let sectionEnd = start + 8000;
  if (nextHeadingMatch) {
    // Some product templates render the price as an H1 immediately after
    // the product title. Keep that price heading in the product section,
    // then stop at the following top-level section.
    const priceHeading = /(?:price|now|sale|NZ\$|\$|\d[\d,.]*\.\d{2})/i.test(nextHeadingMatch[1]);
    if (!priceHeading) sectionEnd = start + nextHeadingMatch.index;
    else {
      const afterPrice = start + nextHeadingMatch.index + nextHeadingMatch[0].length;
      const following = text.slice(afterPrice).search(/^#\s+/m);
      sectionEnd = following >= 0 ? afterPrice + following : afterPrice + 8000;
    }
  }
  let section = text.slice(start, sectionEnd);
  // Require a price-shaped product-page signal inside the anchored section.
  // A bare dollar amount immediately after a title can be a related card;
  // retailer pages normally expose a price heading, NZ currency marker, or
  // explicit price label.
  if (!/^#{1,6}\s+.*(?:\$|\d[\d,.]*\.\d{2})/m.test(section) &&
      !/^#{1,6}\s+(?:NZD\s*)?(?:NZ\$|\$)?\s*\d{3,}(?:\.\d{2})?(?:\s*NZD)?\s*$/im.test(section) &&
      !/\b(?:price|now|sale)\s*:/i.test(section) &&
      !/\bNZ\$\s*\d/i.test(section) &&
      !/(?:NZ\$|\$)\s*\d[\d,]*\.\d{2}\b/.test(section)) return null;
  // Never scan recommendations, description specifications or service plans.
  const end = section.search(/(?:^#{1,6}\s+(?:related|recommended|you may|customers|description|specifications|maintenance|service plans|finance options|choose (?:size|amount)|quantity)|\badd to (?:cart|bag|basket)\b)/im);
  if (end >= 0) section = section.slice(0, end);
  return { title: heading[1].trim(), text: section };
}

export function extractPrice(text, bounds) {
  if (typeof text !== 'string') return null;
  // Remove explicitly struck-out original prices, links/images and formatting.
  const cleaned = text.replace(/~~[\s\S]*?~~/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_]/g, '');
  const candidates = [];
  for (const rawLine of cleaned.split('\n')) {
    const line = rawLine.replace(/^\s*#{1,6}\s*/, '').trim();
    if (!line || /\{\{|\}\}/.test(line)) continue;
    // Ambiguous foreign currency, ranges and conditional/member prices must
    // not be presented as an unconditional NZD checkout price.
    if (/\b(?:USD|AUD|from|member|club|with code|coupon)\b|(?:US|AU|A)\s*\$/i.test(line) || /[€£]/.test(line)) continue;
    const matches = [...line.matchAll(/(?:NZ\$|NZD\s*\$?|\$)\s*(\d+(?:,\d{3})*(?:\.\d{2})?)(?![\d.,])/g)];
    // Some rendered pages (including Evo) show the main price as a bare heading.
    if (!matches.length && /^(?:price\s*:?\s*)?\d+(?:,\d{3})*\.\d{2}(?:\s*NZD)?$/i.test(line)) {
      const match = line.match(/\d+(?:,\d{3})*\.\d{2}/);
      matches.push(Object.assign([match[0], match[0]], { index: match.index }));
    }
    if (!matches.length && /^(?:price|now|sale(?:\s+price)?)\s*:?\s*\d+(?:,\d{3})*(?:\.\d{2})?(?:\s*NZD)?$/i.test(line)) {
      const match = line.match(/\d+(?:,\d{3})*(?:\.\d{2})?/);
      matches.push(Object.assign([match[0], match[0]], { index: match.index }));
    }
    if (!matches.length && /^\d{3,}(?:\.\d{2})?(?:\s*NZD)?$/i.test(line) && /^\s*#{1,6}\s+/.test(rawLine)) {
      const match = line.match(/\d+(?:,\d{3})*(?:\.\d{2})?/);
      matches.push(Object.assign([match[0], match[0]], { index: match.index }));
    }
    if (/(?:\$[\d,.]+\s*[-–—]\s*(?:(?:NZ)?\$)?\s*\d|\bto\s*(?:NZ)?\$)/i.test(line)) return null;
    for (const match of matches) {
      const before = line.slice(0, match.index);
      const after = line.slice(match.index + match[0].length);
      const immediate = before.slice(-80);
      if (/(?:was|rrp|regular price|save|saving|discount|shipping|freight|delivery|deposit|postage)\s*:?\s*$/i.test(immediate)) continue;
      if (/(?:payments?\s*(?:of|from)?|per (?:week|month)|as low as|interest free from)\s*$/i.test(immediate)) continue;
      if (/^\s*(?:off|discount|shipping|delivery|freight|deposit|postage|per\s+(?:week|month)|\/\s*(?:week|month))/i.test(after)) continue;
      // Reject price-bearing prose/upsells; accept a standalone price or a
      // clearly labelled price, optionally followed by a financing sentence.
      if (before.trim() && !/^(?:(?:sale|our|now|current|online)\s*)?(?:price\s*)?:?\s*$/i.test(before.trim()) && !/(?:now|sale price)\s*:?\s*$/i.test(before)) continue;
      const num = Number(match[1].replace(/,/g, ''));
      if (!Number.isFinite(num) || num <= 0 || (bounds && (num < bounds[0] || num > bounds[1]))) continue;
      candidates.push({ num, sale: /(?:sale price|now|our price)\s*:?\s*$/i.test(immediate) });
    }
  }
  const sale = candidates.filter(c => c.sale);
  const prices = [...new Set((sale.length ? sale : candidates).map(c => c.num))];
  // Multiple unlabelled prices could be sizes, variants or upsells. Do not guess.
  return prices.length === 1 ? prices[0] : null;
}

async function requestJson(fetchImpl, url, init, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return { error: 'timeout' };
  try {
    const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(remaining) });
    if (!response.ok) return { error: response.status === 429 ? 'rate_limited' : `provider_http_${response.status}` };
    const data = await response.json();
    if (!Array.isArray(data.results)) return { error: 'invalid_response' };
    return { data };
  } catch (error) {
    return { error: /Timeout|Abort/.test(error.name) ? 'timeout' : 'provider_unavailable' };
  }
}

function decodeHtml(value) {
  return value.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function htmlToProductText(html) {
  if (typeof html !== 'string') return null;
  const withoutNoise = html.replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  const withHeadings = withoutNoise.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_, level, inner) => `\n${'#'.repeat(Number(level))} ${inner}\n`);
  const withBreaks = withHeadings.replace(/<\/(?:p|div|section|article|li|tr|td|th|br|main|header|footer)\b[^>]*>/gi, '\n');
  return decodeHtml(withBreaks.replace(/<[^>]+>/g, ' ').replace(/[\t\r ]+/g, ' '))
    .split('\n').map(line => line.trim()).filter(Boolean).join('\n');
}

export function extractEmbeddedPrice(html, brand, name, bounds) {
  if (typeof html !== 'string') return null;
  const titleMatch = html.match(/<h1\b[^>]*id=["']product-title["'][^>]*>([\s\S]*?)<\/h1>/i);
  const title = titleMatch && decodeHtml(titleMatch[1].replace(/<[^>]+>/g, ' ').trim());
  if (!title || !titleMatches(title, brand, name)) return null;
  const values = [];
  const dollars = html.match(/<span\b[^>]*id=["']product-price-dollars["'][^>]*>\s*([\d,]+)\s*<\/span>\s*<span\b[^>]*id=["']product-price-cents["'][^>]*>\s*(\.\d{2})\s*<\/span>/i);
  if (dollars) values.push(Number(`${dollars[1].replace(/,/g, '')}${dollars[2]}`));
  const itemPattern = /"item_name"\s*:\s*"((?:\\.|[^"\\])*)"\s*,\s*"item_brand"\s*:\s*"((?:\\.|[^"\\])*)"[\s\S]{0,320}?"price"\s*:\s*(\d+(?:\.\d+)?)/g;
  for (const match of html.matchAll(itemPattern)) {
    const itemName = match[1].replace(/\\"/g, '"');
    const itemBrand = match[2].replace(/\\"/g, '"');
    if (titleMatches(`${itemBrand} ${itemName}`, brand, name)) values.push(Number(match[3]));
  }
  const valid = [...new Set(values.filter(value => Number.isFinite(value) && value > 0 && (!bounds || (value >= bounds[0] && value <= bounds[1]))) )];
  return valid.length === 1 ? { title, price: valid[0] } : null;
}

async function fetchDirectProductText(fetchImpl, url, deadline) {
  // Unit-test providers intentionally only implement the TinyFish endpoints;
  // the direct retailer fallback is reserved for the production fetch.
  if (fetchImpl !== fetch) return null;
  const remaining = deadline - Date.now();
  if (remaining <= 0) return null;
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': 'Trailhead price checker' },
      signal: AbortSignal.timeout(remaining)
    });
    if (!response.ok) return { status: response.status, text: null };
    const raw = await response.text();
    return { status: response.status, text: htmlToProductText(raw), raw };
  } catch (error) { return { status: error?.name || 'error', text: null }; }
}

export async function fetchLivePrices(apiKey, brand, name, catKey, retailers, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const deadline = Date.now() + (options.timeoutMs ?? 24000);
  const headers = { 'X-API-Key': apiKey };
  const candidates = await Promise.all(retailers.map(async retailer => {
    const runSearch = query => requestJson(fetchImpl,
      `https://api.search.tinyfish.ai?query=${encodeURIComponent(query)}&location=NZ&language=en`,
      { headers }, Math.min(deadline, Date.now() + 7000));
    const relevant = data => (data?.results || []).filter(r => r && isProductUrl(r.url, retailer.domain) &&
      // Retailer result titles sometimes omit the brand; the exact product
      // slug in the already-validated retailer URL is an equivalent signal.
      titleMatches(`${r.title || ''} ${r.url || ''}`, brand, name));
    const queries = [
      `${brand} ${name} site:${retailer.domain}`,
      `"${brand} ${name}" ${retailer.domain}`,
      `${brand} ${name} ${retailer.name} NZ`
    ];
    let pages = [];
    let firstError = null;
    for (const query of queries) {
      if (Date.now() >= deadline) break;
      const result = await runSearch(query);
      if (result.error) { firstError ||= result.error; continue; }
      pages = relevant(result.data);
      if (pages.length) break;
    }
    if (!pages.length && firstError) return { retailer, error: firstError, pages: [] };
    return { retailer, pages: [...new Map(pages.map(p => [p.url, p])).values()].slice(0, 2) };
  }));

  const urls = [...new Set(candidates.flatMap(c => c.pages.map(p => p.url)))];
  let fetched = { data: { results: [], errors: [] } };
  if (urls.length) {
    fetched = await requestJson(fetchImpl, 'https://api.fetch.tinyfish.ai', {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls, format: 'html' })
    }, deadline);
  }
  const byUrl = new Map((fetched.data?.results || []).filter(p => p && typeof p.url === 'string').map(p => [p.url, p]));
  const errors = new Map((fetched.data?.errors || []).filter(p => p && p.url).map(p => [p.url, p.error]));
  const results = await Promise.all(candidates.map(async c => {
    const base = { retailer: c.retailer.name, price: 'No matching listing', price_amount: null,
      currency: 'NZD', in_stock: null, url: null, product_title: null,
      promo_code: null, promo_details: null, status: 'not_found', error_code: null };
    if (c.error) return { ...base, price: 'Lookup unavailable', status: 'unavailable', error_code: c.error };
    if (!c.pages.length) return base;
    let failure = { ...base, price: 'Price unverified', status: 'unverified' };
    for (const candidate of c.pages) {
      const page = byUrl.get(candidate.url);
      if (!page || typeof page.text !== 'string') {
        failure = { ...failure, price: 'Lookup unavailable', status: 'unavailable',
          error_code: fetched.error || errors.get(candidate.url) || 'missing_page' };
        continue;
      }
      const finalUrl = page.final_url || page.url;
      if (!isProductUrl(finalUrl, c.retailer.domain)) continue;
      // Some retailer templates return a generic page title even though the
      // fetched content has the matching product heading. The search title is
      // an acceptable discovery signal; productSection still requires the
      // exact product identity in the fetched page before reading a price.
      if (!titleMatches(page.title, brand, name) &&
          !titleMatches(`${candidate.title || ''} ${candidate.url || ''}`, brand, name)) continue;
      let section = productSection(page.text, brand, name);
      let price = section ? extractPrice(section.text, CATEGORY_BOUNDS[catKey]) : null;
      // TinyFish's clean extraction can omit the dynamic product price even
      // when it is present in the retailer's rendered HTML. Fetch that exact
      // page directly as a narrowly-scoped fallback before giving up.
      if (price === null) {
        const direct = await fetchDirectProductText(fetchImpl, finalUrl, deadline);
        const embedded = direct?.raw && extractEmbeddedPrice(direct.raw, brand, name, CATEGORY_BOUNDS[catKey]);
        if (embedded) {
          section = { title: embedded.title, text: `# ${embedded.title}\n\n## ${embedded.price.toFixed(2)}` };
          price = embedded.price;
        } else {
          const directSection = direct?.text && productSection(direct.text, brand, name);
          if (directSection) { section = directSection; price = extractPrice(section.text, CATEGORY_BOUNDS[catKey]); }
        }
      }
      if (!section) continue;
      const matched = { ...base, url: finalUrl, product_title: section.title,
        price: 'Price unverified', status: 'unverified' };
      if (price === null) { failure = matched; continue; }
      // Unknown variant-level stock stays unknown. A generic Add to cart button
      // isn't proof that a particular size/colour is available.
      return { ...matched, price: `NZ$${price.toFixed(2)}`, price_amount: price,
        status: 'verified', checked_at: Date.now() };
    }
    return failure;
  }));
  return {
    results,
    // The catalog doesn't specify size, colour or model year. A cheapest badge
    // would imply like-for-like stock that these searches cannot establish.
    cheapest_retailer: null,
    complete: results.every(r => r.status === 'verified' || r.status === 'not_found'),
    note: 'Prices come only from matching retailer product pages. Listings may differ by year, size, colour or pack quantity; compare the listing titles and confirm availability and the final price at the retailer. Unverified prices and promo codes are not estimated.'
  };
}
