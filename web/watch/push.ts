// Notification settings and browser push. Permission is only requested from a click: in-app alerts are the main
// path, and push covers big moments while you are away, capped per match by the server.
import { api, ApiError, errorMessage, type Config } from './api.ts';
import { el } from './ui.ts';
import { openSheet } from './sheets.ts';
import type { ReadyCtx } from './app.ts';

type PrefKey = 'push_momentum' | 'push_invites' | 'push_answers';

// GET /api/me/notifications, and what turning push on or off returns. Push on the server comes with its VAPID key.
type NotificationPrefs = Record<PrefKey, boolean> & { push_subscribed: boolean }
  & ({ push_available: true; vapid_public_key: string } | { push_available: false; vapid_public_key: null });

const PROMPT_SNOOZE_DAYS = 7;

const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

const maxPerMatch = (config: Config) => config?.notifications?.max_per_match ?? 8;

const momentsCopy = (config: Config) => `Get a notification for big moments (wickets, momentum swings, the result) when you're not looking. At most ${maxPerMatch(config)} per match.`;

function urlBase64ToUint8Array(base64: string) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

// Asks for permission (only ever called from a click), subscribes this browser and registers it with Huddle.
// Throws Error('denied' | 'dismissed') when the person says no; resolves to the updated preferences.
async function enableBrowserAlerts(vapidKey: string): Promise<NotificationPrefs> {
  const reg = await navigator.serviceWorker.register('/sw.js');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error(permission === 'denied' ? 'denied' : 'dismissed');
  await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  const sub = existing || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidKey) });
  return api.post('/api/me/push-subscriptions', sub.toJSON());
}

async function disableBrowserAlerts(): Promise<NotificationPrefs> {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    await sub?.unsubscribe();
  } catch { /* the server-side delete below still stops delivery */ }
  return api.del('/api/me/push-subscriptions');
}

// Huddle API errors carry a status and a safe message; browser errors (service worker, push service) are not shown raw.
const refusalMessage = (err: unknown) => (err instanceof Error && err.message === 'denied' ? 'You blocked notifications. In-app alerts still work.'
  : err instanceof Error && err.message === 'dismissed' ? 'No problem. You can turn notifications on any time in Alerts.'
    : err instanceof ApiError ? err.message
      : 'Notifications could not be turned on in this browser. In-app alerts still work.');

const snoozeKey = (userId: string) => `huddle:push-prompt:${userId}`;

function snoozed(userId: string) {
  try {
    const at = Number(localStorage.getItem(snoozeKey(userId)));
    return at > 0 && Date.now() - at < PROMPT_SNOOZE_DAYS * 86400000;
  } catch {
    return false;
  }
}

function snooze(userId: string) {
  try { localStorage.setItem(snoozeKey(userId), String(Date.now())); } catch { /* storage may be unavailable */ }
}

// Resolves to a dismissible card, or null when it should not be offered: unsupported browser, push not set up
// on the server, permission already denied, already subscribed, or "Not now" in the last 7 days.
export async function pushPrompt(ctx: ReadyCtx) {
  if (!pushSupported() || !ctx.config?.push?.available || Notification.permission === 'denied' || snoozed(ctx.me.id)) return null;
  let prefs: NotificationPrefs;
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
      if (err instanceof Error && err.message === 'denied') {
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

export async function openNotificationSettings(config: Config) {
  const s = openSheet({ title: 'Alerts', lede: `${momentsCopy(config)} Never every ball, and never your friends' messages on your lock screen.` });
  const status = el('div', { class: 'notice-box' }, el('div', { class: 'skeleton' }));
  const toggles = el('div', { class: 'toggle-list' });
  const msg = el('p', { class: 'form-error', role: 'status' });
  s.body.append(el('h3', { text: 'Notifications on this device' }), status, msg, el('h3', { text: 'What to notify me about' }), toggles,
    el('p', { class: 'fine', text: `Big-moment notifications are capped at ${maxPerMatch(config)} per match. In-app alerts in the watch party always work, with or without notifications.` }));

  let prefs: NotificationPrefs;
  try {
    prefs = await api.get('/api/me/notifications');
  } catch (err) {
    if (s.isOpen()) status.replaceChildren(el('p', { text: errorMessage(err) }));
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
          e.currentTarget.disabled = true;
          try { prefs = await disableBrowserAlerts(); msg.textContent = 'Notifications are off.'; } catch (err) { msg.textContent = errorMessage(err); }
          renderStatus();
        } }));
    } else {
      status.append(el('p', { text: 'Notifications are off.' }),
        el('button', { type: 'button', class: 'btn primary', text: 'Turn on notifications', onclick: async (e) => {
          e.currentTarget.disabled = true;
          msg.textContent = '';
          try {
            // This button is only offered when push is available, and the key always comes with it.
            prefs = await enableBrowserAlerts(prefs.vapid_public_key!);
            msg.textContent = 'Notifications are on.';
          } catch (err) {
            msg.textContent = refusalMessage(err);
          }
          renderStatus();
        } }));
    }
  };
  renderStatus();

  const options: [PrefKey, string, string][] = [
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
        msg.textContent = errorMessage(err);
      }
      box.disabled = false;
    });
    toggles.append(el('label', { class: 'toggle-row', for: id }, box, el('span', {}, el('b', { text: label }), el('small', { text: hint }))));
  }
}
