const path = require('node:path');
const crypto = require('node:crypto');

require('dotenv').config({ quiet: true });

const env = process.env;
const isProduction = env.NODE_ENV === 'production';

let sessionSecret = env.SESSION_SECRET;
if (!sessionSecret) {
  if (isProduction) {
    throw new Error('SESSION_SECRET must be set in production.');
  }
  sessionSecret = crypto.randomBytes(32).toString('hex');
  if (env.NODE_ENV !== 'test') {
    console.warn('[config] SESSION_SECRET not set — using a random secret (sessions reset on restart).');
  }
}

const port = Number(env.PORT) || 3000;
const dataDir = path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data'));

module.exports = {
  isProduction,
  port,
  baseUrl: (env.BASE_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
  sessionSecret,
  dataDir,
  dbFile: env.DB_FILE || path.join(dataDir, 'store.db'),
  uploadsDir: path.join(dataDir, 'uploads'),
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
  seedDemoData: env.SEED_DEMO_DATA !== 'false',
};
