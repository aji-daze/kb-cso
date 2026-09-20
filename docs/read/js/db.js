// IndexedDB。ミュージックの db.js と同じ作りに寄せてある。
const NAME = 'shiori';
const VER = 2;
let _db = null;

export const STORES = {
  books:    { keyPath: 'id', idx: { status: 'status', added: 'added' } },
  files:    { keyPath: 'id' },
  marks:    { keyPath: 'id' },
  notes:    { keyPath: 'id', idx: { bookId: 'bookId', at: 'at' } },
  sessions: { keyPath: 'id', idx: { at: 'at', bookId: 'bookId' } },
  aozora:   { keyPath: 'id' },
  fonts:    { keyPath: 'id' },
  settings: { keyPath: 'k' },
};

export function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((ok, ng) => {
    const rq = indexedDB.open(NAME, VER);
    rq.onupgradeneeded = () => {
      const db = rq.result;
      for (const [name, def] of Object.entries(STORES)) {
        if (db.objectStoreNames.contains(name)) continue;
        const st = db.createObjectStore(name, { keyPath: def.keyPath });
        for (const [k, path] of Object.entries(def.idx || {})) st.createIndex(k, path);
      }
    };
    rq.onsuccess = () => { _db = rq.result; ok(_db); };
    rq.onerror = () => ng(rq.error);
  });
}

function tx(store, mode) {
  return open().then((db) => db.transaction(store, mode).objectStore(store));
}
function wrap(rq) {
  return new Promise((ok, ng) => { rq.onsuccess = () => ok(rq.result); rq.onerror = () => ng(rq.error); });
}

export const get = (s, k) => tx(s, 'readonly').then((o) => wrap(o.get(k)));
export const put = (s, v) => tx(s, 'readwrite').then((o) => wrap(o.put(v)));
export const del = (s, k) => tx(s, 'readwrite').then((o) => wrap(o.delete(k)));
export const all = (s) => tx(s, 'readonly').then((o) => wrap(o.getAll()));
export const count = (s) => tx(s, 'readonly').then((o) => wrap(o.count()));
export const clear = (s) => tx(s, 'readwrite').then((o) => wrap(o.clear()));

export function byIndex(s, idx, val) {
  return tx(s, 'readonly').then((o) => wrap(o.index(idx).getAll(val)));
}

// まとめ書き。青空文庫の索引のように件数が多いものはこちらで入れる。
export function putAll(s, rows, onProgress) {
  return open().then((db) => new Promise((ok, ng) => {
    const t = db.transaction(s, 'readwrite');
    const o = t.objectStore(s);
    let i = 0;
    for (const r of rows) {
      o.put(r);
      if (onProgress && ++i % 2000 === 0) onProgress(i, rows.length);
    }
    t.oncomplete = () => ok(rows.length);
    t.onerror = () => ng(t.error);
  }));
}

export async function setting(k, v) {
  if (v === undefined) {
    const row = await get('settings', k);
    return row ? row.v : undefined;
  }
  return put('settings', { k, v });
}

export function uid(prefix) {
  return (prefix || '') + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// 端末の保存領域を固定する（空きが減っても消されにくくなる）。
export async function persist() {
  if (!navigator.storage || !navigator.storage.persist) return null;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch { return null; }
}

export async function usage() {
  if (!navigator.storage || !navigator.storage.estimate) return null;
  try { return await navigator.storage.estimate(); } catch { return null; }
}
