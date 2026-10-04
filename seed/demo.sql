-- Demo catalogue for 3D Armory. Load with: npm run db:seed:local (or db:seed:remote)
-- Only inserts when the catalogue is empty, so it is safe to run more than once.
INSERT INTO categories (name, slug, description, sort_order)
SELECT * FROM (VALUES
  ('Models', 'models', 'Display-grade sculptures, busts and terrain.', 0),
  ('Figures', 'figures', 'Characters, warriors and collectible figures.', 1),
  ('Trinkets', 'trinkets', 'Small treasures: dice, keychains, fidgets and desk gear.', 2)
) WHERE NOT EXISTS (SELECT 1 FROM categories);

INSERT INTO products
  (name, slug, description, price_cents, compare_at_cents, category_id, stock, material, dimensions, image, featured, active)
SELECT v.* FROM (VALUES
  ('Obsidian Dragon Bust', 'obsidian-dragon-bust', 'A low-poly dragon bust printed in silk black PLA with hand-brushed gold accents. Weighted base, felt-lined bottom — made to command a shelf.', 4999, 5999, (SELECT id FROM categories WHERE slug = 'models'), 6, 'PLA+ silk black & gold', '18 × 12 × 14 cm', '/img/products/dragon.svg', 1, 1),
  ('Sentinel Knight Helm', 'sentinel-knight-helm', 'A faceted great-helm sculpture inspired by medieval armour. Finished in matte black with a gilded visor trim.', 3999, NULL, (SELECT id FROM categories WHERE slug = 'models'), 8, 'PLA, primed & painted', '14 × 11 × 16 cm', '/img/products/helmet.svg', 1, 1),
  ('Royal Guard Figure', 'royal-guard-figure', 'Resin-printed at 25-micron layers for crisp detail. Ships unpainted and primed, ready for your brushes — or order it pre-painted in black & gold.', 2999, NULL, (SELECT id FROM categories WHERE slug = 'figures'), 10, 'High-detail resin', '75 mm scale', '/img/products/knight.svg', 1, 1),
  ('Rook Tower Chess Piece', 'rook-tower-chess-piece', 'An oversized castle rook with a spiral stair interior. Made to order in silk gold PLA.', 1499, NULL, (SELECT id FROM categories WHERE slug = 'figures'), NULL, 'PLA silk gold', '9 cm tall', '/img/products/rook.svg', 0, 1),
  ('Gilded D20 Dice', 'gilded-d20-dice', 'A chunky, balanced D20 with recessed numerals inlaid in gold. Rolls true and looks even better sitting on your character sheet.', 1299, NULL, (SELECT id FROM categories WHERE slug = 'trinkets'), 25, 'Resin with gold inlay', '25 mm', '/img/products/d20.svg', 1, 1),
  ('Armory Shield Keychain', 'armory-shield-keychain', 'Our crest, shrunk down to pocket size. Tough PETG with a split ring that will not let go.', 899, NULL, (SELECT id FROM categories WHERE slug = 'trinkets'), 40, 'PETG', '5 × 4 cm', '/img/products/shield.svg', 0, 1),
  ('Mini Blade Letter Opener', 'mini-blade-letter-opener', 'A desk-friendly longsword with a blunted edge and a gold-wrapped grip. Opens letters, not people.', 1199, NULL, (SELECT id FROM categories WHERE slug = 'trinkets'), 15, 'PLA+', '17 cm', '/img/products/sword.svg', 0, 1),
  ('Spiral Vortex Vase', 'spiral-vortex-vase', 'A single-wall vase printed in one continuous spiral. Watertight liner included for fresh flowers.', 2499, NULL, (SELECT id FROM categories WHERE slug = 'models'), 0, 'PETG translucent', '22 cm tall', '/img/products/vase.svg', 0, 1)
) AS v WHERE NOT EXISTS (SELECT 1 FROM products);
