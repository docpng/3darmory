import { slugify } from './format.js';

export const ORDER_STATUSES = ['pending', 'paid', 'shipped', 'completed', 'cancelled', 'expired'];

const MAX_QTY_PER_ITEM = 20;

const SORTS = {
  newest: 'p.created_at DESC, p.id DESC',
  'price-asc': 'p.price_cents ASC',
  'price-desc': 'p.price_cents DESC',
  name: 'p.name COLLATE NOCASE ASC',
};

const PRODUCT_COLUMNS = `p.*, c.name AS category_name, c.slug AS category_slug`;
const PRODUCT_FROM = `FROM products p LEFT JOIN categories c ON c.id = p.category_id`;
const CATEGORIES_SQL = `SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS product_count
  FROM categories c ORDER BY c.sort_order, c.name`;

/** D1 rejects `undefined` bind values. */
const clean = (params) => params.map((v) => (v === undefined ? null : v));

function parseSettings(rows) {
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  s.shipping_flat_cents = Number(s.shipping_flat_cents) || 0;
  s.free_shipping_threshold_cents = Number(s.free_shipping_threshold_cents) || 0;
  return s;
}

/** Data access for the store, backed by a Cloudflare D1 database. */
export function createStore(db) {
  const stmt = (sql, ...params) => db.prepare(sql).bind(...clean(params));
  const all = async (sql, ...params) => (await stmt(sql, ...params).all()).results;
  const first = (sql, ...params) => stmt(sql, ...params).first();
  const run = (sql, ...params) => stmt(sql, ...params).run();

  /* ----------------------------- settings ----------------------------- */

  async function getSettings() {
    return parseSettings(await all('SELECT key, value FROM settings'));
  }

  /** Settings + categories in one round trip — needed by every page's header and footer. */
  async function getLayoutData() {
    const [settings, categories] = await db.batch([
      db.prepare('SELECT key, value FROM settings'),
      db.prepare(CATEGORIES_SQL),
    ]);
    return { settings: parseSettings(settings.results), categories: categories.results };
  }

  async function updateSettings(values) {
    await db.batch(
      Object.entries(values).map(([key, value]) =>
        stmt(
          'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
          key,
          String(value),
        ),
      ),
    );
  }

  /* ---------------------------- categories ---------------------------- */

  const listCategories = () => all(CATEGORIES_SQL);

  const getCategoryBySlug = (slug) => first('SELECT * FROM categories WHERE slug = ?', slug);

  async function uniqueSlug(table, base, excludeId = null) {
    const root = slugify(base) || 'item';
    let slug = root;
    for (let i = 2; ; i++) {
      const row = await first(`SELECT id FROM ${table} WHERE slug = ?`, slug);
      if (!row || row.id === excludeId) return slug;
      slug = `${root}-${i}`;
    }
  }

  async function createCategory({ name, description = '', sort_order = 0 }) {
    const slug = await uniqueSlug('categories', name);
    const res = await run(
      'INSERT INTO categories (name, slug, description, sort_order) VALUES (?, ?, ?, ?)',
      name,
      slug,
      description,
      sort_order,
    );
    return res.meta.last_row_id;
  }

  async function updateCategory(id, { name, description = '', sort_order = 0 }) {
    const slug = await uniqueSlug('categories', name, id);
    await run(
      'UPDATE categories SET name = ?, slug = ?, description = ?, sort_order = ? WHERE id = ?',
      name,
      slug,
      description,
      sort_order,
      id,
    );
  }

  const deleteCategory = (id) => run('DELETE FROM categories WHERE id = ?', id);

  /* ----------------------------- products ----------------------------- */

  function listProducts({ category, q, sort = 'newest', featured, includeInactive = false, limit } = {}) {
    const where = [];
    const params = [];
    if (!includeInactive) where.push('p.active = 1');
    if (category) {
      where.push('c.slug = ?');
      params.push(category);
    }
    if (featured) where.push('p.featured = 1');
    if (q) {
      where.push('(p.name LIKE ? OR p.description LIKE ? OR p.material LIKE ?)');
      const like = `%${q}%`;
      params.push(like, like, like);
    }
    let sql = `SELECT ${PRODUCT_COLUMNS} ${PRODUCT_FROM}`;
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    sql += ` ORDER BY ${SORTS[sort] || SORTS.newest}`;
    if (limit) {
      sql += ' LIMIT ?';
      params.push(limit);
    }
    return all(sql, ...params);
  }

  const getProduct = (id) => first(`SELECT ${PRODUCT_COLUMNS} ${PRODUCT_FROM} WHERE p.id = ?`, id);

  const getProductBySlug = (slug) =>
    first(`SELECT ${PRODUCT_COLUMNS} ${PRODUCT_FROM} WHERE p.slug = ? AND p.active = 1`, slug);

  const relatedProducts = (product, limit = 4) =>
    all(
      `SELECT ${PRODUCT_COLUMNS} ${PRODUCT_FROM}
       WHERE p.active = 1 AND p.id != ? AND (p.category_id IS ? OR p.featured = 1)
       ORDER BY (p.category_id IS ?) DESC, p.created_at DESC LIMIT ?`,
      product.id,
      product.category_id,
      product.category_id,
      limit,
    );

  const productValues = (d, slug) => [
    d.name,
    slug,
    d.description,
    d.price_cents,
    d.compare_at_cents,
    d.category_id,
    d.stock,
    d.material,
    d.dimensions,
    d.image,
    d.featured,
    d.active,
  ];

  async function createProduct(data) {
    const slug = await uniqueSlug('products', data.slug || data.name);
    const res = await run(
      `INSERT INTO products
        (name, slug, description, price_cents, compare_at_cents, category_id, stock, material, dimensions, image, featured, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ...productValues(data, slug),
    );
    return res.meta.last_row_id;
  }

  async function updateProduct(id, data) {
    const slug = await uniqueSlug('products', data.slug || data.name, id);
    await run(
      `UPDATE products SET
         name = ?, slug = ?, description = ?, price_cents = ?, compare_at_cents = ?, category_id = ?,
         stock = ?, material = ?, dimensions = ?, image = ?, featured = ?, active = ?, updated_at = datetime('now')
       WHERE id = ?`,
      ...productValues(data, slug),
      id,
    );
  }

  const deleteProduct = (id) => run('DELETE FROM products WHERE id = ?', id);

  function isAvailable(product) {
    return product.active === 1 && (product.stock === null || product.stock > 0);
  }

  function maxQuantity(product) {
    return product.stock === null ? MAX_QTY_PER_ITEM : Math.min(product.stock, MAX_QTY_PER_ITEM);
  }

  /**
   * Turns a session cart ({ productId: qty }) into priced line items using current
   * database prices, dropping unavailable products and clamping quantities to stock.
   */
  async function resolveCart(cart = {}) {
    const ids = Object.keys(cart).map(Number).filter(Number.isInteger);
    const products = ids.length
      ? await all(`SELECT ${PRODUCT_COLUMNS} ${PRODUCT_FROM} WHERE p.id IN (${ids.map(() => '?').join(',')})`, ...ids)
      : [];
    const items = [];
    for (const product of products) {
      if (!isAvailable(product)) continue;
      const qty = cart[product.id];
      const quantity = Math.min(Math.max(1, Math.floor(Number(qty)) || 1), maxQuantity(product));
      items.push({ product, quantity, lineTotal: product.price_cents * quantity });
    }
    const subtotal = items.reduce((sum, i) => sum + i.lineTotal, 0);
    const count = items.reduce((sum, i) => sum + i.quantity, 0);
    return { items, subtotal, count };
  }

  function shippingFor(subtotal, settings) {
    if (settings.free_shipping_threshold_cents > 0 && subtotal >= settings.free_shipping_threshold_cents) return 0;
    return settings.shipping_flat_cents;
  }

  /* ------------------------------ orders ------------------------------ */

  async function createPendingOrder({ items, subtotal, shipping, currency }) {
    const order = await first(
      `INSERT INTO orders (status, subtotal_cents, shipping_cents, total_cents, currency)
       VALUES ('pending', ?, ?, ?, ?) RETURNING id`,
      subtotal,
      shipping,
      subtotal + shipping,
      currency,
    );
    await db.batch(
      items.map((i) =>
        stmt(
          'INSERT INTO order_items (order_id, product_id, name, unit_price_cents, quantity) VALUES (?, ?, ?, ?, ?)',
          order.id,
          i.product.id,
          i.product.name,
          i.product.price_cents,
          i.quantity,
        ),
      ),
    );
    return order.id;
  }

  const attachCheckoutSession = (orderId, sessionId) =>
    run('UPDATE orders SET stripe_session_id = ? WHERE id = ?', sessionId, orderId);

  const getOrderBySession = (sessionId) => first('SELECT * FROM orders WHERE stripe_session_id = ?', sessionId);

  /**
   * Marks the order for a completed Stripe Checkout Session as paid and decrements stock.
   * Runs as one atomic batch guarded on status = 'pending', so it is idempotent: safe to
   * call from both the webhook and the success page, and for replayed webhook events.
   */
  async function markOrderPaid(sessionId, { email, name, address, totalCents, shippingCents } = {}) {
    const order = await getOrderBySession(sessionId);
    if (!order || order.status !== 'pending') return order;
    await db.batch([
      stmt(
        `UPDATE products SET stock = MAX(stock - (
           SELECT SUM(oi.quantity) FROM order_items oi WHERE oi.order_id = ?1 AND oi.product_id = products.id
         ), 0)
         WHERE stock IS NOT NULL
           AND id IN (SELECT product_id FROM order_items WHERE order_id = ?1)
           AND EXISTS (SELECT 1 FROM orders WHERE id = ?1 AND status = 'pending')`,
        order.id,
      ),
      stmt(
        `UPDATE orders SET status = 'paid', paid_at = datetime('now'),
           customer_email = ?, customer_name = ?, shipping_address = ?,
           total_cents = COALESCE(?, total_cents), shipping_cents = COALESCE(?, shipping_cents)
         WHERE id = ? AND status = 'pending'`,
        email ?? null,
        name ?? null,
        address ? JSON.stringify(address) : null,
        totalCents ?? null,
        shippingCents ?? null,
        order.id,
      ),
    ]);
    return getOrderBySession(sessionId);
  }

  const markOrderExpired = (sessionId) =>
    run(`UPDATE orders SET status = 'expired' WHERE stripe_session_id = ? AND status = 'pending'`, sessionId);

  function listOrders({ status } = {}) {
    const base = `SELECT o.*, (SELECT SUM(quantity) FROM order_items WHERE order_id = o.id) AS item_count FROM orders o`;
    if (status === 'all') return all(`${base} ORDER BY o.id DESC`);
    if (status) return all(`${base} WHERE o.status = ? ORDER BY o.id DESC`, status);
    return all(`${base} WHERE o.status NOT IN ('pending', 'expired') ORDER BY o.id DESC`);
  }

  async function getOrder(id) {
    const order = await first('SELECT * FROM orders WHERE id = ?', id);
    if (!order) return null;
    order.items = await all('SELECT * FROM order_items WHERE order_id = ?', id);
    order.address = order.shipping_address ? JSON.parse(order.shipping_address) : null;
    return order;
  }

  const updateOrder = (id, { status, notes }) =>
    run('UPDATE orders SET status = ?, notes = ? WHERE id = ?', status, notes ?? '', id);

  async function dashboardStats() {
    const paid = `('paid', 'shipped', 'completed')`;
    const [counts, lowStock, recentOrders] = await Promise.all([
      first(`SELECT
          (SELECT COUNT(*) FROM products) AS products,
          (SELECT COUNT(*) FROM products WHERE active = 1) AS activeProducts,
          (SELECT COUNT(*) FROM orders WHERE status IN ${paid}) AS orders,
          (SELECT COUNT(*) FROM orders WHERE status = 'paid') AS toFulfil,
          (SELECT COALESCE(SUM(total_cents), 0) FROM orders WHERE status IN ${paid}) AS revenue`),
      all('SELECT id, name, stock FROM products WHERE stock IS NOT NULL AND stock <= 3 ORDER BY stock, name'),
      listOrders(),
    ]);
    return { ...counts, lowStock, recentOrders: recentOrders.slice(0, 5) };
  }

  /* --------------------------- login throttling ------------------------ */

  async function tooManyLoginAttempts(ip) {
    const row = await first('SELECT count, reset_at FROM login_attempts WHERE ip = ?', ip);
    return Boolean(row && row.reset_at > Date.now() && row.count >= 10);
  }

  function recordFailedLogin(ip) {
    const now = Date.now();
    return run(
      `INSERT INTO login_attempts (ip, count, reset_at) VALUES (?, 1, ?)
       ON CONFLICT(ip) DO UPDATE SET
         count = CASE WHEN reset_at < ? THEN 1 ELSE count + 1 END,
         reset_at = CASE WHEN reset_at < ? THEN excluded.reset_at ELSE reset_at END`,
      ip,
      now + 15 * 60 * 1000,
      now,
      now,
    );
  }

  const clearLoginAttempts = (ip) => run('DELETE FROM login_attempts WHERE ip = ?', ip);

  return {
    getSettings,
    getLayoutData,
    updateSettings,
    listCategories,
    getCategoryBySlug,
    createCategory,
    updateCategory,
    deleteCategory,
    listProducts,
    getProduct,
    getProductBySlug,
    relatedProducts,
    createProduct,
    updateProduct,
    deleteProduct,
    isAvailable,
    maxQuantity,
    resolveCart,
    shippingFor,
    createPendingOrder,
    attachCheckoutSession,
    getOrderBySession,
    markOrderPaid,
    markOrderExpired,
    listOrders,
    getOrder,
    updateOrder,
    dashboardStats,
    tooManyLoginAttempts,
    recordFailedLogin,
    clearLoginAttempts,
  };
}
