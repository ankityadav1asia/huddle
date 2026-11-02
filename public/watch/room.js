// The watch party room: realtime feed (long-poll), composer with the message rate limit, match intelligence,
// AI Co-host actions and the member/settings sheets. Everything shown comes from the server, which
// re-authorises every request; this view only renders and never decides who may see what.
import { api, serverNow, newKey } from './api.js';
import { el, icon, aiLabel, initials, teamClass, teamLogo, clock, clockSeconds, ago, plural, toast, setRail, railIntro } from './ui.js';
import { openSheet, closeSheet, sheetActions, confirmSheet } from './sheets.js';
import { openNotificationSettings, pushPrompt } from './push.js';
import { friendPicker, levelChooser } from './home.js';

const LEVEL_NAMES = { relaxed: 'Relaxed', balanced: 'Balanced', strict: 'Strict' };
const ROLE_LABEL = { owner: 'OWNER', admin: 'ADMIN' };
const REPORT_REASONS = [
  ['harassment', 'Harassment or bullying'], ['hate', 'Hate speech'], ['threat', 'Threat or violence'],
  ['spam', 'Spam'], ['personal_info', 'Sharing personal details'], ['sexual', 'Sexual content'],
  ['misinformation', 'Wrong match information'], ['other', 'Something else'],
];
const MAX_ITEMS = 300;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

let R = null;

// Converts a server timestamp to this device's clock (the API tracks the offset from the Date header).
const toLocal = (ts) => new Date(ts).getTime() - (serverNow() - Date.now());

const seenKey = (id) => `huddle:seen:${id}`;
function rememberSeen(state) {
  try { if (state.cursor) localStorage.setItem(seenKey(state.id), String(state.cursor)); } catch { /* storage may be unavailable */ }
}
function lastSeen(id) {
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
  document.removeEventListener('visibilitychange', state.onVis);
  rememberSeen(state);
}

export async function renderRoom(ctx, roomId) {
  leaveRoom();
  const state = {
    id: roomId, ctx, active: true, abort: new AbortController(), items: new Map(), seqSeen: new Set(),
    members: new Map(), presence: { online: [], active: [] }, cursor: 0, cooldownUntil: 0, replyTo: null,
    match: null, matchFetchedAt: 0, matchRev: null, matchBusy: false, matchAgain: false, stick: true,
    hiddenAt: 0, hiddenCursor: 0, catchupSince: null, loopToken: 0, els: {},
    crowdOn: crowdPref(), crowdSeen: new Set(), crowdTimers: new Set(), crowdN: 0,
  };
  R = state;
  const view = document.getElementById('view');
  view.replaceChildren(
    el('div', { class: 'masthead' }, el('header', { class: 'top' }, backButton(state), el('div', { class: 'top-title' }, el('b', { class: 'room-title', text: 'Loading…' })))),
    el('div', { class: 'scroll-body' }, el('div', { class: 'skeleton' }), el('div', { class: 'skeleton' }), el('div', { class: 'skeleton' })),
  );
  await bootstrap(state);
}

function backButton(state) {
  const b = el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Back to home', onclick: () => state.ctx.navigate('#/') });
  b.append(icon('back'));
  return b;
}

async function bootstrap(state) {
  let boot;
  try {
    boot = await api.get(`/api/rooms/${state.id}`, { signal: state.abort.signal });
  } catch (err) {
    if (err?.name === 'AbortError' || state !== R) return;
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
  buildRoom(state);
  for (const item of boot.items) upsertItem(state, item.type, item.data);
  scrollToBottom(state);
  const seen = lastSeen(state.id);
  if (seen && state.cursor - seen >= 3) {
    state.catchupSince = seen;
    showBanner(state, `Welcome back. ${plural(state.cursor - seen, 'update')} since your last visit.`);
  }
  rememberSeen(state);
  if (state.room.match) refreshMatch(state);
  else renderRail(state);
  state.ticker = setInterval(() => tick(state), 1000);
  tick(state);
  state.onVis = () => onVisibility(state);
  document.addEventListener('visibilitychange', state.onVis);
  state.loopToken += 1;
  loop(state, state.loopToken);
}

// ---------------------------------------------------------------- layout
function buildRoom(state) {
  const room = state.room;
  const els = state.els;
  els.title = el('b', { class: 'room-title', text: room.name || 'Watch party' });
  els.typeBadge = el('span', { class: 'type-pill' });
  els.online = el('span', { class: 'online-count' });
  const people = el('button', { type: 'button', class: 'fans-btn', 'aria-label': 'Members', onclick: () => openMembers(state) });
  els.memberCount = el('span', { class: 'fans-count' });
  people.append(icon('people'), els.memberCount);
  const more = el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Room settings', onclick: () => openSettings(state) });
  more.append(icon('dots'));
  els.score = el('button', { type: 'button', class: 'score score-btn', 'aria-label': 'Open match intelligence', hidden: !room.match, onclick: () => openMatchSheet(state) },
    el('div', { class: 'skeleton' }));
  els.replayBar = el('div', { class: 'replay-bar', role: 'group', 'aria-label': 'Replay controls', hidden: true });

  els.cohostLabel = el('span', { class: 'cohost-label' });
  els.cohostText = el('p', { class: 'pulse-text' });
  els.reconnect = el('span', { class: 'reconnect-pill', hidden: true, text: 'Reconnecting…' });
  const catchBtn = el('button', { type: 'button', class: 'catchup-btn', text: 'Catch me up', onclick: () => openCatchup(state) });
  els.pollBtn = el('button', { type: 'button', class: 'catchup-btn ghost', text: 'Suggest a poll', hidden: !room.match, onclick: () => suggestPoll(state) });

  els.feed = el('div', { class: 'feed', role: 'log', 'aria-live': 'polite', 'aria-label': 'Watch party messages' });
  els.notice = el('div', { class: 'feed-notice' });
  els.feed.append(els.notice);
  els.scroll = el('div', { class: 'chat-scroll' }, els.feed);
  els.banner = el('div', { class: 'banner', hidden: true });
  els.newPill = el('button', { type: 'button', class: 'new-pill', hidden: true, text: 'New messages', onclick: () => { state.stick = true; scrollToBottom(state); } });
  els.scroll.addEventListener('scroll', () => {
    const s = els.scroll;
    state.stick = s.scrollHeight - s.scrollTop - s.clientHeight < 60;
    if (state.stick) els.newPill.hidden = true;
  });

  els.input = el('input', { id: 'say', maxlength: '500', placeholder: 'Say something, or ask @huddle', 'aria-label': 'Message the room', autocomplete: 'off', enterkeyhint: 'send' });
  els.send = el('button', { type: 'submit', class: 'send', 'aria-label': 'Send' });
  els.send.append(icon('send'));
  els.reply = el('div', { class: 'reply-chip', hidden: true });
  els.error = el('div', { class: 'send-error', role: 'alert', hidden: true });
  els.notice2 = el('p', { class: 'send-notice', hidden: true });
  els.cooldown = el('div', { class: 'cooldown', hidden: true }, el('span', { class: 'cooldown-text' }), el('span', { class: 'cooldown-bar' }, el('i')));
  const form = el('form', { class: 'composer', autocomplete: 'off' }, els.input, els.send);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submitMessage(state);
  });

  document.getElementById('view').replaceChildren(
    el('div', { class: 'masthead' },
      el('header', { class: 'top' }, backButton(state),
        el('div', { class: 'top-title' }, els.title, el('span', { class: 'top-sub' }, els.typeBadge, els.online)),
        people, more),
      els.score, els.replayBar),
    els.cohost = el('section', { class: 'pulse cohost', 'aria-label': 'AI Co-host' },
      el('div', { class: 'pulse-head' }, els.cohostLabel, els.reconnect),
      els.cohostText,
      el('div', { class: 'pulse-foot cohost-actions' }, catchBtn, els.pollBtn)),
    el('section', { class: 'chat' }, els.scroll, els.banner, els.newPill),
    el('div', { class: 'composer-wrap' }, el('div', { class: 'composer-status', 'aria-live': 'polite' }, els.reply, els.error, els.notice2, els.cooldown), form),
  );
  applyRoomInfo(state);
  // Offer big-moment notifications once (permission is only requested if they tap Turn on).
  pushPrompt(state.ctx).then((card) => {
    if (card && state === R && els.cohost.isConnected) els.cohost.after(card);
  }).catch(() => {});
}

function applyRoomInfo(state) {
  const room = state.room;
  const els = state.els;
  els.title.textContent = room.name || 'Watch party';
  els.typeBadge.textContent = room.room_type === 'public' ? 'Public' : `Private · ${LEVEL_NAMES[room.moderation.level] || 'Balanced'}`;
  els.cohostLabel.replaceChildren(aiLabel(room.ai_enabled ? 'AI Co-host' : 'Match moments'));
  if (!state.lastInsight) {
    els.cohostText.textContent = room.ai_enabled
      ? (room.match ? 'Watching the match with you. Ask @huddle anything about it.' : 'Ask @huddle anything about the room.')
      : 'Big match moments appear here. The AI Co-host is off in this room.';
  }
  const mod = room.moderation;
  els.notice.replaceChildren(
    el('p', {}, el('b', { text: room.ai_enabled ? 'AI Co-host. ' : 'AI Co-host off. ' }), room.ai_notice),
    room.match ? el('p', {}, el('b', { text: 'Simulated fans. ' }), 'A scripted crowd reacts to the simulated replay. They are labelled, are not real people, and can be hidden in room settings.') : null,
    el('p', {}, el('b', { text: 'Disappearing chat. ' }), room.retention_notice),
    el('p', {}, el('b', { text: room.room_type === 'public' ? 'Public room. ' : `${LEVEL_NAMES[mod.level] || ''} moderation. ` }), mod.notice),
  );
  updatePresence(state, state.presence);
}

function updatePresence(state, presence) {
  state.presence = presence || state.presence;
  const n = state.presence.online.length;
  // Real people online; the simulated fans are counted separately so nobody takes them for real viewers.
  const fans = state.room?.match && state.crowdOn ? state.ctx.config.crowd?.fans : 0;
  if (state.els.online) state.els.online.textContent = ` · ${n} online${fans ? ` · ${fans} simulated fans` : ''}`;
  if (state.els.memberCount) state.els.memberCount.textContent = String(state.members.size);
  state.membersSheet?.refresh?.();
}

function setReconnecting(state, on) {
  if (state.els.reconnect) state.els.reconnect.hidden = !on;
}

function scrollToBottom(state) {
  const s = state.els.scroll;
  if (s) s.scrollTop = s.scrollHeight;
  if (state.els.newPill) state.els.newPill.hidden = true;
}

function showBanner(state, text) {
  const b = state.els.banner;
  if (!b) return;
  const go = el('button', { type: 'button', text: 'Catch me up', onclick: () => { b.hidden = true; openCatchup(state); } });
  const x = el('button', { type: 'button', class: 'x', 'aria-label': 'Dismiss', onclick: () => { b.hidden = true; } });
  x.append(icon('close'));
  b.replaceChildren(el('span', { text }), go, x);
  b.hidden = false;
}

function onVisibility(state) {
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

// ---------------------------------------------------------------- realtime
async function loop(state, token) {
  let failures = 0;
  while (state.active && state === R && token === state.loopToken) {
    try {
      const vis = document.hidden ? 'hidden' : 'visible';
      // Sending the match version we have lets the server answer as soon as the next ball is in.
      const rev = state.matchRev != null ? `&rev=${encodeURIComponent(state.matchRev)}` : '';
      const r = await api.get(`/api/rooms/${state.id}/events?after=${state.cursor}&wait=1&vis=${vis}${rev}`, { signal: state.abort.signal });
      if (!state.active || state !== R || token !== state.loopToken) return;
      failures = 0;
      setReconnecting(state, false);
      if (r.room?.status && r.room.status !== 'active') {
        renderEnded(state, { ...state.room, ...r.room });
        return;
      }
      if (r.reset) {
        resetRoom(state);
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
      }
    } catch (err) {
      if (err?.name === 'AbortError' || !state.active || state !== R) return;
      if (err.status === 401) { state.ctx.signedOut(); return; }
      if (err.status === 403 || err.status === 404) { renderProblem(state, err); return; }
      if (err.status === 410) { renderEnded(state, state.room || {}); return; }
      failures += 1;
      setReconnecting(state, true);
      await sleep([1000, 2000, 5000][Math.min(failures - 1, 2)]);
    }
  }
}

function resetRoom(state) {
  const ctx = state.ctx;
  const id = state.id;
  leaveRoom();
  renderRoom(ctx, id);
}

async function refreshRoomInfo(state) {
  try {
    const boot = await api.get(`/api/rooms/${state.id}`, { signal: state.abort.signal });
    if (state !== R) return;
    if (boot.room.status !== 'active') { renderEnded(state, boot.room); return; }
    state.room = boot.room;
    state.members = new Map(boot.members.map((m) => [m.id, m]));
    applyRoomInfo(state);
    renderRail(state);
  } catch { /* the next poll will try again */ }
}

function applyEvents(state, events) {
  for (const ev of events) {
    if (state.seqSeen.has(ev.seq)) continue;
    state.seqSeen.add(ev.seq);
    if (ev.type === 'message' || ev.type === 'message_update') upsertItem(state, 'message', ev.data);
    else if (ev.type === 'poll') upsertItem(state, 'poll', ev.data);
    else if (ev.type === 'insight') {
      const isNew = !state.items.has(`insight:${ev.data.id}`);
      upsertItem(state, 'insight', ev.data);
      if (isNew && (ev.data.priority === 'high' || ev.data.priority === 'medium')) {
        toast([el('b', { text: `${ev.data.label}: ` }), factText(ev.data)], { ms: 8000, tone: ev.data.priority });
      }
    } else if (ev.type === 'member') applyMember(state, ev);
    else if (ev.type === 'room') refreshRoomInfo(state);
  }
}

function applyMember(state, ev) {
  const m = ev.data;
  const prev = state.members.get(m.id);
  let line = '';
  if (m.status === 'active') {
    state.members.set(m.id, { id: m.id, handle: m.handle, name: m.name, team: m.team, role: m.role });
    if (!prev) line = `@${m.handle} joined`;
    else if (prev.role !== m.role) line = `@${m.handle} is now ${m.role === 'admin' ? 'an admin' : 'a member'}`;
  } else if (prev) {
    state.members.delete(m.id);
    line = `@${m.handle} ${m.status === 'removed' ? 'was removed' : 'left'}`;
  }
  if (line) upsertItem(state, 'sys', { id: `m${ev.seq}`, seq: ev.seq, text: line });
  updatePresence(state, state.presence);
}

// ---------------------------------------------------------------- feed items
// Insight facts come from the feed; older ones may still start with "<label>:", so the label is never shown twice.
// Also drops a leading tag that only repeats a word of the label ("Big wicket" + "WICKET: ..."); tags that add
// meaning ("DROPPED:", "DRS:") stay.
function factText(insight) {
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

// The Co-host strip shows the latest important match moment (high or medium priority): label once, then the text.
function setCohostLine(state, insight) {
  if (!['high', 'medium'].includes(insight.priority)) return;
  if (state.lastInsight && (state.lastInsight.seq ?? 0) > (insight.seq ?? 0)) return;
  state.lastInsight = insight;
  state.els.cohostText.replaceChildren(el('b', { text: `${insight.label}: ` }), insight.explanation || factText(insight));
}

function upsertItem(state, type, data) {
  if (type === 'insight') setCohostLine(state, data);
  const key = `${type}:${data.id}`;
  const node = renderItem(state, type, data);
  const existing = state.items.get(key);
  if (existing) {
    existing.data = data;
    if (data.seq != null) existing.seq = data.seq;
    existing.node.replaceWith(node);
    existing.node = node;
    return;
  }
  const entry = { key, type, data, node, seq: data.seq ?? Number.MAX_SAFE_INTEGER };
  state.items.set(key, entry);
  const later = [...state.items.values()].filter((e) => e !== entry && e.seq > entry.seq && e.node.isConnected).sort((a, b) => a.seq - b.seq)[0];
  if (later) state.els.feed.insertBefore(node, later.node);
  else state.els.feed.append(node);
  trimFeed(state);
  if (state.stick) scrollToBottom(state);
  else if (state.els.newPill) state.els.newPill.hidden = false;
}

function removeItem(state, key) {
  const entry = state.items.get(key);
  if (!entry) return;
  entry.node.remove();
  state.items.delete(key);
}

function trimFeed(state) {
  if (state.items.size <= MAX_ITEMS) return;
  const oldest = [...state.items.values()].sort((a, b) => a.seq - b.seq).slice(0, state.items.size - MAX_ITEMS);
  for (const e of oldest) removeItem(state, e.key);
}

function renderItem(state, type, data) {
  if (type === 'crowd') return renderCrowd(data);
  if (type === 'message') return data.sender?.type === 'ai' ? renderAiMessage(state, data) : renderMessage(state, data);
  if (type === 'pending') return renderPending(state, data);
  if (type === 'poll') return renderPoll(state, data);
  if (type === 'insight') return renderInsight(data);
  return el('p', { class: 'sys-line', text: data.text });
}

function avatar(sender) {
  return el('span', { class: `avatar ${teamClass(sender.team)}`, 'aria-hidden': 'true', text: initials(sender.handle) });
}

function replyPreview(reply) {
  return el('p', { class: 'reply-preview' }, el('b', { text: `@${reply.handle || 'someone'}` }), reply.excerpt ? ` ${reply.excerpt}` : ' (message not available)');
}

function reactionRow(state, m) {
  if (m.status !== 'visible' || !m.reactions?.length) return null;
  return el('div', { class: 'reactions' }, m.reactions.map((r) => el('button', {
    type: 'button', class: `react-btn${r.mine ? ' mine' : ''}`, 'aria-pressed': String(r.mine), 'aria-label': `${r.emoji} ${r.count}${r.mine ? ', you reacted' : ''}`,
    onclick: () => react(state, m, r.emoji, !r.mine),
  }, `${r.emoji} ${r.count}`)));
}

function actionsButton(state, m) {
  const b = el('button', { type: 'button', class: 'msg-more', 'aria-label': 'Message actions', onclick: () => openMessageActions(state, m) });
  b.append(icon('dots'));
  return b;
}

function renderMessage(state, m) {
  const member = state.members.get(m.sender.id);
  const row = el('div', { class: `msg${m.mine ? ' you' : ''}${m.status !== 'visible' ? ` ${m.status}` : ''}`, dataset: { id: m.id } });
  const meta = el('div', { class: 'msg-meta' }, el('b', { class: 'handle', text: m.mine ? 'You' : `@${m.sender.handle}` }));
  if (ROLE_LABEL[member?.role]) meta.append(el('span', { class: 'badge role', text: ROLE_LABEL[member.role] }));
  if (m.sender.team) meta.append(el('span', { class: `badge ${teamClass(m.sender.team)}`, text: m.sender.team }));
  meta.append(el('time', { class: 'msg-time', datetime: m.created_at, text: clock(m.created_at) }));
  const body = el('div', { class: 'msg-body' }, meta);
  if (m.reply_to) body.append(replyPreview(m.reply_to));
  if (m.status === 'removed' || m.text == null) body.append(el('p', { class: 'msg-text removed', text: 'Message removed by a moderator.' }));
  else body.append(el('p', { class: 'msg-text', text: m.text }));
  if (m.status === 'held') body.append(el('p', { class: 'msg-flag', text: 'Held for review · only you can see this' }));
  if (m.answer_state === 'ai_unavailable') body.append(el('p', { class: 'msg-note', text: 'The Co-host could not answer right now. Try again in a minute.' }));
  else if (['pending', 'ai_claimed'].includes(m.answer_state) && /(^|\s)@huddle\b/i.test(m.text || '')) body.append(el('p', { class: 'msg-note live', text: 'Co-host is answering…' }));
  const reactions = reactionRow(state, m);
  if (reactions) body.append(reactions);
  row.append(avatar(m.sender), body);
  if (m.status === 'visible') {
    row.append(actionsButton(state, m));
    body.addEventListener('click', (e) => { if (!e.target.closest('button, a')) openMessageActions(state, m); });
  }
  return row;
}

// ---------------------------------------------------------------- simulated fans
// The scripted crowd that reacts to the simulated replay. The server derives the lines from the match feed, the
// same for everyone in this room, and each one is shown when it is due. They are labelled, never stored with the
// chat, and can be hidden on this device in room settings.
const CROWD_KEY = 'huddle:crowd';
const CROWD_LATE_MS = 20000; // a line this overdue (opening the room, coming back) is skipped, not replayed

function crowdPref() {
  try { return localStorage.getItem(CROWD_KEY) !== 'off'; } catch { return true; }
}

function setCrowd(state, on) {
  state.crowdOn = on;
  try { localStorage.setItem(CROWD_KEY, on ? 'on' : 'off'); } catch { /* storage may be unavailable */ }
  updatePresence(state);
  if (!on) {
    for (const t of state.crowdTimers) clearTimeout(t);
    state.crowdTimers.clear();
    for (const key of [...state.items.keys()]) if (key.startsWith('crowd:')) removeItem(state, key);
  }
}

function scheduleCrowd(state, lines = []) {
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

function renderCrowd(c) {
  return el('div', { class: 'msg crowd' },
    el('span', { class: `avatar ${teamClass(c.team)}`, 'aria-hidden': 'true', text: initials(c.fan) }),
    el('div', { class: 'msg-body' },
      el('div', { class: 'msg-meta' },
        el('b', { class: 'handle', text: c.fan }),
        el('span', { class: `badge ${teamClass(c.team)}`, text: c.team }),
        el('span', { class: 'badge sim', text: 'Simulated fan' })),
      el('p', { class: 'msg-text', text: c.text })));
}

function aiFootnote(ai) {
  if (!ai) return 'AI-generated';
  if (ai.type === 'insufficient_data') return 'Not in the match data, so the Co-host will not guess.';
  if (ai.type === 'decline') return 'AI-generated';
  const g = ai.grounding || {};
  const parts = ['From verified match data (simulated replay)'];
  if (g.data_as_of) parts.push(`as of ${clockSeconds(g.data_as_of)}`);
  if (g.stale) parts.push('may be out of date');
  return parts.join(' · ');
}

function renderAiMessage(state, m) {
  const head = el('div', { class: 'ai-head' }, aiLabel('AI Co-host'));
  if (m.reply_to?.handle) head.append(el('span', { class: 'ai-reply', text: `replying to @${m.reply_to.handle}` }));
  const box = el('div', { class: 'ai-note ai-msg', dataset: { id: m.id } }, head);
  if (m.status === 'removed' || m.text == null) box.append(el('p', { class: 'ai-text removed', text: 'Message removed by a moderator.' }));
  else box.append(el('p', { class: 'ai-text', text: m.text }), el('p', { class: 'sub', text: aiFootnote(m.ai) }));
  const reactions = reactionRow(state, m);
  if (reactions) box.append(reactions);
  if (m.status === 'visible') box.append(actionsButton(state, m));
  return box;
}

function renderPending(state, p) {
  const row = el('div', { class: `msg you pending${p.failed ? ' failed' : ''}` },
    avatar({ handle: state.ctx.me.handle, team: state.ctx.me.team }),
    el('div', { class: 'msg-body' },
      el('div', { class: 'msg-meta' }, el('b', { class: 'handle', text: 'You' }), el('span', { class: 'msg-time', text: p.failed ? 'Not sent' : 'Sending…' })),
      el('p', { class: 'msg-text', text: p.text }),
      p.failed ? el('button', { type: 'button', class: 'link-btn', text: 'Retry', onclick: () => deliver(state, p) }) : null));
  return row;
}

function renderInsight(i) {
  const box = el('div', { class: `insight ${i.priority}` },
    el('div', { class: 'insight-head' }, el('span', { class: 'insight-label', text: i.label }), el('span', { class: 'insight-meta', text: `Match moment · ${clock(i.occurred_at)}` })),
    el('p', { class: 'insight-fact', text: factText(i) }));
  if (i.explanation) box.append(el('p', { class: 'insight-ai' }, aiLabel('AI explanation'), el('span', { text: i.explanation })));
  box.append(el('p', { class: 'insight-src', text: 'Verified from the match feed · simulated replay (demo data)' }));
  return box;
}

function renderPoll(state, p) {
  const total = p.options.reduce((a, o) => a + o.votes, 0);
  const winner = total ? p.options.reduce((best, o, i, all) => (o.votes > all[best].votes ? i : best), 0) : -1;
  const box = el('div', { class: 'poll', dataset: { id: p.id } },
    el('div', { class: 'poll-head' }, aiLabel(p.source === 'ai' ? 'AI poll' : 'Huddle poll')),
    el('p', { class: 'poll-q', text: p.question }));
  p.options.forEach((o, i) => {
    const pct = total ? Math.round((o.votes / total) * 100) : 0;
    const fill = el('span', { class: 'fill' });
    fill.style.width = `${pct}%`;
    box.append(el('button', {
      type: 'button', class: `poll-opt${p.my_vote === i ? ' mine' : ''}${!p.open && i === winner ? ' winner' : ''}`,
      disabled: !p.open, 'aria-pressed': String(p.my_vote === i), onclick: () => vote(state, p, i),
    }, fill, el('span', { text: o.label }), el('span', { class: 'pct', text: `${pct}%` })));
  });
  const timer = el('span', { class: 'poll-timer', dataset: { closes: p.closes_at, open: String(p.open) } });
  timer.textContent = p.open ? 'Open' : 'Closed';
  box.append(el('div', { class: 'poll-foot' }, el('span', { text: plural(total, 'vote') }), timer));
  if (!p.open && winner >= 0) box.append(el('p', { class: 'poll-result' }, el('em', { text: `${Math.round((p.options[winner].votes / total) * 100)}%` }), ` picked ${p.options[winner].label}`));
  return box;
}

// ---------------------------------------------------------------- per-second updates
function tick(state) {
  if (state !== R) return;
  // Capped at the rule itself: the server-clock estimate is only accurate to about a second.
  const remaining = Math.min(state.ctx.config.chat.cooldown_seconds, Math.ceil((state.cooldownUntil - Date.now()) / 1000));
  const cd = state.els.cooldown;
  if (cd) {
    if (remaining > 0) {
      cd.hidden = false;
      cd.querySelector('.cooldown-text').textContent = `Next message in ${remaining}s · one message every ${state.ctx.config.chat.cooldown_seconds}s`;
      cd.querySelector('.cooldown-bar i').style.width = `${Math.max(0, Math.min(100, (remaining / state.ctx.config.chat.cooldown_seconds) * 100))}%`;
      state.els.send.disabled = true;
    } else {
      cd.hidden = true;
      state.els.send.disabled = false;
    }
  }
  for (const t of state.els.feed?.querySelectorAll('.poll-timer[data-open="true"]') || []) {
    const left = Math.ceil((new Date(t.dataset.closes).getTime() - serverNow()) / 1000);
    t.textContent = left > 0 ? `Closes in ${left}s` : 'Closing…';
  }
  if (state.match && Date.now() % 5000 < 1000) renderFreshness(state);
}

// ---------------------------------------------------------------- sending
function setError(state, message, extra = null) {
  const e = state.els.error;
  e.replaceChildren(el('span', { text: message }), extra);
  e.hidden = !message;
}

function setNotice(state, message) {
  state.els.notice2.textContent = message || '';
  state.els.notice2.hidden = !message;
}

function setReply(state, m) {
  state.replyTo = m;
  const chip = state.els.reply;
  if (!m) {
    chip.hidden = true;
    chip.replaceChildren();
    return;
  }
  const x = el('button', { type: 'button', class: 'x', 'aria-label': 'Cancel reply', onclick: () => setReply(state, null) });
  x.append(icon('close'));
  chip.replaceChildren(el('span', {}, 'Replying to ', el('b', { text: m.sender.type === 'ai' ? '@huddle' : `@${m.sender.handle}` })), x);
  chip.hidden = false;
  state.els.input.focus();
}

function submitMessage(state) {
  const text = state.els.input.value.trim();
  if (!text) return;
  if (state.cooldownUntil > Date.now()) {
    setError(state, `One message every ${state.ctx.config.chat.cooldown_seconds} seconds. Hold that thought.`);
    return;
  }
  const pending = { id: newKey(), key: null, text, reply_to: state.replyTo?.id || null, failed: false };
  pending.key = pending.id;
  state.els.input.value = '';
  setReply(state, null);
  setError(state, '');
  setNotice(state, '');
  state.stick = true;
  upsertItem(state, 'pending', pending);
  deliver(state, pending);
}

async function deliver(state, pending) {
  pending.failed = false;
  upsertItem(state, 'pending', pending);
  try {
    const r = await api.post(`/api/rooms/${state.id}/messages`, { client_msg_id: pending.key, text: pending.text, ...(pending.reply_to ? { reply_to: pending.reply_to } : {}) });
    if (state !== R) return;
    removeItem(state, `pending:${pending.id}`);
    upsertItem(state, 'message', r.message);
    if (r.status === 'held') setNotice(state, r.notice || 'Your message is waiting for a quick human review before others can see it.');
    else if (r.notice) setNotice(state, r.notice);
    if (r.cooldown_until) state.cooldownUntil = toLocal(r.cooldown_until);
    tick(state);
  } catch (err) {
    if (state !== R) return;
    if (err.status === 0) {
      pending.failed = true;
      upsertItem(state, 'pending', pending);
      setError(state, 'Not sent. Check your connection and retry.');
      return;
    }
    removeItem(state, `pending:${pending.id}`);
    if (!state.els.input.value) state.els.input.value = pending.text;
    if (err.code === 'message_rejected') {
      const review = err.moderation_event_id ? el('button', { type: 'button', class: 'link-btn', text: 'Request a review', onclick: async (e) => {
        e.target.disabled = true;
        try {
          await api.post('/api/appeals', { moderation_event_id: err.moderation_event_id, note: '' });
          setError(state, 'Review requested. A moderator will take a look.');
        } catch (e2) {
          setError(state, e2.message);
        }
      } }) : null;
      setError(state, `Not sent. ${err.message}`, review);
    } else if (err.status === 429) {
      const until = err.cooldown_until ? toLocal(err.cooldown_until) : Date.now() + (err.retry_after || 30) * 1000;
      state.cooldownUntil = Math.max(state.cooldownUntil, until);
      setError(state, err.message);
      tick(state);
    } else if (err.status === 410) {
      renderEnded(state, state.room);
    } else {
      setError(state, err.message);
    }
  }
}

async function react(state, m, emoji, on) {
  try {
    await api.put(`/api/rooms/${state.id}/messages/${m.id}/reactions`, { emoji, on });
  } catch (err) {
    toast(err.message);
  }
}

async function vote(state, p, option) {
  try {
    await api.post(`/api/rooms/${state.id}/polls/${p.id}/vote`, { option });
    upsertItem(state, 'poll', { ...p, my_vote: option, options: p.options.map((o, i) => ({ ...o, votes: o.votes + (i === option ? 1 : 0) - (i === p.my_vote ? 1 : 0) })) });
  } catch (err) {
    toast(err.message);
  }
}

async function suggestPoll(state) {
  const b = state.els.pollBtn;
  b.disabled = true;
  try {
    const r = await api.post(`/api/rooms/${state.id}/polls/suggest`, { client_request_id: newKey() });
    toast(r.source === 'ai' ? 'The Co-host posted a poll.' : 'Poll posted (AI unavailable, so Huddle used a standard poll).');
  } catch (err) {
    toast(err.message);
  } finally {
    setTimeout(() => { b.disabled = false; }, 3000);
  }
}

// ---------------------------------------------------------------- match intelligence
async function refreshMatch(state) {
  if (!state.room?.match) return;
  if (state.matchBusy) { state.matchAgain = true; return; }
  state.matchBusy = true;
  try {
    const snap = await api.get(`/api/rooms/${state.id}/match`, { signal: state.abort.signal });
    if (state !== R) return;
    state.match = snap;
    state.matchFetchedAt = Date.now();
    renderScore(state);
    renderReplayBar(state);
    renderRail(state);
    scheduleCrowd(state, snap.crowd);
    if (state.matchSheet?.isOpen()) state.matchSheet.render();
  } catch (err) {
    if (err?.name === 'AbortError' || state !== R) return;
    state.els.score?.replaceChildren(el('p', { class: 'score-error', text: 'Match data is unavailable right now.' }));
  } finally {
    state.matchBusy = false;
    if (state.matchAgain && state === R) {
      state.matchAgain = false;
      refreshMatch(state);
    }
  }
}

const liveAge = (state) => (state.match?.freshness?.age_seconds == null ? null : state.match.freshness.age_seconds + (Date.now() - state.matchFetchedAt) / 1000);

function freshnessText(state) {
  const m = state.match;
  if (!m) return '';
  if (m.match.status === 'scheduled') return m.replay?.own ? 'Simulated replay · ready to start' : 'Simulated replay · starting soon';
  if (m.match.status === 'completed') return 'Simulated replay · match finished';
  if (m.replay?.paused) return 'Simulated replay · paused';
  const age = liveAge(state);
  if (age == null) return 'Simulated replay · waiting for the first ball';
  return `Simulated replay · updated ${ago(age)}${m.freshness.stale ? ' · data may be stale' : ''}`;
}

function renderFreshness(state) {
  for (const n of document.querySelectorAll('[data-freshness]')) n.textContent = freshnessText(state);
}

const ballDot = (s) => el('span', { class: `ball-dot r${s}`, text: s === '0' ? '•' : s });

function needBlock(s) {
  const need = el('span', { class: 'score-need' });
  if (s.result) need.append(el('b', { text: s.result }));
  else if (s.chase_won) need.append(el('b', { text: `${s.batting} have won` }));
  else need.append('Need ', el('b', { text: String(s.need_runs) }), ' off ', el('b', { text: String(s.need_balls) }), el('br'), `Target ${s.target} · RRR ${s.rrr ?? '-'}`);
  return need;
}

function renderScore(state) {
  const snap = state.match;
  const s = snap.score;
  const team = snap.match.teams.find((t) => t.code === s.batting) || { code: s.batting };
  const line = el('div', { class: 'score-line' },
    el('span', { class: 'team-chip' }, teamLogo(team), s.batting),
    el('span', { class: 'score-runs', text: `${s.runs}/${s.wickets}` }),
    el('span', { class: 'score-overs', text: `(${s.overs})` }),
    needBlock(s));
  const batters = s.batters.map((b) => `${b.short}${b.on_strike ? '*' : ''} ${b.runs} (${b.balls})`).join('  ·  ');
  const row1 = el('div', { class: 'score-row' }, el('span', { class: 'score-batters', text: batters }), el('span', { class: 'this-over' }, s.this_over.map(ballDot)));
  const row2 = el('div', { class: 'score-row' },
    el('span', {}, s.bowler ? ['Bowling ', el('b', { text: s.bowler.short }), ` ${s.bowler.figures}`] : ''),
    el('span', { class: 'replay-tag', 'data-freshness': '', text: freshnessText(state) }));
  state.els.score.replaceChildren(line, row1, row2);
  state.els.score.hidden = false;
}

function table(headers, rows) {
  return el('table', { class: 'mi-table' },
    el('thead', {}, el('tr', {}, headers.map((h) => el('th', { scope: 'col', text: h })))),
    el('tbody', {}, rows.map((r) => el('tr', {}, r.map((c, i) => (i === 0 ? el('th', { scope: 'row', text: c }) : el('td', { text: c })))))));
}

function matchPanel(state, { withControls = true } = {}) {
  const snap = state.match;
  if (!snap) return el('p', { class: 'empty', text: 'Loading match data…' });
  const s = snap.score;
  const own = snap.replay?.own;
  const status = snap.match.status === 'live' ? (snap.replay?.paused ? 'PAUSED' : 'LIVE · SIMULATED') : snap.match.status === 'scheduled' ? (own ? 'READY' : 'STARTING SOON') : 'FINISHED';
  const wrap = el('div', { class: 'mi' },
    el('div', { class: 'mi-head' },
      el('b', { class: 'mi-title', text: snap.match.title }),
      el('span', { class: `status-pill ${snap.match.status === 'live' && !snap.replay?.paused ? 'live' : ''}`, text: status })),
    el('p', { class: 'mi-fresh', 'data-freshness': '', text: freshnessText(state) }),
    el('p', { class: 'mi-src', text: `${snap.match.source_label}. Every number here comes from the feed, never from the AI.` }),
    el('p', { class: 'mi-score' }, el('b', { text: `${s.batting} ${s.runs}/${s.wickets}` }), ` (${s.overs} ov) · ${s.result || (s.chase_won ? `${s.batting} have won` : `need ${s.need_runs} off ${s.need_balls}`)}`),
    el('p', { class: 'mi-meta', text: `Target ${s.target} · CRR ${s.crr ?? '-'} · RRR ${s.rrr ?? '-'} · ${s.first_innings}` }),
    withControls && own ? replayPanel(state) : null,
    withControls && !own ? el('p', { class: 'fine', text: 'Every room following this shared replay sees the same match. For a replay you can start, pause and jump yourself, create a private room with its own replay.' }) : null,
    el('h3', { text: 'Batting' }),
    table(['Batter', 'R', 'B', 'SR'], s.batters.map((b) => [`${b.name}${b.on_strike ? ' *' : ''}`, b.runs, b.balls, b.strike_rate ?? '-'])),
    el('p', { class: 'mi-meta', text: `Partnership ${s.partnership.runs} (${s.partnership.balls}) since the last wicket in the feed` }),
    el('h3', { text: 'Bowling' }),
    table(['Bowler', 'O-M-R-W', 'Econ'], s.bowling_card.map((b) => [b.name, b.figures, b.economy])),
    el('h3', { text: 'Fall of wickets' }),
    s.fall_of_wickets.length
      ? el('ul', { class: 'mi-list' }, s.fall_of_wickets.map((w) => el('li', { text: `${w.name} ${w.r} (${w.b}) ${w.how}${w.score ? ` · ${w.score}` : ''}${w.over ? `, ${w.over} ov` : ''}` })))
      : el('p', { class: 'mi-meta', text: 'No wickets yet.' }),
    el('p', { class: 'mi-meta', text: `In the replay feed so far: ${count(s.team_stats.fours_in_feed, 'four', 'fours')} · ${count(s.team_stats.sixes_in_feed, 'six', 'sixes')} · ${count(s.team_stats.dots_in_feed, 'dot ball', 'dot balls')} · ${count(s.team_stats.extras_in_feed, 'extra', 'extras')}` }),
    el('h3', { text: 'Ball by ball' }),
    snap.commentary.length
      ? el('ol', { class: 'commentary' }, snap.commentary.map((c) => el('li', {},
        el('span', { class: `over-tag${c.symbol ? ` r${c.symbol}` : ''}`, text: c.over || c.label || '•' }),
        el('span', { text: c.text }))))
      : el('p', { class: 'mi-meta', text: 'Commentary appears when the replay starts.' }));
  if (withControls && state.ctx.config.demo_controls && snap.moments?.length) {
    const status2 = el('p', { class: 'fine', role: 'status' });
    wrap.append(el('div', { class: 'demo-controls' },
      el('h3', { text: 'Demo controls (simulated replay)' }),
      el('p', { class: 'fine', text: 'Jump the replay to a big moment. This moves the match for every room following it; skipped balls are filled in without alerts.' }),
      el('div', { class: 'controls-row' }, snap.moments.map((m) => el('button', { type: 'button', class: 'ctl', text: m.label, onclick: async (e) => {
        e.target.disabled = true;
        try {
          const r = await api.post(`/api/demo/matches/${snap.match.id}/jump`, { moment: m.id });
          status2.textContent = `Jumped to ${r.jumped_to}.`;
          refreshMatch(state);
        } catch (err) {
          status2.textContent = err.message;
          e.target.disabled = false;
        }
      } }))),
      status2));
  }
  return wrap;
}

// ---------------------------------------------------------------- the room's own replay
// A private room can run its own copy of the simulated replay. Its owner and admins control it from the bar
// under the score and from the match panel; everyone else sees what the host did (waiting to start, paused).
async function replayAction(state, body, btn, status) {
  btn.disabled = true;
  try {
    const r = await api.post(`/api/rooms/${state.id}/replay`, body);
    if (status) status.textContent = r.jumped_to ? `Jumped to ${r.jumped_to}.` : '';
    refreshMatch(state);
  } catch (err) {
    if (status) status.textContent = err.message;
    else toast(err.message);
    btn.disabled = false;
  }
}

function replayButtons(state, { compact = false, status = null } = {}) {
  const st = state.match.match.status;
  const rp = state.match.replay;
  const ctl = (text, body, extra = {}) => el('button', { type: 'button', class: 'ctl', text, ...extra, onclick: (e) => replayAction(state, body, e.currentTarget, status) });
  const main = st === 'scheduled' ? ctl('Start replay', { action: 'start' }, { class: 'ctl primary' })
    : st === 'completed' ? ctl('Watch again', { action: 'restart' }, { class: 'ctl primary' })
      : rp.paused ? ctl('Resume', { action: 'resume' }, { class: 'ctl primary' })
        : ctl('Pause', { action: 'pause' });
  const speeds = st === 'completed' ? [] : [1, 2].map((n) => (rp.speed === n
    ? el('button', { type: 'button', class: 'ctl', 'aria-pressed': 'true', 'aria-label': n === 1 ? 'Normal speed' : 'Double speed', text: `${n}x` })
    : ctl(`${n}x`, { action: 'speed', speed: n }, { 'aria-pressed': 'false', 'aria-label': n === 1 ? 'Normal speed' : 'Double speed' })));
  const more = compact
    ? el('button', { type: 'button', class: 'ctl', text: 'Moments', onclick: () => openMatchSheet(state) })
    : st === 'live' ? ctl('Restart', { action: 'restart' }) : null;
  return el('div', { class: 'controls-row' }, main, speeds, more);
}

function replayPanel(state) {
  const rp = state.match.replay;
  if (!rp.can_control) {
    return el('div', { class: 'demo-controls' }, el('h3', { text: 'This room\'s replay' }),
      el('p', { class: 'fine', text: 'This room has its own copy of the simulated replay. The room owner and admins start, pause, speed it up or jump it.' }));
  }
  const status = el('p', { class: 'fine', role: 'status' });
  return el('div', { class: 'demo-controls' },
    el('h3', { text: 'This room\'s replay' }),
    el('p', { class: 'fine', text: 'Your room has its own copy of the simulated replay, so only this room moves. Jumping ahead fills in the skipped balls without alerts; jumping back starts the replay again.' }),
    replayButtons(state, { status }),
    el('p', { class: 'ctl-label', text: 'Jump to a moment' }),
    el('div', { class: 'controls-row' }, rp.moments.map((m) => el('button', {
      type: 'button', class: 'ctl', text: m.label, title: m.passed ? 'Starts the replay again from here' : null,
      onclick: (e) => replayAction(state, { action: 'jump', moment: m.id }, e.currentTarget, status),
    }))),
    status);
}

function renderReplayBar(state) {
  const bar = state.els.replayBar;
  const snap = state.match;
  if (!bar || !snap) return;
  const rp = snap.replay;
  const st = snap.match.status;
  if (!rp?.own) {
    bar.hidden = true;
    return;
  }
  if (rp.can_control) {
    bar.replaceChildren(el('span', { class: 'replay-note', text: st === 'scheduled' ? 'Your replay is ready' : 'Your replay' }), replayButtons(state, { compact: true }));
    bar.hidden = false;
    return;
  }
  const note = st === 'scheduled' ? 'Waiting for the host to start the replay.' : st === 'live' && rp.paused ? 'The host paused the replay.' : '';
  bar.replaceChildren(el('span', { class: 'replay-note', text: note }));
  bar.hidden = !note;
}

function openMatchSheet(state) {
  if (!state.match) return;
  const s = openSheet({ title: 'Match intelligence' });
  state.matchSheet = { isOpen: s.isOpen, render: () => s.body.replaceChildren(matchPanel(state)) };
  state.matchSheet.render();
}

function renderRail(state) {
  if (state !== R) return;
  const room = state.room;
  if (!room) { setRail(railIntro()); return; }
  const mod = room.room_type === 'public' ? 'Moderation managed by Huddle' : `${LEVEL_NAMES[room.moderation.level]} moderation · safety protections always on`;
  setRail(
    el('p', { class: 'rail-kicker', text: room.room_type === 'public' ? 'Public watch party' : 'Private watch party' }),
    el('h1', { class: 'rail-title small', text: room.name }),
    el('ul', { class: 'rail-facts' },
      el('li', { text: mod }),
      el('li', { text: room.ai_enabled ? 'AI Co-host on: answers @huddle from verified match data' : 'AI Co-host off in this room' }),
      el('li', { text: `Messages disappear when the watch party ends` })),
    room.match ? el('section', { class: 'rail-section', 'aria-label': 'Match intelligence' }, el('p', { class: 'rail-h', text: 'Match intelligence' }), matchPanel(state)) : null,
  );
}

// ---------------------------------------------------------------- Catch Me Up
async function openCatchup(state) {
  const s = openSheet({ title: 'Catch me up' });
  const label = el('div');
  const slot = el('div', {}, el('div', { class: 'skeleton' }), el('div', { class: 'skeleton' }), el('div', { class: 'skeleton' }));
  s.body.append(label, slot);
  const since = state.catchupSince;
  try {
    const r = await api.post(`/api/rooms/${state.id}/catchup`, since != null ? { since_seq: since } : {});
    if (!s.isOpen()) return;
    state.catchupSince = null;
    rememberSeen(state);
    label.replaceChildren(aiLabel(r.source === 'ai' ? 'AI Co-host summary' : 'Summary from verified match data'));
    slot.replaceChildren(el('p', { class: 'catchup-headline', text: r.headline }));
    if (r.match_points?.length) slot.append(el('h3', { text: 'In the match' }), el('ul', { class: 'bullets' }, r.match_points.map((p) => el('li', { text: p }))));
    if (r.room_points?.length) slot.append(el('h3', { text: 'In the room' }), el('ul', { class: 'bullets' }, r.room_points.map((p) => el('li', { text: p }))));
    if (r.note) slot.append(el('p', { class: 'room-line', text: r.note }));
    slot.append(
      sheetActions(el('button', { type: 'button', class: 'btn primary', text: 'Back to the room', onclick: closeSheet })),
      el('p', { class: 'source', text: `${r.source_label}${r.data_as_of ? ` · data as of ${clockSeconds(r.data_as_of)}` : ''}${r.stale ? ' · may be out of date' : ''}. Only you see this summary.` }));
  } catch (err) {
    if (s.isOpen()) slot.replaceChildren(el('p', { class: 'form-error', text: err.message }));
  }
}

// ---------------------------------------------------------------- message actions and reports
function openMessageActions(state, m) {
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

function openReport(state, m) {
  const s = openSheet({ title: m.sender.type === 'ai' ? 'Report AI response' : 'Report message', lede: 'Reports go to Huddle moderators. The author is not told who reported them.' });
  const reasons = el('div', { class: 'choice-list', role: 'radiogroup', 'aria-label': 'Reason' }, REPORT_REASONS.map(([id, label], i) => el('label', { class: 'choice compact', for: `reason-${id}` },
    el('input', { type: 'radio', name: 'reason', id: `reason-${id}`, value: id, checked: i === 0 }), el('span', {}, el('b', { text: label })))));
  const note = el('textarea', { id: 'report-note', maxlength: '200', rows: '2', placeholder: 'Anything else? (optional)' });
  const error = el('p', { class: 'form-error', role: 'alert' });
  const submit = el('button', { type: 'button', class: 'btn primary', text: 'Send report' });
  submit.addEventListener('click', async () => {
    submit.disabled = true;
    try {
      const r = await api.post(`/api/rooms/${state.id}/messages/${m.id}/report`, { reason: reasons.querySelector('input:checked').value, ...(note.value.trim() ? { note: note.value.trim() } : {}) });
      if (!s.isOpen()) return;
      s.body.replaceChildren(el('p', { class: 'lede', text: r.hidden ? 'Thanks. Several members reported this, so it is hidden while a moderator reviews it.' : 'Thanks. A moderator will review it.' }),
        sheetActions(el('button', { type: 'button', class: 'btn primary', text: 'Done', onclick: closeSheet })));
    } catch (err) {
      error.textContent = err.message;
      submit.disabled = false;
    }
  });
  s.body.append(reasons, el('div', { class: 'field' }, el('label', { for: 'report-note', text: 'Note' }), note), error,
    sheetActions(el('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: closeSheet }), submit));
}

// ---------------------------------------------------------------- members and invitations
function openMembers(state) {
  const room = state.room;
  const manage = room.can_manage;
  const s = openSheet({ title: 'Members' });
  const lede = el('p', { class: 'lede' });
  const list = el('ul', { class: 'member-list' });
  const invites = el('div');
  s.body.append(lede, list, invites);
  const render = () => {
    if (!s.isOpen()) return;
    const online = new Set(state.presence.online);
    lede.textContent = `${plural(state.members.size, 'member')} · ${state.presence.online.length} online`;
    const order = { owner: 0, admin: 1, member: 2 };
    const members = [...state.members.values()].sort((a, b) => order[a.role] - order[b.role] || String(a.handle).localeCompare(String(b.handle)));
    list.replaceChildren(...members.map((m) => {
      const me = m.id === state.ctx.me.id;
      const actions = el('span', { class: 'member-actions' });
      if (room.room_type === 'private' && room.my_role === 'owner' && !me && m.role !== 'owner') {
        actions.append(el('button', { type: 'button', class: 'ctl', text: m.role === 'admin' ? 'Make member' : 'Make admin', onclick: async (e) => {
          e.target.disabled = true;
          try { await api.put(`/api/rooms/${state.id}/members/${m.id}/role`, { role: m.role === 'admin' ? 'member' : 'admin' }); } catch (err) { toast(err.message); }
          e.target.disabled = false;
        } }));
      }
      const canRemove = !me && m.role !== 'owner' && (room.my_role === 'owner' || (room.my_role === 'admin' && m.role === 'member'));
      if (canRemove) {
        actions.append(el('button', { type: 'button', class: 'ctl danger', text: 'Remove', onclick: async () => {
          if (!(await confirmSheet({ title: `Remove @${m.handle}?`, text: 'They lose access to this watch party straight away. They can be invited again later.', confirmLabel: 'Remove', danger: true }))) return;
          try { await api.del(`/api/rooms/${state.id}/members/${m.id}`); toast(`@${m.handle} was removed.`); } catch (err) { toast(err.message); }
        } }));
      }
      return el('li', { class: 'member-row' },
        el('span', { class: `online-dot${online.has(m.id) ? ' on' : ''}`, title: online.has(m.id) ? 'Online' : 'Away' }),
        el('span', { class: `avatar ${teamClass(m.team)}`, 'aria-hidden': 'true', text: initials(m.handle) }),
        el('span', { class: 'member-main' }, el('b', { text: me ? `@${m.handle} (you)` : `@${m.handle}` }), el('small', { text: `${m.name || ''}${online.has(m.id) ? ' · online' : ''}` })),
        ROLE_LABEL[m.role] ? el('span', { class: `role-badge ${m.role}`, text: ROLE_LABEL[m.role] }) : null,
        actions);
    }));
  };
  state.membersSheet = { refresh: render };
  render();
  if (room.room_type === 'private' && manage) loadInvites(state, s, invites);
  else if (room.room_type === 'public') invites.append(el('p', { class: 'fine', text: 'Anyone signed in can join a public watch party. Moderation is managed by Huddle.' }));
}

async function loadInvites(state, s, slot) {
  const results = el('p', { class: 'fine', role: 'status' });
  const picker = friendPicker({ excludeIds: new Set(state.members.keys()) });
  const invite = el('button', { type: 'button', class: 'btn primary', text: 'Send invitations' });
  const statusList = el('ul', { class: 'invite-list' });
  const refresh = async () => {
    try {
      const r = await api.get(`/api/rooms/${state.id}/invitations`);
      if (!s.isOpen()) return;
      picker.hide(r.invitations.filter((i) => i.status === 'pending').map((i) => i.user_id));
      statusList.replaceChildren(...(r.invitations.length ? r.invitations.map((i) => el('li', { class: 'invite-row' },
        el('span', { class: 'member-main' }, el('b', { text: `@${i.handle}` }), el('small', { text: i.display_name || '' })),
        el('span', { class: `status-pill inv-${i.status}`, text: i.status }),
        i.status === 'pending' ? el('button', { type: 'button', class: 'ctl', text: 'Revoke', onclick: async (e) => {
          e.target.disabled = true;
          try { await api.post(`/api/invitations/${i.id}/revoke`); } catch (err) { toast(err.message); }
          refresh();
        } }) : null)) : [el('li', { class: 'empty small', text: 'No invitations yet.' })]));
    } catch (err) {
      statusList.replaceChildren(el('li', { class: 'empty small', text: err.message }));
    }
  };
  invite.addEventListener('click', async () => {
    const ids = picker.ids();
    if (!ids.length) { results.textContent = 'Pick at least one person.'; return; }
    invite.disabled = true;
    try {
      const r = await api.post(`/api/rooms/${state.id}/invitations`, { invitee_ids: ids });
      const ok = r.invitations.filter((i) => i.result === 'invited').length;
      const other = r.invitations.length - ok;
      results.textContent = `${plural(ok, 'invitation')} sent${other ? `, ${other} skipped (already a member, already invited or room full)` : ''}.`;
      refresh();
    } catch (err) {
      results.textContent = err.message;
    }
    invite.disabled = false;
  });
  slot.append(el('h3', { text: 'Invite more friends' }), picker.node, invite, results, el('h3', { text: 'Invitations' }), statusList);
  refresh();
}

// ---------------------------------------------------------------- settings, leave and end
function openSettings(state) {
  const room = state.room;
  const s = openSheet({ title: 'Room settings' });
  const msg = el('p', { class: 'fine', role: 'status' });
  if (room.room_type === 'public') {
    s.body.append(el('h3', { text: 'Moderation' }), el('p', { class: 'notice-box' }, icon('shield'), 'Moderation and safety settings are managed by Huddle.'));
  } else if (room.can_manage) {
    const levels = levelChooser(state.ctx.config.moderation.levels, room.moderation.level, 'room-level');
    const save = el('button', { type: 'button', class: 'btn', text: 'Save moderation level', onclick: async () => {
      save.disabled = true;
      try {
        const r = await api.patch(`/api/rooms/${state.id}/settings`, { moderation_level: levels.value() });
        msg.textContent = `Moderation is now ${LEVEL_NAMES[r.moderation_level]}. It applies to the next message.`;
        refreshRoomInfo(state);
      } catch (err) {
        msg.textContent = err.message;
      }
      save.disabled = false;
    } });
    const ai = el('input', { type: 'checkbox', id: 'room-ai', checked: room.ai_enabled });
    ai.addEventListener('change', async () => {
      ai.disabled = true;
      try {
        await api.patch(`/api/rooms/${state.id}/settings`, { ai_enabled: ai.checked });
        msg.textContent = ai.checked ? 'AI Co-host is on.' : 'AI Co-host is off. Match moments still appear.';
        refreshRoomInfo(state);
      } catch (err) {
        ai.checked = !ai.checked;
        msg.textContent = err.message;
      }
      ai.disabled = false;
    });
    s.body.append(el('h3', { text: 'Moderation' }), levels.node, save,
      el('h3', { text: 'AI Co-host' }),
      el('label', { class: 'toggle-row', for: 'room-ai' }, ai, el('span', {}, el('b', { text: 'AI Co-host on' }), el('small', { text: 'Answers @huddle questions, catches members up and suggests polls, using this room\'s recent messages only.' }))),
      msg);
  } else {
    s.body.append(el('h3', { text: 'Moderation' }), el('p', { class: 'notice-box' }, el('b', { text: `${LEVEL_NAMES[room.moderation.level]}. ` }), room.moderation.description || ''),
      el('p', { class: 'fine', text: 'Only the owner or an admin can change room settings.' }));
  }
  const fans = el('input', { type: 'checkbox', id: 'room-crowd', checked: state.crowdOn });
  fans.addEventListener('change', () => setCrowd(state, fans.checked));
  s.body.append(
    el('p', { class: 'field-hint strong', text: 'Mandatory safety protections stay on at every level: threats, hate, sexual harassment and sharing personal details are always blocked.' }),
    room.match ? el('h3', { text: 'Simulated fans' }) : null,
    room.match ? el('label', { class: 'toggle-row', for: 'room-crowd' }, fans, el('span', {}, el('b', { text: 'Show simulated fans' }), el('small', { text: 'The scripted crowd that reacts to the simulated replay. They are not real people, and only this device hides them.' }))) : null,
    el('h3', { text: 'Privacy' }),
    el('p', { class: 'fine', text: room.ai_notice }),
    el('p', { class: 'fine', text: room.retention_notice }),
    el('div', { class: 'menu-list' },
      el('button', { type: 'button', class: 'menu-item', text: 'Alert settings', onclick: () => openNotificationSettings(state.ctx.config) }),
      room.my_role === 'owner' && room.room_type === 'private'
        ? el('button', { type: 'button', class: 'menu-item danger', text: 'End watch party', onclick: () => endParty(state) })
        : el('button', { type: 'button', class: 'menu-item danger', text: 'Leave room', onclick: () => leaveParty(state) })),
  );
}

async function endParty(state) {
  const ok = await confirmSheet({ title: 'End this watch party?', text: 'Everyone loses access to the chat right away, and messages are deleted from our servers within a day. This cannot be undone.', confirmLabel: 'End watch party', danger: true });
  if (!ok) return;
  try {
    await api.post(`/api/rooms/${state.id}/end`);
    renderEnded(state, state.room);
  } catch (err) {
    toast(err.message);
  }
}

async function leaveParty(state) {
  const ok = await confirmSheet({ title: 'Leave this room?', text: state.room.room_type === 'private' ? 'You will need a new invitation to come back.' : 'You can join the public watch party again any time.', confirmLabel: 'Leave', danger: true });
  if (!ok) return;
  try {
    await api.post(`/api/rooms/${state.id}/leave`);
    state.ctx.navigate('#/');
  } catch (err) {
    toast(err.message);
  }
}

// ---------------------------------------------------------------- terminal states
function renderEnded(state, room) {
  const ctx = state.ctx;
  if (R === state) leaveRoom();
  closeSheet();
  setRail(railIntro());
  document.getElementById('view').replaceChildren(
    el('div', { class: 'masthead' }, el('header', { class: 'top' }, backButton({ ctx }),
      el('div', { class: 'top-title' }, el('b', { class: 'room-title', text: room?.name || 'Watch party' }), el('span', { class: 'top-sub', text: 'Ended' })))),
    el('div', { class: 'scroll-body' },
      el('div', { class: 'card ended-card' },
        el('h2', { class: 'card-title', text: 'This watch party has ended.' }),
        el('p', { class: 'card-lede', text: 'Messages are no longer available to anyone, and they are deleted from our servers after the retention window.' }),
        el('button', { type: 'button', class: 'btn primary', text: 'Back to home', onclick: () => ctx.navigate('#/') }))),
  );
}

function renderProblem(state, err) {
  const ctx = state.ctx;
  const id = state.id;
  if (R === state) leaveRoom();
  if (err.status === 401) { ctx.signedOut(); return; }
  const body = el('div', { class: 'card ended-card' });
  if (err.code === 'join_required') {
    const join = el('button', { type: 'button', class: 'btn primary', text: 'Join the watch party' });
    const error = el('p', { class: 'form-error', role: 'alert' });
    join.addEventListener('click', async () => {
      join.disabled = true;
      try {
        await api.post(`/api/rooms/${id}/join`);
        renderRoom(ctx, id);
      } catch (e) {
        error.textContent = e.message;
        join.disabled = false;
      }
    });
    body.append(el('h2', { class: 'card-title', text: 'Join this public watch party' }),
      el('p', { class: 'card-lede', text: 'Moderation and safety settings are managed by Huddle.' }), join, error);
  } else {
    body.append(
      el('h2', { class: 'card-title', text: err.status === 404 ? 'Room not found' : err.status === 403 ? 'You cannot open this room' : 'Could not open the room' }),
      el('p', { class: 'card-lede', text: err.status === 404 ? 'It may be private, it may have ended, or the link may be wrong.' : err.message }),
      el('button', { type: 'button', class: 'btn primary', text: 'Back to home', onclick: () => ctx.navigate('#/') }));
  }
  setRail(railIntro());
  document.getElementById('view').replaceChildren(
    el('div', { class: 'masthead' }, el('header', { class: 'top' }, backButton({ ctx }), el('div', { class: 'top-title' }, el('b', { class: 'room-title', text: 'Watch party' })))),
    el('div', { class: 'scroll-body' }, body),
  );
}
