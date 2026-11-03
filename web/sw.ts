// Huddle service worker: shows push alerts and opens the watch party when one is tapped. No caching.
// A classic script (no imports or exports): `self` is typed as a plain worker, so `sw` retypes it as a service worker.
const sw = self as unknown as ServiceWorkerGlobalScope;
sw.addEventListener('install', () => sw.skipWaiting());
sw.addEventListener('activate', (event) => event.waitUntil(sw.clients.claim()));

function sameOriginPath(url: string) {
  try {
    const u = new URL(url, self.location.origin);
    return u.origin === self.location.origin ? `${u.pathname}${u.search}${u.hash}` : '/';
  } catch {
    return '/';
  }
}

// What the server sends (lib/notify); each field is still checked before use.
type PushPayload = { title?: string; body?: string; tag?: string; url?: string };

sw.addEventListener('push', (event) => {
  let data: PushPayload = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const title = typeof data.title === 'string' && data.title ? data.title.slice(0, 80) : 'Huddle';
  event.waitUntil(sw.registration.showNotification(title, {
    body: typeof data.body === 'string' ? data.body.slice(0, 200) : '',
    tag: typeof data.tag === 'string' ? data.tag : 'huddle',
    icon: '/assets/csk.png',
    data: { url: sameOriginPath(data.url || '/') },
  }));
});

// The link only opens the app; the app re-checks sign-in, membership and room state before showing anything.
sw.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil((async () => {
    const windows = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      await client.focus();
      try {
        await client.navigate(url);
      } catch {
        client.postMessage({ type: 'open', url });
      }
      return;
    }
    await sw.clients.openWindow(url);
  })());
});
