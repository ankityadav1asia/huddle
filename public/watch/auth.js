// Joining Huddle: pick a display name, a handle and (optionally) the team and up to three players you back in each
// sport. No phone number or password; the server creates a guest profile and keeps this browser signed in with an
// HttpOnly session cookie.
import { api } from './api.js';
import { el, setRail, railIntro, teamClass } from './ui.js';

function shell(view, subtitle, ...content) {
  view.replaceChildren(
    el('div', { class: 'masthead' },
      el('header', { class: 'top' },
        el('div', { class: 'top-title' },
          el('b', { class: 'brand', text: 'Huddle' }),
          el('span', { class: 'top-sub', text: subtitle })))),
    el('div', { class: 'scroll-body' }, ...content),
  );
}

const field = (id, label, input, hint) => el('div', { class: 'field' },
  el('label', { for: id, text: label }), input, hint ? el('p', { class: 'field-hint', id: `${id}-hint`, text: hint }) : null);

// New visitors: create a guest profile.
export function renderAuth(ctx) {
  renderProfileForm(ctx, {
    subtitle: 'Sports watch parties with friends',
    title: 'Join the watch party',
    lede: 'Pick a name for the chat. No phone number or password needed: this browser keeps you signed in.',
    button: 'Join Huddle',
    submit: (body) => api.post('/api/auth/guest', body),
    note: 'Your profile lives in this browser. If you sign out or clear your browser data, it cannot be recovered.',
  });
}

// Signed-in users who still need a handle (older accounts).
export function renderProfile(ctx) {
  renderProfileForm(ctx, {
    subtitle: 'Almost there',
    title: 'Set up your profile',
    lede: 'Fans see your name, your handle and the teams and players you back.',
    button: 'Save and continue',
    submit: (body) => api.put('/api/me/profile', body),
  });
}

function renderProfileForm(ctx, { subtitle, title, lede, button, submit, note }) {
  setRail(railIntro());
  const view = document.getElementById('view');
  const error = el('p', { class: 'form-error', role: 'alert' });
  const name = el('input', { id: 'display-name', maxlength: '30', required: true, autocomplete: 'nickname', value: ctx.me?.display_name || '' });
  const handle = el('input', { id: 'handle', maxlength: '20', required: true, autocapitalize: 'off', spellcheck: 'false', value: ctx.me?.handle || '', 'aria-describedby': 'handle-hint' });
  const backing = sportPicker(ctx.config, ctx.me?.sports);
  const save = el('button', { type: 'submit', class: 'btn primary', text: button });
  const form = el('form', { class: 'card form-card', novalidate: '' },
    el('h2', { class: 'card-title', text: title }),
    el('p', { class: 'card-lede', text: lede }),
    field('display-name', 'Display name', name),
    field('handle', 'Handle', el('div', { class: 'phone-input' }, el('span', { class: 'cc', 'aria-hidden': 'true', text: '@' }), handle), '3–20 letters, numbers or underscores. Friends find you by this.'),
    backing.node,
    error, save);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const h = handle.value.trim().replace(/^@/, '').toLowerCase();
    if (!name.value.trim()) {
      error.textContent = 'Enter a display name.';
      name.focus();
      return;
    }
    if (!/^[a-z0-9_]{3,20}$/.test(h)) {
      error.textContent = 'Handles use 3–20 letters, numbers or underscores.';
      handle.focus();
      return;
    }
    save.disabled = true;
    error.textContent = '';
    try {
      const r = await submit({ display_name: name.value, handle: h, sports: backing.value() });
      ctx.signedIn(r.user, false);
    } catch (err) {
      error.textContent = err.message;
      save.disabled = false;
    }
  });
  shell(view, subtitle, form, note ? el('p', { class: 'fine center', text: note }) : null);
  name.focus();
}

// The team you back (or none) and up to three players in each sport, one sport at a time. A sport you leave alone
// is not sent, so the first room you watch it in asks once.
function sportPicker(config, current) {
  const sports = config?.sports || [];
  const maxPicks = config?.max_picks || 3;
  const chosen = new Map(Object.entries(current || {}).map(([sport, c]) => [sport, { team: c.team ?? null, picks: [...(c.picks || [])] }]));
  const answer = (sport) => chosen.get(sport) || chosen.set(sport, { team: null, picks: [] }).get(sport);
  const hint = el('p', { class: 'field-hint', id: 'picks-hint' });
  const panel = el('div', { class: 'sport-panel' });
  const marks = new Map(sports.map((s) => [s.sport, el('small')]));
  const markTab = (sport) => {
    const team = chosen.get(sport)?.team;
    marks.get(sport).className = team ? `badge ${teamClass(team)}` : '';
    marks.get(sport).textContent = team || '';
  };
  const tabs = sports.map((s) => el('button', { type: 'button', class: 'sport-tab', dataset: { sport: s.sport }, onclick: () => show(s) },
    s.label, marks.get(s.sport)));

  function show(s) {
    tabs.forEach((t) => t.setAttribute('aria-pressed', String(t.dataset.sport === s.sport)));
    hint.textContent = `Up to ${maxPicks} ${s.label} players. You can change them later in Edit profile.`;
    const isTeam = (code) => chosen.has(s.sport) && (chosen.get(s.sport).team ?? '') === code;
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
