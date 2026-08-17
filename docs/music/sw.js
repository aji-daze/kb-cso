// アプリ本体をキャッシュして、電波がなくても起動できるようにする。
// 曲のデータは IndexedDB 側に入っているのでここでは扱わない。
const VERSION = 'music-v2';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './manifest.json',
  './js/app.js',
  './js/db.js',
  './js/tags.js',
  './js/player.js',
  './js/drive.js',
  './js/art.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Google の API などは素通し

  e.respondWith(
    caches.match(req).then((hit) => {
      // キャッシュを即返しつつ、裏で新しいものを取ってくる
      const fresh = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || fresh;
    })
  );
});
