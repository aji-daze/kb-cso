// 端末のフォルダを開いて、その中の本を取り込む。
//
// OneDrive・Google ドライブ・Dropbox は、PC では同期フォルダとして端末の中にある。
// ならクラウドの API を通す必要はなく、そのフォルダを直接開けばいい。トークンも要らない。
//
// 作法は pomera-tab の localfs.js に合わせてある（同じ OneDrive フォルダを
// 両方のアプリから開くので、除外するフォルダや許可の扱いがズレると混乱するため）。
// 違いは、こちらは読むだけ（mode: 'read'）で書き戻さないこと。
import * as DB from './db.js';

const KEY = 'folderHandle';
const NAME_KEY = 'folderName';
const META_KEY = 'folderMeta';

export const supported = () => typeof window.showDirectoryPicker === 'function';

export const BOOK_EXT = /\.(epub|md|markdown|txt|text|zip)$/i;
const TEXT_EXT = /\.(md|markdown|txt|text)$/i;
export const MAX_BYTES = 40 * 1024 * 1024;      // EPUB は大きいので広めに取る
const MAX_TEXT_BYTES = 5 * 1024 * 1024;         // 素のテキストがこれを超えるのは本ではない

// pomera-tab の DEFAULT_EXCLUDE と同じ。どの階層でも、この名前のフォルダは見ない。
export const DEFAULT_EXCLUDE = [
  'Personal Vault', 'Microsoft Copilot Chat ファイル', 'アプリ',
  'Desktop', '画像', '動画', 'music',
];

export const getHandle = () => DB.setting(KEY);
export const savedName = () => DB.setting(NAME_KEY);

export async function pickFolder() {
  if (!supported()) throw new Error('この端末のブラウザはフォルダを覚えられません');
  // 読むだけでなく書き込みも許可してもらう。取り込んだ本をこのフォルダへ複製し、
  // OneDrive の同期で他の端末にも届けるため。
  const handle = await window.showDirectoryPicker({ id: 'pocha-books', mode: 'readwrite', startIn: 'documents' });
  // 別のフォルダに変えたなら、覚えていた更新日時などは捨てる
  const prev = await getHandle();
  if (!prev || !(await prev.isSameEntry(handle))) await DB.setting(META_KEY, {});
  await DB.setting(KEY, handle);
  await DB.setting(NAME_KEY, handle.name);
  return handle;
}

// ブラウザを開き直すと許可が「確認」に戻ることがある。
// request はボタンを押した直後など、ユーザー操作のときだけ true にする。
export async function permission(handle, request = false, mode = 'read') {
  if (!handle) return false;
  // queryPermission を持たないハンドル（ブラウザ内の領域など）は、許可を聞く先が無い＝そのまま使える
  if (!handle.queryPermission) return true;
  const opts = { mode };
  let p = await handle.queryPermission(opts);
  if (p !== 'granted' && request) p = await handle.requestPermission(opts);
  return p === 'granted';
}

// 書き込みまで許されているか
export async function canWrite(ask = false) {
  const handle = await getHandle();
  if (!handle) return false;
  return permission(handle, ask, 'readwrite');
}

export async function saved({ ask = false } = {}) {
  const handle = await getHandle();
  if (!handle) return null;
  return (await permission(handle, ask)) ? handle : null;
}

export async function needsPermission() {
  const handle = await getHandle();
  if (!handle || !handle.queryPermission) return false;
  return (await handle.queryPermission({ mode: 'read' })) === 'prompt';
}

// 取り込んだ本をフォルダへ複製する。OneDrive が同期して他の端末にも届く。
// 同じ名前があれば「名前 (2).拡張子」にして、既存のファイルは壊さない。
export async function saveInto(name, blob, { sub = '' } = {}) {
  const root = await getHandle();
  if (!root) throw new Error('保存先のフォルダが選ばれていません');
  if (!(await permission(root, false, 'readwrite'))) {
    const e = new Error('フォルダへの書き込みが許可されていません');
    e.needPermission = true;
    throw e;
  }
  let dir = root;
  for (const part of String(sub).split('/').filter(Boolean)) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  const m = String(name).match(/^(.*?)(\.[^.]*)?$/);
  const stem = m[1] || 'book';
  const ext = m[2] || '';
  let fname = stem + ext;
  for (let k = 2; ; k++) {
    try { await dir.getFileHandle(fname); } catch (e) {
      if (e && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError')) break;
      throw e;
    }
    fname = stem + ' (' + k + ')' + ext;
    if (k > 50) break;
  }
  const fh = await dir.getFileHandle(fname, { create: true });
  const w = await fh.createWritable();
  await w.write(blob);
  await w.close();
  return (sub ? sub + '/' : '') + fname;
}

export async function forget() {
  await DB.del('settings', KEY);
  await DB.del('settings', NAME_KEY);
  await DB.del('settings', META_KEY);
}

// 中を辿って本のファイルを集める。ここでは中身を読まない（フォルダが大きいと遅くなるため）。
// 更新日時と大きさは覚えておいて、PC 側で書き換えられた本を見分けるのに使う。
export async function scan(handle, onStep, { exclude = DEFAULT_EXCLUDE, max = 4000 } = {}) {
  const skip = new Set(exclude);
  const out = [];
  const walk = async (dir, path, depth) => {
    if (out.length >= max || depth > 8) return;
    for await (const [name, h] of dir.entries()) {
      if (out.length >= max) return;
      if (name.startsWith('.')) continue;          // .obsidian・.trash など
      if (h.kind === 'directory') {
        if (!skip.has(name)) await walk(h, path ? path + '/' + name : name, depth + 1);
        continue;
      }
      if (!BOOK_EXT.test(name)) continue;
      const p = path ? path + '/' + name : name;
      let file = null;
      try { file = await h.getFile(); } catch { continue; }
      if (file.size > MAX_BYTES) continue;
      out.push({ name, path: p, handle: h, size: file.size, mtime: file.lastModified });
      if (onStep && out.length % 25 === 0) onStep(out.length);
    }
  };
  await walk(handle, '', 0);
  out.sort((a, b) => a.path.localeCompare(b.path, 'ja'));
  return out;
}

export const meta = () => DB.setting(META_KEY).then((m) => m || {});
export async function remember(entries) {
  const m = await meta();
  for (const e of entries) m[e.path] = { m: e.mtime, s: e.size };
  await DB.setting(META_KEY, m);
}

export async function read(entry) {
  const file = await entry.handle.getFile();
  // 文字コードはここで決めない。青空文庫のテキストは Shift_JIS なので、
  // UTF-8 でないものを弾くと読めなくなる（取り込み側で判別する）。
  if (TEXT_EXT.test(entry.name) && file.size > MAX_TEXT_BYTES) {
    throw new Error('テキストとしては大きすぎます');
  }
  return file;
}
