# Trailhead — NZ Bike Shop Price Comparison (Scales, Free)

## How this handles many visitors on a free tier

The earlier version ran a live TinyFish search every time *anyone* clicked
a product. That's fine for one person testing it, but falls over with real
traffic — TinyFish's free tier only allows a few requests per minute, and
enough visitors would exhaust it in seconds.

This version separates the two jobs:

- **`api/refresh-batch.js`** is the only thing that ever calls TinyFish. A
  free external scheduler (not Vercel's own cron — see below) hits it
  every couple of minutes. Each call checks one product from the catalog
  and saves the result to a shared cache (Redis). It cycles through the
  whole catalog on a rolling basis — roughly every ~2 hours with a 2-minute
  schedule.
- **`api/lookup.js`** is what visitors' clicks actually hit. It reads from
  that same cache — no TinyFish call, no rate limit, just a fast read.
  However many people are on the site at once, they're all just reading
  the same pre-computed data. If a product somehow isn't cached yet (e.g.
  right after first deploy), it falls back to a live search for that one
  request and saves the result for next time.
- A **"Check live now"** button in the product modal bypasses the cache on
  demand, for anyone who wants the freshest possible check for one item.

This means: fast for everyone (cache reads are near-instant), and total
TinyFish usage stays flat and predictable no matter how many visitors show
up, because it's decoupled from visitor traffic entirely.

## What you need (all free)

1. **Vercel** — hosting, same as before.
2. **Upstash Redis** — the shared cache. Free tier: 500,000 commands/month,
   256MB storage. No card required. This easily covers hundreds of daily
   visitors.
3. **TinyFish** — same as before, free Search API.
4. **A free external scheduler** — Vercel's own Hobby-plan cron only allows
   once-per-day, which is too infrequent here. Use a free service like
   **cron-job.org** instead to call `api/refresh-batch.js` every 2 minutes.

## Setup

### 1. Create a free Upstash Redis database

- Go to https://upstash.com → sign up (no card) → create a Redis database.
- On the database page, copy the **REST URL** and **REST Token**
  (not the regular Redis connection string — you specifically want the
  REST API credentials, since Vercel serverless functions use those).

### 2. Deploy to Vercel

Same as before — import the GitHub repo, framework preset "Other".
Before deploying, add these Environment Variables:

| Name | Value |
|---|---|
| `TINYFISH_API_KEY` | from agent.tinyfish.ai/api-keys |
| `UPSTASH_REDIS_REST_URL` | from your Upstash database page |
| `UPSTASH_REDIS_REST_TOKEN` | from your Upstash database page |
| `REFRESH_SECRET` | make up any long random string yourself — this protects `api/refresh-batch.js` from randoms spamming your TinyFish quota |

Deploy.

### 3. Set up the free scheduler

- Go to https://cron-job.org → sign up (free) → create a new cron job.
- URL: `https://YOUR-SITE.vercel.app/api/refresh-batch?secret=YOUR_REFRESH_SECRET`
  (use the same `REFRESH_SECRET` value you set in Vercel).
- Schedule: every 2 minutes.
- Save and enable it.

Within a couple of hours, the whole 60-product catalog will have been
checked at least once and the cache will be fully warm. From then on,
every visitor's click is served instantly from cache.

### 4. Verify it's working

- Visit `https://YOUR-SITE.vercel.app/api/refresh-batch?secret=YOUR_REFRESH_SECRET`
  directly in a browser once — it should return JSON like
  `{"processed": "Giant Talon 29 3", "cursor": 0, "nextCursor": 1, ...}`.
  Run it a few more times (or just wait for the scheduler) to warm up more
  of the catalog.
- Open the live site and click a product that's already been processed —
  it should load near-instantly and say "Loaded from cache."

## If something goes wrong

- **Products show "Not found" for a while after first deploy** — expected;
  the cache starts empty and fills in over the first couple of hours as
  the scheduler works through the catalog. Use "Check live now" for an
  immediate answer on a specific product while you wait.
- **`api/refresh-batch.js` returns 401** — the `secret` in your cron-job.org
  URL doesn't match `REFRESH_SECRET` in Vercel's environment variables.
- **"Server is missing UPSTASH_REDIS_REST_URL..."** — env vars aren't set,
  or you need to redeploy after adding them.
- **Site feels slow again** — check that the scheduler is actually running
  (cron-job.org shows a history/log of each run). If it stopped, cached
  entries will still work but stop refreshing, and any never-cached
  product falls back to the slower live path.

## Cost note

Genuinely free at this traffic level: Vercel Hobby, TinyFish free tier
(now only used by the background job, not by visitors), Upstash free tier,
cron-job.org free tier. Worth periodically checking each provider's
current free-tier limits, since they do change over time.
