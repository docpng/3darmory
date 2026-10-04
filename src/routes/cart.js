const express = require('express');

const router = express.Router();

function backTo(req, fallback = '/cart') {
  const target = typeof req.body?.redirect === 'string' ? req.body.redirect : '';
  // Only allow local paths to avoid open redirects.
  return /^\/(?!\/)/.test(target) ? target : fallback;
}

router.get('/', (req, res) => {
  const { store } = req.app.locals;
  const cart = store.resolveCart(req.session.cart);
  const settings = res.locals.settings;
  const shipping = cart.items.length ? store.shippingFor(cart.subtotal, settings) : 0;
  const freeShippingRemaining =
    settings.free_shipping_threshold_cents > 0 ? Math.max(0, settings.free_shipping_threshold_cents - cart.subtotal) : 0;

  // Keep the session cart in sync with what is actually purchasable.
  req.session.cart = Object.fromEntries(cart.items.map((i) => [i.product.id, i.quantity]));
  res.locals.cartCount = cart.count;

  res.render('shop/cart', {
    title: 'Your cart',
    cart,
    shipping,
    freeShippingRemaining,
    cancelled: req.query.cancelled === '1',
  });
});

router.post('/add', (req, res) => {
  const { store } = req.app.locals;
  const product = store.getProduct(Number(req.body.productId));
  if (!product || !store.isAvailable(product)) {
    req.flash('error', 'Sorry, that item is not available right now.');
    return res.redirect(backTo(req, '/shop'));
  }
  const cart = { ...(req.session.cart || {}) };
  const requested = (Number(cart[product.id]) || 0) + Math.max(1, Math.floor(Number(req.body.quantity)) || 1);
  const max = store.maxQuantity(product);
  cart[product.id] = Math.min(requested, max);
  req.session.cart = cart;
  req.flash(
    'success',
    requested > max
      ? `Only ${max} of “${product.name}” available — your cart has been updated.`
      : `Added “${product.name}” to your cart.`,
  );
  res.redirect(backTo(req));
});

router.post('/update', (req, res) => {
  const cart = { ...(req.session.cart || {}) };
  const id = String(Number(req.body.productId));
  const qty = Math.floor(Number(req.body.quantity));
  if (id in cart) {
    if (qty > 0) cart[id] = qty;
    else delete cart[id];
  }
  req.session.cart = cart;
  res.redirect('/cart');
});

router.post('/remove', (req, res) => {
  const cart = { ...(req.session.cart || {}) };
  delete cart[String(Number(req.body.productId))];
  req.session.cart = cart;
  res.redirect('/cart');
});

module.exports = router;
