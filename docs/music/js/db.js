// IndexedDB ラッパー。曲のメタ情報・音声ファイル実体・ジャケット・プレイリスト・設定を保存する。
const NAME = 'kbmusic';
const VER = 1;

let dbp = null;

function openDB() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(NAME, VER);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains('tracks')) {
        const s = db.createObjectStore('tracks', { keyPath: 'id' });
        s.createIndex('albumKey', 'albumKey');
        s.createIndex('artistKey', 'artistKey');
        s.createIndex('addedAt', 'addedAt');
        s.createIndex('fp', 'fp', { unique: false });
      }
      // 音声の実体。キーは track.id
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
      // ジャケット画像。キーは albumKey もしくは 'track:<id>'
      if (!db.objectStoreNames.contains('art')) db.createObjectStore('art');
      if (!db.objectStoreNames.contains('playlists')) db.createObjectStore('playlists', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}

function req(r) {
  return new Promise((res, rej) => {
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export async function get(store, key) {
  const db = await openDB();
  return req(db.transaction(store).objectStore(store).get(key));
}

export async function getAll(store) {
  const db = await openDB();
  return req(db.transaction(store).objectStore(store).getAll());
}

export async function getAllKeys(store) {
  const db = await openDB();
  return req(db.transaction(store).objectStore(store).getAllKeys());
}

export async function put(store, value, key) {
  const db = await openDB();
  const t = db.transaction(store, 'readwrite');
  const p = req(key === undefined ? t.objectStore(store).put(value) : t.objectStore(store).put(value, key));
  return p;
}

export async function del(store, key) {
  const db = await openDB();
  const t = db.transaction(store, 'readwrite');
  return req(t.objectStore(store).delete(key));
}

export async function has(store, key) {
  const db = await openDB();
  const n = await req(db.transaction(store).objectStore(store).count(key));
  return n > 0;
}

export async function clear(store) {
  const db = await openDB();
  const t = db.transaction(store, 'readwrite');
  return req(t.objectStore(store).clear());
}

// 1トラック分（メタ + 実体 + ジャケット）をまとめて1トランザクションで書く。
export async function addTrack(track, blob, art) {
  const db = await openDB();
  const stores = art ? ['tracks', 'blobs', 'art'] : ['tracks', 'blobs'];
  const t = db.transaction(stores, 'readwrite');
  t.objectStore('tracks').put(track);
  t.objectStore('blobs').put(blob, track.id);
  if (art) t.objectStore('art').put(art, track.artId);
  return new Promise((res, rej) => {
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}

export async function deleteTracks(ids) {
  const db = await openDB();
  const t = db.transaction(['tracks', 'blobs'], 'readwrite');
  for (const id of ids) {
    t.objectStore('tracks').delete(id);
    t.objectStore('blobs').delete(id);
  }
  return new Promise((res, rej) => {
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}

// 設定は key/value でそのまま保存
const settingsCache = new Map();

export async function loadSettings() {
  const db = await openDB();
  const t = db.transaction('settings');
  const s = t.objectStore('settings');
  const keys = await req(s.getAllKeys());
  const vals = await req(s.getAll());
  settingsCache.clear();
  keys.forEach((k, i) => settingsCache.set(k, vals[i]));
  return settingsCache;
}

export function setting(key, fallback) {
  return settingsCache.has(key) ? settingsCache.get(key) : fallback;
}

export async function setSetting(key, value) {
  settingsCache.set(key, value);
  return put('settings', value, key);
}

export async function estimate() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  try {
    return await navigator.storage.estimate();
  } catch {
    return null;
  }
}

// ブラウザに「このデータは消さないで」と伝える。オフライン前提なので重要。
export async function persist() {
  if (!navigator.storage || !navigator.storage.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
