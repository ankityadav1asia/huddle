// Huddle: the AI co-host inside a live watch-along room.
// The replay feeds balls and crowd chat in; every few seconds the AI reads the new chat and
// writes back the room pulse, moment threads, polls and callbacks.
import { TEAMS, TEAM_CODES, otherTeam, SQUADS, START, shortName, SCRIPT, MOMENTS, CROWD, HOST_LINES, FANS, CREATOR } from './data.js';
import { newMatch, applyBall, summary, need, oversText, batterLine, figures } from './match.js';
import { initAI, runAI, aiState } from './ai.js';
import { moodWord } from './local-ai.js';

const BALL_GAP = 3200;
const OVER_GAP = 2600;
const POLL_MS = 10000;
const TICK_EVERY = 9000;
const URGENT_DELAY = 3200;
const MAX_FEED_NODES = 260;
const SPARK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0l1.9 6.1L16 8l-6.1 1.9L8 16l-1.9-6.1L0 8l6.1-1.9z"/></svg>';

const $ = (sel, root = document) => root.querySelector(sel);
function h(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const arr = (v) => (Array.isArray(v) ? v : []);
const slug = (v) => str(v, 40).toLowerCase().replace(/^#/, '').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
const clampInt = (v, lo, hi, fallback) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
};
const initials = (handle) => (handle.split(/[^a-z0-9]+/i).filter(Boolean).map((s) => s[0]).join('') || handle).slice(0, 2);
const fmtK = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const pickOne = (xs) => xs[Math.floor(Math.random() * xs.length)];
const shuffle = (xs) => {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs;
};
const sampleIndex = (weights) => {
  let x = Math.random();
  for (let i = 0; i < weights.length; i++) { x -= weights[i]; if (x <= 0) return i; }
  return weights.length - 1;
};

const els = {};
let S = null;
let sheetToken = 0;
let sheetDismissable = true;

function freshState(prev) {
  return {
    run: (prev?.run || 0) + 1,
    profile: prev?.profile || { team: 'CSK', picks: ['MS Dhoni', 'Jasprit Bumrah', 'Shivam Dube'] },
    speed: prev?.speed || 1,
    started: false,
    playing: false,
    finished: false,
    match: newMatch(),
    step: 0,
    timer: null,
    holdSince: 0,
    feed: [],
    messages: new Map(),
    fanCounts: {},
    pending: [],
    events: [],
    eventLog: [],
    callbacks: [],
    threads: new Map(),
    active: 'all',
    polls: [],
    lastPollAt: -Infinity,
    pulse: { text: 'Waiting for the room to warm up.', mood: { MI: 54, CSK: 52 }, forYou: '', at: 0, source: '' },
    ballLog: [],
    mark: 0,
    viewers: 12400,
    lastTick: 0,
    busy: false,
    urgentAt: 0,
    seq: 0,
    lines: {},
    stick: true,
    hiddenAt: 0,
    hiddenBalls: 0,
  };
}

/* ---------------- Feed ---------------- */

function itemThread(item) {
  return item.kind === 'msg' ? S.messages.get(item.id)?.thread || '' : item.thread;
}

function visible(item) {
  if (S.active === 'all') return true;
  return (item.kind === 'msg' || item.kind === 'poll' || item.kind === 'ai') && itemThread(item) === S.active;
}

function scrollToBottom() {
  els.scroll.scrollTop = els.scroll.scrollHeight;
}

function addFeed(kind, node, { id = null, thread = '' } = {}) {
  const item = { kind, node, id, thread };
  S.feed.push(item);
  if (S.feed.length > 700) S.feed.splice(0, S.feed.length - 700);
  if (visible(item)) {
    els.feed.append(node);
    if (S.active === 'all') while (els.feed.children.length > MAX_FEED_NODES) els.feed.firstElementChild.remove();
    if (S.stick) scrollToBottom();
    else els.newPill.hidden = false;
  }
  return item;
}

function renderFeed() {
  els.feed.replaceChildren();
  const items = S.feed.filter(visible).slice(-MAX_FEED_NODES);
  if (S.active !== 'all') {
    const t = S.threads.get(S.active);
    const head = h('div', 'thread-head');
    const back = h('button', 'ctl', 'Back to all chat');
    back.type = 'button';
    back.onclick = () => setActive('all');
    head.append(h('h2', null, t.title), h('p', null, t.summary || 'Huddle is still reading this one.'),
      h('span', 'meta', `${t.count} messages · started at ${t.startOver} overs`), back);
    els.feed.append(head);
    if (!items.length) els.feed.append(h('p', 'empty', 'No messages here yet. Say something to start it off.'));
  }
  items.forEach((i) => els.feed.append(i.node));
  S.stick = true;
  els.newPill.hidden = true;
  scrollToBottom();
}

function teamLogo(code, size = '') {
  const img = h('img', `logo ${size}`.trim());
  img.src = TEAMS[code].logo;
  img.alt = '';
  return img;
}

function avatar(handle, team) {
  return h('span', `avatar ${team.toLowerCase()}`, initials(handle));
}

function aiLabel(text) {
  const label = h('span', 'ai-label');
  label.innerHTML = SPARK;
  label.append(text);
  return label;
}

function msgNode(msg) {
  const row = h('div', `msg${msg.you ? ' you' : ''}${msg.creator ? ' creator' : ''}`);
  const body = h('div', 'msg-body');
  const meta = h('div', 'msg-meta');
  meta.append(h('b', 'handle', msg.you ? 'You' : msg.fan));
  meta.append(msg.creator ? h('span', 'badge host', 'HOST') : h('span', `badge ${msg.team.toLowerCase()}`, msg.team));
  msg.tagEl = h('span', 'thread-tag');
  msg.tagEl.hidden = true;
  meta.append(msg.tagEl);
  body.append(meta, h('p', 'msg-text', msg.text));
  row.append(avatar(msg.you ? 'you' : msg.fan, msg.team), body);
  return row;
}

function postMessage({ fan, team, text, you = false, creator = false, thread = '' }) {
  const id = `m${++S.seq}`;
  const msg = { id, fan, team, text, you, creator, thread: '', sentiment: 0 };
  S.messages.set(id, msg);
  S.fanCounts[fan] = (S.fanCounts[fan] || 0) + 1;
  if (!creator) S.pending.push(id);
  msg.node = msgNode(msg);
  if (thread && S.threads.has(thread)) assignThread(msg, thread);
  addFeed('msg', msg.node, { id });
  updateAllCount();
  return msg;
}

function assignThread(msg, tid) {
  const t = S.threads.get(tid);
  msg.thread = tid;
  t.count += 1;
  t.lastActive = Date.now();
  msg.tagEl.textContent = t.title;
  msg.tagEl.hidden = false;
}

function postHost(text) {
  postMessage({ fan: CREATOR.handle, team: 'host', text, creator: true });
}

function postAI(text, { thread = '', sub = '' } = {}) {
  const box = h('div', 'ai-note');
  box.append(aiLabel('Huddle AI'), h('p', null, text));
  if (sub) box.append(h('p', 'sub', sub));
  addFeed('ai', box, { thread });
}

function addBallRow(entry) {
  const row = h('div', `ball-row${entry.symbol === 'W' || entry.runs >= 4 ? ' big' : ''}`);
  row.append(ballDot(entry.symbol), h('span', 'ball-over', entry.label), h('span', 'ball-text', entry.text));
  addFeed('ball', row);
}

function addEventRow(label, text) {
  const row = h('div', 'event-row');
  row.append(h('b', null, label), document.createTextNode(text));
  addFeed('event', row);
}

function ballDot(symbol) {
  return h('span', `ball-dot r${symbol}`, symbol === '0' ? '•' : symbol);
}

/* ---------------- Crowd ---------------- */

function nextLine(key, side) {
  const lines = CROWD[key]?.[side] || CROWD[key]?.[otherTeam(side)];
  if (!lines) return null;
  const bagKey = `${key}:${side}`;
  if (!S.lines[bagKey]?.length) S.lines[bagKey] = shuffle([...lines]);
  return S.lines[bagKey].pop();
}

function fillLine(text) {
  const n = need(S.match);
  return text.replaceAll('{need}', n.runs).replaceAll('{balls}', n.balls)
    .replaceAll('{bat}', shortName(S.match.striker)).replaceAll('{bowler}', shortName(S.match.bowler));
}

function postFan(key, side) {
  const line = nextLine(key, side);
  if (!line) return;
  const fan = pickOne(FANS.filter((f) => f.team === side));
  postMessage({ fan: fan.handle, team: side, text: fillLine(line) });
}

function crowdBurst({ key, n, spread = 4000, mi = 0.5 }) {
  const run = S.run;
  for (let i = 0; i < n; i++) {
    const side = Math.random() < mi ? 'MI' : 'CSK';
    const at = (i / n) * spread + Math.random() * 500;
    setTimeout(() => { if (run === S.run && S.playing) postFan(key, side); }, at / S.speed);
  }
}

function ambient(item) {
  if (item.runs >= 4 && !item.extra) crowdBurst({ key: 'boundary', n: 3, spread: 2500 });
  else if (item.runs === 0 && Math.random() < 0.5) crowdBurst({ key: 'dot', n: 1, spread: 1500 });
  else if (Math.random() < 0.6) crowdBurst({ key: S.match.balls >= 102 ? 'tension' : 'chatter', n: 1, spread: 2500 });
}

function bumpViewers(big) {
  S.viewers += big ? 180 + Math.round(Math.random() * 260) : Math.round((Math.random() - 0.45) * 60);
  els.viewers.textContent = fmtK(S.viewers);
}

/* ---------------- Match runner ---------------- */

function pushEvent(e) {
  const ev = { ...e, over: oversText(S.match.balls), ballIdx: S.ballLog.length };
  S.events.push(ev);
  S.eventLog.push(ev);
}

function recordBall(item) {
  const res = applyBall(S.match, item);
  const entry = {
    label: res.label, symbol: res.symbol, text: item.text, runs: item.runs, extra: item.extra || '',
    bat: item.bat, bowler: item.bowler, wicket: item.wicket || null,
  };
  S.ballLog.push(entry);
  if (item.wicket) pushEvent({ type: 'wicket', bowler: item.bowler, out: item.wicket.out, how: item.wicket.how, text: item.text });
  else if (item.drop) pushEvent({ type: 'drop', bowler: item.bowler, bat: item.bat, text: item.text });
  else if (item.runs >= 4 && !item.extra) pushEvent({ type: 'boundary', bat: item.bat, bowler: item.bowler, runs: item.runs, text: item.text });
  if (item.wicket) checkCallbacks(item);
  return entry;
}

function recordEvent(item) {
  pushEvent({ type: item.type, label: item.label, text: item.text, bowler: item.bowler });
}

function playItem(item) {
  if (item.kind === 'ball') {
    addBallRow(recordBall(item));
    renderScore();
  } else if (item.kind === 'event') {
    recordEvent(item);
    addEventRow(item.label, item.text);
    if (item.type === 'result') S.finished = true;
  }
  if (item.urgent) S.urgentAt = Date.now();
  if (item.host) postHost(HOST_LINES[item.host]);
  if (item.crowd) crowdBurst(item.crowd);
  else if (item.kind === 'ball') ambient(item);
  else if (item.kind === 'overend') crowdBurst({ key: 'overend', n: 3, spread: 2400 });
  bumpViewers(Boolean(item.urgent));
}

// Hold the replay while a poll is still running, so a result is never spoiled by the next ball.
function shouldHold() {
  if (!S.holdSince) S.holdSince = Date.now();
  const waiting = S.polls.some((p) => p.open) || S.busy;
  if (!waiting || Date.now() - S.holdSince > 15000) {
    S.holdSince = 0;
    return false;
  }
  return true;
}

function stepOnce() {
  const item = SCRIPT[S.step];
  if (!item) {
    S.finished = true;
    renderControls();
    return;
  }
  if (item.hold === 'poll' && shouldHold()) {
    S.timer = setTimeout(stepOnce, 500);
    return;
  }
  S.step += 1;
  playItem(item);
  const delay = item.pause || (item.kind === 'overend' ? OVER_GAP : BALL_GAP);
  if (S.finished) renderControls();
  else scheduleNext(delay);
}

function scheduleNext(delay) {
  clearTimeout(S.timer);
  if (!S.playing || S.finished) return;
  S.timer = setTimeout(stepOnce, delay / S.speed);
}

function startMatch() {
  S.started = true;
  S.playing = true;
  renderControls();
  scheduleNext(900);
}

function fastForward(toIdx) {
  while (S.step < toIdx && S.step < SCRIPT.length) {
    const item = SCRIPT[S.step++];
    if (item.kind === 'ball') recordBall(item);
    else if (item.kind === 'event') recordEvent(item);
  }
  S.events = [];
  S.callbacks = [];
}

function restartMatch(toIdx = 0) {
  clearTimeout(S.timer);
  closeSheet();
  S = freshState(S);
  els.feed.replaceChildren();
  els.banner.hidden = true;
  els.toast.hidden = true;
  addEventRow('First innings', `${START.firstInnings}. CSK need ${START.target} to win.`);
  if (toIdx > 0) {
    fastForward(toIdx);
    addEventRow('Skipped ahead', `Jumped to ${oversText(S.match.balls)} overs: ${S.match.batting} ${S.match.runs}/${S.match.wkts}. Tap Catch me up to see what you skipped.`);
  }
  renderScore();
  renderPulse();
  renderChips();
  renderFans();
  startMatch();
}

function jumpTo(momentId) {
  restartMatch(SCRIPT.findIndex((s) => s.moment === momentId));
}

function lookAway() {
  if (!S.started || S.finished) return;
  closeSheet();
  const fromOvers = oversText(S.match.balls);
  let legal = 0;
  while (S.step < SCRIPT.length && legal < 12) {
    const item = SCRIPT[S.step];
    if (item.kind === 'event' && item.type === 'result') break;
    S.step += 1;
    if (item.kind === 'ball' && !recordBall(item).extra) legal += 1;
    else if (item.kind === 'event') recordEvent(item);
    if (item.crowd) {
      for (let i = 0; i < Math.ceil(item.crowd.n / 2); i++) postFan(item.crowd.key, Math.random() < (item.crowd.mi ?? 0.5) ? 'MI' : 'CSK');
    }
  }
  addEventRow('While you were away', `${fromOvers} to ${oversText(S.match.balls)} overs. ${S.match.batting} are now ${S.match.runs}/${S.match.wkts}.`);
  renderScore();
  S.urgentAt = Date.now();
  showBanner(`You looked away for ${legal % 6 ? `${legal} balls` : `${legal / 6} overs`}.`);
  scheduleNext(BALL_GAP * 1.5);
}

function togglePlay() {
  if (!S.started) {
    closeSheet();
    startMatch();
    return;
  }
  if (S.finished) {
    restartMatch(0);
    return;
  }
  S.playing = !S.playing;
  if (S.playing) scheduleNext(600);
  else clearTimeout(S.timer);
  renderControls();
}

/* ---------------- AI tick ---------------- */

const canPoll = () => !S.polls.some((p) => p.open) && Date.now() - S.lastPollAt > 35000 && S.polls.length < 5;

const topThreads = (n) => [...S.threads.values()].sort((a, b) => b.count - a.count).slice(0, n)
  .map((t) => ({ id: t.id, title: t.title, summary: t.summary, messages: t.count }));

async function tick() {
  const ids = S.pending.splice(0, 80);
  const events = S.events.splice(0);
  const callbacks = S.callbacks.splice(0);
  if (!ids.length && !events.length && !callbacks.length) return;
  const run = S.run;
  S.busy = true;
  S.lastTick = Date.now();
  els.pulse.classList.add('thinking');
  const payload = {
    match: summary(S.match),
    events: events.map(({ ballIdx, ...e }) => e),
    messages: ids.map((id) => {
      const m = S.messages.get(id);
      return { id, fan: m.you ? 'viewer' : m.fan, team: m.team, text: m.text };
    }),
    threads: topThreads(6),
    polls: S.polls.slice(-3).map((p) => ({ question: p.question, thread: p.thread, status: p.open ? 'open' : 'closed', result: p.result?.line || '' })),
    callbacks,
    can_poll: canPoll(),
    mood_prev: S.pulse.mood,
    profile: S.profile,
  };
  let out = null;
  try {
    out = await runAI('tick', payload);
  } catch (err) {
    console.error('AI tick failed', err);
  }
  if (run !== S.run) return;
  S.busy = false;
  els.pulse.classList.remove('thinking');
  if (out) applyTick(out.data, ids, out.source, payload);
}

function applyTick(d, ids, source, payload) {
  if (!d || typeof d !== 'object') return;
  const created = [];
  for (const t of arr(d.new_threads)) {
    const id = slug(t.id || t.title);
    if (!id) continue;
    if (S.threads.has(id)) {
      S.threads.get(id).summary = str(t.summary, 160) || S.threads.get(id).summary;
    } else if (S.threads.size < 6) {
      S.threads.set(id, { id, title: `#${id}`, summary: str(t.summary, 160), count: 0, lastActive: Date.now(), startOver: oversText(S.match.balls), fresh: true });
      created.push(id);
    }
  }
  for (const u of arr(d.thread_updates)) {
    const t = S.threads.get(slug(u.id));
    if (t && str(u.summary)) t.summary = str(u.summary, 160);
  }
  const batch = new Set(ids);
  for (const a of arr(d.assignments)) {
    const m = batch.has(a.id) && S.messages.get(a.id);
    if (!m) continue;
    m.sentiment = clampInt(a.sentiment, -1, 1, 0);
    const tid = slug(a.thread);
    if (tid && S.threads.has(tid) && !m.thread) assignThread(m, tid);
  }

  if (str(d.pulse)) S.pulse.text = str(d.pulse, 140);
  if (d.mood && typeof d.mood === 'object') {
    S.pulse.mood = Object.fromEntries(TEAM_CODES.map((c) => [c, clampInt(d.mood[c], 0, 100, S.pulse.mood[c])]));
  }
  S.pulse.forYou = str(d.for_you, 120);
  S.pulse.at = Date.now();
  S.pulse.source = source;

  if (payload.can_poll && d.poll && str(d.poll.question)) openPoll(d.poll);
  if (str(d.host_note)) postAI(str(d.host_note, 200), { thread: payload.callbacks[0]?.thread || '' });

  renderPulse();
  renderChips();
  renderFans();
  if (S.active !== 'all') renderFeed();
  for (const id of created) {
    const t = S.threads.get(id);
    toast([h('b', null, t.title), ` started. ${t.count} fans are talking about it.`], { label: 'Open', run: () => setActive(id) });
  }
}

/* ---------------- Polls ---------------- */

function decisionBowler() {
  const e = S.eventLog.findLast((x) => x.type === 'bowling_change');
  return e && S.ballLog.length - e.ballIdx <= 12 ? e.bowler : S.match.bowler;
}

function openPoll(spec) {
  const options = arr(spec.options).slice(0, 3)
    .map((o) => ({ label: str(o?.label, 28), verdict: str(o?.verdict, 90).replace(/[.!\s]+$/, ''), votes: 0 }))
    .filter((o) => o.label);
  if (options.length < 2) return;
  options.forEach((o) => { if (!o.verdict) o.verdict = `voted "${o.label}"`; });
  let lean = arr(spec.lean).map(Number);
  if (lean.length !== options.length || lean.some((x) => !(x >= 0)) || !lean.some((x) => x > 0)) lean = options.map(() => 1);
  const total = lean.reduce((a, b) => a + b, 0);
  lean = lean.map((x) => x / total);
  const thread = S.threads.has(slug(spec.thread)) ? slug(spec.thread) : '';
  const p = {
    id: `p${++S.seq}`, question: str(spec.question, 90), options, lean, thread,
    open: true, openedAt: Date.now(), total: 0, target: Math.round(S.viewers * (0.09 + Math.random() * 0.04)),
    userVote: null, fanVotes: {}, subjectBowler: decisionBowler(), result: null, calledBack: false,
  };
  FANS.forEach((f) => { p.fanVotes[f.handle] = sampleIndex(lean); });
  p.node = pollNode(p);
  S.polls.push(p);
  S.lastPollAt = Date.now();
  addFeed('poll', p.node, { thread });
  if (S.active !== 'all' && S.active !== thread) {
    toast([h('b', null, 'New poll: '), p.question], { label: 'Vote', run: () => setActive(thread || 'all') });
  }
}

function pollNode(p) {
  const box = h('div', 'poll');
  const head = h('div', 'poll-head');
  head.append(aiLabel('AI poll'));
  if (p.thread) head.append(h('span', 'poll-thread', `#${p.thread}`));
  box.append(head, h('p', 'poll-q', p.question));
  p.optEls = p.options.map((o, i) => {
    const b = h('button', 'poll-opt');
    b.type = 'button';
    const fill = h('span', 'fill');
    const pct = h('span', 'pct', '');
    b.append(fill, h('span', null, o.label), pct);
    b.onclick = () => vote(p, i);
    box.append(b);
    return { b, fill, pct };
  });
  const foot = h('div', 'poll-foot');
  p.votesEl = h('span');
  p.timerEl = h('span');
  foot.append(p.votesEl, p.timerEl);
  p.resultEl = h('p', 'poll-result');
  p.resultEl.hidden = true;
  box.append(foot, p.resultEl);
  updatePoll(p);
  return box;
}

function vote(p, i) {
  if (!p.open || p.userVote != null) return;
  p.userVote = i;
  p.options[i].votes += 1;
  p.total += 1;
  p.optEls[i].b.classList.add('mine');
  updatePoll(p);
  renderFans();
}

function updatePoll(p) {
  p.optEls.forEach((e, i) => {
    const pct = p.total ? Math.round((p.options[i].votes / p.total) * 100) : 0;
    e.fill.style.width = `${pct}%`;
    e.pct.textContent = `${pct}%`;
  });
  p.votesEl.textContent = `${p.total.toLocaleString('en-IN')} votes`;
  p.timerEl.textContent = p.open ? `${Math.max(0, Math.ceil((p.openedAt + POLL_MS - Date.now()) / 1000))}s left` : 'Closed';
}

function pollStep() {
  for (const p of S.polls) {
    if (!p.open) continue;
    const t = Math.min(1, (Date.now() - p.openedAt) / POLL_MS);
    const want = Math.round(p.target * (1 - (1 - t) ** 2));
    const weights = p.lean.map((x) => Math.max(0.01, x + (Math.random() - 0.5) * 0.08));
    const sum = weights.reduce((a, b) => a + b, 0);
    const norm = weights.map((x) => x / sum);
    for (let add = want - (p.total - (p.userVote != null ? 1 : 0)); add > 0; add--) {
      p.options[sampleIndex(norm)].votes += 1;
      p.total += 1;
    }
    if (t >= 1) closePoll(p);
    updatePoll(p);
  }
}

function closePoll(p) {
  p.open = false;
  const win = p.options.reduce((best, o, i, all) => (o.votes > all[best].votes ? i : best), 0);
  const pct = Math.round((p.options[win].votes / p.total) * 100);
  const line = `${pct}% of this room ${p.options[win].verdict}`;
  p.result = { idx: win, pct, label: p.options[win].label, line };
  p.closedAtBall = S.match.balls;
  p.optEls.forEach((e, i) => {
    e.b.disabled = true;
    if (i === win) e.b.classList.add('winner');
  });
  p.resultEl.replaceChildren(h('em', null, `${pct}%`), ` of this room ${p.options[win].verdict}`);
  p.resultEl.hidden = false;
  let sub = '';
  if (p.userVote === win) sub = `You're with the ${pct}%.`;
  else if (p.userVote != null) sub = `You're with the ${Math.round((p.options[p.userVote].votes / p.total) * 100)}% who said "${p.options[p.userVote].label}".`;
  postAI(`${line}.`, { thread: p.thread, sub });
  pushEvent({ type: 'poll_result', text: line });
}

// Rules spot the callback (cheap); the AI writes the line.
function checkCallbacks(item) {
  for (const p of S.polls) {
    if (p.open || !p.result || p.calledBack || p.subjectBowler !== item.bowler) continue;
    if (S.match.balls - p.closedAtBall > 12) continue;
    p.calledBack = true;
    S.callbacks.push({
      poll_question: p.question, poll_result: p.result.line, winning_option: p.result.label, pct: p.result.pct,
      what_happened: `${item.bowler} just dismissed ${item.wicket.out}`, thread: p.thread,
    });
    S.urgentAt = Date.now();
  }
}

/* ---------------- Rendering ---------------- */

function renderScore() {
  const m = S.match;
  const n = need(m);
  const line = h('div', 'score-line');
  const needEl = h('span', 'score-need');
  if (n.runs === 0) needEl.append(h('b', null, `${TEAMS[m.batting].name} won`));
  else {
    needEl.append('Need ', h('b', null, String(n.runs)), ' off ', h('b', null, String(n.balls)), h('br'),
      `Target ${m.target} · RRR ${n.balls ? (n.runs / (n.balls / 6)).toFixed(2) : '-'}`);
  }
  const chip = h('span', 'team-chip');
  chip.append(teamLogo(m.batting), m.batting);
  line.append(chip, h('span', 'score-runs', `${m.runs}/${m.wkts}`),
    h('span', 'score-overs', `(${oversText(m.balls)})`), needEl);

  const row1 = h('div', 'score-row');
  const dots = h('span', 'this-over');
  m.thisOver.forEach((s) => dots.append(ballDot(s)));
  row1.append(h('span', 'score-batters', batterLine(m)), dots);

  const row2 = h('div', 'score-row');
  const bowl = h('span');
  bowl.append('Bowling ', h('b', null, shortName(m.bowler)), ` ${figures(m.bowlers[m.bowler])}`);
  row2.append(bowl, h('span', 'replay-tag', `Sim replay · ${START.firstInnings.replace(' (20)', '')}`));
  els.score.replaceChildren(line, row1, row2);
}

function renderPulse() {
  const p = S.pulse;
  if (els.pulseText.textContent !== p.text) {
    els.pulseText.classList.add('swap');
    setTimeout(() => {
      els.pulseText.textContent = S.pulse.text;
      els.pulseText.classList.remove('swap');
    }, 220);
  }
  for (const team of TEAM_CODES) {
    const box = els.pulse.querySelector(`.mood[data-team="${team}"]`);
    const v = p.mood[team];
    box.dataset.tone = v < 38 ? 'bad' : v < 62 ? 'ok' : 'good';
    box.querySelector('.mood-word').textContent = moodWord(v);
  }
  els.forYou.hidden = !p.forYou;
  els.forYouText.textContent = p.forYou;
}

function chipBtn(id, label, count, { hot = false, fresh = false } = {}) {
  const b = h('button', `chip${S.active === id ? ' active' : ''}${fresh ? ' fresh' : ''}`);
  b.type = 'button';
  if (hot) b.append(h('span', 'hot'));
  const countEl = h('span', 'count', fmtK(count));
  b.append(label, countEl);
  b.onclick = () => setActive(id);
  return { b, countEl };
}

function renderChips() {
  const all = chipBtn('all', 'All chat', S.messages.size);
  els.allCount = all.countEl;
  els.chips.replaceChildren(all.b);
  [...S.threads.values()].sort((a, b) => b.lastActive - a.lastActive).forEach((t) => {
    els.chips.append(chipBtn(t.id, t.title, t.count, { hot: Date.now() - t.lastActive < 12000, fresh: t.fresh }).b);
    t.fresh = false;
  });
}

function updateAllCount() {
  if (els.allCount) els.allCount.textContent = fmtK(S.messages.size);
}

function setActive(id) {
  S.active = id === 'all' || S.threads.has(id) ? id : 'all';
  els.say.placeholder = S.active === 'all' ? 'Say something, or ask @huddle' : `Reply in #${S.active}`;
  renderChips();
  renderFeed();
}

function toast(parts, action) {
  const text = h('span');
  text.append(...parts);
  els.toast.replaceChildren(text);
  if (action) {
    const b = h('button', null, action.label);
    b.type = 'button';
    b.onclick = () => { els.toast.hidden = true; action.run(); };
    els.toast.append(b);
  }
  els.toast.hidden = false;
  clearTimeout(els.toastTimer);
  els.toastTimer = setTimeout(() => { els.toast.hidden = true; }, 6000);
}

function showBanner(text) {
  const go = h('button', null, 'Catch me up');
  go.type = 'button';
  go.onclick = () => { els.banner.hidden = true; openCatchup(); };
  const x = h('button', 'x', '×');
  x.type = 'button';
  x.setAttribute('aria-label', 'Dismiss');
  x.onclick = () => { els.banner.hidden = true; };
  els.banner.replaceChildren(h('span', null, text), go, x);
  els.banner.hidden = false;
}

/* ---------------- Fans like you ---------------- */

function fanMatches() {
  const me = S.profile;
  return FANS.map((f) => {
    const reasons = [];
    let score = 0;
    if (f.team === me.team) { score += 2; reasons.push(`Backs ${f.team}`); }
    for (const p of f.picks) {
      if (me.picks.includes(p)) { score += 1.5; reasons.push(`Picked ${shortName(p)}`); }
    }
    for (const p of S.polls) {
      if (p.userVote != null && p.fanVotes[f.handle] === p.userVote) { score += 1; reasons.push(`Also voted "${p.options[p.userVote].label}"`); }
    }
    return { f, score, reasons, active: S.fanCounts[f.handle] || 0 };
  }).filter((x) => x.score >= 3.5).sort((a, b) => b.score - a.score || b.active - a.active);
}

function renderFans() {
  const matches = fanMatches();
  els.fansCount.textContent = String(matches.length);
}

/* ---------------- Sheets ---------------- */

function openSheet({ dismissable = true } = {}) {
  sheetToken += 1;
  sheetDismissable = dismissable;
  els.sheet.replaceChildren();
  els.sheetLayer.hidden = false;
  els.sheet.scrollTop = 0;
  return sheetToken;
}

function closeSheet() {
  sheetToken += 1;
  els.sheetLayer.hidden = true;
  els.sheet.replaceChildren();
}

function openOnboarding(first) {
  openSheet({ dismissable: !first });
  let team = S.profile.team;
  let picks = [...S.profile.picks];
  els.sheet.append(
    h('h2', null, first ? 'Join the watch-along' : 'Your profile'),
    h('p', 'lede', 'Huddle tunes the room to you: the team you back and the players in your social contest team.'),
    h('h3', null, 'Backing'),
  );
  const seg = h('div', 'seg');
  const teamBtns = ['CSK', 'MI'].map((code) => {
    const b = h('button');
    b.append(teamLogo(code, 'lg'), TEAMS[code].name);
    b.type = 'button';
    b.dataset.team = code;
    b.onclick = () => { team = code; sync(); };
    seg.append(b);
    return b;
  });
  const grid = h('div', 'pick-grid');
  const pickBtns = Object.entries(SQUADS).flatMap(([code, players]) => players.map((p) => {
    const b = h('button', 'pick');
    b.type = 'button';
    b.append(`${shortName(p)} `, h('small', null, code));
    b.onclick = () => {
      if (picks.includes(p)) picks = picks.filter((x) => x !== p);
      else picks = picks.length < 3 ? [...picks, p] : [...picks.slice(1), p];
      sync();
    };
    grid.append(b);
    return [p, b];
  }));
  const actions = h('div', 'sheet-actions');
  const go = h('button', 'btn primary', first ? 'Join the room' : 'Save');
  go.type = 'button';
  go.onclick = () => {
    S.profile = { team, picks };
    closeSheet();
    renderFans();
    if (first && !S.started) startMatch();
  };
  actions.append(go);
  const fine = h('p', 'fine', aiState.mode === 'live'
    ? `The match and crowd are a scripted replay. The AI is live (${aiState.provider}).`
    : 'The match and crowd are a scripted replay. No API key is set, so Huddle runs on its offline engine.');
  els.sheet.append(seg, h('h3', null, 'Players you picked (up to 3)'), grid, actions, fine);
  function sync() {
    teamBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.team === team)));
    pickBtns.forEach(([p, b]) => b.setAttribute('aria-pressed', String(picks.includes(p))));
    go.disabled = !picks.length;
  }
  sync();
}

async function openCatchup() {
  const token = openSheet();
  const from = Math.min(S.mark, Math.max(0, S.ballLog.length - 6));
  const balls = S.ballLog.slice(from).slice(-36);
  const headline = h('h2', null, 'Reading the last few overs…');
  const since = h('p', 'lede', balls.length ? `Since ${balls[0].label} overs` : 'Nothing has happened yet.');
  const slot = h('div');
  slot.append(h('div', 'skeleton'), h('div', 'skeleton'), h('div', 'skeleton'));
  els.sheet.append(aiLabel('Catch me up'), headline, since, slot);

  const run = S.run;
  const payload = {
    match: summary(S.match),
    balls: balls.map((b) => ({ over: b.label, text: b.text, runs: b.runs, extra: b.extra, bat: b.bat, wicket: b.wicket?.out || '', how: b.wicket?.how || '' })),
    events: S.eventLog.filter((e) => e.ballIdx >= from && e.type !== 'boundary').map(({ type, text, bowler, out }) => ({ type, text, bowler, out })),
    threads: topThreads(4),
    polls: S.polls.filter((p) => p.result).map((p) => ({ question: p.question, result: p.result.line, thread: p.thread })),
    profile: S.profile,
  };
  const { data, source } = await runAI('catchup', payload);
  if (run !== S.run || token !== sheetToken) return;
  S.mark = S.ballLog.length;
  headline.textContent = str(data?.headline, 120) || summary(S.match).score;
  const list = h('ul', 'bullets');
  arr(data?.bullets).slice(0, 3).forEach((b) => list.append(h('li', null, str(b, 160))));
  slot.replaceChildren(list);
  if (str(data?.room)) slot.append(h('h3', null, 'In the room'), h('p', 'room-line', str(data.room, 200)));
  const actions = h('div', 'sheet-actions');
  const done = h('button', 'btn primary', 'Back to the room');
  done.type = 'button';
  done.onclick = closeSheet;
  actions.append(done);
  slot.append(actions, h('p', 'source', source === 'live' ? `Written by ${aiState.provider} from the ball log and the chat.` : 'Written by the offline engine from the ball log and the chat.'));
}

function openFans() {
  openSheet();
  const matches = fanMatches();
  const me = S.profile;
  const share = matches.length / FANS.length;
  els.sheet.append(
    h('h2', null, 'Fans like you'),
    h('p', 'lede', `${matches.length} fans in this chat back the same team or picked the same players as you. That is about ${fmtK(Math.round(S.viewers * share))} of the ${fmtK(S.viewers)} watching.`),
  );
  const list = h('div');
  matches.slice(0, 8).forEach(({ f, reasons, active }) => {
    const row = h('div', 'fan-row');
    const main = h('div', 'fan-main');
    const chips = h('div', 'reasons');
    reasons.forEach((r) => chips.append(h('span', null, r)));
    main.append(h('b', null, f.handle), h('span', 'msg-meta', active ? ` · ${active} messages` : ''), chips);
    const wave = h('button', 'wave', 'Say hi');
    wave.type = 'button';
    wave.onclick = () => {
      closeSheet();
      els.say.value = `@${f.handle} `;
      els.say.focus();
    };
    row.append(avatar(f.handle, f.team), main, wave);
    list.append(row);
  });
  if (!matches.length) list.append(h('p', 'empty', 'No close matches yet. Vote in a poll to find fans who think like you.'));
  const you = h('p', 'fine', `You: ${TEAMS[me.team].name} · ${me.picks.map(shortName).join(', ')}`);
  const edit = h('button', 'btn', 'Edit my team and picks');
  edit.type = 'button';
  edit.onclick = () => openOnboarding(false);
  const actions = h('div', 'sheet-actions');
  actions.append(edit);
  els.sheet.append(h('h3', null, 'Best matches right now'), list, you, actions);
}

/* ---------------- Ask @huddle ---------------- */

async function askHuddle(question, msg) {
  const run = S.run;
  const payload = {
    question,
    match: summary(S.match),
    threads: topThreads(4),
    polls: S.polls.filter((p) => p.result).slice(-3).map((p) => ({ question: p.question, result: p.result.line })),
    room_mood: S.pulse.mood,
    profile: S.profile,
  };
  const { data } = await runAI('ask', payload);
  if (run !== S.run) return;
  postAI(str(data?.reply, 280) || "I couldn't work that one out from the match data.", { thread: msg.thread, sub: `You asked: "${question.slice(0, 70)}"` });
}

/* ---------------- Demo controls ---------------- */

function ctl(label, onClick) {
  const b = h('button', 'ctl', label);
  b.type = 'button';
  b.onclick = onClick;
  return b;
}

function buildControls(container) {
  const wrap = h('div', 'controls');
  const status = h('div', 'ai-status');
  status.dataset.ctl = 'status';
  const row1 = h('div', 'controls-row');
  const play = ctl('Start', togglePlay);
  play.classList.add('primary');
  play.dataset.ctl = 'play';
  const s1 = ctl('1x', () => setSpeed(1));
  s1.dataset.speed = '1';
  const s2 = ctl('2x', () => setSpeed(2));
  s2.dataset.speed = '2';
  row1.append(play, s1, s2, ctl('Restart', () => restartMatch(0)));
  const row2 = h('div', 'controls-row');
  MOMENTS.forEach((m) => row2.append(ctl(m.label, () => jumpTo(m.id))));
  const row3 = h('div', 'controls-row');
  row3.append(ctl('Look away for 2 overs', lookAway), ctl('Ask @huddle', () => {
    closeSheet();
    els.say.value = '@huddle CSK ko kitne runs chahiye?';
    els.say.focus();
  }));
  wrap.append(status, row1, h('p', 'ctl-label', 'Jump to a moment'), row2, h('p', 'ctl-label', 'Try'), row3);
  container.replaceChildren(wrap);
  renderControls();
}

function renderControls() {
  document.querySelectorAll('[data-ctl="play"]').forEach((b) => {
    b.textContent = !S.started ? 'Start' : S.finished ? 'Replay' : S.playing ? 'Pause' : 'Play';
  });
  document.querySelectorAll('[data-speed]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.speed) === S.speed)));
  document.querySelectorAll('[data-ctl="status"]').forEach((el) => {
    el.className = `ai-status ${aiState.mode}`;
    const text = aiState.mode === 'live' ? `Live AI · ${aiState.provider}` : aiState.mode === 'offline' ? 'Offline engine (no API key set)' : 'Connecting to the AI…';
    el.replaceChildren(h('i'), h('span', null, text));
  });
}

function setSpeed(n) {
  S.speed = n;
  renderControls();
}

function openControlsSheet() {
  openSheet();
  const box = h('div');
  els.sheet.append(h('h2', null, 'Demo controls'), h('p', 'lede', 'The match is a scripted replay. Jump to a big moment or look away to try Catch me up.'), box);
  buildControls(box);
}

/* ---------------- Boot ---------------- */

// On a laptop the app sits in a phone frame; shrink the whole frame on short screens instead of squashing the chat.
function fitPhone() {
  const phone = $('.phone');
  phone.style.zoom = innerWidth > 520 ? String(Math.min(1, (innerHeight - 32) / 864)) : '';
}

async function boot() {
  fitPhone();
  addEventListener('resize', fitPhone);
  for (const [key, id] of Object.entries({
    score: 'score', pulse: 'pulse', pulseText: 'pulse-text', forYou: 'for-you', forYouText: 'for-you-text',
    chips: 'chips', scroll: 'chat-scroll', feed: 'feed', banner: 'banner', toast: 'toast', newPill: 'new-pill', composer: 'composer',
    say: 'say', sheetLayer: 'sheet-layer', sheet: 'sheet', viewers: 'viewers', fansBtn: 'fans-btn',
    fansCount: 'fans-count', menuBtn: 'menu-btn', catchupBtn: 'catchup-btn',
  })) els[key] = document.getElementById(id);

  S = freshState();
  addEventRow('First innings', `${START.firstInnings}. CSK need ${START.target} to win.`);
  renderScore();
  renderPulse();
  renderChips();
  renderFans();
  document.querySelectorAll('[data-controls]').forEach(buildControls);

  els.menuBtn.onclick = openControlsSheet;
  els.fansBtn.onclick = openFans;
  els.catchupBtn.onclick = () => openCatchup();
  $('[data-close]', els.sheetLayer).onclick = () => { if (sheetDismissable) closeSheet(); };
  els.newPill.onclick = () => { S.stick = true; scrollToBottom(); els.newPill.hidden = true; };
  els.scroll.addEventListener('scroll', () => {
    const s = els.scroll;
    S.stick = s.scrollHeight - s.scrollTop - s.clientHeight < 60;
    if (S.stick) els.newPill.hidden = true;
  });
  els.composer.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = els.say.value.trim();
    if (!text) return;
    els.say.value = '';
    const msg = postMessage({ fan: 'You', team: S.profile.team, text, you: true, thread: S.active === 'all' ? '' : S.active });
    S.stick = true;
    scrollToBottom();
    if (/@huddle\b/i.test(text)) askHuddle(text.replace(/@huddle\b/gi, '').trim() || text, msg);
  });
  document.addEventListener('visibilitychange', () => {
    if (!S.started) return;
    if (document.hidden) {
      S.hiddenAt = Date.now();
      S.hiddenBalls = S.ballLog.length;
    } else if (S.hiddenAt) {
      const missed = S.ballLog.length - S.hiddenBalls;
      if (Date.now() - S.hiddenAt > 12000 && missed >= 3) showBanner(`Welcome back. You missed ${missed} deliveries.`);
      S.hiddenAt = 0;
    }
  });

  setInterval(() => {
    if (!S.started) return;
    pollStep();
    const now = Date.now();
    const urgentDue = S.urgentAt > S.lastTick && now - S.urgentAt > URGENT_DELAY;
    const regularDue = now - S.lastTick > TICK_EVERY && S.pending.length >= 3;
    if (!S.busy && (urgentDue || regularDue)) tick();
  }, 250);

  await initAI();
  renderControls();
  openOnboarding(true);
}

boot();
