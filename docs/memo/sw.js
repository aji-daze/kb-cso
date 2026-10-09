// 画面一式をキャッシュし、2回目以降はネットワークを待たずに開く。
// 保存データは localStorage 側にあるのでここでは触らない。
const VERSION = 'memo-v9';
const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './sync.js',
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
      // 同じドメインの他のアプリのキャッシュは消さない（caches は共有）
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('memo-') && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;

  // キャッシュ優先。裏で新しいものを取ってきて次回に備える。
  // 画面そのもの（共有・ショートカットで ?text= などが付く）は './' の1件にまとめて持つ。
  const key = req.mode === 'navigate' ? './' : req;
  e.respondWith(
    caches.match(key, { ignoreSearch: true }).then((hit) => {
      const net = fetch(req)
        .then((res) => {
          if (res && res.ok) caches.open(VERSION).then((c) => c.put(key, res.clone()));
          return res;
        })
        .catch(() => hit);
      return hit || net;
    })
  );
});
