const express = require('express');
const config = require('../config');

const router = express.Router();

function absoluteImageUrl(image) {
  if (!image || image.endsWith('.svg')) return null; // Stripe cannot display SVGs
  const url = image.startsWith('http') ? image : `${config.baseUrl}${image}`;
  return url.startsWith('https://') ? url : null; // Stripe requires publicly reachable HTTPS images
}

/** Copies the customer + payment details from a Checkout Session onto our order. */
function fulfilFromSession(store, session) {
  const details = session.customer_details || {};
  const shipping = session.collected_information?.shipping_details || session.shipping_details || null;
  return store.markOrderPaid(session.id, {
    email: details.email,
    name: shipping?.name || details.name,
    address: shipping?.address || details.address || null,
    totalCents: session.amount_total,
    shippingCents: session.total_details?.amount_shipping,
  });
}

router.post('/', async (req, res) => {
  const { store, stripe } = req.app.locals;
  if (!stripe) {
    req.flash('error', 'Online checkout is not configured yet. Please contact us to place an order.');
    return res.redirect('/cart');
  }

  const cart = store.resolveCart(req.session.cart);
  if (!cart.items.length) {
    req.flash('error', 'Your cart is empty.');
    return res.redirect('/cart');
  }

  const settings = store.getSettings();
  const shipping = store.shippingFor(cart.subtotal, settings);
  const orderId = store.createPendingOrder({
    items: cart.items,
    subtotal: cart.subtotal,
    shipping,
    currency: config.currency,
  });

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    client_reference_id: String(orderId),
    metadata: { order_id: String(orderId) },
    line_items: cart.items.map(({ product, quantity }) => {
      const image = absoluteImageUrl(product.image);
      return {
        quantity,
        price_data: {
          currency: config.currency,
          unit_amount: product.price_cents,
          product_data: {
            name: product.name,
            ...(product.description ? { description: product.description.slice(0, 500) } : {}),
            ...(image ? { images: [image] } : {}),
            metadata: { product_id: String(product.id) },
          },
        },
      };
    }),
    shipping_address_collection: { allowed_countries: config.shippingCountries },
    shipping_options: [
      {
        shipping_rate_data: {
          type: 'fixed_amount',
          display_name: shipping === 0 ? 'Free shipping' : 'Standard shipping',
          fixed_amount: { amount: shipping, currency: config.currency },
          delivery_estimate: {
            minimum: { unit: 'business_day', value: 3 },
            maximum: { unit: 'business_day', value: 8 },
          },
        },
      },
    ],
    phone_number_collection: { enabled: true },
    success_url: `${config.baseUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${config.baseUrl}/cart?cancelled=1`,
  });

  store.attachCheckoutSession(orderId, session.id);
  res.redirect(303, session.url);
});

router.get('/success', async (req, res, next) => {
  const { store, stripe } = req.app.locals;
  const sessionId = typeof req.query.session_id === 'string' ? req.query.session_id : '';
  let order = sessionId ? store.getOrderBySession(sessionId) : null;
  if (!stripe || !order) return next();

  // The webhook is the source of truth, but confirm here too in case it hasn't arrived yet.
  if (order.status === 'pending') {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status === 'paid') order = fulfilFromSession(store, session);
  }

  req.session.cart = {};
  res.locals.cartCount = 0;
  res.render('shop/success', { title: 'Order confirmed', order: store.getOrder(order.id) });
});

module.exports = router;
module.exports.fulfilFromSession = fulfilFromSession;
