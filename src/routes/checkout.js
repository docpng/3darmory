import { Hono } from 'hono';
import { notFound, render } from '../lib/render.js';

const checkout = new Hono();

function absoluteImageUrl(baseUrl, image) {
  if (!image || image.endsWith('.svg')) return null; // Stripe cannot display SVGs
  const url = image.startsWith('http') ? image : `${baseUrl}${image}`;
  return url.startsWith('https://') ? url : null; // Stripe requires publicly reachable HTTPS images
}

/** Copies the customer + payment details from a Checkout Session onto our order. */
export function fulfilFromSession(store, session) {
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

checkout.post('/', async (c) => {
  const store = c.get('store');
  const stripe = c.get('stripe');
  const session = c.get('session');
  const config = c.get('config');
  if (!stripe) {
    session.flash = { type: 'error', message: 'Online checkout is not configured yet. Please contact us to place an order.' };
    return c.redirect('/cart');
  }

  const cart = await store.resolveCart(session.cart);
  if (!cart.items.length) {
    session.flash = { type: 'error', message: 'Your cart is empty.' };
    return c.redirect('/cart');
  }

  const { settings } = c.get('locals');
  const shipping = store.shippingFor(cart.subtotal, settings);
  const orderId = await store.createPendingOrder({
    items: cart.items,
    subtotal: cart.subtotal,
    shipping,
    currency: config.currency,
  });

  const checkoutSession = await stripe.checkout.sessions.create({
    mode: 'payment',
    client_reference_id: String(orderId),
    metadata: { order_id: String(orderId) },
    line_items: cart.items.map(({ product, quantity }) => {
      const image = absoluteImageUrl(config.baseUrl, product.image);
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

  await store.attachCheckoutSession(orderId, checkoutSession.id);
  return c.redirect(checkoutSession.url, 303);
});

checkout.get('/success', async (c) => {
  const store = c.get('store');
  const stripe = c.get('stripe');
  const sessionId = c.req.query('session_id') || '';
  let order = sessionId ? await store.getOrderBySession(sessionId) : null;
  if (!stripe || !order) return notFound(c);

  // The webhook is the source of truth, but confirm here too in case it hasn't arrived yet.
  if (order.status === 'pending') {
    const checkoutSession = await stripe.checkout.sessions.retrieve(sessionId);
    if (checkoutSession.payment_status === 'paid') order = await fulfilFromSession(store, checkoutSession);
  }

  c.get('session').cart = {};
  return render(c, 'shop/success', { title: 'Order confirmed', cartCount: 0, order: await store.getOrder(order.id) });
});

export default checkout;
