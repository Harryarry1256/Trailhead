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
`catKey`, and boolean `force`. A valid cache entry is returned unless force
is true. Cache misses and forced checks call the provider. Live work is bounded
to 24 seconds so a failed provider can return an error within Vercel's 30-second
function limit. The browser stops waiting after 28 seconds.

The cache uses the `price:v2:` namespace, bypassing results from the previous
extraction logic without deleting them. Complete checks with prices expire after
six hours. Complete searches with no matches expire after five minutes.
Incomplete checks never overwrite valid cached data. Cache age is shown to users.

## Background refresh

Configure an external scheduler to request `GET /api/refresh-batch` with an
`x-refresh-secret` header matching `REFRESH_SECRET`. The legacy `?secret=...`
query is still accepted, but the header avoids putting the secret in URLs.

Each call processes **one** product: up to four searches and one fetch batch
of up to eight pages. At a two-minute interval, 160 products take about
5 hours 20 minutes to cycle. A shorter schedule must account for the provider's
account-wide limits and interactive lookups. These limits are not enforced by
per-process counters because Vercel uses multiple function instances.

The response reports `processed`, `saved`, `cursor`, `nextCursor` and
`totalProducts`. Incomplete checks return HTTP 502 and retailer error statuses;
the cursor advances so one blocked product cannot stall the whole catalog.
Other failures return a useful error instead of a successful empty result.

## Troubleshooting

- **Lookup unavailable:** check provider access, service health and rate limits.
  Error codes `provider_http_401/402/403/404` require checking the TinyFish account
  or API configuration. HTTP 429 is reported as `rate_limited`.
- **Price unverified:** the fetched page lacks an unambiguous matching product
  price. Do not substitute a search-snippet price. Review the actual page format
  and add a regression test before changing the extraction rules.
- **No matching listing:** search returned no acceptable product page. It does
  not establish that the retailer is out of stock.
- **Stale timestamps:** check scheduler logs and configuration. Cache entries
  expire even if the scheduler stops.

## Validation

Run `pnpm test` (or `node --test` after installing dependencies).
Tests cover price parsing, model and URL matching, provider errors, redirects,
cache expiry/failure preservation, API input and the browser request race.
Provider responses in automated tests are fixtures, not live account checks.
After deployment, check representative products against their exact retailer
pages and exercise forced refresh. A missing/blocked provider must remain visibly
unavailable, never become an invented price or an out-of-stock claim.

Provider contracts: [Search API](https://docs.tinyfish.ai/search-api/reference)
and [Fetch API](https://docs.tinyfish.ai/fetch-api/reference).
