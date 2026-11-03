// Match Centre: a Cricbuzz-style window over the room, opened from its scorecard. Swipeable tabs (Scorecard, Graphs,
// Commentary, and Overs for cricket or Play by play for F1, basketball and hockey) show
// GET /api/rooms/:id/match?detail=1; the room calls update() whenever the match moves on.
import { api, errorMessage } from './api.ts';
import { el, icon, plural, teamClass, type Child } from './ui.ts';

export interface MatchCentre {
  update(): void;
  close(): void;
  isOpen(): boolean;
}

// The one place in the app that says what the match data are.
const NOTE = 'Match data and crowd chat in this prototype are illustrative.';
const REFETCH_MS = 2000; // update() fetches at most about once every 2 s
const DASH = '–';
// Constructor codes of the snapshot's F1 team names, for the team colours (styles.css .t-<code>).
const F1_TEAMS: Record<string, string> = { McLaren: 'MCL', 'Red Bull': 'RBR', Ferrari: 'FER', Mercedes: 'MER' };
// Line colours for a series that has no team colour.
const SPARE = ['#2a78d6', '#eb6834', '#1baf7a'];

type Sport = 'cricket' | 'f1' | 'basketball' | 'hockey';
type Status = 'scheduled' | 'live' | 'completed';
type Innings = 'current' | 'first';

interface TeamRef { code: string; name: string }
interface MatchInfo { title: string; status: Status; sport: string; format?: string | null; teams: TeamRef[] }

// A commentary line, newest first. `over` is a cricket ball's over.ball ("18.4"), the overs bowled for other cricket
// lines, and the clock in the other sports. `symbol` is set on cricket balls only ("0".."6", "W", "wd", "nb").
interface Line { event_id?: string; kind: string; over: string | null; symbol: string | null; label: string | null; text: string }

// `over` is 1-based and `total` the innings score at its end; the over in progress comes last.
interface OverPoint { over: number; runs: number; wickets: number; total: number }
interface CricketGraph { kind: 'cricket'; target: number | null; overs: OverPoint[] }
interface ScoreGraph { kind: 'score'; teams: string[]; points: { label: string; a: number; b: number }[] }
interface GapGraph { kind: 'gaps'; drivers: string[]; laps: { lap: number; gaps: Record<string, number> }[] }

// GET /api/rooms/:id/match?detail=1: only the fields read here. Without detail the server sends no graphs and only
// the last 10 lines of commentary, which the window shows as they are.
interface Detail {
  match: MatchInfo;
  freshness?: { stale?: boolean } | null;
  score: unknown; // one shape per sport: see viewOf()
  commentary?: Line[] | null;
  graphs?: CricketGraph | ScoreGraph | GapGraph | null;
}

// The scorecards (lib/match/scorecard.ts and lib/match/sports/*.ts snapshot()).
interface Batter { name: string; runs: number; balls: number; on_strike: boolean; fours?: number | null; sixes?: number | null }
// score and over are null for a wicket that fell before the ball-by-ball data begin.
interface Wicket { name: string; r: number; b: number; how: string; score: string | null; over: string | null; fours?: number | null; sixes?: number | null }
interface CricketScore {
  batting: string;
  bowling: string;
  runs: number;
  wickets: number;
  overs: string;
  balls: number;
  target: number | null;
  first_innings: string | null;
  need_runs: number;
  need_balls: number;
  crr: number | null;
  rrr: number | null;
  result: string | null;
  chase_won: boolean;
  batters: Batter[];
  bowler: { name: string } | null;
  bowling_card: { name: string; figures: string; economy: number | null }[];
  fall_of_wickets: Wicket[];
  partnership: { runs: number; balls: number };
}
interface F1Car { pos: number; code: string; name: string; team: string; gap: string; tyre: string; pits: number }
interface F1Score { lap: number; total_laps: number; safety_car: boolean; result: string | null; order: F1Car[]; fastest_lap: { driver: string; time: string } | null }
interface ClockScore<T> { period: string; clock: string; result: string | null; teams: (TeamRef & { score: number } & T)[] }
type BasketballScore = ClockScore<{ team_fouls: number; leaders: { name: string; pts: number }[] }>;
interface HockeyScore extends ClockScore<{ shots: number }> {
  power_play: { team: string; until: string; penalty: string } | null;
  empty_net: string | null;
  goals: { team: string; scorer: string; assists: string[]; time: string; strength: string }[];
  penalties: { team: string; player: string; infraction: string; time: string }[];
}

type View =
  | { sport: 'cricket'; score: CricketScore; graph: CricketGraph | null }
  | { sport: 'f1'; score: F1Score; graph: GapGraph | null }
  | { sport: 'basketball'; score: BasketballScore; graph: ScoreGraph | null }
  | { sport: 'hockey'; score: HockeyScore; graph: ScoreGraph | null };

// The score's shape follows match.sport, which TypeScript cannot see: this is the one place it is asserted.
function viewOf(d: Detail): View {
  const g = d.graphs ?? null;
  switch (d.match.sport) {
    case 'f1': return { sport: 'f1', score: d.score as F1Score, graph: g?.kind === 'gaps' ? g : null };
    case 'basketball': return { sport: 'basketball', score: d.score as BasketballScore, graph: g?.kind === 'score' ? g : null };
    case 'hockey': return { sport: 'hockey', score: d.score as HockeyScore, graph: g?.kind === 'score' ? g : null };
    default: return { sport: 'cricket', score: d.score as CricketScore, graph: g?.kind === 'cricket' ? g : null };
  }
}

// ---- The window ----

let current: MatchCentre | null = null;
let ids = 0;

// One window at a time: opening another closes the first.
export function openMatchCentre(roomId: string): MatchCentre {
  current?.close();
  current = createCentre(roomId);
  return current;
}

function createCentre(roomId: string): MatchCentre {
  const uid = `mc${++ids}`;
  const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  const host = document.getElementById('app') ?? document.querySelector<HTMLElement>('.phone') ?? document.body;
  const behind = document.getElementById('view'); // the room: inert while the window covers it
  const behindWasInert = behind?.inert ?? false;

  let alive = true;
  let data: Detail | null = null;
  let view: View | null = null;
  let signature = '';
  let built: Sport | null = null;
  let tabs: HTMLButtonElement[] = [];
  let panels: HTMLElement[] = [];
  let pager: HTMLElement | null = null;
  let active = 0;
  let target: number | null = null; // the panel a tapped tab is scrolling to
  let moved = false; // whether the pager has scrolled since that tap
  let tappedAt = 0;
  let settleTimer = 0;
  let innings: Innings = 'current';
  const charts: ChartState = { open: new Set(), picks: new Map() };
  let inflight = false;
  let queued = false;
  let lastFetch = 0;
  let waitTimer = 0;
  let ctrl: AbortController | null = null;

  const title = el('h2', { class: 'mc-title', id: `${uid}-title` });
  const sub = el('p', { class: 'mc-sub' });
  const status = el('p', { class: 'mc-status' });
  const notice = el('p', { class: 'mc-notice', role: 'status' });
  const tablist = el('div', { class: 'mc-tabs', role: 'tablist', 'aria-label': 'Match Centre sections', hidden: true, onkeydown: onTabKey });
  const body = el('div', { class: 'mc-body' });
  const root = el('div', { class: 'mc', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': `${uid}-kicker ${uid}-title`, tabindex: '-1', onkeydown: onKey },
    el('header', { class: 'mc-head' },
      el('div', { class: 'mc-bar' },
        el('button', { type: 'button', class: 'mc-back', 'aria-label': 'Close Match Centre', onclick: close }, icon('back')),
        el('div', { class: 'mc-titles' }, el('p', { class: 'mc-kicker', id: `${uid}-kicker`, text: 'Match Centre' }), title, sub)),
      status, notice, tablist),
    body,
    el('p', { class: 'mc-note', text: NOTE }));
  // A resize (rotation, the laptop frame's zoom) keeps the active panel in place.
  const resize = new ResizeObserver(() => {
    if (pager && target === null) pager.scrollLeft = active * pager.clientWidth;
  });

  showLoading();
  host.append(root);
  if (behind) behind.inert = true;
  window.addEventListener('hashchange', close); // leaving the room's route leaves its window too
  root.focus({ preventScroll: true });
  void load();

  const handle: MatchCentre = { update, close, isOpen: () => alive };
  return handle;

  function update() {
    if (!alive) return;
    if (inflight) {
      queued = true;
      return;
    }
    const wait = lastFetch + REFETCH_MS - Date.now();
    if (wait > 0) {
      if (!waitTimer) waitTimer = window.setTimeout(() => { waitTimer = 0; update(); }, wait);
      return;
    }
    void load();
  }

  function close() {
    if (!alive) return;
    alive = false;
    ctrl?.abort();
    clearTimeout(waitTimer);
    clearTimeout(settleTimer);
    resize.disconnect();
    window.removeEventListener('hashchange', close);
    root.remove();
    if (behind && !behindWasInert) behind.inert = false;
    if (current === handle) current = null;
    refocus(opener);
  }

  async function load() {
    inflight = true;
    lastFetch = Date.now();
    const c = new AbortController();
    ctrl = c;
    try {
      const d: Detail = await api.get(`/api/rooms/${encodeURIComponent(roomId)}/match?detail=1`, { signal: c.signal });
      if (alive) apply(d);
    } catch (err) {
      if (alive && !(err instanceof Error && err.name === 'AbortError')) failed(err);
    } finally {
      inflight = false;
      if (ctrl === c) ctrl = null;
      if (alive && queued) {
        queued = false;
        update();
      }
    }
  }

  function retry() {
    clearTimeout(waitTimer);
    waitTimer = 0;
    if (inflight) queued = true;
    else void load();
  }

  function apply(d: Detail) {
    notice.textContent = '';
    // The freshness age and the crowd lines change on every call; only a change in the match redraws.
    const sig = JSON.stringify([d.match, d.score, d.commentary, d.graphs, Boolean(d.freshness?.stale)]);
    if (sig === signature) return;
    signature = sig;
    data = d;
    view = viewOf(d);
    title.textContent = d.match.title;
    sub.replaceChildren(...nodes(subLine(d)));
    status.textContent = statusLine(view);
    if (built !== view.sport) build(view.sport);
    panels.forEach((_, i) => render(i));
  }

  // Before the first answer the window shows the error with a retry; after it, the last good view stays up.
  function failed(err: unknown) {
    if (data) {
      notice.textContent = `Not updated: ${errorMessage(err)}`;
      return;
    }
    body.replaceChildren(el('div', { class: 'mc-problem', role: 'alert' },
      el('p', { text: errorMessage(err) }),
      el('button', { type: 'button', class: 'mc-retry', text: 'Try again', onclick: () => { showLoading(); root.focus({ preventScroll: true }); retry(); } })));
  }

  function showLoading() {
    body.replaceChildren(el('div', { class: 'mc-loading', role: 'status' },
      el('span', { class: 'mc-sr', text: 'Loading the Match Centre…' }),
      el('div', { class: 'mc-skel' }), el('div', { class: 'mc-skel' }), el('div', { class: 'mc-skel is-short' })));
  }

  function build(sport: Sport) {
    built = sport;
    const names = ['Scorecard', 'Graphs', 'Commentary', sport === 'cricket' ? 'Overs' : 'Play by play'];
    tabs = names.map((name, i) => el('button', {
      type: 'button', class: 'mc-tab', role: 'tab', id: `${uid}-tab-${i}`, 'aria-controls': `${uid}-panel-${i}`, text: name,
      onclick: () => select(i),
    }));
    panels = names.map((_, i) => el('section', { class: 'mc-panel', role: 'tabpanel', id: `${uid}-panel-${i}`, 'aria-labelledby': `${uid}-tab-${i}`, tabindex: '0' }));
    if (pager) resize.unobserve(pager);
    pager = el('div', { class: 'mc-pager', onscroll: onPagerScroll, onscrollend: settle }, panels);
    tablist.replaceChildren(...tabs);
    tablist.hidden = false;
    body.replaceChildren(pager);
    resize.observe(pager);
    mark(Math.min(active, names.length - 1));
  }

  // The active tab: selected, in the tab order, and the only panel that is not inert (so Tab and screen readers stay
  // in the panel on screen).
  function mark(i: number) {
    const was = active;
    const moveFocus = was !== i && Boolean(panels[was]?.contains(document.activeElement));
    active = i;
    tabs.forEach((t, k) => {
      t.setAttribute('aria-selected', String(k === i));
      t.tabIndex = k === i ? 0 : -1;
    });
    panels.forEach((p, k) => { p.inert = k !== i; });
    if (moveFocus) panels[i].focus({ preventScroll: true });
    const tab = tabs[i];
    if (tab) {
      const left = tab.offsetLeft;
      const right = left + tab.offsetWidth;
      if (left < tablist.scrollLeft) tablist.scrollLeft = left;
      else if (right > tablist.scrollLeft + tablist.clientWidth) tablist.scrollLeft = right - tablist.clientWidth;
    }
  }

  // A tap or key on a tab scrolls the pager to its panel; the scroll then keeps quiet until it gets there.
  function select(i: number) {
    if (!pager) return;
    mark(i);
    const width = Math.max(1, pager.clientWidth);
    if (Math.abs(pager.scrollLeft / width - i) < 0.01) {
      target = null;
      return;
    }
    target = i;
    moved = false;
    tappedAt = Date.now();
    const still = document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches;
    pager.scrollTo({ left: i * width, behavior: still ? 'auto' : 'smooth' });
    armSettle();
  }

  // A swipe moves the active tab as soon as the next panel is more than half in view.
  function onPagerScroll() {
    if (!pager) return;
    const at = pager.scrollLeft / Math.max(1, pager.clientWidth);
    if (target === null) {
      const i = clampIndex(Math.round(at));
      if (i !== active) mark(i);
    } else if (Math.abs(at - target) < 0.01) {
      target = null;
    } else {
      moved = true;
    }
    armSettle();
  }

  // scrollend, or a quiet spell where it is not supported, settles on the nearest panel; a tapped tab's smooth
  // scroll gets longer, so a slow frame does not flick the tabs back.
  function armSettle() {
    clearTimeout(settleTimer);
    settleTimer = window.setTimeout(settle, target === null ? 160 : 700);
  }

  function settle() {
    clearTimeout(settleTimer);
    if (!pager) return;
    const at = pager.scrollLeft / Math.max(1, pager.clientWidth);
    // A tapped tab's scroll that has not begun (no frames yet, as in a background tab) is still on its way; a swipe
    // that cut into it wins.
    if (target !== null && Math.abs(at - target) >= 0.01 && !moved && Date.now() - tappedAt < 3000) {
      armSettle();
      return;
    }
    target = null;
    const i = clampIndex(Math.round(at));
    if (i !== active) mark(i);
  }

  function clampIndex(i: number) {
    return Math.max(0, Math.min(tabs.length - 1, i));
  }

  function onTabKey(e: KeyboardEvent) {
    const n = tabs.length;
    const from = tabs.findIndex((t) => t === e.target);
    const at = from < 0 ? active : from;
    const next = e.key === 'ArrowRight' ? (at + 1) % n : e.key === 'ArrowLeft' ? (at - 1 + n) % n
      : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    select(next);
    tabs[next].focus();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    e.preventDefault();
    e.stopPropagation(); // one Escape closes one window
    close();
  }

  // Redraws one panel, keeping its reading position (the first keyed block at or below the top stays put) and the
  // focused control.
  function render(i: number) {
    const panel = panels[i];
    if (!panel || !data || !view) return;
    const anchor = anchorOf(panel);
    const focused = document.activeElement instanceof HTMLElement && panel.contains(document.activeElement)
      ? document.activeElement.closest<HTMLElement>('[data-fk]')?.dataset.fk : undefined;
    let content: Child;
    try {
      content = panelContent(i, data, view);
    } catch (err) {
      console.error(err);
      content = empty('This section could not be shown.');
    }
    panel.replaceChildren(...nodes(content));
    if (anchor) {
      const again = panel.querySelector<HTMLElement>(`[data-key="${CSS.escape(anchor.key)}"]`);
      if (again) panel.scrollTop = topIn(again, panel) - anchor.offset;
    }
    if (focused) panel.querySelector<HTMLElement>(`[data-fk="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  }

  function panelContent(i: number, d: Detail, v: View): Child {
    const lines = (d.commentary ?? []).filter((c) => c.text);
    if (i === 0) return scorecard(v, d.match, innings, (which) => { innings = which; render(0); });
    if (i === 1) return graphsPanel(v, d.match, charts);
    if (i === 2) return commentary(lines);
    return v.sport === 'cricket' ? oversPanel(lines, v.graph, v.score) : playByPlay(lines, v.sport);
  }
}

// Focus goes back to whatever opened the window, or to its replacement if the room has redrawn it.
function refocus(opener: HTMLElement | null) {
  if (!opener) return;
  let back: HTMLElement | null = opener.isConnected ? opener : null;
  if (!back && opener.id) back = document.getElementById(opener.id);
  if (!back && opener.classList.length) {
    back = document.querySelector<HTMLElement>(`${opener.tagName.toLowerCase()}${[...opener.classList].map((c) => `.${CSS.escape(c)}`).join('')}`);
  }
  back?.focus({ preventScroll: true });
}

interface Anchor { key: string; offset: number }

function anchorOf(panel: HTMLElement): Anchor | null {
  const top = panel.scrollTop;
  if (top <= 0) return null; // at the top the newest lines show
  let pick: HTMLElement | null = null;
  for (const n of panel.querySelectorAll<HTMLElement>('[data-key]')) {
    pick = n;
    if (topIn(n, panel) >= top) break;
  }
  return pick?.dataset.key ? { key: pick.dataset.key, offset: topIn(pick, panel) - top } : null;
}

// An element's top within the panel's scrolled content (the panel is positioned, so it is on the offset chain).
function topIn(node: HTMLElement, panel: HTMLElement) {
  let y = 0;
  for (let n: HTMLElement | null = node; n && n !== panel; n = n.offsetParent as HTMLElement | null) y += n.offsetTop;
  return y;
}

// ---- Shared pieces ----

function nodes(c: Child): (Node | string)[] {
  if (c == null || c === false) return [];
  if (c instanceof Node) return [c];
  if (typeof c === 'object') return c.flatMap(nodes);
  return [String(c)];
}

const sr = (text: string) => el('span', { class: 'mc-sr', text });
const count = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? DASH : String(v));
const fixed = (v: number | null | undefined, digits = 2) => (v == null || !Number.isFinite(v) ? DASH : v.toFixed(digits));
const strikeRate = (runs: number, balls: number) => (balls > 0 ? ((runs / balls) * 100).toFixed(2) : DASH);
const oversText = (balls: number) => `${Math.floor(balls / 6)}.${balls % 6}`;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const notRecorded = () => [el('span', { 'aria-hidden': 'true', text: DASH }), sr('not on record')];

function empty(title: string, hint?: string) {
  return el('div', { class: 'mc-empty' }, el('p', { class: 'mc-empty-title', text: title }), hint ? el('p', { text: hint }) : null);
}

function card(key: string, ...children: Child[]) {
  return el('section', { class: 'mc-card', dataset: { key } }, children);
}

// The green bar on top of a card, like Cricbuzz's innings header.
function header(name: Child, right?: Child) {
  return el('div', { class: 'mc-inn' }, el('span', { class: 'mc-inn-name' }, name), right == null ? null : el('span', { class: 'mc-inn-score' }, right));
}

// head: the column headings; `left` lists the columns after the first that align left (names, not numbers).
function table(head: Child[], rows: HTMLTableRowElement[], { foot = [], left = [] }: { foot?: (HTMLTableRowElement | null)[]; left?: number[] } = {}) {
  return el('div', { class: 'mc-scroll' }, el('table', { class: 'mc-table' },
    el('thead', {}, el('tr', {}, head.map((h, i) => el('th', { scope: 'col', class: left.includes(i) ? 'mc-l' : null }, h)))),
    el('tbody', {}, rows),
    foot.some(Boolean) ? el('tfoot', {}, foot) : null));
}

function facts(rows: ([string, Child] | null | false)[]) {
  return el('dl', { class: 'mc-kv' }, rows.map((r) => r && el('div', {}, el('dt', { text: r[0] }), el('dd', {}, r[1]))));
}

const swatch = (code: string | null) => el('span', { class: `mc-swatch ${teamClass(code)}`, 'aria-hidden': 'true' });

// ---- Header lines ----

function subLine(d: Detail): Child[] {
  const st = d.match.status;
  const parts: Child[] = [];
  if (d.match.format) parts.push(d.match.format);
  parts.push(st === 'live' ? el('span', { class: 'mc-live', text: 'Live' }) : st === 'scheduled' ? 'Starting soon' : 'Finished');
  if (st === 'live' && d.freshness?.stale) parts.push('may be out of date');
  return parts.flatMap((p, i) => (i ? [' · ', p] : [p]));
}

// The red line under the header: the result, or what the game needs now.
function statusLine(v: View): string {
  if (v.score.result) return v.score.result;
  if (v.sport === 'cricket') {
    const s = v.score;
    if (!s.target) return `${s.batting} ${s.runs}-${s.wickets} (${s.overs} Ov)`;
    if (s.chase_won) return `${s.batting} have won`;
    return `${s.batting} need ${plural(s.need_runs, 'run')} in ${plural(s.need_balls, 'ball')}`;
  }
  if (v.sport === 'f1') {
    const s = v.score;
    const leader = s.order[0];
    return [`Lap ${s.lap}/${s.total_laps}`, s.safety_car ? 'Safety car' : '', leader ? `${leader.name} leads` : ''].filter(Boolean).join(' · ');
  }
  const [a, b] = v.score.teams;
  const lead = !a || !b ? '' : a.score === b.score ? `Tied ${a.score}-${b.score}` : `${a.score > b.score ? a.name : b.name} lead by ${Math.abs(a.score - b.score)}`;
  const pp = v.sport === 'hockey' && v.score.power_play ? `${v.score.power_play.team} power play` : '';
  return [`${v.score.period} ${v.score.clock}`, lead, pp].filter(Boolean).join(' · ');
}

// ---- Scorecard ----

function scorecard(v: View, m: MatchInfo, innings: Innings, pick: (i: Innings) => void): Child {
  switch (v.sport) {
    case 'cricket': return cricketCard(v.score, m, innings, pick);
    case 'f1': return f1Card(v.score);
    case 'basketball': return basketballCard(v.score);
    case 'hockey': return hockeyCard(v.score);
  }
}

// "MI 186/6 (20)": the first innings, of which only the total is known.
function parseInnings(text: string) {
  const m = /^(\S+)\s+(\d+)\/(\d+)\s*\(([\d.]+)\)/.exec(text);
  return m ? { team: m[1], score: `${m[2]}-${m[3]}`, overs: m[4] } : null;
}

function cricketCard(s: CricketScore, m: MatchInfo, innings: Innings, pick: (i: Innings) => void): Child {
  const name = (code: string) => m.teams.find((t) => t.code === code)?.name || code;
  const first = s.target && s.first_innings ? parseInnings(s.first_innings) ?? { team: s.bowling, score: s.first_innings, overs: null } : null;
  const showFirst = Boolean(first) && innings === 'first';
  const pill = (label: string, which: Innings) => el('button', {
    type: 'button', class: 'mc-pill', 'aria-pressed': String(showFirst === (which === 'first')), dataset: { fk: `inn-${which}` }, text: label,
    onclick: () => pick(which),
  });
  const pills = first ? el('div', { class: 'mc-pills', role: 'group', 'aria-label': 'Innings', dataset: { key: 'pills' } },
    pill(`${first.team} (1st Inn)`, 'first'), pill(`${s.batting} (2nd Inn)`, 'current')) : null;
  if (first && showFirst) {
    return [pills, card('inn-1',
      header(`${name(first.team)} 1st Innings`, [el('b', { text: first.score }), first.overs ? ` (${first.overs} Ov)` : null]),
      el('p', { class: 'mc-card-note', text: 'Only the total of this innings is on record here.' }))];
  }
  return [
    pills,
    card('inn-2',
      header(`${name(s.batting)} ${first ? '2nd' : '1st'} Innings`, [el('b', { text: `${s.runs}-${s.wickets}` }), ` (${s.overs} Ov)`]),
      el('div', { dataset: { key: 'bat' } }, battingTable(s)),
      el('div', { dataset: { key: 'fow' } }, fallOfWickets(s)),
      el('div', { dataset: { key: 'bowl' } }, bowlingTable(s))),
    chaseCard(s),
  ];
}

function battingTable(s: CricketScore) {
  const row = (name: Child, how: string, r: number, b: number, fours?: number | null, sixes?: number | null) => el('tr', {},
    el('th', { scope: 'row' }, el('span', { class: 'mc-name' }, name), el('span', { class: 'mc-how', text: how })),
    el('td', { class: 'mc-strong', text: r }), el('td', { text: b }), el('td', { text: count(fours) }), el('td', { text: count(sixes) }),
    el('td', { text: strikeRate(r, b) }));
  // Runs off the bat add up to the total less the extras, so the extras are what is left.
  const offBat = s.fall_of_wickets.reduce((t, w) => t + w.r, 0) + s.batters.reduce((t, b) => t + b.runs, 0);
  const extras = s.runs - offBat;
  return table(['Batter', 'R', 'B', '4s', '6s', 'SR'], [
    ...s.fall_of_wickets.map((w) => row(w.name, w.how, w.r, w.b, w.fours, w.sixes)),
    ...s.batters.map((b) => (s.result
      ? row(b.name, 'not out', b.runs, b.balls, b.fours, b.sixes)
      : row([b.name, b.on_strike ? [el('span', { 'aria-hidden': 'true', text: ' *' }), sr(', on strike')] : null], 'batting', b.runs, b.balls, b.fours, b.sixes))),
  ], {
    foot: [
      extras >= 0 ? el('tr', {}, el('th', { scope: 'row', text: 'Extras' }), el('td', { colspan: '5', class: 'mc-strong', text: extras })) : null,
      el('tr', { class: 'mc-total' }, el('th', { scope: 'row', text: 'Total' }),
        el('td', { colspan: '5' }, el('b', { text: `${s.runs}-${s.wickets}` }), ` (${s.overs} Ov, RR ${fixed(s.crr)})`)),
    ],
  });
}

function fallOfWickets(s: CricketScore): Child {
  if (!s.fall_of_wickets.length) return [el('h3', { class: 'mc-sub-head', text: 'Fall of wickets' }), el('p', { class: 'mc-card-note', text: 'No wickets yet.' })];
  const early = s.fall_of_wickets.some((w) => !w.score || !w.over);
  return [
    el('h3', { class: 'mc-sub-head', text: 'Fall of wickets' }),
    table(['Batter', 'Score', 'Over'], s.fall_of_wickets.map((w) => el('tr', {},
      el('th', { scope: 'row', text: w.name }),
      el('td', {}, w.score ? w.score.replace('/', '-') : notRecorded()),
      el('td', {}, w.over ?? notRecorded())))),
    early ? el('p', { class: 'mc-foot-note', text: `${DASH} fell before the ball-by-ball record begins.` }) : null,
  ];
}

function bowlingTable(s: CricketScore) {
  return table(['Bowler', 'O', 'M', 'R', 'W', 'ECON'], s.bowling_card.map((b) => {
    const parts = b.figures.split('-');
    const [o, m, r, w] = parts.length === 4 ? parts : [DASH, DASH, DASH, DASH];
    const now = s.bowler?.name === b.name;
    return el('tr', {},
      el('th', { scope: 'row' }, b.name, now ? [el('span', { 'aria-hidden': 'true', text: ' *' }), sr(', bowling now')] : null),
      el('td', { text: o }), el('td', { text: m }), el('td', { text: r }), el('td', { class: 'mc-strong', text: w }), el('td', { text: fixed(b.economy) }));
  }));
}

function chaseCard(s: CricketScore) {
  // The stand began `start` legal balls in: at the last wicket, or where the ball-by-ball record begins.
  const start = s.balls - s.partnership.balls;
  const last = s.fall_of_wickets[s.fall_of_wickets.length - 1];
  const partial = last ? !last.over : start > 0;
  const chasing = Boolean(s.target) && !s.result && !s.chase_won;
  return card('chase', facts([
    Boolean(s.target) && ['Target', String(s.target)],
    chasing && ['Need', `${plural(s.need_runs, 'run')} off ${plural(s.need_balls, 'ball')}`],
    ['CRR', fixed(s.crr)],
    chasing && ['Req. RR', fixed(s.rrr)],
    ['Partnership', [`${s.partnership.runs} (${s.partnership.balls})`, partial ? el('small', { text: ` from ${oversText(start)} Ov` }) : null]],
  ]));
}

function tyre(name: string) {
  const letter = (name[0] || '?').toUpperCase();
  return [el('span', { class: `mc-tyre is-${letter.toLowerCase()}`, 'aria-hidden': 'true', title: name, text: letter }), sr(name)];
}

function f1Card(s: F1Score): Child {
  return [
    card('order', header('Running order', [el('b', { text: `Lap ${s.lap}` }), `/${s.total_laps}`]),
      table(['Pos', 'Driver', 'Gap', 'Tyre', 'Stops'], s.order.map((c) => el('tr', {},
        el('td', { class: 'mc-strong', text: c.pos }),
        el('th', { scope: 'row', class: 'mc-l' }, el('span', { class: 'mc-name' }, swatch(F1_TEAMS[c.team] ?? null), c.name), el('span', { class: 'mc-how', text: c.team })),
        el('td', { text: c.gap }),
        el('td', {}, tyre(c.tyre)),
        el('td', { text: c.pits }))), { left: [1] })),
    card('race', facts([
      ['Fastest lap', s.fastest_lap ? `${s.fastest_lap.driver} · ${s.fastest_lap.time}` : DASH],
      ['Safety car', s.safety_car ? 'Deployed' : 'Not out'],
    ])),
  ];
}

const teamCell = (t: TeamRef) => el('th', { scope: 'row' }, el('span', { class: 'mc-name' }, swatch(t.code), t.name));
const gameClock = (s: { result: string | null; period: string; clock: string }) => (s.result ? 'Final' : `${s.period} ${s.clock}`);

function basketballCard(s: BasketballScore): Child {
  return [
    card('score', header('Score', gameClock(s)),
      table(['Team', 'PTS', 'Team fouls'], s.teams.map((t) => el('tr', {},
        teamCell(t), el('td', { class: 'mc-strong mc-big', text: t.score }), el('td', { text: t.team_fouls })))),
      el('p', { class: 'mc-foot-note', text: 'Team fouls count this quarter.' })),
    ...s.teams.map((t) => card(`leaders-${t.code}`,
      table([[swatch(t.code), `${t.name} leaders`], 'PTS'], t.leaders.map((p) => el('tr', {},
        el('th', { scope: 'row', text: p.name }), el('td', { class: 'mc-strong', text: p.pts })))))),
  ];
}

function hockeyCard(s: HockeyScore): Child {
  const code = (name: string) => s.teams.find((t) => t.name === name)?.code ?? null;
  const pp = s.power_play;
  return [
    card('score', header('Score', gameClock(s)),
      table(['Team', 'Goals', el('abbr', { title: 'Shots on goal', text: 'SOG' })], s.teams.map((t) => el('tr', {},
        teamCell(t), el('td', { class: 'mc-strong mc-big', text: t.score }), el('td', { text: t.shots })))),
      facts([
        ['Power play', pp ? [`${pp.team} until ${pp.until}`, el('small', { text: ` · ${pp.penalty}` })] : 'Even strength'],
        Boolean(s.empty_net) && ['Empty net', `${s.empty_net} goalie pulled`],
      ])),
    card('goals', el('h3', { class: 'mc-sub-head', text: 'Goals this period' }),
      s.goals.length
        ? table(['Time', 'Goal'], s.goals.map((g) => el('tr', {},
          el('td', { class: 'mc-strong', text: g.time }),
          el('th', { scope: 'row', class: 'mc-l' },
            el('span', { class: 'mc-name' }, swatch(code(g.team)), g.scorer),
            el('span', { class: 'mc-how', text: [g.team, g.strength, g.assists.length ? `Assists: ${g.assists.join(', ')}` : 'Unassisted'].join(' · ') })))), { left: [1] })
        : el('p', { class: 'mc-card-note', text: 'No goals yet this period.' })),
    card('penalties', el('h3', { class: 'mc-sub-head', text: 'Penalties this period' }),
      s.penalties.length
        ? table(['Time', 'Player', 'Infraction'], s.penalties.map((p) => el('tr', {},
          el('td', { class: 'mc-strong', text: p.time }),
          el('th', { scope: 'row', class: 'mc-l' }, el('span', { class: 'mc-name' }, swatch(code(p.team)), p.player), el('span', { class: 'mc-how', text: p.team })),
          el('td', { text: p.infraction }))), { left: [1] })
        : el('p', { class: 'mc-card-note', text: 'No penalties yet this period.' })),
  ];
}

// ---- Commentary, overs and play by play ----

const BALL_WORDS: Record<string, string> = { '0': 'dot ball', '4': 'four', '6': 'six', W: 'wicket', wd: 'wide', nb: 'no ball', lb: 'leg bye', b: 'bye' };
const ballWord = (sym: string) => BALL_WORDS[sym] ?? (/^\d+$/.test(sym) ? plural(Number(sym), 'run') : sym);
const ballClass = (sym: string) => (sym === 'W' ? 'b-w' : sym === '4' ? 'b-4' : sym === '6' ? 'b-6' : sym === '0' ? 'b-0' : /^\d+$/.test(sym) ? 'b-run' : 'b-x');

function ball(sym: string) {
  const face = sym === '0' ? el('span', { class: 'mc-ball b-0', 'aria-hidden': 'true' }, icon('dot'))
    : el('span', { class: `mc-ball ${ballClass(sym)}`, 'aria-hidden': 'true', text: sym });
  return [face, sr(ballWord(sym))];
}

const lineKey = (c: Line) => c.event_id || `${c.over ?? ''}|${c.text.slice(0, 48)}`;

function commentary(lines: Line[]): Child {
  if (!lines.length) return empty('No commentary yet', 'Commentary appears once play starts.');
  return el('ol', { class: 'mc-com' }, lines.map((c) => {
    if (c.kind === 'overend') {
      const sum = /^End of over (\d+):\s*(.+)$/.exec(c.text); // "End of over 17: 6 runs. CSK 164/3."
      return el('li', { class: 'mc-eoo', dataset: { key: lineKey(c) } },
        el('b', { text: sum ? `End of over ${sum[1]}` : c.label || 'End of over' }), el('span', { text: sum ? sum[2] : c.text }));
    }
    const note = !c.symbol && c.kind === 'event';
    return el('li', { class: `mc-com-item${c.symbol === 'W' ? ' is-wicket' : ''}`, dataset: { key: lineKey(c) } },
      el('div', { class: 'mc-com-side' }, c.over ? el('span', { class: 'mc-com-over', text: c.over }) : null, c.symbol ? ball(c.symbol) : null),
      note
        ? el('div', { class: 'mc-com-note' }, c.label ? el('b', { text: c.label }) : null, el('p', { text: c.text }))
        : el('p', { class: 'mc-com-text', text: c.text }));
  }));
}

// The over a ball was bowled in, 0-based: "18.4" is a ball of over 18, the 19th.
function overIndex(c: Line): number | null {
  if (!c.symbol || !c.over) return null;
  const m = /^(\d+)\.\d+$/.exec(c.over);
  return m ? Number(m[1]) : null;
}

// Runs in each over and the score at its end, by 1-based over. The wickets down at the end of an over are counted
// back from the current score, so only while the graph's overs run without a gap up to the over in progress.
function overScores(g: CricketGraph | null, s: CricketScore) {
  const out = new Map<number, { runs: number; score: string }>();
  if (!g) return out;
  const overs = [...g.overs].sort((a, b) => a.over - b.over);
  let wkts: number | null = overs.length && overs[overs.length - 1].over >= Math.ceil(s.balls / 6) ? s.wickets : null;
  for (let i = overs.length - 1; i >= 0; i--) {
    const o = overs[i];
    if (i < overs.length - 1 && overs[i + 1].over !== o.over + 1) wkts = null;
    out.set(o.over, { runs: o.runs, score: wkts === null ? String(o.total) : `${o.total}-${wkts}` });
    if (wkts !== null) wkts -= o.wickets;
  }
  return out;
}

function oversPanel(lines: Line[], g: CricketGraph | null, s: CricketScore): Child {
  const byOver = new Map<number, Line[]>();
  for (let i = lines.length - 1; i >= 0; i--) { // oldest first, as the balls were bowled
    const k = overIndex(lines[i]);
    if (k !== null) byOver.set(k, [...(byOver.get(k) ?? []), lines[i]]);
  }
  const after = overScores(g, s);
  const overs = [...new Set([...byOver.keys(), ...[...after.keys()].map((o) => o - 1)])].sort((a, b) => b - a);
  if (!overs.length) return empty('No overs yet', 'Each over appears here once it is under way.');
  return el('ol', { class: 'mc-overs' }, overs.map((k) => {
    const balls = byOver.get(k) ?? [];
    const info = after.get(k + 1);
    // Without the full commentary an over's first balls may be missing; say so rather than show a short over.
    const cut = balls.length > 0 && balls[0].over !== `${k}.1`;
    return el('li', { class: 'mc-over', dataset: { key: `ov-${k}` } },
      el('b', { class: 'mc-over-num' }, el('span', { 'aria-hidden': 'true', text: `Ov ${k + 1}` }), sr(`Over ${k + 1}`)),
      balls.length
        ? el('div', { class: 'mc-over-balls' }, cut ? [el('span', { class: 'mc-over-more', 'aria-hidden': 'true', text: '…' }), sr('earlier balls not loaded')] : null,
          balls.map((b) => ball(b.symbol ?? '')))
        : el('p', { class: 'mc-over-none', text: 'No ball-by-ball record' }),
      el('div', { class: 'mc-over-total' }, info ? [el('b', { text: plural(info.runs, 'run') }), el('span', { text: `${s.batting} ${info.score}` })] : null));
  }));
}

// "Q4 5:41" is 5:41 in quarter 4; F1 lines carry the lap ("Lap 45").
function periodOf(clock: string | null, sport: Sport) {
  if (!clock) return '';
  if (sport === 'f1') return clock;
  const m = /^([QP])(\d+)\s/.exec(clock);
  return m ? `${m[1] === 'Q' ? 'Quarter' : 'Period'} ${m[2]}` : clock.split(' ').length > 1 ? clock.split(' ')[0] : '';
}

const timeOf = (clock: string | null, sport: Sport) => (!clock || sport === 'f1' ? '' : /(\d{1,2}:\d{2})$/.exec(clock)?.[1] ?? clock);

function playByPlay(lines: Line[], sport: Sport): Child {
  if (!lines.length) return empty('No plays yet', 'Play by play appears once play starts.');
  const groups: { name: string; rows: Line[] }[] = [];
  for (const c of lines) {
    const name = periodOf(c.over, sport);
    const last = groups[groups.length - 1];
    if (last && last.name === name) last.rows.push(c);
    else groups.push({ name, rows: [c] });
  }
  const seen = new Map<string, number>();
  return groups.map((g) => {
    const n = (seen.get(g.name) ?? 0) + 1;
    seen.set(g.name, n);
    return card(`pbp-${g.name}-${n}`,
      g.name ? el('h3', { class: 'mc-sub-head', text: g.name }) : null,
      el('ol', { class: 'mc-pbp' }, g.rows.map((c) => el('li', { class: 'mc-pbp-row', dataset: { key: lineKey(c) } },
        el('span', { class: 'mc-pbp-time', text: timeOf(c.over, sport) }),
        el('p', {}, c.kind === 'event' && c.label ? el('b', { class: 'mc-tag', text: c.label }) : null, c.text)))));
  });
}

// ---- Graphs: inline SVG, no libraries ----

// What survives a redraw: which data tables are open and the point a reader picked on each chart.
interface ChartState { open: Set<string>; picks: Map<string, number> }

interface Frame { w: number; h: number; l: number; r: number; t: number; b: number }
interface Tick { x: number; label: string }
type KeyKind = 'line' | 'dashed' | 'bar' | 'dot' | 'target';
interface LegendKey { label: string; kind: KeyKind; cls?: string; style?: string | null }

// A chart: its marks, the x of each point a reader can pick, what each point says, and the marks that show the pick.
interface Plot {
  key: string;
  title: string;
  summary: string;
  frame: Frame;
  marks: SVGElement[];
  xs: number[];
  describe(i: number): string;
  pick(i: number): SVGElement[];
  legend: LegendKey[];
  table?: { head: string[]; rows: (string | number)[][] };
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number | null | undefined> = {}, ...kids: (Node | string)[]) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, String(v));
  node.append(...kids);
  return node;
}

const r2 = (v: number) => Math.round(v * 100) / 100;
const scale = (d0: number, d1: number, r0: number, r1: number) => (v: number) => r0 + ((v - d0) / (d1 - d0 || 1)) * (r1 - r0);

// Round ticks covering lo..hi, in steps of 1, 2 or 5 times a power of ten.
function ticks(lo: number, hi: number, want = 4): number[] {
  const raw = (hi - lo || 1) / want;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((f) => f * mag).find((s) => s >= raw) ?? raw;
  const first = Math.floor(lo / step) * step;
  const last = Math.ceil(hi / step) * step;
  const out: number[] = [];
  for (let v = first; v <= last + step / 1e6; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

// Integer ticks from lo to hi, spaced at least 24 units apart (room for a two-digit label either side).
function intTicks(lo: number, hi: number, x: (v: number) => number): Tick[] {
  const unit = Math.abs(x(lo + 1) - x(lo));
  const every = [1, 2, 5, 10, 20].find((n) => n * unit >= 24) ?? 50;
  const out: Tick[] = [];
  for (let v = Math.ceil(lo / every) * every; v <= hi; v += every) out.push({ x: x(v), label: String(v) });
  return out;
}

function axes(f: Frame, yTicks: number[], y: (v: number) => number, yFormat: (v: number) => string, xTicks: Tick[], xTitle: string, yTitle: string) {
  const base = f.h - f.b;
  const anchor = (x: number) => (x <= f.l + 8 ? 'start' : x >= f.w - f.r - 8 ? 'end' : 'middle');
  return [
    ...yTicks.flatMap((v) => [
      svg('line', { class: 'mc-grid', x1: f.l, x2: f.w - f.r, y1: r2(y(v)), y2: r2(y(v)) }),
      svg('text', { x: f.l - 5, y: r2(y(v)), dy: '0.32em', 'text-anchor': 'end' }, yFormat(v)),
    ]),
    svg('line', { class: 'mc-base', x1: f.l, x2: f.w - f.r, y1: base, y2: base }),
    ...xTicks.map((t) => svg('text', { x: r2(t.x), y: base + 13, 'text-anchor': anchor(t.x) }, t.label)),
    svg('text', { class: 'mc-axis-title', x: f.w - f.r, y: f.h - 3, 'text-anchor': 'end' }, xTitle),
    svg('text', { class: 'mc-axis-title', x: 0, y: 10 }, yTitle),
  ];
}

const crosshair = (f: Frame, x: number) => svg('line', { class: 'mc-cross', x1: r2(x), x2: r2(x), y1: f.t, y2: f.h - f.b });

// A bar with a rounded top, square at the baseline.
function barPath(x: number, y: number, w: number, h: number, r = 3) {
  if (h <= 0) return '';
  const k = Math.min(r, w / 2, h);
  return `M${r2(x)},${r2(y + h)}V${r2(y + k)}Q${r2(x)},${r2(y)} ${r2(x + k)},${r2(y)}H${r2(x + w - k)}Q${r2(x + w)},${r2(y)} ${r2(x + w)},${r2(y + k)}V${r2(y + h)}Z`;
}

// Team colours come from the .t-<code> classes; a team without one gets a spare colour.
function colour(code: string | null, i: number) {
  const cls = teamClass(code);
  return { cls, style: cls ? null : `--team: ${SPARE[i % SPARE.length]}` };
}

function graphsPanel(v: View, m: MatchInfo, charts: ChartState): Child {
  const none = empty('No graph yet', 'Graphs fill in as the match goes on.');
  if (v.sport === 'cricket') {
    const g = v.graph;
    if (!g || !g.overs.length) return none;
    const overs = [...g.overs].sort((a, b) => a.over - b.over);
    const sorted = { ...g, overs };
    // The x axis runs to the end of the innings, so the overs still to come show as room on the right.
    const limit = /\bT(\d+)$/i.exec(m.format ?? '')?.[1]; // "IPL T20": 20 overs
    const lastOver = limit ? Number(limit) : m.format === 'ODI' ? 50 : overs[overs.length - 1].over;
    // The last entry is the over in progress until its sixth legal ball.
    const live = !v.score.result && overs[overs.length - 1].over > v.score.balls / 6 ? v.score.balls : null;
    return [plotCard(manhattan(sorted, lastOver, live), charts), plotCard(worm(sorted, lastOver, live), charts)];
  }
  const plot = v.sport === 'f1' ? v.graph && gapPlot(v.graph, v.score) : v.graph && scorePlot(v.graph, v.score.teams, v.sport === 'hockey' ? 'Goals' : 'Points');
  return plot ? plotCard(plot, charts) : none;
}

function plotCard(p: Plot, charts: ChartState) {
  const f = p.frame;
  const id = `mc-plot-${++ids}`;
  const layer = svg('g', { class: 'mc-picked' });
  const chart = svg('svg', { class: 'mc-svg', viewBox: `0 0 ${f.w} ${f.h}`, role: 'img', 'aria-labelledby': `${id}-t ${id}-d` },
    svg('title', { id: `${id}-t` }, p.title), svg('desc', { id: `${id}-d` }, p.summary), ...p.marks, layer);
  const readout = el('p', { class: 'mc-readout', 'aria-live': 'polite' });
  const frame = el('div', { class: 'mc-plot', tabindex: '0', role: 'group', 'aria-label': `${p.title}. Use the arrow keys to read each point.`, dataset: { fk: `plot-${p.key}` } }, chart);
  let at: number | null = null;
  // A reader's pick draws its marks and stays across redraws; until then the readout shows the latest point.
  const show = (i: number, picked: boolean) => {
    const k = Math.max(0, Math.min(p.xs.length - 1, i));
    at = picked ? k : null;
    readout.textContent = p.describe(k);
    layer.replaceChildren(...(picked ? p.pick(k) : []));
    if (picked) charts.picks.set(p.key, k);
  };
  const nearest = (clientX: number) => {
    const box = chart.getBoundingClientRect();
    const x = ((clientX - box.left) / (box.width || 1)) * f.w;
    let best = 0;
    p.xs.forEach((px, i) => { if (Math.abs(px - x) < Math.abs(p.xs[best] - x)) best = i; });
    return best;
  };
  chart.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') show(nearest(e.clientX), true); });
  chart.addEventListener('pointerdown', (e) => show(nearest(e.clientX), true));
  frame.addEventListener('keydown', (e) => {
    const from = at ?? p.xs.length - 1;
    const to = e.key === 'ArrowRight' ? from + 1 : e.key === 'ArrowLeft' ? from - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? p.xs.length - 1 : null;
    if (to === null) return;
    e.preventDefault(); // the arrows step through the chart rather than swipe the panels
    show(to, true);
  });
  const saved = charts.picks.get(p.key);
  show(saved ?? p.xs.length - 1, saved !== undefined && saved < p.xs.length);
  const tableKey = `table-${p.key}`;
  return card(`plot-${p.key}`,
    el('h3', { class: 'mc-card-title', text: p.title }),
    el('div', { class: 'mc-chart' }, readout, frame,
      p.legend.length ? el('ul', { class: 'mc-legend' }, p.legend.map((k) => el('li', {},
        el('span', { class: `mc-key is-${k.kind} ${k.cls ?? ''}`, style: k.style ?? null, 'aria-hidden': 'true' }), k.label))) : null),
    p.table ? el('details', {
      class: 'mc-data', open: charts.open.has(tableKey),
      ontoggle: (e) => { if (e.currentTarget.open) charts.open.add(tableKey); else charts.open.delete(tableKey); },
    },
    el('summary', { dataset: { fk: tableKey }, text: 'Data table' }),
    table(p.table.head, p.table.rows.map((r) => el('tr', {}, r.map((c, i) => (i === 0 ? el('th', { scope: 'row', text: c }) : el('td', { text: c })))))))
      : null);
}

// Manhattan: the runs of each over as bars, a red dot on top for each wicket in it. `live`: the legal balls bowled
// when the last over is still in progress (drawn lighter), else null.
function manhattan(g: CricketGraph, lastOver: number, live: number | null): Plot {
  const overs = g.overs;
  const first = overs[0].over;
  const end = Math.max(overs[overs.length - 1].over, lastOver);
  const f: Frame = { w: 320, h: 184, l: 30, r: 8, t: 24, b: 32 };
  const slot = (f.w - f.l - f.r) / (end - first + 1);
  const bw = Math.min(16, slot * 0.64);
  const yt = ticks(0, Math.max(6, ...overs.map((o) => o.runs)));
  const y = scale(0, yt[yt.length - 1], f.h - f.b, f.t);
  const cx = (over: number) => f.l + (over - first + 0.5) * slot;
  const base = f.h - f.b;
  const isLive = (i: number) => live !== null && i === overs.length - 1;
  const bar = (o: OverPoint, i: number, picked = false) => svg('path', {
    class: `mc-bar${isLive(i) ? ' is-live' : ''}${picked ? ' is-picked' : ''}`, d: barPath(cx(o.over) - bw / 2, y(o.runs), bw, base - y(o.runs)),
  });
  const most = overs.reduce((a, b) => (b.runs > a.runs ? b : a));
  const fell = overs.filter((o) => o.wickets > 0).map((o) => o.over);
  return {
    key: 'manhattan',
    title: 'Manhattan: runs per over',
    summary: `Runs in each over from over ${first} to over ${overs[overs.length - 1].over}${live === null ? '' : ', the last one still in progress'}. `
      + `Most: ${plural(most.runs, 'run')} in over ${most.over}. `
      + (fell.length ? `Wickets fell in over${fell.length > 1 ? 's' : ''} ${fell.join(', ')}.` : 'No wickets fell in these overs.'),
    frame: f,
    marks: [
      ...axes(f, yt, y, String, intTicks(first, end, cx), 'Over', 'Runs'),
      ...overs.map((o, i) => bar(o, i)),
      ...overs.flatMap((o) => Array.from({ length: o.wickets }, (_, k) => svg('circle', { class: 'mc-wkt', cx: r2(cx(o.over)), cy: r2(y(o.runs) - 7 - k * 9), r: 3.5 }))),
    ],
    xs: overs.map((o) => cx(o.over)),
    describe: (i) => {
      const o = overs[i];
      return `Over ${o.over}${isLive(i) ? ' so far' : ''}: ${plural(o.runs, 'run')}${o.wickets ? `, ${plural(o.wickets, 'wicket')}` : ''} · total ${o.total}`;
    },
    pick: (i) => [bar(overs[i], i, true)],
    legend: [
      { label: 'Runs in the over', kind: 'bar' },
      ...(live === null ? [] : [{ label: 'This over so far', kind: 'bar' as const, cls: 'is-live' }]),
      { label: 'Wicket', kind: 'dot' },
    ],
    table: { head: ['Over', 'Runs', 'Wickets', 'Total'], rows: overs.map((o, i) => [isLive(i) ? `${o.over} (so far)` : o.over, o.runs, o.wickets, o.total]) },
  };
}

// Worm: the innings total after each over, from where the ball-by-ball record begins, with the target line. An over
// in progress is plotted where the innings stands (17.4 overs), not at its end.
function worm(g: CricketGraph, lastOver: number, live: number | null): Plot {
  const overs = g.overs;
  const pts = [{ over: overs[0].over - 1, wickets: 0, total: overs[0].total - overs[0].runs }, ...overs].map((p, i, all) => {
    const now = live !== null && i === all.length - 1;
    return { at: now ? live / 6 : p.over, when: now ? `After ${oversText(live)} overs` : `After over ${p.over}`, wickets: p.wickets, total: p.total };
  });
  const from = pts[0].at;
  const end = Math.max(overs[overs.length - 1].over, lastOver, from + 1);
  const f: Frame = { w: 320, h: 184, l: 34, r: 28, t: 24, b: 32 };
  const yt = ticks(0, Math.max(10, g.target ?? 0, ...pts.map((p) => p.total)));
  const y = scale(0, yt[yt.length - 1], f.h - f.b, f.t);
  const x = scale(from, end, f.l, f.w - f.r);
  const last = pts[pts.length - 1];
  const target = g.target;
  return {
    key: 'worm',
    title: 'Worm: runs after each over',
    summary: `The innings total after each over from over ${from}${target ? `, with the target of ${target}` : ''}. ${last.when}: ${last.total}.`,
    frame: f,
    marks: [
      ...axes(f, yt, y, String, intTicks(from, end, x), 'Over', 'Runs'),
      ...(target ? [
        svg('line', { class: 'mc-target', x1: f.l, x2: f.w - f.r, y1: r2(y(target)), y2: r2(y(target)) }),
        svg('text', { class: 'mc-val', x: f.l + 4, y: r2(y(target) - 5) }, `Target ${target}`),
      ] : []),
      svg('path', { class: 'mc-line', d: pts.map((p, i) => `${i ? 'L' : 'M'}${r2(x(p.at))},${r2(y(p.total))}`).join('') }),
      svg('circle', { class: 'mc-end', cx: r2(x(last.at)), cy: r2(y(last.total)), r: 4 }),
      ...pts.filter((p) => p.wickets > 0).map((p) => svg('circle', { class: 'mc-wkt', cx: r2(x(p.at)), cy: r2(y(p.total)), r: 4 })),
      svg('text', { class: 'mc-val', x: r2(x(last.at) + 7), y: r2(y(last.total)), dy: '0.32em' }, String(last.total)),
    ],
    xs: pts.map((p) => x(p.at)),
    describe: (i) => {
      const p = pts[i];
      const need = target ? (p.total >= target ? ' · target reached' : ` · ${plural(target - p.total, 'run')} short of the target`) : '';
      return `${p.when}: ${p.total}${p.wickets ? ` (${plural(p.wickets, 'wicket')} in the over)` : ''}${need}`;
    },
    pick: (i) => [crosshair(f, x(pts[i].at)), svg('circle', { class: 'mc-pick-dot', cx: r2(x(pts[i].at)), cy: r2(y(pts[i].total)), r: 4.5 })],
    legend: [{ label: 'Runs', kind: 'line' }, { label: 'Wicket', kind: 'dot' }, ...(target ? [{ label: 'Target', kind: 'target' as const }] : [])],
  };
}

// "Q4 5:41" → the seconds on the clock.
function clockSeconds(label: string): number | null {
  const m = /(\d{1,2}):(\d{2})$/.exec(label);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// Basketball and hockey: each team's score as a step line in its colour (the second team dashed, as the two colours
// can be close), placed by the game clock while it runs down within one period, else play by play.
function scorePlot(g: ScoreGraph, teams: TeamRef[], unit: string): Plot | null {
  const pts = g.points;
  const [ca, cb] = g.teams;
  if (!pts.length || !ca || !cb) return null;
  const name = (code: string) => teams.find((t) => t.code === code)?.name || code;
  const secs = pts.map((p) => clockSeconds(p.label));
  let timed = true;
  secs.forEach((s, i) => { if (s === null || (i > 0 && (secs[i - 1] === null || s > (secs[i - 1] ?? 0)))) timed = false; });
  const top = secs[0] ?? 0;
  const xv = pts.map((_, i) => (timed ? top - (secs[i] ?? 0) : i));
  const f: Frame = { w: 320, h: 190, l: 32, r: 50, t: 24, b: 34 };
  const values = pts.flatMap((p) => [p.a, p.b]);
  const yt = ticks(Math.min(...values), Math.max(...values));
  const y = scale(yt[0], yt[yt.length - 1], f.h - f.b, f.t);
  // A running clock's axis goes on to 0:00, so the time left in the period shows as room on the right.
  const x = scale(xv[0], Math.max(timed ? top : 0, xv[xv.length - 1], xv[0] + 1), f.l, f.w - f.r);
  const step = (vs: number[]) => vs.map((v, i) => (i ? `H${r2(x(xv[i]))}V${r2(y(v))}` : `M${r2(x(xv[0]))},${r2(y(v))}`)).join('');
  const A = colour(ca, 0);
  const B = colour(cb, 1);
  const last = pts[pts.length - 1];
  const xTicks: Tick[] = [];
  if (timed) {
    const every = [1, 2, 5, 10].find((n) => top / 60 / n <= 6) ?? 20;
    for (let mins = 0; mins * 60 <= top; mins += every) xTicks.push({ x: x(top - mins * 60), label: `${mins}:00` });
  } else {
    xTicks.push({ x: x(xv[0]), label: pts[0].label }, { x: x(xv[xv.length - 1]), label: last.label });
  }
  const period = /^(\S+)\s+\d{1,2}:\d{2}$/.exec(pts[0].label)?.[1];
  // End labels only where they clear each other; the legend and the readout carry the rest.
  const ya = y(last.a);
  const yb = y(last.b);
  const xEnd = r2(x(xv[xv.length - 1]) + 6);
  const ends = Math.abs(ya - yb) >= 11 ? [
    svg('text', { class: 'mc-val', x: xEnd, y: r2(ya), dy: '0.32em' }, `${ca} ${last.a}`),
    svg('text', { class: 'mc-val', x: xEnd, y: r2(yb), dy: '0.32em' }, `${cb} ${last.b}`),
  ] : [];
  const dot = (c: { cls: string; style: string | null }, xx: number, yy: number) => svg('circle', { class: `mc-pick-dot ${c.cls}`, style: c.style, cx: r2(xx), cy: r2(yy), r: 4.5 });
  return {
    key: 'score',
    title: 'Score progression',
    summary: `The score after every change, ${name(ca)} as a solid line and ${name(cb)} dashed, from ${pts[0].label} to ${last.label}. `
      + `Latest: ${name(ca)} ${last.a}, ${name(cb)} ${last.b}.`,
    frame: f,
    marks: [
      ...axes(f, yt, y, String, xTicks, timed ? `Game clock${period ? `, ${period}` : ''}` : 'Play', unit),
      svg('path', { class: `mc-series ${A.cls}`, style: A.style, d: step(pts.map((p) => p.a)) }),
      svg('path', { class: `mc-series is-b ${B.cls}`, style: B.style, d: step(pts.map((p) => p.b)) }),
      ...ends,
    ],
    xs: xv.map((v) => x(v)),
    describe: (i) => `${pts[i].label}: ${name(ca)} ${pts[i].a}, ${name(cb)} ${pts[i].b}`,
    pick: (i) => [crosshair(f, x(xv[i])), dot(A, x(xv[i]), y(pts[i].a)), dot(B, x(xv[i]), y(pts[i].b))],
    legend: [{ label: name(ca), kind: 'line', cls: A.cls, style: A.style }, { label: name(cb), kind: 'dashed', cls: B.cls, style: B.style }],
    table: { head: ['Time', name(ca), name(cb)], rows: pts.map((p) => [p.label, p.a, p.b]) },
  };
}

// F1: each listed driver's gap to the leader on every lap, the leader on top. Team-mates share a colour, the second
// one dashed, as on the broadcast graphics.
function gapPlot(g: GapGraph, s: F1Score): Plot | null {
  const laps = [...g.laps].sort((a, b) => a.lap - b.lap);
  const drivers = g.drivers.filter((code) => laps.some((l) => isNum(l.gaps[code])));
  if (!laps.length || !drivers.length) return null;
  const f: Frame = { w: 320, h: 200, l: 34, r: 34, t: 24, b: 34 };
  const first = laps[0].lap;
  const end = Math.max(laps[laps.length - 1].lap, s.total_laps || 0, first + 1);
  const gapsOf = (code: string) => laps.flatMap((l) => (isNum(l.gaps[code]) ? [l.gaps[code]] : []));
  const yt = ticks(0, Math.max(1, ...drivers.flatMap(gapsOf)));
  const y = scale(0, yt[yt.length - 1], f.t, f.h - f.b);
  const x = scale(first, end, f.l, f.w - f.r);
  const mates = new Map<string, number>();
  const traces = drivers.map((code, i) => {
    const car = s.order.find((c) => c.code === code);
    const team = car ? F1_TEAMS[car.team] ?? null : null;
    const n = team ? mates.get(team) ?? 0 : 0;
    if (team) mates.set(team, n + 1);
    const c = colour(team, i);
    let d = '';
    let pen = 'M';
    for (const l of laps) {
      const v = l.gaps[code];
      if (!isNum(v)) {
        pen = 'M';
        continue;
      }
      d += `${pen}${r2(x(l.lap))},${r2(y(v))}`;
      pen = 'L';
    }
    return { code, name: car?.name ?? code, cls: `${c.cls}${n ? ' is-b' : ''}`, style: c.style, dashed: n > 0, d };
  });
  const lastLap = laps[laps.length - 1].lap;
  // Driver codes at the line ends, dropping any that would overlap the one above.
  const ends = traces.flatMap((t) => {
    const final = [...laps].reverse().find((l) => isNum(l.gaps[t.code]));
    return final ? [{ y: y(final.gaps[t.code]), code: t.code }] : [];
  }).sort((a, b) => a.y - b.y);
  const shown = ends.filter((e, i) => i === 0 || e.y - ends[i - 1].y >= 11);
  return {
    key: 'gaps',
    title: 'Gap to the leader',
    summary: `Seconds behind the leader on each lap from lap ${first} to lap ${lastLap}, for ${traces.map((t) => t.name).join(', ')}. The leader is at the top.`,
    frame: f,
    marks: [
      ...axes(f, yt, y, (v) => `${v}s`, intTicks(first, end, x), 'Lap', 'Seconds behind the leader'),
      ...traces.map((t) => svg('path', { class: `mc-series ${t.cls}`, style: t.style, d: t.d })),
      ...shown.map((e) => svg('text', { class: 'mc-val', x: r2(x(lastLap) + 6), y: r2(e.y), dy: '0.32em' }, e.code)),
    ],
    xs: laps.map((l) => x(l.lap)),
    describe: (i) => {
      const l = laps[i];
      const rows = traces.flatMap((t) => (isNum(l.gaps[t.code]) ? [{ code: t.code, v: l.gaps[t.code] }] : [])).sort((a, b) => a.v - b.v);
      return `Lap ${l.lap}: ${rows.map((r) => (r.v === 0 ? `${r.code} leads` : `${r.code} +${r.v.toFixed(1)}s`)).join(' · ')}`;
    },
    pick: (i) => [crosshair(f, x(laps[i].lap)), ...traces.flatMap((t) => {
      const v = laps[i].gaps[t.code];
      return isNum(v) ? [svg('circle', { class: `mc-pick-dot ${t.cls}`, style: t.style, cx: r2(x(laps[i].lap)), cy: r2(y(v)), r: 4.5 })] : [];
    })],
    legend: traces.map((t) => ({ label: `${t.code} · ${t.name}`, kind: t.dashed ? 'dashed' : 'line', cls: t.cls, style: t.style })),
    table: {
      head: ['Lap', ...traces.map((t) => t.code)],
      rows: laps.map((l) => [l.lap, ...traces.map((t) => {
        const v = l.gaps[t.code];
        return isNum(v) ? (v === 0 ? 'Leader' : `+${v.toFixed(1)}`) : DASH;
      })]),
    },
  };
}
