const Stripe = require('stripe');
const config = require('../config');

/** Returns a configured Stripe client, or null when no secret key is set (checkout disabled). */
function createStripeClient(secretKey = config.stripe.secretKey) {
  if (!secretKey) return null;
  return new Stripe(secretKey, { appInfo: { name: '3D Armory Store' } });
}

module.exports = { createStripeClient };
