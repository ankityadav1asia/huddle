// Catch me up: the match so far (or what you missed while away) as stats and key moments, and what the room is saying
// on each #thread. POST /api/rooms/:id/catchup answers the person who asks; nothing is posted in the room.
import { api, ApiError, errorMessage } from './api.ts';
import { el, clockSeconds, type Child } from './ui.ts';
import { openSheet, closeSheet } from './sheets.ts';

interface CatchUp {
  headline: string;
  stats: { label: string; value: string }[];
  match_points: string[];
  thread_points: { thread: string; id: string; text: string }[];
  room_points: string[];
  note?: string;
  source: 'ai' | 'match_data';
  data_as_of: string | null;
  stale: boolean;
}

export interface CatchUpOptions {
  roomId: string;
  since: number | null; // the room event to catch up from after time away; null for the match so far
  caughtUp: () => void;
  showThread: (id: string) => void;
}

export function openCatchUp(o: CatchUpOptions) {
  const s = openSheet({ title: 'Catch me up', full: true });
  const body = el('div', { class: 'cu-body', 'aria-busy': 'true' },
    el('div', { class: 'cu-skeleton' }, el('i'), el('i'), el('i'), el('span', { class: 'sr-only', text: 'Catching you up…' })));
  s.body.append(
    el('p', { class: 'cu-scope', text: o.since == null ? 'The match so far, and what the room is saying.' : 'What you missed while you were away.' }),
    body);
  load(o, body, s.isOpen);
}

async function load(o: CatchUpOptions, body: HTMLElement, isOpen: () => boolean) {
  let view: Child[];
  try {
    const c: CatchUp = await api.post(`/api/rooms/${o.roomId}/catchup`, o.since == null ? { scope: 'match' } : { since_seq: o.since });
    o.caughtUp();
    view = render(c, o);
  } catch (err) {
    const wait = err instanceof ApiError && err.status === 429 && err.retry_after ? `Ready again in ${Math.ceil(err.retry_after)}s.` : '';
    view = [el('p', { class: 'cu-error', text: [errorMessage(err), wait].filter(Boolean).join(' ') }),
      el('button', { type: 'button', class: 'btn', text: 'Try again', onclick: () => { body.replaceChildren(); load(o, body, isOpen); } })];
  }
  if (!isOpen()) return;
  body.replaceChildren(el('div', { class: 'cu-view' }, view));
  body.removeAttribute('aria-busy');
}

const section = (title: string, ...content: Child[]) => el('section', { class: 'cu-section' }, el('h3', { text: title }), ...content);
const bullets = (items: string[]) => el('ul', { class: 'bullets' }, items.map((p) => el('li', { text: p })));

function render(c: CatchUp, o: CatchUpOptions): Child[] {
  const talk = [
    ...c.thread_points.map((p) => el('li', { class: 'cu-thread' },
      el('button', { type: 'button', class: 'chip', text: `#${p.thread}`, onclick: () => { closeSheet(); o.showThread(p.id); } }),
      el('span', { text: p.text }))),
    ...c.room_points.map((p) => el('li', { text: p })),
  ];
  const foot = [c.source === 'ai' ? 'AI summary' : 'Summary from verified match data',
    c.data_as_of ? `data as of ${clockSeconds(c.data_as_of)}` : '', c.stale ? 'may be out of date' : ''].filter(Boolean).join(' · ');
  return [
    el('p', { class: 'cu-headline', text: c.headline }),
    c.stats.length ? el('dl', { class: 'cu-stats' }, c.stats.map((s) => el('div', {}, el('dt', { text: s.label }), el('dd', { text: s.value })))) : null,
    c.match_points.length ? section('Key moments', bullets(c.match_points)) : null,
    talk.length ? section('In the room', el('ul', { class: 'bullets cu-talk' }, talk)) : null,
    c.note ? el('p', { class: 'summary-note', text: c.note }) : null,
    el('p', { class: 'bubble-foot', text: foot }),
  ];
}
