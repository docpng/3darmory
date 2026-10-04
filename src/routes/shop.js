import { Hono } from 'hono';
import { notFound, render } from '../lib/render.js';

const shop = new Hono();

shop.get('/', async (c) => {
  const store = c.get('store');
  const [featured, newest] = await Promise.all([
    store.listProducts({ featured: true, limit: 8 }),
    store.listProducts({ sort: 'newest', limit: 4 }),
  ]);
  return render(c, 'shop/home', { featured, newest });
});

shop.get('/shop', async (c) => {
  const store = c.get('store');
  const category = c.req.query('category') || '';
  const q = (c.req.query('q') || '').trim().slice(0, 100);
  const sort = c.req.query('sort') || 'newest';
  const activeCategory = category ? await store.getCategoryBySlug(category) : null;
  return render(c, 'shop/catalog', {
    title: activeCategory ? activeCategory.name : 'Shop',
    products: await store.listProducts({ category: activeCategory?.slug, q, sort }),
    activeCategory,
    q,
    sort,
  });
});

shop.get('/product/:slug', async (c) => {
  const store = c.get('store');
  const product = await store.getProductBySlug(c.req.param('slug'));
  if (!product) return notFound(c);
  return render(c, 'shop/product', {
    title: product.name,
    description: product.description.slice(0, 160),
    product,
    available: store.isAvailable(product),
    maxQty: store.maxQuantity(product),
    related: await store.relatedProducts(product),
  });
});

shop.get('/about', (c) => render(c, 'shop/about', { title: 'About' }));

export default shop;
