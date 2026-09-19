// アプリ本体をキャッシュして、電波がなくても起動できるようにする。
// 曲のデータは IndexedDB 側に入っているのでここでは扱わない。
const VERSION = 'music-v18';
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

// アイコンをテーマ・アクセントに合わせて差し替える。
// manifest.json や icons/*.png の URL 自体は変えず、返す中身だけを IndexedDB に
// 保存してある Blob に差し替える（ホーム画面アイコンは追加時に焼き付くため、
// 中身が変わったときだけ更新が効く）。
const ICON_SETTING_BY_PATH = {
  '/icons/icon-192.png': 'icon192',
  '/icons/icon-512.png': 'icon512',
  '/icons/icon-maskable-512.png': 'iconMask512',
  '/icons/apple-touch-icon.png': 'icon512',
};
function iconSettingKeyFor(pathname) {
  for (const suffix in ICON_SETTING_BY_PATH) {
    if (pathname.endsWith(suffix)) return ICON_SETTING_BY_PATH[suffix];
  }
  return null;
}

// SW からは import が使えないので、ここだけで完結する小さな読み出し関数を用意する。
// バージョンを指定せずに開く（不用意に onupgradeneeded を走らせて DB を作り替えないため）。
// DB がまだ無い場合は、新規作成の版上げごと中止して「無い」扱いにする。
function readIconBlobFromDb(settingKey) {
  return new Promise((resolve) => {
    let req;
    try {
      req = indexedDB.open('kbmusic');
    } catch (e) {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      try {
        req.transaction.abort(); // DB がまだ無い＝ SW からは作らない
      } catch (e) {
        /* noop */
      }
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
    req.onsuccess = () => {
      const db = req.result;
      try {
        if (!db.objectStoreNames.contains('settings')) {
          db.close();
          resolve(null);
          return;
        }
        const t = db.transaction('settings', 'readonly');
        const r = t.objectStore('settings').get(settingKey);
        r.onsuccess = () => {
          db.close();
          resolve(r.result || null);
        };
        r.onerror = () => {
          db.close();
          resolve(null);
        };
      } catch (e) {
        try {
          db.close();
        } catch (e2) {
          /* noop */
        }
        resolve(null);
      }
    };
  });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Google の API などは素通し

  // アイコンだけは特別扱い。取れなければ必ず従来どおりの処理（キャッシュ優先＋裏で更新）に落ちる。
  const iconSettingKey = iconSettingKeyFor(url.pathname);
  if (iconSettingKey) {
    e.respondWith(
      (async () => {
        try {
          const blob = await readIconBlobFromDb(iconSettingKey);
          if (blob && blob.size > 0) {
            return new Response(blob, { headers: { 'content-type': 'image/png', 'cache-control': 'no-cache' } });
          }
        } catch (err) {
          /* 何かあっても下の fallback に必ず落ちる */
        }
        const hit = await caches.match(req);
        const fresh = fetch(hit ? new Request(req.url, { cache: 'no-cache' }) : req)
          .then((res) => save(req, res))
          .catch(() => hit);
        return hit || fresh;
      })()
    );
    return;
  }

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

// 取り込みの進捗・完了通知をタップしたら、開いているタブがあればそれを前面に出し、無ければ新しく開く
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./');
    })
  );
});
