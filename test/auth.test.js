import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Auth, hashPassword, verifyPassword, isPasswordHash } from '../src/auth.js';

const req = (cookie) => ({ headers: cookie ? { cookie } : {} });
const url = (q = '') => new URL('http://x/media/abc' + q);

test('password hashing', () => {
  const h = hashPassword('treadmill');
  assert.ok(isPasswordHash(h));
  assert.ok(verifyPassword('treadmill', h));
  assert.ok(!verifyPassword('Treadmill', h));
  assert.notEqual(hashPassword('treadmill'), h, 'salted');
});

test('disabled auth lets everything through', () => {
  const a = new Auth();
  assert.equal(a.enabled, false);
  assert.ok(a.check(req(), url()));
  assert.equal(a.mediaKey(), null);
  assert.equal(a.withKey('/media/x'), '/media/x');
});

test('login sets a cookie that grants access; media keys only work as ?k=', () => {
  const a = new Auth({ passwordHash: hashPassword('pw') });
  assert.ok(!a.check(req(), url()));
  assert.equal(a.login('1.1.1.1', 'nope').ok, false);
  const r = a.login('1.1.1.1', 'pw');
  assert.ok(r.ok);
  const cookie = r.cookie.split(';')[0];
  assert.ok(a.check(req(cookie), url()));
  assert.ok(/Max-Age=/.test(r.cookie), 'persists for a settings password');
  const k = a.mediaKey();
  assert.ok(a.check(req(), url('?k=' + encodeURIComponent(k))));
  assert.ok(!a.check(req('shoebox_auth=' + encodeURIComponent(k)), url()), 'media key is not a web cookie');
  assert.ok(!a.check(req(), url('?k=media.9999999999999.forged')));
});

test('settings password tokens survive a restart; session tokens do not', () => {
  const h = hashPassword('pw');
  const cookie = new Auth({ passwordHash: h }).login('ip', 'pw').cookie.split(';')[0];
  assert.ok(new Auth({ passwordHash: h }).check(req(cookie), url()), 'same password → still signed in');
  assert.ok(!new Auth({ passwordHash: hashPassword('other') }).check(req(cookie), url()), 'changed password → signed out');
  const s1 = new Auth({ passwordHash: h, session: true });
  const sc = s1.login('ip', 'pw');
  assert.ok(!/Max-Age=/.test(sc.cookie), 'session cookie ends with the browser');
  assert.ok(!new Auth({ passwordHash: h, session: true }).check(req(sc.cookie.split(';')[0]), url()), 'new session → signed out');
});

test('repeated wrong passwords lock the address out', () => {
  const a = new Auth({ passwordHash: hashPassword('pw') });
  for (let i = 0; i < 4; i++) assert.equal(a.login('9.9.9.9', 'x').retryAfter, undefined);
  assert.ok(a.login('9.9.9.9', 'x').retryAfter > 0);
  const locked = a.login('9.9.9.9', 'pw');
  assert.equal(locked.ok, false, 'even the right password waits out the lock');
  assert.ok(locked.retryAfter > 0);
  assert.ok(a.login('8.8.8.8', 'pw').ok, 'other devices are unaffected');
});
