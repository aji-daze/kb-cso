// 端末のフォルダを開いて、その中の本を取り込む。
//
// OneDrive・Google ドライブ・Dropbox は、PC では同期フォルダとして端末の中にある。
// ならクラウドの API を通す必要はなく、そのフォルダを直接開けばいい。認証も要らない。
//
// File System Access API を使うと、**一度選んだフォルダを覚えておける**。
// 次に開いたときは選び直さずに中を読めるので、同期で増えた本がそのまま出てくる。
// この API が無い端末（iOS / Safari）では、一回きりのフォルダ選択に落とす。
import * as DB from './db.js';

const KEY = 'folderHandle';
const NAME_KEY = 'folderName';

export const supported = () => typeof window.showDirectoryPicker === 'function';

export const BOOK_EXT = /\.(epub|md|markdown|txt|text)$/i;

export async function pick() {
  if (!supported()) throw new Error('この端末のブラウザはフォルダを覚えられません');
  const handle = await window.showDirectoryPicker({ id: 'pocha-books', mode: 'read' });
  await DB.setting(KEY, handle);
  await DB.setting(NAME_KEY, handle.name);
  return handle;
}

export async function savedName() { return DB.setting(NAME_KEY); }

// 覚えてあるフォルダを返す。権限が切れていたら null（呼ぶ側が pick し直す）。
export async function saved({ ask = false } = {}) {
  const handle = await DB.setting(KEY);
  if (!handle || !handle.queryPermission) return null;
  let st = await handle.queryPermission({ mode: 'read' });
  if (st === 'prompt' && ask) st = await handle.requestPermission({ mode: 'read' });
  return st === 'granted' ? handle : null;
}

export async function needsPermission() {
  const handle = await DB.setting(KEY);
  if (!handle || !handle.queryPermission) return false;
  return (await handle.queryPermission({ mode: 'read' })) === 'prompt';
}

export async function forget() {
  await DB.del('settings', KEY);
  await DB.del('settings', NAME_KEY);
}

// 中を再帰的に辿って本のファイルを集める。パスも返す（重複を弾くのに使う）。
export async function scan(handle, onStep, max = 4000) {
  const out = [];
  const walk = async (dir, path, depth) => {
    if (out.length >= max || depth > 8) return;
    for await (const [name, h] of dir.entries()) {
      if (out.length >= max) return;
      if (name.startsWith('.')) continue;
      const p = path ? path + '/' + name : name;
      if (h.kind === 'directory') { await walk(h, p, depth + 1); continue; }
      if (!BOOK_EXT.test(name)) continue;
      out.push({ name, path: p, handle: h });
      if (onStep && out.length % 25 === 0) onStep(out.length);
    }
  };
  await walk(handle, '', 0);
  out.sort((a, b) => a.path.localeCompare(b.path, 'ja'));
  return out;
}

export const read = (entry) => entry.handle.getFile();
