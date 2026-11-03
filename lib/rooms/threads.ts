// Moment threads: #topics inside a room. The match opens one in every room following it for each big moment (each
// sport's engine decides which), and a room opens one when enough people argue about one of its sport's topics. Every
// message still shows in "All chat". Deterministic: no AI involved.
import { one, many, type Queryable } from '../db/index.ts';
import type { MessageRow, RoomRow, ThreadRow } from '../db/rows.ts';
import type { MomentThread, Topic } from '../match/fixture.ts';
import { badRequest, newId } from '../util.ts';
import { appendEvent, RoomEndedError } from './events.ts';

const FRESH_SECONDS = 30; // chat this soon after a big moment is about it
const DISCUSSION = { messages: 3, people: 2, minutes: 10 };

// A thread as clients list it.
export type ThreadItem = Pick<ThreadRow, 'id' | 'slug' | 'title' | 'about' | 'source' | 'created_at' | 'last_active_at'> & { messages: number };

const topicFor = (text: string, topics: Topic[]) => {
  const t = text.toLowerCase();
  return topics.find((topic) => topic.keywords.some((k) => t.includes(k))) || null;
};

async function openThread(q: Queryable, roomId: string, { slug, about, keywords, source }: Pick<ThreadRow, 'slug' | 'about' | 'keywords' | 'source'>) {
  // ON CONFLICT DO UPDATE returns the row whether it was inserted or already there.
  const row = (await one<{ id: string; created: boolean }>(q,
    `INSERT INTO room_threads (id, room_id, slug, title, about, keywords, source) VALUES ($1, $2, $3, $4, $5, $6::text[], $7)
     ON CONFLICT (room_id, slug) DO UPDATE SET last_active_at = now()
     RETURNING id, (xmax = 0) AS created`,
    [newId('thr'), roomId, slug, `#${slug}`, about, keywords, source]))!;
  if (row.created) await appendEvent(q, roomId, 'thread', row.id);
  return row;
}

// Called by feed ingestion (inside its transaction) for the big moments that just happened.
export async function openMomentThreads(q: Queryable, matchId: string, opened: MomentThread[]) {
  if (!opened.length) return;
  const rooms = await many<Pick<RoomRow, 'id'>>(q, `SELECT id FROM rooms WHERE match_id = $1 AND status = 'active'`, [matchId]);
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
// from the last few seconds. requested: the thread_id the client sent, unchecked.
export async function threadForMessage(q: Queryable, roomId: string, text: string, requested: unknown): Promise<string | null> {
  if (requested != null) {
    const t = typeof requested === 'string' && await one<Pick<ThreadRow, 'id'>>(q, 'SELECT id FROM room_threads WHERE id = $1 AND room_id = $2', [requested, roomId]);
    if (!t) throw badRequest('That thread is not in this room.', 'invalid_thread');
    return t.id;
  }
  const threads = await many<Pick<ThreadRow, 'id' | 'keywords' | 'source'> & { fresh: boolean }>(q,
    `SELECT id, keywords, source, created_at > now() - make_interval(secs => $2) AS fresh
       FROM room_threads WHERE room_id = $1 ORDER BY created_at DESC LIMIT 20`, [roomId, FRESH_SECONDS]);
  const lower = text.toLowerCase();
  const mentioned = threads.find((t) => t.keywords.some((k) => lower.includes(k)));
  if (mentioned) return mentioned.id;
  const recent = threads.find((t) => t.fresh && t.source === 'moment');
  return recent && text.length >= 10 ? recent.id : null;
}

// A topic the room keeps arguing about becomes a thread once enough people join in, and those messages move into it.
export async function maybeOpenDiscussion(q: Queryable, roomId: string, text: string, topics: Topic[] = []) {
  const topic = topicFor(text, topics);
  if (!topic) return null;
  if (await one(q, 'SELECT 1 FROM room_threads WHERE room_id = $1 AND slug = $2', [roomId, topic.slug])) return null;
  // Visible user messages always have a sender and a body.
  const recent = await many<Pick<MessageRow, 'id'> & { sender_id: string; body: string }>(q,
    `SELECT id, sender_id, body FROM messages
      WHERE room_id = $1 AND sender_type = 'user' AND status = 'visible' AND thread_id IS NULL
        AND created_at > now() - make_interval(mins => $2)
      ORDER BY seq DESC LIMIT 60`, [roomId, DISCUSSION.minutes]);
  const about = recent.filter((m) => topicFor(m.body, topics)?.slug === topic.slug);
  if (about.length < DISCUSSION.messages || new Set(about.map((m) => m.sender_id)).size < DISCUSSION.people) return null;
  const thread = await openThread(q, roomId, { slug: topic.slug, about: 'Started by the room.', keywords: topic.keywords, source: 'discussion' });
  await q.query('UPDATE messages SET thread_id = $2 WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb))',
    [JSON.stringify(about.map((m) => m.id)), thread.id]);
  for (const m of about) await appendEvent(q, roomId, 'message_update', m.id);
  return thread.id;
}

export async function touchThread(q: Queryable, threadId: string) {
  await q.query('UPDATE room_threads SET last_active_at = now() WHERE id = $1', [threadId]);
}

export async function hydrateThreads(q: Queryable, roomId: string, ids: string[] | null = null) {
  const rows = await many<ThreadItem>(q,
    `SELECT t.id, t.slug, t.title, t.about, t.source, t.created_at, t.last_active_at,
            (SELECT count(*)::int FROM messages m WHERE m.thread_id = t.id AND m.status = 'visible') AS messages
       FROM room_threads t
      WHERE t.room_id = $1 AND ($2::jsonb IS NULL OR t.id IN (SELECT jsonb_array_elements_text($2::jsonb)))
      ORDER BY t.created_at`,
    [roomId, ids ? JSON.stringify(ids) : null]);
  return new Map(rows.map((t) => [t.id, t]));
}
