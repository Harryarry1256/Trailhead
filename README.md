# Trailhead — NZ bike retailer price checks

The browser, lookup endpoint and scheduled refresh share `lib/catalog.js`.
The catalog contains search targets, not a claim that every retailer stocks
those products. A target may cover multiple years, colours, sizes or packs.
Always compare the returned retailer listing titles before purchasing.

## Accuracy rules

- Search results discover at most two candidate product URLs per retailer.
- Prices must come from the fetched product page, with a matching title and
  main product heading on the retailer's production domain. Redirects are checked.
- Search snippets never supply prices. Related items, crossed-out prices,
  shipping charges, instalments and ambiguous price ranges are excluded.
- A missing search match, failed provider request and unverified price have
  separate statuses. None means the product is out of stock.
- Stock, promo codes and a like-for-like cheapest retailer are not inferred.
  The catalog has no variant IDs or verified stock feed to support those claims.
- Late lookup responses cannot replace the results of a newer product selection.

## Hosting and configuration

Deploy the repository to Vercel with framework preset **Other**, Node.js 22+
(default compatible runtime), and these server-only environment variables:

| Variable | Purpose |
|---|---|
| `TINYFISH_API_KEY` | TinyFish Search and Fetch API access |
| `UPSTASH_REDIS_REST_URL` | Upstash REST endpoint |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash REST token |
| `REFRESH_SECRET` | Secret protecting the background refresh endpoint |

Do not commit credentials. Redeploy after updating environment variables.
Install dependencies with `pnpm install --frozen-lockfile`.

`POST /api/lookup` accepts a catalog `brand` and `name`, optional matching
`catKey`, and a legacy boolean `force` that is accepted but ignored. This endpoint
only reads Redis: neither missing entries, reloads nor cache outages call the
search provider or write price data. Missing entries return `pending: true` and
an awaiting-update message. Cache outages return HTTP 503.

The cache uses the `price:v2:` namespace, bypassing results from the previous
extraction logic without deleting them. New complete snapshots are retained for
24 hours, including completed searches with no matches. After six hours, results
are explicitly marked as awaiting refresh; after 24 hours they are not served.
Incomplete checks never overwrite saved data or extend its lifetime. The original
check time is always shown. Existing entries keep their expiry until cron replaces
them; deployment does not clear or rewrite saved prices.

## Background refresh

Configure an external scheduler to request `GET /api/refresh-batch` with an
`x-refresh-secret` header matching `REFRESH_SECRET`. The legacy `?secret=...`
query is still accepted, but the header avoids putting the secret in URLs.

Each call refreshes **two** products concurrently with the same 24-second
per-product deadline and shared provider pacing. At a two-minute scheduler
interval, the current 167-product catalog takes about 2 hours 48 minutes per pass.

Verified product URLs are stored separately in Redis (`discovery:v1:`) for seven
days, renewed on successful checks. Existing saved price results can bootstrap
this URL cache. Known URLs go straight to TinyFish Fetch, skipping Search for
that retailer. Every price still requires a fresh fetched page, matching product
identity and a valid retailer URL. If a known page fails validation, discovery is
invalidated for the next pass; the existing good price and its expiry are retained.

Retailers without known URLs still use Search. Successful search responses are
cached for one hour; empty responses for six hours. Provider errors are not cached
as empty searches. Both jobs share the existing 26-request rolling minute budget
and respect provider Retry-After responses. This reduces repeat discovery; it does
not remove provider limits or guarantee access to every retailer.

The response reports `processed`, `saved`, `savedCount`, `cursor`, `nextCursor`
and `totalProducts`. A partial batch saves its successful product independently,
returns HTTP 502 with product/retailer errors, and advances past both products.
Failed products retain their original saved price timestamps and expiry. Visitor
lookups remain cache-only and consume no search or fetch allowance.

## Troubleshooting

- **Saved prices unavailable:** check the Upstash configuration and service health.
- **Awaiting saved prices:** no usable snapshot exists yet. Check scheduler logs;
  a full pass takes about 2 hours 48 minutes at a two-minute interval.
- **Scheduled refresh failures:** check provider access, service health and rate limits.
  Error codes `provider_http_401/402/403/404` require checking the TinyFish account
  or API configuration. HTTP 429 is reported as `rate_limited`.
- **Price unverified:** the fetched page lacks an unambiguous matching product
  price. Do not substitute a search-snippet price. Review the actual page format
  and add a regression test before changing the extraction rules.
- **No matching listing:** search returned no acceptable product page. It does
  not establish that the retailer is out of stock.
- **Stale timestamps:** check scheduler logs and configuration. Previously saved
  prices remain labeled with their actual age for up to 24 hours if refreshes fail.

## Validation

Run `pnpm test` (or `node --test` after installing dependencies).
Tests cover price parsing, model and URL matching, provider errors, redirects,
cache expiry/failure preservation, API input and the browser request race.
Provider responses in automated tests are fixtures, not live account checks.
After deployment, check representative products against their exact retailer
pages, confirm reloads retain the saved timestamp, and verify scheduled refreshes
continue. A missing snapshot must show as awaiting update, never as an invented
price or an out-of-stock claim.

Provider contracts: [Search API](https://docs.tinyfish.ai/search-api/reference)
and [Fetch API](https://docs.tinyfish.ai/fetch-api/reference).
