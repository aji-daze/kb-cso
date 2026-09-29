// 画面一式をキャッシュして、電波がなくても開けるようにする。
// ノートの本文は IndexedDB 側にあるのでここでは触らない。OneDrive への通信（別オリジン）にも触らない。
const VERSION = 'notes-v5';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './manifest.json',
  './config.js',
  './js/app.js',
  './js/auth.js',
  './js/db.js',
  './js/graph.js',
  './js/render.js',
  './js/vault.js',
  './js/reader.js',
  './js/lock.js',
  './js/store.js',
  './vendor/editor.js',
  './vendor/marked.js',
  './vendor/purify.js',
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

  // 画面の読み込みは、サインインから戻ったとき ?code=…、共有から来たとき ?text=… が付く。
  // 付いたまま控えないよう、画面そのものは常に index.html として扱う。
  const key = req.mode === 'navigate' ? new Request('./index.html') : req;

  // 電波があれば新しいものを優先する（古い画面と新しい画面の部品が混ざらないように）。
  // 3 秒で返ってこなければ控えを出す。電波がなければ控えだけで動く。
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(key);
    const net = fetch(req, { cache: 'no-cache' }).then((res) => {
      if (res && res.ok) cache.put(key, res.clone());
      return res;
    });
    if (!hit) return net;
    const late = new Promise((r) => setTimeout(() => r(hit), 3000));
    return Promise.race([net.catch(() => hit), late]);
  })());
});
