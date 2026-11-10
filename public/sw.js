/* =============================================================
   Service worker of the Radma admin app (scope /admin only — the
   customer calculators are never touched).
   - Install to the home screen; a small "you are offline" page when
     there is no network. Data (/api) is never cached: prices and
     customers always come from the server.
   - Shows the notifications the server pushes, and opens the right
     page of the app when one is tapped.
   ============================================================= */
const CACHE = 'radma-admin-v1';
const OFFLINE = '/offline.html';
const SHELL = [OFFLINE, '/icons/icon-192.png', '/images/logo.png'];

self.addEventListener('install', (e) => {
    e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
    e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
        .then(() => self.clients.claim()));
});

// Pages of the app: always from the network (fresh code and data); the offline page when it fails
self.addEventListener('fetch', (e) => {
    const req = e.request;
    if (req.method !== 'GET' || req.mode !== 'navigate') return;
    e.respondWith(fetch(req).catch(() => caches.match(OFFLINE)));
});

self.addEventListener('push', (e) => {
    let data = {};
    try { data = e.data ? e.data.json() : {}; } catch { data = { title: 'رادما', body: e.data ? e.data.text() : '' }; }
    e.waitUntil(self.registration.showNotification(data.title || 'رادما', {
        body: data.body || '',
        icon: '/icons/icon-192.png',
        badge: '/icons/badge-96.png',
        tag: data.tag || undefined,
        renotify: Boolean(data.tag),
        dir: 'rtl',
        lang: 'ar',
        data: { url: data.url || '/admin' }
    }));
});

self.addEventListener('notificationclick', (e) => {
    e.notification.close();
    const url = new URL((e.notification.data && e.notification.data.url) || '/admin', self.location.origin);
    if (url.origin !== self.location.origin || !url.pathname.startsWith('/admin')) return;
    e.waitUntil((async () => {
        const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const app = open.find((c) => new URL(c.url).pathname.startsWith('/admin'));
        if (app) {
            await app.focus();
            app.postMessage({ type: 'open', url: url.pathname + url.hash });
            return;
        }
        await self.clients.openWindow(url.href);
    })());
});
