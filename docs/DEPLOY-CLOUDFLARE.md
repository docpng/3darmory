# Testing 3D Armory on Cloudflare

This guide puts your store on a public **HTTPS** address through Cloudflare so you can test it from your phone, share it with friends and run real Stripe test payments, all without renting a server.

## How it works (and why not Workers or Pages)

3D Armory is a Node.js server that saves products, orders and uploaded images to disk in a SQLite database. **Cloudflare Workers and Pages can't run it as-is.** They have no local disk, and the database library (`better-sqlite3`) is native code they don't support.

Instead we use **Cloudflare Tunnel**. The app runs on your own computer (or any small server), and Cloudflare gives it a secure public URL:

```
Visitor ──HTTPS──▶ Cloudflare ──tunnel──▶ cloudflared on your machine ──▶ http://localhost:3000 (3D Armory)
```

There are no open ports or router changes, and HTTPS is handled for you. Your computer must stay on while people are testing.

---

## Option A: Quick tunnel (5 minutes, no Cloudflare account)

Best for a quick test. You get a random `https://something.trycloudflare.com` address that changes every time you restart the tunnel.

### 1. Install the app

Requires [Node.js](https://nodejs.org) 20 or newer.

```bash
git clone https://github.com/docpng/3darmory.git
cd 3darmory
npm install
cp .env.example .env
```

### 2. Install `cloudflared`

| System | Command |
| --- | --- |
| macOS | `brew install cloudflared` |
| Windows | `winget install --id Cloudflare.cloudflared` |
| Debian/Ubuntu | Download the `.deb` from the [cloudflared releases page](https://github.com/cloudflare/cloudflared/releases/latest) and run `sudo dpkg -i cloudflared-linux-amd64.deb` |

### 3. Start the tunnel

In its own terminal window:

```bash
cloudflared tunnel --url http://localhost:3000
```

After a few seconds it prints something like:

```
Your quick Tunnel has been created! Visit it at:
https://brave-golden-forge-example.trycloudflare.com
```

Copy that address and leave the window open.

### 4. Configure `.env`

Open `.env` and set at least:

```ini
BASE_URL=https://brave-golden-forge-example.trycloudflare.com   # your tunnel address, no trailing slash
SESSION_SECRET=paste-a-long-random-string-here
ADMIN_EMAIL=you@example.com
ADMIN_PASSWORD=pick-a-strong-password
STRIPE_SECRET_KEY=sk_test_...     # Stripe dashboard → Developers → API keys (Test mode)
```

To generate a `SESSION_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> Always use **test mode** keys (`sk_test_…`) while testing. No real money moves.

### 5. Start the store

In a second terminal window:

```bash
NODE_ENV=production npm start
```

On Windows PowerShell:

```powershell
$env:NODE_ENV="production"; npm start
```

Open your tunnel address. You should see the store. Sign in to the admin at `https://<your-tunnel>/admin`.

### 6. Connect the Stripe webhook

The webhook is how Stripe tells your store that an order has been paid. Choose one way:

**Option 1: Stripe CLI (easiest, nothing to update when the URL changes)**

```bash
stripe login
stripe listen --forward-to localhost:3000/webhooks/stripe
```

Copy the `whsec_…` value it prints into `STRIPE_WEBHOOK_SECRET` in `.env`, restart the store, and keep `stripe listen` running while you test.

**Option 2: Stripe dashboard**

1. Stripe dashboard (Test mode) → *Developers → Webhooks → Add endpoint*.
2. Endpoint URL: `https://<your-tunnel>/webhooks/stripe`
3. Events: `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`
4. Copy the endpoint's signing secret into `STRIPE_WEBHOOK_SECRET` and restart the store.

### 7. Place a test order

1. Add something to the cart and click **Checkout securely**.
2. Pay with card `4242 4242 4242 4242`, any future expiry date, any CVC and any postcode.
3. You land on the order confirmation page. The order appears under **Admin → Orders** as *paid*, and that product's stock goes down.

### Each time you restart the quick tunnel

The `trycloudflare.com` address changes, so:

1. Update `BASE_URL` in `.env` and restart the store.
2. If you used the Stripe dashboard webhook (Option 2), update its URL too.

If that gets tedious, use Option B.

---

## Option B: Named tunnel on your own domain (stable URL)

You'll need a free Cloudflare account and a domain whose DNS is managed by Cloudflare. Your store then stays at a fixed address such as `https://shop.3darmory.com`.

```bash
cloudflared tunnel login                                      # opens a browser; pick your domain
cloudflared tunnel create 3darmory                            # creates the tunnel and a credentials file
cloudflared tunnel route dns 3darmory shop.3darmory.com       # points the hostname at the tunnel
cloudflared tunnel run --url http://localhost:3000 3darmory   # start it (keep running)
```

Then set `BASE_URL=https://shop.3darmory.com` in `.env`, restart the store, and point your Stripe webhook at `https://shop.3darmory.com/webhooks/stripe`.

Tips:

- You can also create and manage the tunnel from the Cloudflare dashboard under **Zero Trust → Networks → Tunnels**. It gives you an install command with a token, and you add a *public hostname* pointing to `http://localhost:3000`.
- To keep the tunnel running after reboots, install it as a service with `sudo cloudflared service install`. See Cloudflare's docs for your operating system.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| "Session expired" when submitting any form, or you can't stay logged in | You're running with `NODE_ENV=production` but opening the site over plain `http://` (for example `http://localhost:3000`). Production mode only sends login cookies over HTTPS. Use the tunnel's `https://` address, or run plain `npm start` (without `NODE_ENV=production`) for local-only testing. |
| After paying, Stripe sends you to the wrong site or a dead link | `BASE_URL` doesn't match the tunnel address. Update it and restart the store. |
| Orders stay "pending" | The webhook isn't reaching the store. Check `STRIPE_WEBHOOK_SECRET`, check that `stripe listen` is running (Option 1) or that the endpoint URL is correct (Option 2), and look under *Developers → Webhooks* in Stripe for failed deliveries. Orders are also confirmed when the customer reaches the success page. |
| Checkout button says "Checkout unavailable" | `STRIPE_SECRET_KEY` isn't set. Add it and restart. |
| Admin login says it isn't configured | Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `.env` and restart. |
| Product images don't appear on the Stripe payment page | Stripe only shows images with public HTTPS URLs, so check that `BASE_URL` is your `https://` tunnel address. The demo SVG artwork never appears there; upload JPG, PNG or WebP photos. |

## When you're ready to go live

A tunnel from your own computer is great for testing, but the store goes offline whenever the computer sleeps. For a real launch, run the app on an always-on host with a persistent disk (see **Deploying** in the main README). You can keep Cloudflare in front of it for DNS and HTTPS. Then swap your Stripe test keys for live keys (`sk_live_…`) and create a live-mode webhook.
