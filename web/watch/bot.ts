// Dream AI: a floating AI chat widget in the room. The room mounts dreamBotLauncher(), a glowing orb just above its
// message box; the orb opens a chat window that rises from the bottom of the phone. Ask it anything about the room's
// game; answers come from POST /api/rooms/:id/bot (verified match data, the sport's rules sheet and roster) and are
// only ever shown to the person who asked, never posted in the room. Each room's conversation is kept in memory while
// the page is open.
import { api, ApiError, errorMessage, newKey } from './api.ts';
import { el, icon, aiLabel, type Child } from './ui.ts';

// POST /api/rooms/:id/bot. With source 'unavailable' the AI could not answer, and answer says so.
interface BotAnswer {
  answer: string;
  background: string | null; // what the AI knows about the players, teams or sport, apart from this game's data
  asked_at: string | null; // the clock or over of the latest play, e.g. "Over 18.4"
  grounding: 'grounded' | 'rules_sheet' | 'insufficient_data' | 'not_applicable' | null;
  source: 'ai' | 'unavailable';
}

// GET /api/rooms/:id/guide: the sport's checked rules sheet, its players and questions to start with.
interface Guide { sport_name: string; examples: string[]; rules: { topic: string; text: string }[]; roster: { name: string; team: string; role: string }[] }

// What the room passes in. catchUp opens the room's Catch me up window. The fields are read each time the window
// opens, so a room may keep one options object and update it.
export interface BotOptions {
  roomId: string;
  game: string | null; // the game the room follows
  ai: boolean; // the room's AI is on; without it, or without a game, Dream AI can only catch you up
  catchUp: () => void;
  situation?: () => string | null; // the live match line, e.g. "CSK 135/2 (14.3) · need 52 off 33"
}

// A question keeps its key, so trying again after a network error cannot be answered twice.
interface Ask { text: string; key: string }

// One bubble of the conversation. until: when a rate limit lifts (epoch ms).
type Turn =
  | { who: 'me'; text: string }
  | { who: 'bot'; state: 'pending' }
  | { who: 'bot'; state: 'answer'; reply: BotAnswer; ask: Ask }
  | { who: 'bot'; state: 'error'; text: string; until: number | null; retry: Ask | null };
type Answered = Extract<Turn, { state: 'answer' }>;
type Failed = Extract<Turn, { state: 'error' }>;

interface Chat {
  roomId: string;
  opts: BotOptions;
  turns: Turn[];
  busy: boolean;
  guide?: Guide | null; // null while loading; undefined until loaded, or after a failure (the next open tries again)
}

// The open window; there is at most one.
interface View { chat: Chat; render: () => void; context: () => void; close: (restoreFocus?: boolean) => void }

const MAX_TURNS = 60;
const chats = new Map<string, Chat>();
const launchers = new Map<string, HTMLButtonElement>(); // each room's orb, which gets focus back when the window closes
let view: View | null = null;
let seq = 0;
let nudged = false; // the "Ask me anything" hint shows once per page load

const canAsk = (o: BotOptions) => Boolean(o.game && o.ai);
const sheetOpen = () => document.getElementById('sheet-layer')?.hidden === false;
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// The floating orb the room puts in its chat panel, just above the message box.
// Entering a room (and opening Dream AI) fans three balls of 0.3 cm out of the red ball to its left, where the
// design puts them: red high up-left, blue up-left, white (with a border) level to the left, 1.5–2 cm out. They
// stay in view for about 10 seconds, then fade. Real centimetres, as designed; angles are above the leftward horizontal.
const BURST = [{ colour: 'red', angle: 62, cm: 1.5 }, { colour: 'blue', angle: 26, cm: 1.9 }, { colour: 'white', angle: 2, cm: 2 }];
function burst(from: HTMLElement) {
  const app = document.getElementById('app');
  if (!app || reducedMotion()) return;
  const box = app.getBoundingClientRect();
  const orb = from.getBoundingClientRect();
  const x = orb.left + orb.width / 2 - box.left;
  const y = orb.top + orb.height / 2 - box.top;
  BURST.forEach(({ colour, angle, cm }, i) => {
    const ball = el('span', { class: `db-burst ${colour}`, 'aria-hidden': 'true' });
    ball.style.left = `${x}px`; // set through the CSSOM: the page's CSP forbids inline style attributes
    ball.style.top = `${y}px`;
    app.append(ball);
    const rad = (angle * Math.PI) / 180;
    const to = `translate(${(-cm * Math.cos(rad)).toFixed(3)}cm, ${(-cm * Math.sin(rad)).toFixed(3)}cm)`;
    ball.animate([
      { transform: 'translate(0, 0) scale(0.3)', opacity: 0 },
      { transform: 'translate(0, 0) scale(1)', opacity: 1, offset: 0.024 },
      { transform: `${to} scale(1.12)`, opacity: 1, offset: 0.08 },
      { transform: `${to} scale(1)`, opacity: 1, offset: 0.1 },
      { transform: `${to} scale(1)`, opacity: 1, offset: 0.962 },
      { transform: `${to} scale(0.8)`, opacity: 0 },
    ], { duration: 10600, delay: i * 90, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)', fill: 'backwards' }).finished
      .then(() => ball.remove(), () => ball.remove());
  });
}

export function dreamBotLauncher(opts: BotOptions): HTMLElement {
  const nudge = el('div', { class: 'db-nudge', 'aria-hidden': 'true', hidden: true, text: 'Ask me anything about this match', onclick: () => launch() });
  const orb = el('button', { type: 'button', class: 'db-orb', 'aria-label': 'Dream AI: ask the AI about the game', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', onclick: () => launch() }, icon('seam'));
  const wrap = el('div', { class: 'db-launch' }, orb, el('span', { class: 'db-tip', 'aria-hidden': 'true', text: 'Ask Dream AI' }), nudge);
  launchers.set(opts.roomId, orb);
  const hideNudge = () => {
    if (nudge.hidden || nudge.classList.contains('out')) return;
    nudge.classList.add('out');
    setTimeout(() => { nudge.hidden = true; }, reducedMotion() ? 0 : 240);
  };
  function launch() {
    hideNudge();
    burst(orb);
    openDreamBot(opts);
  }
  // The balls greet each room as it opens, once the orb is on screen.
  setTimeout(() => { if (wrap.isConnected && !document.hidden) burst(orb); }, 650);
  if (!nudged && canAsk(opts)) {
    setTimeout(() => {
      if (nudged || !wrap.isConnected || view) return;
      nudged = true;
      nudge.hidden = false;
      setTimeout(hideNudge, 6500);
    }, 1500);
  }
  return wrap;
}

export function openDreamBot(opts: BotOptions): void {
  const chat = chats.get(opts.roomId) || { roomId: opts.roomId, opts, turns: [], busy: false };
  chats.set(opts.roomId, chat);
  chat.opts = opts;
  if (view?.chat === chat) return;
  view?.close(false);
  view = mount(chat);
  if (canAsk(opts) && chat.guide === undefined) loadGuide(chat);
}

// The chat window: a header with the live match line, the conversation (or a welcome), suggestions and the input.
// It sits over the whole app, inside the phone frame; Escape, the backdrop and the close button shut it.
function mount(chat: Chat): View {
  const opts = chat.opts;
  const asks = canAsk(opts);
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const finePointer = matchMedia('(pointer: fine)').matches; // on a phone, opening the keyboard by itself gets in the way
  const id = (seq += 1);
  const nodes = new WeakMap<Turn, HTMLElement>();
  let closed = false;

  const context = el('p', { class: 'db-ctx', hidden: true });
  const head = el('div', { class: 'db-head' },
    avatar('lg'),
    el('div', { class: 'db-id' },
      el('h2', { id: `db-title-${id}`, class: 'db-name' }, 'Dream AI', aiLabel('AI')),
      el('p', { class: 'db-status' }, el('span', { class: 'db-live', 'aria-hidden': 'true' }), 'Match analyst · reads the live scorecard')),
    el('button', { type: 'button', class: 'db-x', 'aria-label': 'Close Dream AI', onclick: () => self.close() }, icon('close')),
    context);

  const welcomeChips = el('div', { class: 'db-suggest', role: 'group', 'aria-label': 'Suggestions' });
  const welcome = el('div', { class: 'db-welcome' },
    avatar('xl'),
    el('p', { class: 'db-hello', text: 'Hi, I\'m Dream AI' }),
    el('p', { class: 'db-lede', text: asks ? `Ask me anything about ${opts.game}. I answer from verified match data and the sport's rules sheet, and tell you when the data does not say instead of guessing.`
      : opts.game ? 'The AI is off in this room, so I can only catch you up, from match data.'
        : 'This room is not following a game, so I can only catch you up.' }),
    welcomeChips);
  const log = el('div', { class: 'db-log', role: 'log', 'aria-live': 'polite', 'aria-label': 'Your conversation with Dream AI' });
  const scroller = el('div', { class: 'db-scroll' }, welcome, log);

  const row = el('div', { class: 'db-row', role: 'group', 'aria-label': 'Suggestions', hidden: true });
  const input = el('input', { class: 'db-input', id: `db-question-${id}`, maxlength: '300', placeholder: 'Ask about the game, a player or a rule', 'aria-label': 'Ask Dream AI', autocomplete: 'off', enterkeyhint: 'send' });
  const send = el('button', { type: 'submit', class: 'db-send', 'aria-label': 'Ask' }, icon('send'));
  const form = el('form', { class: 'db-compose', autocomplete: 'off' }, input, send);
  input.addEventListener('input', () => form.classList.toggle('ready', input.value.trim() !== ''));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || chat.busy) return;
    input.value = '';
    form.classList.remove('ready');
    ask(chat, { text, key: newKey() });
  });
  const main = el('div', { class: 'db-body' }, scroller,
    el('div', { class: 'db-foot' }, row, asks ? form : null, asks ? el('p', { class: 'db-fine', text: 'Only you see these answers' }) : null));
  const rules = el('section', { class: 'db-rules', hidden: true });
  const panel = el('div', { class: 'db-panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': `db-title-${id}`, tabindex: '-1' }, head, main, rules);
  const layer = el('div', { class: 'db-layer' }, el('div', { class: 'db-backdrop', onclick: () => self.close() }), panel);

  function focusHome() {
    if (asks && finePointer && !main.hidden) input.focus({ preventScroll: true });
    else panel.focus({ preventScroll: true });
  }

  const chip = (text: string, kind: string, run: () => void, disabled = false) =>
    el('button', { type: 'button', class: `db-chip ${kind}`, disabled, onclick: run }, icon(kind === 'catch' ? 'spark' : kind === 'rules' ? 'shield' : 'send'), el('span', { text }));

  // Catch me up, the guide's questions, then the rules and players. The room's Catch me up opens its own window.
  function suggestions(): HTMLElement[] {
    const g = chat.guide;
    return [
      chip('Catch me up', 'catch', () => { self.close(); chat.opts.catchUp(); }),
      ...(asks && g ? g.examples.map((q) => chip(q, 'ask', () => { ask(chat, { text: q, key: newKey() }); focusHome(); }, chat.busy)) : []),
      ...(asks && g === null ? [el('span', { class: 'db-chip-wait', 'aria-hidden': 'true' }), el('span', { class: 'db-chip-wait short', 'aria-hidden': 'true' })] : []),
      ...(asks && g ? [chip('Rules and players', 'rules', showRules)] : []),
    ];
  }

  // Swapping the chips keeps keyboard focus on the same suggestion.
  function setChips(box: HTMLElement, list: HTMLElement[]) {
    const at = document.activeElement;
    const focused = at instanceof HTMLElement && box.contains(at) ? at.textContent : null;
    box.replaceChildren(...list);
    if (focused != null) list.find((c) => c.textContent === focused)?.focus();
  }

  function bubble(t: Turn): HTMLElement {
    if (t.who === 'me') return el('div', { class: 'db-msg me' }, el('p', { class: 'db-bubble' }, el('span', { class: 'sr-only', text: 'You: ' }), t.text));
    const bot = (kind: string, ...body: Child[]) => el('div', { class: `db-msg bot ${kind}` }, avatar(),
      el('div', { class: 'db-bubble' }, el('span', { class: 'sr-only', text: 'Dream AI: ' }), body));
    const again = (run: () => void) => el('button', { type: 'button', class: 'db-retry', onclick: () => { run(); focusHome(); } }, 'Try again');
    if (t.state === 'pending') {
      return bot('thinking', el('span', { class: 'db-dots', 'aria-hidden': 'true' }, el('i'), el('i'), el('i')), el('span', { class: 'db-shimmer', text: 'Thinking' }));
    }
    if (t.state === 'error') {
      return bot('error', el('p', { text: t.text }), t.until ? waitLine(t.until) : null, t.retry ? again(() => retry(chat, t)) : null);
    }
    const r = t.reply;
    if (r.source !== 'ai') return bot('muted', el('p', { class: 'db-answer', text: r.answer }), provenance(r), again(() => askAgain(chat, t)));
    return bot('answer', r.answer ? el('p', { class: 'db-answer', text: r.answer }) : null, r.answer ? provenance(r) : null,
      r.background ? el('div', { class: 'db-bg' }, el('p', { class: 'db-bg-label' }, icon('ai'), 'From AI knowledge · not from the match data'), el('p', { class: 'db-bg-text', text: r.background })) : null);
  }

  function render() {
    const talking = chat.turns.length > 0;
    welcome.hidden = talking;
    row.hidden = !talking;
    setChips(welcomeChips, talking ? [] : suggestions());
    setChips(row, talking ? suggestions() : []);
    send.disabled = chat.busy;
    // Keep the bubbles already shown, so they do not animate again; drop replaced ones and add new ones.
    const want = chat.turns.map((t) => {
      const n = nodes.get(t) || bubble(t);
      nodes.set(t, n);
      return n;
    });
    const keep = new Set<Element>(want);
    for (const c of Array.from(log.children)) if (!keep.has(c)) c.remove();
    want.forEach((n, i) => { if (log.children[i] !== n) log.insertBefore(n, log.children[i] || null); });
    // Follow the conversation; a long answer shows from its first line.
    const last = log.lastElementChild;
    if (talking && last instanceof HTMLElement) {
      scroller.scrollTop = last.offsetHeight > scroller.clientHeight - 24 ? last.offsetTop - 12 : scroller.scrollHeight;
    }
  }

  // The sport's checked rules sheet and players, in the window; the back button returns to the conversation.
  let readAt = 0;
  function showRules() {
    const g = chat.guide;
    if (!g) return;
    const title = el('h3', { id: `db-rules-${id}`, class: 'db-rules-title', tabindex: '-1', text: `${g.sport_name[0].toUpperCase()}${g.sport_name.slice(1)}: rules and players` });
    rules.replaceChildren(
      el('button', { type: 'button', class: 'db-back', onclick: hideRules }, icon('back'), 'Back to chat'),
      title,
      el('p', { class: 'db-rules-lede', text: 'A short, checked rules sheet. Dream AI and the AI Co-host answer rule and player questions from it.' }),
      el('h4', { text: 'Rules' }),
      el('dl', { class: 'db-rule-list' }, g.rules.map((r) => el('div', {}, el('dt', { text: r.topic }), el('dd', { text: r.text })))),
      el('h4', { text: 'Players' }),
      el('ul', { class: 'db-roster' }, g.roster.map((p) => el('li', {}, el('b', { text: p.name }), el('span', { text: `${p.role}, ${p.team}` })))));
    rules.setAttribute('aria-labelledby', title.id);
    readAt = scroller.scrollTop;
    main.hidden = true;
    rules.hidden = false;
    rules.scrollTop = 0;
    title.focus({ preventScroll: true });
  }
  function hideRules() {
    rules.hidden = true;
    rules.replaceChildren();
    main.hidden = false;
    scroller.scrollTop = readAt;
    const back = Array.from(main.querySelectorAll<HTMLElement>('.db-chip.rules')).find((c) => c.getClientRects().length > 0);
    if (back) back.focus();
    else focusHome();
  }

  // Focus stays in the window while it is open; a sheet opened over it handles its own keys.
  const onKey = (e: KeyboardEvent) => {
    if (sheetOpen()) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      self.close();
    } else if (e.key === 'Tab') trapTab(panel, e);
  };
  const onFocus = (e: FocusEvent) => {
    if (!sheetOpen() && e.target instanceof Node && !panel.contains(e.target)) focusHome();
  };
  const onRoute = () => self.close(false);
  // A rate limit counts down while the window is open.
  const timer = setInterval(() => {
    for (const n of log.querySelectorAll<HTMLElement>('[data-until]')) n.textContent = waitText(Number(n.dataset.until));
  }, 1000);

  const self: View = {
    chat,
    render,
    context: () => {
      const line = chat.opts.situation?.() || null;
      context.hidden = !line;
      context.replaceChildren(...(line ? [el('span', { class: 'db-ctx-dot', 'aria-hidden': 'true' }), el('span', { class: 'sr-only', text: 'Match situation: ' }), el('span', { text: line })] : []));
    },
    close: (restoreFocus = true) => {
      if (closed) return;
      closed = true;
      if (view === self) view = null;
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('focusin', onFocus);
      removeEventListener('hashchange', onRoute);
      clearInterval(timer);
      const orb = launchers.get(chat.roomId);
      orb?.setAttribute('aria-expanded', 'false');
      layer.classList.add('closing');
      setTimeout(() => layer.remove(), reducedMotion() ? 0 : 200);
      if (restoreFocus) (orb?.isConnected ? orb : opener?.isConnected ? opener : null)?.focus();
    },
  };

  (document.getElementById('app') || document.body).append(layer);
  document.addEventListener('keydown', onKey);
  document.addEventListener('focusin', onFocus);
  addEventListener('hashchange', onRoute);
  launchers.get(chat.roomId)?.setAttribute('aria-expanded', 'true');
  self.context();
  render();
  requestAnimationFrame(() => { if (!closed) focusHome(); });
  return self;
}

function trapTab(panel: HTMLElement, e: KeyboardEvent) {
  const stops = Array.from(panel.querySelectorAll<HTMLElement>('button, input, [href]'))
    .filter((n) => !n.matches(':disabled') && n.getClientRects().length > 0);
  if (!stops.length) return;
  const first = stops[0];
  const last = stops[stops.length - 1];
  const at = document.activeElement;
  const outside = !(at instanceof Node) || !panel.contains(at);
  if (e.shiftKey ? outside || at === first || at === panel : outside || at === last) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
  }
}

const avatar = (size = '') => el('span', { class: `db-avatar${size ? ` ${size}` : ''}`, 'aria-hidden': 'true' }, icon('seam'));

function refresh(chat: Chat) {
  if (view?.chat === chat) view.render();
}

async function loadGuide(chat: Chat) {
  chat.guide = null;
  try {
    chat.guide = await api.get(`/api/rooms/${chat.roomId}/guide`);
  } catch {
    chat.guide = undefined; // the examples and rules are extras: Dream AI works without them
  }
  refresh(chat);
}

function ask(chat: Chat, a: Ask) {
  if (chat.busy) return;
  chat.turns.push({ who: 'me', text: a.text });
  answer(chat, a);
}

// The answer lands in the conversation even if the window was closed meanwhile; it shows when it is opened again.
async function answer(chat: Chat, a: Ask) {
  const pending: Turn = { who: 'bot', state: 'pending' };
  chat.turns.push(pending);
  if (chat.turns.length > MAX_TURNS) chat.turns.splice(0, chat.turns.length - MAX_TURNS);
  chat.busy = true;
  refresh(chat);
  let result: Turn;
  try {
    const reply: BotAnswer = await api.post(`/api/rooms/${chat.roomId}/bot`, { question: a.text, client_request_id: a.key });
    result = { who: 'bot', state: 'answer', reply, ask: a };
  } catch (err) {
    const limited = err instanceof ApiError && err.status === 429 && err.retry_after;
    result = {
      who: 'bot', state: 'error', text: errorMessage(err),
      until: limited ? Date.now() + Math.ceil(err.retry_after!) * 1000 : null,
      retry: err instanceof ApiError && err.status === 0 ? a : null,
    };
  }
  const i = chat.turns.indexOf(pending);
  if (i >= 0) chat.turns[i] = result;
  else chat.turns.push(result);
  chat.busy = false;
  if (view?.chat === chat) view.context();
  refresh(chat);
}

// A network error: the same question with the same key, so it cannot be answered twice.
function retry(chat: Chat, t: Failed) {
  if (chat.busy || !t.retry) return;
  chat.turns.splice(chat.turns.indexOf(t), 1);
  answer(chat, t.retry);
}

// The AI could not answer: ask the same question again, as a new request.
function askAgain(chat: Chat, t: Answered) {
  if (chat.busy) return;
  chat.turns.splice(chat.turns.indexOf(t), 1);
  answer(chat, { text: t.ask.text, key: newKey() });
}

// A rate limit says how long to wait. Screen readers hear it once; the visible line counts down.
function waitText(until: number) {
  const s = Math.ceil((until - Date.now()) / 1000);
  return s > 0 ? `Ready again in ${s < 90 ? `${s}s` : `${Math.ceil(s / 60)} min`}` : 'Ready again now';
}
function waitLine(until: number) {
  const text = waitText(until);
  return el('p', { class: 'db-wait' }, el('span', { class: 'sr-only', text }), el('span', { 'aria-hidden': 'true', dataset: { until: String(until) }, text }));
}

// "As of Over 18.4 · from verified match data": when the answer is from, and what it rests on.
function provenance(r: BotAnswer) {
  const parts = r.asked_at ? [`as of ${r.asked_at}`] : [];
  let kind = '';
  if (r.source === 'ai' && r.grounding === 'grounded') { parts.push('from verified match data'); kind = ' data'; }
  else if (r.source === 'ai' && r.grounding === 'rules_sheet') { parts.push('from the rules sheet'); kind = ' rules'; }
  else if (r.source === 'ai' && r.grounding === 'insufficient_data') { parts.push('not in the match data'); kind = ' none'; }
  if (!parts.length) return null;
  const text = parts.join(' · ');
  return el('p', { class: `db-prov${kind}`, text: text[0].toUpperCase() + text.slice(1) });
}
