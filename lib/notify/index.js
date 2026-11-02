// Notifications: invitations and important match moments. In-app delivery is the room feed itself (plus the
// home screen's invitation list); browser push is optional, per user preference and browser permission, and only
// for away members. Push payloads are generic and minimal, rebuilt from verified data at send time, and expire
// fast. Huddle keeps no notification inbox and never writes a notification into the chat table: only
// delivery metadata (ids, status, timestamps) is stored, and it is deleted after DELIVERY_RETENTION_HOURS.
import { config } from '../config.js';
import { one, many } from '../db/index.js';
import { newId, badRequest, onlyKeys } from '../util.js';
import { enqueue } from '../jobs/queue.js';
import { log } from '../log.js';
import { pushAvailable, sendPush } from './push.js';

const AWAY_SECONDS = 45;

async function queueDelivery(q, { dedupeKey, recipientId, roomId, kind, refId, priority, ttlSeconds }) {
  const row = await one(q,
    `INSERT INTO notification_deliveries (id, dedupe_key, recipient_id, room_id, kind, ref_id, priority, channel, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'push', 'queued', now() + make_interval(secs => $8))
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [newId('ntf'), dedupeKey, recipientId, roomId, kind, refId, priority, ttlSeconds]);
  if (row) await enqueue(q, { type: 'push_delivery', dedupeKey: `push:${row.id}`, payload: { delivery_id: row.id }, priority: 2, expiresInSeconds: ttlSeconds, maxAttempts: 3 });
  return Boolean(row);
}

// "Actively viewing" = this room is open in a visible tab right now. Hidden tabs and closed tabs count as not
// looking, so those members get the notification; people watching the room already see the in-app alert.
const ACTIVELY_VIEWING = `EXISTS (SELECT 1 FROM room_presence p WHERE p.room_id = r.id AND p.user_id = m.user_id
                          AND p.state = 'active' AND p.last_seen_at > now() - make_interval(secs => ${AWAY_SECONDS}))`;

// Big match moments (high and medium priority) become notifications for opted-in members who are not looking,
// at most MATCH_ALERTS_PER_USER per person per match (default 8), spaced at least MATCH_ALERT_MIN_GAP_SECONDS
// apart. The last slot is kept for the result. Deduped per signal and person, so retries never double up.
// A private room's own replay counts every run from the last 12 hours as one match, so restarting it cannot
// reset the cap.
export async function queueMomentumPushes(db, signal) {
  const n = config().notify;
  if (!pushAvailable() || !n.priorities.includes(signal.priority)) return 0;
  const isResult = signal.trigger === 'match_result_confirmed';
  const replayRoom = (await one(db, 'SELECT room_id FROM matches WHERE id = $1', [signal.match_id]))?.room_id ?? null;
  const recipients = await many(db,
    `SELECT DISTINCT ON (m.user_id) m.user_id, r.id AS room_id
       FROM room_members m
       JOIN rooms r ON r.id = m.room_id
       JOIN notification_prefs np ON np.user_id = m.user_id AND np.push_momentum
      WHERE r.match_id = $1 AND r.status = 'active' AND m.status = 'active'
        AND EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.user_id = m.user_id)
        AND NOT ${ACTIVELY_VIEWING}
      ORDER BY m.user_id, r.created_at`,
    [signal.match_id]);
  let queued = 0;
  for (const r of recipients) {
    const ok = await db.tx(async (q) => {
      await q.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`notify:${r.user_id}`]);
      const used = await one(q,
        `SELECT count(*)::int AS n,
                COALESCE(EXTRACT(EPOCH FROM (now() - max(d.created_at))), 1e9)::float8 AS since_last
           FROM notification_deliveries d JOIN match_signals s ON s.id = d.ref_id JOIN matches mt ON mt.id = s.match_id
          WHERE d.recipient_id = $1 AND d.kind = 'momentum' AND d.status IN ('queued', 'sent')
            AND (s.match_id = $2 OR (mt.room_id = $3::text AND d.created_at > now() - interval '12 hours'))`,
        [r.user_id, signal.match_id, replayRoom]);
      const allowance = isResult ? n.maxPerMatch : n.maxPerMatch - 1;
      if (used.n >= allowance) return false;
      if (!isResult && used.since_last < n.minGapSeconds) return false;
      return queueDelivery(q, { dedupeKey: `momentum:${signal.id}:${r.user_id}`, recipientId: r.user_id, roomId: r.room_id, kind: 'momentum', refId: signal.id, priority: signal.priority, ttlSeconds: config().push.ttlSeconds });
    });
    if (ok) queued += 1;
  }
  return queued;
}

// Medium priority: only for members who explicitly opted in to answer alerts and are not looking at the room.
export async function queueAnswerPush(db, { roomId, userId, messageId }) {
  if (!pushAvailable()) return;
  const eligible = await one(db,
    `SELECT 1 FROM notification_prefs np WHERE np.user_id = $1 AND np.push_answers
        AND EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.user_id = $1)
        AND NOT EXISTS (SELECT 1 FROM room_presence p WHERE p.room_id = $2 AND p.user_id = $1 AND p.state = 'active'
                         AND p.last_seen_at > now() - make_interval(secs => $3))`,
    [userId, roomId, AWAY_SECONDS]);
  if (eligible) await queueDelivery(db, { dedupeKey: `answer:${messageId}`, recipientId: userId, roomId, kind: 'answer', refId: messageId, priority: 'medium', ttlSeconds: 600 });
}

export async function handleInviteJob(db, job) {
  const inv = await one(db,
    `SELECT i.id, i.invitee_id, i.room_id FROM room_invitations i JOIN rooms r ON r.id = i.room_id
      WHERE i.id = $1 AND i.status = 'pending' AND i.expires_at > now() AND r.status = 'active'`, [job.payload.invitation_id]);
  if (!inv || !pushAvailable()) return 'skipped';
  const ok = await one(db,
    `SELECT 1 FROM notification_prefs np WHERE np.user_id = $1 AND np.push_invites AND EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.user_id = $1)`, [inv.invitee_id]);
  if (!ok) return 'skipped';
  await queueDelivery(db, { dedupeKey: `invite:${inv.id}`, recipientId: inv.invitee_id, roomId: inv.room_id, kind: 'invite', refId: inv.id, priority: 'medium', ttlSeconds: 3600 });
  return 'queued';
}

async function skip(db, id, status, reason) {
  await db.query(`UPDATE notification_deliveries SET status = $2, skip_reason = $3 WHERE id = $1 AND status = 'queued'`, [id, status, reason]);
  return reason;
}

// Final checks happen immediately before sending: room still active, still a member, preference still on,
// event not expired, and (for room alerts) still away. A failed push never affects the watch party.
export async function handlePushDelivery(db, job) {
  const d = await one(db, `SELECT *, expires_at <= now() AS expired FROM notification_deliveries WHERE id = $1`, [job.payload.delivery_id]);
  if (!d || d.status !== 'queued') return 'done';
  if (d.expired) return skip(db, d.id, 'expired', 'expired');
  const pref = { momentum: 'push_momentum', answer: 'push_answers', invite: 'push_invites' }[d.kind];
  const prefs = await one(db, `SELECT ${pref} AS enabled FROM notification_prefs WHERE user_id = $1`, [d.recipient_id]);
  if (!prefs?.enabled) return skip(db, d.id, 'skipped', 'preference_off');
  let payload;
  if (d.kind === 'invite') {
    const inv = await one(db, `SELECT i.id FROM room_invitations i JOIN rooms r ON r.id = i.room_id WHERE i.id = $1 AND i.status = 'pending' AND i.expires_at > now() AND r.status = 'active'`, [d.ref_id]);
    if (!inv) return skip(db, d.id, 'skipped', 'invitation_closed');
    payload = { title: 'Huddle', body: 'You have a new watch party invitation.', url: '/#/home', tag: 'huddle-invite' };
  } else {
    const member = await one(db,
      `SELECT r.status AS room_status, m.status AS member_status, ${ACTIVELY_VIEWING} AS viewing
         FROM rooms r JOIN room_members m ON m.room_id = r.id AND m.user_id = $2 WHERE r.id = $1`,
      [d.room_id, d.recipient_id]);
    if (!member || member.room_status !== 'active' || member.member_status !== 'active') return skip(db, d.id, 'skipped', 'not_eligible');
    if (member.viewing) return skip(db, d.id, 'skipped', 'already_in_room');
    if (d.kind === 'momentum') {
      const s = await one(db, `SELECT label, fact_text, expires_at > now() AS live FROM match_signals WHERE id = $1 AND status = 'published'`, [d.ref_id]);
      if (!s?.live) return skip(db, d.id, 'expired', 'signal_expired');
      // Verified match facts only; no room name, no chat text on the lock screen.
      payload = { title: `Huddle · ${s.label}`, body: `${s.fact_text.slice(0, 110)} Come back to the watch party.`, url: `/#/room/${d.room_id}`, tag: `huddle-${d.room_id}` };
    } else {
      payload = { title: 'Huddle', body: 'Your question in the watch party has an answer.', url: `/#/room/${d.room_id}`, tag: `huddle-${d.room_id}` };
    }
  }
  const subs = await many(db, 'SELECT * FROM push_subscriptions WHERE user_id = $1', [d.recipient_id]);
  if (!subs.length) return skip(db, d.id, 'skipped', 'no_subscription');
  let sent = 0;
  let transient = false;
  for (const s of subs) {
    const r = await sendPush(s, payload, { ttlSeconds: config().push.ttlSeconds, urgency: d.priority === 'high' ? 'high' : 'normal' });
    if (r.ok) {
      sent += 1;
      await db.query('UPDATE push_subscriptions SET last_success_at = now(), failure_count = 0 WHERE id = $1', [s.id]);
    } else if (r.gone) {
      await db.query('DELETE FROM push_subscriptions WHERE id = $1', [s.id]);
    } else {
      transient = true;
      await db.query('UPDATE push_subscriptions SET failure_count = failure_count + 1 WHERE id = $1', [s.id]);
    }
  }
  if (sent) {
    await db.query(`UPDATE notification_deliveries SET status = 'sent', sent_at = now() WHERE id = $1`, [d.id]);
    return 'sent';
  }
  if (transient) throw Object.assign(new Error('push failed'), { category: 'push_failed' });
  return skip(db, d.id, 'failed', 'no_valid_subscription');
}

export async function getPrefs(db, user) {
  await db.query('INSERT INTO notification_prefs (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [user.id]);
  const prefs = await one(db, 'SELECT push_momentum, push_answers, push_invites FROM notification_prefs WHERE user_id = $1', [user.id]);
  const subs = await one(db, 'SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id = $1', [user.id]);
  return { ...prefs, push_subscribed: subs.n > 0, push_available: pushAvailable(), vapid_public_key: pushAvailable() ? config().push.publicKey : null };
}

export async function setPrefs(db, user, body) {
  onlyKeys(body, ['push_momentum', 'push_answers', 'push_invites']);
  for (const [k, v] of Object.entries(body)) if (typeof v !== 'boolean') throw badRequest(`${k} must be true or false.`);
  await db.query('INSERT INTO notification_prefs (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [user.id]);
  await db.query(
    `UPDATE notification_prefs SET push_momentum = COALESCE($2, push_momentum), push_answers = COALESCE($3, push_answers),
            push_invites = COALESCE($4, push_invites), updated_at = now() WHERE user_id = $1`,
    [user.id, body.push_momentum ?? null, body.push_answers ?? null, body.push_invites ?? null]);
  return getPrefs(db, user);
}

export async function saveSubscription(db, user, body) {
  onlyKeys(body, ['endpoint', 'keys', 'expirationTime']);
  const endpoint = typeof body.endpoint === 'string' ? body.endpoint : '';
  let host = '';
  try {
    const u = new URL(endpoint);
    host = u.protocol === 'https:' ? u.hostname : '';
  } catch { /* invalid */ }
  if (!host || endpoint.length > 1000) throw badRequest('That push subscription is not valid.');
  const { p256dh, auth } = body.keys || {};
  if (typeof p256dh !== 'string' || typeof auth !== 'string' || p256dh.length > 200 || auth.length > 100) throw badRequest('That push subscription is not valid.');
  const count = await one(db, 'SELECT count(*)::int AS n FROM push_subscriptions WHERE user_id = $1', [user.id]);
  if (count.n >= 5) await db.query('DELETE FROM push_subscriptions WHERE id = (SELECT id FROM push_subscriptions WHERE user_id = $1 ORDER BY created_at LIMIT 1)', [user.id]);
  await db.query(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, failure_count = 0`,
    [newId('psub'), user.id, endpoint, p256dh, auth]);
  log.info('push.subscribed', { user: user.id, host });
  return getPrefs(db, user);
}

export async function removeSubscriptions(db, user) {
  await db.query('DELETE FROM push_subscriptions WHERE user_id = $1', [user.id]);
  return getPrefs(db, user);
}
