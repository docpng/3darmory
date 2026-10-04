import { Hono } from 'hono';
import Stripe from 'stripe';

import { getConfig } from './lib/config.js';
import { createStore } from './lib/store.js';
import { notFound, render } from './lib/render.js';
import { randomHex, safeEqual, sessionMiddleware } from './lib/session.js';
import { serveImage } from './lib/images.js';
import * as format from './lib/format.js';

import shopRoutes from './routes/shop.js';
import cartRoutes from './routes/cart.js';
import checkoutRoutes from './routes/checkout.js';
import webhookRoutes from './routes/webhooks.js';
import adminRoutes from './routes/admin.js';

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

const defaultStripeFactory = (secretKey) => new Stripe(secretKey);

/**
 * Builds the Hono app. `createStripe` can be swapped out in tests.
 */
export function createApp({ createStripe = defaultStripeFactory } = {}) {
  const app = new Hono();

  // Per-request services + security headers.
  app.use('*', async (c, next) => {
    const config = getConfig(c.env, c.req.raw);
    c.set('config', config);
    c.set('store', createStore(c.env.DB));
    c.set('stripe', config.stripe.secretKey ? createStripe(config.stripe.secretKey) : null);
    await next();
    c.header('Content-Security-Policy', CSP);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  });

  // Stripe webhooks are authenticated by signature, not by session/CSRF.
  app.route('/webhooks', webhookRoutes);
  app.get('/uploads/:key', serveImage);

  app.use('*', sessionMiddleware());

  // Template locals shared by every page.
  app.use('*', async (c, next) => {
    const session = c.get('session');
    const config = c.get('config');
    if (!session.csrf) session.csrf = randomHex();
    const { settings, categories } = await c.get('store').getLayoutData();
    const cart = session.cart || {};
    c.set('locals', {
      settings,
      categories,
      csrfToken: session.csrf,
      currency: config.currency,
      money: (cents) => format.formatMoney(cents, config.currency),
      formatDate: format.formatDate,
      centsToInput: format.centsToInput,
      cartCount: Object.values(cart).reduce((a, b) => a + Number(b || 0), 0),
      currentPath: c.req.path,
      isAdmin: Boolean(session.admin),
      stripeEnabled: Boolean(c.get('stripe')),
      flash: session.flash || null,
      title: null,
      description: null,
    });
    delete session.flash;
    await next();
  });

  // CSRF protection: every POST must carry the session's token. Parsing the body here
  // (form or multipart) also makes it available to routes as c.get('body').
  app.use('*', async (c, next) => {
    if (c.req.method !== 'POST') return next();
    const type = c.req.header('content-type') || '';
    const body =
      type.startsWith('application/x-www-form-urlencoded') || type.startsWith('multipart/form-data')
        ? await c.req.parseBody()
        : {};
    c.set('body', body);
    if (typeof body._csrf === 'string' && (await safeEqual(body._csrf, c.get('session').csrf))) return next();
    return render(c, 'error', {
      title: 'Session expired',
      message: 'Your session expired. Please go back, refresh the page and try again.',
    }, 403);
  });

  app.route('/', shopRoutes);
  app.route('/cart', cartRoutes);
  app.route('/checkout', checkoutRoutes);
  app.route('/admin', adminRoutes);

  app.notFound(notFound);

  app.onError((err, c) => {
    console.error(err);
    if (/no such table/i.test(err.message)) {
      return c.text(
        'The database has not been set up yet. Run `npm run db:migrate:local` (or `npm run db:migrate:remote` for the deployed site).',
        500,
      );
    }
    if (!c.get('locals')) return c.text('Something went wrong.', 500);
    return render(c, 'error', {
      title: 'Something went wrong',
      message: 'An unexpected error occurred. Please try again.',
    }, 500);
  });

  return app;
}

const app = createApp();

export default {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
};
