const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'armory-test-'));
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATA_DIR: dataDir,
  ADMIN_EMAIL: 'owner@example.com',
  ADMIN_PASSWORD: 'correct horse',
  STRIPE_WEBHOOK_SECRET: 'whsec_test_secret',
  BASE_URL: 'https://shop.example.com',
});

const request = require('supertest');
const Stripe = require('stripe');
const { createApp } = require('../src/app');
const { openDatabase } = require('../src/db');

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

let app;
let db;

before(() => {
  db = openDatabase(':memory:');
  app = createApp({ db, stripe: fakeStripe, seed: true });
});

async function csrfFrom(agent, url) {
  const res = await agent.get(url);
  const match = res.text.match(/name="_csrf" value="([a-f0-9]+)"/) || res.text.match(/_csrf=([a-f0-9]+)/);
  assert.ok(match, `no CSRF token found on ${url}`);
  return match[1];
}

async function adminAgent() {
  const agent = request.agent(app);
  const token = await csrfFrom(agent, '/admin/login');
  const res = await agent
    .post('/admin/login')
    .type('form')
    .send({ _csrf: token, email: 'owner@example.com', password: 'correct horse' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/admin');
  return agent;
}

const productBySlug = (slug) => db.prepare('SELECT * FROM products WHERE slug = ?').get(slug);

test('storefront pages render with seeded products', async () => {
  const home = await request(app).get('/');
  assert.equal(home.status, 200);
  assert.match(home.text, /3D Armory/);
  assert.match(home.text, /Obsidian Dragon Bust/);

  const shop = await request(app).get('/shop?category=trinkets');
  assert.equal(shop.status, 200);
  assert.match(shop.text, /Gilded D20 Dice/);
  assert.doesNotMatch(shop.text, /Obsidian Dragon Bust/);

  const search = await request(app).get('/shop?q=dragon');
  assert.match(search.text, /Obsidian Dragon Bust/);

  const product = await request(app).get('/product/gilded-d20-dice');
  assert.equal(product.status, 200);
  assert.match(product.text, /\$12\.99/);

  assert.equal((await request(app).get('/product/does-not-exist')).status, 404);
});

test('POST requests without a CSRF token are rejected', async () => {
  const res = await request(app).post('/cart/add').type('form').send({ productId: 1 });
  assert.equal(res.status, 403);
});

test('cart clamps quantities to available stock and ignores sold-out items', async () => {
  const agent = request.agent(app);
  const token = await csrfFrom(agent, '/product/gilded-d20-dice');
  const dice = productBySlug('gilded-d20-dice');
  const vase = productBySlug('spiral-vortex-vase'); // seeded with stock 0

  await agent.post('/cart/add').type('form').send({ _csrf: token, productId: dice.id, quantity: 500 });
  const soldOut = await agent.post('/cart/add').type('form').send({ _csrf: token, productId: vase.id });
  assert.equal(soldOut.status, 302);

  const cart = await agent.get('/cart');
  assert.match(cart.text, /Gilded D20 Dice/);
  assert.doesNotMatch(cart.text, /Spiral Vortex Vase/);
  assert.match(cart.text, /value="20"/); // capped at 20 per item
});

test('admin area requires login', async () => {
  const res = await request(app).get('/admin/products');
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /^\/admin\/login/);

  const agent = request.agent(app);
  const token = await csrfFrom(agent, '/admin/login');
  const bad = await agent.post('/admin/login').type('form').send({ _csrf: token, email: 'owner@example.com', password: 'nope' });
  assert.equal(bad.status, 401);
});

test('admin can create, edit and delete a product with an image', async () => {
  const agent = await adminAgent();
  const token = await csrfFrom(agent, '/admin/products/new');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );

  const created = await agent
    .post(`/admin/products?_csrf=${token}`)
    .field('name', 'Mini Wyvern')
    .field('description', 'A tiny wyvern.')
    .field('price', '19.50')
    .field('track_stock', 'on')
    .field('stock', '4')
    .field('active', 'on')
    .attach('image', png, { filename: 'wyvern.png', contentType: 'image/png' });
  assert.equal(created.status, 302);

  const product = productBySlug('mini-wyvern');
  assert.equal(product.price_cents, 1950);
  assert.equal(product.stock, 4);
  assert.match(product.image, /^\/uploads\/[a-f0-9]+\.png$/);
  assert.ok(fs.existsSync(path.join(dataDir, 'uploads', path.basename(product.image))));
  assert.equal((await request(app).get(product.image)).status, 200);

  const page = await request(app).get('/product/mini-wyvern');
  assert.match(page.text, /\$19\.50/);

  const edited = await agent
    .post(`/admin/products/${product.id}?_csrf=${token}`)
    .field('name', 'Mini Wyvern')
    .field('price', '21')
    .field('active', 'on');
  assert.equal(edited.status, 302);
  const updated = productBySlug('mini-wyvern');
  assert.equal(updated.price_cents, 2100);
  assert.equal(updated.stock, null); // stock tracking switched off => made to order
  assert.equal(updated.image, product.image); // image kept

  const invalid = await agent.post(`/admin/products/${product.id}?_csrf=${token}`).field('name', '').field('price', 'abc');
  assert.equal(invalid.status, 422);

  const del = await agent.post(`/admin/products/${product.id}/delete`).type('form').send({ _csrf: token });
  assert.equal(del.status, 302);
  assert.equal(productBySlug('mini-wyvern'), undefined);
});

test('admin can update site settings', async () => {
  const agent = await adminAgent();
  const token = await csrfFrom(agent, '/admin/settings');
  const res = await agent.post('/admin/settings').type('form').send({
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
  assert.equal(res.status, 302);
  const home = await request(app).get('/');
  assert.match(home.text, /Brand new headline/);
  assert.doesNotMatch(home.text, /class="announcement"/);
});

test('checkout creates a Stripe session from server-side prices and the webhook marks the order paid', async () => {
  const agent = request.agent(app);
  const token = await csrfFrom(agent, '/product/gilded-d20-dice');
  const helm = productBySlug('sentinel-knight-helm');
  const stockBefore = helm.stock;

  await agent.post('/cart/add').type('form').send({ _csrf: token, productId: helm.id, quantity: 2 });
  const checkout = await agent.post('/checkout').type('form').send({ _csrf: token });
  assert.equal(checkout.status, 303);
  assert.equal(checkout.headers.location, 'https://checkout.stripe.com/c/pay/test');

  const session = createdSessions.at(-1);
  const line = session.params.line_items[0];
  assert.equal(line.quantity, 2);
  assert.equal(line.price_data.unit_amount, helm.price_cents);
  assert.equal(line.price_data.product_data.name, 'Sentinel Knight Helm');
  assert.equal(session.params.success_url, 'https://shop.example.com/checkout/success?session_id={CHECKOUT_SESSION_ID}');

  const order = db.prepare('SELECT * FROM orders WHERE stripe_session_id = ?').get(session.id);
  assert.equal(order.status, 'pending');

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

  const forged = await request(app)
    .post('/webhooks/stripe')
    .set('Content-Type', 'application/json')
    .set('Stripe-Signature', 't=1,v1=bad')
    .send(payload);
  assert.equal(forged.status, 400);

  const signature = realStripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_test_secret' });
  const hook = await request(app)
    .post('/webhooks/stripe')
    .set('Content-Type', 'application/json')
    .set('Stripe-Signature', signature)
    .send(payload);
  assert.equal(hook.status, 200);

  const paid = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
  assert.equal(paid.status, 'paid');
  assert.equal(paid.customer_email, 'buyer@example.com');
  assert.equal(paid.total_cents, 2 * helm.price_cents + 700);
  assert.equal(productBySlug('sentinel-knight-helm').stock, stockBefore - 2);

  // Replaying the webhook must not decrement stock twice.
  await request(app).post('/webhooks/stripe').set('Content-Type', 'application/json').set('Stripe-Signature', signature).send(payload);
  assert.equal(productBySlug('sentinel-knight-helm').stock, stockBefore - 2);

  // Success page clears the cart and shows the order.
  const success = await agent.get(`/checkout/success?session_id=${session.id}`);
  assert.equal(success.status, 200);
  assert.match(success.text, /Order #\d+/);
  assert.match((await agent.get('/cart')).text, /Your cart is empty/);

  // The order shows up for the admin.
  const admin = await adminAgent();
  const orders = await admin.get('/admin/orders');
  assert.match(orders.text, /Ada Buyer/);
});
