const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const config = require('./config');
const { slugify } = require('./lib/format');

const SCHEMA = `
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
`;

const DEFAULT_SETTINGS = {
  store_name: '3D Armory',
  tagline: 'Forged layer by layer.',
  hero_title: 'Precision-printed models, figures & trinkets.',
  hero_subtitle:
    'Every piece is designed, printed and hand-finished in our workshop — built to be displayed, gifted and collected.',
  announcement: 'Free shipping on orders over $75',
  about_text:
    '3D Armory is a small workshop obsessed with detail. We print every model, figure and trinket to order on calibrated machines, then sand, prime and finish each one by hand.\n\nHave an idea for a custom piece? Get in touch — we love a challenge.',
  contact_email: 'hello@3darmory.com',
  shipping_flat_cents: '599',
  free_shipping_threshold_cents: '7500',
};

const DEMO_CATEGORIES = [
  { name: 'Models', description: 'Display-grade sculptures, busts and terrain.' },
  { name: 'Figures', description: 'Characters, warriors and collectible figures.' },
  { name: 'Trinkets', description: 'Small treasures: dice, keychains, fidgets and desk gear.' },
];

const DEMO_PRODUCTS = [
  {
    name: 'Obsidian Dragon Bust',
    category: 'Models',
    price: 4999,
    compare: 5999,
    stock: 6,
    material: 'PLA+ silk black & gold',
    dimensions: '18 × 12 × 14 cm',
    image: '/img/products/dragon.svg',
    featured: 1,
    description:
      'A low-poly dragon bust printed in silk black PLA with hand-brushed gold accents. Weighted base, felt-lined bottom — made to command a shelf.',
  },
  {
    name: 'Sentinel Knight Helm',
    category: 'Models',
    price: 3999,
    stock: 8,
    material: 'PLA, primed & painted',
    dimensions: '14 × 11 × 16 cm',
    image: '/img/products/helmet.svg',
    featured: 1,
    description:
      'A faceted great-helm sculpture inspired by medieval armour. Finished in matte black with a gilded visor trim.',
  },
  {
    name: 'Royal Guard Figure',
    category: 'Figures',
    price: 2999,
    stock: 10,
    material: 'High-detail resin',
    dimensions: '75 mm scale',
    image: '/img/products/knight.svg',
    featured: 1,
    description:
      'Resin-printed at 25-micron layers for crisp detail. Ships unpainted and primed, ready for your brushes — or order it pre-painted in black & gold.',
  },
  {
    name: 'Rook Tower Chess Piece',
    category: 'Figures',
    price: 1499,
    stock: null,
    material: 'PLA silk gold',
    dimensions: '9 cm tall',
    image: '/img/products/rook.svg',
    featured: 0,
    description: 'An oversized castle rook with a spiral stair interior. Made to order in silk gold PLA.',
  },
  {
    name: 'Gilded D20 Dice',
    category: 'Trinkets',
    price: 1299,
    stock: 25,
    material: 'Resin with gold inlay',
    dimensions: '25 mm',
    image: '/img/products/d20.svg',
    featured: 1,
    description:
      'A chunky, balanced D20 with recessed numerals inlaid in gold. Rolls true and looks even better sitting on your character sheet.',
  },
  {
    name: 'Armory Shield Keychain',
    category: 'Trinkets',
    price: 899,
    stock: 40,
    material: 'PETG',
    dimensions: '5 × 4 cm',
    image: '/img/products/shield.svg',
    featured: 0,
    description: 'Our crest, shrunk down to pocket size. Tough PETG with a split ring that will not let go.',
  },
  {
    name: 'Mini Blade Letter Opener',
    category: 'Trinkets',
    price: 1199,
    stock: 15,
    material: 'PLA+',
    dimensions: '17 cm',
    image: '/img/products/sword.svg',
    featured: 0,
    description: 'A desk-friendly longsword with a blunted edge and a gold-wrapped grip. Opens letters, not people.',
  },
  {
    name: 'Spiral Vortex Vase',
    category: 'Models',
    price: 2499,
    stock: 0,
    material: 'PETG translucent',
    dimensions: '22 cm tall',
    image: '/img/products/vase.svg',
    featured: 0,
    description:
      'A single-wall vase printed in one continuous spiral. Watertight liner included for fresh flowers.',
  },
];

function openDatabase(file = config.dbFile) {
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(key, value);

  return db;
}

function seedDemoData(db) {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM categories').get();
  if (n > 0) return false;

  const insertCategory = db.prepare(
    'INSERT INTO categories (name, slug, description, sort_order) VALUES (?, ?, ?, ?)',
  );
  const insertProduct = db.prepare(`
    INSERT INTO products
      (name, slug, description, price_cents, compare_at_cents, category_id, stock, material, dimensions, image, featured, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`);

  db.transaction(() => {
    const ids = {};
    DEMO_CATEGORIES.forEach((c, i) => {
      ids[c.name] = insertCategory.run(c.name, slugify(c.name), c.description, i).lastInsertRowid;
    });
    for (const p of DEMO_PRODUCTS) {
      insertProduct.run(
        p.name,
        slugify(p.name),
        p.description,
        p.price,
        p.compare ?? null,
        ids[p.category],
        p.stock,
        p.material,
        p.dimensions,
        p.image,
        p.featured,
      );
    }
  })();
  return true;
}

module.exports = { openDatabase, seedDemoData, DEFAULT_SETTINGS };
