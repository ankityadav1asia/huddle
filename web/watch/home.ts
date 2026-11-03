// Home: invitations, the public watch parties, your private rooms, and creating a room.
import { api, ApiError, errorMessage, type CreatedRoom, type LevelInfo, type ModerationLevel, type Role } from './api.ts';
import { el, icon, plural, inHours, setRail, railIntro, toast, teamLogo } from './ui.ts';
import { openSheet, closeSheet, sheetActions } from './sheets.ts';
import type { ReadyCtx } from './app.ts';

// GET /api/me/invitations: pending invitations to private rooms, which always have a moderation level.
interface Invitation { id: string; room_name: string | null; inviter_handle: string; match_title: string | null; moderation_level: ModerationLevel; expires_at: string }

// GET /api/rooms: the public watch parties (one per sport), your private rooms and the games a new room can follow.
interface PublicRoom {
  id: string;
  name: string | null;
  sport: string;
  match_title: string;
  match_status: string;
  members: number;
  max_members: number;
  online: number;
  joined: boolean;
  full: boolean;
  score: { line: string; sub: string | null; note: string | null } | null; // a live game's scoreboard
}
interface MyRoom { id: string; name: string | null; status: string; role: Role; moderation_level: ModerationLevel; members: number; online: number }
interface Game { id: string; title: string; sport: string }
interface RoomLists { public_rooms: PublicRoom[]; my_rooms: MyRoom[]; matches: Game[] }

// A fan found by username (GET /api/users/search).
interface FoundUser { id: string; handle: string; teams: string[] }

let refreshTimer = 0;

export function leaveHome() {
  clearInterval(refreshTimer);
}

export const LEVEL_NAMES = { relaxed: 'Relaxed', balanced: 'Balanced', strict: 'Strict' };

export async function renderHome(ctx: ReadyCtx) {
  leaveHome();
  setRail(railIntro());
  const view = document.getElementById('view');
  if (!view) return;
  const invites = el('section', { class: 'home-section', 'aria-labelledby': 'h-invites' });
  const live = el('section', { class: 'home-section', 'aria-labelledby': 'h-live' });
  const mine = el('section', { class: 'home-section', 'aria-labelledby': 'h-mine' });
  const create = el('button', { type: 'button', class: 'btn primary', text: 'Create a private room' });
  let data: RoomLists | null = null; // the /api/rooms response, once loaded
  create.addEventListener('click', () => openCreateRoom(ctx, data));

  const menu = el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Menu', onclick: () => openMenu(ctx) }, icon('dots'));

  view.replaceChildren(
    el('div', { class: 'masthead' },
      el('header', { class: 'top' },
        el('div', { class: 'top-title' },
          el('b', { class: 'brand', text: 'Huddle' }),
          el('span', { class: 'top-sub', text: `Hi @${ctx.me.handle}` })),
        menu)),
    el('div', { class: 'scroll-body', id: 'home-body' }, invites, live, mine),
    el('div', { class: 'bottom-bar' }, create),
  );
  live.append(el('div', { class: 'skeleton' }), el('div', { class: 'skeleton' }));

  const load = async () => {
    try {
      const [rooms, inv]: [RoomLists, { invitations: Invitation[] }] = await Promise.all([api.get('/api/rooms'), api.get('/api/me/invitations')]);
      if (!document.contains(live)) return;
      data = rooms;
      renderInvites(ctx, invites, inv.invitations, load);
      renderLive(ctx, live, rooms);
      renderMine(ctx, mine, rooms.my_rooms);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return ctx.signedOut();
      if (document.contains(live)) live.replaceChildren(el('p', { class: 'empty', text: errorMessage(err) }));
    }
  };
  await load();
  refreshTimer = setInterval(() => { if (!document.hidden) load(); }, 15000);
}

function renderInvites(ctx: ReadyCtx, section: HTMLElement, invitations: Invitation[], reload: () => void) {
  section.replaceChildren();
  section.hidden = !invitations.length;
  if (!invitations.length) return;
  section.append(el('h2', { class: 'section-title', id: 'h-invites', text: `Invitations (${invitations.length})` }));
  for (const inv of invitations) {
    const accept = el('button', { type: 'button', class: 'btn primary small', text: 'Accept' });
    const decline = el('button', { type: 'button', class: 'btn small', text: 'Decline' });
    const err = el('p', { class: 'form-error', role: 'alert' });
    accept.addEventListener('click', async () => {
      accept.disabled = decline.disabled = true;
      try {
        const r = await api.post(`/api/invitations/${inv.id}/accept`);
        ctx.navigate(`#/room/${r.room_id}`);
      } catch (e) {
        err.textContent = errorMessage(e);
        setTimeout(reload, 1500);
      }
    });
    decline.addEventListener('click', async () => {
      accept.disabled = decline.disabled = true;
      try { await api.post(`/api/invitations/${inv.id}/decline`); } catch (e) { err.textContent = errorMessage(e); }
      reload();
    });
    section.append(el('article', { class: 'card invite-card' },
      el('p', { class: 'card-kicker', text: 'Private watch party' }),
      el('h3', { class: 'card-h', text: inv.room_name }),
      el('p', { class: 'card-meta', text: `@${inv.inviter_handle} invited you${inv.match_title ? ` · ${inv.match_title}` : ''} · ${LEVEL_NAMES[inv.moderation_level] || 'Balanced'} moderation · ${inHours(inv.expires_at)}` }),
      el('div', { class: 'card-actions' }, decline, accept), err));
  }
}

const SPORT_LABEL: Partial<Record<string, string>> = { cricket: 'Cricket · T20', f1: 'Formula 1', basketball: 'Basketball', hockey: 'Ice hockey' };
const SPORT_TAG: Partial<Record<string, string>> = { f1: 'F1', basketball: 'NBA', hockey: 'NHL' };

// Joining a public watch party (or opening one you are in); a full room says so where it was tapped.
async function enter(ctx: ReadyCtx, room: PublicRoom, control: HTMLButtonElement, err: HTMLElement) {
  control.disabled = true;
  try {
    if (!room.joined) await api.post(`/api/rooms/${room.id}/join`);
    ctx.navigate(`#/room/${room.id}`);
  } catch (e) {
    err.textContent = errorMessage(e);
    control.disabled = e instanceof ApiError && e.code === 'room_full';
  }
}

// One card per public watch party: the sport and its status, the game, a live game's score, then who is in and Join.
function renderLive(ctx: ReadyCtx, section: HTMLElement, rooms: RoomLists) {
  section.replaceChildren(el('h2', { class: 'section-title', id: 'h-live', text: 'Public watch parties' }));
  if (!rooms.public_rooms.length) {
    section.append(el('p', { class: 'empty', text: 'No public watch party right now.' }));
    return;
  }
  for (const room of rooms.public_rooms) {
    const live = room.match_status === 'live';
    const full = room.full && !room.joined;
    const err = el('p', { class: 'form-error', role: 'alert' });
    const go = el('button', { type: 'button', class: 'btn primary small', text: room.joined ? 'Open' : full ? 'Full' : 'Join', disabled: full });
    go.addEventListener('click', () => enter(ctx, room, go, err));
    const s = live ? room.score : null;
    // Where the teams have logos, the logos are the title (the name stays for screen readers).
    const logos = room.sport === 'cricket' || !room.sport;
    section.append(el('article', { class: 'card pub-card' },
      el('div', { class: 'pub-top' },
        el('span', { class: 'pub-mark' }, logos ? null : el('span', { class: 'sport-tag', text: SPORT_TAG[room.sport] || room.sport }),
          el('span', { class: 'card-sport', text: SPORT_LABEL[room.sport] || 'Cricket' })),
        el('span', { class: `status-pill${live ? ' live' : ''}`, text: live ? '● Live' : 'Not started' })),
      logos
        ? el('h3', { class: 'card-h pub-logos' }, el('span', { class: 'sr-only', text: room.match_title || 'Match' }),
          teamLogo('MI'), el('span', { class: 'pub-v', 'aria-hidden': 'true', text: 'v' }), teamLogo('CSK'))
        : el('h3', { class: 'card-h', text: room.match_title || 'Match' }),
      s ? el('p', { class: 'pub-score' }, el('b', { text: s.line }), s.sub ? el('span', { text: s.sub }) : null, s.note ? el('em', { text: s.note }) : null) : null,
      el('div', { class: 'pub-foot' },
        el('p', { class: 'card-meta' },
          el('span', { text: live ? `${room.members}/${room.max_members} members · ${room.online} online` : full ? 'Full' : 'Starts when the first fan joins' }),
          el('span', { class: 'managed' }, icon('shield'), 'Moderated by Huddle')),
        go),
      err));
  }
}

function renderMine(ctx: ReadyCtx, section: HTMLElement, rooms: MyRoom[]) {
  section.replaceChildren(el('h2', { class: 'section-title', id: 'h-mine', text: 'Your private rooms' }));
  if (!rooms.length) {
    section.append(el('p', { class: 'empty', text: 'No private rooms yet. Create one and invite friends.' }));
    return;
  }
  const list = el('ul', { class: 'room-list' });
  for (const r of rooms) {
    const ended = r.status !== 'active';
    const label = el('span', { class: 'room-main' },
      el('b', { text: r.name || 'Ended watch party' }),
      el('small', { text: ended ? 'Ended · messages are no longer available' : `${plural(r.members, 'member')} · ${r.online} online · ${LEVEL_NAMES[r.moderation_level] || 'Balanced'} moderation` }));
    const badge = el('span', { class: `role-badge ${r.role}`, text: r.role === 'owner' ? 'OWNER' : r.role === 'admin' ? 'ADMIN' : 'MEMBER' });
    const item = ended
      ? el('div', { class: 'room-row ended', 'aria-disabled': 'true' }, label, el('span', { class: 'status-pill', text: 'Ended' }))
      : el('button', { type: 'button', class: 'room-row', onclick: () => ctx.navigate(`#/room/${r.id}`) }, label, badge);
    list.append(el('li', {}, item));
  }
  section.append(list);
}

// "Cricket: Chennai Super Kings (Dhoni, Bumrah) · F1: Ferrari": what you back in each sport you answered for.
function backingLine(ctx: ReadyCtx) {
  return (ctx.config.sports || []).filter((s) => ctx.me.sports?.[s.sport]).map((s) => {
    const { team, picks } = ctx.me.sports[s.sport];
    const names = picks.map((p) => s.players.find((x) => x.name === p)?.short || p);
    return `${s.label}: ${team ? s.teams.find((t) => t.code === team)?.name || team : 'no team'}${names.length ? ` (${names.join(', ')})` : ''}`;
  }).join(' · ');
}

function openMenu(ctx: ReadyCtx) {
  const s = openSheet({ title: `@${ctx.me.handle}` });
  const backing = backingLine(ctx);
  s.body.append(
    ...(backing ? [el('p', { class: 'fine', text: backing })] : []),
    el('p', { class: 'fine', text: `Account ID: ${ctx.me.id}` }),
    el('div', { class: 'menu-list' },
      el('button', { type: 'button', class: 'menu-item', text: 'Edit profile', onclick: () => { closeSheet(); ctx.editProfile(); } }),
      ctx.me.is_moderator ? el('a', { class: 'menu-item', href: '/mod', text: 'Moderation queue' }) : null,
      signOutButton(ctx)),
  );
}

// Guest profiles have no password to sign back in with, so signing out asks for a second, explicit click.
function signOutButton(ctx: ReadyCtx) {
  let armed = false;
  const b = el('button', { type: 'button', class: 'menu-item danger', text: 'Sign out' });
  b.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      b.textContent = `Sign out and lose @${ctx.me.handle}? Tap again to confirm`;
      return;
    }
    b.disabled = true;
    try { await api.post('/api/auth/logout'); } catch { /* signed out locally either way */ }
    closeSheet();
    ctx.signedOut();
  });
  return b;
}

export function friendPicker({ excludeIds = new Set(), onChange, label = 'Invite friends' }: { excludeIds?: Set<string>; onChange?: (ids: string[]) => void; label?: string }) {
  const selected: Map<string, FoundUser> = new Map();
  const input = el('input', { id: 'friend-search', type: 'search', placeholder: 'Search by username', autocomplete: 'off', 'aria-describedby': 'friend-hint' });
  const results = el('ul', { class: 'search-results', 'aria-live': 'polite' });
  const chips = el('div', { class: 'selected-chips' });
  let timer = 0;
  let seq = 0;
  const renderChips = () => {
    chips.replaceChildren(...[...selected.values()].map((u) => {
      const x = el('button', { type: 'button', class: 'chip selected', 'aria-label': `Remove @${u.handle}` }, `@${u.handle}`, icon('close'));
      x.addEventListener('click', () => { selected.delete(u.id); renderChips(); onChange?.([...selected.keys()]); });
      return x;
    }));
  };
  const userItem = (u: FoundUser) => el('li', {},
    el('button', { type: 'button', class: 'result-btn', 'aria-pressed': String(selected.has(u.id)), onclick: (e) => {
      if (selected.has(u.id)) selected.delete(u.id); else selected.set(u.id, u);
      e.currentTarget.setAttribute('aria-pressed', String(selected.has(u.id)));
      renderChips();
      onChange?.([...selected.keys()]);
    } }, el('b', { text: `@${u.handle}` }),
    u.teams?.length ? el('small', { text: u.teams.join(' · ') }) : null));

  let hidden: Set<string> = new Set();
  const offered = (u: FoundUser) => !excludeIds.has(u.id) && !hidden.has(u.id);

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { seq += 1; results.replaceChildren(); return; }
    timer = setTimeout(async () => {
      const mineSeq = ++seq;
      try {
        const r: { users: FoundUser[] } = await api.get(`/api/users/search?q=${encodeURIComponent(q)}`);
        if (mineSeq !== seq) return;
        const users = r.users.filter(offered);
        results.replaceChildren(...(users.length ? users.map(userItem)
          : [el('li', { class: 'empty small', text: 'No fans found with that handle.' })]));
      } catch (err) {
        results.replaceChildren(el('li', { class: 'empty small', text: errorMessage(err) }));
      }
    }, 250);
  });
  return {
    node: el('div', { class: 'friend-picker' },
      el('label', { for: 'friend-search', text: label }), input,
      el('p', { class: 'field-hint', id: 'friend-hint', text: 'Up to 10 at a time. They get an invitation they can accept or decline.' }),
      chips, results),
    ids: () => [...selected.keys()],
    // People with a pending invitation: not offered again, and dropped from the selection, until it is revoked.
    hide: (ids: string[]) => {
      hidden = new Set(ids);
      for (const id of hidden) selected.delete(id);
      renderChips();
      onChange?.([...selected.keys()]);
      input.dispatchEvent(new Event('input')); // re-list suggestions or search results without them
    },
  };
}

export function levelChooser(levels: LevelInfo[], current: ModerationLevel, name = 'level') {
  const wrap = el('div', { class: 'choice-list', role: 'radiogroup', 'aria-label': 'Moderation level' });
  for (const l of levels) {
    const id = `${name}-${l.id}`;
    const radio = el('input', { type: 'radio', name, id, value: l.id, checked: l.id === current });
    wrap.append(el('label', { class: 'choice', for: id }, radio,
      el('span', {}, el('b', {}, LEVEL_NAMES[l.id], l.id === 'balanced' ? el('em', { text: 'Recommended' }) : null), el('small', { text: l.description.replace(/^Recommended\.\s*/, '') }))));
  }
  return { node: wrap, value: () => wrap.querySelector<HTMLInputElement>('input:checked')?.value };
}

function openCreateRoom(ctx: ReadyCtx, data: RoomLists | null) {
  const s = openSheet({ title: 'Create a private room', lede: 'Invite friends, pick how strict the chat should be, and watch together.' });
  const error = el('p', { class: 'form-error', role: 'alert' });
  const name = el('input', { id: 'room-name', maxlength: '40', required: true, placeholder: 'e.g. Chepauk crew' });
  const matches = data?.matches || [];
  let match: Game | undefined = matches[0];
  const followTitle = el('b', { text: match ? `Follow ${match.title}` : '' });
  // One game per sport: pick which one the room watches.
  const pickMatch = matches.length > 1 ? el('fieldset', { class: 'field' }, el('legend', { text: 'Game' }),
    el('div', { class: 'choice-list', role: 'radiogroup', 'aria-label': 'Game' }, matches.map((m, i) => {
      const radio = el('input', { type: 'radio', name: 'create-match', id: `create-match-${i}`, value: m.id, checked: i === 0 });
      radio.addEventListener('change', () => {
        match = m;
        followTitle.textContent = `Follow ${m.title}`;
      });
      return el('label', { class: 'choice', for: `create-match-${i}` }, radio, el('span', {}, el('b', { text: m.title }), el('small', { text: SPORT_LABEL[m.sport] || m.sport })));
    }))) : null;
  const follow = el('input', { type: 'checkbox', id: 'follow-match', checked: Boolean(match) });
  const ai = el('input', { type: 'checkbox', id: 'ai-on', checked: true });
  const levels = levelChooser(ctx.config.moderation.levels, 'balanced', 'create-level');
  const picker = friendPicker({ excludeIds: new Set([ctx.me.id]) });
  const create = el('button', { type: 'submit', class: 'btn primary', text: 'Create and enter' });
  const form = el('form', { class: 'sheet-form', novalidate: '' },
    el('div', { class: 'field' }, el('label', { for: 'room-name', text: 'Room name' }), name),
    pickMatch,
    match ? el('label', { class: 'toggle-row', for: 'follow-match' }, follow,
      el('span', {}, followTitle, el('small', { text: 'Live scorecard, Match Centre, big-moment alerts, #threads and Dream Bot in the room.' }))) : null,
    el('fieldset', { class: 'field' }, el('legend', { text: 'Moderation' }), levels.node,
      el('p', { class: 'field-hint strong', text: 'Mandatory safety protections stay on at every level: threats, hate, sexual harassment and sharing personal details are always blocked.' })),
    el('label', { class: 'toggle-row', for: 'ai-on' }, ai,
      el('span', {}, el('b', { text: 'AI Co-host' }), el('small', { text: 'Explains big moments, suggests polls and answers questions nobody else does, reading recent messages in this room only.' }))),
    picker.node,
    error,
    sheetActions(el('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: closeSheet }), create));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!name.value.trim()) {
      error.textContent = 'Give the room a name.';
      name.focus();
      return;
    }
    create.disabled = true;
    error.textContent = '';
    try {
      const r: CreatedRoom = await api.post('/api/rooms', {
        name: name.value,
        match_id: follow.checked && match ? match.id : null,
        moderation_level: levels.value(),
        ai_enabled: ai.checked,
        invitee_ids: picker.ids(),
      });
      closeSheet();
      const missed = r.invitations.filter((i) => i.result !== 'invited');
      if (missed.length) toast(`${plural(missed.length, 'invitation')} could not be sent.`);
      ctx.navigate(`#/room/${r.room_id}`);
    } catch (err) {
      error.textContent = errorMessage(err);
      create.disabled = false;
    }
  });
  s.body.append(form);
}
