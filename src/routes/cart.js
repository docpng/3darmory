import { Hono } from 'hono';
import { render } from '../lib/render.js';

const cart = new Hono();

function backTo(body, fallback = '/cart') {
  const target = typeof body.redirect === 'string' ? body.redirect : '';
  // Only allow local paths to avoid open redirects.
  return /^\/(?!\/)/.test(target) ? target : fallback;
}

cart.get('/', async (c) => {
  const store = c.get('store');
  const session = c.get('session');
  const { settings } = c.get('locals');
  const resolved = await store.resolveCart(session.cart);
  const shipping = resolved.items.length ? store.shippingFor(resolved.subtotal, settings) : 0;
  const freeShippingRemaining =
    settings.free_shipping_threshold_cents > 0
      ? Math.max(0, settings.free_shipping_threshold_cents - resolved.subtotal)
      : 0;

  // Keep the session cart in sync with what is actually purchasable.
  session.cart = Object.fromEntries(resolved.items.map((i) => [i.product.id, i.quantity]));

  return render(c, 'shop/cart', {
    title: 'Your cart',
    cart: resolved,
    cartCount: resolved.count,
    shipping,
    freeShippingRemaining,
    cancelled: c.req.query('cancelled') === '1',
  });
});

cart.post('/add', async (c) => {
  const store = c.get('store');
  const session = c.get('session');
  const body = c.get('body');
  const product = await store.getProduct(Number(body.productId));
  if (!product || !store.isAvailable(product)) {
    session.flash = { type: 'error', message: 'Sorry, that item is not available right now.' };
    return c.redirect(backTo(body, '/shop'));
  }
  const next = { ...(session.cart || {}) };
  const requested = (Number(next[product.id]) || 0) + Math.max(1, Math.floor(Number(body.quantity)) || 1);
  const max = store.maxQuantity(product);
  next[product.id] = Math.min(requested, max);
  session.cart = next;
  session.flash = {
    type: 'success',
    message:
      requested > max
        ? `Only ${max} of “${product.name}” available — your cart has been updated.`
        : `Added “${product.name}” to your cart.`,
  };
  return c.redirect(backTo(body));
});

cart.post('/update', (c) => {
  const session = c.get('session');
  const body = c.get('body');
  const next = { ...(session.cart || {}) };
  const id = String(Number(body.productId));
  const qty = Math.floor(Number(body.quantity));
  if (id in next) {
    if (qty > 0) next[id] = qty;
    else delete next[id];
  }
  session.cart = next;
  return c.redirect('/cart');
});

cart.post('/remove', (c) => {
  const session = c.get('session');
  const next = { ...(session.cart || {}) };
  delete next[String(Number(c.get('body').productId))];
  session.cart = next;
  return c.redirect('/cart');
});

export default cart;
