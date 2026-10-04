import views from '../generated/views.js';

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&#34;', "'": '&#39;' };

export function escapeHtml(value) {
  return value == null ? '' : String(value).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

function resolveName(from, target) {
  const parts = from.split('/').slice(0, -1);
  for (const segment of target.replace(/\.ejs$/, '').split('/')) {
    if (segment === '..') parts.pop();
    else if (segment !== '.') parts.push(segment);
  }
  return parts.join('/');
}

/** Renders a precompiled template. `include()` works like EJS: parent locals + extra data. */
export function renderTemplate(name, locals) {
  const template = views[name];
  if (!template) throw new Error(`Template not found: ${name}`);
  const include = (target, data) => renderTemplate(resolveName(name, target), { ...locals, ...data });
  return template(locals, escapeHtml, include);
}

/** Renders a view as the HTTP response, merging in the shared page locals. */
export function render(c, name, locals = {}, status = 200) {
  const html = renderTemplate(name, { ...c.get('locals'), ...locals });
  return c.html(html, status);
}

/** Styled 404 page. Routes return this instead of c.notFound(), which in a sub-router uses Hono's plain default. */
export function notFound(c) {
  if (!c.get('locals')) return c.text('Not found', 404);
  return render(c, 'error', {
    title: 'Not found',
    message: "We couldn't find that page. It may have been moved or sold out.",
  }, 404);
}
