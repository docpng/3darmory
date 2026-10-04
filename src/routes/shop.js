const express = require('express');

const router = express.Router();

router.get('/', (req, res) => {
  const { store } = req.app.locals;
  res.render('shop/home', {
    featured: store.listProducts({ featured: true, limit: 8 }),
    newest: store.listProducts({ sort: 'newest', limit: 4 }),
  });
});

router.get('/shop', (req, res) => {
  const { store } = req.app.locals;
  const category = typeof req.query.category === 'string' ? req.query.category : '';
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : '';
  const sort = typeof req.query.sort === 'string' ? req.query.sort : 'newest';
  const activeCategory = category ? store.getCategoryBySlug(category) : null;
  res.render('shop/catalog', {
    title: activeCategory ? activeCategory.name : 'Shop',
    products: store.listProducts({ category: activeCategory?.slug, q, sort }),
    activeCategory,
    q,
    sort,
  });
});

router.get('/product/:slug', (req, res, next) => {
  const { store } = req.app.locals;
  const product = store.getProductBySlug(req.params.slug);
  if (!product) return next();
  res.render('shop/product', {
    title: product.name,
    description: product.description.slice(0, 160),
    product,
    available: store.isAvailable(product),
    maxQty: store.maxQuantity(product),
    related: store.relatedProducts(product),
  });
});

router.get('/about', (req, res) => {
  res.render('shop/about', { title: 'About' });
});

module.exports = router;
