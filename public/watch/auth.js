// Sign-in with an Indian mobile number and a one-time code, then a first-time profile.
// Providers (from GET /api/config → otp.provider):
//   messagecentral Message Central VerifyNow sends and checks the SMS code; Huddle's server talks to it.
//   twilio_verify  Twilio Verify sends and checks the code (same screens).
//   demo           local development only: no SMS, the code is shown on screen and labelled as demo.
//   unavailable    sign-in is not configured yet.
import { api } from './api.js';
import { el, setRail, railIntro } from './ui.js';

const RESEND_SECONDS = 30;
const PHONE_RE = /^[6-9]\d{9}$/;

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

const phoneInput = () => el('input', { id: 'phone', name: 'phone', type: 'tel', inputmode: 'numeric', autocomplete: 'tel-national', maxlength: '16', placeholder: '98765 43210', required: true, 'aria-describedby': 'phone-hint' });

// Accepts "98765 43210", "+91 98765 43210" or "098765 43210" and returns the 10 digits (validated by the caller).
function tenDigits(value) {
  const d = String(value).replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) return d.slice(2);
  if (d.length === 11 && d.startsWith('0')) return d.slice(1);
  return d;
}
const codeInput = (maxlength) => el('input', { id: 'code', name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength, placeholder: '6-digit code', required: true });
const phoneField = (input) => field('phone', 'Mobile number', el('div', { class: 'phone-input' }, el('span', { class: 'cc', 'aria-hidden': 'true', text: '+91' }), input), 'Enter the 10-digit number, without +91.');
const masked = (digits) => `+91 ${digits.slice(0, 2)}XXXXXX${digits.slice(-2)}`;

// Resend countdown on a link button; stops itself once the button leaves the page.
function resendTimer(button, seconds) {
  let wait = seconds;
  const tick = () => {
    button.disabled = wait > 0;
    button.textContent = wait > 0 ? `Resend code in ${wait}s` : 'Resend code';
    wait -= 1;
  };
  tick();
  const timer = setInterval(() => { if (!document.contains(button)) clearInterval(timer); else tick(); }, 1000);
  return {
    stop: () => clearInterval(timer),
    restart: (s) => { wait = s; tick(); },
  };
}

export function renderAuth(ctx) {
  setRail(railIntro());
  const otp = ctx.config?.otp || {};
  if (!otp.provider || otp.provider === 'unavailable') return renderUnavailable();
  return renderServerPhone(ctx);
}

function renderUnavailable() {
  shell(document.getElementById('view'), 'Cricket watch parties with friends',
    el('div', { class: 'card form-card', role: 'status' },
      el('h2', { class: 'card-title', text: 'Sign-in is being set up' }),
      el('p', { class: 'card-lede', text: 'Please check back soon.' })));
}

// ---------------------------------------------------------------- one-time code (Message Central or Twilio Verify; demo locally)
function renderServerPhone(ctx) {
  const view = document.getElementById('view');
  const error = el('p', { class: 'form-error', role: 'alert' });
  const phone = phoneInput();
  const send = el('button', { type: 'submit', class: 'btn primary', text: 'Send code' });
  const form = el('form', { class: 'card form-card', novalidate: '' },
    el('h2', { class: 'card-title', text: 'Sign in with your mobile' }),
    el('p', { class: 'card-lede', text: 'Use your Indian mobile number. We send a one-time code; your number is never shown to other fans.' }),
    phoneField(phone), error, send);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const digits = tenDigits(phone.value);
    if (!PHONE_RE.test(digits)) {
      error.textContent = 'Enter a valid 10-digit Indian mobile number.';
      phone.focus();
      return;
    }
    send.disabled = true;
    error.textContent = '';
    try {
      const r = await api.post('/api/auth/otp/request', { phone: digits });
      renderServerCode(ctx, digits, r);
    } catch (err) {
      error.textContent = err.message;
      send.disabled = false;
    }
  });
  shell(view, 'Cricket watch parties with friends', form,
    el('p', { class: 'fine center', text: ctx.config?.otp?.demo ? 'Demo server: no SMS is sent. The code appears on screen.' : 'Standard SMS rates may apply.' }));
  phone.focus();
}

function renderServerCode(ctx, digits, sent) {
  const view = document.getElementById('view');
  const error = el('p', { class: 'form-error', role: 'alert' });
  const code = codeInput('8');
  const verify = el('button', { type: 'submit', class: 'btn primary', text: 'Verify and continue' });
  const resend = el('button', { type: 'button', class: 'link-btn' });
  const demo = sent.demo_code
    ? el('div', { class: 'demo-box', role: 'note' },
      el('b', { text: 'Demo sign-in' }),
      el('span', { text: 'No SMS is sent, and this does not prove you own the number.' }),
      el('span', {}, 'Your code is ', el('code', { text: sent.demo_code })))
    : null;
  if (sent.demo_code) code.value = sent.demo_code;
  const timer = resendTimer(resend, sent.resend_after || RESEND_SECONDS);
  resend.addEventListener('click', async () => {
    error.textContent = '';
    try {
      const r = await api.post('/api/auth/otp/request', { phone: digits });
      timer.stop();
      renderServerCode(ctx, digits, r);
    } catch (err) {
      error.textContent = err.message;
      if (err.retry_after) timer.restart(err.retry_after);
    }
  });

  const form = el('form', { class: 'card form-card', novalidate: '' },
    el('h2', { class: 'card-title', text: 'Enter your code' }),
    el('p', { class: 'card-lede', text: `We sent a one-time code to ${masked(digits)}. It expires in ${Math.round((sent.expires_in || 300) / 60)} minutes.` }),
    demo,
    field('code', 'One-time code', code),
    error, verify,
    el('div', { class: 'form-links' }, resend,
      el('button', { type: 'button', class: 'link-btn', text: 'Change number', onclick: () => { timer.stop(); renderAuth(ctx); } })));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const value = code.value.replace(/\D/g, '');
    if (!/^\d{4,8}$/.test(value)) {
      error.textContent = 'Enter the code from the SMS.';
      return;
    }
    verify.disabled = true;
    error.textContent = '';
    try {
      const r = await api.post('/api/auth/otp/verify', { phone: digits, code: value });
      timer.stop();
      ctx.signedIn(r.user, r.needs_profile);
    } catch (err) {
      error.textContent = err.attempts_left != null ? `${err.message} ${err.attempts_left} tries left.` : err.message;
      verify.disabled = false;
    }
  });
  shell(view, 'Cricket watch parties with friends', form);
  code.focus();
}

// ---------------------------------------------------------------- profile
export function renderProfile(ctx) {
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
  const save = el('button', { type: 'submit', class: 'btn primary', text: 'Join Huddle' });
  const form = el('form', { class: 'card form-card', novalidate: '' },
    el('h2', { class: 'card-title', text: 'Set up your profile' }),
    el('p', { class: 'card-lede', text: 'Fans see your name, handle and team. Never your phone number.' }),
    field('display-name', 'Display name', name),
    field('handle', 'Handle', el('div', { class: 'phone-input' }, el('span', { class: 'cc', 'aria-hidden': 'true', text: '@' }), handle), '3–20 letters, numbers or underscores. Friends find you by this.'),
    el('fieldset', { class: 'field' }, el('legend', { text: 'Your team (optional)' }), el('div', { class: 'team-grid' }, teamBtns)),
    error, save);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    save.disabled = true;
    error.textContent = '';
    try {
      const r = await api.put('/api/me/profile', { display_name: name.value, handle: handle.value.replace(/^@/, '').toLowerCase(), team: team || null });
      ctx.signedIn(r.user, false);
    } catch (err) {
      error.textContent = err.message;
      save.disabled = false;
    }
  });
  shell(view, 'Almost there', form);
  name.focus();
}
