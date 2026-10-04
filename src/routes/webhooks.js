import { Hono } from 'hono';
import { fulfilFromSession } from './checkout.js';

const webhooks = new Hono();

webhooks.post('/stripe', async (c) => {
  const store = c.get('store');
  const stripe = c.get('stripe');
  const { webhookSecret } = c.get('config').stripe;
  if (!stripe || !webhookSecret) return c.text('Stripe webhooks are not configured.', 503);

  // Signature verification needs the exact raw body. Workers only have async crypto.
  const payload = await c.req.text();
  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(payload, c.req.header('stripe-signature') || '', webhookSecret);
  } catch (err) {
    return c.text(`Webhook signature verification failed: ${err.message}`, 400);
  }

  const session = event.data.object;
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      if (session.payment_status === 'paid') await fulfilFromSession(store, session);
      break;
    case 'checkout.session.expired':
    case 'checkout.session.async_payment_failed':
      await store.markOrderExpired(session.id);
      break;
    default:
      break;
  }
  return c.json({ received: true });
});

export default webhooks;
