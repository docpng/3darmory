import { getSignedCookie, setSignedCookie } from 'hono/cookie';

const COOKIE = 'armory';
const MAX_AGE = 30 * 24 * 60 * 60;

/**
 * Cookie-backed session: a small JSON object (cart, CSRF token, admin login, flash message)
 * signed with SESSION_SECRET so it can't be tampered with.
 */
export function sessionMiddleware() {
  return async (c, next) => {
    const config = c.get('config');
    let secret = config.sessionSecret;
    if (!secret) {
      if (!config.isLocal) {
        return c.text('SESSION_SECRET is not configured. Set it with: npx wrangler secret put SESSION_SECRET', 500);
      }
      secret = 'local-development-only-secret';
    }

    let session = {};
    const raw = await getSignedCookie(c, secret, COOKIE);
    if (raw) {
      try {
        session = JSON.parse(raw) || {};
      } catch {
        session = {};
      }
    }
    const before = JSON.stringify(session);
    c.set('session', session);

    await next();

    const after = JSON.stringify(c.get('session'));
    if (after !== before) {
      await setSignedCookie(c, COOKIE, after, secret, {
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
        secure: config.secureCookies,
        maxAge: MAX_AGE,
      });
    }
  };
}

export function randomHex(bytes = 24) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string comparison (compares SHA-256 digests so lengths don't leak). */
export async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(String(a))),
    crypto.subtle.digest('SHA-256', enc.encode(String(b))),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}
