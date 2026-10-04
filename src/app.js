const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const cookieSession = require('cookie-session');

const config = require('./config');
const { openDatabase, seedDemoData } = require('./db');
const { createStore } = require('./lib/store');
const { createStripeClient } = require('./lib/stripe');
const format = require('./lib/format');

const shopRoutes = require('./routes/shop');
const cartRoutes = require('./routes/cart');
const checkoutRoutes = require('./routes/checkout');
const webhookRoutes = require('./routes/webhooks');
const adminRoutes = require('./routes/admin');

const CSP = [
  "default-src 'self'",
  "img-src 'self' data: https:",
  "style-src 'self' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "script-src 'self'",
  "form-action 'self' https://checkout.stripe.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

/**
 * Builds the Express app. Dependencies can be injected for tests.
 */
function createApp({ db = openDatabase(), stripe = createStripeClient(), seed = config.seedDemoData } = {}) {
  if (seed) seedDemoData(db);
  fs.mkdirSync(config.uploadsDir, { recursive: true });

  const store = createStore(db);
  const app = express();

  app.set('views', path.join(__dirname, '..', 'views'));
  app.set('view engine', 'ejs');
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.locals.store = store;
  app.locals.stripe = stripe;

  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    });
    next();
  });

  // Stripe webhooks need the raw request body for signature verification,
  // so they are mounted before any body parsers.
  app.use('/webhooks', webhookRoutes);

  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: config.isProduction ? '7d' : 0 }));
  app.use('/uploads', express.static(config.uploadsDir, { maxAge: config.isProduction ? '30d' : 0 }));

  app.use(express.urlencoded({ extended: false, limit: '200kb' }));
  app.use(
    cookieSession({
      name: 'armory',
      keys: [config.sessionSecret],
      maxAge: 30 * 24 * 60 * 60 * 1000,
      sameSite: 'lax',
      httpOnly: true,
      secure: config.isProduction,
    }),
  );

  // Template locals shared by every page.
  app.use((req, res, next) => {
    if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
    res.locals.csrfToken = req.session.csrf;
    const settings = store.getSettings();
    const cart = req.session.cart || {};
    res.locals.settings = settings;
    res.locals.currency = config.currency;
    res.locals.money = (cents) => format.formatMoney(cents, config.currency);
    res.locals.formatDate = format.formatDate;
    res.locals.centsToInput = format.centsToInput;
    res.locals.cartCount = Object.values(cart).reduce((a, b) => a + Number(b || 0), 0);
    res.locals.currentPath = req.path;
    res.locals.isAdmin = Boolean(req.session.admin);
    res.locals.categories = store.listCategories();
    res.locals.stripeEnabled = Boolean(stripe);
    res.locals.flash = req.session.flash || null;
    res.locals.title = null;
    res.locals.description = null;
    delete req.session.flash;
    req.flash = (type, message) => {
      req.session.flash = { type, message };
    };
    next();
  });

  // CSRF protection: one random token per session, required on every state-changing request.
  app.use((req, res, next) => {
    if (req.method !== 'POST') return next();
    // Multipart (file upload) bodies are not parsed yet at this point, so those forms
    // carry the token in the query string instead.
    const isMultipart = req.is('multipart/form-data');
    const sent = isMultipart ? req.query._csrf : req.body?._csrf;
    const expected = Buffer.from(req.session.csrf);
    const received = Buffer.from(String(sent || ''));
    if (received.length === expected.length && crypto.timingSafeEqual(received, expected)) return next();
    res.status(403);
    return res.render('error', { title: 'Session expired', message: 'Your session expired. Please go back, refresh the page and try again.' });
  });

  app.use('/', shopRoutes);
  app.use('/cart', cartRoutes);
  app.use('/checkout', checkoutRoutes);
  app.use('/admin', adminRoutes);

  app.use((req, res) => {
    res.status(404).render('error', {
      title: 'Not found',
      message: "We couldn't find that page. It may have been moved or sold out.",
    });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    const status = err.status || err.statusCode || 500;
    res.status(status);
    if (res.locals.settings) {
      return res.render('error', {
        title: 'Something went wrong',
        message: status < 500 ? err.message : 'An unexpected error occurred. Please try again.',
      });
    }
    res.type('text').send('Something went wrong.');
  });

  return app;
}

module.exports = { createApp };
