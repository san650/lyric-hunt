const CACHE_NAME = 'lyrics';
const CACHE_VERSION = 'v6';     // bump per deploy
const CACHE = `${CACHE_NAME}-${CACHE_VERSION}`;

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './styles.css',
  './app.js',
  './commands.js',
  './history.js',
  './store.js',
  './db.js',
  './lyrics.js',
  './icon.svg',
  './fonts/fonts.css',
  './fonts/fraunces-italic.woff2',
  './fonts/fraunces.woff2',
  './fonts/jetbrains-mono.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    // Any leftover cache that matches our naming scheme but is not the current
    // version means this activate is an update (not a first install). After
    // claiming clients, broadcast RELOAD so they swap to the new shell
    // immediately — avoids the "two-reload PWA update" problem on future
    // deploys. See pwa-gotchas/reference/sw-update-reload.md.
    const oldKeys = keys.filter((k) => k.startsWith(CACHE_NAME + '-') && k !== CACHE);
    const wasUpdate = oldKeys.length > 0;
    await Promise.all(oldKeys.map((k) => caches.delete(k)));
    await self.clients.claim();
    if (wasUpdate) {
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const c of clients) c.postMessage({ type: 'RELOAD' });
    }
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => {
        // Navigation fallback: any HTML navigation that misses (e.g. ?query
        // params, shareable links with hashes resolved to URLs) is served the
        // cached app shell so the SPA can take over.
        if (req.mode === 'navigate') return caches.match('./index.html');
        return cached;
      });
    })
  );
});
