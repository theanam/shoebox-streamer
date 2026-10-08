// Optional password protection for the web interface.
//
// Passwords are stored as scrypt hashes. A signed-in browser gets an HttpOnly cookie; players that
// can't sign in (VLC, the iPhone's native video player) get a "media key" in the URL instead. Both are
// HMAC-signed with a key derived from the password hash, so they keep working across restarts until
// the password changes. A session password (`shoebox --password`) uses a random key instead, so
// every sign-in ends when Shoebox stops.

import crypto from 'node:crypto';

const COOKIE = 'shoebox_auth';
const DAY = 86400_000;
const WEB_TTL = 30 * DAY;
const MEDIA_TTL = 30 * DAY;
const SCRYPT = { N: 16384, r: 8, p: 1 };

const b64url = (buf) => Buffer.from(buf).toString('base64url');

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${b64url(salt)}$${b64url(key)}`;
}

export function verifyPassword(password, stored) {
  const [kind, n, salt, key] = String(stored || '').split('$');
  if (kind !== 'scrypt' || !salt || !key) return false;
  const want = Buffer.from(key, 'base64url');
  const got = crypto.scryptSync(String(password), Buffer.from(salt, 'base64url'), want.length, { ...SCRYPT, N: Number(n) || SCRYPT.N });
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

export const isPasswordHash = (s) => /^scrypt\$\d+\$[\w-]+\$[\w-]+$/.test(String(s || ''));

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export class Auth {
  /**
   * @param {{ passwordHash?: string, session?: boolean }} opts  no hash → auth disabled
   */
  constructor({ passwordHash = '', session = false } = {}) {
    this.hash = passwordHash;
    this.session = session;
    this.key = session
      ? crypto.randomBytes(32)
      : crypto.createHash('sha256').update('shoebox-auth-v1:' + passwordHash).digest();
    this.failures = new Map(); // ip → { count, until }
  }

  get enabled() {
    return !!this.hash;
  }

  sign(scope, ttl) {
    const exp = Date.now() + ttl;
    const mac = crypto.createHmac('sha256', this.key).update(`${scope}.${exp}`).digest('base64url');
    return `${scope}.${exp}.${mac}`;
  }

  verifyToken(token, scope) {
    const [s, exp, mac] = String(token || '').split('.');
    if (s !== scope || !exp || !mac || Number(exp) < Date.now()) return false;
    const want = crypto.createHmac('sha256', this.key).update(`${s}.${exp}`).digest();
    const got = Buffer.from(mac, 'base64url');
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  }

  /** Signed in via cookie, or carrying a valid media key (?k=) for media URLs. */
  check(req, url) {
    if (!this.enabled) return true;
    if (this.verifyToken(parseCookies(req.headers.cookie)[COOKIE], 'web')) return true;
    const k = url.searchParams.get('k');
    return !!k && this.verifyToken(k, 'media');
  }

  mediaKey() {
    return this.enabled ? this.sign('media', MEDIA_TTL) : null;
  }

  /** Append the media key to a same-server URL (no-op when auth is off). */
  withKey(path, key = this.mediaKey()) {
    if (!key) return path;
    return `${path}${path.includes('?') ? '&' : '?'}k=${encodeURIComponent(key)}`;
  }

  /** @returns {{ ok: true, cookie: string } | { ok: false, retryAfter?: number }} */
  login(ip, password) {
    const now = Date.now();
    const f = this.failures.get(ip);
    if (f?.until > now) return { ok: false, retryAfter: Math.ceil((f.until - now) / 1000) };
    if (verifyPassword(password, this.hash)) {
      this.failures.delete(ip);
      const token = this.sign('web', WEB_TTL);
      // A session password's sign-in should end with the browser session too.
      const age = this.session ? '' : `; Max-Age=${WEB_TTL / 1000}`;
      return { ok: true, cookie: `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${age}` };
    }
    // After 5 wrong guesses, each further one locks this address out for longer (up to 5 minutes).
    const count = (f?.count || 0) + 1;
    const lock = count >= 5 ? Math.min(300, 2 ** (count - 5) * 15) * 1000 : 0;
    this.failures.set(ip, { count, until: now + lock });
    return { ok: false, retryAfter: lock ? lock / 1000 : undefined };
  }

  logoutCookie() {
    return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  }
}
