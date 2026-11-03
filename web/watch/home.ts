// Home: invitations, the public watch parties, your private rooms, and creating a room.
import { api, ApiError, errorMessage, type CreatedRoom, type LevelInfo, type ModerationLevel, type Role } from './api.ts';
import { el, icon, plural, inHours, setRail, railIntro, toast, teamLogo } from './ui.ts';
import { openSheet, closeSheet, sheetActions } from './sheets.ts';
import { openNotificationSettings } from './push.ts';
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
}
interface MyRoom { id: string; name: string | null; status: string; role: Role; moderation_level: ModerationLevel; members: number; online: number }
interface Game { id: string; title: string; sport: string }
interface RoomLists { public_rooms: PublicRoom[]; my_rooms: MyRoom[]; matches: Game[] }

// A fan found by handle or name, or one of the labelled demo friends (GET /api/users/search, /api/users/demo).
interface FoundUser { id: string; handle: string; name: string | null; teams: string[]; demo: boolean }

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

  const bell = el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Alert settings', onclick: () => openNotificationSettings(ctx.config) }, icon('bell'));
  const menu = el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Menu', onclick: () => openMenu(ctx) }, icon('dots'));

  view.replaceChildren(
    el('div', { class: 'masthead' },
      el('header', { class: 'top' },
        el('div', { class: 'top-title' },
          el('b', { class: 'brand', text: 'Huddle' }),
          el('span', { class: 'top-sub', text: `Hi ${ctx.me.display_name || ctx.me.handle} · @${ctx.me.handle}` })),
        bell, menu)),
    el('div', { class: 'scroll-body', id: 'home-body' },
      invites, live, mine,
      el('p', { class: 'fine center', text: 'Match data is a simulated replay (demo data), not a live feed.' })),
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
      el('p', { class: 'card-meta', text: `@${inv.inviter_handle} invited you${inv.match_title ? ` · ${inv.match_title} (simulated replay)` : ''} · ${LEVEL_NAMES[inv.moderation_level] || 'Balanced'} moderation · ${inHours(inv.expires_at)}` }),
      el('div', { class: 'card-actions' }, decline, accept), err));
  }
}

// Only rooms for live or scheduled matches are listed; rooms of finished matches are not.
const matchStatus = (status: string) => (status === 'live' ? 'Live · simulated replay' : 'Starts when the first fan joins');

const SPORT_LABEL: Partial<Record<string, string>> = { cricket: 'Cricket · T20', f1: 'Formula 1', basketball: 'Basketball · NBA', hockey: 'Ice hockey · NHL' };
const SPORT_TAG: Partial<Record<string, string>> = { f1: 'F1', basketball: 'NBA', hockey: 'NHL' };

function renderLive(ctx: ReadyCtx, section: HTMLElement, rooms: RoomLists) {
  section.replaceChildren(el('h2', { class: 'section-title', id: 'h-live', text: 'Public watch parties' }));
  const pub = rooms.public_rooms;
  if (!pub.length) {
    section.append(el('p', { class: 'empty', text: 'No public watch party right now.' }));
    return;
  }
  for (const room of pub) {
    const full = Boolean(room.full) && !room.joined;
    const go = el('button', { type: 'button', class: 'btn primary small', text: room.joined ? 'Open' : full ? 'Full' : 'Join', disabled: full });
    const err = el('p', { class: 'form-error', role: 'alert' });
    go.addEventListener('click', async () => {
      go.disabled = true;
      try {
        if (!room.joined) await api.post(`/api/rooms/${room.id}/join`);
        ctx.navigate(`#/room/${room.id}`);
      } catch (e) {
        err.textContent = errorMessage(e);
        go.disabled = e instanceof ApiError && e.code === 'room_full';
        if (e instanceof ApiError && e.code === 'room_full') go.textContent = 'Full';
      }
    });
    const seats = room.max_members ? `${room.members}/${room.max_members}` : plural(room.members, 'member');
    section.append(el('article', { class: 'card public-card' },
      el('div', { class: 'fixture-row' },
        room.sport === 'cricket' || !room.sport
          ? [teamLogo('MI'), el('b', { class: 'fixture-name', text: room.match_title || 'Match' }), teamLogo('CSK')]
          : [el('span', { class: 'sport-tag', text: SPORT_TAG[room.sport] || room.sport }), el('b', { class: 'fixture-name', text: room.match_title || 'Match' })],
        el('span', { class: `status-pill ${room.match_status === 'live' ? 'live' : ''}`, text: matchStatus(room.match_status) })),
      el('p', { class: 'card-sport', text: `${SPORT_LABEL[room.sport] || 'Cricket'} · simulated game` }),
      el('h3', { class: 'card-h', text: room.name }),
      el('p', { class: 'card-meta' },
        room.full ? el('b', { class: 'full-tag', text: `Full · ${seats}` }) : `${seats}${room.max_members ? ' members' : ''}`,
        ` · ${room.online} online · `, el('span', { class: 'managed' }, icon('shield'), 'Moderation managed by Huddle')),
      el('div', { class: 'card-actions' }, go), err));
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
  const s = openSheet({ title: ctx.me.display_name || ctx.me.handle });
  const backing = backingLine(ctx);
  s.body.append(
    el('p', { class: 'lede', text: `@${ctx.me.handle}` }),
    ...(backing ? [el('p', { class: 'fine', text: backing })] : []),
    el('p', { class: 'fine', text: `Account ID: ${ctx.me.id}` }),
    el('div', { class: 'menu-list' },
      el('button', { type: 'button', class: 'menu-item', text: 'Alert settings', onclick: () => openNotificationSettings(ctx.config) }),
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

export function friendPicker({ excludeIds = new Set(), onChange }: { excludeIds?: Set<string>; onChange?: (ids: string[]) => void }) {
  const selected: Map<string, FoundUser> = new Map();
  const input = el('input', { id: 'friend-search', type: 'search', placeholder: 'Search by handle or name', autocomplete: 'off', 'aria-describedby': 'friend-hint' });
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
    } }, el('b', { text: `@${u.handle}` }), el('span', { text: u.name || '' }),
    u.demo ? el('small', { class: 'demo-tag', text: 'Demo' }) : null,
    u.teams?.length ? el('small', { text: u.teams.join(' · ') }) : null));

  // With an empty search box, offer the labelled demo friends so the invite flow can be tried alone.
  let demo: FoundUser[] = [];
  let hidden: Set<string> = new Set();
  const offered = (u: FoundUser) => !excludeIds.has(u.id) && !hidden.has(u.id);
  const showDemo = () => {
    const users = demo.filter(offered);
    results.replaceChildren(...(users.length
      ? [el('li', { class: 'results-head', text: 'Demo friends (no one signs in as them, so their invites stay pending)' }), ...users.map(userItem)]
      : []));
  };
  api.get('/api/users/demo').then((r: { users: FoundUser[] }) => {
    demo = r.users || [];
    if (input.value.trim().length < 2) showDemo();
  }).catch(() => {});

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { seq += 1; showDemo(); return; }
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
      el('label', { for: 'friend-search', text: 'Invite friends' }), input,
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
  // One simulated game per sport: pick which one the room watches.
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
  const own = el('input', { type: 'checkbox', id: 'own-replay', checked: true });
  follow.addEventListener('change', () => { own.disabled = !follow.checked; });
  const ai = el('input', { type: 'checkbox', id: 'ai-on', checked: true });
  const levels = levelChooser(ctx.config.moderation.levels, 'balanced', 'create-level');
  const picker = friendPicker({ excludeIds: new Set([ctx.me.id]) });
  const create = el('button', { type: 'submit', class: 'btn primary', text: 'Create and enter' });
  const form = el('form', { class: 'sheet-form', novalidate: '' },
    el('div', { class: 'field' }, el('label', { for: 'room-name', text: 'Room name' }), name),
    pickMatch,
    match ? el('label', { class: 'toggle-row', for: 'follow-match' }, follow,
      el('span', {}, followTitle, el('small', { text: 'Simulated replay (demo data). Scoreboard, play by play, big-moment alerts, #threads and rules help in the room.' }))) : null,
    match ? el('label', { class: 'toggle-row sub', for: 'own-replay' }, own,
      el('span', {}, el('b', { text: 'Control the replay yourself' }), el('small', { text: 'Your room gets its own copy: start it when friends arrive, pause, play at 0.5x or 2x, or jump to big moments. Off: follow the shared replay with the public watch party.' }))) : null,
    el('fieldset', { class: 'field' }, el('legend', { text: 'Moderation' }), levels.node,
      el('p', { class: 'field-hint strong', text: 'Mandatory safety protections stay on at every level: threats, hate, sexual harassment and sharing personal details are always blocked.' })),
    el('label', { class: 'toggle-row', for: 'ai-on' }, ai,
      el('span', {}, el('b', { text: 'AI Co-host' }), el('small', { text: 'Reads recent messages in this room only, to answer @huddle questions, catch members up and suggest polls.' }))),
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
        ...(follow.checked && match ? { own_replay: own.checked } : {}),
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
