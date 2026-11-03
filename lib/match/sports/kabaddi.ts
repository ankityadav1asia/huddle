// Kabaddi: the last thirteen minutes of a Pro Kabaddi League game, Jaipur Pink Panthers v Patna Pirates, with real
// players. Every raid is applied by the PKL rules (touch and bonus points, tackles and super tackles, revivals,
// all-outs, do-or-die raids), so the scoreboard, the points breakdown and the players on the mat always agree.
import type { FactsInput, Fixture, Graphs, PlayLabel, PollTemplate, Signal, Team } from '../fixture.ts';
import type { Priority } from '../../db/rows.ts';
import { makeFans } from '../fans.ts';
import { scriptedThread, scriptedBurst, ROLE, type ScriptedItem } from './scripted.ts';

type Breakdown = { raid: number; tackle: number; all_out: number; extra: number };
interface PlayerLine { raid_points: number; raids: number; tackle_points: number }

// The game as the script has it. `clock` is the time left in the second half; `empty` counts each team's empty raids
// in a row (the third is a do-or-die raid).
interface KabaddiState {
  half: 1 | 2;
  clock: string;
  score: Record<string, number>;
  points: Record<string, Breakdown>;
  on_mat: Record<string, number>;
  empty: Record<string, number>;
  raiding: string;
  players: Record<string, PlayerLine>;
  result: string | null;
  last_seq: number;
  last_text: string;
}

// A raid: `touch` lists the defenders the raider puts out, `bonus` the bonus point, `tackled` the defenders who stop
// him (the first gets the points). A raid with neither is an empty raid.
interface Raid { by: string; touch?: string[]; bonus?: boolean; tackled?: string[] }
export interface KabaddiItem extends ScriptedItem<KabaddiState> {
  raid?: Raid;
  final?: boolean;
}
type Extra = Omit<KabaddiItem, 'kind' | 'clock' | 'text' | 'type' | 'label'>;
type KabaddiScore = ReturnType<typeof snapshot>;

const CODES = ['JPP', 'PAT'];
const TEAMS: Record<string, string> = { JPP: 'Jaipur Pink Panthers', PAT: 'Patna Pirates' };
const SHORT: Record<string, string> = { JPP: 'Jaipur', PAT: 'Patna' };
const SIDES: Team[] = CODES.map((code) => ({ code, name: TEAMS[code], logo: `assets/${code.toLowerCase()}.png` }));
const PLAYERS: Record<string, { team: string; role: string }> = {
  'Arjun Deshwal': { team: 'JPP', role: 'raider (captain)' },
  'Neeraj Narwal': { team: 'JPP', role: 'raider' },
  'Abhijeet Malik': { team: 'JPP', role: 'raider' },
  'Reza Mirbagheri': { team: 'JPP', role: 'defender, left cover' },
  'Ankush Rathee': { team: 'JPP', role: 'defender, left corner' },
  'Sahul Kumar': { team: 'JPP', role: 'defender, right corner' },
  'Lucky Sharma': { team: 'JPP', role: 'all-rounder' },
  'Devank Dalal': { team: 'PAT', role: 'raider' },
  'Ayan Lohchab': { team: 'PAT', role: 'raider' },
  'Sudhakar M': { team: 'PAT', role: 'raider' },
  'Ankit Jaglan': { team: 'PAT', role: 'defender (captain), right cover' },
  'Deepak Rajender Singh': { team: 'PAT', role: 'defender, left corner' },
  'Navdeep': { team: 'PAT', role: 'defender, right corner' },
  'Gurdeep': { team: 'PAT', role: 'all-rounder' },
};
const BACKED = ['Arjun Deshwal', 'Reza Mirbagheri', 'Neeraj Narwal', 'Ankush Rathee', 'Devank Dalal', 'Ayan Lohchab', 'Ankit Jaglan', 'Sudhakar M'];
const last = (name: string) => name.split(' ').slice(-1)[0];
const team = (player: string) => PLAYERS[player].team;
const other = (code: string) => (code === 'JPP' ? 'PAT' : 'JPP');
const line = (s: KabaddiState) => `${SHORT.JPP} ${s.score.JPP}, ${SHORT.PAT} ${s.score.PAT}`;
const doOrDie = (s: KabaddiState) => s.empty[s.raiding] >= 2;

const P = (clock: string, text: string, extra: Extra = {}): KabaddiItem => ({ kind: 'play', clock, text, ...extra });
const E = (clock: string, type: string, lbl: string, text: string, extra: Extra = {}): KabaddiItem => ({ kind: 'event', type, label: lbl, clock, text, ...extra });
const R = (clock: string, by: string, text: string, raid: Omit<Raid, 'by'> = {}, extra: Extra = {}): KabaddiItem => P(clock, text, { raid: { by, ...raid }, ...extra });

const SUPER_TACKLE = { slug: 'super-tackle', about: 'Jaipur defend with three on the mat and win two points.', keywords: ['super tackle', 'tackle', 'reza', 'sahul', 'three on the mat', 'defence', 'defense'] };
const DO_OR_DIE = { slug: 'do-or-die', about: 'Arjun Deshwal\'s do-or-die super raid.', keywords: ['do or die', 'do-or-die', 'arjun', 'super raid', 'three points'] };
const ALL_OUT = { slug: 'all-out', about: 'Patna inflict an all-out on Jaipur.', keywords: ['all out', 'all-out', 'devank', 'lona', 'revived'] };
const LAST_RAID = { slug: 'last-raid', about: 'The last minute: two do-or-die raids decide it.', keywords: ['last raid', 'last minute', 'do or die', 'arjun', 'devank', 'decider'] };

const SCRIPT: KabaddiItem[] = [
  E('13:00', 'start', 'Second half', 'Thirteen minutes left in the second half at the Sawai Mansingh Indoor Stadium, and it is Jaipur 24, Patna 23. Patna to raid.', { crowd: { key: 'start', n: 8, spread: 6000 }, pause: 4000 }),
  R('12:40', 'Devank Dalal', 'Devank Dalal dances in the left corner and flicks Ankush Rathee\'s ankle on the way back. Level at 24.', { touch: ['Ankush Rathee'] }, { crowd: { key: 'raid_pat', n: 4, share: 0.35 } }),
  R('12:15', 'Arjun Deshwal', 'Arjun Deshwal stretches for the bonus and touches Ankit Jaglan for a second point. Jaipur lead by two.', { touch: ['Ankit Jaglan'], bonus: true }, { crowd: { key: 'raid_jpp', n: 5, share: 0.7 } }),
  R('11:50', 'Ayan Lohchab', 'Ayan Lohchab probes the right flank, finds nothing and walks back. Empty raid.'),
  R('11:25', 'Neeraj Narwal', 'Neeraj Narwal goes for the toe touch and Ankit Jaglan blocks him at the mid-line. Tackle point for Patna.', { tackled: ['Ankit Jaglan'] }, { crowd: { key: 'tackle_pat', n: 4, share: 0.3 } }),
  R('11:00', 'Devank Dalal', 'Running hand touch on Sahul Kumar and a back kick on Lucky Sharma! Two points for Devank, and Jaipur are down to three.', { touch: ['Sahul Kumar', 'Lucky Sharma'] }, { crowd: { key: 'raid_pat', n: 6, share: 0.3 } }),
  R('10:35', 'Arjun Deshwal', 'Arjun Deshwal takes the bonus and gets out quickly. 27 all.', { bonus: true }, { crowd: { key: 'raid_jpp', n: 3, share: 0.7 } }),
  R('10:10', 'Ayan Lohchab', 'SUPER TACKLE! Only three Jaipur defenders on the mat, and Reza Mirbagheri traps Ayan Lohchab with a thigh hold. Two points to Jaipur!', { tackled: ['Reza Mirbagheri'] }, {
    thread: SUPER_TACKLE, moment: 'super-tackle', crowd: { key: 'super_tackle', n: 14, spread: 7000, share: 0.75 }, pause: 3500,
  }),
  R('09:45', 'Abhijeet Malik', 'Abhijeet Malik is shadowed by the Patna cover and steps back to his half. Empty raid.'),
  R('09:20', 'Sudhakar M', 'Sudhakar catches Reza Mirbagheri with a running hand touch. Patna one behind.', { touch: ['Reza Mirbagheri'] }, { crowd: { key: 'raid_pat', n: 3, share: 0.3 } }),
  R('08:55', 'Neeraj Narwal', 'Neeraj Narwal waits out the raid clock without a touch. Second empty raid in a row: the next Jaipur raid is do-or-die.', {}, { crowd: { key: 'tension', n: 4 } }),
  R('08:30', 'Devank Dalal', 'SUPER TACKLE again! Three Jaipur defenders, and Sahul Kumar dives on Devank Dalal\'s ankle. Two more points for Jaipur.', { tackled: ['Sahul Kumar', 'Ankush Rathee'] }, {
    thread: SUPER_TACKLE, crowd: { key: 'super_tackle', n: 12, spread: 6000, share: 0.75 }, pause: 3000,
  }),
  R('08:05', 'Arjun Deshwal', 'DO-OR-DIE... and Arjun Deshwal delivers! A dubki under Navdeep, touches on Deepak and Gurdeep, and he is home. SUPER RAID, three points!', { touch: ['Navdeep', 'Deepak Rajender Singh', 'Gurdeep'] }, {
    thread: DO_OR_DIE, moment: 'do-or-die', crowd: { key: 'super_raid_jpp', n: 18, spread: 8000, share: 0.8 }, pause: 4000,
  }),
  R('07:40', 'Ayan Lohchab', 'Ayan Lohchab picks off Ankush Rathee in the corner. Patna need points quickly.', { touch: ['Ankush Rathee'] }, { crowd: { key: 'raid_pat', n: 3, share: 0.3 } }),
  E('07:15', 'timeout', 'Strategic timeout', 'Patna take their strategic timeout, five points down with seven minutes left.', { crowd: { key: 'timeout', n: 6, spread: 5000 }, pause: 3000 }),
  R('06:55', 'Arjun Deshwal', 'Arjun Deshwal again: a touch on Ankit Jaglan, then Deepak Rajender Singh as he dives for the line. Patna down to two.', { touch: ['Ankit Jaglan', 'Deepak Rajender Singh'] }, { crowd: { key: 'raid_jpp', n: 6, share: 0.75 } }),
  R('06:30', 'Devank Dalal', 'SUPER RAID from Devank Dalal! The bonus, then Lucky Sharma and Sahul Kumar trying to block him. Three points, and Patna are alive.', { touch: ['Lucky Sharma', 'Sahul Kumar'], bonus: true }, {
    crowd: { key: 'super_raid_pat', n: 14, spread: 7000, share: 0.25 }, pause: 3000,
  }),
  R('06:05', 'Neeraj Narwal', 'Neeraj Narwal is caught by Ankit Jaglan\'s ankle hold. Tackle point Patna.', { tackled: ['Ankit Jaglan'] }, { crowd: { key: 'tackle_pat', n: 4, share: 0.3 } }),
  R('05:40', 'Sudhakar M', 'Sudhakar runs the clock down on the left and comes back empty.'),
  R('05:15', 'Abhijeet Malik', 'Abhijeet Malik slips a touch on Navdeep. Jaipur lead by four.', { touch: ['Navdeep'] }, { crowd: { key: 'raid_jpp', n: 3, share: 0.7 } }),
  R('04:50', 'Ayan Lohchab', 'Ayan Lohchab takes out Ankush Rathee and Reza Mirbagheri with one sweep of the hand. Jaipur down to three.', { touch: ['Ankush Rathee', 'Reza Mirbagheri'] }, { crowd: { key: 'raid_pat', n: 6, share: 0.3 } }),
  R('04:25', 'Arjun Deshwal', 'Ankit Jaglan blocks Arjun Deshwal at the mid-line! A huge tackle by the Patna captain. Jaipur have two left on the mat.', { tackled: ['Ankit Jaglan'] }, { crowd: { key: 'tackle_pat', n: 8, share: 0.25 } }),
  R('04:00', 'Devank Dalal', 'ALL OUT! Devank Dalal touches the last two, Sahul Kumar and Lucky Sharma, and Jaipur are all out. Two raid points and two all-out points: Patna lead!', { touch: ['Sahul Kumar', 'Lucky Sharma'] }, {
    thread: ALL_OUT, moment: 'all-out', crowd: { key: 'all_out', n: 18, spread: 8000, share: 0.2 }, pause: 4000,
  }),
  R('03:35', 'Neeraj Narwal', 'Neeraj Narwal answers with the bonus and a touch on Gurdeep. Jaipur one behind.', { touch: ['Gurdeep'], bonus: true }, { crowd: { key: 'raid_jpp', n: 5, share: 0.75 } }),
  R('03:10', 'Ayan Lohchab', 'Ayan Lohchab is careful, and comes back empty.', {}, { crowd: { key: 'tension', n: 4 } }),
  R('02:45', 'Arjun Deshwal', 'Arjun Deshwal touches Navdeep with a toe and it is 40 all!', { touch: ['Navdeep'] }, { crowd: { key: 'raid_jpp', n: 8, share: 0.75 } }),
  R('02:20', 'Sudhakar M', 'Reza Mirbagheri ankle-holds Sudhakar! Jaipur back in front, 41-40.', { tackled: ['Reza Mirbagheri'] }, { crowd: { key: 'tackle_jpp', n: 8, share: 0.75 } }),
  R('01:55', 'Abhijeet Malik', 'Abhijeet Malik is wary of the chain tackle and comes back empty.', {}, { crowd: { key: 'tension', n: 4 } }),
  R('01:30', 'Devank Dalal', 'Devank Dalal brushes Ankush Rathee on the way out. 41 all with ninety seconds left.', { touch: ['Ankush Rathee'] }, { crowd: { key: 'raid_pat', n: 8, share: 0.3 } }),
  R('01:05', 'Neeraj Narwal', 'Neeraj Narwal runs the raid clock down and comes back empty. The next Jaipur raid is do-or-die.', {}, { crowd: { key: 'tension', n: 6 } }),
  R('00:40', 'Ayan Lohchab', 'Ayan Lohchab comes back empty too. Forty seconds left, 41 all, and Jaipur must score on this raid.', {}, { crowd: { key: 'tension', n: 8 }, pause: 3000 }),
  R('00:20', 'Arjun Deshwal', 'LAST-MINUTE DO-OR-DIE! Arjun Deshwal touches Ankit Jaglan, then Gurdeep as they close in, and flies back over the mid-line. Jaipur lead 43-41!', { touch: ['Ankit Jaglan', 'Gurdeep'] }, {
    thread: LAST_RAID, moment: 'last-raid', crowd: { key: 'decider', n: 20, spread: 8000, share: 0.8 }, pause: 4500,
  }),
  R('00:05', 'Devank Dalal', 'The last raid of the game: Devank Dalal goes for the bonus and Reza Mirbagheri and Sahul Kumar chain-tackle him. It\'s over.', { tackled: ['Reza Mirbagheri', 'Sahul Kumar'] }, {
    thread: LAST_RAID, crowd: { key: 'tackle_jpp', n: 12, spread: 6000, share: 0.8 }, pause: 3500,
  }),
  E('00:00', 'full_time', 'Full time', 'FULL TIME! Jaipur Pink Panthers win a thriller against Patna Pirates.', {
    final: true,
    thread: { slug: 'result', about: 'The final whistle.', keywords: ['won', 'win', 'final score', 'full time'] },
    crowd: { key: 'final', n: 12, spread: 7000 }, pause: 3000,
  }),
];

const line0 = (raid_points: number, raids: number, tackle_points: number): PlayerLine => ({ raid_points, raids, tackle_points });

function initialState(): KabaddiState {
  return {
    half: 2, clock: '13:00',
    score: { JPP: 24, PAT: 23 },
    points: { JPP: { raid: 14, tackle: 7, all_out: 2, extra: 1 }, PAT: { raid: 13, tackle: 8, all_out: 0, extra: 2 } },
    on_mat: { JPP: 6, PAT: 5 },
    empty: { JPP: 0, PAT: 1 },
    raiding: 'PAT',
    players: {
      'Arjun Deshwal': line0(8, 11, 0), 'Neeraj Narwal': line0(4, 6, 0), 'Abhijeet Malik': line0(2, 4, 0),
      'Reza Mirbagheri': line0(0, 0, 3), 'Ankush Rathee': line0(0, 0, 2), 'Sahul Kumar': line0(0, 0, 2), 'Lucky Sharma': line0(0, 0, 0),
      'Devank Dalal': line0(7, 10, 0), 'Ayan Lohchab': line0(5, 8, 0), 'Sudhakar M': line0(1, 3, 0),
      'Ankit Jaglan': line0(0, 0, 4), 'Deepak Rajender Singh': line0(0, 0, 2), 'Navdeep': line0(0, 0, 2), 'Gurdeep': line0(0, 0, 0),
    },
    result: null, last_seq: -1, last_text: '',
  };
}

// What one raid did, for the signal rules: points each way, and whether it was a super raid, super tackle, do-or-die
// or all-out.
interface RaidOutcome { team: string; raid_points: number; tackle_points: number; super_tackle: boolean; do_or_die: boolean; all_out: string | null }

function applyItem(prev: KabaddiState, item: KabaddiItem, seq: number) {
  const s = structuredClone(prev);
  s.last_seq = seq;
  s.last_text = item.text;
  s.clock = item.clock;
  let outcome: RaidOutcome | null = null;
  if (item.raid) {
    const { by, touch = [], bonus = false, tackled = [] } = item.raid;
    const att = team(by);
    const def = other(att);
    const dod = s.empty[att] >= 2;
    s.players[by].raids += 1;
    outcome = { team: att, raid_points: 0, tackle_points: 0, super_tackle: false, do_or_die: dod, all_out: null };
    if (tackled.length) {
      // The raider is out. Three or fewer defenders make it a super tackle: two points. The tacklers' side revives one.
      const pts = s.on_mat[def] <= 3 ? 2 : 1;
      outcome.tackle_points = pts;
      outcome.super_tackle = pts === 2;
      s.score[def] += pts;
      s.points[def].tackle += pts;
      s.players[tackled[0]].tackle_points += pts;
      s.on_mat[att] -= 1;
      s.on_mat[def] = Math.min(7, s.on_mat[def] + 1);
      s.empty[att] = 0;
    } else if (touch.length || bonus) {
      // Each defender touched is out and revives one of the raider's side; the bonus point revives nobody.
      const pts = touch.length + (bonus ? 1 : 0);
      outcome.raid_points = pts;
      s.score[att] += pts;
      s.points[att].raid += pts;
      s.players[by].raid_points += pts;
      s.on_mat[def] -= touch.length;
      s.on_mat[att] = Math.min(7, s.on_mat[att] + touch.length);
      s.empty[att] = 0;
    } else if (dod) {
      // An empty do-or-die raid: the raider is out and the defenders get a point.
      s.score[def] += 1;
      s.points[def].extra += 1;
      s.on_mat[att] -= 1;
      s.on_mat[def] = Math.min(7, s.on_mat[def] + 1);
      s.empty[att] = 0;
    } else {
      s.empty[att] += 1;
    }
    // A side with nobody left on the mat is all out: two points to the other side, and all seven come back.
    for (const code of CODES) {
      if (s.on_mat[code] <= 0) {
        s.score[other(code)] += 2;
        s.points[other(code)].all_out += 2;
        s.on_mat[code] = 7;
        outcome.all_out = code;
      }
    }
    s.raiding = def;
  }
  if (item.final) {
    const [a, b] = CODES;
    const hi = Math.max(s.score[a], s.score[b]);
    const lo = Math.min(s.score[a], s.score[b]);
    s.result = hi === lo ? `Tied ${hi}-${lo}` : `${SHORT[s.score[a] > s.score[b] ? a : b]} win ${hi}-${lo}`;
  }
  return { state: s, ball: outcome };
}

function snapshot(s: KabaddiState) {
  const people = Object.entries(s.players).map(([name, p]) => ({ name, short: last(name), team: PLAYERS[name].team, ...p }));
  return {
    sport: 'kabaddi', half: s.half, clock: s.clock, result: s.result, raiding: s.raiding, do_or_die: !s.result && doOrDie(s),
    teams: CODES.map((code) => ({
      code, name: TEAMS[code], score: s.score[code], on_mat: s.on_mat[code],
      raid_points: s.points[code].raid, tackle_points: s.points[code].tackle, all_out_points: s.points[code].all_out, extra_points: s.points[code].extra,
    })),
    raiders: people.filter((p) => p.raids > 0).sort((x, y) => y.raid_points - x.raid_points || x.raids - y.raids).slice(0, 5)
      .map(({ name, short, team: code, raid_points, raids }) => ({ name, short, team: code, raid_points, raids })),
    defenders: people.filter((p) => p.tackle_points > 0).sort((x, y) => y.tackle_points - x.tackle_points).slice(0, 5)
      .map(({ name, short, team: code, tackle_points }) => ({ name, short, team: code, tackle_points })),
    last_play: s.last_text,
  };
}

// Rules over each raid: a super raid (3+ points), a super tackle, an all-out, a do-or-die raid that scores, a team
// going ahead in the last two minutes, and the result. The raid's place in the feed makes each card unique.
function detectSignals(prev: KabaddiState, next: KabaddiState, ball: unknown, seq: number): Signal[] {
  const out: Signal[] = [];
  const sig = (trigger: string, priority: Priority, lbl: string, fact_text: string, dedupe: string) =>
    out.push({ trigger, priority, label: lbl, evidence: { clock: next.clock, text: next.last_text, score: line(next) }, fact_text, dedupe });
  const o = ball as RaidOutcome | null;
  if (o) {
    const att = SHORT[o.team];
    const def = SHORT[other(o.team)];
    if (o.raid_points >= 3) sig('super_raid', 'high', o.do_or_die ? 'Do-or-die super raid' : 'Super raid', `${o.raid_points}-point super raid for ${att}${o.do_or_die ? ' on a do-or-die raid' : ''} with ${next.clock} left: ${line(next)}.`, `raid-${seq}`);
    else if (o.do_or_die && o.raid_points > 0) sig('do_or_die', 'medium', 'Do-or-die', `${att} score on a do-or-die raid with ${next.clock} left: ${line(next)}.`, `raid-${seq}`);
    if (o.super_tackle) sig('super_tackle', 'high', 'Super tackle', `Super tackle: ${def} stop the raider with three or fewer on the mat, two points, with ${next.clock} left: ${line(next)}.`, `tackle-${seq}`);
    if (o.all_out) sig('all_out', 'high', 'All out', `${SHORT[o.all_out]} are all out: two extra points to ${SHORT[other(o.all_out)]} with ${next.clock} left: ${line(next)}.`, `allout-${seq}`);
    const [a, b] = CODES;
    const lead = (st: KabaddiState) => Math.sign(st.score[a] - st.score[b]);
    const minutesLeft = Number(next.clock.split(':')[0]);
    if (minutesLeft < 2 && lead(next) !== 0 && lead(next) !== lead(prev)) {
      const ahead = lead(next) > 0 ? a : b;
      sig('late_lead', 'medium', 'Late lead', `${SHORT[ahead]} go ahead with ${next.clock} left: ${line(next)}.`, `lead-${seq}`);
    }
  }
  if (!prev.result && next.result) sig('match_result_confirmed', 'high', 'Result', `Full time: ${next.result} (${line(next)}).`, 'result');
  return out;
}

function facts(snap: FactsInput<KabaddiScore>) {
  const sc = snap.score;
  const [a, b] = sc.teams;
  const name = (code: string) => (code === a.code ? a.name : b.name);
  return {
    headline: `${a.name} ${a.score}-${b.score} ${b.name} · ${sc.result || `second half, ${sc.clock} left`}`,
    sport: 'kabaddi', game: snap.match.title, competition: snap.match.format, status: snap.match.status, source_note: snap.match.source_label,
    half: sc.half, time_left: sc.clock, score: `${a.name} ${a.score}, ${b.name} ${b.score}`, result: sc.result,
    next_raid: sc.result ? null : `${name(sc.raiding)}${sc.do_or_die ? ' (do-or-die raid)' : ''}`,
    points_breakdown: sc.teams.map((t) => `${t.name}: ${t.raid_points} raid, ${t.tackle_points} tackle, ${t.all_out_points} all-out, ${t.extra_points} extra`),
    players_on_mat: `${a.name} ${a.on_mat}, ${b.name} ${b.on_mat}`,
    top_raiders: sc.raiders.map((r) => `${r.name} (${name(r.team)}) ${r.raid_points} raid points from ${r.raids} raids`),
    top_defenders: sc.defenders.map((d) => `${d.name} (${name(d.team)}) ${d.tackle_points} tackle points`),
    last_play: sc.last_play,
  };
}

function templatePoll(s: KabaddiState): PollTemplate {
  if (s.result) return { question: 'Player of the match?', options: ['Arjun Deshwal', 'Devank Dalal', 'Reza Mirbagheri'] };
  return { question: 'Who wins this one?', options: ['Jaipur Pink Panthers', 'Patna Pirates'] };
}

// Every raid sits at the time left in the second half.
const describe = (item: KabaddiItem): PlayLabel => ({ over: `2H ${item.clock}`, symbol: null });

// The score at the start, after each change, and now, labelled by the time left.
function graphs(states: KabaddiState[]): Graphs {
  const [a, b] = CODES;
  const points: { label: string; a: number; b: number }[] = [];
  states.forEach((s, i) => {
    const point = { label: `2H ${s.clock}`, a: s.score[a], b: s.score[b] };
    const prev = points.at(-1);
    if (!prev || prev.a !== point.a || prev.b !== point.b || (i === states.length - 1 && prev.label !== point.label)) points.push(point);
  });
  return { kind: 'score', teams: CODES, points };
}

const CROWD = {
  start: {
    JPP: ['Pink Panthers, bas 13 minute aur 💗', 'Arjun bhai aaj rukne wale nahi', 'Jaipur ka ghar hai, jeetna hi hai', 'Pink Army ready hai 🐾'],
    PAT: ['Pirates ka comeback dekhna 🏴‍☠️', 'ek point hi peeche hain, chill', 'Devank aaj form mein hai', 'Patna Pirates, chalo!'],
  },
  raid_jpp: {
    JPP: ['ARJUN!! kya raid hai 🔥', 'touch karke nikal gaya 😎', 'bonus bhi, touch bhi 💗', 'Jaipur Jaipur!'],
    PAT: ['corner sambhalo yaar', 'itna space kyun diya 😤', 'next raid pe pakdo usko'],
  },
  raid_pat: {
    JPP: ['ankle hold kab seekhoge 😩', 'corner pe dhyaan do bhai', 'phir se touch, uff'],
    PAT: ['DEVANK!! 🔥', 'yahi chahiye tha Pirates ko', 'back kick dekha? 😍', 'chalo chalo, comeback on'],
  },
  tackle_jpp: {
    JPP: ['REZA!! deewar hai woh 🧱', 'ankle hold perfect 👏', 'Jaipur defence on fire'],
    PAT: ['arre, bonus ke chakkar mein gaya 🤦', 'raid clock dekh ke chalo yaar', 'fas gaya re'],
  },
  tackle_pat: {
    JPP: ['mid-line pe hi pakad liya 😩', 'Jaglan aaj wall bana hai', 'aaram se raid karo'],
    PAT: ['JAGLAN!!! captain 🫡', 'block kya maara hai', 'Pirates defence 🔥'],
  },
  super_tackle: {
    JPP: ['SUPER TACKLE!!! 💗💗', 'teen pe bhi pakad liya 😱', 'Reza bhai ki thigh hold 🔥', 'yeh hai defence', 'do points, mazaa aa gaya'],
    PAT: ['teen defenders se fas gaye 🤦‍♂️', 'super tackle de diya yaar', 'itna andar kyun gaye', 'raider ko samajhna chahiye tha'],
  },
  super_raid_jpp: {
    JPP: ['ARJUN DESHWAL!!! 🤯🤯', 'DO OR DIE MEIN SUPER RAID 💗🔥', 'dubki dekhi?? dubki!!', 'teen point ek raid mein 😱', 'yeh hai captain', 'Pink Army roar 🐾'],
    PAT: ['teen out ek saath 😭', 'dubki pe koi nahi tha', 'do or die mein bhi nikal gaya 😩'],
  },
  super_raid_pat: {
    JPP: ['bonus kyun diya yaar 😤', 'teen point de diye', 'focus Jaipur, focus'],
    PAT: ['SUPER RAID!!! 🏴‍☠️🔥', 'Devank on fire', 'Patna zinda hai 💪', 'teen point, game on!'],
  },
  all_out: {
    JPP: ['ALL OUT?? nahi yaar 😭', 'saare out ho gaye 😩', 'lead gayi', 'abhi bhi time hai, wapas aao'],
    PAT: ['ALL OUT!!! 🏴‍☠️🏴‍☠️', 'LONA!! do extra points 🔥', 'Patna aage!!', 'Devank, Devank, Devank!', 'comeback complete'],
  },
  timeout: {
    JPP: ['bas focus rakho ab', 'lead bachao Panthers', 'Arjun ko rest do thoda'],
    PAT: ['timeout zaroori tha', 'plan banao coach', 'paanch point, ho jayega'],
  },
  tension: {
    JPP: ['saans ruki hui hai 😬', 'raid clock dekho', 'chalo Jaipur'],
    PAT: ['ek raid, ek raid 🙏', 'chalo Pirates', 'dil dhadak raha hai'],
  },
  decider: {
    JPP: ['ARJUNNN!!! 💗💗💗', 'LAST MINUTE DO OR DIE 🤯', 'bonus + touch, kya player hai', 'Jaipur aage!!!', 'rona aa gaya 😭'],
    PAT: ['nahi yaar 😭', 'aakhri raid bachi hai', 'Devank, ab tum hi ho 🙏'],
  },
  final: {
    JPP: ['JAIPUR JEET GAYA 💗🐾', 'kya thriller tha', 'Arjun Deshwal, player of the match'],
    PAT: ['heartbreak 💔', 'all-out ke baad bhi haar gaye', 'proud of Pirates, next time'],
  },
  chatter: {
    JPP: ['Reza ki defence solid hai aaj', 'Arjun ko raid do bas', 'Ankush corner pe alert rehna'],
    PAT: ['Devank ko zyada raids do', 'Jaglan ka ankle hold best hai', 'Ayan ko confidence chahiye'],
  },
};

export const KABADDI: Fixture<KabaddiState, KabaddiItem, KabaddiScore> = {
  key: 'pkl-jpp-pat',
  sport: 'kabaddi',
  sportName: 'kabaddi',
  title: 'Jaipur Pink Panthers v Patna Pirates',
  teams: SIDES,
  format: 'PKL',
  sourceLabel: 'Raid-by-raid match feed',
  items: SCRIPT,
  engine: {
    initialState, applyItem, snapshot, facts, templatePoll, graphs,
    detectSignals: (prev, next, _item, ball, seq) => detectSignals(prev, next, ball, seq),
    threadForItem: scriptedThread,
    describe,
  },
  crowd: {
    lines: CROWD,
    fans: makeFans(CODES, ['panthers', 'pirates', 'pinkarmy', 'pkl', 'kabaddi', 'jaipur', 'patna', 'raid', 'dubki', 'tackle', 'jpp', 'pat'], { seed: 'kabaddi' }),
    burstFor: (item, _state, rand) => scriptedBurst(item, rand, 0.4),
    fill: (text) => text,
    otherSide: (code) => other(code),
    momentCues: new Set(['super_tackle', 'super_raid_jpp', 'super_raid_pat', 'all_out', 'decider', 'final', 'tension']),
  },
  topics: [
    { slug: 'refs', keywords: ['referee', 'umpire', 'review', 'out', 'line', 'lobby'] },
    { slug: 'raiders', keywords: ['arjun', 'devank', 'raider', 'raid', 'bonus', 'dubki'] },
  ],
  terms: /\b(?:raids?|raider|raiding|tackles?|super tackle|super raid|all.?outs?|lona|do.?or.?die|bonus|baulk|mat|revive\w*|revival|lobby|empty raid|ankle hold|thigh hold|dubki|chain tackle|kabaddi|pkl|panthers|pirates|jaipur|patna|arjun|deshwal|neeraj|abhijeet|reza|mirbagheri|ankush|sahul|lucky|devank|ayan|sudhakar|jaglan|deepak|navdeep|gurdeep|points?|win\w*|tied?|rule\w*)\b/i,
  rules: [
    { topic: 'Match length', text: 'A Pro Kabaddi match has two halves of 20 minutes with a short break. Each team has 7 players on the mat; a PKL league match that is level at the end is a tie.' },
    { topic: 'Raid', text: 'One raider crosses into the opponents\' half, must cross the baulk line, tries to touch defenders and must get back over the mid-line within the 30-second raid clock. Each defender touched is out and gives the raiding team one point, if the raider gets back.' },
    { topic: 'Bonus point', text: 'When six or seven defenders are on the mat, a raider who crosses the bonus line with one foot while the other foot is in the air earns a bonus point. A bonus point does not revive a player.' },
    { topic: 'Tackle', text: 'If the defenders stop the raider from getting back to his half, the raider is out and the defending team gets one tackle point.' },
    { topic: 'Super tackle', text: 'A tackle made when the defending team has three or fewer players on the mat is a super tackle and is worth two points instead of one.' },
    { topic: 'Super raid', text: 'A raid that earns three or more points is called a super raid.' },
    { topic: 'All out', text: 'When every player of a team is out, the other team gets two extra all-out points and the whole team comes back on the mat.' },
    { topic: 'Do-or-die raid', text: 'After two empty raids in a row, a team\'s third raid is a do-or-die raid: the raider must score, or he is out and the defending team gets a point.' },
    { topic: 'Empty raid', text: 'A raid that scores no point and in which the raider is not caught is an empty raid. It counts towards the do-or-die rule.' },
    { topic: 'Revival', text: 'For every point a team scores by putting an opponent out, one of its own players who is out comes back on the mat, in the order they went out.' },
    { topic: 'Lobby and lines', text: 'The lobby is the side strip of the court. It only comes into play once a raider touches a defender; a player who steps out of bounds otherwise is out.' },
  ],
  roster: Object.entries(PLAYERS).map(([name, p]) => ROLE(name, TEAMS[p.team], p.role)),
  backing: {
    teams: SIDES,
    players: BACKED.map((name) => ({ name, short: last(name), team: PLAYERS[name].team })),
  },
  examples: ['What is a super tackle?', 'What is a do-or-die raid?', 'Who is Arjun Deshwal?'],
};
