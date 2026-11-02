// Joining Huddle: pick a display name, a handle and (optionally) a team and up to three players. No phone number
// or password; the server
// creates a guest profile and keeps this browser signed in with an HttpOnly session cookie.
import { api } from './api.js';
import { el, setRail, railIntro } from './ui.js';

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
    subtitle: 'Cricket watch parties with friends',
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
    lede: 'Fans see your name, handle, team and players.',
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
  let team = ctx.me?.team || '';
  const teamBtns = [['CSK', 'Chennai Super Kings'], ['MI', 'Mumbai Indians'], ['', 'No team']].map(([code, label]) => {
    const b = el('button', { type: 'button', class: 'team-opt', dataset: { team: code }, 'aria-pressed': String(team === code) });
    if (code) b.append(el('img', { class: 'logo', src: `assets/${code.toLowerCase()}.png`, alt: '' }));
    b.append(el('span', { text: label }));
    b.addEventListener('click', () => {
      team = code;
      teamBtns.forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.team === team)));
    });
    return b;
  });
  // Players for your contest team, from both squads (demo data, like the match).
  const maxPicks = ctx.config?.max_picks || 3;
  const picks = new Set(ctx.me?.picks || []);
  const pickHint = el('p', { class: 'field-hint', id: 'picks-hint', text: `Up to ${maxPicks}, for your contest team. You can change them later in Edit profile.` });
  const pickBtns = Object.entries(ctx.config?.squads || {}).flatMap(([code, players]) => players.map((p) => {
    const b = el('button', { type: 'button', class: 'pick', 'aria-pressed': String(picks.has(p.name)), 'aria-label': `${p.name}, ${code}` }, p.short, el('small', { text: ` ${code}` }));
    b.addEventListener('click', () => {
      if (picks.has(p.name)) picks.delete(p.name);
      else if (picks.size >= maxPicks) {
        pickHint.textContent = `You can pick ${maxPicks}. Tap one of your players to swap.`;
        return;
      } else picks.add(p.name);
      b.setAttribute('aria-pressed', String(picks.has(p.name)));
    });
    return b;
  }));
  const save = el('button', { type: 'submit', class: 'btn primary', text: button });
  const form = el('form', { class: 'card form-card', novalidate: '' },
    el('h2', { class: 'card-title', text: title }),
    el('p', { class: 'card-lede', text: lede }),
    field('display-name', 'Display name', name),
    field('handle', 'Handle', el('div', { class: 'phone-input' }, el('span', { class: 'cc', 'aria-hidden': 'true', text: '@' }), handle), '3–20 letters, numbers or underscores. Friends find you by this.'),
    el('fieldset', { class: 'field' }, el('legend', { text: 'Backing (optional)' }), el('div', { class: 'team-grid' }, teamBtns)),
    pickBtns.length ? el('fieldset', { class: 'field', 'aria-describedby': 'picks-hint' }, el('legend', { text: 'Players you picked' }), el('div', { class: 'pick-grid' }, pickBtns), pickHint) : null,
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
      const r = await submit({ display_name: name.value, handle: h, team: team || null, picks: [...picks] });
      ctx.signedIn(r.user, false);
    } catch (err) {
      error.textContent = err.message;
      save.disabled = false;
    }
  });
  shell(view, subtitle, form, note ? el('p', { class: 'fine center', text: note }) : null);
  name.focus();
}
