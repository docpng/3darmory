const { slugify } = require('./format');

const MAX_QTY_PER_ITEM = 20;

const SORTS = {
  newest: 'p.created_at DESC, p.id DESC',
  'price-asc': 'p.price_cents ASC',
  'price-desc': 'p.price_cents DESC',
  name: 'p.name COLLATE NOCASE ASC',
};

const PRODUCT_COLUMNS = `p.*, c.name AS category_name, c.slug AS category_slug`;
const PRODUCT_FROM = `FROM products p LEFT JOIN categories c ON c.id = p.category_id`;

function createStore(db) {
  /* ----------------------------- settings ----------------------------- */

  function getSettings() {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    s.shipping_flat_cents = Number(s.shipping_flat_cents) || 0;
    s.free_shipping_threshold_cents = Number(s.free_shipping_threshold_cents) || 0;
    return s;
  }

  function updateSettings(values) {
    const upsert = db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    db.transaction(() => {
      for (const [key, value] of Object.entries(values)) upsert.run(key, String(value));
    })();
  }

  /* ---------------------------- categories ---------------------------- */

  function listCategories() {
    return db
      .prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS product_count
         FROM categories c ORDER BY c.sort_order, c.name`,
      )
      .all();
  }

  function getCategoryBySlug(slug) {
    return db.prepare('SELECT * FROM categories WHERE slug = ?').get(slug);
  }

  function uniqueSlug(table, base, excludeId = null) {
    const root = slugify(base) || 'item';
    let slug = root;
    for (let i = 2; ; i++) {
      const row = db.prepare(`SELECT id FROM ${table} WHERE slug = ?`).get(slug);
      if (!row || row.id === excludeId) return slug;
      slug = `${root}-${i}`;
    }
  }

  function createCategory({ name, description = '', sort_order = 0 }) {
    const slug = uniqueSlug('categories', name);
    return db
      .prepare('INSERT INTO categories (name, slug, description, sort_order) VALUES (?, ?, ?, ?)')
      .run(name, slug, description, sort_order).lastInsertRowid;
  }

  function updateCategory(id, { name, description = '', sort_order = 0 }) {
    const slug = uniqueSlug('categories', name, id);
    db.prepare('UPDATE categories SET name = ?, slug = ?, description = ?, sort_order = ? WHERE id = ?').run(
      name,
      slug,
      description,
      sort_order,
      id,
    );
  }

  function deleteCategory(id) {
    db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  }

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
    return db.prepare(sql).all(...params);
  }

  function getProduct(id) {
    return db.prepare(`SELECT ${PRODUCT_COLUMNS} ${PRODUCT_FROM} WHERE p.id = ?`).get(id);
  }

  function getProductBySlug(slug) {
    return db.prepare(`SELECT ${PRODUCT_COLUMNS} ${PRODUCT_FROM} WHERE p.slug = ? AND p.active = 1`).get(slug);
  }

  function relatedProducts(product, limit = 4) {
    return db
      .prepare(
        `SELECT ${PRODUCT_COLUMNS} ${PRODUCT_FROM}
         WHERE p.active = 1 AND p.id != ? AND (p.category_id IS ? OR p.featured = 1)
         ORDER BY (p.category_id IS ?) DESC, p.created_at DESC LIMIT ?`,
      )
      .all(product.id, product.category_id, product.category_id, limit);
  }

  function createProduct(data) {
    const slug = uniqueSlug('products', data.slug || data.name);
    return db
      .prepare(
        `INSERT INTO products
          (name, slug, description, price_cents, compare_at_cents, category_id, stock, material, dimensions, image, featured, active)
         VALUES (@name, @slug, @description, @price_cents, @compare_at_cents, @category_id, @stock, @material, @dimensions, @image, @featured, @active)`,
      )
      .run({ ...data, slug }).lastInsertRowid;
  }

  function updateProduct(id, data) {
    const slug = uniqueSlug('products', data.slug || data.name, id);
    db.prepare(
      `UPDATE products SET
         name = @name, slug = @slug, description = @description, price_cents = @price_cents,
         compare_at_cents = @compare_at_cents, category_id = @category_id, stock = @stock,
         material = @material, dimensions = @dimensions, image = @image, featured = @featured,
         active = @active, updated_at = datetime('now')
       WHERE id = @id`,
    ).run({ ...data, slug, id });
  }

  function deleteProduct(id) {
    db.prepare('DELETE FROM products WHERE id = ?').run(id);
  }

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
  function resolveCart(cart = {}) {
    const items = [];
    for (const [id, qty] of Object.entries(cart)) {
      const product = getProduct(Number(id));
      if (!product || !isAvailable(product)) continue;
      const quantity = Math.min(Math.max(1, Math.floor(Number(qty)) || 1), maxQuantity(product));
      items.push({ product, quantity, lineTotal: product.price_cents * quantity });
    }
    const subtotal = items.reduce((sum, i) => sum + i.lineTotal, 0);
    const count = items.reduce((sum, i) => sum + i.quantity, 0);
    return { items, subtotal, count };
  }

  function shippingFor(subtotal, settings = getSettings()) {
    if (settings.free_shipping_threshold_cents > 0 && subtotal >= settings.free_shipping_threshold_cents) return 0;
    return settings.shipping_flat_cents;
  }

  /* ------------------------------ orders ------------------------------ */

  function createPendingOrder({ items, subtotal, shipping, currency }) {
    return db.transaction(() => {
      const orderId = db
        .prepare(
          `INSERT INTO orders (status, subtotal_cents, shipping_cents, total_cents, currency)
           VALUES ('pending', ?, ?, ?, ?)`,
        )
        .run(subtotal, shipping, subtotal + shipping, currency).lastInsertRowid;
      const insertItem = db.prepare(
        'INSERT INTO order_items (order_id, product_id, name, unit_price_cents, quantity) VALUES (?, ?, ?, ?, ?)',
      );
      for (const i of items) insertItem.run(orderId, i.product.id, i.product.name, i.product.price_cents, i.quantity);
      return orderId;
    })();
  }

  function attachCheckoutSession(orderId, sessionId) {
    db.prepare('UPDATE orders SET stripe_session_id = ? WHERE id = ?').run(sessionId, orderId);
  }

  function getOrderBySession(sessionId) {
    return db.prepare('SELECT * FROM orders WHERE stripe_session_id = ?').get(sessionId);
  }

  /**
   * Marks the order for a completed Stripe Checkout Session as paid and decrements stock.
   * Idempotent: safe to call from both the webhook and the success page.
   */
  function markOrderPaid(sessionId, { email, name, address, totalCents, shippingCents } = {}) {
    return db.transaction(() => {
      const order = getOrderBySession(sessionId);
      if (!order || order.status !== 'pending') return order;
      db.prepare(
        `UPDATE orders SET status = 'paid', paid_at = datetime('now'),
           customer_email = ?, customer_name = ?, shipping_address = ?,
           total_cents = COALESCE(?, total_cents), shipping_cents = COALESCE(?, shipping_cents)
         WHERE id = ?`,
      ).run(
        email ?? null,
        name ?? null,
        address ? JSON.stringify(address) : null,
        totalCents ?? null,
        shippingCents ?? null,
        order.id,
      );
      const items = db.prepare('SELECT product_id, quantity FROM order_items WHERE order_id = ?').all(order.id);
      const decrement = db.prepare(
        'UPDATE products SET stock = MAX(stock - ?, 0) WHERE id = ? AND stock IS NOT NULL',
      );
      for (const i of items) if (i.product_id) decrement.run(i.quantity, i.product_id);
      return getOrderBySession(sessionId);
    })();
  }

  function markOrderExpired(sessionId) {
    db.prepare(`UPDATE orders SET status = 'expired' WHERE stripe_session_id = ? AND status = 'pending'`).run(
      sessionId,
    );
  }

  function listOrders({ status } = {}) {
    const base = `SELECT o.*, (SELECT SUM(quantity) FROM order_items WHERE order_id = o.id) AS item_count FROM orders o`;
    if (status === 'all') return db.prepare(`${base} ORDER BY o.id DESC`).all();
    if (status) return db.prepare(`${base} WHERE o.status = ? ORDER BY o.id DESC`).all(status);
    return db.prepare(`${base} WHERE o.status NOT IN ('pending', 'expired') ORDER BY o.id DESC`).all();
  }

  function getOrder(id) {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (!order) return null;
    order.items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(id);
    order.address = order.shipping_address ? JSON.parse(order.shipping_address) : null;
    return order;
  }

  function updateOrder(id, { status, notes }) {
    db.prepare('UPDATE orders SET status = ?, notes = ? WHERE id = ?').run(status, notes ?? '', id);
  }

  function dashboardStats() {
    const paidStatuses = `('paid', 'shipped', 'completed')`;
    return {
      products: db.prepare('SELECT COUNT(*) AS n FROM products').get().n,
      activeProducts: db.prepare('SELECT COUNT(*) AS n FROM products WHERE active = 1').get().n,
      orders: db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE status IN ${paidStatuses}`).get().n,
      toFulfil: db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE status = 'paid'`).get().n,
      revenue: db.prepare(`SELECT COALESCE(SUM(total_cents), 0) AS n FROM orders WHERE status IN ${paidStatuses}`).get()
        .n,
      lowStock: db
        .prepare('SELECT id, name, stock FROM products WHERE stock IS NOT NULL AND stock <= 3 ORDER BY stock, name')
        .all(),
      recentOrders: listOrders().slice(0, 5),
    };
  }

  return {
    getSettings,
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
  };
}

module.exports = { createStore, ORDER_STATUSES: ['pending', 'paid', 'shipped', 'completed', 'cancelled', 'expired'] };
