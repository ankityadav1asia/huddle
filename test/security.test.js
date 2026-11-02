import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { startApp, client, signUp } from './helpers.js';
import { verifyFirebaseIdToken, signInWithFirebase } from '../lib/auth/firebase.js';
import { ensureDemoMatch } from '../lib/match/feed.js';

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });

// ---------------------------------------------------------------- Firebase ID tokens
const PROJECT = 'huddle-test-project';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const keys = async (kid) => (kid === 'kid-1' ? publicKey : null);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

function idToken(claims = {}, { kid = 'kid-1', key = privateKey, alg = 'RS256' } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, sub: 'firebase-uid-1', iat: now - 5, exp: now + 3600, auth_time: now - 5,
    phone_number: '+919812345678', firebase: { sign_in_provider: 'phone', identities: { phone: ['+919812345678'] } }, ...claims,
  };
  const head = b64({ alg, kid, typ: 'JWT' });
  const body = b64(payload);
  return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url')}`;
}

test('a genuine Firebase phone token verifies; forged, foreign or malformed tokens do not', async () => {
  const ok = await verifyFirebaseIdToken(idToken(), { projectId: PROJECT, keys });
  assert.deepEqual([ok.uid, ok.phone], ['firebase-uid-1', '+919812345678']);
  const bad = [
    idToken({}, { key: other.privateKey }), // signed by someone else
    idToken({}, { kid: 'unknown-kid' }),
    idToken({ aud: 'another-project' }),
    idToken({ iss: 'https://securetoken.google.com/another-project' }),
    idToken({ exp: Math.floor(Date.now() / 1000) - 3600 }),
    idToken({ firebase: { sign_in_provider: 'password' } }),
    idToken({ phone_number: undefined }),
    idToken({}, { alg: 'HS256' }),
    'not.a.token', 'x', '',
  ];
  for (const t of bad) await assert.rejects(verifyFirebaseIdToken(t, { projectId: PROJECT, keys }), (e) => e.code === 'invalid_token');
});

test('Firebase sign-in opens a Huddle session only for a fresh +91 phone sign-in', async () => {
  const cfg = { ...app.cfg, otp: { ...app.cfg.otp, provider: 'firebase', firebase: { ...app.cfg.otp.firebase, projectId: PROJECT, apiKey: 'public-web-key', maxAuthAgeSeconds: 600 } } };
  const { user, session } = await signInWithFirebase(app.db, cfg, { idToken: idToken(), ip: '10.0.0.1' }, { keys });
  assert.equal(user.phone_e164, '+919812345678');
  assert.ok(session.token);
  const stored = (await app.db.query('SELECT firebase_uid FROM users WHERE id = $1', [user.id])).rows[0];
  assert.equal(stored.firebase_uid, 'firebase-uid-1');
  const now = Math.floor(Date.now() / 1000);
  await assert.rejects(signInWithFirebase(app.db, cfg, { idToken: idToken({ auth_time: now - 3600 }), ip: '10.0.0.1' }, { keys }), (e) => e.code === 'stale_token');
  await assert.rejects(signInWithFirebase(app.db, cfg, { idToken: idToken({ phone_number: '+14155550100' }), ip: '10.0.0.1' }, { keys }), (e) => e.code === 'phone_not_supported');
  // Sign-in is refused outright when the server is not configured for Firebase.
  await assert.rejects(signInWithFirebase(app.db, app.cfg, { idToken: idToken(), ip: '10.0.0.1' }, { keys }), (e) => e.code === 'otp_unavailable');
});

test('the Firebase endpoint rejects junk and is rate-limited per network', async () => {
  app.cfg.otp.provider = 'firebase';
  app.cfg.otp.firebase.projectId = PROJECT;
  app.cfg.otp.firebase.apiKey = 'public-web-key';
  const c = client(app.base);
  assert.equal((await c.post('/api/auth/firebase', { id_token: 'garbage' })).status, 400);
  assert.equal((await c.post('/api/auth/firebase', { id_token: 'garbage', phone: '9812345678' })).status, 400); // no extra fields
  const cfg = await c.get('/api/config');
  assert.equal(cfg.body.otp.provider, 'firebase');
  assert.deepEqual(Object.keys(cfg.body.otp.firebase).sort(), ['apiKey', 'appId', 'authDomain', 'projectId']);
  assert.equal(cfg.body.otp.demo, false);
  // The server-side OTP endpoints are closed in Firebase mode.
  assert.equal((await c.post('/api/auth/otp/request', { phone: '9812345670' })).status, 400);
  app.cfg.verifyPerIpPerHour = undefined;
  for (let i = 0; i < 40; i++) await c.post('/api/auth/firebase', { id_token: 'garbage' });
  const limited = await c.post('/api/auth/firebase', { id_token: 'garbage' });
  assert.equal(limited.status, 429);
  app.cfg.otp.provider = 'demo';
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
