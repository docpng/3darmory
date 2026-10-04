-- 3D Armory database schema (Cloudflare D1)
CREATE TABLE IF NOT EXISTS categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS products (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL,
  slug             TEXT NOT NULL UNIQUE,
  description      TEXT NOT NULL DEFAULT '',
  price_cents      INTEGER NOT NULL CHECK (price_cents >= 0),
  compare_at_cents INTEGER,
  category_id      INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  stock            INTEGER,            -- NULL = made to order (unlimited)
  material         TEXT NOT NULL DEFAULT '',
  dimensions       TEXT NOT NULL DEFAULT '',
  image            TEXT,
  featured         INTEGER NOT NULL DEFAULT 0,
  active           INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  stripe_session_id  TEXT UNIQUE,
  status             TEXT NOT NULL DEFAULT 'pending', -- pending | paid | shipped | completed | cancelled | expired
  customer_email     TEXT,
  customer_name      TEXT,
  shipping_address   TEXT,
  subtotal_cents     INTEGER NOT NULL DEFAULT 0,
  shipping_cents     INTEGER NOT NULL DEFAULT 0,
  total_cents        INTEGER NOT NULL DEFAULT 0,
  currency           TEXT NOT NULL,
  notes              TEXT NOT NULL DEFAULT '',
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at            TEXT
);

CREATE TABLE IF NOT EXISTS order_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id         INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id       INTEGER REFERENCES products(id) ON DELETE SET NULL,
  name             TEXT NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  quantity         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

-- Tracks failed admin logins per IP for rate limiting.
CREATE TABLE IF NOT EXISTS login_attempts (
  ip       TEXT PRIMARY KEY,
  count    INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);

-- Default site settings (editable in Admin → Site settings).
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('store_name', '3D Armory'),
  ('tagline', 'Forged layer by layer.'),
  ('hero_title', 'Precision-printed models, figures & trinkets.'),
  ('hero_subtitle', 'Every piece is designed, printed and hand-finished in our workshop — built to be displayed, gifted and collected.'),
  ('announcement', 'Free shipping on orders over $75'),
  ('about_text', '3D Armory is a small workshop obsessed with detail. We print every model, figure and trinket to order on calibrated machines, then sand, prime and finish each one by hand.

Have an idea for a custom piece? Get in touch — we love a challenge.'),
  ('contact_email', 'hello@3darmory.com'),
  ('shipping_flat_cents', '599'),
  ('free_shipping_threshold_cents', '7500');
