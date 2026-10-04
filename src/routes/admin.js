const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');

const config = require('../config');
const { parseMoney } = require('../lib/format');
const { ORDER_STATUSES } = require('../lib/store');

const router = express.Router();

/* ------------------------------ uploads ------------------------------ */

const IMAGE_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

const upload = multer({
  storage: multer.diskStorage({
    destination: config.uploadsDir,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(12).toString('hex') + IMAGE_TYPES[file.mimetype]),
  }),
  limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 30 },
  fileFilter: (req, file, cb) => {
    if (IMAGE_TYPES[file.mimetype]) return cb(null, true);
    const err = new Error('Images must be JPG, PNG, WebP or GIF.');
    err.code = 'INVALID_TYPE';
    cb(err);
  },
}).single('image');

function handleUpload(req, res, next) {
  upload(req, res, (err) => {
    if (err) {
      req.uploadError = err.code === 'LIMIT_FILE_SIZE' ? 'Image is too large (max 8 MB).' : err.message;
      req.body = req.body || {};
    }
    next();
  });
}

function removeUploadedFile(image) {
  if (!image || !image.startsWith('/uploads/')) return;
  const file = path.join(config.uploadsDir, path.basename(image));
  fs.rm(file, { force: true }, () => {});
}

/* ------------------------------- auth -------------------------------- */

const SESSION_HOURS = 12;
const loginAttempts = new Map();

function tooManyAttempts(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || entry.resetAt < now) return false;
  return entry.count >= 10;
}

function recordFailedAttempt(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || entry.resetAt < now) loginAttempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
  else entry.count += 1;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function requireAdmin(req, res, next) {
  const admin = req.session.admin;
  if (admin && Date.now() - admin.at < SESSION_HOURS * 3600 * 1000) return next();
  req.session.admin = null;
  const nextUrl = req.method === 'GET' ? `?next=${encodeURIComponent(req.originalUrl)}` : '';
  res.redirect(`/admin/login${nextUrl}`);
}

const loginConfigured = () => Boolean(config.admin.email && config.admin.password);

router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex');
  next();
});

router.get('/login', (req, res) => {
  if (req.session.admin) return res.redirect('/admin');
  res.render('admin/login', {
    title: 'Sign in',
    configured: loginConfigured(),
    next: typeof req.query.next === 'string' ? req.query.next : '',
    error: null,
    email: '',
  });
});

router.post('/login', (req, res) => {
  const ip = req.ip;
  const email = String(req.body.email || '').trim().toLowerCase();
  const nextUrl = /^\/admin(\/|$|\?)/.test(req.body.next || '') ? req.body.next : '/admin';
  const fail = (error) =>
    res.status(401).render('admin/login', { title: 'Sign in', configured: loginConfigured(), next: nextUrl, error, email });

  if (!loginConfigured()) return fail('Admin login is not configured.');
  if (tooManyAttempts(ip)) return fail('Too many attempts. Please wait 15 minutes and try again.');

  const ok = safeEqual(email, config.admin.email) & safeEqual(req.body.password || '', config.admin.password);
  if (!ok) {
    recordFailedAttempt(ip);
    return fail('Incorrect email or password.');
  }
  loginAttempts.delete(ip);
  req.session.admin = { email, at: Date.now() };
  req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.redirect(nextUrl);
});

router.post('/logout', (req, res) => {
  req.session.admin = null;
  res.redirect('/admin/login');
});

router.use(requireAdmin);

/* ----------------------------- dashboard ----------------------------- */

router.get('/', (req, res) => {
  const { store, stripe } = req.app.locals;
  res.render('admin/dashboard', {
    title: 'Dashboard',
    stats: store.dashboardStats(),
    stripeConfigured: Boolean(stripe),
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

  const categoryId = Number(body.category_id) || null;

  return {
    errors,
    data: {
      name,
      slug: String(body.slug || '').trim(),
      description: String(body.description || '').trim().slice(0, 5000),
      price_cents: price ?? 0,
      compare_at_cents: compareAt && price !== null && compareAt > price ? compareAt : null,
      category_id: categoryId,
      stock,
      material: String(body.material || '').trim().slice(0, 120),
      dimensions: String(body.dimensions || '').trim().slice(0, 120),
      image: existing?.image ?? null,
      featured: body.featured === 'on' ? 1 : 0,
      active: body.active === 'on' ? 1 : 0,
    },
  };
}

router.get('/products', (req, res) => {
  const { store } = req.app.locals;
  res.render('admin/products', {
    title: 'Products',
    products: store.listProducts({ includeInactive: true, sort: 'name' }),
  });
});

router.get('/products/new', (req, res) => {
  res.render('admin/product-form', { title: 'New product', product: emptyProduct(), errors: [] });
});

router.post('/products', handleUpload, (req, res) => {
  const { store } = req.app.locals;
  const { data, errors } = parseProductForm(req.body);
  if (req.uploadError) errors.push(req.uploadError);
  if (errors.length) {
    if (req.file) removeUploadedFile(`/uploads/${req.file.filename}`);
    return res.status(422).render('admin/product-form', { title: 'New product', product: data, errors });
  }
  if (req.file) data.image = `/uploads/${req.file.filename}`;
  store.createProduct(data);
  req.flash('success', `“${data.name}” was created.`);
  res.redirect('/admin/products');
});

router.get('/products/:id/edit', (req, res, next) => {
  const product = req.app.locals.store.getProduct(Number(req.params.id));
  if (!product) return next();
  res.render('admin/product-form', { title: `Edit ${product.name}`, product, errors: [] });
});

router.post('/products/:id', handleUpload, (req, res, next) => {
  const { store } = req.app.locals;
  const existing = store.getProduct(Number(req.params.id));
  if (!existing) return next();
  const { data, errors } = parseProductForm(req.body, existing);
  if (req.uploadError) errors.push(req.uploadError);
  if (errors.length) {
    if (req.file) removeUploadedFile(`/uploads/${req.file.filename}`);
    return res
      .status(422)
      .render('admin/product-form', { title: `Edit ${existing.name}`, product: { ...data, id: existing.id }, errors });
  }
  if (req.file || req.body.remove_image === 'on') {
    removeUploadedFile(existing.image);
    data.image = req.file ? `/uploads/${req.file.filename}` : null;
  }
  store.updateProduct(existing.id, data);
  req.flash('success', `“${data.name}” was saved.`);
  res.redirect('/admin/products');
});

router.post('/products/:id/delete', (req, res) => {
  const { store } = req.app.locals;
  const product = store.getProduct(Number(req.params.id));
  if (product) {
    store.deleteProduct(product.id);
    removeUploadedFile(product.image);
    req.flash('success', `“${product.name}” was deleted.`);
  }
  res.redirect('/admin/products');
});

/* ----------------------------- categories ---------------------------- */

function parseCategoryForm(body) {
  return {
    name: String(body.name || '').trim().slice(0, 60),
    description: String(body.description || '').trim().slice(0, 300),
    sort_order: Math.floor(Number(body.sort_order)) || 0,
  };
}

router.get('/categories', (req, res) => {
  res.render('admin/categories', { title: 'Categories' });
});

router.post('/categories', (req, res) => {
  const data = parseCategoryForm(req.body);
  if (!data.name) req.flash('error', 'Category name is required.');
  else {
    req.app.locals.store.createCategory(data);
    req.flash('success', `Category “${data.name}” added.`);
  }
  res.redirect('/admin/categories');
});

router.post('/categories/:id', (req, res) => {
  const data = parseCategoryForm(req.body);
  if (!data.name) req.flash('error', 'Category name is required.');
  else {
    req.app.locals.store.updateCategory(Number(req.params.id), data);
    req.flash('success', `Category “${data.name}” saved.`);
  }
  res.redirect('/admin/categories');
});

router.post('/categories/:id/delete', (req, res) => {
  req.app.locals.store.deleteCategory(Number(req.params.id));
  req.flash('success', 'Category deleted. Its products are now uncategorised.');
  res.redirect('/admin/categories');
});

/* ------------------------------- orders ------------------------------ */

router.get('/orders', (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : '';
  res.render('admin/orders', {
    title: 'Orders',
    orders: req.app.locals.store.listOrders({ status: status || undefined }),
    status,
    statuses: ORDER_STATUSES,
  });
});

router.get('/orders/:id', (req, res, next) => {
  const order = req.app.locals.store.getOrder(Number(req.params.id));
  if (!order) return next();
  res.render('admin/order', { title: `Order #${order.id}`, order, statuses: ORDER_STATUSES });
});

router.post('/orders/:id', (req, res, next) => {
  const { store } = req.app.locals;
  const order = store.getOrder(Number(req.params.id));
  if (!order) return next();
  const status = ORDER_STATUSES.includes(req.body.status) ? req.body.status : order.status;
  store.updateOrder(order.id, { status, notes: String(req.body.notes || '').slice(0, 2000) });
  req.flash('success', `Order #${order.id} updated.`);
  res.redirect(`/admin/orders/${order.id}`);
});

/* ------------------------------ settings ----------------------------- */

const TEXT_SETTINGS = ['store_name', 'tagline', 'hero_title', 'hero_subtitle', 'announcement', 'about_text', 'contact_email'];

router.get('/settings', (req, res) => {
  res.render('admin/settings', { title: 'Site settings', errors: [] });
});

router.post('/settings', (req, res) => {
  const values = {};
  for (const key of TEXT_SETTINGS) values[key] = String(req.body[key] ?? '').trim().slice(0, 3000);
  const errors = [];
  const flat = parseMoney(req.body.shipping_flat);
  const threshold = String(req.body.free_shipping_threshold || '').trim() ? parseMoney(req.body.free_shipping_threshold) : 0;
  if (flat === null) errors.push('Flat shipping rate must be a number (use 0 for free shipping).');
  if (threshold === null) errors.push('Free-shipping threshold must be a number, or blank to disable.');
  if (!values.store_name) errors.push('Store name is required.');
  if (errors.length) {
    res.locals.settings = { ...res.locals.settings, ...values };
    return res.status(422).render('admin/settings', { title: 'Site settings', errors });
  }
  values.shipping_flat_cents = flat;
  values.free_shipping_threshold_cents = threshold;
  req.app.locals.store.updateSettings(values);
  req.flash('success', 'Settings saved.');
  res.redirect('/admin/settings');
});

module.exports = router;
