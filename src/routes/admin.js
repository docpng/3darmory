import { Hono } from 'hono';
import { notFound, render } from '../lib/render.js';
import { parseMoney } from '../lib/format.js';
import { ORDER_STATUSES } from '../lib/store.js';
import { randomHex, safeEqual } from '../lib/session.js';
import { deleteImage, hasUpload, saveImage } from '../lib/images.js';

const admin = new Hono();

const SESSION_HOURS = 12;

admin.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
  c.header('X-Robots-Tag', 'noindex');
});

/* ------------------------------- auth -------------------------------- */

const loginConfigured = (config) => Boolean(config.admin.email && config.admin.password);
const clientIp = (c) => c.req.header('cf-connecting-ip') || 'unknown';

admin.get('/login', (c) => {
  if (c.get('session').admin) return c.redirect('/admin');
  return render(c, 'admin/login', {
    title: 'Sign in',
    configured: loginConfigured(c.get('config')),
    next: c.req.query('next') || '',
    error: null,
    email: '',
  });
});

admin.post('/login', async (c) => {
  const store = c.get('store');
  const config = c.get('config');
  const session = c.get('session');
  const body = c.get('body');
  const ip = clientIp(c);
  const email = String(body.email || '').trim().toLowerCase();
  const nextUrl = /^\/admin(\/|$|\?)/.test(body.next || '') ? body.next : '/admin';
  const fail = (error) =>
    render(c, 'admin/login', { title: 'Sign in', configured: loginConfigured(config), next: nextUrl, error, email }, 401);

  if (!loginConfigured(config)) return fail('Admin login is not configured.');
  if (await store.tooManyLoginAttempts(ip)) return fail('Too many attempts. Please wait 15 minutes and try again.');

  const [emailOk, passwordOk] = await Promise.all([
    safeEqual(email, config.admin.email),
    safeEqual(body.password || '', config.admin.password),
  ]);
  if (!emailOk || !passwordOk) {
    await store.recordFailedLogin(ip);
    return fail('Incorrect email or password.');
  }
  await store.clearLoginAttempts(ip);
  session.admin = { email, at: Date.now() };
  session.csrf = randomHex();
  return c.redirect(nextUrl);
});

admin.post('/logout', (c) => {
  c.get('session').admin = null;
  return c.redirect('/admin/login');
});

admin.use('*', async (c, next) => {
  const session = c.get('session');
  if (session.admin && Date.now() - session.admin.at < SESSION_HOURS * 3600 * 1000) return next();
  session.admin = null;
  const nextUrl = c.req.method === 'GET' ? `?next=${encodeURIComponent(c.req.path + new URL(c.req.url).search)}` : '';
  return c.redirect(`/admin/login${nextUrl}`);
});

const flash = (c, type, message) => {
  c.get('session').flash = { type, message };
};

/* ----------------------------- dashboard ----------------------------- */

admin.get('/', async (c) => {
  const config = c.get('config');
  return render(c, 'admin/dashboard', {
    title: 'Dashboard',
    stats: await c.get('store').dashboardStats(),
    stripeConfigured: Boolean(c.get('stripe')),
    webhookConfigured: Boolean(config.stripe.webhookSecret),
    baseUrl: config.baseUrl,
  });
});

/* ------------------------------ products ----------------------------- */

function emptyProduct() {
  return {
    name: '',
    slug: '',
    description: '',
    price_cents: null,
    compare_at_cents: null,
    category_id: null,
    stock: null,
    material: '',
    dimensions: '',
    image: null,
    featured: 0,
    active: 1,
  };
}

function parseProductForm(body, existing) {
  const errors = [];
  const name = String(body.name || '').trim().slice(0, 120);
  if (!name) errors.push('Name is required.');

  const price = parseMoney(body.price);
  if (price === null) errors.push('Price must be a number, e.g. 24.99.');

  let compareAt = null;
  if (String(body.compare_at || '').trim()) {
    compareAt = parseMoney(body.compare_at);
    if (compareAt === null) errors.push('Compare-at price must be a number, or left blank.');
  }

  let stock = null;
  if (body.track_stock === 'on') {
    stock = Math.floor(Number(body.stock));
    if (!Number.isFinite(stock) || stock < 0) {
      errors.push('Stock must be zero or a positive whole number.');
      stock = 0;
    }
  }

  return {
    errors,
    data: {
      name,
      slug: String(body.slug || '').trim(),
      description: String(body.description || '').trim().slice(0, 5000),
      price_cents: price ?? 0,
      compare_at_cents: compareAt && price !== null && compareAt > price ? compareAt : null,
      category_id: Number(body.category_id) || null,
      stock,
      material: String(body.material || '').trim().slice(0, 120),
      dimensions: String(body.dimensions || '').trim().slice(0, 120),
      image: existing?.image ?? null,
      featured: body.featured === 'on' ? 1 : 0,
      active: body.active === 'on' ? 1 : 0,
    },
  };
}

admin.get('/products', async (c) =>
  render(c, 'admin/products', {
    title: 'Products',
    products: await c.get('store').listProducts({ includeInactive: true, sort: 'name' }),
  }),
);

admin.get('/products/new', (c) =>
  render(c, 'admin/product-form', { title: 'New product', product: emptyProduct(), errors: [] }),
);

admin.post('/products', async (c) => {
  const body = c.get('body');
  const { data, errors } = parseProductForm(body);
  if (!errors.length && hasUpload(body.image)) {
    const saved = await saveImage(c.env.IMAGES, body.image);
    if (saved.error) errors.push(saved.error);
    else data.image = saved.path;
  }
  if (errors.length) {
    await deleteImage(c.env.IMAGES, data.image);
    return render(c, 'admin/product-form', { title: 'New product', product: data, errors }, 422);
  }
  await c.get('store').createProduct(data);
  flash(c, 'success', `“${data.name}” was created.`);
  return c.redirect('/admin/products');
});

admin.get('/products/:id/edit', async (c) => {
  const product = await c.get('store').getProduct(Number(c.req.param('id')));
  if (!product) return notFound(c);
  return render(c, 'admin/product-form', { title: `Edit ${product.name}`, product, errors: [] });
});

admin.post('/products/:id', async (c) => {
  const store = c.get('store');
  const body = c.get('body');
  const existing = await store.getProduct(Number(c.req.param('id')));
  if (!existing) return notFound(c);
  const { data, errors } = parseProductForm(body, existing);
  let uploaded = null;
  if (!errors.length && hasUpload(body.image)) {
    const saved = await saveImage(c.env.IMAGES, body.image);
    if (saved.error) errors.push(saved.error);
    else uploaded = saved.path;
  }
  if (errors.length) {
    return render(
      c,
      'admin/product-form',
      { title: `Edit ${existing.name}`, product: { ...data, id: existing.id }, errors },
      422,
    );
  }
  if (uploaded || body.remove_image === 'on') {
    await deleteImage(c.env.IMAGES, existing.image);
    data.image = uploaded;
  }
  await store.updateProduct(existing.id, data);
  flash(c, 'success', `“${data.name}” was saved.`);
  return c.redirect('/admin/products');
});

admin.post('/products/:id/delete', async (c) => {
  const store = c.get('store');
  const product = await store.getProduct(Number(c.req.param('id')));
  if (product) {
    await store.deleteProduct(product.id);
    await deleteImage(c.env.IMAGES, product.image);
    flash(c, 'success', `“${product.name}” was deleted.`);
  }
  return c.redirect('/admin/products');
});

/* ----------------------------- categories ---------------------------- */

function parseCategoryForm(body) {
  return {
    name: String(body.name || '').trim().slice(0, 60),
    description: String(body.description || '').trim().slice(0, 300),
    sort_order: Math.floor(Number(body.sort_order)) || 0,
  };
}

admin.get('/categories', (c) => render(c, 'admin/categories', { title: 'Categories' }));

admin.post('/categories', async (c) => {
  const data = parseCategoryForm(c.get('body'));
  if (!data.name) flash(c, 'error', 'Category name is required.');
  else {
    await c.get('store').createCategory(data);
    flash(c, 'success', `Category “${data.name}” added.`);
  }
  return c.redirect('/admin/categories');
});

admin.post('/categories/:id', async (c) => {
  const data = parseCategoryForm(c.get('body'));
  if (!data.name) flash(c, 'error', 'Category name is required.');
  else {
    await c.get('store').updateCategory(Number(c.req.param('id')), data);
    flash(c, 'success', `Category “${data.name}” saved.`);
  }
  return c.redirect('/admin/categories');
});

admin.post('/categories/:id/delete', async (c) => {
  await c.get('store').deleteCategory(Number(c.req.param('id')));
  flash(c, 'success', 'Category deleted. Its products are now uncategorised.');
  return c.redirect('/admin/categories');
});

/* ------------------------------- orders ------------------------------ */

admin.get('/orders', async (c) => {
  const status = c.req.query('status') || '';
  return render(c, 'admin/orders', {
    title: 'Orders',
    orders: await c.get('store').listOrders({ status: status || undefined }),
    status,
    statuses: ORDER_STATUSES,
  });
});

admin.get('/orders/:id', async (c) => {
  const order = await c.get('store').getOrder(Number(c.req.param('id')));
  if (!order) return notFound(c);
  return render(c, 'admin/order', { title: `Order #${order.id}`, order, statuses: ORDER_STATUSES });
});

admin.post('/orders/:id', async (c) => {
  const store = c.get('store');
  const body = c.get('body');
  const order = await store.getOrder(Number(c.req.param('id')));
  if (!order) return notFound(c);
  const status = ORDER_STATUSES.includes(body.status) ? body.status : order.status;
  await store.updateOrder(order.id, { status, notes: String(body.notes || '').slice(0, 2000) });
  flash(c, 'success', `Order #${order.id} updated.`);
  return c.redirect(`/admin/orders/${order.id}`);
});

/* ------------------------------ settings ----------------------------- */

const TEXT_SETTINGS = ['store_name', 'tagline', 'hero_title', 'hero_subtitle', 'announcement', 'about_text', 'contact_email'];

admin.get('/settings', (c) => render(c, 'admin/settings', { title: 'Site settings', errors: [] }));

admin.post('/settings', async (c) => {
  const body = c.get('body');
  const values = {};
  for (const key of TEXT_SETTINGS) values[key] = String(body[key] ?? '').trim().slice(0, 3000);
  const errors = [];
  const flat = parseMoney(body.shipping_flat);
  const threshold = String(body.free_shipping_threshold || '').trim() ? parseMoney(body.free_shipping_threshold) : 0;
  if (flat === null) errors.push('Flat shipping rate must be a number (use 0 for free shipping).');
  if (threshold === null) errors.push('Free-shipping threshold must be a number, or blank to disable.');
  if (!values.store_name) errors.push('Store name is required.');
  if (errors.length) {
    const locals = c.get('locals');
    return render(c, 'admin/settings', { title: 'Site settings', errors, settings: { ...locals.settings, ...values } }, 422);
  }
  values.shipping_flat_cents = flat;
  values.free_shipping_threshold_cents = threshold;
  await c.get('store').updateSettings(values);
  flash(c, 'success', 'Settings saved.');
  return c.redirect('/admin/settings');
});

export default admin;
