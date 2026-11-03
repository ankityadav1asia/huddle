// Catch me up: what you missed while away (or the match so far), built to scan. How long you were away, the score
// then and now, what changed, a timeline of the plays that mattered, and what the room said on each #thread and in
// its polls. POST /api/rooms/:id/catchup answers the person who asks; nothing is posted in the room.
import { api, ApiError, errorMessage } from './api.ts';
import { el, clockSeconds, plural, teamLogo, type Child } from './ui.ts';
import { openSheet, closeSheet } from './sheets.ts';

interface CatchUp {
  scope: 'since' | 'match';
  away: string | null; // "6 min"; null for the match so far
  headline: string;
  change: { from: string; to: string; teams: { code: string; name: string; logo?: string }[] } | null;
  delta: { label: string; value: string }[];
  timeline: { at: string; label: string; text: string; score: string }[];
  match_points: string[];
  thread_points: { thread: string; id: string; text: string }[];
  room_points: string[];
  polls: { question: string; leader: string | null; share: number | null; votes: number }[];
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
    el('div', { class: 'cu-skeleton' }, el('i'), el('i'), el('i'), el('i'), el('span', { class: 'sr-only', text: 'Catching you up…' })));
  s.body.append(body);
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
// "Big wicket" → cu-tag--big-wicket: each tag's colour in watch.css.
const tagClass = (label: string) => `cu-tag cu-tag--${label.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '')}`;

function render(c: CatchUp, o: CatchUpOptions): Child[] {
  const away = c.scope === 'since';
  const foot = [c.source === 'ai' ? 'AI Co-host summary of verified match data' : 'From verified match data',
    c.data_as_of ? `as of ${clockSeconds(c.data_as_of)}` : '', c.stale ? 'may be out of date' : ''].filter(Boolean).join(' · ');
  return [
    el('header', { class: 'cu-top' },
      el('p', { class: 'cu-away', text: away ? (c.away ? `You were away ${c.away}` : 'Since you looked away') : 'The match so far' }),
      el('p', { class: 'cu-headline', text: c.headline })),
    c.change ? hero(c.change, away) : null,
    c.delta.length ? el('ul', { class: 'cu-deltas', 'aria-label': 'What changed' },
      c.delta.map((d) => el('li', {}, el('span', { text: d.label }), el('b', { text: d.value })))) : null,
    c.match_points.length ? section(c.source === 'ai' ? 'Why it matters' : 'Standouts',
      el('ul', { class: 'cu-points' }, c.match_points.map((p) => el('li', { text: p })))) : null,
    section(away ? 'What you missed' : 'Key moments', c.timeline.length ? timeline(c.timeline)
      : el('p', { class: 'cu-empty', text: away ? 'Nothing big happened while you were away.' : 'No big moments yet.' })),
    room(c, o),
    c.note ? el('p', { class: 'cu-note', text: c.note }) : null,
    el('p', { class: 'cu-foot', text: foot }),
  ];
}

// The score when you left (or where the run started) and now, under the side's logo or both sides' logos.
function hero(ch: NonNullable<CatchUp['change']>, away: boolean) {
  const same = ch.from === ch.to;
  return el('div', { class: 'cu-hero' },
    el('div', { class: 'cu-logos', 'aria-hidden': 'true' }, ch.teams.map((t) => teamLogo(t))),
    el('dl', { class: 'cu-change' },
      same ? null : el('div', { class: 'cu-then' }, el('dt', { text: away ? 'When you left' : 'From' }), el('dd', { text: ch.from })),
      el('div', { class: 'cu-now' }, el('dt', { text: same ? 'No change' : 'Now' }), el('dd', { text: ch.to }))));
}

// The plays that mattered, oldest first: where in the game, a coloured tag, what happened and the score after it.
function timeline(plays: CatchUp['timeline']) {
  return el('ol', { class: 'cu-timeline' }, plays.map((p) => el('li', { class: 'cu-play' },
    el('span', { class: 'cu-at', text: p.at }),
    el('div', { class: 'cu-what' },
      el('span', { class: tagClass(p.label), text: p.label }),
      el('p', { class: 'cu-text', text: p.text }),
      el('span', { class: 'cu-score', text: p.score })))));
}

// What the room said: each busy #thread (its chip opens it), poll results, then the rest of the talk.
function room(c: CatchUp, o: CatchUpOptions) {
  const threads = c.thread_points.map((p) => el('li', { class: 'cu-card' },
    el('button', { type: 'button', class: 'chip', text: `#${p.thread}`, 'aria-label': `Open #${p.thread}`, onclick: () => { closeSheet(); o.showThread(p.id); } }),
    el('p', { text: p.text })));
  const polls = c.polls.map((p) => {
    const bar = el('i');
    bar.style.width = `${p.share ?? 0}%`;
    return el('li', { class: 'cu-card cu-poll' },
      el('span', { class: 'cu-kicker', text: 'Poll' }),
      el('p', { class: 'cu-q', text: p.question }),
      p.leader ? [
        el('div', { class: 'cu-bar', role: 'img', 'aria-label': `${p.share}% picked ${p.leader}` }, bar),
        el('p', { class: 'cu-result' }, el('b', { text: p.leader }), ` · ${p.share}% of ${plural(p.votes, 'vote')}`),
      ] : el('p', { class: 'cu-result', text: 'No votes yet' }));
  });
  return section('In the room',
    threads.length || polls.length ? el('ul', { class: 'cu-cards' }, threads, polls) : null,
    c.room_points.length ? el('ul', { class: 'cu-points cu-talk' }, c.room_points.map((p) => el('li', { text: p }))) : null);
}
