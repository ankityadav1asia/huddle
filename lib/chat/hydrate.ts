// Turns stored rows into what clients render. Only room-scoped rows that already passed authorization reach
// here. Phone numbers never leave the server; removed messages lose their text.
import { one, many, type Queryable } from '../db/index.ts';
import type { MatchRow, MessageRow, PollRow, RoomEventRow, RoomRole, RoomRow, SignalRow } from '../db/rows.ts';
import { hydrateThreads, type ThreadItem } from '../rooms/threads.ts';
import type { RoomEventType } from '../rooms/events.ts';
import type { MemberStatus } from '../rooms/service.ts';
import { fixtureFor } from '../match/fixture.ts';

export const REACTIONS = ['🔥', '😂', '😮', '👏', '😢', '🏏'];

// ---------------------------------------------------------------- what clients render
export interface Sender { type: 'user' | 'ai'; id: string | null; handle: string | null; name: string | null; team: string | null }
export interface ReactionCount { emoji: string; count: number; mine: boolean }

export interface MessageItem {
  id: string;
  seq: number | null; // null while the message is held
  sender: Sender;
  text: string | null;
  status: MessageRow['status'];
  reply_to: { id: string; handle: string | null; excerpt: string | null } | null;
  reactions: ReactionCount[];
  answer_state: MessageRow['answer_state'];
  thread: { id: string; title: string | null } | null;
  ai: MessageRow['ai_meta'];
  mine: boolean;
  created_at: Date;
}

export interface PollItem {
  id: string;
  seq: number;
  question: string;
  source: string;
  options: { label: string; votes: number }[];
  open: boolean;
  closes_at: Date;
  my_vote: number | null;
  created_at: Date;
}

export interface InsightItem {
  id: string;
  seq: number;
  trigger: string;
  priority: SignalRow['priority'];
  label: string;
  fact: string;
  explanation: string | null;
  source_event_id: string;
  occurred_at: Date;
  expires_at: Date;
  created_at: Date;
}

export interface MemberItem {
  id: string;
  handle: string | null;
  name: string | null;
  team: string | null;
  role: RoomRole | null; // null (with status) for someone who has no membership row in this room
  status: MemberStatus | null;
}

// A room_events row as polls read it. appendEvent always records the changed row's id.
export type RoomEventRef = Pick<RoomEventRow, 'seq'> & { type: RoomEventType; entity_id: string };
export interface RoomUpdate { seq: number; type: RoomEventType; data: MessageItem | PollItem | InsightItem | MemberItem | ThreadItem | { id: string } }

// ---------------------------------------------------------------- rows read here
// A message with its sender's profile, the message it replies to and its thread (LEFT JOINs: null where absent).
interface MessageViewRow extends MessageRow {
  handle: string | null;
  display_name: string | null;
  team: string | null;
  reply_sender_type: MessageRow['sender_type'] | null;
  reply_handle: string | null;
  reply_body: string | null;
  reply_status: MessageRow['status'] | null;
  thread_title: string | null;
}

// Reactions per message and emoji, with whether the viewer is among them.
interface ReactionRow { message_id: string; emoji: string; n: number; mine: boolean }

// counts: votes by option index (jsonb object keys).
type PollViewRow = PollRow & { is_open: boolean; my_vote: number | null; counts: Record<string, number> };

type InsightViewRow = Pick<SignalRow, 'trigger' | 'priority' | 'label' | 'fact_text' | 'ai_text' | 'expires_at'>
  & { id: string; seq: number; created_at: Date; occurred_at: Date; event_id: string };

type MemberViewRow = Omit<MemberItem, 'name'> & { display_name: string | null };

const sender = (r: MessageViewRow): Sender => (r.sender_type === 'ai'
  ? { type: 'ai', id: null, handle: 'huddle', name: 'Huddle Co-host', team: null }
  : { type: 'user', id: r.sender_id, handle: r.handle, name: r.display_name, team: r.team });

// The sport of a room's game: people show the team they back in it there. Null for a room without a game.
export async function roomSport(q: Queryable, roomId: string): Promise<string | null> {
  const r = await one<Pick<MatchRow, 'fixture_key'>>(q, 'SELECT mt.fixture_key FROM rooms r JOIN matches mt ON mt.id = r.match_id WHERE r.id = $1', [roomId]);
  return r ? fixtureFor(r).sport : null;
}

export async function hydrateMessages(q: Queryable, roomId: string, ids: string[], viewerId: string, sport?: string | null): Promise<Map<string, MessageItem>> {
  if (!ids.length) return new Map();
  if (sport === undefined) sport = await roomSport(q, roomId);
  const rows = await many<MessageViewRow>(q,
    `SELECT m.*, u.handle, u.display_name, u.sports -> $3::text ->> 'team' AS team, p.sender_type AS reply_sender_type, pu.handle AS reply_handle,
            p.body AS reply_body, p.status AS reply_status, t.title AS thread_title
       FROM messages m
       LEFT JOIN users u ON u.id = m.sender_id
       LEFT JOIN messages p ON p.id = m.reply_to_id AND p.room_id = m.room_id
       LEFT JOIN users pu ON pu.id = p.sender_id
       LEFT JOIN room_threads t ON t.id = m.thread_id
      WHERE m.room_id = $1 AND m.id IN (SELECT jsonb_array_elements_text($2::jsonb))`,
    [roomId, JSON.stringify(ids), sport]);
  const reactions = await many<ReactionRow>(q,
    `SELECT message_id, emoji, count(*)::int AS n, bool_or(user_id = $2) AS mine
       FROM message_reactions WHERE message_id IN (SELECT jsonb_array_elements_text($1::jsonb))
      GROUP BY message_id, emoji`,
    [JSON.stringify(ids), viewerId]);
  const byMsg = new Map<string, ReactionCount[]>();
  for (const r of reactions) {
    if (!byMsg.has(r.message_id)) byMsg.set(r.message_id, []);
    byMsg.get(r.message_id)!.push({ emoji: r.emoji, count: r.n, mine: r.mine });
  }
  const out = new Map<string, MessageItem>();
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

export async function hydratePolls(q: Queryable, roomId: string, ids: string[], viewerId: string): Promise<Map<string, PollItem>> {
  if (!ids.length) return new Map();
  const rows = await many<PollViewRow>(q,
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

export async function hydrateInsights(q: Queryable, roomId: string, ids: string[], aiEnabled: boolean): Promise<Map<string, InsightItem>> {
  if (!ids.length) return new Map();
  const rows = await many<InsightViewRow>(q,
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

export async function hydrateMembers(q: Queryable, roomId: string, ids: string[], sport?: string | null): Promise<Map<string, MemberItem>> {
  if (!ids.length) return new Map();
  if (sport === undefined) sport = await roomSport(q, roomId);
  const rows = await many<MemberViewRow>(q,
    `SELECT u.id, u.handle, u.display_name, u.sports -> $3::text ->> 'team' AS team, m.role, m.status FROM users u
       LEFT JOIN room_members m ON m.user_id = u.id AND m.room_id = $1
      WHERE u.id IN (SELECT jsonb_array_elements_text($2::jsonb))`,
    [roomId, JSON.stringify(ids), sport]);
  return new Map(rows.map((r) => [r.id, { id: r.id, handle: r.handle, name: r.display_name, team: r.team, role: r.role, status: r.status }]));
}

// Hydrates a list of room_events rows ({seq, type, entity_id}) into renderable items, in order.
export async function hydrateEvents(q: Queryable, room: Pick<RoomRow, 'id' | 'ai_enabled'>, viewerId: string, events: RoomEventRef[]) {
  const ids = (types: RoomEventType[]): string[] => [...new Set<string>(events.filter((e) => types.includes(e.type)).map((e) => e.entity_id))];
  const sport = ids(['message', 'message_update', 'member']).length ? await roomSport(q, room.id) : null; // for each person's team
  const messages = await hydrateMessages(q, room.id, ids(['message', 'message_update']), viewerId, sport);
  const polls = await hydratePolls(q, room.id, ids(['poll']), viewerId);
  const insights = await hydrateInsights(q, room.id, ids(['insight']), room.ai_enabled);
  const members = await hydrateMembers(q, room.id, ids(['member']), sport);
  const threadIds = ids(['thread']);
  const threads: Map<string, ThreadItem> = threadIds.length ? await hydrateThreads(q, room.id, threadIds) : new Map();
  const out: RoomUpdate[] = [];
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
