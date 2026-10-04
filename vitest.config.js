import { defineConfig } from 'vitest/config';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';

// Tests run inside the real Workers runtime (workerd) with local D1 + R2 via Miniflare.
export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            SESSION_SECRET: 'test-session-secret',
            ADMIN_EMAIL: 'owner@example.com',
            ADMIN_PASSWORD: 'correct horse',
            STRIPE_WEBHOOK_SECRET: 'whsec_test_secret',
          },
        },
      }),
    ],
    test: { setupFiles: ['./test/setup.js'] },
  };
});
