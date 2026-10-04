# 3D Armory

Online store for **3D Armory**: 3D printed models, figures and trinkets. It has a modern black & gold storefront, an admin CMS for the owner, and checkout through **Stripe**.

![Stack](https://img.shields.io/badge/stack-Node%20%7C%20Express%20%7C%20SQLite%20%7C%20Stripe-d4af37?labelColor=0b0b0c)

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
- Uploads must be JPG, PNG, WebP or GIF, up to 8 MB, and get random file names

## Quick start

Requires Node.js 20 or newer.

```bash
npm install
cp .env.example .env      # then fill in the values (see below)
npm run dev               # http://localhost:3000
```

On first start, the store fills itself with demo products and categories. Delete them from the admin panel, or set `SEED_DEMO_DATA=false` before the first run to start with an empty catalogue.

To open the admin panel, go to **/admin** (there is also an "Owner login" link in the footer) and sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`.

## Configuration (`.env`)

| Variable | Description |
| --- | --- |
| `BASE_URL` | Public URL of the site, such as `https://3darmory.com`. Stripe redirects back to this URL. |
| `SESSION_SECRET` | Long random string used to sign cookies. **Required in production.** |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | Admin login details. |
| `STRIPE_SECRET_KEY` | Stripe secret key (`sk_test_…` for testing, `sk_live_…` for real payments). |
| `STRIPE_WEBHOOK_SECRET` | Signing secret of your Stripe webhook endpoint (`whsec_…`). |
| `CURRENCY` | Currency for all prices (default `usd`). |
| `SHIPPING_COUNTRIES` | Countries you ship to, as comma-separated ISO codes (default `US,CA`). |
| `DATA_DIR` | Folder for the SQLite database and uploaded images (default `./data`). |

## Setting up Stripe

1. Create a Stripe account and copy your **secret key** from *Developers → API keys* into `STRIPE_SECRET_KEY`.
2. Add a webhook endpoint at *Developers → Webhooks* that points to `https://YOUR-DOMAIN/webhooks/stripe` and listens for:
   - `checkout.session.completed`
   - `checkout.session.expired`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.async_payment_failed`
3. Copy the endpoint's **signing secret** into `STRIPE_WEBHOOK_SECRET`.

To test locally, use the [Stripe CLI](https://docs.stripe.com/stripe-cli):

```bash
stripe listen --forward-to localhost:3000/webhooks/stripe   # prints a whsec_… secret for .env
```

Then pay with the test card `4242 4242 4242 4242`, any future expiry date and any CVC.

Paid orders appear under **Admin → Orders**, and stock goes down automatically.

## Deploying

The app is a single Node process. Deploy it to any host that offers a **persistent disk**, such as Render, Railway, Fly.io or a VPS, and point `DATA_DIR` at that disk so your products, orders and uploaded images survive restarts and redeploys.

```bash
NODE_ENV=production npm start
```

Or use Docker:

```bash
docker build -t 3darmory .
docker run -p 3000:3000 -v armory-data:/data --env-file .env 3darmory
```

Serve the site over HTTPS in production. Session cookies are marked `secure`, and Stripe only shows product images that have HTTPS URLs.

## Development

```bash
npm test     # runs the test suite (node:test + supertest, Stripe API mocked)
```

Project layout:

```
server.js            entry point
src/app.js           Express app, security headers, sessions, CSRF
src/db.js            SQLite schema, default settings, demo data
src/lib/store.js     data access (products, categories, cart, orders, settings)
src/routes/          shop, cart, checkout, webhooks, admin
views/               EJS templates (storefront + admin)
public/              CSS, JS, logo and demo product artwork
```
