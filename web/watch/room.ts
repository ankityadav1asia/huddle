// The watch party room: the live scorecard, Catch me up and the invite button, then one panel of swipeable tabs: the
// chat (the AI Co-host's messages, #threads, the composer with its rate limit, and the Dream AI launcher) and the
// match tabs (match.ts), which a tap on the scorecard opens. The server re-authorises every request; this view never
// decides who sees what.
import { api, ApiError, errorMessage, serverNow, newKey, type CreatedRoom, type InviteResult, type ModerationLevel, type Role } from './api.ts';
import { el, icon, aiLabel, initials, teamClass, teamLogo, clock, clockSeconds, ago, plural, toast, setRail, railIntro, type Child } from './ui.ts';
import { openSheet, closeSheet, sheetActions, confirmSheet } from './sheets.ts';
import { friendPicker, levelChooser, LEVEL_NAMES } from './home.ts';
import { mountMatchTabs, MATCH_TABS, type MatchTabs } from './match.ts';
import { swipeTabs, type SwipeTabs } from './tabs.ts';
import { dreamBotLauncher, openDreamBot, type BotOptions } from './bot.ts';
import { openCatchUp } from './catchup.ts';
import type { ReadyCtx } from './app.ts';

const ROLE_LABEL: Partial<Record<Role, string>> = { owner: 'OWNER', admin: 'ADMIN' };
const REPORT_REASONS = [
  ['harassment', 'Harassment or bullying'], ['hate', 'Hate speech'], ['threat', 'Threat or violence'],
  ['spam', 'Spam'], ['personal_info', 'Sharing personal details'], ['sexual', 'Sexual content'],
  ['misinformation', 'Wrong match information'], ['other', 'Something else'],
];
const SAFETY_NOTE = 'Mandatory safety protections stay on at every level: threats, hate, sexual harassment and sharing personal details are always blocked.';
const MAX_ITEMS = 300;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Server payloads: only the fields this view reads (lib/rooms/realtime.ts, lib/chat/hydrate.ts, lib/match/feed.ts).

// The room in the bootstrap. A public room's moderation is Huddle's, with no level; a private room always has one.
type Room = {
  name: string | null;
  status: string;
  ai_enabled: boolean;
  ai_notice: string;
  retention_notice: string;
  match: { id: string; title: string; sport: string } | null;
  my_role: Role;
  can_manage: boolean;
} & (
  | { room_type: 'public'; moderation: { level: null; notice: string } }
  | { room_type: 'private'; moderation: { level: ModerationLevel; description: string; notice: string } }
);

// A member, with the team they back in this room's sport.
interface Member { id: string; handle: string | null; team: string | null; role: Role }

// Who has the room open, and who has it in front (active).
interface Presence { online: string[]; active: string[] }

// One of the fans in the stands: a public room's crowd, which chats along with the game.
interface CrowdFan { handle: string; team: string }

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
  source: string; // 'ai', or a standard poll Huddle posts when no AI wrote one
  options: { label: string; votes: number }[];
  open: boolean;
  closes_at: string;
  my_vote: number | null;
}

// A big match moment (momentum alert). The fact is verified from the match feed; the explanation is the AI's.
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
  crowd_fans: CrowdFan[]; // the public room's crowd; none in private rooms
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

// GET /api/rooms/:id/match: what the scorecard shows. The match tabs fetch their own detail.
interface MatchSnapshot {
  match: { id: string; status: 'scheduled' | 'live' | 'completed'; sport: string; teams: { code: string; name: string; logo?: string }[] };
  freshness: { age_seconds: number | null; stale: boolean };
  // One shape per sport, picked by match.sport, which TypeScript cannot narrow score by: hence any. The one-sport
  // renderers give it their sport's type (below).
  score: any;
  crowd: CrowdLine[];
}

// The scorecard fields shown, per sport (lib/match/scorecard.ts and lib/match/sports/*).
interface Batter { short: string; runs: number; balls: number; on_strike: boolean }
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
interface SideScore { code: string; score: number }
interface BasketballScore {
  period: string;
  clock: string;
  result: string | null;
  teams: (SideScore & { leaders: { short: string; pts: number }[] })[];
  last_play: string;
}
interface KabaddiScore {
  half: number;
  clock: string; // time left in the half
  result: string | null;
  raiding: string;
  do_or_die: boolean;
  teams: SideScore[];
  raiders: { short: string; team: string; raid_points: number }[];
  last_play: string;
}
interface FootballScore {
  minute: string;
  period: string;
  result: string | null;
  teams: SideScore[];
  goals: { team: string; scorer: string; minute: string; penalty: boolean }[];
  cards: { team: string; player: string; minute: string; card: 'yellow' | 'red' }[];
  last_play: string;
}

// An invitation as the room's owner and admins see it (GET /api/rooms/:id/invitations).
interface RoomInvitation { id: string; user_id: string; handle: string; status: string }

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
  // header and scorecard
  title: HTMLElement;
  sub: HTMLSpanElement;
  reconnect: HTMLSpanElement;
  score: HTMLButtonElement;
  // watching strip
  watchers: HTMLButtonElement;
  add: HTMLButtonElement;
  // tabs: the Chat tab's unread count
  unread: HTMLElement;
  // chat
  threadBar: HTMLDivElement;
  scroll: HTMLDivElement;
  feed: HTMLDivElement;
  threadHead: HTMLDivElement;
  banner: HTMLDivElement;
  newPill: HTMLButtonElement;
  // composer
  backing: HTMLDivElement;
  input: HTMLInputElement;
  send: HTMLButtonElement;
  reply: HTMLDivElement;
  error: HTMLDivElement;
  notice: HTMLParagraphElement;
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
  unread: number; // new messages while another tab is open
  // Set by bootstrap() before anything reads them.
  room: Room;
  crowdFans: CrowdFan[];
  bot: BotOptions; // Dream AI's, for its launcher and the room menu: bot.ts reads them each time its window opens
  // Set later, if at all.
  ticker?: number;
  onVis?: () => void;
  membersSheet?: { refresh: () => void };
  tabs?: SwipeTabs;
  matchTabs?: MatchTabs; // when the room follows a game
  composerSize?: ResizeObserver;
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
  state.tabs?.destroy();
  state.matchTabs?.destroy();
  state.composerSize?.disconnect();
  rememberSeen(state);
}

export async function renderRoom(ctx: ReadyCtx, roomId: string) {
  leaveRoom();
  // Cast: room and crowdFans arrive in bootstrap(), and bot and els in buildRoom(), before anything reads them. The
  // presence cast only types its empty lists, which would otherwise be never[].
  const state = {
    id: roomId, ctx, active: true, abort: new AbortController(), items: new Map(), seqSeen: new Set(),
    members: new Map(), presence: { online: [], active: [] } as Presence, cursor: 0, cooldownUntil: 0, replyTo: null,
    match: null, matchFetchedAt: 0, matchRev: null, matchBusy: false, matchAgain: false, stick: true,
    hiddenAt: 0, hiddenCursor: 0, catchupSince: null, loopToken: 0, els: {},
    crowdOn: crowdPref(), crowdSeen: new Set(), crowdTimers: new Set(), crowdN: 0,
    threads: new Map(), activeThread: 'all', booted: false, unread: 0,
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
  state.crowdFans = boot.crowd_fans || [];
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
  renderRail(state);
  if (state.room.match) {
    refreshMatch(state);
    renderBacking(state);
  }
  state.ticker = setInterval(() => tick(state), 1000);
  tick(state);
  state.onVis = () => onVisibility(state);
  document.addEventListener('visibilitychange', state.onVis);
  state.loopToken += 1;
  loop(state, state.loopToken);
}

const COMPETITION: Partial<Record<string, string>> = { cricket: 'IPL T20', kabaddi: 'Pro Kabaddi', football: 'Indian Super League', basketball: 'NBA' };

// A public watch party goes by its game ("MI v CSK"); a private room keeps the name its owner gave it.
const roomTitle = (room: Room) => (room.room_type === 'public' && room.match?.title) || room.name || 'Watch party';

// Top to bottom: the header and the live scorecard, Catch me up and the invite button, then a white panel filling
// the rest of the screen: the tab bar (Chat and, with a game, the match tabs) over the swipeable panels. The Chat tab
// holds the thread chips, the messages and the composer; the match tabs use the full height.
function buildRoom(state: RoomState) {
  const room = state.room;
  const els = state.els;
  els.title = el('b', { class: 'room-title', text: roomTitle(room) });
  els.sub = el('span', { class: 'room-sub' });
  els.reconnect = el('span', { class: 'reconnect-pill', hidden: true, text: 'Reconnecting…' });
  const menu = el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Room menu', onclick: () => openRoomMenu(state) }, icon('dots'));
  els.score = el('button', { type: 'button', class: 'score score-btn', 'aria-label': 'Show the full scorecard', hidden: !room.match, onclick: () => state.tabs?.select(1 + MATCH_TABS.indexOf('Scorecard')) },
    el('div', { class: 'skeleton' }));
  const catchUpBtn = el('button', { type: 'button', class: 'catch-btn', onclick: () => openCatch(state, null) }, icon('spark'), 'Catch me up');
  els.add = el('button', { type: 'button', class: 'add-btn', onclick: () => addFriends(state) },
    el('span', { text: 'Invite friends' }), el('span', { class: 'plus', 'aria-hidden': 'true' }, icon('plus')));

  els.feed = el('div', { class: 'feed', role: 'log', 'aria-live': 'polite', 'aria-label': 'Watch party chat' });
  els.threadHead = el('div', { class: 'thread-head', hidden: true });
  // Shown (by the stylesheet) only while the feed has no messages.
  const empty = el('p', { class: 'feed-empty', text: room.can_manage ? 'No messages yet. Say hello, or tap + to invite friends.' : 'No messages yet. Say hello.' });
  els.feed.append(els.threadHead, empty);
  els.threadBar = el('div', { class: 'chips thread-bar', role: 'toolbar', 'aria-label': 'Threads', hidden: true });
  els.scroll = el('div', { class: 'chat-scroll' }, els.feed);
  els.banner = el('div', { class: 'banner', hidden: true });
  els.newPill = el('button', { type: 'button', class: 'new-pill', hidden: true, text: 'New messages', onclick: () => { state.stick = true; scrollToBottom(state); } });
  els.scroll.addEventListener('scroll', () => {
    const s = els.scroll;
    state.stick = s.scrollHeight - s.scrollTop - s.clientHeight < 60;
    if (state.stick) els.newPill.hidden = true;
  });

  els.backing = el('div', { class: 'backing', hidden: true });
  els.input = el('input', { id: 'say', maxlength: '500', placeholder: 'Say something…', 'aria-label': 'Message the room', autocomplete: 'off', enterkeyhint: 'send' });
  els.send = el('button', { type: 'submit', class: 'send', 'aria-label': 'Send' }, icon('send'));
  els.reply = el('div', { class: 'reply-chip', hidden: true });
  els.error = el('div', { class: 'send-error', role: 'alert', hidden: true });
  els.notice = el('p', { class: 'send-notice', hidden: true });
  els.cooldown = el('div', { class: 'cooldown', hidden: true }, el('span', { class: 'cooldown-text' }), el('span', { class: 'cooldown-bar' }, el('i')));
  const form = el('form', { class: 'composer', autocomplete: 'off' }, els.input, els.send);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitMessage(state);
  });
  const composer = el('div', { class: 'composer-wrap' }, els.backing,
    el('div', { class: 'composer-status', 'aria-live': 'polite' }, els.reply, els.error, els.notice, els.cooldown),
    form);

  // The Chat tab's panel is positioned: the Dream AI launcher sits in its bottom-right corner, just above the
  // composer, however tall the composer grows (the backing prompt, a reply, an error: watch.css reads --composer-h).
  state.bot = {
    roomId: state.id, game: room.match?.title || null, ai: room.ai_enabled,
    catchUp: () => openCatch(state, state.catchupSince),
    situation: () => situation(state),
  };
  const chatPanel = el('div', { class: 'chat-panel' }, els.threadBar, el('div', { class: 'chat' }, els.scroll, els.banner, els.newPill),
    composer, dreamBotLauncher(state.bot));
  state.composerSize = new ResizeObserver(() => chatPanel.style.setProperty('--composer-h', `${composer.offsetHeight}px`));
  state.composerSize.observe(composer);
  const match = room.match ? mountMatchTabs(state.id) : undefined;
  state.matchTabs = match;
  const tabs = swipeTabs('Chat and match', ['Chat', ...(room.match ? MATCH_TABS : [])],
    [chatPanel, ...(match?.panels ?? [])], (i) => onTab(state, i));
  state.tabs = tabs;
  tabs.tablist.hidden = !match; // a room without a game has only the chat
  els.unread = el('b', { class: 'tab-count', 'aria-hidden': 'true', hidden: true });
  tabs.tabs[0].append(els.unread);

  document.getElementById('view')?.replaceChildren(
    el('div', { class: 'masthead room-head' },
      el('header', { class: 'top' }, backButton(state),
        el('div', { class: 'top-title' }, els.title, el('span', { class: 'top-sub' }, els.sub, els.reconnect)),
        menu),
      els.score,
      el('div', { class: 'watch-strip' }, catchUpBtn, els.add)),
    el('div', { class: 'room-panel' }, tabs.tablist, tabs.pager),
  );
  applyRoomInfo(state);
}

// A match tab's first opening fetches the match detail; coming back to the chat clears its unread count.
function onTab(state: RoomState, i: number) {
  if (i === 0) setUnread(state, 0);
  else state.matchTabs?.open();
}

// New messages while another tab is open: a small red count on the Chat tab.
function setUnread(state: RoomState, n: number) {
  state.unread = n;
  const badge = state.els.unread;
  badge.hidden = !n;
  badge.textContent = n > 99 ? '99+' : String(n);
  const tab = state.tabs?.tabs[0];
  if (n) tab?.setAttribute('aria-label', `Chat, ${plural(n, 'new message')}`);
  else tab?.removeAttribute('aria-label');
}

// What counts as a new message for that count: anything posted in the chat by someone else.
function isNewMessage<K extends FeedType>(type: K, data: FeedData[K]) {
  if (type === 'message') return !(data as ChatMessage).mine;
  return type === 'crowd' || type === 'poll' || type === 'insight';
}

function applyRoomInfo(state: RoomState) {
  const room = state.room;
  const els = state.els;
  els.title.textContent = roomTitle(room);
  // The +: a private room's owner and admins invite friends; in a public room anyone can start a private room on
  // the same game with friends.
  const pub = room.room_type === 'public';
  els.add.hidden = pub ? !room.match : !room.can_manage;
  els.add.setAttribute('aria-label', pub ? 'Invite friends to a private room on this game' : 'Invite friends to this room');
  state.bot.game = room.match?.title || null;
  state.bot.ai = room.ai_enabled;
  updatePresence(state);
}

function addFriends(state: RoomState) {
  if (state.room.room_type === 'public') openQuickPrivate(state);
  else openInvites(state);
}

function openBot(state: RoomState) {
  openDreamBot(state.bot);
}

// Where the game stands, in one line for Dream AI: "CSK 135/2 (14.3) · need 52 off 33", "MBSG 2–1 EBFC · 72' · Second half".
function situation(state: RoomState): string | null {
  const snap = state.match;
  if (!snap?.score || snap.match.status === 'scheduled') return null;
  const sport = snap.match.sport || 'cricket';
  if (sport === 'cricket') {
    const s: CricketScore = snap.score;
    const now = `${s.batting} ${s.runs}/${s.wickets} (${s.overs})`;
    if (s.result) return `${now} · ${s.result}`;
    if (s.chase_won) return `${now} · ${s.batting} have won`;
    return s.target ? `${now} · need ${s.need_runs} off ${s.need_balls}` : now;
  }
  const line = (s: { result: string | null; teams: SideScore[] }, when: string) => {
    const [a, b] = s.teams;
    return a && b ? `${a.code} ${a.score}–${b.score} ${b.code} · ${s.result || when}` : null;
  };
  if (sport === 'kabaddi') {
    const s: KabaddiScore = snap.score;
    return line(s, `${s.half === 1 ? '1st half' : '2nd half'} ${s.clock}`);
  }
  if (sport === 'football') {
    const s: FootballScore = snap.score;
    return line(s, `${s.minute} · ${s.period}`);
  }
  const s: BasketballScore = snap.score;
  return line(s, `${s.period} ${s.clock}`);
}

// Catch me up: the match so far, or (after time away) what this person missed. A #thread in it opens that thread.
function openCatch(state: RoomState, since: number | null) {
  openCatchUp({
    roomId: state.id,
    since,
    caughtUp: () => {
      state.catchupSince = null;
      rememberSeen(state);
    },
    showThread: (id) => setThread(state, id),
  });
}

// "Public · 201 watching": people online plus, in a public room, the crowd (unless this device hides it).
function updatePresence(state: RoomState, presence?: Presence) {
  state.presence = presence || state.presence;
  const watching = state.presence.online.length + visibleCrowd(state).length;
  state.els.sub.textContent = `${state.room.room_type === 'public' ? 'Public' : 'Private'} · ${watching} watching`;
  state.membersSheet?.refresh();
}

function setReconnecting(state: RoomState, on: boolean) {
  state.els.reconnect.hidden = !on;
}

function scrollToBottom(state: RoomState) {
  const s = state.els.scroll;
  if (s) s.scrollTop = s.scrollHeight;
  if (state.els.newPill) state.els.newPill.hidden = true;
}

// Coming back to the room: Catch me up summarises what was missed.
function showBanner(state: RoomState, text: string) {
  const b = state.els.banner;
  const go = el('button', { type: 'button', text: 'Catch me up', onclick: () => { b.hidden = true; openCatch(state, state.catchupSince); } });
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
      // Sending the match version we have lets the server answer as soon as the next play is in.
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
        state.matchTabs?.update(); // only once a match tab has been opened
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
    else if (ev.type === 'insight') upsertItem(state, 'insight', ev.data);
    else if (ev.type === 'member') applyMember(state, ev);
    else if (ev.type === 'thread') addThread(state, ev.data);
    else if (ev.type === 'room') refreshRoomInfo(state);
  }
}

function applyMember(state: RoomState, ev: MemberEvent) {
  const m = ev.data;
  const prev = state.members.get(m.id);
  let line = '';
  if (m.status === 'active') {
    state.members.set(m.id, { id: m.id, handle: m.handle, team: m.team, role: m.role });
    if (!prev) line = `@${m.handle} joined`;
    else if (prev.role !== m.role) line = `@${m.handle} is now ${m.role === 'admin' ? 'an admin' : 'a member'}`;
  } else if (prev) {
    state.members.delete(m.id);
    line = `@${m.handle} ${m.status === 'removed' ? 'was removed' : 'left'}`;
  }
  if (line) upsertItem(state, 'sys', { id: `m${ev.seq}`, seq: ev.seq, text: line });
  if (m.id === state.ctx.me.id && prev && prev.role !== m.role) refreshRoomInfo(state); // what the + offers
  updatePresence(state);
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

// `type` says which payload `data` is (the signature pairs them), but TypeScript cannot narrow one parameter by
// another: hence the casts here, in renderItem and in itemThread.
function upsertItem<K extends FeedType>(state: RoomState, type: K, data: FeedData[K]) {
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
  if (state.booted && state.tabs && state.tabs.active() !== 0 && isNewMessage(type, data)) setUnread(state, state.unread + 1);
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
  if (type === 'insight') return renderInsight(state, data as Insight);
  return el('p', { class: 'sys-line', text: (data as FeedData['sys']).text });
}

function avatar(who: Pick<Sender, 'handle' | 'team'>, extra = '') {
  return el('span', { class: `avatar ${teamClass(who.team)}${extra ? ` ${extra}` : ''}`, 'aria-hidden': 'true', text: initials(who.handle) });
}

// The AI Co-host posts as itself, labelled as AI. Big-moment alerts in a room with the AI switched off, and
// standard polls when no AI wrote them, come from Huddle instead.
function poster(ai: boolean) {
  return ai
    ? { cls: 'cohost', face: el('span', { class: 'avatar ai-face', 'aria-hidden': 'true' }, icon('spark')), name: aiLabel('AI Co-host') }
    : { cls: 'huddle', face: el('span', { class: 'avatar huddle-face', 'aria-hidden': 'true', text: 'H' }), name: el('b', { class: 'handle', text: 'Huddle' }) };
}

// The server names the AI Co-host 'huddle' in reply previews, a username nobody can take.
const replyName = (handle: string | null) => (handle === 'huddle' ? 'AI Co-host' : `@${handle || 'someone'}`);

function replyPreview(reply: NonNullable<ChatMessage['reply_to']>) {
  return el('p', { class: 'reply-preview' }, el('b', { text: replyName(reply.handle) }), reply.excerpt ? ` ${reply.excerpt}` : ' (message not available)');
}

function reactionRow(state: RoomState, m: ChatMessage) {
  if (m.status !== 'visible' || !m.reactions?.length) return null;
  return el('div', { class: 'reactions' }, m.reactions.map((r) => el('button', {
    type: 'button', class: `react-btn${r.mine ? ' mine' : ''}`, 'aria-pressed': String(r.mine), 'aria-label': `${r.emoji} ${r.count}${r.mine ? ', you reacted' : ''}`,
    onclick: () => react(state, m, r.emoji, !r.mine),
  }, `${r.emoji} ${r.count}`)));
}

// A visible message opens its actions (react, reply, report) from its ⋯ button or a tap on it.
function actionable(state: RoomState, row: HTMLElement, body: HTMLElement, m: ChatMessage) {
  row.classList.add('act');
  row.append(el('button', { type: 'button', class: 'msg-more', 'aria-label': 'Message actions', onclick: () => openMessageActions(state, m) }, icon('dots')));
  body.addEventListener('click', (e) => { if (e.target instanceof Element && !e.target.closest('button, a')) openMessageActions(state, m); });
}

const timeTag = (at: string) => el('time', { class: 'msg-time', datetime: at, text: clock(at) });

function renderMessage(state: RoomState, m: UserMessage) {
  const member = state.members.get(m.sender.id);
  const row = el('div', { class: `msg${m.mine ? ' you' : ''}${m.status !== 'visible' ? ` ${m.status}` : ''}`, dataset: { id: m.id } });
  const meta = el('div', { class: 'msg-meta' }, el('b', { class: 'handle', text: m.mine ? 'You' : `@${m.sender.handle}` }));
  if (member && ROLE_LABEL[member.role]) meta.append(el('span', { class: 'badge role', text: ROLE_LABEL[member.role] }));
  if (m.sender.team) meta.append(el('span', { class: `badge ${teamClass(m.sender.team)}`, text: m.sender.team }));
  meta.append(timeTag(m.created_at));
  if (m.thread) meta.append(threadTag(state, m.thread.id, m.thread.title));
  const body = el('div', { class: 'msg-body' }, meta);
  if (m.reply_to) body.append(replyPreview(m.reply_to));
  if (m.status === 'removed' || m.text == null) body.append(el('p', { class: 'msg-text removed', text: 'Message removed by a moderator.' }));
  else body.append(el('p', { class: 'msg-text', text: m.text }));
  if (m.status === 'held') body.append(el('p', { class: 'msg-flag', text: 'Held for review · only you can see this' }));
  const reactions = reactionRow(state, m);
  if (reactions) body.append(reactions);
  row.append(avatar(m.sender), body);
  if (m.status === 'visible') actionable(state, row, body, m);
  return row;
}

function aiFootnote(ai: AiMeta | null) {
  if (!ai || ai.type === 'decline') return 'AI-generated';
  if (ai.type === 'insufficient_data') return 'Not in the match data, so the Co-host will not guess.';
  const g = ai.grounding || {};
  const parts = [g.status === 'rules_sheet' ? 'From the checked rules sheet' : 'From verified match data'];
  if (ai.asked_at) parts.push(`asked at ${ai.asked_at}`);
  else if (g.data_as_of) parts.push(`as of ${clockSeconds(g.data_as_of)}`);
  if (g.stale) parts.push('may be out of date');
  return parts.join(' · ');
}

// The Co-host's answer to a question nobody else answered.
function renderAiMessage(state: RoomState, m: ChatMessage) {
  const who = poster(true);
  const body = el('div', { class: 'msg-body' },
    el('div', { class: 'msg-meta' }, who.name, timeTag(m.created_at), m.thread ? threadTag(state, m.thread.id, m.thread.title) : null));
  if (m.reply_to) body.append(replyPreview(m.reply_to));
  if (m.status === 'removed' || m.text == null) body.append(el('p', { class: 'msg-text removed', text: 'Message removed by a moderator.' }));
  else body.append(el('p', { class: 'msg-text', text: m.text }), el('p', { class: 'msg-foot', text: aiFootnote(m.ai) }));
  const reactions = reactionRow(state, m);
  if (reactions) body.append(reactions);
  const row = el('div', { class: `msg ${who.cls}`, dataset: { id: m.id } }, who.face, body);
  if (m.status === 'visible') actionable(state, row, body, m);
  return row;
}

// A big moment, posted in the chat: its label and the verified fact, then the AI's explanation when there is one.
function renderInsight(state: RoomState, i: Insight) {
  const who = poster(state.room.ai_enabled);
  return el('div', { class: `msg ${who.cls} alert ${i.priority}` }, who.face,
    el('div', { class: 'msg-body' },
      el('div', { class: 'msg-meta' }, who.name, timeTag(i.occurred_at)),
      el('p', { class: 'alert-fact' }, el('span', { class: 'alert-tag', text: i.label }), factText(i)),
      i.explanation ? el('p', { class: 'msg-text', text: i.explanation }) : null));
}

function renderPending(state: RoomState, p: PendingMessage) {
  return el('div', { class: `msg you pending${p.failed ? ' failed' : ''}` },
    avatar({ handle: state.ctx.me.handle, team: myTeam(state) }),
    el('div', { class: 'msg-body' },
      el('div', { class: 'msg-meta' }, el('b', { class: 'handle', text: 'You' }), el('span', { class: 'msg-time', text: p.failed ? 'Not sent' : 'Sending…' })),
      el('p', { class: 'msg-text', text: p.text }),
      p.failed ? el('button', { type: 'button', class: 'link-btn', text: 'Retry', onclick: () => deliver(state, p) }) : null));
}

function renderPoll(state: RoomState, p: Poll) {
  const who = poster(p.source === 'ai');
  const total = p.options.reduce((a, o) => a + o.votes, 0);
  const winner = total ? p.options.reduce((best, o, i, all) => (o.votes > all[best].votes ? i : best), 0) : -1;
  const card = el('div', { class: 'poll', dataset: { id: p.id } }, el('p', { class: 'poll-q', text: p.question }));
  p.options.forEach((o, i) => {
    const pct = total ? Math.round((o.votes / total) * 100) : 0;
    const fill = el('span', { class: 'fill' });
    fill.style.width = `${pct}%`;
    card.append(el('button', {
      type: 'button', class: `poll-opt${p.my_vote === i ? ' mine' : ''}${!p.open && i === winner ? ' winner' : ''}`,
      disabled: !p.open, 'aria-pressed': String(p.my_vote === i), onclick: () => vote(state, p, i),
    }, fill, el('span', { text: o.label }), el('span', { class: 'pct', text: `${pct}%` })));
  });
  const timer = el('span', { class: 'poll-timer', dataset: { closes: p.closes_at, open: String(p.open) }, text: p.open ? 'Open' : 'Closed' });
  card.append(el('div', { class: 'poll-foot' }, el('span', { text: plural(total, 'vote') }), timer));
  if (!p.open && winner >= 0) card.append(el('p', { class: 'poll-result' }, el('em', { text: `${Math.round((p.options[winner].votes / total) * 100)}%` }), ` picked ${p.options[winner].label}`));
  return el('div', { class: `msg ${who.cls}` }, who.face,
    el('div', { class: 'msg-body' }, el('div', { class: 'msg-meta' }, who.name, el('span', { class: 'msg-time', text: 'Poll' })), card));
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
      updatePresence(state);
      // team is the code of one of s.teams (the buttons below).
      toast(team ? `You're backing ${s.teams.find((t) => t.code === team)!.name}. Pick your ${s.label} players in Edit profile.`
        : `Just watching ${s.label}. You can pick a team any time in Edit profile.`);
    } catch (err) {
      toast(errorMessage(err));
      box.querySelectorAll('button').forEach((b) => { b.disabled = false; });
    }
  };
  box.replaceChildren(
    el('p', { class: 'backing-q' }, el('b', { text: `Who are you backing in ${s.label}?` }), ' Your team shows next to your name.'),
    el('div', { class: 'backing-teams', role: 'group', 'aria-label': `${s.label} team` },
      s.teams.map((t) => el('button', { type: 'button', class: `chip ${teamClass(t.code)}`, text: t.name, onclick: () => choose(t.code) })),
      el('button', { type: 'button', class: 'chip ghost', text: 'Just watching', onclick: () => choose(null) })));
  box.hidden = false;
}

// A private room on this game, started from the public room: only the people you invite, and no crowd chat.
function openQuickPrivate(state: RoomState) {
  const me = state.ctx.me;
  const s = openSheet({ title: 'Start a private room', lede: 'Watch this game with only the people you invite. Big-moment alerts, #threads, the AI Co-host and Dream AI come with it; the crowd chat stays here.' });
  const error = el('p', { class: 'form-error', role: 'alert' });
  const name = el('input', { id: 'quick-room-name', maxlength: '40', value: `${me.handle}'s room`.slice(0, 40) });
  const picker = friendPicker({ excludeIds: new Set([me.id]) });
  const create = el('button', { type: 'submit', class: 'btn primary', text: 'Create and invite' });
  const form = el('form', { class: 'sheet-form', novalidate: '' },
    el('div', { class: 'field' }, el('label', { for: 'quick-room-name', text: 'Room name' }), name),
    picker.node,
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
      // applyRoomInfo only offers this sheet in a public room following a match.
      const r: CreatedRoom = await api.post('/api/rooms', { name: name.value, match_id: state.room.match!.id, invitee_ids: picker.ids() });
      closeSheet();
      const sent = r.invitations.filter((i) => i.result === 'invited').length;
      toast(sent ? `${plural(sent, 'invitation')} sent.` : 'Private room ready. Invite friends with the + at the top.');
      state.ctx.navigate(`#/room/${r.room_id}`);
    } catch (err) {
      error.textContent = errorMessage(err);
      create.disabled = false;
    }
  });
  s.body.append(form);
}

// The crowd: fans in the stands chatting along in a public room. The server derives their lines from the match
// feed, the same for everyone in the room; each is shown when due, never stored with the chat, and can be hidden on
// this device.
const CROWD_KEY = 'huddle:crowd';
const CROWD_LATE_MS = 20000; // a line this overdue (opening the room, coming back) is skipped, not shown late

const visibleCrowd = (state: RoomState) => (state.crowdOn ? state.crowdFans : []);

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

// A crowd line, as the match snapshot sends it (lib/match/crowd.ts).
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

// A new thread shows up as a chip (it pops in once); there is no toast for it.
function addThread(state: RoomState, t: Thread, { quiet = false }: { quiet?: boolean } = {}) {
  const isNew = !state.threads.has(t.id);
  const live = state.threads.get(t.id)?.live || 0;
  state.threads.set(t.id, { ...t, live, lastActive: Date.parse(t.last_active_at) || Date.now(), fresh: isNew && !quiet });
  renderThreadBar(state);
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
  }, hot ? el('span', { class: 'hot', 'aria-hidden': 'true' }) : null, label, count ? el('span', { class: 'count', text: String(count) }) : null);
  bar.replaceChildren(chip('all', 'All chat'), ...threads.map((t) => {
    const node = chip(t.id, t.title, t.messages + t.live, { hot: Date.now() - t.lastActive < 15000, fresh: t.fresh });
    t.fresh = false;
    return node;
  }));
}

// From a chip or a #tag in the chat, or from Catch me up on any tab: the chat comes into view on that thread.
function setThread(state: RoomState, id: string) {
  state.tabs?.select(0);
  state.activeThread = state.threads.has(id) ? id : 'all';
  const t = state.threads.get(state.activeThread);
  for (const e of state.items.values()) e.node.hidden = !shown(state, e);
  renderThreadHead(state);
  state.els.input.placeholder = t ? `Reply in ${t.title}` : 'Say something…';
  renderThreadBar(state);
  state.stick = true;
  scrollToBottom(state);
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
  state.els.notice.textContent = message || '';
  state.els.notice.hidden = !message;
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
  chip.replaceChildren(el('span', {}, 'Replying to ', el('b', { text: m.sender.type === 'ai' ? 'AI Co-host' : `@${m.sender.handle}` })), x);
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

// From the room menu, which closes on the tap; the server turns away a second poll too soon after the last.
async function suggestPoll(state: RoomState) {
  try {
    const r: { source: string } = await api.post(`/api/rooms/${state.id}/polls/suggest`, { client_request_id: newKey() });
    toast(r.source === 'ai' ? 'The AI Co-host posted a poll.' : 'Poll posted. The AI was unavailable, so Huddle used a standard one.');
  } catch (err) {
    toast(errorMessage(err));
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
    scheduleCrowd(state, snap.crowd);
    if (snap.match.id !== state.room.match?.id) refreshRoomInfo(state); // the room moved on to another game
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
  if (m.match.status === 'scheduled') return 'Starting soon';
  if (m.match.status === 'completed') return 'Match finished';
  const age = liveAge(state);
  if (age == null) return m.match.sport === 'cricket' ? 'Waiting for the first ball' : 'Waiting for the start';
  return m.freshness.stale ? `Last update ${ago(age)}` : '';
}

function renderFreshness(state: RoomState) {
  for (const n of document.querySelectorAll('[data-freshness]')) n.textContent = freshnessText(state);
}

const ballDot = (s: string) => (s === '0'
  ? el('span', { class: 'ball-dot r0', title: 'Dot ball' }, icon('dot'), el('span', { class: 'sr-only', text: 'dot ball' }))
  : el('span', { class: `ball-dot r${s}`, text: s }));

function needBlock(s: CricketScore) {
  const need = el('span', { class: 'score-need' });
  if (s.result) return need;
  if (s.chase_won) need.append(el('b', { text: `${s.batting} have won` }));
  else need.append('Need ', el('b', { text: String(s.need_runs) }), ' off ', el('b', { text: String(s.need_balls) }), el('br'), `Target ${s.target} · RRR ${s.rrr ?? '-'}`);
  return need;
}

// The scorecard under the room title, per sport. Every number comes from the match snapshot (the feed).
function renderScore(state: RoomState) {
  const snap = state.match!; // refreshMatch calls this right after storing the snapshot
  const sport = snap.match.sport || 'cricket';
  const [line, row1, detail] = sport === 'cricket' ? cricketScore(snap) : sport === 'kabaddi' ? kabaddiScore(snap)
    : sport === 'football' ? footballScore(snap) : basketballScore(snap);
  const row2 = el('div', { class: 'score-row' }, detail, el('span', { class: 'fresh-tag', 'data-freshness': '', text: freshnessText(state) }));
  // A result is a sentence ("CSK win by 6 wickets off the final ball"): it gets its own line under the score.
  const result: string | null = snap.score?.result || null;
  state.els.score.replaceChildren(line, ...(result ? [el('p', { class: 'score-result', text: result })] : []), row1, row2);
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
  const row1 = el('div', { class: 'score-row' },
    el('span', { class: 'score-batters' }, icon('bat'), el('span', { class: 'sr-only', text: 'Batting: ' }), batters),
    el('span', { class: 'this-over' }, s.this_over.map(ballDot)));
  return [line, row1, el('span', { class: 'score-bowler' }, ...(s.bowler ? [icon('ball'), el('span', { class: 'sr-only', text: 'Bowling: ' }), el('b', { text: s.bowler.short }), ` ${s.bowler.figures}`] : []))];
}

// Kabaddi, football and basketball: both sides' logos either side of the score, where the game is, a one-line
// detail, and the last play.
function teamScore(snap: MatchSnapshot, s: { result: string | null; teams: SideScore[]; last_play: string }, when: Child, detail: Child) {
  const [a, b] = s.teams;
  const side = (t: SideScore) => el('span', { class: 'team-chip' }, teamLogo(snap.match.teams.find((x) => x.code === t.code) || t), t.code);
  const line = el('div', { class: 'score-line' },
    side(a),
    el('span', { class: 'score-runs', text: `${a.score}–${b.score}` }),
    side(b),
    el('span', { class: 'score-need' }, s.result ? null : when));
  const row1 = el('div', { class: 'score-row' }, el('span', { class: 'score-batters' }, detail));
  return [line, row1, el('span', { class: 'last-play', text: s.last_play || '' })];
}

function basketballScore(snap: MatchSnapshot) {
  const s: BasketballScore = snap.score;
  return teamScore(snap, s, [el('b', { text: s.period }), ` ${s.clock}`],
    s.teams.map((t) => (t.leaders[0] ? `${t.leaders[0].short} ${t.leaders[0].pts} pts` : '')).filter(Boolean).join('  ·  '));
}

function kabaddiScore(snap: MatchSnapshot) {
  const s: KabaddiScore = snap.score;
  const top = s.raiders[0];
  const detail = s.do_or_die && !s.result ? [el('b', { class: 'score-alert', text: 'Do-or-die raid' }), ` · ${s.raiding}`]
    : top ? ['Top raider ', el('b', { text: top.short }), ` (${top.team}) ${plural(top.raid_points, 'pt')}`] : '';
  return teamScore(snap, s, [el('b', { text: s.half === 1 ? '1st half' : '2nd half' }), el('br'), s.clock], detail);
}

// "90+3'" sorts after "90'" and "88'".
function minutes(m: string) {
  const x = /^(\d+)(?:\+(\d+))?/.exec(m);
  return x ? Number(x[1]) + Number(x[2] ?? 0) : 0;
}

function footballScore(snap: MatchSnapshot) {
  const s: FootballScore = snap.score;
  const goal = s.goals[s.goals.length - 1];
  const card = s.cards[s.cards.length - 1];
  // The later of the last goal and the last card; a goal wins a tie.
  const detail = goal && (!card || minutes(goal.minute) >= minutes(card.minute))
    ? ['Goal ', el('b', { text: goal.scorer }), ` ${goal.minute}${goal.penalty ? ' (pen)' : ''} · ${goal.team}`]
    : card ? [el('span', { class: `card-mark ${card.card}`, 'aria-hidden': 'true' }), `${card.card === 'red' ? 'Red' : 'Yellow'} card `, el('b', { text: card.player }), ` ${card.minute} · ${card.team}`]
    : 'No goals yet';
  return teamScore(snap, s, [el('b', { text: s.minute }), el('br'), s.period], detail);
}

function renderRail(state: RoomState) {
  if (state !== R) return;
  const room = state.room;
  const mod = room.room_type === 'public' ? 'Moderation managed by Huddle' : `${LEVEL_NAMES[room.moderation.level]} moderation · safety protections always on`;
  const competition = room.match ? COMPETITION[room.match.sport] : null;
  setRail(
    el('p', { class: 'rail-kicker', text: [competition, room.room_type === 'public' ? 'Public watch party' : 'Private watch party'].filter(Boolean).join(' · ') }),
    el('h1', { class: 'rail-title small', text: roomTitle(room) }),
    el('ul', { class: 'rail-facts' },
      room.match ? el('li', { text: 'Chat, Commentary, Scorecard, Stats and Graphs are tabs: swipe across, or tap the scorecard' }) : null,
      el('li', { text: room.ai_enabled ? 'AI Co-host on: big moments, polls and answers in the chat, labelled as AI' : 'AI Co-host off in this room' }),
      el('li', { text: 'Dream AI, the glowing button above the message box, answers your own questions privately' }),
      el('li', { text: 'Catch me up shows what you missed while you were away' }),
      el('li', { text: mod }),
      el('li', { text: 'Messages disappear when the watch party ends' })),
  );
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

// The room's ⋯ menu: everything that is not the chat.
function openRoomMenu(state: RoomState) {
  const room = state.room;
  const s = openSheet({ title: room.name || 'Watch party' });
  const item = (text: string, onclick: () => void, danger = false) => el('button', { type: 'button', class: `menu-item${danger ? ' danger' : ''}`, text, onclick });
  const hasSettings = room.can_manage || state.crowdFans.length > 0;
  s.body.append(el('div', { class: 'menu-list' },
    item('Room info', () => openRoomInfo(state)),
    item('Members', () => openMembers(state)),
    item('Dream AI', () => { closeSheet(); openBot(state); }),
    room.match ? item('Suggest a poll', () => { closeSheet(); suggestPoll(state); }) : null,
    hasSettings ? item('Room settings', () => openSettings(state)) : null,
    room.my_role === 'owner' && room.room_type === 'private'
      ? item('End watch party', () => endParty(state), true)
      : item('Leave room', () => leaveParty(state), true)));
}

// What used to sit above the chat: moderation, the AI Co-host and how long messages last.
function openRoomInfo(state: RoomState) {
  const room = state.room;
  const s = openSheet({ title: 'Room info' });
  s.body.append(
    el('h3', { text: 'Moderation' }),
    room.room_type === 'public'
      ? el('p', { class: 'notice-box' }, icon('shield'), room.moderation.notice)
      : el('p', { class: 'notice-box' }, el('b', { text: `${LEVEL_NAMES[room.moderation.level]}. ` }), room.moderation.description || ''),
    el('p', { class: 'field-hint strong', text: SAFETY_NOTE }),
    el('h3', { text: 'AI Co-host' }),
    el('p', { class: 'info-line', text: room.ai_notice }),
    el('h3', { text: 'Disappearing chat' }),
    el('p', { class: 'info-line', text: room.retention_notice }),
    ...(state.crowdFans.length ? [el('h3', { text: 'Crowd chat' }),
      el('p', { class: 'info-line', text: 'Fans in the stands chat along with the game in this public room. You can hide them in Room settings.' })] : []),
    ...(room.room_type === 'private' && !room.can_manage ? [el('p', { class: 'fine', text: 'Only the owner or an admin can change room settings.' })] : []),
  );
}

function openSettings(state: RoomState) {
  const room = state.room;
  const s = openSheet({ title: 'Room settings' });
  if (room.room_type === 'private' && room.can_manage) {
    const msg = el('p', { class: 'fine', role: 'status' });
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
        msg.textContent = ai.checked ? 'AI Co-host is on.' : 'AI Co-host is off. Big-moment alerts still appear, from Huddle.';
        refreshRoomInfo(state);
      } catch (err) {
        ai.checked = !ai.checked;
        msg.textContent = errorMessage(err);
      }
      ai.disabled = false;
    });
    s.body.append(el('h3', { text: 'Moderation' }), levels.node, save,
      el('p', { class: 'field-hint strong', text: SAFETY_NOTE }),
      el('h3', { text: 'AI Co-host' }),
      el('label', { class: 'toggle-row', for: 'room-ai' }, ai, el('span', {}, el('b', { text: 'AI Co-host on' }), el('small', { text: 'Explains big moments, suggests polls and answers questions nobody else does, reading this room\'s recent messages only.' }))),
      msg);
  }
  if (state.crowdFans.length) {
    const fans = el('input', { type: 'checkbox', id: 'room-crowd', checked: state.crowdOn });
    fans.addEventListener('change', () => setCrowd(state, fans.checked));
    s.body.append(el('h3', { text: 'Crowd chat' }),
      el('label', { class: 'toggle-row', for: 'room-crowd' }, fans, el('span', {}, el('b', { text: 'Show crowd chat' }), el('small', { text: 'Fans in the stands chatting along with the game. Hiding them changes only this device.' }))));
  }
}

function openMembers(state: RoomState) {
  const room = state.room;
  const s = openSheet({ title: 'Members' });
  const lede = el('p', { class: 'lede' });
  const list = el('ul', { class: 'member-list' });
  const fanList = el('div');
  s.body.append(lede);
  if (room.room_type === 'private' && room.can_manage) s.body.append(el('button', { type: 'button', class: 'btn primary', text: 'Invite friends', onclick: () => openInvites(state) }));
  s.body.append(list, fanList);
  if (room.room_type === 'public') s.body.append(el('p', { class: 'fine', text: 'Anyone signed in can join a public watch party. Moderation is managed by Huddle.' }));
  const render = () => {
    if (!s.isOpen()) return;
    const online = new Set(state.presence.online);
    const fans = visibleCrowd(state);
    lede.textContent = `${plural(state.members.size, 'member')} · ${state.presence.online.length} online`;
    fanList.replaceChildren(...(fans.length ? [
      el('h3', { text: `Fans in the stands (${fans.length})` }),
      el('ul', { class: 'member-list' }, fans.slice(0, 40).map((f) => el('li', { class: 'member-row' },
        avatar(f),
        el('span', { class: 'member-main' }, el('b', { text: f.handle }), el('small', { text: f.team }))))),
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
        el('span', { class: 'member-main' }, el('b', { text: me ? `@${m.handle} (you)` : `@${m.handle}` }), el('small', { text: online.has(m.id) ? 'online' : '' })),
        ROLE_LABEL[m.role] ? el('span', { class: `role-badge ${m.role}`, text: ROLE_LABEL[m.role] }) : null,
        actions);
    }));
  };
  state.membersSheet = { refresh: render };
  render();
}

// A private room's owner and admins invite friends by username, and see how their invitations went.
function openInvites(state: RoomState) {
  const s = openSheet({ title: 'Invite friends' });
  const results = el('p', { class: 'fine', role: 'status' });
  const picker = friendPicker({ excludeIds: new Set<string>(state.members.keys()), label: 'Find friends by username' });
  const invite = el('button', { type: 'button', class: 'btn primary', text: 'Send invitations' });
  const statusList = el('ul', { class: 'invite-list' });
  const refresh = async () => {
    try {
      const r: { invitations: RoomInvitation[] } = await api.get(`/api/rooms/${state.id}/invitations`);
      if (!s.isOpen()) return;
      picker.hide(r.invitations.filter((i) => i.status === 'pending').map((i) => i.user_id));
      statusList.replaceChildren(...(r.invitations.length ? r.invitations.map((i) => el('li', { class: 'invite-row' },
        el('span', { class: 'member-main' }, el('b', { text: `@${i.handle}` })),
        el('span', { class: `status-pill inv-${i.status}`, text: i.status }),
        i.status === 'pending' ? el('button', { type: 'button', class: 'ctl', text: 'Revoke', onclick: async (e) => {
          e.currentTarget.disabled = true;
          try { await api.post(`/api/invitations/${i.id}/revoke`); } catch (err) { toast(errorMessage(err)); }
          refresh();
        } }) : null)) : [el('li', { class: 'empty small', text: 'No invitations yet.' })]));
    } catch (err) {
      if (s.isOpen()) statusList.replaceChildren(el('li', { class: 'empty small', text: errorMessage(err) }));
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
  s.body.append(picker.node, invite, results, el('h3', { text: 'Invitations' }), statusList);
  refresh();
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
