# Deploying 3D Armory to Cloudflare

3D Armory runs entirely on Cloudflare:

| Piece | Cloudflare product | What it stores / does |
| --- | --- | --- |
| The store itself | **Workers** | Runs every page, the cart, checkout and the admin CMS |
| CSS, JS, logo, demo artwork | **Workers static assets** | Served from Cloudflare's edge, no extra setup |
| Products, categories, orders, settings | **D1** (SQLite database) | Binding `DB` |
| Uploaded product photos | **R2** (file storage) | Binding `IMAGES` |

The free plans for Workers, D1 and R2 easily cover a small store. Enabling R2 requires a payment method on your Cloudflare account, even if you stay inside the free tier.

You'll need [Node.js](https://nodejs.org) 20 or newer and a free [Cloudflare account](https://dash.cloudflare.com/sign-up). All commands are run from the project folder. In IntelliJ, use the built-in **Terminal**.

---

## 1. Install and log in

```bash
npm install
npx wrangler login          # opens your browser to connect Wrangler to your Cloudflare account
```

## 2. Create the database and image bucket

```bash
npx wrangler d1 create 3darmory
npx wrangler r2 bucket create 3darmory-images
```

`d1 create` prints a `database_id`. Open **`wrangler.jsonc`** and paste it in place of `REPLACE_WITH_YOUR_D1_DATABASE_ID`.

While you're in `wrangler.jsonc`, also check the `vars` section:

- `ADMIN_EMAIL`: the email you'll use to sign in to `/admin`
- `CURRENCY`: `usd`, `gbp`, `eur`, `aud`, and so on
- `SHIPPING_COUNTRIES`: the countries you ship to, as comma-separated codes

## 3. Set up the database tables

```bash
npm run db:migrate:remote   # creates the tables + default site settings
npm run db:seed:remote      # optional: loads the 8 demo products (skip it to start empty)
```

## 4. Add your secrets

Each command asks you to paste a value. Secrets are stored encrypted by Cloudflare and never go in git.

```bash
npx wrangler secret put SESSION_SECRET         # a long random string (see below)
npx wrangler secret put ADMIN_PASSWORD         # your admin password
npx wrangler secret put STRIPE_SECRET_KEY      # sk_test_… while testing, sk_live_… when you go live
```

To generate a `SESSION_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 5. Deploy

```bash
npm run deploy
```

Wrangler prints your store's address, something like `https://3darmory.<your-subdomain>.workers.dev`. Open it to see the store, and go to `/admin` to sign in.

## 6. Connect Stripe (payment confirmations)

Stripe uses a webhook to tell your store that an order has been paid.

1. Stripe dashboard (start in **Test mode**) → *Developers → Webhooks → Add endpoint*.
2. Endpoint URL: `https://<your-store-address>/webhooks/stripe`
3. Events: `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`
4. Copy the endpoint's signing secret (`whsec_…`) and save it:

   ```bash
   npx wrangler secret put STRIPE_WEBHOOK_SECRET
   ```

**Place a test order:** add something to the cart, check out, and pay with card `4242 4242 4242 4242`, any future expiry date and any CVC. The order shows up under **Admin → Orders** as *paid*, and that product's stock goes down.

---

## Using your own domain

Workers dashboard → your `3darmory` Worker → **Settings → Domains & Routes → Add → Custom domain**, then enter something like `shop.3darmory.com`. The domain's DNS must be managed by Cloudflare. HTTPS is automatic.

Then update the Stripe webhook URL to the new domain. Links in Stripe emails and redirects use whichever address the customer visited, so you don't need to change any other setting. (To force one address, add `"BASE_URL": "https://shop.3darmory.com"` to `vars` in `wrangler.jsonc`.)

## Automatic deploys from GitHub (optional)

Workers dashboard → your Worker → **Settings → Builds → Connect** → choose the `docpng/3darmory` repository and the `main` branch. Keep the default deploy command (`npx wrangler deploy`). Every push to `main` then redeploys the store. Secrets and the database are kept between deploys.

If you add a new file to `migrations/` later, run `npm run db:migrate:remote` once to apply it.

---

## Running it locally (IntelliJ or any terminal)

Everything runs on your machine with a local copy of D1 and R2. No Cloudflare account is needed for this part.

```bash
npm install
cp .dev.vars.example .dev.vars    # then fill in SESSION_SECRET and ADMIN_PASSWORD (Stripe keys optional)
npm run setup                     # creates the local database and loads the demo products
npm run dev                       # http://localhost:8787
```

In IntelliJ, open `package.json` and click ▶ next to `setup` (first time only), then ▶ next to `dev`. `dev` reloads automatically when you save a file. Use **Debug** instead of Run to stop at breakpoints.

To test payments locally, put your `sk_test_…` key in `.dev.vars`, then run:

```bash
stripe listen --forward-to localhost:8787/webhooks/stripe
```

Copy the `whsec_…` value it prints into `STRIPE_WEBHOOK_SECRET` in `.dev.vars`, and restart `npm run dev`.

The local database and uploaded images are stored in `.wrangler/` (git ignores that folder). To start fresh, delete `.wrangler/` and run `npm run setup` again.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Page says "The database has not been set up yet" | Run `npm run db:migrate:remote` (deployed site) or `npm run db:migrate:local` (local). |
| "SESSION_SECRET is not configured" | `npx wrangler secret put SESSION_SECRET` (deployed), or add it to `.dev.vars` (local). |
| Admin login says it isn't configured | Set `ADMIN_EMAIL` in `wrangler.jsonc` and the `ADMIN_PASSWORD` secret. |
| "Checkout unavailable" button | `STRIPE_SECRET_KEY` isn't set. Add the secret; there's no need to redeploy. |
| Orders stay "pending" | The webhook isn't reaching the store. Check the endpoint URL and `STRIPE_WEBHOOK_SECRET`, and look for failed deliveries under *Developers → Webhooks* in Stripe. Orders are also confirmed when the customer reaches the success page. |
| `wrangler deploy` complains about the database id | Paste the id from `npx wrangler d1 create 3darmory` into `wrangler.jsonc`. To find it later, run `npx wrangler d1 list`. |
| Product photos don't appear on the Stripe payment page | Stripe only shows JPG/PNG/WebP photos over HTTPS. The demo SVG artwork never appears there; upload real photos in the admin. |
| Changed a template in `views/` but nothing changed | `npm run dev` and `npm run deploy` rebuild templates automatically. If you run Wrangler another way, run `npm run build` first. |

## Logs

```bash
npx wrangler tail          # live logs from the deployed store
```

Logs are also in the dashboard: your Worker → **Observability**.
