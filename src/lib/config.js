/** Reads the store configuration from the Worker's environment bindings. */
export function getConfig(env, request) {
  const url = new URL(request.url);
  return {
    baseUrl: (env.BASE_URL || url.origin).replace(/\/+$/, ''),
    secureCookies: url.protocol === 'https:',
    isLocal: ['localhost', '127.0.0.1'].includes(url.hostname),
    sessionSecret: env.SESSION_SECRET || '',
    admin: {
      email: (env.ADMIN_EMAIL || '').trim().toLowerCase(),
      password: env.ADMIN_PASSWORD || '',
    },
    stripe: {
      secretKey: env.STRIPE_SECRET_KEY || '',
      webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
    },
    currency: (env.CURRENCY || 'usd').toLowerCase(),
    shippingCountries: (env.SHIPPING_COUNTRIES || 'US,CA')
      .split(',')
      .map((c) => c.trim().toUpperCase())
      .filter(Boolean),
  };
}
