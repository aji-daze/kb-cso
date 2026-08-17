// アプリ本体をキャッシュして、電波がなくても起動できるようにする。
// 曲のデータは IndexedDB 側に入っているのでここでは扱わない。
const VERSION = 'music-v4';
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
    caches
      .open(VERSION)
      // cache:'reload' でブラウザの HTTP キャッシュを迂回する。
      // これをやらないと、更新したのに古いファイルを取り込んでしまう。
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

function save(req, res) {
  if (res && res.ok && res.type === 'basic') {
    const copy = res.clone();
    caches.open(VERSION).then((c) => c.put(req, copy));
  }
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Google の API などは素通し

  // ページ本体と manifest は更新を見逃したくないのでネットワーク優先。
  // （ここをキャッシュ優先にすると、アプリを更新しても古い版を掴み続ける）
  if (req.mode === 'navigate' || url.pathname.endsWith('/manifest.json')) {
    e.respondWith(
      fetch(req)
        .then((res) => save(req, res))
        .catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html') || caches.match('./')))
    );
    return;
  }

  // それ以外はキャッシュ優先＋裏で更新（更新分は次回の起動で反映される）
  e.respondWith(
    caches.match(req).then((hit) => {
      const fresh = fetch(hit ? new Request(req.url, { cache: 'no-cache' }) : req)
        .then((res) => save(req, res))
        .catch(() => hit);
      return hit || fresh;
    })
  );
});
