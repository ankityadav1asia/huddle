import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, client, signUp } from './helpers.js';
import { ensureDemoMatch } from '../lib/match/feed.js';
import { messageCentralProvider, setOtpFetch } from '../lib/auth/otp-providers.js';

let app;
before(async () => { app = await startApp(); });
after(async () => { setOtpFetch(null); await app.close(); });

// ---------------------------------------------------------------- a fake Message Central VerifyNow API
const GOOD_CODE = '424242';
function fakeMessageCentral({ sendCode = 200, down = false, rejectFirstToken = false } = {}) {
  const state = { tokens: 0, sends: [], checks: [], issued: new Map(), keys: [] };
  let tokenRejected = !rejectFirstToken;
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, opts = {}) => {
    if (down) throw new TypeError('fetch failed');
    const u = new URL(url);
    if (u.pathname === '/auth/v1/authentication/token') {
      state.tokens += 1;
      state.keys.push(u.searchParams.get('key'));
      return json(200, { status: 200, token: `tok-${state.tokens}` });
    }
    if (!tokenRejected && opts.headers?.authToken === 'tok-1') {
      tokenRejected = true;
      return json(401, { responseCode: 401, message: 'UNAUTHORIZED' });
    }
    if (u.pathname === '/verification/v3/send') {
      state.sends.push(Object.fromEntries(u.searchParams));
      if (sendCode !== 200) return json(400, { responseCode: sendCode, message: 'ERR', data: null });
      const id = String(1000 + state.sends.length);
      state.issued.set(id, { at: Date.now() });
      return json(200, { responseCode: 200, message: 'SUCCESS', data: { verificationId: id, mobileNumber: u.searchParams.get('mobileNumber'), timeout: '60' } });
    }
    if (u.pathname === '/verification/v3/validateOtp') {
      state.checks.push(Object.fromEntries(u.searchParams));
      const id = u.searchParams.get('verificationId');
      if (!state.issued.has(id)) return json(400, { responseCode: 505, message: 'INVALID_VERIFICATION_ID', data: null });
      if (u.searchParams.get('code') === 'expire') return json(400, { responseCode: 705, message: 'VERIFICATION_EXPIRED', data: null });
      if (u.searchParams.get('code') !== GOOD_CODE) return json(400, { responseCode: 702, message: 'WRONG_OTP_PROVIDED', data: null });
      return json(200, { responseCode: 200, message: 'SUCCESS', data: { verificationStatus: 'VERIFICATION_COMPLETED' } });
    }
    return json(404, {});
  };
  return { fetchImpl, state };
}

const MC = { customerId: 'C-TEST', password: 'test-password-not-real' };

test('the Message Central adapter sends and checks codes through VerifyNow', async () => {
  const { fetchImpl, state } = fakeMessageCentral({ rejectFirstToken: true });
  const p = messageCentralProvider(MC, fetchImpl);
  const started = await p.start('+919812300010');
  assert.equal(started.providerRef, '1001');
  assert.equal(started.codeHash, undefined); // Huddle never sees or stores the code
  assert.deepEqual(state.sends[0], { countryCode: '91', customerId: 'C-TEST', flowType: 'SMS', mobileNumber: '9812300010', otpLength: '6' });
  assert.equal(state.keys[0], Buffer.from(MC.password).toString('base64'));
  assert.equal(state.tokens, 2); // the rejected token was refreshed once
  assert.equal(await p.check('+919812300010', GOOD_CODE, { provider_ref: '1001' }), true);
  assert.equal(await p.check('+919812300010', '000000', { provider_ref: '1001' }), false);
  await assert.rejects(p.check('+919812300010', 'expire', { provider_ref: '1001' }), (e) => e.code === 'otp_expired');
  assert.equal(await p.check('+919812300010', GOOD_CODE, { provider_ref: null }), false);
  assert.equal(state.tokens, 2); // the token is reused between calls
});

test('Message Central limits and outages surface as clear, safe errors', async () => {
  for (const code of [506, 800]) {
    const p = messageCentralProvider(MC, fakeMessageCentral({ sendCode: code }).fetchImpl);
    await assert.rejects(p.start('+919812300011'), (e) => e.status === 429);
  }
  const down = messageCentralProvider(MC, fakeMessageCentral({ down: true }).fetchImpl);
  await assert.rejects(down.start('+919812300011'), (e) => e.status === 503 && !/test-password/.test(e.message));
});

test('production sign-in through Message Central: real code flow, no demo code, nothing stored in plaintext', async () => {
  const { fetchImpl, state } = fakeMessageCentral();
  setOtpFetch(fetchImpl);
  Object.assign(app.cfg.otp, { provider: 'messagecentral', demoAllowed: false, messageCentral: { ...MC, email: '' } });
  const c = client(app.base);
  assert.equal((await c.get('/api/config')).body.otp.provider, 'messagecentral');
  const r = await c.post('/api/auth/otp/request', { phone: '98123 00012' });
  assert.equal(r.status, 200);
  assert.equal(r.body.demo_code, undefined);
  assert.equal(r.body.provider, 'messagecentral');
  const row = (await app.db.query(`SELECT code_hash, provider_ref, provider FROM otp_challenges ORDER BY created_at DESC LIMIT 1`)).rows[0];
  assert.deepEqual(row, { code_hash: null, provider_ref: String(1000 + state.sends.length), provider: 'messagecentral' });
  const wrong = await c.post('/api/auth/otp/verify', { phone: '9812300012', code: '111111' });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error.code, 'wrong_code');
  const ok = await c.post('/api/auth/otp/verify', { phone: '9812300012', code: GOOD_CODE });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.needs_profile, true);
  assert.equal((await c.get('/api/me')).status, 200);
  assert.equal((await c.post('/api/auth/otp/verify', { phone: '9812300012', code: GOOD_CODE })).status, 400); // single use
  // Not configured (no credentials) means sign-in stays closed, never demo.
  app.cfg.otp.messageCentral = { customerId: '', password: '', email: '' };
  assert.equal((await c.get('/api/config')).body.otp.provider, 'unavailable');
  assert.equal((await client(app.base).post('/api/auth/otp/request', { phone: '9812300013' })).status, 503);
  Object.assign(app.cfg.otp, { provider: 'demo', demoAllowed: true });
  setOtpFetch(null);
});

test('production never offers the demo sign-in and fails closed without a server secret', async () => {
  app.cfg.otp.demoAllowed = false;
  const c = client(app.base);
  const cfg = await c.get('/api/config');
  assert.equal(cfg.body.otp.provider, 'unavailable');
  assert.equal(cfg.body.otp.demo, false);
  const r = await c.post('/api/auth/otp/request', { phone: '9812300001' });
  assert.equal(r.status, 503);
  assert.equal(r.body.demo_code, undefined);
  assert.equal((await c.post('/api/auth/otp/verify', { phone: '9812300001', code: '123456' })).status, 503);
  app.cfg.otp.demoAllowed = true;
  const secret = app.cfg.secret;
  app.cfg.secret = '';
  assert.equal((await c.post('/api/auth/otp/request', { phone: '9812300002' })).status, 503);
  assert.equal((await c.get('/api/config')).body.otp.provider, 'unavailable');
  app.cfg.secret = secret;
});

test('wrong codes are limited per number across codes, not just per code', async () => {
  const c = client(app.base);
  const phone = '9812300003';
  for (let round = 0; round < 2; round++) {
    const r = await c.post('/api/auth/otp/request', { phone });
    assert.equal(r.status, 200);
    const wrong = r.body.demo_code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) await c.post('/api/auth/otp/verify', { phone, code: wrong });
    await app.db.query(`UPDATE otp_challenges SET created_at = created_at - interval '31 seconds'`); // pass the resend wait
  }
  const r3 = await c.post('/api/auth/otp/request', { phone });
  const v = await c.post('/api/auth/otp/verify', { phone, code: r3.body.demo_code });
  assert.equal(v.status, 429); // even the right code is refused for the rest of the hour
});

test('"sign out on all devices" revokes every session', async () => {
  const a = await signUp(app.base, 'multi_device');
  const second = client(app.base);
  const otp = await second.post('/api/auth/otp/request', { phone: a.phone });
  if (otp.status === 200) await second.post('/api/auth/otp/verify', { phone: a.phone, code: otp.body.demo_code });
  assert.equal((await a.post('/api/auth/logout-all')).status, 200);
  assert.equal((await a.get('/api/me')).status, 401);
  assert.equal((await second.get('/api/me')).status, 401);
});

test('public watch parties hold at most PUBLIC_ROOM_MAX_MEMBERS, and finished matches are not offered', async () => {
  app.cfg.rooms.publicMaxMembers = 2;
  const [x, y, z] = await Promise.all(['cap_x', 'cap_y', 'cap_z'].map((h) => signUp(app.base, h)));
  const pub = (await x.get('/api/rooms')).body.public_rooms[0];
  assert.equal(pub.max_members, 2);
  assert.equal((await x.post(`/api/rooms/${pub.id}/join`)).status, 200);
  assert.equal((await y.post(`/api/rooms/${pub.id}/join`)).status, 200);
  const third = await z.post(`/api/rooms/${pub.id}/join`);
  assert.equal(third.status, 409);
  assert.equal(third.body.error.code, 'room_full');
  assert.equal((await z.get('/api/rooms')).body.public_rooms.find((r) => r.id === pub.id).full, true);
  assert.equal((await x.post(`/api/rooms/${pub.id}/join`)).status, 200); // members can come back
  app.cfg.rooms.publicMaxMembers = 100;

  await app.db.query(`UPDATE matches SET status = 'completed' WHERE id = $1`, [pub.match_id]);
  await ensureDemoMatch(app.db);
  const listed = (await x.get('/api/rooms')).body.public_rooms;
  assert.equal(listed.length, 1);
  assert.notEqual(listed[0].id, pub.id);
});
