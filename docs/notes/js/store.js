// 端末に置くものの出し入れ。db.js と同じ呼び方で、中身は lock.js の鍵で暗号化して入れる。
// files / drafts はノートのパスも伏せる（索引は HMAC、パスは暗号文の中）。
import * as DB from './db.js';
import * as L from './lock.js';

export async function get(store, path) {
  const r = await DB.get(store, await L.id(path));
  return r ? L.decrypt(r) : undefined;
}
export async function put(store, obj) {
  return DB.put(store, { path: await L.id(obj.path), ...(await L.encrypt(obj)) });
}
export async function del(store, path) {
  return DB.del(store, await L.id(path));
}
export async function all(store) {
  const rows = await DB.all(store);
  const out = [];
  for (const r of rows) {
    try { out.push(await L.decrypt(r)); } catch { /* 壊れた行は読まない */ }
  }
  return out;
}
export const clear = DB.clear;

export async function setting(k, v) {
  if (v === undefined) {
    const r = await DB.get('settings', 'x.' + k);
    if (!r) return undefined;
    try { return await L.decrypt(r.v); } catch { return undefined; }
  }
  if (v === null) return DB.del('settings', 'x.' + k);
  return DB.put('settings', { k: 'x.' + k, v: await L.encrypt(v) });
}
