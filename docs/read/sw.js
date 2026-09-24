// アプリ本体のキャッシュ。本の中身は扱わない（IndexedDB にある）。
// 画面を直したら VERSION を上げる。上げ忘れると古い画面が残る。
const VERSION = 'pocha-v1.7.0';
const ASSETS = [
  './', './index.html', './style.css', './manifest.json',
  './js/app.js', './js/db.js', './js/zip.js', './js/md.js', './js/epub.js',
  './js/aozora.js', './js/quotes.js', './js/font.js', './js/drive.js', './js/onedrive.js', './js/folder.js', './js/paper.js', './js/pager.js', './js/notes.js', './js/stats.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/character.png', './art/bear.png', './art/bear.webp',
  './icons/apple-touch-icon.png', './icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // 青空文庫などの外部取得はキャッシュしない（本文は IndexedDB に入れる）
  if (url.origin !== location.origin) return;

  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) {
        // 裏で新しい版を取っておく
        fetch(req).then((res) => {
          if (res && res.ok) caches.open(VERSION).then((c) => c.put(req, res.clone()));
        }).catch(() => {});
        return hit;
      }
      return fetch(req).then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => {
        // オフラインでの取得失敗時、index.html を返すのはナビゲーション要求だけにする。
        // 画像・JS・CSS などにまで返すと、キャッシュに無い物を取りに行ったときに
        // HTML が代わりに返り、モジュールなら構文エラー、画像なら壊れた表示になる。
        if (req.mode === 'navigate') return caches.match('./index.html');
        return Response.error();
      });
    })
  );
});
