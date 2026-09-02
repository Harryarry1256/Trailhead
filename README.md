# Trailhead — NZ Bike Shop Price Comparison (Free Version)

A static front end + one small serverless function. The function calls
TinyFish's free Search API (https://docs.tinyfish.ai/search-api) to look up
each retailer's search results for a product, and pulls a price out of the
result snippets. No paid API required — TinyFish's Search endpoint is free
at any wallet balance, including $0, no credit card needed.

**Tradeoff vs. the paid version:** this reads search-result snippets, not a
full page. It's less consistently accurate than an AI actually reading the
product page — some items will show "Not found" even when the product is
in stock, and promo codes will rarely show up (they're mostly on banners,
not in search snippets). It's a real live lookup, just a rougher one.

## Files

- `index.html` — the whole site (product grid, search, comparison modal).
- `api/lookup.js` — serverless function that calls TinyFish per retailer.

## Deploy it (Vercel, free tier)

1. **Get a free TinyFish API key**
   Go to https://agent.tinyfish.ai/api-keys, sign up, create a key.
   No credit card required. Check https://docs.tinyfish.ai/search-api or
   https://tinyfish.ai/pricing for the current free-tier rate limit before
   you launch, since it does change — the code paces requests to be gentle
   on it, but very frequent clicking could still hit a rate limit.

2. **Put this project in a GitHub repo**
   Create a new repo, add these files, commit, push.

3. **Import into Vercel**
   - Go to https://vercel.com → New Project → Import your GitHub repo.
   - Framework preset: "Other" (no build step needed).
   - Before deploying, add an Environment Variable:
     - Name: `TINYFISH_API_KEY`
     - Value: the key from step 1
   - Click Deploy.

   **Alt (no GitHub, from your machine):**
   ```bash
   npm install -g vercel
   cd trailhead-site
   vercel
   vercel env add TINYFISH_API_KEY
   vercel --prod
   ```

4. **Test it**
   Open the deployed URL, click a product. It should show a spinner, then
   real search results — cheapest one highlighted, and a "Visit" link per
   retailer straight to the search result TinyFish found.

## If something goes wrong

- **"Server is missing TINYFISH_API_KEY"** — the env var isn't set, or you
  need to redeploy after adding it (Vercel only picks up new env vars on the
  next deploy).
- **Some/most retailers show "Not found"** — expected sometimes. Snippet
  text doesn't always contain a clean price. If it's happening on nearly
  every product, double check your API key is valid and not rate-limited.
- **"Rate limited — try refreshing in a moment"** on a retailer row — you've
  hit TinyFish's free-tier rate limit. Wait a few seconds and click
  "Refresh prices" in the modal.

## Cost note

This version has no per-click API cost. Vercel's own free tier covers
light traffic; if this gets heavy public use, check Vercel's current
free-tier limits at https://vercel.com/docs/limits before assuming it
stays $0 indefinitely.
