# 3D Armory

Online store for **3D Armory**: 3D printed models, figures and trinkets. It has a modern black & gold storefront, an admin CMS for the owner, and checkout through **Stripe**. It runs on **Cloudflare Workers**.

![Stack](https://img.shields.io/badge/stack-Cloudflare%20Workers%20%7C%20D1%20%7C%20R2%20%7C%20Hono%20%7C%20Stripe-d4af37?labelColor=0b0b0c)

## Features

**Storefront**
- Home page with a hero section, collections, featured products, the workshop process and a custom-order call to action
- Shop page with category filters, search and sorting
- Product pages with sale pricing, stock status, material and size specs, and related products
- Cart that stores quantities in the session and limits them to available stock
- Stripe Checkout with shipping-address collection, flat-rate or free shipping, and an order confirmation page
- Responsive layout for phones, tablets and desktop

**Admin CMS** (`/admin`)
- Dashboard with revenue, paid orders, orders to fulfil, low-stock alerts and a payment setup checklist
- Products: create, edit and delete products, with price, sale ("compare-at") price, category, stock tracking or made-to-order, material, size, image upload, featured flag and visibility
- Categories: add, rename, reorder and delete
- Orders: view customer and shipping details, update status (paid → shipped → completed) and keep internal notes
- Site settings: edit the store name, tagline, announcement bar, home page hero, About page, contact email and shipping rates without touching code

**Security**
- Prices are always read from the database on the server, so customers cannot change them
- Stripe webhook signature verification, with order fulfilment that stays correct if Stripe sends the same event twice
- CSRF protection on every form, signed session cookies, login rate limiting, and a strict Content Security Policy
- Uploads must be JPG, PNG, WebP or GIF (checked against the file's actual bytes), up to 8 MB, and get random file names

## Quick start (local)

Requires Node.js 20 or newer. No Cloudflare account is needed to run it locally.

```bash
npm install
cp .dev.vars.example .dev.vars   # set SESSION_SECRET and ADMIN_PASSWORD (Stripe keys optional)
npm run setup                    # creates the local database + demo products
npm run dev                      # http://localhost:8787
```

To open the admin panel, go to **/admin** (there is also an "Owner login" link in the footer) and sign in with `ADMIN_EMAIL` (in `wrangler.jsonc`) and `ADMIN_PASSWORD`.

## Deploying

**See [docs/DEPLOY-CLOUDFLARE.md](docs/DEPLOY-CLOUDFLARE.md)** for step-by-step instructions. In short:

```bash
npx wrangler login
npx wrangler d1 create 3darmory              # paste the id into wrangler.jsonc
npx wrangler r2 bucket create 3darmory-images
npm run db:migrate:remote && npm run db:seed:remote
npx wrangler secret put SESSION_SECRET       # and ADMIN_PASSWORD, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
npm run deploy
```

Then add a Stripe webhook pointing to `https://<your-store>/webhooks/stripe`. The guide lists the events to select.

## Configuration

| Setting | Where | Description |
| --- | --- | --- |
| `ADMIN_EMAIL` | `vars` in `wrangler.jsonc` | Admin login email |
| `CURRENCY` | `vars` | Currency for all prices (default `usd`) |
| `SHIPPING_COUNTRIES` | `vars` | Countries you ship to, as comma-separated ISO codes (default `US,CA`) |
| `BASE_URL` | `vars` (optional) | Forces the public URL used for Stripe redirects. By default the address the customer visited is used |
| `SESSION_SECRET` | secret | Long random string used to sign cookies |
| `ADMIN_PASSWORD` | secret | Admin login password |
| `STRIPE_SECRET_KEY` | secret | `sk_test_…` for testing, `sk_live_…` for real payments |
| `STRIPE_WEBHOOK_SECRET` | secret | Signing secret of your Stripe webhook endpoint |

Set secrets with `npx wrangler secret put NAME` for the deployed site, or in `.dev.vars` locally.

Store text, the announcement bar and shipping rates are edited in **Admin → Site settings**, not in config.

## Development

```bash
npm test          # Vitest, running inside the real Workers runtime with local D1 + R2 (Stripe API mocked)
npm run build     # recompile EJS templates (dev, deploy and test do this automatically)
```

Templates are normal EJS files in `views/`. Cloudflare Workers don't allow code to be generated at runtime, so `scripts/build-views.mjs` precompiles them into `src/generated/views.js` before every dev run, deploy and test.

Project layout:

```
wrangler.jsonc           Cloudflare config: D1, R2, static assets, vars
src/index.js             Worker entry: Hono app, security headers, session, CSRF, error pages
src/lib/store.js         data access on D1 (products, categories, cart, orders, settings)
src/lib/images.js        product image upload/serving with R2
src/routes/              shop, cart, checkout, webhooks, admin
views/                   EJS templates (storefront + admin)
public/                  CSS, JS, logo and demo product artwork (served as static assets)
migrations/              D1 schema migrations
seed/demo.sql            optional demo catalogue
test/                    Vitest suite
```
