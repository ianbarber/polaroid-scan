const CACHE = 'polascan-v16'; // bump the version whenever ASSETS changes so the precache refreshes
const ASSETS = ['./', './index.html', './style.css', './app.js', './vision.js', './worker.js', './manifest.json', './icon-192.png', './icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS))); self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('polascan-') && k !== CACHE).map(k => caches.delete(k))))); self.clients.claim(); });
// Network-first so edits show up on the next reload; the cache is only the offline fallback.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  // The agent dashboard shares this origin but owns its own network/data policy.
  if (url.pathname === '/agents' || url.pathname.startsWith('/agents/')) return;
  if (url.pathname.startsWith('/debug') || url.pathname === '/save' || url.pathname.endsWith('/config.json')) return;
  e.respondWith((async () => {
    try {
      // revalidate with the server: otherwise the browser's heuristic HTTP cache can keep serving an
      // old worker.js/vision.js (navigations can't take a RequestInit, and are revalidated anyway)
      const res = await (e.request.mode === 'navigate' ? fetch(e.request) : fetch(e.request, { cache: 'no-cache' }));
      if (res.ok) {
        const copy = res.clone();
        e.waitUntil(caches.open(CACHE).then(cache => cache.put(e.request, copy)));
      }
      return res;
    } catch {
      const hit = await caches.match(e.request);
      if (hit) return hit;
      if (e.request.mode === 'navigate') return caches.match('./index.html');
      return Response.error();
    }
  })());
});
