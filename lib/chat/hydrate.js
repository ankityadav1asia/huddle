// Turns stored rows into what clients render. Only room-scoped rows that already passed authorization reach
// here. Phone numbers never leave the server; removed messages lose their text.
import { many } from '../db/index.js';
import { hydrateThreads } from '../rooms/threads.js';

export const REACTIONS = ['🔥', '😂', '😮', '👏', '😢', '🏏'];

const sender = (r) => (r.sender_type === 'ai'
  ? { type: 'ai', id: null, handle: 'huddle', name: 'Huddle Co-host', team: null }
  : { type: 'user', id: r.sender_id, handle: r.handle, name: r.display_name, team: r.team });

export async function hydrateMessages(q, roomId, ids, viewerId) {
  if (!ids.length) return new Map();
  const rows = await many(q,
    `SELECT m.*, u.handle, u.display_name, u.team, p.sender_type AS reply_sender_type, pu.handle AS reply_handle,
            p.body AS reply_body, p.status AS reply_status, t.title AS thread_title
       FROM messages m
       LEFT JOIN users u ON u.id = m.sender_id
       LEFT JOIN messages p ON p.id = m.reply_to_id AND p.room_id = m.room_id
       LEFT JOIN users pu ON pu.id = p.sender_id
       LEFT JOIN room_threads t ON t.id = m.thread_id
      WHERE m.room_id = $1 AND m.id IN (SELECT jsonb_array_elements_text($2::jsonb))`,
    [roomId, JSON.stringify(ids)]);
  const reactions = await many(q,
    `SELECT message_id, emoji, count(*)::int AS n, bool_or(user_id = $2) AS mine
       FROM message_reactions WHERE message_id IN (SELECT jsonb_array_elements_text($1::jsonb))
      GROUP BY message_id, emoji`,
    [JSON.stringify(ids), viewerId]);
  const byMsg = new Map();
  for (const r of reactions) {
    if (!byMsg.has(r.message_id)) byMsg.set(r.message_id, []);
    byMsg.get(r.message_id).push({ emoji: r.emoji, count: r.n, mine: r.mine });
  }
  const out = new Map();
  for (const r of rows) {
    if (r.status === 'held' && r.sender_id !== viewerId) continue;
    out.set(r.id, {
      id: r.id,
      seq: r.seq,
      sender: sender(r),
      text: r.status === 'removed' ? null : r.body,
      status: r.status,
      reply_to: r.reply_to_id ? {
        id: r.reply_to_id,
        handle: r.reply_sender_type === 'ai' ? 'huddle' : r.reply_handle,
        excerpt: r.reply_status === 'visible' && r.reply_body ? r.reply_body.slice(0, 80) : null,
      } : null,
      reactions: (byMsg.get(r.id) || []).sort((a, b) => REACTIONS.indexOf(a.emoji) - REACTIONS.indexOf(b.emoji)),
      answer_state: r.answer_state,
      thread: r.thread_id ? { id: r.thread_id, title: r.thread_title } : null,
      ai: r.sender_type === 'ai' ? r.ai_meta : null,
      mine: r.sender_id === viewerId,
      created_at: r.created_at,
    });
  }
  return out;
}

export async function hydratePolls(q, roomId, ids, viewerId) {
  if (!ids.length) return new Map();
  const rows = await many(q,
    `SELECT p.*, (p.status = 'open' AND p.closes_at > now()) AS is_open,
            (SELECT option_index FROM poll_votes v WHERE v.poll_id = p.id AND v.user_id = $3) AS my_vote,
            COALESCE((SELECT jsonb_object_agg(option_index, n) FROM (
               SELECT option_index, count(*)::int AS n FROM poll_votes v WHERE v.poll_id = p.id GROUP BY option_index) c), '{}'::jsonb) AS counts
       FROM polls p WHERE p.room_id = $1 AND p.id IN (SELECT jsonb_array_elements_text($2::jsonb))`,
    [roomId, JSON.stringify(ids), viewerId]);
  return new Map(rows.map((p) => [p.id, {
    id: p.id, seq: p.seq, question: p.question, source: p.source,
    options: p.options.map((o, i) => ({ label: o.label, votes: Number(p.counts[i] || 0) })),
    open: p.is_open, closes_at: p.closes_at, my_vote: p.my_vote, created_at: p.created_at,
  }]));
}

export async function hydrateInsights(q, roomId, ids, aiEnabled) {
  if (!ids.length) return new Map();
  const rows = await many(q,
    `SELECT i.id, i.seq, i.created_at, s.trigger, s.priority, s.label, s.fact_text, s.ai_text, s.expires_at,
            e.occurred_at, e.id AS event_id
       FROM room_insights i JOIN match_signals s ON s.id = i.signal_id JOIN match_events e ON e.id = s.event_id
      WHERE i.room_id = $1 AND i.id IN (SELECT jsonb_array_elements_text($2::jsonb))`,
    [roomId, JSON.stringify(ids)]);
  return new Map(rows.map((r) => [r.id, {
    id: r.id, seq: r.seq, trigger: r.trigger, priority: r.priority, label: r.label,
    fact: r.fact_text,
    explanation: aiEnabled ? r.ai_text : null,
    source_event_id: r.event_id, occurred_at: r.occurred_at, expires_at: r.expires_at, created_at: r.created_at,
  }]));
}

export async function hydrateMembers(q, roomId, ids) {
  if (!ids.length) return new Map();
  const rows = await many(q,
    `SELECT u.id, u.handle, u.display_name, u.team, m.role, m.status FROM users u
       LEFT JOIN room_members m ON m.user_id = u.id AND m.room_id = $1
      WHERE u.id IN (SELECT jsonb_array_elements_text($2::jsonb))`,
    [roomId, JSON.stringify(ids)]);
  return new Map(rows.map((r) => [r.id, { id: r.id, handle: r.handle, name: r.display_name, team: r.team, role: r.role, status: r.status }]));
}

// Hydrates a list of room_events rows ({seq, type, entity_id}) into renderable items, in order.
export async function hydrateEvents(q, room, viewerId, events) {
  const ids = (types) => [...new Set(events.filter((e) => types.includes(e.type)).map((e) => e.entity_id))];
  const messages = await hydrateMessages(q, room.id, ids(['message', 'message_update']), viewerId);
  const polls = await hydratePolls(q, room.id, ids(['poll']), viewerId);
  const insights = await hydrateInsights(q, room.id, ids(['insight']), room.ai_enabled);
  const members = await hydrateMembers(q, room.id, ids(['member']));
  const threadIds = ids(['thread']);
  const threads = threadIds.length ? await hydrateThreads(q, room.id, threadIds) : new Map();
  const out = [];
  for (const e of events) {
    const data = e.type === 'message' || e.type === 'message_update' ? messages.get(e.entity_id)
      : e.type === 'poll' ? polls.get(e.entity_id)
        : e.type === 'insight' ? insights.get(e.entity_id)
          : e.type === 'member' ? members.get(e.entity_id)
            : e.type === 'thread' ? threads.get(e.entity_id)
              : e.type === 'room' ? { id: room.id } : null;
    if (data) out.push({ seq: e.seq, type: e.type, data });
  }
  return out;
}
