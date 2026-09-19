// 画面一式をキャッシュして、電波がなくても開けるようにする。
// 保存データは localStorage 側にあるのでここでは触らない。
const VERSION = 'desk-v1';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './manifest.json',
  './js/store.js',
  './js/clock.js',
  './js/timeline.js',
  './js/tasks.js',
  './js/timer.js',
  './js/links.js',
  './js/app.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      // cache:'reload' を付けないと、更新したのに古いファイルを取り込むことがある。
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

  // 自分のファイルはキャッシュ優先。裏で新しいものを取ってきて次回に備える。
  e.respondWith(
    caches.match(req).then((hit) => {
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
