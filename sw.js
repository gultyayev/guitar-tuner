// Offline support with reliable updates.
//
// Strategy: network first (revalidating past the HTTP cache, so GitHub Pages'
// 10-minute max-age can't serve a stale copy), falling back to the offline cache
// when the network is down or takes longer than 3 s. Fonts are cache-first.
// Bump VERSION on every release: the old cache is dropped and open pages reload.
const VERSION = 'tuner-v8';
const CORE = ['./', './index.html', './manifest.webmanifest', './tuner-worker.js', './tuner-worklet.js', './fx.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png', './icons/icon.svg'];
const FONTS = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;

self.addEventListener('install', e => {
  // cache:'reload' bypasses the browser's HTTP cache, so the precache is always the new release.
  e.waitUntil(caches.open(VERSION)
    .then(c => c.addAll(CORE.map(u => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const old = (await caches.keys()).filter(k => k !== VERSION);
    await Promise.all(old.map(k => caches.delete(k)));
    await self.clients.claim();
    // Pages from v3/v4 have no update code of their own, so reload them from here.
    // Newer pages reload themselves on 'controllerchange' (one reload, not two).
    // Not awaited on purpose: the reload's request waits for this worker to finish
    // activating, so awaiting it inside waitUntil would deadlock.
    if (old.some(k => /^tuner-v[34]$/.test(k))) {
      self.clients.matchAll({ type: 'window' })
        .then(cs => cs.forEach(c => c.navigate(c.url).catch(() => {})));
    }
  })());
});

function timeout(ms) { return new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms)); }

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (FONTS.test(req.url)) {
    e.respondWith(caches.open(VERSION).then(async cache => {
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
      return res;
    }));
    return;
  }
  if (url.origin !== location.origin) return;

  const key = req.mode === 'navigate' ? './index.html' : req;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    try {
      const net = fetch(req, { cache: 'no-cache' }); net.catch(() => {});
      const res = await Promise.race([net, timeout(3000)]);
      if (res.ok) cache.put(key, res.clone());
      return res;
    } catch {
      const hit = await cache.match(key, { ignoreSearch: true });
      if (hit) return hit;
      throw new Error('offline and not cached');
    }
  })());
});
