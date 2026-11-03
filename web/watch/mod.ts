// Moderator queue: approve or remove held messages, act on reports, resolve appeals.
import { api } from './api.ts';
import { el, clock } from './ui.ts';

const body = document.getElementById('mod-body');

const REASON = {
  harassment: 'Harassment', hate: 'Hate speech', threat: 'Threat', spam: 'Spam', personal_info: 'Personal details',
  sexual: 'Sexual content', misinformation: 'Wrong match information', other: 'Other',
};

function actionButton(label, run, cls = 'ctl') {
  const b = el('button', { type: 'button', class: cls, text: label });
  b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      await run();
      await load();
    } catch (err) {
      b.disabled = false;
      alertLine(err.message);
    }
  });
  return b;
}

let status: HTMLParagraphElement;
function alertLine(text) {
  status.textContent = text;
}

async function load() {
  if (!body) return;
  let me;
  try {
    me = await api.get('/api/me');
  } catch (err) {
    body.replaceChildren(el('div', { class: 'card' }, el('p', { text: err.status === 401 ? 'Sign in on the main page first.' : err.message }), el('a', { href: '/', text: 'Go to Huddle' })));
    return;
  }
  let q;
  try {
    q = await api.get('/api/mod/queue');
  } catch (err) {
    body.replaceChildren(el('div', { class: 'card' }, el('p', { text: err.status === 403 ? `Moderators only. You are signed in as @${me.user.handle}.` : err.message })));
    return;
  }
  status = el('p', { class: 'form-error', role: 'alert' });
  const held = el('section', { class: 'home-section' }, el('h2', { class: 'section-title', text: `Held for review (${q.held.length})` }));
  if (!q.held.length) held.append(el('p', { class: 'empty', text: 'Nothing is waiting for review.' }));
  for (const m of q.held) {
    held.append(el('article', { class: 'card mod-item' },
      el('p', { class: 'mod-meta', text: `${m.sender_type === 'ai' ? 'AI Co-host' : `@${m.handle}`} · ${m.room_type} room · ${clock(m.created_at)} · ${m.reports} report${m.reports === 1 ? '' : 's'}${m.moderation?.categories?.length ? ` · flagged: ${m.moderation.categories.join(', ')}` : ''}` }),
      el('p', { class: 'mod-text', text: m.body }),
      el('div', { class: 'mod-actions' },
        actionButton('Approve and publish', () => api.post(`/api/mod/messages/${m.id}`, { action: 'approve' })),
        actionButton('Remove', () => api.post(`/api/mod/messages/${m.id}`, { action: 'remove' }), 'ctl danger'))));
  }
  const reports = el('section', { class: 'home-section' }, el('h2', { class: 'section-title', text: `Open reports and appeals (${q.reports.length})` }));
  if (!q.reports.length) reports.append(el('p', { class: 'empty', text: 'No open reports.' }));
  for (const r of q.reports) {
    const actions = el('div', { class: 'mod-actions' });
    if (r.kind === 'appeal') {
      actions.append(
        actionButton('Overturn (it was fine)', () => api.post(`/api/mod/appeals/${r.id}`, { action: 'overturn' })),
        actionButton('Uphold', () => api.post(`/api/mod/appeals/${r.id}`, { action: 'uphold' })));
    } else if (r.message_id) {
      actions.append(
        actionButton('Remove message', () => api.post(`/api/mod/messages/${r.message_id}`, { action: 'remove' }), 'ctl danger'),
        actionButton('Dismiss', () => api.post(`/api/mod/messages/${r.message_id}`, { action: 'dismiss' })));
    }
    reports.append(el('article', { class: 'card mod-item' },
      el('p', { class: 'mod-meta', text: r.kind === 'appeal'
        ? `Appeal of an automated decision · ${clock(r.created_at)}`
        : `${r.kind === 'ai_response' ? 'AI response' : 'Message'} by ${r.sender_type === 'ai' ? 'the AI Co-host' : `@${r.author_handle || 'unknown'}`} · ${REASON[r.reason] || r.reason} · ${clock(r.created_at)}${r.message_status && r.message_status !== 'visible' ? ` · now ${r.message_status}` : ''}` }),
      r.body ? el('p', { class: 'mod-text', text: r.body }) : el('p', { class: 'mod-meta', text: r.kind === 'appeal' ? 'The original message was never stored (it was stopped before posting).' : 'Message no longer available.' }),
      r.note ? el('p', { class: 'mod-meta', text: `Note: ${r.note}` }) : null,
      actions));
  }
  body.replaceChildren(status, held, reports);
}

load();
