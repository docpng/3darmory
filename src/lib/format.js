function slugify(text) {
  return String(text)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

const formatters = new Map();

function formatMoney(cents, currency = 'usd') {
  const code = currency.toUpperCase();
  if (!formatters.has(code)) {
    formatters.set(code, new Intl.NumberFormat('en-US', { style: 'currency', currency: code }));
  }
  return formatters.get(code).format((Number(cents) || 0) / 100);
}

/** Parses a user-entered price such as "12.50" or "$12" into integer cents, or null if invalid. */
function parseMoney(input) {
  const cleaned = String(input ?? '').replace(/[^0-9.]/g, '');
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  const [whole, frac = ''] = cleaned.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

function centsToInput(cents) {
  return cents == null ? '' : (cents / 100).toFixed(2);
}

function formatDate(sqliteDate) {
  if (!sqliteDate) return '';
  const d = new Date(sqliteDate.replace(' ', 'T') + 'Z');
  return d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

module.exports = { slugify, formatMoney, parseMoney, centsToInput, formatDate };
