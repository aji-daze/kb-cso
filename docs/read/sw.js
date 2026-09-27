// アプリ本体のキャッシュ。本の中身は扱わない（IndexedDB にある）。
// 画面を直したら VERSION を上げる。上げ忘れると古い画面が残る。
const VERSION = 'pocha-v1.10.0';
const SHARE_CACHE = 'pocha-share';   // Android の共有シートから受け取ったファイルの一時置き場
const ASSETS = [
  './', './index.html', './style.css', './manifest.json',
  './js/app.js', './js/db.js', './js/zip.js', './js/md.js', './js/epub.js',
  './js/aozora.js', './js/quotes.js', './js/cover.js', './js/font.js', './js/drive.js', './js/onedrive.js', './js/folder.js', './js/paper.js', './js/pager.js', './js/notes.js', './js/stats.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/character.png', './art/bear.png', './art/bear.webp',
  './icons/apple-touch-icon.png', './icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      // 共有の一時置き場（SHARE_CACHE）は版が変わっても消さない
      .then((ks) => Promise.all(ks.filter((k) => k !== VERSION && k !== SHARE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Android の共有シートから「ぽちゃ文庫」を選んだときの受け口。
// manifest.json の share_target は action:"./"（=スコープ直下）に POST で来る。
// ここで横取りして、送られてきたファイルを Cache に置き、?share=1 へ 303 リダイレクトする
// （リダイレクト先は普通の GET なので、静的配信のままで受け取れる。OS2-02）。
async function handleShare(req) {
  try {
    const form = await req.formData();
    const files = form.getAll('file').filter((f) => f && typeof f.size === 'number' && f.size > 0);
    const cache = await caches.open(SHARE_CACHE);
    // 前回ぶんが残っていたら消す（取り込み側が空にし忘れたときの保険）
    for (const k of await cache.keys()) await cache.delete(k);
    if (files.length) {
      await cache.put('./__share__/index', new Response(JSON.stringify({ n: files.length }),
        { headers: { 'Content-Type': 'application/json' } }));
      for (let i = 0; i < files.length; i++) {
        await cache.put('./__share__/file-' + i, new Response(files[i],
          { headers: { 'Content-Type': files[i].type || 'application/octet-stream',
            'X-Share-Filename': encodeURIComponent(files[i].name || ('共有された本' + i)) } }));
      }
    }
  } catch (e) { /* フォームが読めなくても、まずは画面に戻す */ }
  return Response.redirect('./?share=1', 303);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  if (req.method === 'POST') {
    const scope = new URL(self.registration.scope).pathname;
    if (url.origin === location.origin && (url.pathname === scope || url.pathname === scope + 'index.html')) {
      e.respondWith(handleShare(req));
    }
    return;   // 共有以外の POST には触らない（素通り）
  }
  if (req.method !== 'GET') return;
  // 青空文庫などの外部取得はキャッシュしない（本文は IndexedDB に入れる）
  // 外の取得（書影の画像も含む）はここでは覚えない。
  // CORS の無い画像を Cache に入れると、Chrome は1件あたり数MBとして容量を数えるため、
  // 本を入れている IndexedDB の容量を食う。書影は取り込めるものは Blob で IndexedDB に持つ。
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
