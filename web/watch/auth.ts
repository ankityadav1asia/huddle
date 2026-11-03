// Joining takes one tap: the server creates a guest profile with a username it picks (@fan_4821) and keeps this
// browser signed in with an HttpOnly session cookie. Edit profile changes the username and the teams and players
// someone backs in each sport.
import { api, errorMessage, type Config, type SportChoice, type SportInfo } from './api.ts';
import { el, setRail, railIntro, teamClass, type Child } from './ui.ts';
import type { Ctx } from './app.ts';

function shell(view: HTMLElement, subtitle: string, ...content: Child[]) {
  view.replaceChildren(
    el('div', { class: 'masthead' },
      el('header', { class: 'top' },
        el('div', { class: 'top-title' },
          el('b', { class: 'brand', text: 'Huddle' }),
          el('span', { class: 'top-sub', text: subtitle })))),
    el('div', { class: 'scroll-body' }, ...content),
  );
}

// New visitors: one button.
export function renderAuth(ctx: Ctx) {
  setRail(railIntro());
  const view = document.getElementById('view');
  if (!view) return;
  const error = el('p', { class: 'form-error', role: 'alert' });
  const join = el('button', { type: 'button', class: 'btn primary', text: 'Join Huddle' });
  join.addEventListener('click', async () => {
    join.disabled = true;
    error.textContent = '';
    try {
      ctx.signedIn((await api.post('/api/auth/guest', {})).user, false);
    } catch (err) {
      error.textContent = errorMessage(err);
      join.disabled = false;
    }
  });
  shell(view, 'Sports watch parties with friends',
    el('div', { class: 'card form-card' },
      el('h2', { class: 'card-title', text: 'Join the watch party' }),
      el('p', { class: 'card-lede', text: 'One tap, no name, phone number or password. Huddle gives you a username like @fan_4821; change it, and pick the teams you back, any time in Edit profile.' }),
      error, join),
    el('p', { class: 'fine center', text: 'Your profile lives in this browser. If you sign out or clear your browser data, it cannot be recovered.' }));
  join.focus();
}

// Signed-in users: Edit profile, and older profiles that have no username yet.
export function renderProfile(ctx: Ctx) {
  setRail(railIntro());
  const view = document.getElementById('view');
  if (!view) return;
  const error = el('p', { class: 'form-error', role: 'alert' });
  const handle = el('input', { id: 'handle', maxlength: '20', required: true, autocapitalize: 'off', spellcheck: 'false', value: ctx.me?.handle || '', 'aria-describedby': 'handle-hint' });
  const backing = sportPicker(ctx.config, ctx.me?.sports);
  const save = el('button', { type: 'submit', class: 'btn primary', text: 'Save' });
  const form = el('form', { class: 'card form-card', novalidate: '' },
    el('h2', { class: 'card-title', text: 'Your profile' }),
    el('p', { class: 'card-lede', text: 'Fans see your username and the teams and players you back.' }),
    el('div', { class: 'field' },
      el('label', { for: 'handle', text: 'Username' }),
      el('div', { class: 'phone-input' }, el('span', { class: 'cc', 'aria-hidden': 'true', text: '@' }), handle),
      el('p', { class: 'field-hint', id: 'handle-hint', text: '3–20 letters, numbers or underscores. Friends find you by this.' })),
    backing.node,
    error, save);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const h = handle.value.trim().replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9_]{3,20}$/.test(h)) {
      error.textContent = 'Usernames use 3–20 letters, numbers or underscores.';
      handle.focus();
      return;
    }
    save.disabled = true;
    error.textContent = '';
    try {
      ctx.signedIn((await api.put('/api/me/profile', { handle: h, sports: backing.value() })).user, false);
    } catch (err) {
      error.textContent = errorMessage(err);
      save.disabled = false;
    }
  });
  shell(view, 'Your profile', form);
  handle.focus();
}

// The team you back (or none) and up to three players in each sport, one sport at a time. A sport you leave alone
// is not sent, so the first room you watch it in asks once.
function sportPicker(config: Config | null, current: Record<string, SportChoice> | undefined) {
  const sports = config?.sports || [];
  const maxPicks = config?.max_picks || 3;
  const chosen = new Map<string, SportChoice>(Object.entries(current || {}).map(([sport, c]) => [sport, { team: c.team ?? null, picks: [...(c.picks || [])] }]));
  const answer = (sport: string) => chosen.get(sport) || chosen.set(sport, { team: null, picks: [] }).get(sport)!;
  const hint = el('p', { class: 'field-hint', id: 'picks-hint' });
  const panel = el('div', { class: 'sport-panel' });
  const marks = new Map<string, HTMLElement>(sports.map((s) => [s.sport, el('small')]));
  const markTab = (sport: string) => {
    const team = chosen.get(sport)?.team;
    marks.get(sport)!.className = team ? `badge ${teamClass(team)}` : '';
    marks.get(sport)!.textContent = team || '';
  };
  const tabs = sports.map((s) => el('button', { type: 'button', class: 'sport-tab', dataset: { sport: s.sport }, onclick: () => show(s) },
    s.label, marks.get(s.sport)));

  function show(s: SportInfo) {
    tabs.forEach((t) => t.setAttribute('aria-pressed', String(t.dataset.sport === s.sport)));
    hint.textContent = `Up to ${maxPicks} ${s.label} players. You can change them later in Edit profile.`;
    const isTeam = (code: string | undefined) => chosen.has(s.sport) && (chosen.get(s.sport)!.team ?? '') === code;
    const teamBtns = [...s.teams, { code: '', name: 'No team' }].map((t) => el('button', {
      type: 'button', class: 'team-opt', dataset: { team: t.code }, 'aria-pressed': String(isTeam(t.code)),
      onclick: () => {
        answer(s.sport).team = t.code || null;
        teamBtns.forEach((b) => b.setAttribute('aria-pressed', String(isTeam(b.dataset.team))));
        markTab(s.sport);
      },
    }, t.logo ? el('img', { class: 'logo', src: t.logo, alt: '' }) : el('span', { class: `team-mark ${teamClass(t.code)}`, 'aria-hidden': 'true', text: t.code || '–' }),
    el('span', { text: t.name })));
    const pickBtns = s.players.map((p) => {
      const b = el('button', { type: 'button', class: 'pick', 'aria-pressed': String(Boolean(chosen.get(s.sport)?.picks.includes(p.name))), 'aria-label': `${p.name}, ${p.team}` },
        p.short, el('small', { text: ` ${p.team}` }));
      b.addEventListener('click', () => {
        const mine = answer(s.sport);
        if (mine.picks.includes(p.name)) mine.picks = mine.picks.filter((x) => x !== p.name);
        else if (mine.picks.length >= maxPicks) {
          hint.textContent = `You can pick ${maxPicks}. Tap one of your players to swap.`;
          return;
        } else mine.picks.push(p.name);
        b.setAttribute('aria-pressed', String(mine.picks.includes(p.name)));
      });
      return b;
    });
    panel.replaceChildren(
      el('div', { class: 'team-grid', role: 'group', 'aria-label': `${s.label} team` }, teamBtns),
      el('div', { class: 'pick-grid', role: 'group', 'aria-label': `${s.label} players`, 'aria-describedby': 'picks-hint' }, pickBtns));
  }

  sports.forEach((s) => markTab(s.sport));
  if (sports.length) show(sports[0]);
  return {
    node: sports.length ? el('fieldset', { class: 'field' }, el('legend', { text: 'Teams you back (optional)' }),
      el('div', { class: 'sport-tabs', role: 'group', 'aria-label': 'Sport' }, tabs), panel, hint) : null,
    value: () => Object.fromEntries(chosen),
  };
}
