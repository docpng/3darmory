import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import Stripe from 'stripe';
import { createApp } from '../src/index.js';
import views from '../src/generated/views.js';
import { renderTemplate } from '../src/lib/render.js';

const BASE = 'https://shop.example.com';
const realStripe = new Stripe('sk_test_dummy');
const createdSessions = [];
const fakeStripe = {
  webhooks: realStripe.webhooks,
  checkout: {
    sessions: {
      async create(params) {
        const session = { id: `cs_test_${createdSessions.length + 1}`, url: 'https://checkout.stripe.com/c/pay/test', params };
        createdSessions.push(session);
        return session;
      },
      async retrieve(id) {
        return { id, payment_status: 'unpaid' };
      },
    },
  },
};

const app = createApp({ createStripe: () => fakeStripe });
const testEnv = () => ({ ...env, STRIPE_SECRET_KEY: 'sk_test_dummy' });

async function call(path, init = {}) {
  const ctx = createExecutionContext();
  const res = await app.fetch(new Request(BASE + path, { redirect: 'manual', ...init }), testEnv(), ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** Minimal cookie-keeping client, like a browser session. */
function agent() {
  const jar = new Map();
  const request = async (path, init = {}) => {
    const headers = new Headers(init.headers);
    if (jar.size) headers.set('cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
    const res = await call(path, { ...init, headers });
    for (const cookie of res.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const i = pair.indexOf('=');
      jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return res;
  };
  return {
    get: (path) => request(path),
    post: (path, body) => request(path, { method: 'POST', body }),
    form: (path, fields) => request(path, { method: 'POST', body: new URLSearchParams(fields) }),
    async text(path) {
      return (await request(path)).text();
    },
    async csrf(path) {
      const html = await (await request(path)).text();
      const match = html.match(/name="_csrf" value="([a-f0-9]+)"/);
      expect(match, `no CSRF token on ${path}`).toBeTruthy();
      return match[1];
    },
  };
}

async function adminAgent() {
  const a = agent();
  const token = await a.csrf('/admin/login');
  const res = await a.form('/admin/login', { _csrf: token, email: 'owner@example.com', password: 'correct horse' });
  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toBe('/admin');
  return a;
}

const productBySlug = (slug) => env.DB.prepare('SELECT * FROM products WHERE slug = ?').bind(slug).first();

describe('storefront', () => {
  it('renders pages with seeded products', async () => {
    const home = await call('/');
    expect(home.status).toBe(200);
    const html = await home.text();
    expect(html).toContain('3D Armory');
    expect(html).toContain('Obsidian Dragon Bust');
    expect(home.headers.get('content-security-policy')).toContain("script-src 'self'");

    const shop = await (await call('/shop?category=trinkets')).text();
    expect(shop).toContain('Gilded D20 Dice');
    expect(shop).not.toContain('Obsidian Dragon Bust');

    expect(await (await call('/shop?q=dragon')).text()).toContain('Obsidian Dragon Bust');

    const product = await call('/product/gilded-d20-dice');
    expect(product.status).toBe(200);
    expect(await product.text()).toContain('$12.99');

    const missing = await call('/product/does-not-exist');
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain('<title>Not found · 3D Armory</title>');
  });

  it('compiles every template without undeclared variables', () => {
    // Templates are precompiled in strict mode; a variable missing from LOCAL_NAMES in
    // scripts/build-views.mjs would surface here as a ReferenceError.
    const locals = { settings: { about_text: '' }, categories: [], errors: [], statuses: [], money: String, formatDate: String, centsToInput: String };
    for (const name of Object.keys(views)) {
      try {
        renderTemplate(name, locals);
      } catch (err) {
        expect(err, name).not.toBeInstanceOf(ReferenceError);
      }
    }
  });

  it('rejects POST requests without a CSRF token', async () => {
    const res = await call('/cart/add', { method: 'POST', body: new URLSearchParams({ productId: '1' }) });
    expect(res.status).toBe(403);
  });

  it('clamps cart quantities to stock and ignores sold-out items', async () => {
    const a = agent();
    const token = await a.csrf('/product/gilded-d20-dice');
    const dice = await productBySlug('gilded-d20-dice');
    const vase = await productBySlug('spiral-vortex-vase'); // seeded with stock 0

    await a.form('/cart/add', { _csrf: token, productId: dice.id, quantity: 500 });
    expect((await a.form('/cart/add', { _csrf: token, productId: vase.id })).status).toBe(302);

    const cart = await a.text('/cart');
    expect(cart).toContain('Gilded D20 Dice');
    expect(cart).not.toContain('Spiral Vortex Vase');
    expect(cart).toContain('value="20"'); // capped at 20 per item
  });
});

describe('admin', () => {
  it('requires login and rejects a wrong password', async () => {
    const res = await call('/admin/products');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/^\/admin\/login/);
    expect(res.headers.get('cache-control')).toBe('no-store');

    const a = agent();
    const token = await a.csrf('/admin/login');
    const bad = await a.form('/admin/login', { _csrf: token, email: 'owner@example.com', password: 'nope' });
    expect(bad.status).toBe(401);
  });

  it('creates, edits and deletes a product with an image in R2', async () => {
    const a = await adminAgent();
    const token = await a.csrf('/admin/products/new');
    const png = Uint8Array.from(
      atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='),
      (ch) => ch.charCodeAt(0),
    );

    const form = new FormData();
    Object.entries({ _csrf: token, name: 'Mini Wyvern', description: 'A tiny wyvern.', price: '19.50', track_stock: 'on', stock: '4', active: 'on' })
      .forEach(([k, v]) => form.append(k, v));
    form.append('image', new File([png], 'wyvern.png', { type: 'image/png' }));
    expect((await a.post('/admin/products', form)).status).toBe(302);

    const product = await productBySlug('mini-wyvern');
    expect(product.price_cents).toBe(1950);
    expect(product.stock).toBe(4);
    expect(product.image).toMatch(/^\/uploads\/[a-f0-9]{24}\.png$/);
    const image = await call(product.image);
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/png');
    await image.arrayBuffer();

    expect(await (await call('/product/mini-wyvern')).text()).toContain('$19.50');

    // A fake "image" (wrong magic bytes) is rejected.
    const fake = new FormData();
    Object.entries({ _csrf: token, name: 'Mini Wyvern', price: '19.50', active: 'on' }).forEach(([k, v]) => fake.append(k, v));
    fake.append('image', new File(['<svg onload=alert(1)>'], 'x.png', { type: 'image/png' }));
    expect((await a.post(`/admin/products/${product.id}`, fake)).status).toBe(422);

    expect((await a.form(`/admin/products/${product.id}`, { _csrf: token, name: 'Mini Wyvern', price: '21', active: 'on' })).status).toBe(302);
    const updated = await productBySlug('mini-wyvern');
    expect(updated.price_cents).toBe(2100);
    expect(updated.stock).toBe(null); // stock tracking off => made to order
    expect(updated.image).toBe(product.image); // image kept

    expect((await a.form(`/admin/products/${product.id}`, { _csrf: token, name: '', price: 'abc' })).status).toBe(422);

    expect((await a.form(`/admin/products/${product.id}/delete`, { _csrf: token })).status).toBe(302);
    expect(await productBySlug('mini-wyvern')).toBe(null);
    expect(await env.IMAGES.get(product.image.slice('/uploads/'.length))).toBe(null);
  });

  it('updates site settings', async () => {
    const a = await adminAgent();
    const token = await a.csrf('/admin/settings');
    const res = await a.form('/admin/settings', {
      _csrf: token,
      store_name: '3D Armory',
      tagline: 'Forged layer by layer.',
      hero_title: 'Brand new headline',
      hero_subtitle: 'Sub',
      announcement: '',
      about_text: 'About us',
      contact_email: 'hi@example.com',
      shipping_flat: '7.00',
      free_shipping_threshold: '100',
    });
    expect(res.status).toBe(302);
    const home = await (await call('/')).text();
    expect(home).toContain('Brand new headline');
    expect(home).not.toContain('class="announcement"');
  });
});

describe('checkout', () => {
  it('creates a Stripe session from server-side prices; the webhook marks the order paid once', async () => {
    const a = agent();
    const token = await a.csrf('/product/sentinel-knight-helm');
    const helm = await productBySlug('sentinel-knight-helm');

    await a.form('/cart/add', { _csrf: token, productId: helm.id, quantity: 2 });
    const checkout = await a.form('/checkout', { _csrf: token });
    expect(checkout.status).toBe(303);
    expect(checkout.headers.get('location')).toBe('https://checkout.stripe.com/c/pay/test');

    const session = createdSessions.at(-1);
    const line = session.params.line_items[0];
    expect(line.quantity).toBe(2);
    expect(line.price_data.unit_amount).toBe(helm.price_cents);
    expect(session.params.success_url).toBe(`${BASE}/checkout/success?session_id={CHECKOUT_SESSION_ID}`);

    const order = await env.DB.prepare('SELECT * FROM orders WHERE stripe_session_id = ?').bind(session.id).first();
    expect(order.status).toBe('pending');

    const payload = JSON.stringify({
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: session.id,
          payment_status: 'paid',
          amount_total: 2 * helm.price_cents + 700,
          total_details: { amount_shipping: 700 },
          customer_details: { email: 'buyer@example.com', name: 'Ada Buyer' },
          collected_information: {
            shipping_details: { name: 'Ada Buyer', address: { line1: '1 Forge St', city: 'Ironton', country: 'US' } },
          },
        },
      },
    });
    const hook = (signature) =>
      call('/webhooks/stripe', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'stripe-signature': signature },
        body: payload,
      });

    expect((await hook('t=1,v1=bad')).status).toBe(400);

    const signature = await realStripe.webhooks.generateTestHeaderStringAsync({ payload, secret: 'whsec_test_secret' });
    expect((await hook(signature)).status).toBe(200);

    const paid = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(order.id).first();
    expect(paid.status).toBe('paid');
    expect(paid.customer_email).toBe('buyer@example.com');
    expect(paid.total_cents).toBe(2 * helm.price_cents + 700);
    expect((await productBySlug('sentinel-knight-helm')).stock).toBe(helm.stock - 2);

    // Replaying the webhook must not decrement stock twice.
    await hook(signature);
    expect((await productBySlug('sentinel-knight-helm')).stock).toBe(helm.stock - 2);

    // Success page clears the cart and shows the order.
    const success = await a.get(`/checkout/success?session_id=${session.id}`);
    expect(success.status).toBe(200);
    expect(await success.text()).toMatch(/Order #\d+/);
    expect(await a.text('/cart')).toContain('Your cart is empty');

    const admin = await adminAgent();
    const orders = await admin.get('/admin/orders');
    expect(orders.status).toBe(200);
    expect(await orders.text()).toContain('Ada Buyer');
  });
});
