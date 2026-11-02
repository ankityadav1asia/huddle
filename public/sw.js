// Huddle service worker: shows push alerts and opens the watch party when one is tapped. No caching.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

function sameOriginPath(url) {
  try {
    const u = new URL(url, self.location.origin);
    return u.origin === self.location.origin ? `${u.pathname}${u.search}${u.hash}` : '/';
  } catch {
    return '/';
  }
}

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const title = typeof data.title === 'string' && data.title ? data.title.slice(0, 80) : 'Huddle';
  event.waitUntil(self.registration.showNotification(title, {
    body: typeof data.body === 'string' ? data.body.slice(0, 200) : '',
    tag: typeof data.tag === 'string' ? data.tag : 'huddle',
    icon: '/assets/csk.png',
    data: { url: sameOriginPath(data.url || '/') },
  }));
});

// The link only opens the app; the app re-checks sign-in, membership and room state before showing anything.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
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
    await self.clients.openWindow(url);
  })());
});
