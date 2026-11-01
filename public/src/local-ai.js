// Offline engine: same inputs and outputs as the LLM tasks in lib/prompts.js, built from keyword
// clustering and a Hinglish + emoji sentiment lexicon. It keeps the demo working with no API key
// or when a live call fails, and it is the cheap first pass you would run per message at scale.
import { SQUADS, TEAM_CODES, otherTeam, shortName } from './data.js';

const POS = ['what a', 'shot', 'beauty', 'love', 'come on', 'yes', 'huge', 'hero', 'jeet', 'won', 'kya maara', 'badhiya', 'mast',
  'ho jayega', 'chill', 'masterstroke', 'golden arm', 'thala', 'whistle', 'feast', 'shabash', 'accha', 'sahi', 'bach gaye', 'phew',
  'lifeline', 'wapas aa', 'finally', 'game on', 'thank you', 'easy', 'maza', 'goosebumps', 'yehi chahiye',
  '🔥', '👏', '💛', '💙', '❤️', '😍', '🥳', '💪', '🐐', '🦁', '😎', '🚀'];
const NEG = ['mistake', 'bakwaas', 'faltu', 'bekar', 'kyun', 'galat', 'blunder', 'chhod', 'scam', 'waste', 'pathetic', 'nahi',
  'nooo', 'nahiii', 'kharab', 'backfire', 'heartbreak', 'unplayable', 'darr', 'nervous', 'dekha nahi', 'feka', 'le dooba', 'haraya',
  'seriously', 'bola tha', 'pressure', 'unbelievable', 'kahan hai',
  '😡', '😤', '🤦', '😭', '💔', '💀', '😩', '😰', '🤡', '😒', '😬'];

export function sentiment(text) {
  const t = text.toLowerCase();
  const score = POS.filter((w) => t.includes(w)).length - NEG.filter((w) => t.includes(w)).length;
  return Math.sign(score);
}

// Topic order matters: the first match wins.
const TOPICS = {
  'dropped-catch': {
    kw: ['chhod', 'drop', 'sitter', 'catches win', 'lifeline', 'butter', 'bach gaya', 'skipper', 'chhoot'],
    event: 'drop',
    poll: {
      question: 'Will that drop cost MI the game?',
      options: [
        { label: 'Yes, game over', verdict: 'thinks that drop will cost MI the game', kw: ['match wahi', 'moment', 'lifeline', 'unbelievable', 'dil nahi', 'catches win'] },
        { label: 'No, still alive', verdict: 'thinks MI can still defend this', kw: ['abhi', 'bumrah', 'defend', 'lol', 'butter'] },
      ],
    },
  },
  'drs-call': {
    kw: ['drs', 'review', 'umpire', 'lbw', 'ball tracking', 'plumb', 'leg ke bahar', 'going down', 'clip', 'hitting', 'out out', 'dil muh', 'miss nahi'],
    event: 'review',
    poll: {
      question: 'Was MI right to review that LBW?',
      options: [
        { label: 'Yes, worth it', verdict: 'thinks MI were right to review', kw: ['plumb', 'review lo', 'hitting', 'out out', 'scam', 'phir se', 'clip'] },
        { label: 'Wasted review', verdict: 'thinks it was a wasted review', kw: ['waste', 'leg ke bahar', 'going down', 'kyun liya', 'no way', 'sahi decision', 'bacha liya'] },
      ],
    },
  },
  'last-over': {
    kw: ['last over', 'off 6', 'defend', 'ek boundary', 'finish', 'saans', 'dekha nahi', 'wide yorker', 'nerves', 'non-striker', 'deliver'],
    event: 'last_over',
    poll: {
      question: 'Last over. Who takes it?',
      options: [
        { label: 'CSK chase it', verdict: 'backs CSK to chase it down', kw: ['ho jayega', 'humara', 'chill', 'gaikwad', 'ruturaj', 'thala'] },
        { label: 'MI defend it', verdict: 'backs MI to defend it', kw: ['defend', 'yorker', 'nerves', 'deliver', 'ek wicket'] },
      ],
    },
  },
  'bowling-change': {
    kw: ['tilak', 'bowling change', 'part-timer', 'part timer', 'captain', 'bumrah kahan', 'bumrah kyun', 'masterstroke', 'golden arm',
      'wapas liya', 'kisne bola', '16th', 'bacha rahe', 'hardik bhai', 'hardik ko', 'thank you hardik', 'gift'],
    event: 'bowling_change',
    poll: {
      question: 'Tilak in the 16th over: right call?',
      options: [
        { label: 'Mistake, bowl Bumrah', verdict: 'thinks the bowling change was a mistake',
          kw: ['mistake', 'kahan', 'kyun', 'bakwaas', 'blunder', 'free ke runs', 'gift', 'thank you hardik', 'lol', '??', 'backfire', 'bola tha', 'samajh nahi', 'popcorn', 'paani'] },
        { label: 'Smart call', verdict: 'backs the bowling change', kw: ['trust', 'plan', 'record', 'smart', 'bacha rahe'] },
      ],
    },
  },
  'dube-show': { kw: ['dube'], event: null },
};

const EVENT_TOPIC = Object.fromEntries(Object.entries(TOPICS).filter(([, t]) => t.event).map(([id, t]) => [t.event, id]));
const MAJOR = ['result', 'wicket', 'drop', 'review', 'bowling_change', 'last_over', 'walk_in', 'boundary'];
const DELTA = {
  wicket: { bat: -26, bowl: 34 }, boundary: { bat: 6, bowl: -6 }, bowling_change: { bat: 8, bowl: -14 },
  review: { bat: 8, bowl: -10 }, drop: { bat: 12, bowl: -16 }, walk_in: { bat: 14, bowl: -6 },
};

// A burst of chat right after a big moment is usually about that moment, even without keywords.
let recentTopic = { id: null, at: 0 };

const topicFor = (text) => {
  const t = text.toLowerCase();
  return Object.entries(TOPICS).find(([, def]) => def.kw.some((k) => t.includes(k)))?.[0] || null;
};
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

export function moodWord(v) {
  if (v < 20) return 'Gutted';
  if (v < 38) return 'Fuming';
  if (v < 50) return 'Nervous';
  if (v < 62) return 'Hopeful';
  if (v < 80) return 'Upbeat';
  return 'Buzzing';
}

function feel(msgs) {
  if (!msgs.length) return 'are quiet';
  const a = avg(msgs.map((m) => m.s));
  if (a <= -0.3) return 'are angry';
  if (a < 0) return 'are uneasy';
  if (a === 0) return 'are split';
  if (a >= 0.3) return 'are loving it';
  return 'are hopeful';
}

function summarise(msgs) {
  const loud = [...msgs].sort((a, b) => Math.abs(b.s) - Math.abs(a.s) || b.text.length - a.text.length)
    .find((m) => m.text.length >= 12 && m.text.length <= 60) || msgs[0];
  const sides = TEAM_CODES.map((code) => `${code} fans ${feel(msgs.filter((m) => m.team === code))}`).join(', ');
  return `${sides}. Loudest take: "${loud.text}"`;
}

function buildPoll(topic, msgs) {
  const spec = TOPICS[topic].poll;
  const counts = spec.options.map((o) => 1 + msgs.filter((m) => o.kw.some((k) => m.text.toLowerCase().includes(k))).length);
  const total = counts.reduce((a, b) => a + b, 0);
  return {
    question: spec.question,
    thread: topic,
    options: spec.options.map(({ label, verdict }) => ({ label, verdict })),
    // Chat over-represents the loudest side, so pull the estimate a little toward an even split.
    lean: counts.map((c) => clamp(0.5 + (c / total - 0.5) * 0.8, 0.12, 0.88)),
  };
}

const EMPTY_POLL = { question: '', thread: '', options: [], lean: [] };

function nextMood(p) {
  const bat = p.match.batting_code;
  const bowl = p.match.bowling_code;
  // Moods drift back toward neutral so one big moment does not pin a fan base for the rest of the match.
  const mood = Object.fromEntries(TEAM_CODES.map((c) => [c, 50 + ((p.mood_prev?.[c] ?? 50) - 50) * 0.8]));
  for (const e of p.events) {
    const d = DELTA[e.type];
    if (d) { mood[bat] += d.bat; mood[bowl] += d.bowl; }
  }
  for (const code of TEAM_CODES) {
    const own = p.messages.filter((m) => m.team === code).map((m) => sentiment(m.text));
    if (own.length) mood[code] += avg(own) * 12;
  }
  if (p.events.some((e) => e.type === 'result')) {
    const batWon = p.match.need_runs === 0;
    mood[bat] = batWon ? 96 : 8;
    mood[bowl] = batWon ? 8 : 96;
  }
  return Object.fromEntries(TEAM_CODES.map((c) => [c, Math.round(clamp(mood[c], 3, 97))]));
}

function pulseFor(p, mood, topThread) {
  const m = p.match;
  const w = (code) => moodWord(mood[code]).toLowerCase();
  const tail = `${m.bowling_code} fans ${w(m.bowling_code)}, ${m.batting_code} fans ${w(m.batting_code)}.`;
  const e = MAJOR.map((type) => p.events.findLast((x) => x.type === type)).find(Boolean);
  switch (e?.type) {
    case 'result': {
      const winner = m.need_runs === 0 ? m.batting_code : m.bowling_code;
      return `${winner} win it off the last ball. ${winner} fans ${w(winner)}, ${otherTeam(winner)} fans ${w(otherTeam(winner))}.`;
    }
    case 'wicket': return `${shortName(e.out)} is gone. ${tail}`;
    case 'drop': return `Dropped! ${m.need_runs} off ${m.balls_left} now. ${tail}`;
    case 'review': return `The review stays not out. ${tail}`;
    case 'bowling_change': return `${shortName(e.bowler)} gets the ball and the room erupts. ${tail}`;
    case 'last_over': return `Last over, ${m.need_runs} to win. ${tail}`;
    case 'walk_in': return `${e.text.split('.')[0]}. ${tail}`;
    case 'boundary': return `${shortName(e.bat)} is taking over. ${m.need_runs} off ${m.balls_left}. ${tail}`;
    default:
      return topThread ? `Most of the room is on ${topThread}. ${tail}` : `${m.need_runs} off ${m.balls_left}. ${tail}`;
  }
}

function batterScore(match, name) {
  const line = match.batters.find((b) => b.startsWith(name));
  return line ? line.slice(name.length).replace('*', '').trim() : '';
}

function forYou(p) {
  const { picks } = p.profile;
  const m = p.match;
  for (const e of [...p.events].reverse()) {
    if (e.type === 'wicket' && picks.includes(e.out)) return `Your pick ${shortName(e.out)} is out. Tough one.`;
    if (e.type === 'wicket' && picks.includes(e.bowler)) return `Your pick ${shortName(e.bowler)} just took a wicket.`;
    if (e.type === 'boundary' && picks.includes(e.bat)) return `Your pick ${shortName(e.bat)} keeps going: ${batterScore(m, e.bat)}.`;
  }
  if (picks.includes(m.current_bowler)) return `Your pick ${shortName(m.current_bowler)} is bowling: ${m.bowler.slice(m.current_bowler.length).trim()}.`;
  const batting = picks.find((pk) => m.batters.some((b) => b.startsWith(pk)));
  if (batting) return `Your pick ${shortName(batting)} is batting: ${batterScore(m, batting)}.`;
  return '';
}

function hostNote(callbacks) {
  const c = callbacks[0];
  if (!c) return '';
  return /mistake|wrong|bad|no\b/i.test(c.winning_option)
    ? `Plot twist: ${c.what_happened}, a few balls after ${c.pct}% of this room voted "${c.winning_option}". 👀`
    : `Called it: ${c.what_happened}. ${c.pct}% of this room backed "${c.winning_option}".`;
}

export function tick(p) {
  const existing = new Set(p.threads.map((t) => t.id));
  const evType = MAJOR.map((type) => p.events.findLast((x) => x.type === type && EVENT_TOPIC[type])).find(Boolean)?.type;
  if (evType) recentTopic = { id: EVENT_TOPIC[evType], at: Date.now() };
  const fallbackTopic = Date.now() - recentTopic.at < 15000 ? recentTopic.id : null;

  const groups = {};
  const scored = p.messages.map((m) => {
    const s = sentiment(m.text);
    let topic = topicFor(m.text);
    if (!topic && fallbackTopic && m.text.length > 10 && s !== 0) topic = fallbackTopic;
    if (topic) (groups[topic] ||= []).push({ ...m, s });
    return { id: m.id, topic, s };
  });

  const new_threads = [];
  const thread_updates = [];
  for (const [topic, msgs] of Object.entries(groups)) {
    if (existing.has(topic)) thread_updates.push({ id: topic, summary: summarise(msgs) });
    else if (msgs.length >= 4) {
      new_threads.push({ id: topic, title: `#${topic}`, summary: summarise(msgs) });
      existing.add(topic);
    }
  }

  let poll = EMPTY_POLL;
  if (p.can_poll) {
    const best = Object.entries(groups)
      .filter(([t, msgs]) => TOPICS[t].poll && msgs.length >= 5 && !p.polls.some((x) => x.thread === t))
      .sort((a, b) => b[1].length - a[1].length)[0];
    if (best) poll = buildPoll(best[0], best[1]);
  }

  const mood = nextMood(p);
  const busiest = Object.entries(groups).filter(([t]) => existing.has(t)).sort((a, b) => b[1].length - a[1].length)[0];
  return {
    pulse: pulseFor(p, mood, busiest ? `#${busiest[0]}` : ''),
    mood,
    assignments: scored.map(({ id, topic, s }) => ({ id, thread: topic && existing.has(topic) ? topic : '', sentiment: s })),
    new_threads,
    thread_updates,
    poll,
    host_note: hostNote(p.callbacks),
    for_you: forYou(p),
  };
}

export function catchup(p) {
  const m = p.match;
  const headline = m.need_runs === 0
    ? `${m.batting_code} won it. ${m.score} in ${m.overs} overs.`
    : `${m.score} after ${m.overs}. ${m.need_runs} needed off ${m.balls_left}.`;
  if (!p.balls.length) return { headline, bullets: ['Nothing big has happened since you last checked.'], room: '' };

  const picks = p.profile.picks;
  const tagPick = (name, text) => (picks.includes(name) ? `Your pick ${text}` : text);
  const key = [];
  for (const b of p.balls) {
    if (b.wicket) key.push({ w: 3, t: `${b.over}: ${tagPick(b.wicket, `${shortName(b.wicket)} out, ${b.how}.`)}` });
    else if (/DROPPED/.test(b.text)) key.push({ w: 2, t: `${b.over}: dropped catch. ${shortName(b.bat)} survives.` });
    else if (b.runs === 6 && picks.includes(b.bat)) key.push({ w: 1.5, t: `${b.over}: your pick ${shortName(b.bat)} hit a six.` });
  }
  for (const e of p.events) {
    if (e.type === 'bowling_change') key.push({ w: 2.5, t: `Bowling change: part-timer ${shortName(e.bowler)} came on ahead of a frontline bowler.` });
    if (e.type === 'review') key.push({ w: 2, t: `DRS: ${e.text}` });
  }
  const legal = p.balls.filter((b) => !b.extra);
  const runs = p.balls.reduce((s, b) => s + b.runs, 0);
  const fours = legal.filter((b) => b.runs === 4).length;
  const sixes = legal.filter((b) => b.runs === 6).length;
  key.push({ w: 1, t: `${runs} runs off ${legal.length} balls, with ${fours} fours and ${sixes} sixes.` });

  const bullets = key.sort((a, b) => b.w - a.w).slice(0, 3).map((k) => k.t);
  const poll = p.polls.findLast((x) => x.result);
  const thread = p.threads[0];
  const room = poll ? `${poll.result}.` : thread ? `Most talked about: ${thread.title}. ${thread.summary}` : '';
  return { headline, bullets, room };
}

const ALL_PLAYERS = [...Object.values(SQUADS).flat(), 'Mitchell Santner', 'Deepak Chahar', 'Dewald Brevis'];

export function ask(p) {
  const q = p.question.toLowerCase();
  const m = p.match;
  if (/need|required|rrr|target|how many|kitne|chahiye/.test(q)) {
    return { reply: m.need_runs ? `${m.batting_code} need ${m.need_runs} off ${m.balls_left}, required rate ${m.required_rate}.` : `${m.batting_code} have already won it.` };
  }
  const player = ALL_PLAYERS.find((n) => q.includes(shortName(n).toLowerCase()) || (n === 'MS Dhoni' && /thala|mahi/.test(q)));
  if (player) {
    const bat = m.batters.find((b) => b.startsWith(player));
    const bowl = m.bowling_figures.find((b) => b.startsWith(player));
    const out = m.dismissed.find((b) => b.startsWith(player));
    const line = bat ? `${bat.replace('*', '').slice(player.length).trim()} and batting` : out ? `out, ${out.slice(player.length).trim()}` : bowl ? `bowling figures ${bowl.slice(player.length).trim()}` : 'yet to come in';
    return { reply: `${player}: ${line}.` };
  }
  if (/win|predict|chance|jeet/.test(q)) {
    return { reply: `Tough to call: ${m.need_runs} off ${m.balls_left} with ${10 - Number(m.score.split('/')[1])} wickets in hand. The room is split.` };
  }
  if (/room|talking|thread|everyone|log/.test(q) && p.threads.length) {
    return { reply: `The room is mostly on ${p.threads[0].title}. ${p.threads[0].summary}` };
  }
  return { reply: `${m.score} after ${m.overs}. Last ball: ${m.recent_balls.at(-1)?.replace(/^\S+\s/, '') || 'none yet'}` };
}
