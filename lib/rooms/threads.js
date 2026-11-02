// Moment threads: #topics inside a room, as in the original demo. The match opens one in every room following it for
// each big moment (a wicket, the bowling change, the DRS call, a dropped catch, the last over, the result), and a
// room opens one when three or more messages from at least two people argue about the same topic. A message joins a
// thread when it is sent from it, mentions its topic, or follows a big moment within seconds; every message still
// shows in "All chat". Deterministic: no AI involved.
import { one, many } from '../db/index.js';
import { badRequest, newId } from '../util.js';
import { appendEvent, RoomEndedError } from './events.js';
import { shortName } from '../match/demo-script.js';

const slugify = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
const FRESH_SECONDS = 30; // chat this soon after a big moment is about it
const DISCUSSION = { messages: 3, people: 2, minutes: 10 };

// Topics people argue about, in Hinglish and English (from the original demo). The first match wins.
export const TOPICS = [
  { slug: 'dropped-catch', keywords: ['chhod', 'drop', 'sitter', 'catches win', 'lifeline', 'butter', 'bach gaya', 'chhoot'] },
  { slug: 'drs-call', keywords: ['drs', 'review', 'umpire', 'lbw', 'ball tracking', 'plumb', 'leg ke bahar', 'going down', 'hitting'] },
  { slug: 'last-over', keywords: ['last over', 'final over', 'off 6', 'ek boundary', 'saans', 'wide yorker', 'nerves'] },
  { slug: 'bowling-change', keywords: ['bowling change', 'part-timer', 'part timer', 'bumrah kahan', 'bumrah kyun', 'masterstroke',
    'golden arm', 'tilak ko', 'kisne bola', 'hardik ko'] },
];
const topicKeywords = (slug) => TOPICS.find((t) => t.slug === slug)?.keywords || [];
export const topicFor = (text) => {
  const t = text.toLowerCase();
  return TOPICS.find((topic) => topic.keywords.some((k) => t.includes(k))) || null;
};

// The thread a feed item opens, if any. Built on ordinary cricket events (wicket, drop, bowling change, review, last
// over, result), so a real data feed would open the same threads.
export function threadForItem(item) {
  if (item.wicket) {
    const who = shortName(item.wicket.out);
    return { slug: `${slugify(who)}-out`, about: `${item.wicket.out} out, ${item.wicket.how}.`, keywords: [who.toLowerCase()] };
  }
  if (item.drop) return { slug: 'dropped-catch', about: `${item.drop.by} drops ${item.bat}.`, keywords: topicKeywords('dropped-catch') };
  if (item.moment === 'drs' || (item.kind === 'event' && item.type === 'review')) {
    return { slug: 'drs-call', about: item.text, keywords: topicKeywords('drs-call') };
  }
  if (item.kind !== 'event') return null;
  if (item.type === 'bowling_change') return { slug: 'bowling-change', about: item.text, keywords: topicKeywords('bowling-change') };
  if (item.type === 'last_over') return { slug: 'last-over', about: item.text, keywords: topicKeywords('last-over') };
  if (item.type === 'result') return { slug: 'result', about: item.text, keywords: ['won', 'win', 'jeet', 'champion'] };
  return null;
}

async function openThread(q, roomId, { slug, about, keywords, source }) {
  const row = await one(q,
    `INSERT INTO room_threads (id, room_id, slug, title, about, keywords, source) VALUES ($1, $2, $3, $4, $5, $6::text[], $7)
     ON CONFLICT (room_id, slug) DO UPDATE SET last_active_at = now()
     RETURNING id, (xmax = 0) AS created`,
    [newId('thr'), roomId, slug, `#${slug}`, about, keywords, source]);
  if (row.created) await appendEvent(q, roomId, 'thread', row.id);
  return row;
}

// Called by feed ingestion (inside its transaction) for the big moments that just happened. Skipped balls (a jump)
// open nothing, like they alert nobody.
export async function openMomentThreads(q, matchId, opened) {
  if (!opened.length) return;
  const rooms = await many(q, `SELECT id FROM rooms WHERE match_id = $1 AND status = 'active'`, [matchId]);
  for (const r of rooms) {
    for (const t of opened) {
      try {
        await openThread(q, r.id, { ...t, source: 'moment' });
      } catch (err) {
        if (!(err instanceof RoomEndedError)) throw err;
      }
    }
  }
}

// Which thread a new message joins: the one it was sent from, else one whose topic it mentions, else a big moment
// from the last few seconds.
export async function threadForMessage(q, roomId, text, requested) {
  if (requested != null) {
    const t = typeof requested === 'string' && await one(q, 'SELECT id FROM room_threads WHERE id = $1 AND room_id = $2', [requested, roomId]);
    if (!t) throw badRequest('That thread is not in this room.', 'invalid_thread');
    return t.id;
  }
  const threads = await many(q,
    `SELECT id, keywords, source, created_at > now() - make_interval(secs => $2) AS fresh
       FROM room_threads WHERE room_id = $1 ORDER BY created_at DESC LIMIT 20`, [roomId, FRESH_SECONDS]);
  const lower = text.toLowerCase();
  const mentioned = threads.find((t) => t.keywords.some((k) => lower.includes(k)));
  if (mentioned) return mentioned.id;
  const recent = threads.find((t) => t.fresh && t.source === 'moment');
  return recent && text.length >= 10 ? recent.id : null;
}

// A topic the room keeps arguing about becomes a thread once enough people have joined in; those messages move
// into it.
export async function maybeOpenDiscussion(q, roomId, text) {
  const topic = topicFor(text);
  if (!topic) return null;
  if (await one(q, 'SELECT 1 FROM room_threads WHERE room_id = $1 AND slug = $2', [roomId, topic.slug])) return null;
  const recent = await many(q,
    `SELECT id, sender_id, body FROM messages
      WHERE room_id = $1 AND sender_type = 'user' AND status = 'visible' AND thread_id IS NULL
        AND created_at > now() - make_interval(mins => $2)
      ORDER BY seq DESC LIMIT 60`, [roomId, DISCUSSION.minutes]);
  const about = recent.filter((m) => topicFor(m.body)?.slug === topic.slug);
  if (about.length < DISCUSSION.messages || new Set(about.map((m) => m.sender_id)).size < DISCUSSION.people) return null;
  const thread = await openThread(q, roomId, { slug: topic.slug, about: 'Started by the room.', keywords: topic.keywords, source: 'discussion' });
  await q.query('UPDATE messages SET thread_id = $2 WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))',
    [JSON.stringify(about.map((m) => m.id)), thread.id]);
  for (const m of about) await appendEvent(q, roomId, 'message_update', m.id);
  return thread.id;
}

export async function touchThread(q, threadId) {
  await q.query('UPDATE room_threads SET last_active_at = now() WHERE id = $1', [threadId]);
}

export async function hydrateThreads(q, roomId, ids = null) {
  const rows = await many(q,
    `SELECT t.id, t.slug, t.title, t.about, t.source, t.created_at, t.last_active_at,
            (SELECT count(*)::int FROM messages m WHERE m.thread_id = t.id AND m.status = 'visible') AS messages
       FROM room_threads t
      WHERE t.room_id = $1 AND ($2::jsonb IS NULL OR t.id IN (SELECT jsonb_array_elements_text($2::jsonb)))
      ORDER BY t.created_at`,
    [roomId, ids ? JSON.stringify(ids) : null]);
  return new Map(rows.map((t) => [t.id, t]));
}
