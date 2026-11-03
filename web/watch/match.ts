// The room's match tabs, a Cricbuzz-style match page beside the chat: Commentary (play by play in every sport),
// Scorecard (with the over-by-over record in cricket), Stats and Graphs (the win predictor first). They show
// GET /api/rooms/:id/match?detail=1, fetched the first time a match tab opens; the room calls update() whenever the
// match moves on.
import { api, errorMessage } from './api.ts';
import { el, icon, plural, teamClass, teamLogo, type Child } from './ui.ts';

// panels: one per tab, in the order of MATCH_TABS, for the room to place in its pager after the Chat tab. Each ends
// with the one note on the match data.
export interface MatchTabs {
  panels: HTMLElement[];
  open(): void; // a match tab is on screen: the first call fetches the detail
  update(): void; // the match moved on: refetches, once opened, at most about once every 2 s
  destroy(): void;
}

export const MATCH_TABS = ['Commentary', 'Scorecard', 'Stats'];

// The one place in the app that says what the match data are.
const NOTE = 'Match data and crowd chat in this prototype are illustrative.';
const REFETCH_MS = 2000;
const DASH = '–';
// What the win predictor always says about itself.
const ESTIMATE = 'Estimate from the score and time left · not an official prediction';

type Innings = 'current' | 'first';

// `logo` when the server sends one; teamLogo() otherwise uses assets/<code>.png.
interface TeamRef { code: string; name: string; logo?: string }
interface MatchInfo { sport: string; format?: string | null; teams: TeamRef[] }

// A commentary line, newest first. `over` is a cricket ball's over.ball ("18.4"), the overs bowled for other cricket
// lines, and the clock in the other sports ("Q4 5:41", "2H 12:41", "72'"). `symbol` is set on cricket balls only
// ("0".."6", "W", "wd", "nb").
interface Line { event_id?: string; kind: string; over: string | null; symbol: string | null; label: string | null; text: string }

// `over` is 1-based and `total` the innings score at its end; the over in progress comes last.
interface OverPoint { over: number; runs: number; wickets: number; total: number }
interface CricketGraph { kind: 'cricket'; target: number | null; overs: OverPoint[] }
interface ScoreGraph { kind: 'score'; teams: string[]; points: { label: string; a: number; b: number }[] }

// The Stats tab: each team side by side (`a` and `b` follow `teams`), or a list of facts.
type StatSection =
  | { title: string; kind: 'compare'; teams: [string, string]; rows: { label: string; a: number; b: number; unit?: '%' }[] }
  | { title: string; kind: 'list'; rows: ListRow[] };
interface ListRow { label: string; value: string; note?: string }

// The win predictor: whole percentages for teams [a, b] (and a draw in football) that add up to 100, at the start of
// the run and after each play.
interface Split { a: number; b: number; draw?: number }
interface Prediction {
  teams: [string, string];
  points: (Split & { label: string })[];
  now: Split;
  projections: ListRow[];
  method: string;
}

// GET /api/rooms/:id/match?detail=1: only the fields read here. Without detail the server sends no graphs and only
// the last 10 lines of commentary, which the tabs show as they are.
interface Detail {
  match: MatchInfo;
  score: unknown; // one shape per sport: see viewOf()
  commentary?: Line[] | null;
  graphs?: CricketGraph | ScoreGraph | null;
  stats?: { sections: StatSection[] } | null;
  prediction?: Prediction | null;
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
type TeamScore<T> = TeamRef & { score: number } & T;
interface BasketballScore {
  period: string;
  clock: string;
  result: string | null;
  teams: TeamScore<{ team_fouls: number; leaders: { name: string; pts: number }[] }>[];
}
// `clock` is the time left in the half; `raiding` the team that raids next.
interface KabaddiScore {
  half: number;
  clock: string;
  result: string | null;
  raiding: string;
  do_or_die: boolean;
  teams: TeamScore<{ on_mat: number; raid_points: number; tackle_points: number; all_out_points: number; extra_points: number }>[];
  raiders: { name: string; team: string; raid_points: number; raids: number }[];
  defenders: { name: string; team: string; tackle_points: number }[];
}
interface FootballScore {
  minute: string; // "72'", "90+3'"
  period: string;
  result: string | null;
  teams: TeamScore<{ shots: number; on_target: number; corners: number; fouls: number; yellow: number; red: number }>[];
  goals: { team: string; scorer: string; assist: string | null; minute: string; penalty: boolean }[];
  cards: { team: string; player: string; minute: string; card: 'yellow' | 'red' }[];
}

type View =
  | { sport: 'cricket'; score: CricketScore; graph: CricketGraph | null }
  | { sport: 'kabaddi'; score: KabaddiScore; graph: ScoreGraph | null }
  | { sport: 'football'; score: FootballScore; graph: ScoreGraph | null }
  | { sport: 'basketball'; score: BasketballScore; graph: ScoreGraph | null };

// The score's shape follows match.sport, which TypeScript cannot see: this is the one place it is asserted.
function viewOf(d: Detail): View {
  const g = d.graphs ?? null;
  const sg = g?.kind === 'score' ? g : null;
  switch (d.match.sport) {
    case 'kabaddi': return { sport: 'kabaddi', score: d.score as KabaddiScore, graph: sg };
    case 'football': return { sport: 'football', score: d.score as FootballScore, graph: sg };
    case 'basketball': return { sport: 'basketball', score: d.score as BasketballScore, graph: sg };
    default: return { sport: 'cricket', score: d.score as CricketScore, graph: g?.kind === 'cricket' ? g : null };
  }
}

// ---- The tabs ----

let ids = 0;

export function mountMatchTabs(roomId: string): MatchTabs {
  let alive = true;
  let opened = false;
  let data: Detail | null = null;
  let view: View | null = null;
  let signature = '';
  let innings: Innings = 'current';
  const charts: ChartState = { open: new Set(), picks: new Map() };
  let inflight = false;
  let queued = false;
  let lastFetch = 0;
  let waitTimer = 0;
  let ctrl: AbortController | null = null;

  const panels = [0, 1, 2, 3].map(() => el('section', { class: 'mc-panel' }));
  // Each panel: a notice when a refresh fails, the tab's content, and the note at the bottom.
  const notices = panels.map(() => el('p', { class: 'mc-notice', role: 'status' }));
  const notes = panels.map(() => el('p', { class: 'mc-note', text: NOTE }));
  const fill = (i: number, content: Child) => panels[i].replaceChildren(notices[i], ...nodes(content), notes[i]);
  const notify = (text: string) => notices.forEach((n) => { n.textContent = text; });
  showLoading();

  return { panels, open, update, destroy };

  function open() {
    if (!alive || opened) return;
    opened = true;
    void load();
  }

  function update() {
    if (!alive || !opened) return;
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

  function destroy() {
    alive = false;
    ctrl?.abort();
    clearTimeout(waitTimer);
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
    notify('');
    // The crowd lines and the freshness change on every call; only a change in the match redraws.
    const sig = JSON.stringify([d.match, d.score, d.commentary, d.graphs, d.stats, d.prediction]);
    if (sig === signature) return;
    signature = sig;
    data = d;
    view = viewOf(d);
    panels.forEach((_, i) => render(i));
  }

  // Before the first answer each tab shows the error with a retry; after it, the last good view stays up.
  function failed(err: unknown) {
    if (data) {
      notify(`Not updated: ${errorMessage(err)}`);
      return;
    }
    panels.forEach((panel, i) => fill(i, el('div', { class: 'mc-problem', role: 'alert' },
      el('p', { text: errorMessage(err) }),
      el('button', { type: 'button', class: 'mc-retry', text: 'Try again', onclick: () => { showLoading(); panel.focus({ preventScroll: true }); retry(); } }))));
  }

  function showLoading() {
    panels.forEach((_, i) => fill(i, el('div', { class: 'mc-loading', role: 'status' },
      el('span', { class: 'mc-sr', text: 'Loading the match…' }),
      el('div', { class: 'mc-skel' }), el('div', { class: 'mc-skel' }), el('div', { class: 'mc-skel is-short' }))));
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
    fill(i, content);
    if (anchor) {
      const again = panel.querySelector<HTMLElement>(`[data-key="${CSS.escape(anchor.key)}"]`);
      if (again) panel.scrollTop = topIn(again, panel) - anchor.offset;
    }
    if (focused) panel.querySelector<HTMLElement>(`[data-fk="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  }

  function panelContent(i: number, d: Detail, v: View): Child {
    const lines = (d.commentary ?? []).filter((c) => c.text);
    if (i === 0) return commentary(lines);
    if (i === 1) return scorecard(v, d.match, lines, innings, (which) => { innings = which; render(1); });
    return statsPanel(v, d.match, d.stats?.sections ?? [], d.prediction ?? null, charts);
  }
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
const halfName = (h: number) => (h === 1 ? 'First half' : h === 2 ? 'Second half' : `Half ${h}`);
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

// A team's logo before a name; `team` is a code or a team from the match data.
const named = (team: string | TeamRef, name: Child) => el('span', { class: 'mc-name mc-team' }, teamLogo(team), name);

// "72'" or "90+3'": the minutes played (93), and the minute the added time follows (90).
function minuteOf(label: string): { at: number; base: number } | null {
  const m = /^(\d{1,3})(?:\+(\d{1,2}))?'$/.exec(label.trim());
  return m ? { at: Number(m[1]) + Number(m[2] ?? 0), base: Number(m[1]) } : null;
}

// Where a game stands: "Q4 5:41", "Second half 12:41", "72' · Second half"; at the end, Final or Full time.
function gameClock(v: Exclude<View, { sport: 'cricket' }>): string {
  switch (v.sport) {
    case 'kabaddi': return v.score.result ? 'Full time' : `${halfName(v.score.half)} ${v.score.clock}`;
    case 'football': return v.score.result ? 'Full time' : `${v.score.minute} · ${v.score.period}`;
    case 'basketball': return v.score.result ? 'Final' : `${v.score.period} ${v.score.clock}`;
  }
}

// ---- Scorecard ----

function scorecard(v: View, m: MatchInfo, lines: Line[], innings: Innings, pick: (i: Innings) => void): Child {
  switch (v.sport) {
    case 'cricket': return cricketCard(v.score, m, innings, pick, overByOver(lines, v.graph, v.score));
    case 'kabaddi': return kabaddiCard(v.score, gameClock(v));
    case 'football': return footballCard(v.score, gameClock(v));
    case 'basketball': return basketballCard(v.score, gameClock(v));
  }
}

// "MI 186/6 (20)": the first innings, of which only the total is known.
function parseInnings(text: string) {
  const m = /^(\S+)\s+(\d+)\/(\d+)\s*\(([\d.]+)\)/.exec(text);
  return m ? { team: m[1], score: `${m[2]}-${m[3]}`, overs: m[4] } : null;
}

// `overs`: the over-by-over card, which follows the innings with ball-by-ball data.
function cricketCard(s: CricketScore, m: MatchInfo, innings: Innings, pick: (i: Innings) => void, overs: HTMLElement): Child {
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
    overs,
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

const teamCell = (t: TeamRef, short = false) => el('th', { scope: 'row' }, named(t, short ? t.code : t.name));
// A player and their side: the team's logo, the name, and a line of detail under it.
const playerCell = (team: string, name: Child, how?: string) => el('th', { scope: 'row', class: 'mc-l' }, named(team, name), how ? el('span', { class: 'mc-how', text: how }) : null);

function basketballCard(s: BasketballScore, when: string): Child {
  return [
    card('score', header('Score', when),
      table(['Team', 'PTS', 'Team fouls'], s.teams.map((t) => el('tr', {},
        teamCell(t), el('td', { class: 'mc-strong mc-big', text: t.score }), el('td', { text: t.team_fouls })))),
      el('p', { class: 'mc-foot-note', text: 'Team fouls count this quarter.' })),
    ...s.teams.map((t) => card(`leaders-${t.code}`,
      table([named(t, `${t.name} leaders`), 'PTS'], t.leaders.map((p) => el('tr', {},
        el('th', { scope: 'row', text: p.name }), el('td', { class: 'mc-strong', text: p.pts })))))),
  ];
}

// The seven on the mat, filled for each player still in.
function mat(n: number) {
  return el('span', { class: 'mc-mat' },
    el('span', { class: 'mc-mat-dots', 'aria-hidden': 'true' }, Array.from({ length: 7 }, (_, i) => el('i', { class: i < n ? 'is-on' : null }))),
    el('b', { 'aria-hidden': 'true', text: n }), sr(`${n} of 7`));
}

function kabaddiCard(s: KabaddiScore, when: string): Child {
  const raider = s.teams.find((t) => t.code === s.raiding);
  return [
    card('score', header('Score', when),
      table(['Team', 'PTS', 'On mat'], s.teams.map((t) => el('tr', {},
        teamCell(t), el('td', { class: 'mc-strong mc-big', text: t.score }), el('td', {}, mat(t.on_mat))))),
      s.result ? null : facts([['Next raid', [
        raider ? named(raider, raider.name) : s.raiding,
        s.do_or_die ? el('b', { class: 'mc-tag is-alert', text: 'Do-or-die' }) : null,
      ]]])),
    card('points', el('h3', { class: 'mc-sub-head', text: 'Points breakdown' }),
      table(['Team', 'Raid', 'Tackle', 'All out', 'Extra', 'Total'], s.teams.map((t) => el('tr', {},
        teamCell(t, true), el('td', { text: t.raid_points }), el('td', { text: t.tackle_points }), el('td', { text: t.all_out_points }),
        el('td', { text: t.extra_points }), el('td', { class: 'mc-strong', text: t.score }))))),
    card('raiders', el('h3', { class: 'mc-sub-head', text: 'Top raiders' }),
      s.raiders.length
        ? table(['Raider', 'Raids', 'Raid pts'], s.raiders.map((p) => el('tr', {},
          playerCell(p.team, p.name, p.team), el('td', { text: p.raids }), el('td', { class: 'mc-strong', text: p.raid_points }))))
        : el('p', { class: 'mc-card-note', text: 'No raid points yet.' })),
    card('defenders', el('h3', { class: 'mc-sub-head', text: 'Top defenders' }),
      s.defenders.length
        ? table(['Defender', 'Tackle pts'], s.defenders.map((p) => el('tr', {},
          playerCell(p.team, p.name, p.team), el('td', { class: 'mc-strong', text: p.tackle_points }))))
        : el('p', { class: 'mc-card-note', text: 'No tackle points yet.' })),
  ];
}

const cardMark = (card: 'yellow' | 'red') => el('span', { class: `mc-cardmark is-${card}`, 'aria-hidden': 'true' });

function footballCard(s: FootballScore, when: string): Child {
  const [a, b] = s.teams;
  const stats: [string, (t: FootballScore['teams'][number]) => number][] = [
    ['Shots', (t) => t.shots], ['On target', (t) => t.on_target], ['Corners', (t) => t.corners],
    ['Fouls', (t) => t.fouls], ['Yellow cards', (t) => t.yellow], ['Red cards', (t) => t.red],
  ];
  return [
    card('score', header('Score', when),
      table(['Team', 'Goals'], s.teams.map((t) => el('tr', {}, teamCell(t), el('td', { class: 'mc-strong mc-big', text: t.score }))))),
    card('goals', el('h3', { class: 'mc-sub-head', text: 'Goals' }),
      s.goals.length
        ? table(['Min', 'Goal'], s.goals.map((g) => el('tr', {},
          el('td', { class: 'mc-strong', text: g.minute }),
          playerCell(g.team, [g.scorer, g.penalty ? [' ', el('b', { class: 'mc-tag', 'aria-hidden': 'true', text: 'Pen' }), sr(', penalty')] : null],
            [g.team, g.assist ? `Assist: ${g.assist}` : null].filter(Boolean).join(' · ')))), { left: [1] })
        : el('p', { class: 'mc-card-note', text: 'No goals yet.' })),
    card('cards', el('h3', { class: 'mc-sub-head', text: 'Cards' }),
      s.cards.length
        ? table(['Min', 'Player', 'Card'], s.cards.map((c) => el('tr', {},
          el('td', { class: 'mc-strong', text: c.minute }),
          playerCell(c.team, c.player, c.team),
          el('td', {}, cardMark(c.card), c.card === 'red' ? 'Red' : 'Yellow'))), { left: [1] })
        : el('p', { class: 'mc-card-note', text: 'No cards yet.' })),
    a && b ? card('stats', el('h3', { class: 'mc-sub-head', text: 'Match stats' }),
      table(['', named(a, a.code), named(b, b.code)], stats.map(([label, of]) => el('tr', {},
        el('th', { scope: 'row', text: label }), el('td', { class: 'mc-strong', text: of(a) }), el('td', { class: 'mc-strong', text: of(b) }))))) : null,
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

// The over-by-over record at the end of the scorecard, newest over first: each ball's badge, the runs in the over and
// the score after it.
function overByOver(lines: Line[], g: CricketGraph | null, s: CricketScore) {
  const byOver = new Map<number, Line[]>();
  for (let i = lines.length - 1; i >= 0; i--) { // oldest first, as the balls were bowled
    const k = overIndex(lines[i]);
    if (k !== null) byOver.set(k, [...(byOver.get(k) ?? []), lines[i]]);
  }
  const after = overScores(g, s);
  const overs = [...new Set([...byOver.keys(), ...[...after.keys()].map((o) => o - 1)])].sort((a, b) => b - a);
  return card('overs', header('Over by over'), overs.length ? el('ol', { class: 'mc-overs' }, overs.map((k) => {
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
  })) : el('p', { class: 'mc-card-note', text: 'No overs yet. Each over appears here once it is under way.' }));
}

// ---- Stats ----

// Whole numbers as they are, anything else to one decimal place.
const amount = (v: number, unit?: '%') => `${Number.isInteger(v) ? v : (Math.round(v * 10) / 10).toFixed(1)}${unit ?? ''}`;
const teamOf = (m: MatchInfo, code: string): TeamRef => m.teams.find((t) => t.code === code) ?? { code, name: code };

// Sets a bar segment's share; a segment with none is left out. The page's CSP allows no style attributes, so this goes
// through the CSSOM.
function share<T extends HTMLElement>(node: T, part: number): T {
  node.style.flexGrow = String(Math.max(0, part));
  node.hidden = !(part > 0);
  return node;
}

// Stats, in one place: the win predictor, the head-to-head comparisons, the sport's charts, then the lists
// (partnerships, bowling, goals, leaders).
function statsPanel(v: View, m: MatchInfo, sections: StatSection[], prediction: Prediction | null, charts: ChartState): Child {
  const plots = chartsOf(v, m);
  if (!prediction && !plots.length && !sections.length) return empty('No stats yet', 'Stats and graphs fill in as the match goes on.');
  const keyed = sections.map((s, i) => ({ s, key: `stats-${i}` }));
  return [
    prediction ? predictorCard(prediction, v, m, charts) : null,
    ...keyed.flatMap(({ s, key }) => (s.kind === 'compare' ? [compareCard(s, m, key)] : [])),
    ...plots.map((p) => plotCard(p, charts)),
    ...keyed.flatMap(({ s, key }) => (s.kind === 'list' ? [card(key,
      el('h3', { class: 'mc-sub-head', text: s.title }),
      s.rows.length ? factList(s.rows) : el('p', { class: 'mc-card-note', text: 'Nothing yet.' }))] : [])),
  ];
}

// Label and value rows, the value on the right and an optional note under the label.
function factList(rows: ListRow[]) {
  return el('ul', { class: 'mc-list' }, rows.map((r) => el('li', {},
    el('span', { class: 'mc-list-label' }, r.label, r.note ? el('small', { text: r.note }) : null),
    el('b', { class: 'mc-list-value', text: r.value }))));
}

// Cricbuzz-style head to head: the teams' logos in the header, then for each stat the label in the middle, each
// team's value on its side and a bar split in the team colours. A screen reader hears one sentence per row.
function compareCard(s: Extract<StatSection, { kind: 'compare' }>, m: MatchInfo, key: string) {
  const [a, b] = s.teams.map((code) => teamOf(m, code));
  const side = (t: TeamRef, end: boolean) => el('span', { class: `mc-vs-team${end ? ' is-b' : ''}` }, teamLogo(t), el('b', { text: t.code }));
  return card(key,
    el('div', { class: 'mc-vs' }, side(a, false), el('h3', { class: 'mc-vs-title', text: s.title }), side(b, true)),
    s.rows.length ? el('ul', { class: 'mc-cmp' }, s.rows.map((r) => {
      const total = r.a + r.b;
      const value = (v: number, t: TeamRef, other: number) => el('b', { class: v > other ? `mc-cmp-v is-lead ${teamClass(t.code)}` : 'mc-cmp-v', text: amount(v, r.unit) });
      return el('li', { class: 'mc-cmp-row' },
        el('div', { class: 'mc-cmp-line', 'aria-hidden': 'true' },
          value(r.a, a, r.b), el('span', { class: 'mc-cmp-label', text: r.label }), value(r.b, b, r.a),
          el('span', { class: `mc-split${total > 0 ? '' : ' is-none'}` },
            share(el('i', { class: teamClass(a.code) || 'mc-spare-0' }), total > 0 ? r.a : 1),
            share(el('i', { class: teamClass(b.code) || 'mc-spare-1' }), total > 0 ? r.b : 1))),
        sr(`${r.label}: ${a.name} ${amount(r.a, r.unit)}, ${b.name} ${amount(r.b, r.unit)}`));
    })) : el('p', { class: 'mc-card-note', text: 'Nothing yet.' }));
}

// ---- Graphs: inline SVG, no libraries ----

// What survives a redraw: which data tables are open and the point a reader picked on each chart.
interface ChartState { open: Set<string>; picks: Map<string, number> }

interface Frame { w: number; h: number; l: number; r: number; t: number; b: number }
interface Tick { x: number; label: string }
type KeyKind = 'line' | 'dashed' | 'bar' | 'dot' | 'target' | 'area';
interface LegendKey { label: string; kind: KeyKind; cls?: string }

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
  team?: string; // the batting side the chart is about: it is drawn in that team's colours
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

// Team colours come from the .t-<code> classes (--team, --team-soft, --team-ink); a team without one gets a spare
// colour class.
const colour = (code: string | null, i: number) => teamClass(code) || `mc-spare-${i % 3}`;

function chartsOf(v: View, m: MatchInfo): Plot[] {
  if (v.sport === 'cricket') {
    const g = v.graph;
    if (!g || !g.overs.length) return [];
    const overs = [...g.overs].sort((a, b) => a.over - b.over);
    const sorted = { ...g, overs };
    // The x axis runs to the end of the innings, so the overs still to come show as room on the right.
    const limit = /\bT(\d+)$/i.exec(m.format ?? '')?.[1]; // "IPL T20": 20 overs
    const lastOver = limit ? Number(limit) : m.format === 'ODI' ? 50 : overs[overs.length - 1].over;
    // The last entry is the over in progress until its sixth legal ball.
    const live = !v.score.result && overs[overs.length - 1].over > v.score.balls / 6 ? v.score.balls : null;
    const side = v.score.batting;
    return [manhattan(sorted, lastOver, live, side), worm(sorted, lastOver, live, side)];
  }
  const plot = v.graph && scorePlot(v.graph, v.score.teams, v.sport === 'football' ? 'Goals' : 'Points');
  return plot ? [plot] : [];
}

// ---- The win predictor ----

// Whose chance the line follows: the chasing side in cricket, else the side ahead on the scoreboard (the favourite
// when the scores are level).
function trackedSide(p: Prediction, v: View): 0 | 1 {
  let lead: string | null = null;
  if (v.sport === 'cricket') lead = v.score.batting;
  else {
    const [x, y] = v.score.teams;
    if (x && y && x.score !== y.score) lead = x.score > y.score ? x.code : y.code;
  }
  const i = lead ? p.teams.indexOf(lead) : -1;
  if (i === 0 || i === 1) return i;
  return p.now.b > p.now.a ? 1 : 0;
}

// Who is likelier to win now, as one bar in the team colours (the draw in the middle in football); the chase or lead
// team's chance over the plays; what the estimate projects; and what it is.
function predictorCard(p: Prediction, v: View, m: MatchInfo, charts: ChartState) {
  const [a, b] = p.teams.map((code) => teamOf(m, code));
  const draw = p.now.draw ?? null;
  const plot = p.points.length > 1 ? winPlot(p, a, b, trackedSide(p, v)) : null;
  const parts = plot ? plotParts(plot, charts) : null;
  const side = (t: TeamRef, value: number, end: boolean) => el('span', { class: `mc-wp-team${end ? ' is-b' : ''}` },
    teamLogo(t), el('span', { class: 'mc-wp-code', text: t.code }), el('b', { class: 'mc-wp-pct', text: `${value}%` }));
  return card('predictor',
    el('h3', { class: 'mc-card-title', text: 'Win predictor' }),
    el('div', { class: 'mc-wp' },
      el('div', { class: 'mc-wp-head' },
        side(a, p.now.a, false),
        draw === null ? null : el('span', { class: 'mc-wp-draw' }, el('span', { text: 'Draw' }), ' ', el('b', { text: `${draw}%` })),
        side(b, p.now.b, true)),
      el('div', { class: 'mc-wp-bar', 'aria-hidden': 'true' },
        share(el('i', { class: colour(a.code, 0) }), p.now.a),
        draw === null ? null : share(el('i', { class: 'is-draw' }), draw),
        share(el('i', { class: colour(b.code, 1) }), p.now.b))),
    parts?.chart,
    p.projections.length ? el('div', { class: 'mc-wp-proj' }, el('h4', { class: 'mc-wp-sub', text: 'Projections' }), factList(p.projections)) : null,
    el('p', { class: 'mc-wp-note' }, el('span', { text: ESTIMATE }), p.method ? el('small', { text: p.method }) : null),
    parts?.data);
}

// The tracked side's chance after each play on a 0–100% scale. With two outcomes the area between the line and 50%
// takes the colour of the side it favours; with a draw possible the area under the line is the tracked side's.
function winPlot(p: Prediction, a: TeamRef, b: TeamRef, side: 0 | 1): Plot {
  const pts = p.points;
  const [me, them] = side === 0 ? [a, b] : [b, a];
  const chance = (q: Split) => (side === 0 ? q.a : q.b);
  const draws = pts.some((q) => q.draw != null);
  const f: Frame = { w: 320, h: 178, l: 34, r: 34, t: 22, b: 32 };
  const last = pts.length - 1;
  const x = scale(0, last, f.l, f.w - f.r);
  const y = scale(0, 100, f.h - f.b, f.t);
  const mid = y(50);
  const base = f.h - f.b;
  const C = colour(me.code, side);
  const O = colour(them.code, 1 - side);
  const line = pts.map((q, i) => `L${r2(x(i))},${r2(y(chance(q)))}`).join('');
  const area = (to: number) => `M${r2(x(0))},${r2(to)}${line}L${r2(x(last))},${r2(to)}Z`;
  const short = (s: string) => (s.length > 16 ? `${s.slice(0, 15)}…` : s);
  const id = `mc-clip-${++ids}`;
  const clip = (suffix: string, top: number, bottom: number) => svg('clipPath', { id: `${id}-${suffix}` },
    svg('rect', { x: f.l, y: r2(top), width: f.w - f.l - f.r, height: r2(Math.max(0, bottom - top)) }));
  const end = pts[last];
  const pct = (q: Split) => `${a.code} ${q.a}%${q.draw != null ? `, draw ${q.draw}%` : ''}, ${b.code} ${q.b}%`;
  return {
    key: 'win',
    title: `${me.name}: chance of winning`,
    summary: `${me.name}${me.name.endsWith('s') ? "'" : "'s"} chance of winning after each play, from ${pts[0].label} (${chance(pts[0])}%) to ${end.label} (${chance(end)}%).`
      + (draws ? '' : ` Above the 50% line ${me.name} are favoured, below it ${them.name}.`),
    frame: f,
    marks: [
      ...axes(f, [0, 25, 50, 75, 100], y, (v) => `${v}%`, [{ x: x(0), label: short(pts[0].label) }, { x: x(last), label: short(end.label) }], 'Play', `${me.code} win %`),
      ...(draws
        ? [svg('path', { class: `mc-wp-area ${C}`, d: area(base) })]
        : [
          svg('defs', {}, clip('up', f.t, mid), clip('down', mid, base)),
          svg('path', { class: `mc-wp-area ${C}`, d: area(mid), 'clip-path': `url(#${id}-up)` }),
          svg('path', { class: `mc-wp-area ${O}`, d: area(mid), 'clip-path': `url(#${id}-down)` }),
        ]),
      svg('line', { class: 'mc-mid', x1: f.l, x2: f.w - f.r, y1: r2(mid), y2: r2(mid) }),
      svg('path', { class: `mc-wp-line ${C}`, d: line.replace(/^L/, 'M') }),
      svg('circle', { class: `mc-wp-dot ${C}`, cx: r2(x(last)), cy: r2(y(chance(end))), r: 4.5 }),
      svg('text', { class: 'mc-val', x: r2(x(last) + 8), y: r2(y(chance(end))), dy: '0.32em' }, `${chance(end)}%`),
    ],
    xs: pts.map((_, i) => x(i)),
    describe: (i) => `${pts[i].label}: ${pct(pts[i])}`,
    pick: (i) => [crosshair(f, x(i)), svg('circle', { class: `mc-pick-dot ${C}`, cx: r2(x(i)), cy: r2(y(chance(pts[i]))), r: 4.5 })],
    legend: [
      { label: `${me.code} win chance`, kind: 'line', cls: C },
      ...(draws ? [] : [{ label: `${me.code} favoured`, kind: 'area' as const, cls: C }, { label: `${them.code} favoured`, kind: 'area' as const, cls: O }]),
    ],
    table: { head: ['Play', a.code, ...(draws ? ['Draw'] : []), b.code], rows: pts.map((q) => [q.label, q.a, ...(draws ? [q.draw ?? DASH] : []), q.b]) },
  };
}

// ---- Chart cards ----

function plotCard(p: Plot, charts: ChartState) {
  const { chart, data } = plotParts(p, charts);
  return card(`plot-${p.key}`, el('h3', { class: 'mc-card-title', text: p.title }), chart, data);
}

// A chart with its readout and legend, which a pointer or the arrow keys read point by point, and its data table.
function plotParts(p: Plot, charts: ChartState) {
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
  return {
    chart: el('div', { class: `mc-chart${p.team ? ` ${teamClass(p.team)}` : ''}` }, readout, frame,
      p.legend.length ? el('ul', { class: 'mc-legend' }, p.legend.map((k) => el('li', {},
        el('span', { class: `mc-key is-${k.kind} ${k.cls ?? ''}`, 'aria-hidden': 'true' }), k.label))) : null),
    data: p.table ? el('details', {
      class: 'mc-data', open: charts.open.has(tableKey),
      ontoggle: (e) => { if (e.currentTarget.open) charts.open.add(tableKey); else charts.open.delete(tableKey); },
    },
    el('summary', { dataset: { fk: tableKey }, text: 'Data table' }),
    table(p.table.head, p.table.rows.map((r) => el('tr', {}, r.map((c, i) => (i === 0 ? el('th', { scope: 'row', text: c }) : el('td', { text: c })))))))
      : null,
  };
}

// Manhattan: the runs of each over as bars, a red dot on top for each wicket in it. `live`: the legal balls bowled
// when the last over is still in progress (drawn lighter), else null.
function manhattan(g: CricketGraph, lastOver: number, live: number | null, side: string): Plot {
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
    team: side,
    title: `${side} innings · runs per over`,
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
      { label: `${side} runs in the over`, kind: 'bar' },
      ...(live === null ? [] : [{ label: 'This over so far', kind: 'bar' as const, cls: 'is-live' }]),
      { label: 'Wicket', kind: 'dot' },
    ],
    table: { head: ['Over', 'Runs', 'Wickets', 'Total'], rows: overs.map((o, i) => [isLive(i) ? `${o.over} (so far)` : o.over, o.runs, o.wickets, o.total]) },
  };
}

// Worm: the innings total after each over, from where the ball-by-ball record begins, with the target line. An over
// in progress is plotted where the innings stands (17.4 overs), not at its end.
function worm(g: CricketGraph, lastOver: number, live: number | null, side: string): Plot {
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
  const line = pts.map((p) => `L${r2(x(p.at))},${r2(y(p.total))}`).join('');
  const base = f.h - f.b;
  return {
    key: 'worm',
    team: side,
    title: g.target ? `${side}'s chase · runs after each over` : `${side} innings · runs after each over`,
    summary: `The innings total after each over from over ${from}${target ? `, with the target of ${target}` : ''}. ${last.when}: ${last.total}.`,
    frame: f,
    marks: [
      ...axes(f, yt, y, String, intTicks(from, end, x), 'Over', 'Runs'),
      ...(target ? [
        svg('line', { class: 'mc-target', x1: f.l, x2: f.w - f.r, y1: r2(y(target)), y2: r2(y(target)) }),
        svg('text', { class: 'mc-val', x: f.l + 4, y: r2(y(target) - 5) }, `Target ${target}`),
      ] : []),
      svg('path', { class: 'mc-area', d: `M${r2(x(pts[0].at))},${base}${line}L${r2(x(last.at))},${base}Z` }),
      svg('path', { class: 'mc-line', d: line.replace(/^L/, 'M') }),
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
    legend: [{ label: `${side} total`, kind: 'line' }, { label: 'Wicket', kind: 'dot' }, ...(target ? [{ label: `Target ${target}`, kind: 'target' as const }] : [])],
  };
}

// "Q4 5:41" → the seconds on the clock.
function clockSeconds(label: string): number | null {
  const m = /(\d{1,2}):(\d{2})$/.exec(label);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// Kabaddi, football and basketball: each team's score as a step line in its colour (the second team dashed, as the
// two colours can be close), placed by the game clock while it runs down within one period, by the minute in
// football, else play by play.
function scorePlot(g: ScoreGraph, teams: TeamRef[], unit: string): Plot | null {
  const pts = g.points;
  const [ca, cb] = g.teams;
  if (!pts.length || !ca || !cb) return null;
  const name = (code: string) => teams.find((t) => t.code === code)?.name || code;
  const secs = pts.map((p) => clockSeconds(p.label));
  let timed = true;
  secs.forEach((s, i) => { if (s === null || (i > 0 && (secs[i - 1] === null || s > (secs[i - 1] ?? 0)))) timed = false; });
  const mins = pts.map((p) => minuteOf(p.label)?.at ?? null);
  const minuted = !timed && mins.every((m, i) => m !== null && (i === 0 || m >= (mins[i - 1] ?? 0)));
  const top = secs[0] ?? 0;
  const xv = pts.map((_, i) => (timed ? top - (secs[i] ?? 0) : minuted ? mins[i] ?? 0 : i));
  const f: Frame = { w: 320, h: 190, l: 32, r: 50, t: 24, b: 34 };
  const values = pts.flatMap((p) => [p.a, p.b]);
  // Goals count from nil; a span of at least 4 keeps the ticks whole numbers.
  const lo = unit === 'Goals' ? 0 : Math.min(...values);
  const yt = ticks(lo, Math.max(...values, lo + 4));
  const y = scale(yt[0], yt[yt.length - 1], f.h - f.b, f.t);
  // A running clock's axis goes on to 0:00, and football's to 90 minutes, so the time left shows as room on the right.
  const end = Math.max(timed ? top : minuted ? 90 : 0, xv[xv.length - 1], xv[0] + 1);
  const x = scale(xv[0], end, f.l, f.w - f.r);
  const step = (vs: number[]) => vs.map((v, i) => (i ? `H${r2(x(xv[i]))}V${r2(y(v))}` : `M${r2(x(xv[0]))},${r2(y(v))}`)).join('');
  const A = colour(ca, 0);
  const B = colour(cb, 1);
  const last = pts[pts.length - 1];
  const xTicks: Tick[] = [];
  if (timed) {
    const every = [1, 2, 5, 10].find((n) => top / 60 / n <= 6) ?? 20;
    for (let m = 0; m * 60 <= top; m += every) xTicks.push({ x: x(top - m * 60), label: `${m}:00` });
  } else if (minuted) {
    xTicks.push(...intTicks(xv[0], end, x).map((t) => ({ ...t, label: `${t.label}'` })));
  } else {
    xTicks.push({ x: x(xv[0]), label: pts[0].label }, { x: x(xv[xv.length - 1]), label: last.label });
  }
  const tag = /^(\S+)\s+\d{1,2}:\d{2}$/.exec(pts[0].label)?.[1];
  const period = tag && /^\dH$/.test(tag) ? halfName(Number(tag[0])).toLowerCase() : tag; // "2H": the second half
  // End labels only where they clear each other; the legend and the readout carry the rest.
  const ya = y(last.a);
  const yb = y(last.b);
  const xEnd = r2(x(xv[xv.length - 1]) + 6);
  const ends = Math.abs(ya - yb) >= 11 ? [
    svg('text', { class: 'mc-val', x: xEnd, y: r2(ya), dy: '0.32em' }, `${ca} ${last.a}`),
    svg('text', { class: 'mc-val', x: xEnd, y: r2(yb), dy: '0.32em' }, `${cb} ${last.b}`),
  ] : [];
  const dot = (cls: string, xx: number, yy: number, mark = 'mc-pick-dot') => svg('circle', { class: `${mark} ${cls}`, cx: r2(xx), cy: r2(yy), r: 4.5 });
  const xLast = x(xv[xv.length - 1]);
  return {
    key: 'score',
    title: 'Score progression',
    summary: `The score after every change, ${name(ca)} as a solid line and ${name(cb)} dashed, from ${pts[0].label} to ${last.label}. `
      + `Latest: ${name(ca)} ${last.a}, ${name(cb)} ${last.b}.`,
    frame: f,
    marks: [
      ...axes(f, yt, y, String, xTicks, timed ? `Game clock${period ? `, ${period}` : ''}` : minuted ? 'Minute' : 'Play', unit),
      svg('path', { class: `mc-series ${A}`, d: step(pts.map((p) => p.a)) }),
      svg('path', { class: `mc-series is-b ${B}`, d: step(pts.map((p) => p.b)) }),
      dot(A, xLast, ya, 'mc-series-end'),
      dot(B, xLast, yb, 'mc-series-end'),
      ...ends,
    ],
    xs: xv.map((v) => x(v)),
    describe: (i) => `${pts[i].label}: ${name(ca)} ${pts[i].a}, ${name(cb)} ${pts[i].b}`,
    pick: (i) => [crosshair(f, x(xv[i])), dot(A, x(xv[i]), y(pts[i].a)), dot(B, x(xv[i]), y(pts[i].b))],
    legend: [{ label: name(ca), kind: 'line', cls: A }, { label: name(cb), kind: 'dashed', cls: B }],
    table: { head: ['Time', name(ca), name(cb)], rows: pts.map((p) => [p.label, p.a, p.b]) },
  };
}
