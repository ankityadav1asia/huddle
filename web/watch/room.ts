// The watch party room: the long-poll feed, the composer and its rate limit, match intelligence, AI Co-host actions
// and the member and settings sheets. The server re-authorises every request; this view never decides who sees what.
import { api, ApiError, errorMessage, serverNow, newKey, type CreatedRoom, type InviteResult, type ModerationLevel, type Role } from './api.ts';
import { el, icon, aiLabel, initials, teamClass, teamLogo, clock, clockSeconds, ago, plural, toast, setRail, railIntro, type Attrs } from './ui.ts';
import { openSheet, closeSheet, sheetActions, confirmSheet } from './sheets.ts';
import { openNotificationSettings, pushPrompt } from './push.ts';
import { friendPicker, levelChooser, LEVEL_NAMES } from './home.ts';
import type { ReadyCtx } from './app.ts';

const ROLE_LABEL: Partial<Record<Role, string>> = { owner: 'OWNER', admin: 'ADMIN' };
const REPORT_REASONS = [
  ['harassment', 'Harassment or bullying'], ['hate', 'Hate speech'], ['threat', 'Threat or violence'],
  ['spam', 'Spam'], ['personal_info', 'Sharing personal details'], ['sexual', 'Sexual content'],
  ['misinformation', 'Wrong match information'], ['other', 'Something else'],
];
const MAX_ITEMS = 300;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// Server payloads: only the fields this view reads (lib/rooms/realtime.ts, lib/chat/hydrate.ts, lib/match/feed.ts).

// The room in the bootstrap. A public room's moderation is Huddle's, with no level; a private room always has one.
type Room = {
  name: string | null;
  status: string;
  ai_enabled: boolean;
  ai_notice: string;
  retention_notice: string;
  match: { id: string; sport: string } | null;
  my_role: Role;
  can_manage: boolean;
} & (
  | { room_type: 'public'; moderation: { level: null; notice: string } }
  | { room_type: 'private'; moderation: { level: ModerationLevel; description: string; notice: string } }
);

// A member, with the team they back in this room's sport.
interface Member { id: string; handle: string | null; name: string | null; team: string | null; role: Role }

// Who has the room open, and who has it in front (active).
interface Presence { online: string[]; active: string[] }

// One of a public watch party's simulated fans.
interface SimFan { handle: string; team: string }

// Who wrote a message: a person, or the AI Co-host (no id or team).
interface Sender { type: 'user' | 'ai'; id: string | null; handle: string | null; team: string | null }

// What the AI Co-host's answer was based on.
interface AiMeta { type?: string; asked_at?: string | null; grounding?: { status?: string; data_as_of?: string | null; stale?: boolean } }

interface ChatMessage {
  id: string;
  seq: number | null; // null while the message is held
  sender: Sender;
  text: string | null; // null once removed
  status: 'visible' | 'held' | 'removed';
  reply_to: { handle: string | null; excerpt: string | null } | null;
  reactions: { emoji: string; count: number; mine: boolean }[];
  answer_state: string | null;
  thread: { id: string; title: string | null } | null;
  ai: AiMeta | null;
  mine: boolean;
  created_at: string;
}

// A person's message: renderItem sends the Co-host's to renderAiMessage instead.
type UserMessage = ChatMessage & { sender: { type: 'user'; id: string } };

interface Poll {
  id: string;
  seq: number;
  question: string;
  source: string;
  options: { label: string; votes: number }[];
  open: boolean;
  closes_at: string;
  my_vote: number | null;
}

// A big match moment posted to the room.
interface Insight { id: string; seq: number; priority: 'high' | 'medium' | 'low'; label: string; fact: string; explanation: string | null; occurred_at: string }

// A #thread, opened by a big moment or by a topic the room keeps arguing about.
interface Thread { id: string; slug: string; title: string; about: string | null; source: 'moment' | 'discussion'; messages: number; last_active_at: string }

// What the thread bar keeps for each: messages seen live since loading, its last activity, and whether it is new.
interface ThreadState extends Thread { live: number; lastActive: number; fresh: boolean }

// A member event: someone joined, changed role, left or was removed.
type MemberUpdate = Omit<Member, 'role'> & ({ status: 'active'; role: Role } | { status: 'left' | 'removed' | null; role: Role | null });

// A realtime event from the long-poll.
type RoomEvent = { seq: number } & (
  | { type: 'message' | 'message_update'; data: ChatMessage }
  | { type: 'poll'; data: Poll }
  | { type: 'insight'; data: Insight }
  | { type: 'member'; data: MemberUpdate }
  | { type: 'thread'; data: Thread }
  | { type: 'room'; data: { id: string } }
);
type MemberEvent = Extract<RoomEvent, { type: 'member' }>;

// GET /api/rooms/:id. An ended room comes back as { room: { status, name } } only, which bootstrap() checks first.
interface RoomBootstrap {
  room: Room;
  members: Member[];
  presence: Presence;
  cursor: number;
  match_rev: string | null;
  cooldown_until: string | null;
  simulated_fans: SimFan[];
  threads: Thread[];
  items: ({ type: 'message'; data: ChatMessage } | { type: 'poll'; data: Poll } | { type: 'insight'; data: Insight })[];
}

// GET /api/rooms/:id/events (the long-poll). An ended room, or a reset, comes back with little more than its status.
interface RoomPoll {
  room: { status: string; ai_enabled?: boolean; moderation_level?: ModerationLevel | null };
  events: RoomEvent[];
  cursor: number;
  presence?: Presence;
  match_rev?: string | null;
  reset?: boolean;
}

// GET /api/rooms/:id/guide: help for newcomers to the room's sport.
interface Guide { sport_name: string; examples: string[]; rules: { topic: string; text: string }[]; roster: { name: string; team: string; role: string }[] }

// GET /api/rooms/:id/match.
interface MatchSnapshot {
  match: { id: string; title: string; status: 'scheduled' | 'live' | 'completed'; sport: string; source_label: string; teams: { code: string; name: string; logo?: string }[] };
  freshness: { age_seconds: number | null; stale: boolean };
  // One shape per sport, picked by match.sport, which TypeScript cannot narrow score by: hence any. The one-sport
  // renderers give it their sport's type (below); the ones that switch on the sport type what they iterate over.
  score: any;
  commentary: { over: string | null; symbol: string | null; label: string | null; text: string }[];
  moments: { id: string; label: string }[]; // demo controls
  replay: { own: boolean; paused: boolean; speed: number; can_control: boolean; moments: { id: string; label: string; passed: boolean }[] };
  crowd: CrowdLine[];
}

// The scoreboard fields shown, per sport (lib/match/scorecard.ts and lib/match/sports/*).
interface Batter { name: string; short: string; runs: number; balls: number; strike_rate: number | null; on_strike: boolean }
interface CricketScore {
  batting: string;
  runs: number;
  wickets: number;
  overs: string;
  target: number;
  need_runs: number;
  need_balls: number;
  rrr: number | null;
  result: string | null;
  chase_won: boolean;
  batters: Batter[];
  bowler: { short: string; figures: string } | null;
  this_over: string[];
}
interface BowlingFigures { name: string; figures: string; economy: number }
interface FallOfWicket { name: string; r: number; b: number; how: string; score: string | null; over: string | null }
interface F1Car { pos: number; name: string; short: string; team: string; gap: string; tyre: string; pits: number }
interface F1Score { lap: number; total_laps: number; safety_car: boolean; result: string | null; order: F1Car[]; fastest_lap: { driver: string; time: string } }
interface BasketballTeam { name: string; leaders: { name: string; short: string; pts: number }[] }
interface HockeyGoal { time: string; scorer: string; team: string; strength: string; assists: string[] }
interface HockeyPenalty { time: string; player: string; team: string; infraction: string }

// POST /api/rooms/:id/catchup: a summary for the asker only.
interface CatchUp {
  headline: string;
  match_points?: string[];
  room_points?: string[];
  note?: string;
  source: string;
  source_label: string;
  data_as_of: string | null;
  stale: boolean;
}

// An invitation as the room's owner and admins see it (GET /api/rooms/:id/invitations).
interface RoomInvitation { id: string; user_id: string; handle: string; display_name: string | null; status: string }

// A control for a private room's own replay (POST /api/rooms/:id/replay).
type ReplayControl = { action: string; speed?: number; moment?: string };

// What each kind of feed entry holds; upsertItem pairs a type with its data.
interface FeedData {
  message: ChatMessage;
  pending: PendingMessage;
  poll: Poll;
  insight: Insight;
  crowd: CrowdLine & { seq: number };
  sys: { id: string; seq: number; text: string };
}
type FeedType = keyof FeedData;

// One feed entry (message, pending message, poll, insight, crowd line or system line) and its node.
type FeedEntry = { key: string; node: HTMLElement; thread: string | null; seq: number };

// The room's elements, made by buildRoom().
interface RoomEls {
  // header
  title: HTMLElement;
  typeBadge: HTMLSpanElement;
  online: HTMLSpanElement;
  memberCount: HTMLSpanElement;
  score: HTMLButtonElement;
  replayBar: HTMLDivElement;
  // AI Co-host strip
  cohost: HTMLElement;
  cohostLabel: HTMLSpanElement;
  cohostText: HTMLParagraphElement;
  reconnect: HTMLSpanElement;
  pollBtn: HTMLButtonElement;
  backing: HTMLDivElement;
  guide: HTMLDivElement;
  // chat
  threadBar: HTMLDivElement;
  scroll: HTMLDivElement;
  feed: HTMLDivElement;
  notice: HTMLDivElement;
  threadHead: HTMLDivElement;
  banner: HTMLDivElement;
  newPill: HTMLButtonElement;
  // composer
  input: HTMLInputElement;
  send: HTMLButtonElement;
  reply: HTMLDivElement;
  error: HTMLDivElement;
  notice2: HTMLParagraphElement;
  cooldown: HTMLDivElement;
}

// The open room.
interface RoomState {
  id: string;
  ctx: ReadyCtx;
  active: boolean;
  abort: AbortController;
  items: Map<string, FeedEntry>;
  seqSeen: Set<number>;
  members: Map<string, Member>;
  presence: Presence;
  cursor: number;
  cooldownUntil: number;
  replyTo: ChatMessage | null;
  match: MatchSnapshot | null;
  matchFetchedAt: number;
  matchRev: string | null;
  matchBusy: boolean;
  matchAgain: boolean;
  stick: boolean;
  hiddenAt: number;
  hiddenCursor: number;
  catchupSince: number | null;
  loopToken: number;
  els: RoomEls; // filled in by buildRoom
  crowdOn: boolean;
  crowdSeen: Set<string>;
  crowdTimers: Set<number>;
  crowdN: number;
  threads: Map<string, ThreadState>;
  activeThread: string;
  booted: boolean;
  // Set by bootstrap() before anything reads them.
  room: Room;
  simFans: SimFan[];
  // Set later, if at all.
  ticker?: number;
  onVis?: () => void;
  lastInsight?: Insight;
  guide?: Guide;
  membersSheet?: { refresh: () => void };
  matchSheet?: { isOpen: () => boolean; render: () => void };
}

let R: RoomState | null = null;

// Converts a server timestamp to this device's clock (the API tracks the offset from the Date header).
const toLocal = (ts: string) => new Date(ts).getTime() - (serverNow() - Date.now());

const seenKey = (id: string) => `huddle:seen:${id}`;
function rememberSeen(state: RoomState) {
  try { if (state.cursor) localStorage.setItem(seenKey(state.id), String(state.cursor)); } catch { /* storage may be unavailable */ }
}
function lastSeen(id: string) {
  try {
    const v = Number(localStorage.getItem(seenKey(id)));
    return Number.isInteger(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

export function leaveRoom() {
  if (!R) return;
  const state = R;
  R = null;
  state.active = false;
  state.abort.abort();
  clearInterval(state.ticker);
  for (const t of state.crowdTimers) clearTimeout(t);
  if (state.onVis) document.removeEventListener('visibilitychange', state.onVis);
  rememberSeen(state);
}

export async function renderRoom(ctx: ReadyCtx, roomId: string) {
  leaveRoom();
  // Cast: room and simFans arrive in bootstrap(), and els fills up in buildRoom(), before anything reads them. The
  // presence cast only types its empty lists, which would otherwise be never[].
  const state = {
    id: roomId, ctx, active: true, abort: new AbortController(), items: new Map(), seqSeen: new Set(),
    members: new Map(), presence: { online: [], active: [] } as Presence, cursor: 0, cooldownUntil: 0, replyTo: null,
    match: null, matchFetchedAt: 0, matchRev: null, matchBusy: false, matchAgain: false, stick: true,
    hiddenAt: 0, hiddenCursor: 0, catchupSince: null, loopToken: 0, els: {},
    crowdOn: crowdPref(), crowdSeen: new Set(), crowdTimers: new Set(), crowdN: 0,
    threads: new Map(), activeThread: 'all', booted: false,
  } as RoomState;
  R = state;
  const view = document.getElementById('view');
  if (!view) return;
  view.replaceChildren(
    el('div', { class: 'masthead' }, el('header', { class: 'top' }, backButton(state), el('div', { class: 'top-title' }, el('b', { class: 'room-title', text: 'Loading…' })))),
    el('div', { class: 'scroll-body' }, el('div', { class: 'skeleton' }), el('div', { class: 'skeleton' }), el('div', { class: 'skeleton' })),
  );
  await bootstrap(state);
}

function backButton(state: Pick<RoomState, 'ctx'>) {
  return el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Back to home', onclick: () => state.ctx.navigate('#/') }, icon('back'));
}

async function bootstrap(state: RoomState) {
  let boot: RoomBootstrap;
  try {
    boot = await api.get(`/api/rooms/${state.id}`, { signal: state.abort.signal });
  } catch (err) {
    if ((err instanceof Error && err.name === 'AbortError') || state !== R) return;
    renderProblem(state, err);
    return;
  }
  if (state !== R) return;
  if (boot.room.status !== 'active') {
    renderEnded(state, boot.room);
    return;
  }
  state.room = boot.room;
  state.members = new Map(boot.members.map((m) => [m.id, m]));
  state.presence = boot.presence || state.presence;
  state.cursor = boot.cursor;
  state.matchRev = boot.match_rev;
  state.cooldownUntil = boot.cooldown_until ? toLocal(boot.cooldown_until) : 0;
  state.simFans = boot.simulated_fans || []; // the public watch party's scripted crowd; none in private rooms
  buildRoom(state);
  for (const t of boot.threads || []) addThread(state, t, { quiet: true });
  for (const item of boot.items) upsertItem(state, item.type, item.data);
  state.booted = true;
  scrollToBottom(state);
  const seen = lastSeen(state.id);
  if (seen && state.cursor - seen >= 3) {
    state.catchupSince = seen;
    showBanner(state, `Welcome back. ${plural(state.cursor - seen, 'update')} since your last visit.`);
  }
  rememberSeen(state);
  if (state.room.match) {
    refreshMatch(state);
    renderBacking(state);
    loadGuide(state);
  } else renderRail(state);
  state.ticker = setInterval(() => tick(state), 1000);
  tick(state);
  state.onVis = () => onVisibility(state);
  document.addEventListener('visibilitychange', state.onVis);
  state.loopToken += 1;
  loop(state, state.loopToken);
}

function buildRoom(state: RoomState) {
  const room = state.room;
  const els = state.els;
  els.title = el('b', { class: 'room-title', text: room.name || 'Watch party' });
  els.typeBadge = el('span', { class: 'type-pill' });
  els.online = el('span', { class: 'online-count' });
  els.memberCount = el('span', { class: 'fans-count' });
  const people = el('button', { type: 'button', class: 'fans-btn', 'aria-label': 'Members', onclick: () => openMembers(state) }, icon('people'), els.memberCount);
  const more = el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Room settings', onclick: () => openSettings(state) }, icon('dots'));
  els.score = el('button', { type: 'button', class: 'score score-btn', 'aria-label': 'Open match intelligence', hidden: !room.match, onclick: () => openMatchSheet(state) },
    el('div', { class: 'skeleton' }));
  els.replayBar = el('div', { class: 'replay-bar', role: 'group', 'aria-label': 'Replay controls', hidden: true });

  els.cohostLabel = el('span', { class: 'cohost-label' });
  els.cohostText = el('p', { class: 'pulse-text' });
  els.reconnect = el('span', { class: 'reconnect-pill', hidden: true, text: 'Reconnecting…' });
  const catchBtn = el('button', { type: 'button', class: 'catchup-btn', text: 'Catch me up', onclick: () => openCatchup(state) });
  els.pollBtn = el('button', { type: 'button', class: 'catchup-btn ghost', text: 'Suggest a poll', hidden: !room.match, onclick: () => suggestPoll(state) });
  const privateBtn = room.room_type === 'public' && room.match
    ? el('button', { type: 'button', class: 'catchup-btn ghost', text: '+ Private room', onclick: () => openQuickPrivate(state) }) : null;
  els.backing = el('div', { class: 'guide backing', hidden: true });
  els.guide = el('div', { class: 'guide', hidden: true });

  els.feed = el('div', { class: 'feed', role: 'log', 'aria-live': 'polite', 'aria-label': 'Watch party messages' });
  els.notice = el('div', { class: 'feed-notice' });
  els.threadHead = el('div', { class: 'thread-head', hidden: true });
  els.feed.append(els.notice, els.threadHead);
  els.threadBar = el('div', { class: 'chips thread-bar', role: 'toolbar', 'aria-label': 'Threads', hidden: true });
  els.scroll = el('div', { class: 'chat-scroll' }, els.feed);
  els.banner = el('div', { class: 'banner', hidden: true });
  els.newPill = el('button', { type: 'button', class: 'new-pill', hidden: true, text: 'New messages', onclick: () => { state.stick = true; scrollToBottom(state); } });
  els.scroll.addEventListener('scroll', () => {
    const s = els.scroll;
    state.stick = s.scrollHeight - s.scrollTop - s.clientHeight < 60;
    if (state.stick) els.newPill.hidden = true;
  });

  els.input = el('input', { id: 'say', maxlength: '500', placeholder: 'Say something, or ask @huddle', 'aria-label': 'Message the room', autocomplete: 'off', enterkeyhint: 'send' });
  els.send = el('button', { type: 'submit', class: 'send', 'aria-label': 'Send' }, icon('send'));
  els.reply = el('div', { class: 'reply-chip', hidden: true });
  els.error = el('div', { class: 'send-error', role: 'alert', hidden: true });
  els.notice2 = el('p', { class: 'send-notice', hidden: true });
  els.cooldown = el('div', { class: 'cooldown', hidden: true }, el('span', { class: 'cooldown-text' }), el('span', { class: 'cooldown-bar' }, el('i')));
  const form = el('form', { class: 'composer', autocomplete: 'off' }, els.input, els.send);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitMessage(state);
  });

  document.getElementById('view')?.replaceChildren(
    el('div', { class: 'masthead' },
      el('header', { class: 'top' }, backButton(state),
        el('div', { class: 'top-title' }, els.title, el('span', { class: 'top-sub' }, els.typeBadge, els.online)),
        people, more),
      els.score, els.replayBar),
    els.cohost = el('section', { class: 'pulse cohost', 'aria-label': 'AI Co-host' },
      el('div', { class: 'pulse-head' }, els.cohostLabel, els.reconnect),
      els.cohostText,
      el('div', { class: 'pulse-foot cohost-actions' }, catchBtn, els.pollBtn, privateBtn),
      els.backing, els.guide),
    els.threadBar,
    el('section', { class: 'chat' }, els.scroll, els.banner, els.newPill),
    el('div', { class: 'composer-wrap' }, el('div', { class: 'composer-status', 'aria-live': 'polite' }, els.reply, els.error, els.notice2, els.cooldown), form),
  );
  applyRoomInfo(state);
  // Offer big-moment notifications once (permission is only requested if they tap Turn on).
  pushPrompt(state.ctx).then((card) => {
    if (card && state === R && els.cohost.isConnected) els.cohost.after(card);
  }).catch(() => {});
}

function applyRoomInfo(state: RoomState) {
  const room = state.room;
  const els = state.els;
  els.title.textContent = room.name || 'Watch party';
  els.typeBadge.textContent = room.room_type === 'public' ? 'Public' : `Private · ${LEVEL_NAMES[room.moderation.level] || 'Balanced'}`;
  els.cohostLabel.replaceChildren(aiLabel(room.ai_enabled ? 'AI Co-host' : 'Match moments'));
  if (!state.lastInsight) {
    els.cohostText.textContent = room.ai_enabled
      ? (room.match ? 'Watching the match with you. Ask @huddle anything about it.' : 'Ask @huddle anything about the room.')
      : 'Big match moments appear here. The AI Co-host is off in this room.';
  }
  els.notice.replaceChildren(
    el('p', {}, el('b', { text: room.ai_enabled ? 'AI Co-host. ' : 'AI Co-host off. ' }), room.ai_notice),
    ...(state.simFans.length ? [el('p', {}, el('b', { text: 'Simulated fans. ' }), 'A scripted crowd reacts to the simulated game in this public watch party. They are labelled, are not real people, and can be hidden in room settings. Private rooms have none.')] : []),
    el('p', {}, el('b', { text: 'Disappearing chat. ' }), room.retention_notice),
    el('p', {}, el('b', { text: room.room_type === 'public' ? 'Public room. ' : `${LEVEL_NAMES[room.moderation.level] || ''} moderation. ` }), room.moderation.notice),
  );
  updatePresence(state, state.presence);
}

function updatePresence(state: RoomState, presence?: Presence) {
  state.presence = presence || state.presence;
  const n = state.presence.online.length;
  // Real people online; the simulated fans (public watch party only) are counted separately, so nobody takes them
  // for real viewers, and listed under their own heading in Members.
  const fans = simulatedFans(state).length;
  if (state.els.online) state.els.online.textContent = ` · ${n} online${fans ? ` · ${fans} simulated fans` : ''}`;
  if (state.els.memberCount) state.els.memberCount.textContent = String(state.members.size + fans);
  state.membersSheet?.refresh();
}

function setReconnecting(state: RoomState, on: boolean) {
  if (state.els.reconnect) state.els.reconnect.hidden = !on;
}

function scrollToBottom(state: RoomState) {
  const s = state.els.scroll;
  if (s) s.scrollTop = s.scrollHeight;
  if (state.els.newPill) state.els.newPill.hidden = true;
}

function showBanner(state: RoomState, text: string) {
  const b = state.els.banner;
  if (!b) return;
  const go = el('button', { type: 'button', text: 'Catch me up', onclick: () => { b.hidden = true; openCatchup(state); } });
  const x = el('button', { type: 'button', class: 'x', 'aria-label': 'Dismiss', onclick: () => { b.hidden = true; } }, icon('close'));
  b.replaceChildren(el('span', { text }), go, x);
  b.hidden = false;
}

function onVisibility(state: RoomState) {
  if (document.hidden) {
    state.hiddenAt = Date.now();
    state.hiddenCursor = state.cursor;
    rememberSeen(state);
    return;
  }
  if (!state.hiddenAt) return;
  const away = Date.now() - state.hiddenAt;
  state.hiddenAt = 0;
  if (away >= 20000 && state.cursor > state.hiddenCursor) {
    state.catchupSince = state.hiddenCursor;
    showBanner(state, 'Welcome back. Here is what you missed.');
  }
}

async function loop(state: RoomState, token: number) {
  let failures = 0;
  while (state.active && state === R && token === state.loopToken) {
    try {
      const vis = document.hidden ? 'hidden' : 'visible';
      // Sending the match version we have lets the server answer as soon as the next ball is in.
      const rev = state.matchRev != null ? `&rev=${encodeURIComponent(state.matchRev)}` : '';
      const r: RoomPoll = await api.get(`/api/rooms/${state.id}/events?after=${state.cursor}&wait=1&vis=${vis}${rev}`, { signal: state.abort.signal });
      if (!state.active || state !== R || token !== state.loopToken) return;
      failures = 0;
      setReconnecting(state, false);
      if (r.room?.status && r.room.status !== 'active') {
        renderEnded(state, { ...state.room, ...r.room });
        return;
      }
      if (r.reset) {
        renderRoom(state.ctx, state.id);
        return;
      }
      applyEvents(state, r.events || []);
      if (r.cursor > state.cursor) state.cursor = r.cursor;
      if (r.presence) updatePresence(state, r.presence);
      if (r.room && (r.room.ai_enabled !== state.room.ai_enabled || (state.room.room_type === 'private' && r.room.moderation_level !== state.room.moderation.level))) {
        refreshRoomInfo(state);
      }
      if (r.match_rev != null && r.match_rev !== state.matchRev) {
        state.matchRev = r.match_rev;
        refreshMatch(state);
      }
    } catch (err) {
      if ((err instanceof Error && err.name === 'AbortError') || !state.active || state !== R) return;
      if (err instanceof ApiError && err.status === 401) { state.ctx.signedOut(); return; }
      if (err instanceof ApiError && (err.status === 403 || err.status === 404)) { renderProblem(state, err); return; }
      if (err instanceof ApiError && err.status === 410) { renderEnded(state, state.room || {}); return; }
      failures += 1;
      setReconnecting(state, true);
      await sleep([1000, 2000, 5000][Math.min(failures - 1, 2)]);
    }
  }
}

async function refreshRoomInfo(state: RoomState) {
  try {
    const boot: RoomBootstrap = await api.get(`/api/rooms/${state.id}`, { signal: state.abort.signal });
    if (state !== R) return;
    if (boot.room.status !== 'active') { renderEnded(state, boot.room); return; }
    state.room = boot.room;
    state.members = new Map(boot.members.map((m) => [m.id, m]));
    applyRoomInfo(state);
    renderRail(state);
  } catch { /* the next poll will try again */ }
}

function applyEvents(state: RoomState, events: RoomEvent[]) {
  for (const ev of events) {
    if (state.seqSeen.has(ev.seq)) continue;
    state.seqSeen.add(ev.seq);
    if (ev.type === 'message' || ev.type === 'message_update') upsertItem(state, 'message', ev.data);
    else if (ev.type === 'poll') upsertItem(state, 'poll', ev.data);
    else if (ev.type === 'insight') {
      const isNew = !state.items.has(`insight:${ev.data.id}`);
      upsertItem(state, 'insight', ev.data);
      if (isNew && (ev.data.priority === 'high' || ev.data.priority === 'medium')) {
        toast([el('b', { text: `${ev.data.label}: ` }), factText(ev.data)], { ms: 8000, tone: ev.data.priority });
      }
    } else if (ev.type === 'member') applyMember(state, ev);
    else if (ev.type === 'thread') addThread(state, ev.data);
    else if (ev.type === 'room') refreshRoomInfo(state);
  }
}

function applyMember(state: RoomState, ev: MemberEvent) {
  const m = ev.data;
  const prev = state.members.get(m.id);
  let line = '';
  if (m.status === 'active') {
    state.members.set(m.id, { id: m.id, handle: m.handle, name: m.name, team: m.team, role: m.role });
    if (!prev) line = `@${m.handle} joined`;
    else if (prev.role !== m.role) line = `@${m.handle} is now ${m.role === 'admin' ? 'an admin' : 'a member'}`;
  } else if (prev) {
    state.members.delete(m.id);
    line = `@${m.handle} ${m.status === 'removed' ? 'was removed' : 'left'}`;
  }
  if (line) upsertItem(state, 'sys', { id: `m${ev.seq}`, seq: ev.seq, text: line });
  updatePresence(state, state.presence);
}

// The label is shown with the fact, so a leading tag that is the label or one of its words ("Big wicket" and
// "WICKET: ...") is dropped. Tags that add meaning ("DROPPED:", "DRS:") stay.
function factText(insight: Insight) {
  const fact = String(insight.fact || '');
  const label = String(insight.label || '').toLowerCase();
  if (!label) return fact;
  const tag = fact.match(/^([A-Za-z][A-Za-z -]*):\s*/);
  if (!tag) return fact;
  const t = tag[1].toLowerCase();
  if (t !== label && !label.split(/\s+/).includes(t)) return fact;
  const rest = fact.slice(tag[0].length).trim();
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

// The Co-host strip shows the latest important match moment (high or medium priority): label once, then the text.
function setCohostLine(state: RoomState, insight: Insight) {
  if (!['high', 'medium'].includes(insight.priority)) return;
  if (state.lastInsight && (state.lastInsight.seq ?? 0) > (insight.seq ?? 0)) return;
  state.lastInsight = insight;
  state.els.cohostText.replaceChildren(el('b', { text: `${insight.label}: ` }), insight.explanation || factText(insight));
}

// `type` says which payload `data` is (the signature pairs them), but TypeScript cannot narrow one parameter by
// another: hence the casts here, in renderItem and in itemThread.
function upsertItem<K extends FeedType>(state: RoomState, type: K, data: FeedData[K]) {
  if (type === 'insight') setCohostLine(state, data as Insight);
  const key = `${type}:${data.id}`;
  const node = renderItem(state, type, data);
  const thread = itemThread(state, type, data);
  const existing = state.items.get(key);
  if (existing) {
    existing.thread = thread;
    if (data.seq != null) existing.seq = data.seq;
    existing.node.replaceWith(node);
    existing.node = node;
    node.hidden = !shown(state, existing);
    return;
  }
  const entry: FeedEntry = { key, node, thread, seq: data.seq ?? Number.MAX_SAFE_INTEGER };
  state.items.set(key, entry);
  const later = [...state.items.values()].filter((e) => e !== entry && e.seq > entry.seq && e.node.isConnected).sort((a, b) => a.seq - b.seq)[0];
  if (later) state.els.feed.insertBefore(node, later.node);
  else state.els.feed.append(node);
  node.hidden = !shown(state, entry);
  if (state.booted && thread && (type === 'message' || type === 'crowd')) bumpThread(state, thread);
  trimFeed(state);
  if (node.hidden) return;
  if (state.stick) scrollToBottom(state);
  else if (state.els.newPill) state.els.newPill.hidden = false;
}

function removeItem(state: RoomState, key: string) {
  const entry = state.items.get(key);
  if (!entry) return;
  entry.node.remove();
  state.items.delete(key);
}

function trimFeed(state: RoomState) {
  if (state.items.size <= MAX_ITEMS) return;
  const oldest = [...state.items.values()].sort((a, b) => a.seq - b.seq).slice(0, state.items.size - MAX_ITEMS);
  for (const e of oldest) removeItem(state, e.key);
}

function renderItem<K extends FeedType>(state: RoomState, type: K, data: FeedData[K]) {
  if (type === 'crowd') return renderCrowd(state, data as FeedData['crowd']);
  if (type === 'message') return (data as ChatMessage).sender?.type === 'ai' ? renderAiMessage(state, data as ChatMessage) : renderMessage(state, data as UserMessage);
  if (type === 'pending') return renderPending(state, data as PendingMessage);
  if (type === 'poll') return renderPoll(state, data as Poll);
  if (type === 'insight') return renderInsight(data as Insight);
  return el('p', { class: 'sys-line', text: (data as FeedData['sys']).text });
}

function avatar(sender: Pick<Sender, 'handle' | 'team'>) {
  return el('span', { class: `avatar ${teamClass(sender.team)}`, 'aria-hidden': 'true', text: initials(sender.handle) });
}

function replyPreview(reply: NonNullable<ChatMessage['reply_to']>) {
  return el('p', { class: 'reply-preview' }, el('b', { text: `@${reply.handle || 'someone'}` }), reply.excerpt ? ` ${reply.excerpt}` : ' (message not available)');
}

function reactionRow(state: RoomState, m: ChatMessage) {
  if (m.status !== 'visible' || !m.reactions?.length) return null;
  return el('div', { class: 'reactions' }, m.reactions.map((r) => el('button', {
    type: 'button', class: `react-btn${r.mine ? ' mine' : ''}`, 'aria-pressed': String(r.mine), 'aria-label': `${r.emoji} ${r.count}${r.mine ? ', you reacted' : ''}`,
    onclick: () => react(state, m, r.emoji, !r.mine),
  }, `${r.emoji} ${r.count}`)));
}

function actionsButton(state: RoomState, m: ChatMessage) {
  return el('button', { type: 'button', class: 'msg-more', 'aria-label': 'Message actions', onclick: () => openMessageActions(state, m) }, icon('dots'));
}

function renderMessage(state: RoomState, m: UserMessage) {
  const member = state.members.get(m.sender.id);
  const row = el('div', { class: `msg${m.mine ? ' you' : ''}${m.status !== 'visible' ? ` ${m.status}` : ''}`, dataset: { id: m.id } });
  const meta = el('div', { class: 'msg-meta' }, el('b', { class: 'handle', text: m.mine ? 'You' : `@${m.sender.handle}` }));
  if (member && ROLE_LABEL[member.role]) meta.append(el('span', { class: 'badge role', text: ROLE_LABEL[member.role] }));
  if (m.sender.team) meta.append(el('span', { class: `badge ${teamClass(m.sender.team)}`, text: m.sender.team }));
  meta.append(el('time', { class: 'msg-time', datetime: m.created_at, text: clock(m.created_at) }));
  if (m.thread) meta.append(threadTag(state, m.thread.id, m.thread.title));
  const body = el('div', { class: 'msg-body' }, meta);
  if (m.reply_to) body.append(replyPreview(m.reply_to));
  if (m.status === 'removed' || m.text == null) body.append(el('p', { class: 'msg-text removed', text: 'Message removed by a moderator.' }));
  else body.append(el('p', { class: 'msg-text', text: m.text }));
  if (m.status === 'held') body.append(el('p', { class: 'msg-flag', text: 'Held for review · only you can see this' }));
  if (m.answer_state === 'ai_unavailable') body.append(el('p', { class: 'msg-note', text: 'The Co-host could not answer right now. Try again in a minute.' }));
  else if (m.answer_state !== null && ['pending', 'ai_claimed'].includes(m.answer_state) && /(^|\s)@huddle\b/i.test(m.text || '')) body.append(el('p', { class: 'msg-note live', text: 'Co-host is answering…' }));
  const reactions = reactionRow(state, m);
  if (reactions) body.append(reactions);
  row.append(avatar(m.sender), body);
  if (m.status === 'visible') {
    row.append(actionsButton(state, m));
    body.addEventListener('click', (e) => { if (e.target instanceof Element && !e.target.closest('button, a')) openMessageActions(state, m); });
  }
  return row;
}

// The first time you watch a sport, its room asks once which team you back (or none). Your name then carries
// that team in every room of the sport; players and changes are in Edit profile.
const myTeam = (state: RoomState) => (state.room.match ? state.ctx.me.sports?.[state.room.match.sport]?.team || null : null);

function renderBacking(state: RoomState) {
  const box = state.els.backing;
  const sport = state.room.match?.sport;
  const s = state.ctx.config.sports?.find((x) => x.sport === sport);
  if (!s || state.ctx.me.sports?.[s.sport]) {
    box.hidden = true;
    return;
  }
  const choose = async (team: string | null) => {
    box.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      state.ctx.me = (await api.put(`/api/me/sports/${sport}`, { team })).user;
      if (state !== R) return;
      box.hidden = true;
      const mine = state.members.get(state.ctx.me.id);
      if (mine) mine.team = team;
      state.membersSheet?.refresh();
      // team is the code of one of s.teams (the buttons below).
      toast(team ? `You're backing ${s.teams.find((t) => t.code === team)!.name}. Pick your ${s.label} players in Edit profile.`
        : `Just watching ${s.label}. You can pick a team any time in Edit profile.`);
    } catch (err) {
      toast(errorMessage(err));
      box.querySelectorAll('button').forEach((b) => { b.disabled = false; });
    }
  };
  box.replaceChildren(
    el('p', { class: 'guide-line' }, el('b', { text: `Who are you backing in ${s.label}? ` }), 'Your team shows next to your name in its rooms.'),
    el('div', { class: 'ask-chips', role: 'group', 'aria-label': `${s.label} team` },
      s.teams.map((t) => el('button', { type: 'button', class: `chip ${teamClass(t.code)}`, text: t.name, onclick: () => choose(t.code) })),
      el('button', { type: 'button', class: 'chip ask-chip ghost', text: 'Just watching', onclick: () => choose(null) })));
  box.hidden = false;
}

// Every room following a match tells newcomers they can ask: example questions fill in "@huddle ..." and the
// checked rules sheet opens even when the AI is off. Answers use the sheet and the moment the question was asked.
async function loadGuide(state: RoomState) {
  try {
    const g: Guide = await api.get(`/api/rooms/${state.id}/guide`, { signal: state.abort.signal });
    if (state !== R) return;
    state.guide = g;
    renderGuide(state);
  } catch { /* the guide is an extra: the room works without it */ }
}

function renderGuide(state: RoomState) {
  const g = state.guide;
  const box = state.els.guide;
  if (!g || !box) return;
  const ai = state.room.ai_enabled;
  box.replaceChildren(
    el('p', { class: 'guide-line' }, el('b', { text: `New to ${g.sport_name}? ` }),
      ai ? 'Ask @huddle about any rule or player: answers use the checked rules sheet and the moment you asked.' : 'The rules sheet explains the rules and the players.'),
    el('div', { class: 'ask-chips' },
      ai ? g.examples.map((q) => el('button', { type: 'button', class: 'chip ask-chip', text: q, onclick: () => askAbout(state, q) })) : null,
      el('button', { type: 'button', class: 'chip ask-chip ghost', text: 'Rules and players', onclick: () => openGuideSheet(state) })));
  box.hidden = false;
}

function askAbout(state: RoomState, question: string) {
  state.els.input.value = `@huddle ${question}`;
  state.els.input.focus();
}

function openGuideSheet(state: RoomState) {
  const g = state.guide!; // opened only from the guide's own button, which renderGuide shows once it has loaded
  const s = openSheet({ title: `${g.sport_name[0].toUpperCase()}${g.sport_name.slice(1)}: rules and players`, lede: 'A short, checked rules sheet. The AI Co-host explains from it when you ask @huddle.' });
  s.body.append(
    el('h3', { text: 'Rules' }),
    el('dl', { class: 'rules-list' }, g.rules.flatMap((r) => [el('dt', { text: r.topic }), el('dd', { text: r.text })])),
    el('h3', { text: 'Players' }),
    el('ul', { class: 'mi-list' }, g.roster.map((p) => el('li', {}, el('b', { text: p.name }), ` · ${p.role}, ${p.team}`))),
    el('p', { class: 'fine', text: 'Real players in a made-up game: the match is a simulated replay, not a live feed.' }));
}

// A private room on this match, started from the public watch party: only the people you invite, no simulated fans.
function openQuickPrivate(state: RoomState) {
  const me = state.ctx.me;
  const s = openSheet({ title: 'Start a private room', lede: 'Watch this match with only the people you invite. Match moments, #threads and the AI Co-host come with it; simulated fans stay here.' });
  const error = el('p', { class: 'form-error', role: 'alert' });
  const name = el('input', { id: 'quick-room-name', maxlength: '40', value: `${me.display_name || me.handle}'s room`.slice(0, 40) });
  const own = el('input', { type: 'checkbox', id: 'quick-own-replay' });
  const picker = friendPicker({ excludeIds: new Set([me.id]) });
  const create = el('button', { type: 'submit', class: 'btn primary', text: 'Create and invite' });
  const form = el('form', { class: 'sheet-form', novalidate: '' },
    el('div', { class: 'field' }, el('label', { for: 'quick-room-name', text: 'Room name' }), name),
    picker.node,
    el('label', { class: 'toggle-row', for: 'quick-own-replay' }, own, el('span', {}, el('b', { text: 'Control the replay yourself' }),
      el('small', { text: 'Off: the room follows this same match, in step with the public watch party. On: your room gets its own copy to start, pause or jump.' }))),
    error,
    sheetActions(el('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: closeSheet }), create));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!name.value.trim()) {
      error.textContent = 'Give the room a name.';
      name.focus();
      return;
    }
    create.disabled = true;
    error.textContent = '';
    try {
      // buildRoom only offers this sheet in a room following a match.
      const r: CreatedRoom = await api.post('/api/rooms', { name: name.value, match_id: state.room.match!.id, own_replay: own.checked, invitee_ids: picker.ids() });
      closeSheet();
      const sent = r.invitations.filter((i) => i.result === 'invited').length;
      toast(sent ? `${plural(sent, 'invitation')} sent.` : 'Private room ready. Invite friends from Members.');
      state.ctx.navigate(`#/room/${r.room_id}`);
    } catch (err) {
      error.textContent = errorMessage(err);
      create.disabled = false;
    }
  });
  s.body.append(form);
}

// The scripted crowd reacting to the simulated replay. The server derives its lines from the match feed, the same
// for everyone in the room; each is shown when due, never stored with the chat, and can be hidden on this device.
const CROWD_KEY = 'huddle:crowd';
const CROWD_LATE_MS = 20000; // a line this overdue (opening the room, coming back) is skipped, not replayed

const simulatedFans = (state: RoomState) => (state.crowdOn && state.simFans ? state.simFans : []);

function crowdPref() {
  try { return localStorage.getItem(CROWD_KEY) !== 'off'; } catch { return true; }
}

function setCrowd(state: RoomState, on: boolean) {
  state.crowdOn = on;
  try { localStorage.setItem(CROWD_KEY, on ? 'on' : 'off'); } catch { /* storage may be unavailable */ }
  updatePresence(state);
  if (!on) {
    for (const t of state.crowdTimers) clearTimeout(t);
    state.crowdTimers.clear();
    for (const key of [...state.items.keys()]) if (key.startsWith('crowd:')) removeItem(state, key);
  }
}

// A simulated fan's line, as the match snapshot sends it (lib/match/crowd.ts).
type CrowdLine = { id: string; at: string; fan: string; team: string; text: string; thread: string | null };

function scheduleCrowd(state: RoomState, lines: CrowdLine[] = []) {
  if (!state.crowdOn) return;
  const now = serverNow();
  for (const c of lines) {
    if (state.crowdSeen.has(c.id)) continue;
    state.crowdSeen.add(c.id);
    const wait = Date.parse(c.at) - now;
    if (wait < -CROWD_LATE_MS) continue;
    const timer = setTimeout(() => {
      state.crowdTimers.delete(timer);
      if (state !== R || !state.crowdOn) return;
      // Sorts after everything already in the feed and before the next real message.
      state.crowdN += 1;
      upsertItem(state, 'crowd', { ...c, seq: state.cursor + 1 - 1 / (state.crowdN + 1) });
    }, Math.max(0, wait));
    state.crowdTimers.add(timer);
  }
}

function renderCrowd(state: RoomState, c: FeedData['crowd']) {
  const thread = threadBySlug(state, c.thread);
  return el('div', { class: 'msg crowd' },
    avatar({ handle: c.fan, team: c.team }),
    el('div', { class: 'msg-body' },
      el('div', { class: 'msg-meta' },
        el('b', { class: 'handle', text: c.fan }),
        el('span', { class: `badge ${teamClass(c.team)}`, text: c.team }),
        el('span', { class: 'badge sim', text: 'Simulated fan' }),
        thread ? threadTag(state, thread.id, thread.title) : null),
      el('p', { class: 'msg-text', text: c.text })));
}

// The match opens a #thread for each big moment and the room opens one for a topic people keep arguing about. The
// chips above the chat filter it to one thread; anything sent from a thread joins it. All chat still shows everything.
const threadBySlug = (state: RoomState, slug: string | null) => (slug ? [...state.threads.values()].find((t) => t.slug === slug) || null : null);

function itemThread<K extends FeedType>(state: RoomState, type: K, data: FeedData[K]) {
  if (type === 'message') return (data as ChatMessage).thread?.id || null;
  if (type === 'pending') return (data as PendingMessage).thread_id || null;
  if (type === 'crowd') return threadBySlug(state, (data as FeedData['crowd']).thread)?.id || null;
  return null;
}

const shown = (state: RoomState, entry: FeedEntry) => state.activeThread === 'all' || entry.thread === state.activeThread;

function threadTag(state: RoomState, id: string, title: string | null) {
  return el('button', { type: 'button', class: 'thread-tag', text: title, 'aria-label': `Open ${title}`, onclick: (e) => {
    e.stopPropagation();
    setThread(state, id);
  } });
}

function addThread(state: RoomState, t: Thread, { quiet = false }: { quiet?: boolean } = {}) {
  const isNew = !state.threads.has(t.id);
  const live = state.threads.get(t.id)?.live || 0;
  state.threads.set(t.id, { ...t, live, lastActive: Date.parse(t.last_active_at) || Date.now(), fresh: isNew && !quiet });
  renderThreadBar(state);
  if (isNew && !quiet) {
    toast([el('b', { text: t.title }), t.source === 'moment' ? ' opened for this moment.' : ' started: the room keeps talking about it.'],
      { action: { label: 'Open', run: () => setThread(state, t.id) } });
  }
}

function bumpThread(state: RoomState, id: string) {
  const t = state.threads.get(id);
  if (!t) return;
  t.live += 1;
  t.lastActive = Date.now();
  renderThreadBar(state);
  if (state.activeThread === id) renderThreadHead(state);
}

function renderThreadHead(state: RoomState) {
  const t = state.threads.get(state.activeThread);
  state.els.notice.hidden = Boolean(t);
  state.els.threadHead.hidden = !t;
  if (!t) return;
  state.els.threadHead.replaceChildren(
    el('h2', { text: t.title }),
    ...(t.about ? [el('p', { text: t.about })] : []),
    el('p', { class: 'meta', text: `${plural(t.messages + t.live, 'message')} · ${t.source === 'moment' ? 'opened by a big moment' : 'started by the room'}` }),
    el('button', { type: 'button', class: 'link-btn', text: 'Back to All chat', onclick: () => setThread(state, 'all') }));
}

function renderThreadBar(state: RoomState) {
  const bar = state.els.threadBar;
  if (!bar) return;
  const threads = [...state.threads.values()].sort((a, b) => b.lastActive - a.lastActive);
  bar.hidden = !threads.length;
  const chip = (id: string, label: string, count?: number, { hot = false, fresh = false }: { hot?: boolean; fresh?: boolean } = {}) => el('button', {
    type: 'button', class: `chip${state.activeThread === id ? ' active' : ''}${fresh ? ' fresh' : ''}`, 'aria-pressed': String(state.activeThread === id),
    onclick: () => setThread(state, id),
  }, hot ? el('span', { class: 'hot', 'aria-hidden': 'true' }) : null, label, count == null ? null : el('span', { class: 'count', text: String(count) }));
  bar.replaceChildren(chip('all', 'All chat'), ...threads.map((t) => {
    const node = chip(t.id, t.title, t.messages + t.live, { hot: Date.now() - t.lastActive < 15000, fresh: t.fresh });
    t.fresh = false;
    return node;
  }));
}

function setThread(state: RoomState, id: string) {
  state.activeThread = state.threads.has(id) ? id : 'all';
  const t = state.threads.get(state.activeThread);
  for (const e of state.items.values()) e.node.hidden = !shown(state, e);
  renderThreadHead(state);
  state.els.input.placeholder = t ? `Reply in ${t.title}` : 'Say something, or ask @huddle';
  renderThreadBar(state);
  state.stick = true;
  scrollToBottom(state);
}

function aiFootnote(ai: AiMeta | null) {
  if (!ai) return 'AI-generated';
  if (ai.type === 'insufficient_data') return 'Not in the match data, so the Co-host will not guess.';
  if (ai.type === 'decline') return 'AI-generated';
  const g = ai.grounding || {};
  const parts = [g.status === 'rules_sheet' ? 'From the checked rules sheet' : 'From verified match data (simulated)'];
  if (ai.asked_at) parts.push(`asked at ${ai.asked_at}`);
  else if (g.data_as_of) parts.push(`as of ${clockSeconds(g.data_as_of)}`);
  if (g.stale) parts.push('may be out of date');
  return parts.join(' · ');
}

function renderAiMessage(state: RoomState, m: ChatMessage) {
  const head = el('div', { class: 'ai-head' }, aiLabel('AI Co-host'));
  if (m.reply_to?.handle) head.append(el('span', { class: 'ai-reply', text: `replying to @${m.reply_to.handle}` }));
  const box = el('div', { class: 'ai-note ai-msg', dataset: { id: m.id } }, head);
  if (m.status === 'removed' || m.text == null) box.append(el('p', { class: 'ai-text removed', text: 'Message removed by a moderator.' }));
  else box.append(el('p', { class: 'ai-text', text: m.text }), el('p', { class: 'sub', text: aiFootnote(m.ai) }));
  const reactions = reactionRow(state, m);
  if (reactions) box.append(reactions);
  if (m.status === 'visible') box.append(actionsButton(state, m));
  return box;
}

function renderPending(state: RoomState, p: PendingMessage) {
  return el('div', { class: `msg you pending${p.failed ? ' failed' : ''}` },
    avatar({ handle: state.ctx.me.handle, team: myTeam(state) }),
    el('div', { class: 'msg-body' },
      el('div', { class: 'msg-meta' }, el('b', { class: 'handle', text: 'You' }), el('span', { class: 'msg-time', text: p.failed ? 'Not sent' : 'Sending…' })),
      el('p', { class: 'msg-text', text: p.text }),
      p.failed ? el('button', { type: 'button', class: 'link-btn', text: 'Retry', onclick: () => deliver(state, p) }) : null));
}

function renderInsight(i: Insight) {
  const box = el('div', { class: `insight ${i.priority}` },
    el('div', { class: 'insight-head' }, el('span', { class: 'insight-label', text: i.label }), el('span', { class: 'insight-meta', text: `Match moment · ${clock(i.occurred_at)}` })),
    el('p', { class: 'insight-fact', text: factText(i) }));
  if (i.explanation) box.append(el('p', { class: 'insight-ai' }, aiLabel('AI explanation'), el('span', { text: i.explanation })));
  box.append(el('p', { class: 'insight-src', text: 'Verified from the match feed · simulated replay (demo data)' }));
  return box;
}

function renderPoll(state: RoomState, p: Poll) {
  const total = p.options.reduce((a, o) => a + o.votes, 0);
  const winner = total ? p.options.reduce((best, o, i, all) => (o.votes > all[best].votes ? i : best), 0) : -1;
  const box = el('div', { class: 'poll', dataset: { id: p.id } },
    el('div', { class: 'poll-head' }, aiLabel(p.source === 'ai' ? 'AI poll' : 'Huddle poll')),
    el('p', { class: 'poll-q', text: p.question }));
  p.options.forEach((o, i) => {
    const pct = total ? Math.round((o.votes / total) * 100) : 0;
    const fill = el('span', { class: 'fill' });
    fill.style.width = `${pct}%`;
    box.append(el('button', {
      type: 'button', class: `poll-opt${p.my_vote === i ? ' mine' : ''}${!p.open && i === winner ? ' winner' : ''}`,
      disabled: !p.open, 'aria-pressed': String(p.my_vote === i), onclick: () => vote(state, p, i),
    }, fill, el('span', { text: o.label }), el('span', { class: 'pct', text: `${pct}%` })));
  });
  const timer = el('span', { class: 'poll-timer', dataset: { closes: p.closes_at, open: String(p.open) }, text: p.open ? 'Open' : 'Closed' });
  box.append(el('div', { class: 'poll-foot' }, el('span', { text: plural(total, 'vote') }), timer));
  if (!p.open && winner >= 0) box.append(el('p', { class: 'poll-result' }, el('em', { text: `${Math.round((p.options[winner].votes / total) * 100)}%` }), ` picked ${p.options[winner].label}`));
  return box;
}

function tick(state: RoomState) {
  if (state !== R) return;
  // Capped at the rule itself: the server-clock estimate is only accurate to about a second.
  const remaining = Math.min(state.ctx.config.chat.cooldown_seconds, Math.ceil((state.cooldownUntil - Date.now()) / 1000));
  const cd = state.els.cooldown;
  if (cd) {
    if (remaining > 0) {
      cd.hidden = false;
      // buildRoom makes the cooldown box with both of these parts.
      cd.querySelector('.cooldown-text')!.textContent = `Next message in ${remaining}s · one message every ${state.ctx.config.chat.cooldown_seconds}s`;
      cd.querySelector<HTMLElement>('.cooldown-bar i')!.style.width = `${Math.max(0, Math.min(100, (remaining / state.ctx.config.chat.cooldown_seconds) * 100))}%`;
      state.els.send.disabled = true;
    } else {
      cd.hidden = true;
      state.els.send.disabled = false;
    }
  }
  for (const t of state.els.feed?.querySelectorAll<HTMLElement>('.poll-timer[data-open="true"]') || []) {
    const left = Math.ceil((new Date(t.dataset.closes!).getTime() - serverNow()) / 1000); // renderPoll sets data-closes on every timer
    t.textContent = left > 0 ? `Closes in ${left}s` : 'Closing…';
  }
  if (state.match && Date.now() % 5000 < 1000) renderFreshness(state);
}

function setError(state: RoomState, message: string, extra: HTMLElement | null = null) {
  const e = state.els.error;
  e.replaceChildren(el('span', { text: message }), ...(extra ? [extra] : []));
  e.hidden = !message;
}

function setNotice(state: RoomState, message: string) {
  state.els.notice2.textContent = message || '';
  state.els.notice2.hidden = !message;
}

function setReply(state: RoomState, m: ChatMessage | null) {
  state.replyTo = m;
  const chip = state.els.reply;
  if (!m) {
    chip.hidden = true;
    chip.replaceChildren();
    return;
  }
  const x = el('button', { type: 'button', class: 'x', 'aria-label': 'Cancel reply', onclick: () => setReply(state, null) }, icon('close'));
  chip.replaceChildren(el('span', {}, 'Replying to ', el('b', { text: m.sender.type === 'ai' ? '@huddle' : `@${m.sender.handle}` })), x);
  chip.hidden = false;
  state.els.input.focus();
}

// A message on its way. Its id is also its client_msg_id, so a retry is not posted twice. It has no seq until the
// server has it, so it sorts after everything else.
type PendingMessage = { id: string; text: string; reply_to: string | null; thread_id: string | null; failed: boolean; seq?: undefined };

function submitMessage(state: RoomState) {
  const text = state.els.input.value.trim();
  if (!text) return;
  if (state.cooldownUntil > Date.now()) {
    setError(state, `One message every ${state.ctx.config.chat.cooldown_seconds} seconds. Hold that thought.`);
    return;
  }
  const pending: PendingMessage = { id: newKey(), text, reply_to: state.replyTo?.id || null, thread_id: state.activeThread === 'all' ? null : state.activeThread, failed: false };
  state.els.input.value = '';
  setReply(state, null);
  setError(state, '');
  setNotice(state, '');
  state.stick = true;
  upsertItem(state, 'pending', pending);
  deliver(state, pending);
}

async function deliver(state: RoomState, pending: PendingMessage) {
  pending.failed = false;
  upsertItem(state, 'pending', pending);
  try {
    const r = await api.post(`/api/rooms/${state.id}/messages`, {
      client_msg_id: pending.id, text: pending.text,
      ...(pending.reply_to ? { reply_to: pending.reply_to } : {}), ...(pending.thread_id ? { thread_id: pending.thread_id } : {}),
    });
    if (state !== R) return;
    removeItem(state, `pending:${pending.id}`);
    upsertItem(state, 'message', r.message);
    if (r.status === 'held') setNotice(state, r.notice || 'Your message is waiting for a quick human review before others can see it.');
    else if (r.notice) setNotice(state, r.notice);
    if (r.cooldown_until) state.cooldownUntil = toLocal(r.cooldown_until);
    tick(state);
  } catch (err) {
    if (state !== R) return;
    if (err instanceof ApiError && err.status === 0) {
      pending.failed = true;
      upsertItem(state, 'pending', pending);
      setError(state, 'Not sent. Check your connection and retry.');
      return;
    }
    removeItem(state, `pending:${pending.id}`);
    if (!state.els.input.value) state.els.input.value = pending.text;
    if (err instanceof ApiError && err.code === 'message_rejected') {
      const review = err.moderation_event_id ? el('button', { type: 'button', class: 'link-btn', text: 'Request a review', onclick: async (e) => {
        e.currentTarget.disabled = true;
        try {
          await api.post('/api/appeals', { moderation_event_id: err.moderation_event_id, note: '' });
          setError(state, 'Review requested. A moderator will take a look.');
        } catch (e2) {
          setError(state, errorMessage(e2));
        }
      } }) : null;
      setError(state, `Not sent. ${err.message}`, review);
    } else if (err instanceof ApiError && err.status === 429) {
      const until = err.cooldown_until ? toLocal(err.cooldown_until) : Date.now() + (err.retry_after || 30) * 1000;
      state.cooldownUntil = Math.max(state.cooldownUntil, until);
      setError(state, err.message);
      tick(state);
    } else if (err instanceof ApiError && err.status === 410) {
      renderEnded(state, state.room);
    } else {
      setError(state, errorMessage(err));
    }
  }
}

async function react(state: RoomState, m: ChatMessage, emoji: string, on: boolean) {
  try {
    await api.put(`/api/rooms/${state.id}/messages/${m.id}/reactions`, { emoji, on });
  } catch (err) {
    toast(errorMessage(err));
  }
}

async function vote(state: RoomState, p: Poll, option: number) {
  try {
    await api.post(`/api/rooms/${state.id}/polls/${p.id}/vote`, { option });
    upsertItem(state, 'poll', { ...p, my_vote: option, options: p.options.map((o, i) => ({ ...o, votes: o.votes + (i === option ? 1 : 0) - (i === p.my_vote ? 1 : 0) })) });
  } catch (err) {
    toast(errorMessage(err));
  }
}

async function suggestPoll(state: RoomState) {
  const b = state.els.pollBtn;
  b.disabled = true;
  try {
    const r = await api.post(`/api/rooms/${state.id}/polls/suggest`, { client_request_id: newKey() });
    toast(r.source === 'ai' ? 'The Co-host posted a poll.' : 'Poll posted (AI unavailable, so Huddle used a standard poll).');
  } catch (err) {
    toast(errorMessage(err));
  } finally {
    setTimeout(() => { b.disabled = false; }, 3000);
  }
}

async function refreshMatch(state: RoomState) {
  if (!state.room?.match) return;
  if (state.matchBusy) { state.matchAgain = true; return; }
  state.matchBusy = true;
  try {
    const snap: MatchSnapshot = await api.get(`/api/rooms/${state.id}/match`, { signal: state.abort.signal });
    if (state !== R) return;
    state.match = snap;
    state.matchFetchedAt = Date.now();
    renderScore(state);
    renderReplayBar(state);
    renderRail(state);
    scheduleCrowd(state, snap.crowd);
    if (state.matchSheet?.isOpen()) state.matchSheet.render();
  } catch (err) {
    if ((err instanceof Error && err.name === 'AbortError') || state !== R) return;
    state.els.score?.replaceChildren(el('p', { class: 'score-error', text: 'Match data is unavailable right now.' }));
  } finally {
    state.matchBusy = false;
    if (state.matchAgain && state === R) {
      state.matchAgain = false;
      refreshMatch(state);
    }
  }
}

const liveAge = (state: RoomState) => (state.match?.freshness?.age_seconds == null ? null : state.match.freshness.age_seconds + (Date.now() - state.matchFetchedAt) / 1000);

function freshnessText(state: RoomState) {
  const m = state.match;
  if (!m) return '';
  if (m.match.status === 'scheduled') return m.replay?.own ? 'Simulated replay · ready to start' : 'Simulated replay · starting soon';
  if (m.match.status === 'completed') return 'Simulated replay · match finished';
  if (m.replay?.paused) return 'Simulated replay · paused';
  const age = liveAge(state);
  if (age == null) return 'Simulated replay · waiting for the first ball';
  return `Simulated replay · updated ${ago(age)}${m.freshness.stale ? ' · data may be stale' : ''}`;
}

function renderFreshness(state: RoomState) {
  for (const n of document.querySelectorAll('[data-freshness]')) n.textContent = freshnessText(state);
}

const ballDot = (s: string) => el('span', { class: `ball-dot r${s}`, text: s === '0' ? '•' : s });

function needBlock(s: CricketScore) {
  const need = el('span', { class: 'score-need' });
  if (s.result) need.append(el('b', { text: s.result }));
  else if (s.chase_won) need.append(el('b', { text: `${s.batting} have won` }));
  else need.append('Need ', el('b', { text: String(s.need_runs) }), ' off ', el('b', { text: String(s.need_balls) }), el('br'), `Target ${s.target} · RRR ${s.rrr ?? '-'}`);
  return need;
}

// The score card under the room title, per sport. Every number comes from the match snapshot (the feed).
function renderScore(state: RoomState) {
  const snap = state.match!; // refreshMatch calls this right after storing the snapshot
  const sport = snap.match.sport || 'cricket';
  const [line, row1, detail] = sport === 'cricket' ? cricketScore(snap) : sport === 'f1' ? f1Score(snap) : teamScore(snap);
  const row2 = el('div', { class: 'score-row' }, detail, el('span', { class: 'replay-tag', 'data-freshness': '', text: freshnessText(state) }));
  state.els.score.replaceChildren(line, row1, row2);
  state.els.score.hidden = false;
}

function cricketScore(snap: MatchSnapshot) {
  const s: CricketScore = snap.score;
  const team = snap.match.teams.find((t) => t.code === s.batting) || { code: s.batting };
  const line = el('div', { class: 'score-line' },
    el('span', { class: 'team-chip' }, teamLogo(team), s.batting),
    el('span', { class: 'score-runs', text: `${s.runs}/${s.wickets}` }),
    el('span', { class: 'score-overs', text: `(${s.overs})` }),
    needBlock(s));
  const batters = s.batters.map((b) => `${b.short}${b.on_strike ? '*' : ''} ${b.runs} (${b.balls})`).join('  ·  ');
  const row1 = el('div', { class: 'score-row' }, el('span', { class: 'score-batters', text: batters }), el('span', { class: 'this-over' }, s.this_over.map(ballDot)));
  return [line, row1, el('span', {}, s.bowler ? ['Bowling ', el('b', { text: s.bowler.short }), ` ${s.bowler.figures}`] : '')];
}

function f1Score(snap: MatchSnapshot) {
  const s: F1Score = snap.score;
  const status = s.result ? el('b', { text: s.result }) : s.safety_car ? el('b', { class: 'flag-sc', text: 'Safety car' }) : [el('b', { text: s.order[0].short }), ' leads'];
  const line = el('div', { class: 'score-line' },
    el('span', { class: 'team-chip sport-chip', text: 'F1' }),
    el('span', { class: 'score-runs', text: `Lap ${s.lap}` }),
    el('span', { class: 'score-overs', text: `/ ${s.total_laps}` }),
    el('span', { class: 'score-need' }, status));
  const row1 = el('div', { class: 'score-row' }, el('span', { class: 'score-batters', text: s.order.slice(0, 3).map((d) => `P${d.pos} ${d.short}${d.pos > 1 ? ` ${d.gap}` : ''}`).join('  ·  ') }));
  return [line, row1, el('span', { text: `Fastest lap ${s.fastest_lap.driver.split(' ').pop()} ${s.fastest_lap.time}` })];
}

// Basketball and hockey: two teams, a period and a clock.
function teamScore(snap: MatchSnapshot) {
  const s = snap.score;
  const [a, b] = s.teams;
  const line = el('div', { class: 'score-line' },
    el('span', { class: 'team-chip sport-chip', text: a.code }),
    el('span', { class: 'score-runs', text: `${a.score}–${b.score}` }),
    el('span', { class: 'team-chip sport-chip', text: b.code }),
    el('span', { class: 'score-need' }, s.result ? el('b', { text: s.result }) : [el('b', { text: s.period }), ` ${s.clock}`]));
  const detail = snap.match.sport === 'basketball'
    ? s.teams.map((t: BasketballTeam) => `${t.leaders[0].short} ${t.leaders[0].pts} pts`).join('  ·  ')
    : `Shots ${a.shots}–${b.shots}${s.power_play ? ` · ${s.power_play.team} power play` : ''}${s.empty_net ? ` · ${s.empty_net} goalie pulled` : ''}`;
  const row1 = el('div', { class: 'score-row' }, el('span', { class: 'score-batters', text: detail }));
  return [line, row1, el('span', { class: 'last-play', text: s.last_play || '' })];
}

function table(headers: string[], rows: (string | number)[][]) {
  return el('table', { class: 'mi-table' },
    el('thead', {}, el('tr', {}, headers.map((h) => el('th', { scope: 'col', text: h })))),
    el('tbody', {}, rows.map((r) => el('tr', {}, r.map((c, i) => (i === 0 ? el('th', { scope: 'row', text: c }) : el('td', { text: c })))))));
}

function matchPanel(state: RoomState, { withControls = true }: { withControls?: boolean } = {}) {
  const snap = state.match;
  if (!snap) return el('p', { class: 'empty', text: 'Loading match data…' });
  const own = snap.replay?.own;
  const status = snap.match.status === 'live' ? (snap.replay?.paused ? 'PAUSED' : 'LIVE · SIMULATED') : snap.match.status === 'scheduled' ? (own ? 'READY' : 'STARTING SOON') : 'FINISHED';
  const wrap = el('div', { class: 'mi' },
    el('div', { class: 'mi-head' },
      el('b', { class: 'mi-title', text: snap.match.title }),
      el('span', { class: `status-pill ${snap.match.status === 'live' && !snap.replay?.paused ? 'live' : ''}`, text: status })),
    el('p', { class: 'mi-fresh', 'data-freshness': '', text: freshnessText(state) }),
    el('p', { class: 'mi-src', text: `${snap.match.source_label}. Every number here comes from the feed, never from the AI.` }),
    ...sportSummary(snap),
    withControls && own ? replayPanel(state) : null,
    withControls && !own ? el('p', { class: 'fine', text: 'Every room following this shared replay sees the same match. For a replay you can start, pause and jump yourself, create a private room with its own replay.' }) : null,
    ...sportDetail(snap),
    el('h3', { text: (snap.match.sport || 'cricket') === 'cricket' ? 'Ball by ball' : 'Play by play' }),
    snap.commentary.length
      ? el('ol', { class: 'commentary' }, snap.commentary.map((c) => el('li', {},
        el('span', { class: `over-tag${c.symbol ? ` r${c.symbol}` : ''}`, text: c.over || c.label || '•' }),
        el('span', { text: c.text }))))
      : el('p', { class: 'mi-meta', text: 'Commentary appears when the replay starts.' }));
  if (withControls && state.ctx.config.demo_controls && snap.moments?.length) {
    const status2 = el('p', { class: 'fine', role: 'status' });
    wrap.append(el('div', { class: 'demo-controls' },
      el('h3', { text: 'Demo controls (simulated replay)' }),
      el('p', { class: 'fine', text: 'Jump the replay to a big moment. This moves the match for every room following it; skipped balls are filled in without alerts.' }),
      el('div', { class: 'controls-row' }, snap.moments.map((m) => el('button', { type: 'button', class: 'ctl', text: m.label, onclick: async (e) => {
        const b = e.currentTarget;
        b.disabled = true;
        try {
          const r = await api.post(`/api/demo/matches/${snap.match.id}/jump`, { moment: m.id });
          status2.textContent = `Jumped to ${r.jumped_to}.`;
          refreshMatch(state);
        } catch (err) {
          status2.textContent = errorMessage(err);
          b.disabled = false;
        }
      } }))),
      status2));
  }
  return wrap;
}

// The match panel's headline lines, per sport; sportDetail adds the tables.
function sportSummary(snap: MatchSnapshot) {
  const s = snap.score;
  const sport = snap.match.sport || 'cricket';
  if (sport === 'cricket') {
    return [
      el('p', { class: 'mi-score' }, el('b', { text: `${s.batting} ${s.runs}/${s.wickets}` }), ` (${s.overs} ov) · ${s.result || (s.chase_won ? `${s.batting} have won` : `need ${s.need_runs} off ${s.need_balls}`)}`),
      el('p', { class: 'mi-meta', text: `Target ${s.target} · CRR ${s.crr ?? '-'} · RRR ${s.rrr ?? '-'} · ${s.first_innings}` }),
    ];
  }
  if (sport === 'f1') {
    return [
      el('p', { class: 'mi-score' }, el('b', { text: `Lap ${s.lap}/${s.total_laps}` }), ` · ${s.result || `${s.order[0].name} leads`}`),
      el('p', { class: 'mi-meta', text: `Safety car: ${s.safety_car ? 'deployed' : 'not out'} · Fastest lap ${s.fastest_lap.driver} ${s.fastest_lap.time}` }),
    ];
  }
  const [a, b] = s.teams;
  return [
    el('p', { class: 'mi-score' }, el('b', { text: `${a.name} ${a.score}–${b.score} ${b.name}` }), ` · ${s.result || `${s.period} ${s.clock}`}`),
    el('p', { class: 'mi-meta', text: sport === 'basketball'
      ? `Team fouls this quarter: ${a.name} ${a.team_fouls}, ${b.name} ${b.team_fouls}`
      : `Shots on goal: ${a.name} ${a.shots}, ${b.name} ${b.shots}${s.power_play ? ` · ${s.power_play.team} power play until ${s.power_play.until}` : ''}` }),
  ];
}

function sportDetail(snap: MatchSnapshot) {
  const s = snap.score;
  const sport = snap.match.sport || 'cricket';
  if (sport === 'cricket') {
    return [
      el('h3', { text: 'Batting' }),
      table(['Batter', 'R', 'B', 'SR'], s.batters.map((b: Batter) => [`${b.name}${b.on_strike ? ' *' : ''}`, b.runs, b.balls, b.strike_rate ?? '-'])),
      el('p', { class: 'mi-meta', text: `Partnership ${s.partnership.runs} (${s.partnership.balls}) since the last wicket in the feed` }),
      el('h3', { text: 'Bowling' }),
      table(['Bowler', 'O-M-R-W', 'Econ'], s.bowling_card.map((b: BowlingFigures) => [b.name, b.figures, b.economy])),
      el('h3', { text: 'Fall of wickets' }),
      s.fall_of_wickets.length
        ? el('ul', { class: 'mi-list' }, s.fall_of_wickets.map((w: FallOfWicket) => el('li', { text: `${w.name} ${w.r} (${w.b}) ${w.how}${w.score ? ` · ${w.score}` : ''}${w.over ? `, ${w.over} ov` : ''}` })))
        : el('p', { class: 'mi-meta', text: 'No wickets yet.' }),
      el('p', { class: 'mi-meta', text: `In the replay feed so far: ${count(s.team_stats.fours_in_feed, 'four', 'fours')} · ${count(s.team_stats.sixes_in_feed, 'six', 'sixes')} · ${count(s.team_stats.dots_in_feed, 'dot ball', 'dot balls')} · ${count(s.team_stats.extras_in_feed, 'extra', 'extras')}` }),
    ];
  }
  if (sport === 'f1') {
    return [el('h3', { text: 'Running order' }),
      table(['Pos', 'Driver', 'Gap', 'Tyre', 'Stops'], s.order.map((d: F1Car) => [`P${d.pos}`, `${d.name} (${d.team})`, d.gap, d.tyre, d.pits]))];
  }
  if (sport === 'basketball') {
    return [el('h3', { text: 'Points' }),
      table(['Player', 'Team', 'Pts'], s.teams.flatMap((t: BasketballTeam) => t.leaders.map((p) => [p.name, t.name, p.pts])))];
  }
  return [
    el('h3', { text: 'Goals this period' }),
    s.goals.length ? el('ul', { class: 'mi-list' }, s.goals.map((g: HockeyGoal) => el('li', { text: `${g.time} ${g.scorer} (${g.team}, ${g.strength})${g.assists.length ? ` · assists ${g.assists.join(', ')}` : ''}` })))
      : el('p', { class: 'mi-meta', text: 'No goals yet this period.' }),
    el('h3', { text: 'Penalties' }),
    s.penalties.length ? el('ul', { class: 'mi-list' }, s.penalties.map((p: HockeyPenalty) => el('li', { text: `${p.time} ${p.player} (${p.team}), ${p.infraction}` })))
      : el('p', { class: 'mi-meta', text: 'No penalties yet this period.' }),
  ];
}

// A private room can run its own copy of the simulated replay. Its owner and admins control it from the bar
// under the score and from the match panel; everyone else sees what the host did (waiting to start, paused).
async function replayAction(state: RoomState, body: ReplayControl, btn: HTMLButtonElement, status: HTMLElement | null) {
  btn.disabled = true;
  try {
    const r = await api.post(`/api/rooms/${state.id}/replay`, body);
    if (status) status.textContent = r.jumped_to ? `Jumped to ${r.jumped_to}.` : '';
    refreshMatch(state);
  } catch (err) {
    if (status) status.textContent = errorMessage(err);
    else toast(errorMessage(err));
    btn.disabled = false;
  }
}

function replayButtons(state: RoomState, { compact = false, status = null }: { compact?: boolean; status?: HTMLElement | null } = {}) {
  // Only replayPanel and renderReplayBar call this, both once the snapshot is in.
  const st = state.match!.match.status;
  const rp = state.match!.replay;
  const ctl = (text: string, body: ReplayControl, extra: Attrs<HTMLButtonElement> = {}) => el('button', { type: 'button', class: 'ctl', text, ...extra, onclick: (e) => replayAction(state, body, e.currentTarget, status) });
  const main = st === 'scheduled' ? ctl('Start replay', { action: 'start' }, { class: 'ctl primary' })
    : st === 'completed' ? ctl('Watch again', { action: 'restart' }, { class: 'ctl primary' })
      : rp.paused ? ctl('Resume', { action: 'resume' }, { class: 'ctl primary' })
        : ctl('Pause', { action: 'pause' });
  const speedName: Record<number, string> = { 0.5: 'Half speed', 1: 'Normal speed', 2: 'Double speed' };
  const speeds = st === 'completed' ? [] : [0.5, 1, 2].map((n) => (rp.speed === n
    ? el('button', { type: 'button', class: 'ctl', 'aria-pressed': 'true', 'aria-label': speedName[n], text: `${n}x` })
    : ctl(`${n}x`, { action: 'speed', speed: n }, { 'aria-pressed': 'false', 'aria-label': speedName[n] })));
  const more = compact
    ? el('button', { type: 'button', class: 'ctl', text: 'Moments', onclick: () => openMatchSheet(state) })
    : st === 'live' ? ctl('Restart', { action: 'restart' }) : null;
  return el('div', { class: 'controls-row' }, main, speeds, more);
}

function replayPanel(state: RoomState) {
  const rp = state.match!.replay; // matchPanel only shows this panel with a snapshot
  if (!rp.can_control) {
    return el('div', { class: 'demo-controls' }, el('h3', { text: 'This room\'s replay' }),
      el('p', { class: 'fine', text: 'This room has its own copy of the simulated replay. The room owner and admins start, pause, speed it up or jump it.' }));
  }
  const status = el('p', { class: 'fine', role: 'status' });
  return el('div', { class: 'demo-controls' },
    el('h3', { text: 'This room\'s replay' }),
    el('p', { class: 'fine', text: 'Your room has its own copy of the simulated replay, so only this room moves. Jumping ahead fills in the skipped balls without alerts; jumping back starts the replay again.' }),
    replayButtons(state, { status }),
    el('p', { class: 'ctl-label', text: 'Jump to a moment' }),
    el('div', { class: 'controls-row' }, rp.moments.map((m) => el('button', {
      type: 'button', class: 'ctl', text: m.label, title: m.passed ? 'Starts the replay again from here' : null,
      onclick: (e) => replayAction(state, { action: 'jump', moment: m.id }, e.currentTarget, status),
    }))),
    status);
}

function renderReplayBar(state: RoomState) {
  const bar = state.els.replayBar;
  const snap = state.match;
  if (!bar || !snap) return;
  const rp = snap.replay;
  const st = snap.match.status;
  if (!rp?.own) {
    bar.hidden = true;
    return;
  }
  if (rp.can_control) {
    bar.replaceChildren(el('span', { class: 'replay-note', text: st === 'scheduled' ? 'Your replay is ready' : 'Your replay' }), replayButtons(state, { compact: true }));
    bar.hidden = false;
    return;
  }
  const note = st === 'scheduled' ? 'Waiting for the host to start the replay.' : st === 'live' && rp.paused ? 'The host paused the replay.' : '';
  bar.replaceChildren(el('span', { class: 'replay-note', text: note }));
  bar.hidden = !note;
}

function openMatchSheet(state: RoomState) {
  if (!state.match) return;
  const s = openSheet({ title: 'Match intelligence' });
  state.matchSheet = { isOpen: s.isOpen, render: () => s.body.replaceChildren(matchPanel(state)) };
  state.matchSheet.render();
}

function renderRail(state: RoomState) {
  if (state !== R) return;
  const room = state.room;
  if (!room) { setRail(railIntro()); return; }
  const mod = room.room_type === 'public' ? 'Moderation managed by Huddle' : `${LEVEL_NAMES[room.moderation.level]} moderation · safety protections always on`;
  setRail(
    el('p', { class: 'rail-kicker', text: room.room_type === 'public' ? 'Public watch party' : 'Private watch party' }),
    el('h1', { class: 'rail-title small', text: room.name }),
    el('ul', { class: 'rail-facts' },
      el('li', { text: mod }),
      el('li', { text: room.ai_enabled ? 'AI Co-host on: answers @huddle from verified match data' : 'AI Co-host off in this room' }),
      el('li', { text: 'Messages disappear when the watch party ends' })),
    room.match ? el('section', { class: 'rail-section', 'aria-label': 'Match intelligence' }, el('p', { class: 'rail-h', text: 'Match intelligence' }), matchPanel(state)) : null,
  );
}

async function openCatchup(state: RoomState) {
  const s = openSheet({ title: 'Catch me up' });
  const label = el('div');
  const slot = el('div', {}, el('div', { class: 'skeleton' }), el('div', { class: 'skeleton' }), el('div', { class: 'skeleton' }));
  s.body.append(label, slot);
  const since = state.catchupSince;
  try {
    const r: CatchUp = await api.post(`/api/rooms/${state.id}/catchup`, since != null ? { since_seq: since } : {});
    if (!s.isOpen()) return;
    state.catchupSince = null;
    rememberSeen(state);
    label.replaceChildren(aiLabel(r.source === 'ai' ? 'AI Co-host summary' : 'Summary from verified match data'));
    slot.replaceChildren(el('p', { class: 'catchup-headline', text: r.headline }));
    if (r.match_points?.length) slot.append(el('h3', { text: 'In the match' }), el('ul', { class: 'bullets' }, r.match_points.map((p) => el('li', { text: p }))));
    if (r.room_points?.length) slot.append(el('h3', { text: 'In the room' }), el('ul', { class: 'bullets' }, r.room_points.map((p) => el('li', { text: p }))));
    if (r.note) slot.append(el('p', { class: 'room-line', text: r.note }));
    slot.append(
      sheetActions(el('button', { type: 'button', class: 'btn primary', text: 'Back to the room', onclick: closeSheet })),
      el('p', { class: 'source', text: `${r.source_label}${r.data_as_of ? ` · data as of ${clockSeconds(r.data_as_of)}` : ''}${r.stale ? ' · may be out of date' : ''}. Only you see this summary.` }));
  } catch (err) {
    if (s.isOpen()) slot.replaceChildren(el('p', { class: 'form-error', text: errorMessage(err) }));
  }
}

function openMessageActions(state: RoomState, m: ChatMessage) {
  const who = m.sender.type === 'ai' ? 'the AI Co-host' : m.mine ? 'you' : `@${m.sender.handle}`;
  const s = openSheet({ title: 'Message' });
  s.body.append(el('blockquote', { class: 'quote' }, el('b', { text: `From ${who}` }), el('span', { text: m.text || '' })));
  const mineSet = new Set((m.reactions || []).filter((r) => r.mine).map((r) => r.emoji));
  s.body.append(el('h3', { text: 'React' }), el('div', { class: 'reaction-grid' }, state.ctx.config.chat.reactions.map((emoji) => el('button', {
    type: 'button', class: `react-pick${mineSet.has(emoji) ? ' mine' : ''}`, 'aria-pressed': String(mineSet.has(emoji)), 'aria-label': `React with ${emoji}`,
    onclick: () => { closeSheet(); react(state, m, emoji, !mineSet.has(emoji)); },
  }, emoji))));
  const list = el('div', { class: 'menu-list' },
    el('button', { type: 'button', class: 'menu-item', text: 'Reply', onclick: () => { closeSheet(); setReply(state, m); } }));
  if (!m.mine) list.append(el('button', { type: 'button', class: 'menu-item danger', text: m.sender.type === 'ai' ? 'Report this AI response' : 'Report message', onclick: () => openReport(state, m) }));
  s.body.append(list);
}

function openReport(state: RoomState, m: ChatMessage) {
  const s = openSheet({ title: m.sender.type === 'ai' ? 'Report AI response' : 'Report message', lede: 'Reports go to Huddle moderators. The author is not told who reported them.' });
  const reasons = el('div', { class: 'choice-list', role: 'radiogroup', 'aria-label': 'Reason' }, REPORT_REASONS.map(([id, label], i) => el('label', { class: 'choice compact', for: `reason-${id}` },
    el('input', { type: 'radio', name: 'reason', id: `reason-${id}`, value: id, checked: i === 0 }), el('span', {}, el('b', { text: label })))));
  const note = el('textarea', { id: 'report-note', maxlength: '200', rows: '2', placeholder: 'Anything else? (optional)' });
  const error = el('p', { class: 'form-error', role: 'alert' });
  const submit = el('button', { type: 'button', class: 'btn primary', text: 'Send report' });
  submit.addEventListener('click', async () => {
    submit.disabled = true;
    try {
      const r = await api.post(`/api/rooms/${state.id}/messages/${m.id}/report`, { reason: reasons.querySelector<HTMLInputElement>('input:checked')!.value, ...(note.value.trim() ? { note: note.value.trim() } : {}) });
      if (!s.isOpen()) return;
      s.body.replaceChildren(el('p', { class: 'lede', text: r.hidden ? 'Thanks. Several members reported this, so it is hidden while a moderator reviews it.' : 'Thanks. A moderator will review it.' }),
        sheetActions(el('button', { type: 'button', class: 'btn primary', text: 'Done', onclick: closeSheet })));
    } catch (err) {
      error.textContent = errorMessage(err);
      submit.disabled = false;
    }
  });
  s.body.append(reasons, el('div', { class: 'field' }, el('label', { for: 'report-note', text: 'Note' }), note), error,
    sheetActions(el('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: closeSheet }), submit));
}

function openMembers(state: RoomState) {
  const room = state.room;
  const s = openSheet({ title: 'Members' });
  const lede = el('p', { class: 'lede' });
  const list = el('ul', { class: 'member-list' });
  const invites = el('div');
  const fanList = el('div');
  s.body.append(lede, list, invites, fanList);
  const render = () => {
    if (!s.isOpen()) return;
    const online = new Set(state.presence.online);
    const fans = simulatedFans(state);
    lede.textContent = `${plural(state.members.size, 'member')} · ${state.presence.online.length} online${fans.length ? ` · ${fans.length} simulated fans` : ''}`;
    fanList.replaceChildren(...(fans.length ? [
      el('h3', { text: `Simulated fans (${fans.length})` }),
      el('p', { class: 'fine', text: 'The scripted crowd of this public watch party. They are not real people and only appear here, never in private rooms.' }),
      el('ul', { class: 'member-list' }, fans.slice(0, 40).map((f) => el('li', { class: 'member-row' },
        avatar(f),
        el('span', { class: 'member-main' }, el('b', { text: f.handle }), el('small', { text: f.team })),
        el('span', { class: 'badge sim', text: 'Simulated fan' })))),
      ...(fans.length > 40 ? [el('p', { class: 'fine', text: `And ${fans.length - 40} more.` })] : []),
    ] : []));
    const order = { owner: 0, admin: 1, member: 2 };
    const members = [...state.members.values()].sort((a, b) => order[a.role] - order[b.role] || String(a.handle).localeCompare(String(b.handle)));
    list.replaceChildren(...members.map((m) => {
      const me = m.id === state.ctx.me.id;
      const actions = el('span', { class: 'member-actions' });
      if (room.room_type === 'private' && room.my_role === 'owner' && !me && m.role !== 'owner') {
        actions.append(el('button', { type: 'button', class: 'ctl', text: m.role === 'admin' ? 'Make member' : 'Make admin', onclick: async (e) => {
          const b = e.currentTarget;
          b.disabled = true;
          try { await api.put(`/api/rooms/${state.id}/members/${m.id}/role`, { role: m.role === 'admin' ? 'member' : 'admin' }); } catch (err) { toast(errorMessage(err)); }
          b.disabled = false;
        } }));
      }
      const canRemove = !me && m.role !== 'owner' && (room.my_role === 'owner' || (room.my_role === 'admin' && m.role === 'member'));
      if (canRemove) {
        actions.append(el('button', { type: 'button', class: 'ctl danger', text: 'Remove', onclick: async () => {
          if (!(await confirmSheet({ title: `Remove @${m.handle}?`, text: 'They lose access to this watch party straight away. They can be invited again later.', confirmLabel: 'Remove', danger: true }))) return;
          try { await api.del(`/api/rooms/${state.id}/members/${m.id}`); toast(`@${m.handle} was removed.`); } catch (err) { toast(errorMessage(err)); }
        } }));
      }
      return el('li', { class: 'member-row' },
        el('span', { class: `online-dot${online.has(m.id) ? ' on' : ''}`, title: online.has(m.id) ? 'Online' : 'Away' }),
        avatar(m),
        el('span', { class: 'member-main' }, el('b', { text: me ? `@${m.handle} (you)` : `@${m.handle}` }), el('small', { text: `${m.name || ''}${online.has(m.id) ? ' · online' : ''}` })),
        ROLE_LABEL[m.role] ? el('span', { class: `role-badge ${m.role}`, text: ROLE_LABEL[m.role] }) : null,
        actions);
    }));
  };
  state.membersSheet = { refresh: render };
  render();
  if (room.room_type === 'private' && room.can_manage) loadInvites(state, s, invites);
  else if (room.room_type === 'public') invites.append(el('p', { class: 'fine', text: 'Anyone signed in can join a public watch party. Moderation is managed by Huddle.' }));
}

async function loadInvites(state: RoomState, s: ReturnType<typeof openSheet>, slot: HTMLElement) {
  const results = el('p', { class: 'fine', role: 'status' });
  const picker = friendPicker({ excludeIds: new Set<string>(state.members.keys()) });
  const invite = el('button', { type: 'button', class: 'btn primary', text: 'Send invitations' });
  const statusList = el('ul', { class: 'invite-list' });
  const refresh = async () => {
    try {
      const r: { invitations: RoomInvitation[] } = await api.get(`/api/rooms/${state.id}/invitations`);
      if (!s.isOpen()) return;
      picker.hide(r.invitations.filter((i) => i.status === 'pending').map((i) => i.user_id));
      statusList.replaceChildren(...(r.invitations.length ? r.invitations.map((i) => el('li', { class: 'invite-row' },
        el('span', { class: 'member-main' }, el('b', { text: `@${i.handle}` }), el('small', { text: i.display_name || '' })),
        el('span', { class: `status-pill inv-${i.status}`, text: i.status }),
        i.status === 'pending' ? el('button', { type: 'button', class: 'ctl', text: 'Revoke', onclick: async (e) => {
          e.currentTarget.disabled = true;
          try { await api.post(`/api/invitations/${i.id}/revoke`); } catch (err) { toast(errorMessage(err)); }
          refresh();
        } }) : null)) : [el('li', { class: 'empty small', text: 'No invitations yet.' })]));
    } catch (err) {
      statusList.replaceChildren(el('li', { class: 'empty small', text: errorMessage(err) }));
    }
  };
  invite.addEventListener('click', async () => {
    const ids = picker.ids();
    if (!ids.length) { results.textContent = 'Pick at least one person.'; return; }
    invite.disabled = true;
    try {
      const r: { invitations: InviteResult[] } = await api.post(`/api/rooms/${state.id}/invitations`, { invitee_ids: ids });
      const ok = r.invitations.filter((i) => i.result === 'invited').length;
      const other = r.invitations.length - ok;
      results.textContent = `${plural(ok, 'invitation')} sent${other ? `, ${other} skipped (already a member, already invited or room full)` : ''}.`;
      refresh();
    } catch (err) {
      results.textContent = errorMessage(err);
    }
    invite.disabled = false;
  });
  slot.append(el('h3', { text: 'Invite more friends' }), picker.node, invite, results, el('h3', { text: 'Invitations' }), statusList);
  refresh();
}

function openSettings(state: RoomState) {
  const room = state.room;
  const s = openSheet({ title: 'Room settings' });
  const msg = el('p', { class: 'fine', role: 'status' });
  if (room.room_type === 'public') {
    s.body.append(el('h3', { text: 'Moderation' }), el('p', { class: 'notice-box' }, icon('shield'), 'Moderation and safety settings are managed by Huddle.'));
  } else if (room.can_manage) {
    const levels = levelChooser(state.ctx.config.moderation.levels, room.moderation.level, 'room-level');
    const save = el('button', { type: 'button', class: 'btn', text: 'Save moderation level', onclick: async () => {
      save.disabled = true;
      try {
        const r: { moderation_level: ModerationLevel } = await api.patch(`/api/rooms/${state.id}/settings`, { moderation_level: levels.value() });
        msg.textContent = `Moderation is now ${LEVEL_NAMES[r.moderation_level]}. It applies to the next message.`;
        refreshRoomInfo(state);
      } catch (err) {
        msg.textContent = errorMessage(err);
      }
      save.disabled = false;
    } });
    const ai = el('input', { type: 'checkbox', id: 'room-ai', checked: room.ai_enabled });
    ai.addEventListener('change', async () => {
      ai.disabled = true;
      try {
        await api.patch(`/api/rooms/${state.id}/settings`, { ai_enabled: ai.checked });
        msg.textContent = ai.checked ? 'AI Co-host is on.' : 'AI Co-host is off. Match moments still appear.';
        refreshRoomInfo(state);
      } catch (err) {
        ai.checked = !ai.checked;
        msg.textContent = errorMessage(err);
      }
      ai.disabled = false;
    });
    s.body.append(el('h3', { text: 'Moderation' }), levels.node, save,
      el('h3', { text: 'AI Co-host' }),
      el('label', { class: 'toggle-row', for: 'room-ai' }, ai, el('span', {}, el('b', { text: 'AI Co-host on' }), el('small', { text: 'Answers @huddle questions, catches members up and suggests polls, using this room\'s recent messages only.' }))),
      msg);
  } else {
    s.body.append(el('h3', { text: 'Moderation' }), el('p', { class: 'notice-box' }, el('b', { text: `${LEVEL_NAMES[room.moderation.level]}. ` }), room.moderation.description || ''),
      el('p', { class: 'fine', text: 'Only the owner or an admin can change room settings.' }));
  }
  const fans = el('input', { type: 'checkbox', id: 'room-crowd', checked: state.crowdOn });
  fans.addEventListener('change', () => setCrowd(state, fans.checked));
  s.body.append(
    el('p', { class: 'field-hint strong', text: 'Mandatory safety protections stay on at every level: threats, hate, sexual harassment and sharing personal details are always blocked.' }),
    ...(state.simFans.length ? [el('h3', { text: 'Simulated fans' }),
      el('label', { class: 'toggle-row', for: 'room-crowd' }, fans, el('span', {}, el('b', { text: 'Show simulated fans' }), el('small', { text: 'The scripted crowd that reacts to the simulated game. They are not real people, and only this device hides them.' })))] : []),
    el('h3', { text: 'Privacy' }),
    el('p', { class: 'fine', text: room.ai_notice }),
    el('p', { class: 'fine', text: room.retention_notice }),
    el('div', { class: 'menu-list' },
      el('button', { type: 'button', class: 'menu-item', text: 'Alert settings', onclick: () => openNotificationSettings(state.ctx.config) }),
      room.my_role === 'owner' && room.room_type === 'private'
        ? el('button', { type: 'button', class: 'menu-item danger', text: 'End watch party', onclick: () => endParty(state) })
        : el('button', { type: 'button', class: 'menu-item danger', text: 'Leave room', onclick: () => leaveParty(state) })),
  );
}

async function endParty(state: RoomState) {
  const ok = await confirmSheet({ title: 'End this watch party?', text: 'Everyone loses access to the chat right away, and messages are deleted from our servers within a day. This cannot be undone.', confirmLabel: 'End watch party', danger: true });
  if (!ok) return;
  try {
    await api.post(`/api/rooms/${state.id}/end`);
    renderEnded(state, state.room);
  } catch (err) {
    toast(errorMessage(err));
  }
}

async function leaveParty(state: RoomState) {
  const ok = await confirmSheet({ title: 'Leave this room?', text: state.room.room_type === 'private' ? 'You will need a new invitation to come back.' : 'You can join the public watch party again any time.', confirmLabel: 'Leave', danger: true });
  if (!ok) return;
  try {
    await api.post(`/api/rooms/${state.id}/leave`);
    state.ctx.navigate('#/');
  } catch (err) {
    toast(errorMessage(err));
  }
}

function renderEnded(state: RoomState, room: { name?: string | null }) {
  const ctx = state.ctx;
  if (R === state) leaveRoom();
  closeSheet();
  setRail(railIntro());
  document.getElementById('view')?.replaceChildren(
    el('div', { class: 'masthead' }, el('header', { class: 'top' }, backButton({ ctx }),
      el('div', { class: 'top-title' }, el('b', { class: 'room-title', text: room?.name || 'Watch party' }), el('span', { class: 'top-sub', text: 'Ended' })))),
    el('div', { class: 'scroll-body' },
      el('div', { class: 'card ended-card' },
        el('h2', { class: 'card-title', text: 'This watch party has ended.' }),
        el('p', { class: 'card-lede', text: 'Messages are no longer available to anyone, and they are deleted from our servers after the retention window.' }),
        el('button', { type: 'button', class: 'btn primary', text: 'Back to home', onclick: () => ctx.navigate('#/') }))),
  );
}

function renderProblem(state: RoomState, err: unknown) {
  const ctx = state.ctx;
  const id = state.id;
  if (R === state) leaveRoom();
  if (err instanceof ApiError && err.status === 401) { ctx.signedOut(); return; }
  const body = el('div', { class: 'card ended-card' });
  if (err instanceof ApiError && err.code === 'join_required') {
    const join = el('button', { type: 'button', class: 'btn primary', text: 'Join the watch party' });
    const error = el('p', { class: 'form-error', role: 'alert' });
    join.addEventListener('click', async () => {
      join.disabled = true;
      try {
        await api.post(`/api/rooms/${id}/join`);
        renderRoom(ctx, id);
      } catch (e) {
        error.textContent = errorMessage(e);
        join.disabled = false;
      }
    });
    body.append(el('h2', { class: 'card-title', text: 'Join this public watch party' }),
      el('p', { class: 'card-lede', text: 'Moderation and safety settings are managed by Huddle.' }), join, error);
  } else {
    const status = err instanceof ApiError ? err.status : undefined; // only Huddle's own errors have one
    body.append(
      el('h2', { class: 'card-title', text: status === 404 ? 'Room not found' : status === 403 ? 'You cannot open this room' : 'Could not open the room' }),
      el('p', { class: 'card-lede', text: status === 404 ? 'It may be private, it may have ended, or the link may be wrong.' : errorMessage(err) }),
      el('button', { type: 'button', class: 'btn primary', text: 'Back to home', onclick: () => ctx.navigate('#/') }));
  }
  setRail(railIntro());
  document.getElementById('view')?.replaceChildren(
    el('div', { class: 'masthead' }, el('header', { class: 'top' }, backButton({ ctx }), el('div', { class: 'top-title' }, el('b', { class: 'room-title', text: 'Watch party' })))),
    el('div', { class: 'scroll-body' }, body),
  );
}
