// Dream Bot: a chatbot window over the room. Ask it anything about the room's game; answers come from
// POST /api/rooms/:id/bot (verified match data, the sport's rules sheet and roster) and are only ever shown to the
// person who asked, never posted in the room. Each room's conversation is kept in memory while the page is open.
import { api, ApiError, errorMessage, newKey } from './api.ts';
import { el, icon, aiLabel, clockSeconds } from './ui.ts';
import { openSheet, sheetActions } from './sheets.ts';

// POST /api/rooms/:id/bot. With source 'unavailable' the AI could not answer, and answer says so.
interface BotAnswer {
  answer: string;
  asked_at: string | null; // the clock or over of the latest play, e.g. "Over 18.4"
  grounding: 'grounded' | 'rules_sheet' | 'insufficient_data' | 'not_applicable' | null;
  source: 'ai' | 'unavailable';
}

// POST /api/rooms/:id/catchup: a summary for the asker only, by the AI or straight from match data.
interface CatchUp { headline: string; match_points?: string[]; room_points?: string[]; note?: string; source: string; data_as_of: string | null; stale: boolean }

// GET /api/rooms/:id/guide: the sport's checked rules sheet, its players and questions to start with.
interface Guide { sport_name: string; examples: string[]; rules: { topic: string; text: string }[]; roster: { name: string; team: string; role: string }[] }

// What the room passes in. since and caughtUp tie Catch me up to what this person last saw in the room.
export interface BotOptions {
  roomId: string;
  game: string | null; // the game the room follows
  ai: boolean; // the room's AI is on; without it, or without a game, Dream Bot can only catch you up
  since: () => number | null;
  caughtUp: () => void;
}

// A request. A question keeps its key, so trying again after a network error cannot be answered twice.
type Ask = { kind: 'question'; text: string; key: string } | { kind: 'catchup' };

// One bubble of the conversation.
type Turn =
  | { who: 'me'; text: string }
  | { who: 'bot'; state: 'pending' }
  | { who: 'bot'; state: 'answer'; reply: BotAnswer }
  | { who: 'bot'; state: 'summary'; summary: CatchUp }
  | { who: 'bot'; state: 'error'; text: string; note: string; retry: Ask | null };
type Failed = Extract<Turn, { state: 'error' }>;

interface Chat {
  roomId: string;
  opts: BotOptions;
  turns: Turn[];
  busy: boolean;
  guide?: Guide | null; // null while loading; undefined until loaded, or after a failure (the next open tries again)
  view: { isOpen: () => boolean; renderLog: () => void; renderChips: () => void } | null;
}

const MAX_TURNS = 60;
const chats = new Map<string, Chat>();

export function openDreamBot(opts: BotOptions, { catchUp = false }: { catchUp?: boolean } = {}) {
  const chat = chats.get(opts.roomId) || { roomId: opts.roomId, opts, turns: [], busy: false, view: null };
  chats.set(opts.roomId, chat);
  chat.opts = opts;
  const asks = Boolean(opts.game && opts.ai);
  const s = openSheet({ title: 'Dream Bot', full: true });
  s.heading?.append(aiLabel('AI'));
  const chips = el('div', { class: 'bot-chips', role: 'group', 'aria-label': 'Suggestions' });
  const log = el('div', { class: 'bot-log', role: 'log', 'aria-live': 'polite', 'aria-label': 'Your conversation with Dream Bot' });
  const input = el('input', { id: 'bot-question', maxlength: '300', placeholder: 'Ask about the game, a player or a rule', 'aria-label': 'Ask Dream Bot', autocomplete: 'off', enterkeyhint: 'send' });
  const send = el('button', { type: 'submit', class: 'send', 'aria-label': 'Ask' }, icon('send'));
  const form = el('form', { class: 'composer bot-composer', autocomplete: 'off' }, input, send);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text || chat.busy) return;
    input.value = '';
    ask(chat, { kind: 'question', text, key: newKey() });
  });
  const chip = (text: string, onclick: () => void, cls = 'chip') => el('button', { type: 'button', class: cls, text, onclick });
  chat.view = {
    isOpen: s.isOpen,
    renderChips: () => chips.replaceChildren(
      chip('Catch me up', () => ask(chat, { kind: 'catchup' }), 'chip catch'),
      ...(asks && chat.guide ? chat.guide.examples.map((q) => chip(q, () => ask(chat, { kind: 'question', text: q, key: newKey() }))) : []),
      ...(chat.guide ? [chip('Rules and players', () => openRules(chat), 'chip ghost')] : [])),
    renderLog: () => {
      send.disabled = chat.busy;
      log.replaceChildren(...(chat.turns.length ? chat.turns.map((t) => bubble(chat, t))
        : [el('p', { class: 'bot-empty', text: asks ? 'Answers come from verified match data and the sport\'s rules sheet. When the data does not say, Dream Bot tells you instead of guessing.' : 'Catch me up summarises what you missed.' })]));
      log.scrollTop = log.scrollHeight;
    },
  };
  s.body.append(
    el('p', { class: 'bot-intro', text: asks ? `Ask anything about ${opts.game}. Only you see the answers.`
      : opts.game ? 'The AI is off in this room, so Dream Bot can only catch you up, from match data.'
        : 'This room is not following a game, so Dream Bot can only catch you up.' }),
    chips, log);
  if (asks) s.body.append(form);
  chat.view.renderChips();
  chat.view.renderLog();
  if (opts.game && chat.guide === undefined) loadGuide(chat);
  if (catchUp) ask(chat, { kind: 'catchup' });
}

function refresh(chat: Chat) {
  if (chat.view?.isOpen()) chat.view.renderLog();
}

async function loadGuide(chat: Chat) {
  chat.guide = null;
  try {
    chat.guide = await api.get(`/api/rooms/${chat.roomId}/guide`);
  } catch {
    chat.guide = undefined; // the examples and rules are extras: Dream Bot works without them
  }
  if (chat.view?.isOpen()) chat.view.renderChips();
}

function ask(chat: Chat, a: Ask) {
  if (chat.busy) return;
  chat.turns.push({ who: 'me', text: a.kind === 'catchup' ? 'Catch me up' : a.text });
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
    if (a.kind === 'catchup') {
      const since = chat.opts.since();
      const summary: CatchUp = await api.post(`/api/rooms/${chat.roomId}/catchup`, since != null ? { since_seq: since } : {});
      chat.opts.caughtUp();
      result = { who: 'bot', state: 'summary', summary };
    } else {
      const reply: BotAnswer = await api.post(`/api/rooms/${chat.roomId}/bot`, { question: a.text, client_request_id: a.key });
      result = { who: 'bot', state: 'answer', reply };
    }
  } catch (err) {
    result = { who: 'bot', state: 'error', text: errorMessage(err), note: waitNote(err), retry: err instanceof ApiError && err.status === 0 ? a : null };
  }
  const i = chat.turns.indexOf(pending);
  if (i >= 0) chat.turns[i] = result;
  else chat.turns.push(result);
  chat.busy = false;
  refresh(chat);
}

function retry(chat: Chat, t: Failed) {
  if (chat.busy || !t.retry) return;
  chat.turns.splice(chat.turns.indexOf(t), 1);
  answer(chat, t.retry);
}

// A rate limit says how long to wait.
function waitNote(err: unknown) {
  if (!(err instanceof ApiError && err.status === 429 && err.retry_after)) return '';
  const s = Math.ceil(err.retry_after);
  return `Ready again in ${s < 90 ? `${s}s` : `${Math.ceil(s / 60)} min`}`;
}

// "As of Over 18.4 · from verified match data": when the answer is from, and what it rests on.
function answerNote(r: BotAnswer) {
  const parts = r.asked_at ? [`as of ${r.asked_at}`] : [];
  if (r.source === 'ai' && r.grounding === 'grounded') parts.push('from verified match data');
  else if (r.source === 'ai' && r.grounding === 'rules_sheet') parts.push('from the rules sheet');
  else if (r.source === 'ai' && r.grounding === 'insufficient_data') parts.push('not in the match data, so no guess');
  const note = parts.join(' · ');
  return note ? note[0].toUpperCase() + note.slice(1) : '';
}

const foot = (text: string) => (text ? el('p', { class: 'bubble-foot', text }) : null);

function bubble(chat: Chat, t: Turn) {
  if (t.who === 'me') return el('p', { class: 'bubble me', text: t.text });
  if (t.state === 'pending') {
    return el('p', { class: 'bubble bot typing' }, el('span', { class: 'sr-only', text: 'Dream Bot is answering' }), el('i'), el('i'), el('i'));
  }
  if (t.state === 'error') {
    return el('div', { class: 'bubble bot error' }, el('p', { text: t.text }), foot(t.note),
      t.retry ? el('button', { type: 'button', class: 'link-btn', text: 'Try again', onclick: () => retry(chat, t) }) : null);
  }
  if (t.state === 'summary') return summaryBubble(t.summary);
  const r = t.reply;
  return el('div', { class: `bubble bot${r.source === 'ai' ? '' : ' muted'}` }, el('p', { text: r.answer }), foot(answerNote(r)));
}

function summaryBubble(c: CatchUp) {
  const points = (title: string, list?: string[]) => (list?.length ? [el('p', { class: 'summary-h', text: title }), el('ul', { class: 'bullets' }, list.map((p) => el('li', { text: p })))] : null);
  const note = [c.source === 'ai' ? 'AI summary' : 'Summary from verified match data', c.data_as_of ? `data as of ${clockSeconds(c.data_as_of)}` : '', c.stale ? 'may be out of date' : ''];
  return el('div', { class: 'bubble bot summary' },
    el('p', { class: 'summary-head', text: c.headline }),
    points('In the match', c.match_points),
    points('In the room', c.room_points),
    c.note ? el('p', { class: 'summary-note', text: c.note }) : null,
    foot(note.filter(Boolean).join(' · ')));
}

// The sport's checked rules sheet and players; the button goes back to the conversation.
function openRules(chat: Chat) {
  const g = chat.guide;
  if (!g) return;
  const s = openSheet({ title: `${g.sport_name[0].toUpperCase()}${g.sport_name.slice(1)}: rules and players`, lede: 'A short, checked rules sheet. Dream Bot and the AI Co-host answer rule and player questions from it.' });
  s.body.append(
    el('h3', { text: 'Rules' }),
    el('dl', { class: 'rules-list' }, g.rules.flatMap((r) => [el('dt', { text: r.topic }), el('dd', { text: r.text })])),
    el('h3', { text: 'Players' }),
    el('ul', { class: 'roster-list' }, g.roster.map((p) => el('li', {}, el('b', { text: p.name }), ` · ${p.role}, ${p.team}`))),
    sheetActions(el('button', { type: 'button', class: 'btn primary', text: 'Back to Dream Bot', onclick: () => openDreamBot(chat.opts) })));
}
