// IndexedDB。栞・ミュージックの db.js と同じ作りに寄せてある。
//
// settings : 設定と、認証の更新用トークン
// files    : 開いたノートの本文の控え（電波がなくても読めるように）。{ path, text, eTag, at }
// drafts   : OneDrive にまだ送れていない書きかけ。{ path, text, baseETag, id, at }
const NAME = 'notes';
const VER = 1;
let _db = null;

export const STORES = {
  settings: { keyPath: 'k' },
  files:    { keyPath: 'path' },
  drafts:   { keyPath: 'path' },
};

export function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((ok, ng) => {
    const rq = indexedDB.open(NAME, VER);
    rq.onupgradeneeded = () => {
      const db = rq.result;
      for (const [name, def] of Object.entries(STORES)) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: def.keyPath });
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

export const get = (store, key) => tx(store, 'readonly').then((s) => wrap(s.get(key)));
export const all = (store) => tx(store, 'readonly').then((s) => wrap(s.getAll()));
export const put = (store, val) => tx(store, 'readwrite').then((s) => wrap(s.put(val)));
export const del = (store, key) => tx(store, 'readwrite').then((s) => wrap(s.delete(key)));
export const clear = (store) => tx(store, 'readwrite').then((s) => wrap(s.clear()));

// setting(k) で読む、setting(k, v) で書く。v に null を渡すと消す。
export async function setting(k, v) {
  if (v === undefined) {
    const r = await get('settings', k);
    return r ? r.v : undefined;
  }
  if (v === null) return del('settings', k);
  return put('settings', { k, v });
}
