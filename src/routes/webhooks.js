const express = require('express');
const config = require('../config');
const { fulfilFromSession } = require('./checkout');

const router = express.Router();

router.post('/stripe', express.raw({ type: 'application/json', limit: '1mb' }), (req, res) => {
  const { store, stripe } = req.app.locals;
  if (!stripe || !config.stripe.webhookSecret) {
    return res.status(503).send('Stripe webhooks are not configured.');
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), config.stripe.webhookSecret);
  } catch (err) {
    return res.status(400).send(`Webhook signature verification failed: ${err.message}`);
  }

  const session = event.data.object;
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      if (session.payment_status === 'paid') fulfilFromSession(store, session);
      break;
    case 'checkout.session.expired':
    case 'checkout.session.async_payment_failed':
      store.markOrderExpired(session.id);
      break;
    default:
      break;
  }
  res.json({ received: true });
});

module.exports = router;
