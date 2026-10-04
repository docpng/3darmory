import { applyD1Migrations, env } from 'cloudflare:test';
import seedSql from '../seed/demo.sql?raw';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Load the demo catalogue (statement by statement — D1 prepares one statement at a time).
const statements = seedSql
  .split(/;\s*\n/)
  .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
  .filter(Boolean);
await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
