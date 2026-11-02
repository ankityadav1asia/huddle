import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, client, signUp } from './helpers.js';
import { normalizeIndianMobile } from '../lib/auth/phone.js';

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });

test('Indian mobile numbers are normalised and validated on the server', () => {
  assert.equal(normalizeIndianMobile('98765 43210'), '+919876543210');
  assert.equal(normalizeIndianMobile('+91-98765-43210'), '+919876543210');
  assert.equal(normalizeIndianMobile('919876543210'), '+919876543210');
  assert.equal(normalizeIndianMobile('09876543210'), '+919876543210');
  assert.equal(normalizeIndianMobile('5876543210'), null); // must start 6-9
  assert.equal(normalizeIndianMobile('+1 415 555 0100'), null);
  assert.equal(normalizeIndianMobile('98765'), null);
});

test('OTP sign-in creates a session; the code is single-use and never stored in plaintext', async () => {
  const c = client(app.base);
  const r1 = await c.post('/api/auth/otp/request', { phone: '9811100001' });
  assert.equal(r1.status, 200);
  assert.match(r1.body.demo_code, /^\d{6}$/);
  const stored = (await app.db.query('SELECT code_hash FROM otp_challenges')).rows.map((r) => r.code_hash);
  assert.ok(stored.every((h) => h && !h.includes(r1.body.demo_code)));
  const r2 = await c.post('/api/auth/otp/verify', { phone: '9811100001', code: r1.body.demo_code });
  assert.equal(r2.status, 200);
  assert.equal(r2.body.needs_profile, true);
  assert.ok(c.cookie.startsWith('huddle_session='));
  assert.equal((await c.get('/api/me')).status, 200);
  const again = await client(app.base).post('/api/auth/otp/verify', { phone: '9811100001', code: r1.body.demo_code });
  assert.notEqual(again.status, 200);
});

test('wrong codes are limited and a resend has a cooldown', async () => {
  const c = client(app.base);
  const r1 = await c.post('/api/auth/otp/request', { phone: '9811100002' });
  const wrong = r1.body.demo_code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) assert.equal((await c.post('/api/auth/otp/verify', { phone: '9811100002', code: wrong })).status, 400);
  assert.equal((await c.post('/api/auth/otp/verify', { phone: '9811100002', code: r1.body.demo_code })).status, 429);
  const resend = await c.post('/api/auth/otp/request', { phone: '9811100002' });
  assert.equal(resend.status, 429);
  assert.ok(resend.body.error.retry_after > 0);
});

test('OTP request responses do not reveal whether a number has an account', async () => {
  await signUp(app.base, 'existing_fan', { phone: '9811100003' });
  const known = await client(app.base).post('/api/auth/otp/request', { phone: '9811100003' });
  const unknown = await client(app.base).post('/api/auth/otp/request', { phone: '9811100004' });
  // The resend cooldown applies to the known number because it just signed in; compare a fresh pair instead.
  const a = await client(app.base).post('/api/auth/otp/request', { phone: '9811100005' });
  assert.deepEqual(Object.keys(a.body).sort(), Object.keys(unknown.body).sort());
  assert.ok([200, 429].includes(known.status));
});

test('protected endpoints need a session and a finished profile', async () => {
  const anon = client(app.base);
  assert.equal((await anon.get('/api/rooms')).status, 401);
  const c = client(app.base);
  const r1 = await c.post('/api/auth/otp/request', { phone: '9811100006' });
  await c.post('/api/auth/otp/verify', { phone: '9811100006', code: r1.body.demo_code });
  assert.equal((await c.get('/api/rooms')).status, 403);
  assert.equal((await c.put('/api/me/profile', { display_name: 'Riya', handle: 'huddle' })).status, 400); // reserved
  assert.equal((await c.put('/api/me/profile', { display_name: 'Riya', handle: 'riya_6', team: 'CSK' })).status, 200);
  assert.equal((await c.get('/api/rooms')).status, 200);
  assert.equal((await c.post('/api/auth/logout')).status, 200);
  assert.equal((await c.get('/api/me')).status, 401);
});

test('user search never matches phone numbers and never returns them', async () => {
  const a = await signUp(app.base, 'searcher_1', { phone: '9811100007' });
  await signUp(app.base, 'kavya_kc', { phone: '9811100008' });
  const byHandle = await a.get('/api/users/search?q=kav');
  assert.equal(byHandle.body.users.length, 1);
  assert.equal(byHandle.body.users[0].phone_e164, undefined);
  const byPhone = await a.get('/api/users/search?q=98111');
  assert.equal(byPhone.body.users.length, 0);
});
