// Notification settings and browser push. Permission is only ever requested from a click, and the watch party
// works fully without it: in-app alerts are the main path, push is for big moments while you are away, capped
// per match by the server (notifications.max_per_match).
import { api } from './api.js';
import { el } from './ui.js';
import { openSheet } from './sheets.js';

const PROMPT_SNOOZE_DAYS = 7;

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

const maxPerMatch = (config) => config?.notifications?.max_per_match ?? 8;

export const momentsCopy = (config) => `Get a notification for big moments (wickets, momentum swings, the result) when you're not looking. At most ${maxPerMatch(config)} per match.`;

function urlBase64ToUint8Array(base64) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

// Asks for permission (only ever called from a click), subscribes this browser and registers it with Huddle.
// Throws Error('denied' | 'dismissed') when the person says no; resolves to the updated preferences.
export async function enableBrowserAlerts(vapidKey) {
  const reg = await navigator.serviceWorker.register('/sw.js');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error(permission === 'denied' ? 'denied' : 'dismissed');
  await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  const sub = existing || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidKey) });
  return api.post('/api/me/push-subscriptions', sub.toJSON());
}

async function disableBrowserAlerts() {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    await sub?.unsubscribe();
  } catch { /* the server-side delete below still stops delivery */ }
  return api.del('/api/me/push-subscriptions');
}

// Huddle API errors carry a status and a safe message; browser errors (service worker, push service) are not shown raw.
const refusalMessage = (err) => (err?.message === 'denied' ? 'You blocked notifications. In-app alerts still work.'
  : err?.message === 'dismissed' ? 'No problem. You can turn notifications on any time in Alerts.'
    : err?.status !== undefined ? err.message
      : 'Notifications could not be turned on in this browser. In-app alerts still work.');

// ---------------------------------------------------------------- one-time prompt in the room
const snoozeKey = (userId) => `huddle:push-prompt:${userId}`;

function snoozed(userId) {
  try {
    const at = Number(localStorage.getItem(snoozeKey(userId)));
    return at > 0 && Date.now() - at < PROMPT_SNOOZE_DAYS * 86400000;
  } catch {
    return false;
  }
}

function snooze(userId) {
  try { localStorage.setItem(snoozeKey(userId), String(Date.now())); } catch { /* storage may be unavailable */ }
}

// Resolves to a dismissible card, or null when it should not be offered: unsupported browser, push not set up
// on the server, permission already denied, already subscribed, or "Not now" in the last 7 days.
export async function pushPrompt(ctx) {
  if (!pushSupported() || !ctx.config?.push?.available || Notification.permission === 'denied' || snoozed(ctx.me.id)) return null;
  let prefs;
  try {
    prefs = await api.get('/api/me/notifications');
  } catch {
    return null;
  }
  if (!prefs.push_available || prefs.push_subscribed) return null;
  const text = el('p', { class: 'push-prompt-text', text: momentsCopy(ctx.config) });
  const msg = el('p', { class: 'form-error', role: 'status' });
  const later = el('button', { type: 'button', class: 'btn small', text: 'Not now' });
  const on = el('button', { type: 'button', class: 'btn primary small', text: 'Turn on' });
  const card = el('section', { class: 'push-prompt', 'aria-label': 'Big-moment notifications' }, text, el('div', { class: 'card-actions' }, later, on), msg);
  later.addEventListener('click', () => {
    snooze(ctx.me.id);
    card.remove();
  });
  on.addEventListener('click', async () => {
    on.disabled = true;
    later.disabled = true;
    msg.textContent = '';
    try {
      await enableBrowserAlerts(prefs.vapid_public_key);
      card.replaceChildren(el('p', { class: 'push-prompt-text', text: 'Notifications are on. Change them any time in Alerts.' }));
      setTimeout(() => card.remove(), 4000);
    } catch (err) {
      if (err.message === 'denied') {
        card.replaceChildren(el('p', { class: 'push-prompt-text', text: refusalMessage(err) }));
        setTimeout(() => card.remove(), 4000);
        return;
      }
      msg.textContent = refusalMessage(err);
      on.disabled = false;
      later.disabled = false;
    }
  });
  return card;
}

// ---------------------------------------------------------------- settings sheet
export async function openNotificationSettings(config) {
  const s = openSheet({ title: 'Alerts', lede: `${momentsCopy(config)} Never every ball, and never your friends' messages on your lock screen.` });
  const status = el('div', { class: 'notice-box' }, el('div', { class: 'skeleton' }));
  const toggles = el('div', { class: 'toggle-list' });
  const msg = el('p', { class: 'form-error', role: 'status' });
  s.body.append(el('h3', { text: 'Notifications on this device' }), status, msg, el('h3', { text: 'What to notify me about' }), toggles,
    el('p', { class: 'fine', text: `Big-moment notifications are capped at ${maxPerMatch(config)} per match. In-app alerts in the watch party always work, with or without notifications.` }));

  let prefs;
  try {
    prefs = await api.get('/api/me/notifications');
  } catch (err) {
    if (s.isOpen()) status.replaceChildren(el('p', { text: err.message }));
    return;
  }
  if (!s.isOpen()) return;

  const renderStatus = () => {
    status.replaceChildren();
    if (!prefs.push_available) {
      status.append(el('p', { text: 'Notifications are not set up on this server. In-app alerts still work.' }));
    } else if (!pushSupported()) {
      status.append(el('p', { text: 'This browser does not support notifications. In-app alerts still work.' }));
    } else if (Notification.permission === 'denied') {
      status.append(el('p', { text: 'Notifications are blocked for this site in your browser settings. In-app alerts still work.' }));
    } else if (prefs.push_subscribed) {
      status.append(el('p', { text: 'Notifications are on.' }),
        el('button', { type: 'button', class: 'btn', text: 'Turn off notifications', onclick: async (e) => {
          e.target.disabled = true;
          try { prefs = await disableBrowserAlerts(); msg.textContent = 'Notifications are off.'; } catch (err) { msg.textContent = err.message; }
          renderStatus();
        } }));
    } else {
      status.append(el('p', { text: 'Notifications are off.' }),
        el('button', { type: 'button', class: 'btn primary', text: 'Turn on notifications', onclick: async (e) => {
          e.target.disabled = true;
          msg.textContent = '';
          try {
            prefs = await enableBrowserAlerts(prefs.vapid_public_key);
            msg.textContent = 'Notifications are on.';
          } catch (err) {
            msg.textContent = refusalMessage(err);
          }
          renderStatus();
        } }));
    }
  };
  renderStatus();

  const options = [
    ['push_momentum', 'Big match moments', `Wickets, momentum swings and the result. At most ${maxPerMatch(config)} per match.`],
    ['push_invites', 'Watch party invitations', 'When a friend invites you to a room.'],
    ['push_answers', 'Answers to my questions', 'When the Co-host answers you after you have left the room.'],
  ];
  for (const [key, label, hint] of options) {
    const id = `pref-${key}`;
    const box = el('input', { type: 'checkbox', id, checked: Boolean(prefs[key]) });
    box.addEventListener('change', async () => {
      box.disabled = true;
      try {
        prefs = { ...prefs, ...(await api.put('/api/me/notifications', { [key]: box.checked })) };
      } catch (err) {
        box.checked = !box.checked;
        msg.textContent = err.message;
      }
      box.disabled = false;
    });
    toggles.append(el('label', { class: 'toggle-row', for: id }, box, el('span', {}, el('b', { text: label }), el('small', { text: hint }))));
  }
}
