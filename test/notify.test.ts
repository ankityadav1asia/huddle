import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, signUp, makePrivateRoom, type App, type Client } from './helpers.ts';
import { setPushSender } from '../lib/notify/push.ts';
import { queueMomentumPushes } from '../lib/notify/index.ts';
import { pump } from '../lib/jobs/worker.ts';
import { newId } from '../lib/util.ts';

let app: App; let roomId: string; let matchId: string; let viewer: Client; let hidden: Client; let away: Client; const sent: any[] = [];
before(async () => {
  app = await startApp();
  setPushSender(async (sub, payload) => { sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) }); });
  const owner = await signUp(app.base, 'n_owner');
  viewer = await signUp(app.base, 'n_viewer');
  hidden = await signUp(app.base, 'n_hidden');
  away = await signUp(app.base, 'n_away');
  await owner.get('/api/rooms');
  roomId = await makePrivateRoom(app, owner, [viewer, hidden, away]);
  matchId = (await app.db.query('SELECT match_id FROM rooms WHERE id = $1', [roomId])).rows[0].match_id;
  await app.db.query(`UPDATE matches SET feed_started_at = now() + interval '1 hour'`); // keep the real feed still
  for (const c of [viewer, hidden, away]) {
    await c.post('/api/me/push-subscriptions', { endpoint: `https://push.example.test/${c.user.handle}`, keys: { p256dh: 'p'.repeat(40), auth: 'a'.repeat(16) } });
  }
  await owner.put('/api/me/notifications', { push_momentum: false });
});
after(async () => { await app.close(); });

let seq = 1000;
async function signal(priority: string, trigger = 'wicket_fallen') {
  seq += 1;
  const ev = newId('mev');
  await app.db.query(
    `INSERT INTO match_events (id, match_id, provider_event_id, seq, kind, data, occurred_at) VALUES ($1, $2, $3, $4, 'ball', '{}'::jsonb, now())`,
    [ev, matchId, `test:${seq}`, seq]);
  const s = { id: newId('sig'), match_id: matchId, priority, trigger };
  await app.db.query(
    `INSERT INTO match_signals (id, match_id, event_id, trigger, priority, label, evidence, fact_text, dedupe_key, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'Big wicket', '{}'::jsonb, 'WICKET: test fact. CSK 150/3 (16.1).', $6, 'published', now() + interval '3 minutes')`,
    [s.id, matchId, ev, trigger, priority, `test:${s.id}`]);
  return s;
}

const recipients = () => sent.map((s) => s.endpoint.split('/').pop());

test('members watching the room get the in-app alert only; hidden-tab and away members get a notification', async () => {
  await viewer.get(`/api/rooms/${roomId}/events?after=0&vis=visible`);
  await hidden.get(`/api/rooms/${roomId}/events?after=0&vis=hidden`);
  await queueMomentumPushes(app.db, await signal('high'));
  await pump(app.db, { budgetMs: 3000 });
  assert.deepEqual(recipients().sort(), ['n_away', 'n_hidden']);
  assert.match(sent[0].payload.title, /Big wicket/);
});

test('routine moments are never sent as notifications, and alerts are spaced out', async () => {
  sent.length = 0;
  await queueMomentumPushes(app.db, await signal('low', 'boundary_burst'));
  await queueMomentumPushes(app.db, await signal('high')); // right after the previous one: inside the minimum gap
  await pump(app.db, { budgetMs: 3000 });
  assert.equal(sent.length, 0);
});

test('at most MATCH_ALERTS_PER_USER per person per match, with the last slot kept for the result', async () => {
  app.cfg.notify.minGapSeconds = 0;
  for (let i = 0; i < 12; i++) await queueMomentumPushes(app.db, await signal(i % 2 ? 'medium' : 'high', i % 2 ? 'dropped_catch' : 'wicket_fallen'));
  const perUser = async (handle: string) => (await app.db.query(
    `SELECT count(*)::int AS n FROM notification_deliveries d JOIN users u ON u.id = d.recipient_id WHERE u.handle = $1 AND d.kind = 'momentum'`, [handle])).rows[0].n;
  assert.equal(await perUser('n_away'), app.cfg.notify.maxPerMatch - 1);
  await queueMomentumPushes(app.db, await signal('high', 'match_result_confirmed'));
  assert.equal(await perUser('n_away'), app.cfg.notify.maxPerMatch);
  await queueMomentumPushes(app.db, await signal('high'));
  assert.equal(await perUser('n_away'), app.cfg.notify.maxPerMatch);
  assert.equal(await perUser('n_viewer'), 0);
  assert.equal(await perUser('n_owner'), 0); // preference off
  assert.equal(app.cfg.notify.maxPerMatch, 8);
});
