// 画面一式をキャッシュし、2回目以降はネットワークを待たずに開く。
// 保存データは localStorage 側にあるのでここでは触らない。
const VERSION = 'memo-v2';
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
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
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;

  // キャッシュ優先。裏で新しいものを取ってきて次回に備える。
  // ?x=1 などが付いても同じ画面を返す。
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      const net = fetch(req)
        .then((res) => {
          if (res && res.ok) caches.open(VERSION).then((c) => c.put(req, res.clone()));
          return res;
        })
        .catch(() => hit);
      return hit || net;
    })
  );
});
