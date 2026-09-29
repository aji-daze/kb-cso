// PC のフォルダを直接読み書きする（パソコンの Chrome／Edge だけ）。pomenote（pomera-tab）の localfs.js と同じ方式。
// File System Access API を使うので、Microsoft のサインインもアプリ登録も要らない。
// C:\Users\A.H\OneDrive\Obsidian を選べば、PC の OneDrive が雲へ上げ、スマホ・タブレット（OneDrive につなぐ方）からも見える。
//
// graph.js と同じ形の関数を出す（backend.js がどちらかを選んで使う）。
//   id   … 保管庫からのパス（'資料/設計.md'）
//   eTag … 最終更新時刻と大きさ。保存の直前に見比べ、Obsidian 側で書き換わっていれば Conflict にする
import * as DB from './db.js';
import { Conflict, Exists, NotFound } from './graph.js';

const MAX_BYTES = 5 * 1024 * 1024;
const fatal = new TextDecoder('utf-8', { fatal: true });

export const supported = () => typeof window.showDirectoryPicker === 'function';

let root = null; // 選んだフォルダ
let base = null; // 保管庫（選んだフォルダそのもの、または中の Obsidian など）
let sub = '';    // 選んだフォルダから保管庫までのパス

export class NeedPermission extends Error { constructor() { super('フォルダを使う許可が必要です'); } }

// フォルダの「入れ物」は暗号化できない（文字にできない）ので、鍵とは別に素の IndexedDB に置く。
// 中にあるのはフォルダ名だけで、ノートの中身は入っていない。
export const saved = () => DB.setting('folderHandle');
export const folderName = async () => {
  const h = await saved();
  const s = base ? sub : (await DB.setting('folderSub')) || '';
  return h ? h.name + (s ? '/' + s : '') : '';
};

// 選んだフォルダに .obsidian が無く、中に保管庫（例：Obsidian）があれば、そこを保管庫にする
async function findBase(dir, prefer) {
  const has = async (d, name) => { try { await d.getDirectoryHandle(name); return true; } catch { return false; } };
  if (await has(dir, '.obsidian')) return { dir, sub: '' };
  let d = dir;
  const segs = (prefer || '').split('/').filter(Boolean);
  try {
    for (const s of segs) d = await d.getDirectoryHandle(s);
    if (segs.length) return { dir: d, sub: segs.join('/') };
  } catch { /* 無い */ }
  for await (const [name, h] of dir.entries()) {
    if (h.kind === 'directory' && !name.startsWith('.') && (await has(h, '.obsidian'))) return { dir: h, sub: name };
  }
  return { dir, sub: '' };
}

// prefer：選んだフォルダが OneDrive そのものだったとき、中のどこを保管庫にするか（config の VAULT、例：'Obsidian'）
export async function pick(prefer) {
  const handle = await window.showDirectoryPicker({ id: 'notes-vault', mode: 'readwrite', startIn: 'documents' });
  await DB.setting('folderHandle', handle);
  await DB.setting('folderPrefer', prefer || '');
  root = handle;
  ({ dir: base, sub } = await findBase(handle, prefer));
  await DB.setting('folderSub', sub);
  return handle;
}

// ブラウザを起動し直すと許可が「確認」に戻る。request はボタンを押した直後だけ使える
export async function connect(request = false) {
  const h = await saved();
  if (!h) return false;
  const opts = { mode: 'readwrite' };
  let p = await h.queryPermission(opts);
  if (p !== 'granted' && request) p = await h.requestPermission(opts);
  if (p !== 'granted') return false;
  if (root !== h || !base) {
    root = h;
    ({ dir: base, sub } = await findBase(h, await DB.setting('folderPrefer')));
  }
  return true;
}

export async function forget() {
  await DB.setting('folderHandle', null);
  root = base = null;
  sub = '';
}

const need = () => { if (!base) throw new NeedPermission(); };
const notFound = (e) => e && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError');

async function locate(path, create = false) {
  need();
  const parts = path.split('/').filter(Boolean);
  const name = parts.pop();
  let dir = base;
  for (const p of parts) dir = await dir.getDirectoryHandle(p, { create });
  return { dir, name };
}

async function fileAt(path) {
  try {
    const { dir, name } = await locate(path);
    return await (await dir.getFileHandle(name)).getFile();
  } catch (e) {
    if (notFound(e)) return null;
    throw e;
  }
}

const tag = (f) => f.lastModified + ':' + f.size;
const pick1 = (path, f) => ({
  id: path, path, name: path.slice(path.lastIndexOf('/') + 1), isFolder: false,
  eTag: tag(f), size: f.size, mtime: new Date(f.lastModified).toISOString(), url: '',
});

// 保管庫を全部たどる。. で始まるもの（.obsidian / .trash / .git）は Obsidian も見ないので飛ばす
export async function walk(_vault, onProgress) {
  need();
  const out = [];
  const go = async (dir, prefix) => {
    for await (const [name, h] of dir.entries()) {
      if (name.startsWith('.')) continue;
      const path = prefix + name;
      if (h.kind === 'directory') {
        out.push({ id: path, path, name, isFolder: true, eTag: '', size: 0, mtime: '', url: '' });
        await go(h, path + '/');
      } else {
        out.push(pick1(path, await h.getFile()));
      }
      if (onProgress && out.length % 50 === 0) onProgress(out.length);
    }
  };
  await go(base, '');
  return out;
}

export async function meta(id) {
  const f = await fileAt(id);
  if (!f) throw new NotFound();
  return pick1(id, f);
}

export async function readText(id) {
  const f = await fileAt(id);
  if (!f) throw new NotFound();
  if (f.size > MAX_BYTES) throw new Error('大きすぎるファイルは開けません（5MB まで）');
  let text;
  try { text = fatal.decode(await f.arrayBuffer()); } catch { throw new Error('UTF-8 でないファイルは開けません'); }
  return { text, eTag: tag(f), item: pick1(id, f) };
}

export async function readBlob(id) {
  const f = await fileAt(id);
  if (!f) throw new NotFound();
  return f;
}

async function put(path, text) {
  const { dir, name } = await locate(path, true);
  const h = await dir.getFileHandle(name, { create: true });
  const w = await h.createWritable();
  await w.write(text);
  await w.close();
  return pick1(path, await h.getFile());
}

// 読んだときの版（eTag）のままのときだけ書く。Obsidian 側で書き換わっていれば Conflict
export async function writeText(id, text, eTag) {
  const f = await fileAt(id);
  if (f && eTag && tag(f) !== eTag) {
    // 時刻だけ変わって中身が同じ（OneDrive が入れ直した等）なら、競合にしない
    let now = null;
    try { now = fatal.decode(await f.arrayBuffer()); } catch { /* 読めなければ競合扱い */ }
    if (now !== text) throw new Conflict();
    return pick1(id, f);
  }
  return put(id, text);
}

export async function createText(path, text) {
  if (await fileAt(path)) throw new Exists();
  return put(path, text);
}

// 本文検索：PC の中なので全部読んでも速い
export async function search(q) {
  const k = q.toLowerCase();
  const hits = [];
  for (const it of await walk()) {
    if (it.isFolder || !/\.md$/i.test(it.path)) continue;
    try { if ((await readText(it.id)).text.toLowerCase().includes(k)) hits.push(it.id); } catch { /* 読めないものは飛ばす */ }
  }
  return hits;
}
