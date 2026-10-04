const config = require('./src/config');
const { createApp } = require('./src/app');

const app = createApp();

app.listen(config.port, () => {
  console.log(`3D Armory is running at ${config.baseUrl} (port ${config.port})`);
  if (!app.locals.stripe) console.warn('  ! STRIPE_SECRET_KEY not set — checkout is disabled.');
  if (!config.admin.password) console.warn('  ! ADMIN_PASSWORD not set — the admin dashboard is locked.');
});
