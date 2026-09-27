// OneDrive の読み書き（Microsoft Graph）。
//
// 同期はしない。開くたびに OneDrive 上のファイルを直接読み、保存するたびに直接書く。
// 書くときは読んだときの版（eTag）を If-Match で添える。その間に PC の Obsidian などが
// 書き換えていれば OneDrive が 412 で断ってくるので、黙って上書きすることはない。
import { getToken } from './auth.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const SELECT = 'id,name,eTag,size,lastModifiedDateTime,folder,file,@microsoft.graph.downloadUrl';

export class NeedSignIn extends Error { constructor() { super('サインインが必要です'); } }
export class Conflict extends Error { constructor() { super('OneDrive 側で先に書き換えられています'); } }
export class Exists extends Error { constructor() { super('同じ名前のファイルがもうあります'); } }
export class NotFound extends Error { constructor() { super('OneDrive にファイルが見つかりません'); } }

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// パスを root:/a/b.md: の形にする。区切りごとに符号化しないと # や ? で壊れる。
export const pathRef = (p) => '/me/drive/root:/' + p.split('/').filter(Boolean).map(encodeURIComponent).join('/') + ':';

async function call(url, opt = {}, tries = 0) {
  const tk = await getToken(tries > 0);
  if (!tk) throw new NeedSignIn();
  const r = await fetch(url.startsWith('http') ? url : GRAPH + url, {
    ...opt,
    headers: { ...(opt.headers || {}), Authorization: 'Bearer ' + tk },
  });
  if (r.status === 401 && tries === 0) return call(url, opt, 1);
  if (r.status === 401) throw new NeedSignIn();
  if ((r.status === 429 || r.status === 503) && tries < 3) {
    await wait(Math.min(30, Number(r.headers.get('Retry-After')) || 2 ** (tries + 1)) * 1000);
    return call(url, opt, tries + 1);
  }
  if (r.status === 412) throw new Conflict();
  if (r.status === 409) throw new Exists();
  if (r.status === 404) throw new NotFound();
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error('OneDrive: ' + ((j.error && j.error.message) || ('HTTP ' + r.status)));
  }
  return r.status === 204 ? null : r.json();
}

const pick = (it) => ({
  id: it.id,
  name: it.name,
  isFolder: !!it.folder,
  eTag: it.eTag || '',
  size: Number(it.size || 0),
  mtime: it.lastModifiedDateTime || '',
  url: it['@microsoft.graph.downloadUrl'] || '',
});

// 1つのフォルダの中身。path は OneDrive の一番上からのパス（'' なら一番上）。
export async function children(path) {
  let url = (path ? pathRef(path) : '/me/drive/root') + '/children?$top=999&$select=' + SELECT;
  const out = [];
  while (url) {
    const j = await call(url);
    for (const it of j.value || []) out.push(pick(it));
    url = j['@odata.nextLink'] || '';
  }
  return out;
}

// 保管庫の中を全部たどる。. で始まるもの（.obsidian / .trash / .git）は Obsidian も見ないので飛ばす。
// 返すパスは保管庫からの相対パス。
export async function walk(vault, onProgress) {
  const out = [];
  const queue = [''];
  let active = 0;
  let failed = null;
  await new Promise((done) => {
    const pump = () => {
      if (failed || (!queue.length && !active)) return done();
      while (queue.length && active < 4) {
        const rel = queue.shift();
        active++;
        children(vault + (rel ? '/' + rel : ''))
          .then((items) => {
            for (const it of items) {
              if (it.name.startsWith('.')) continue;
              it.path = rel ? rel + '/' + it.name : it.name;
              out.push(it);
              if (it.isFolder) queue.push(it.path);
            }
            if (onProgress) onProgress(out.length);
          })
          .catch((e) => { failed = e; })
          .finally(() => { active--; pump(); });
      }
    };
    pump();
  });
  if (failed) throw failed;
  return out;
}

export const meta = (id) => call('/me/drive/items/' + encodeURIComponent(id) + '?$select=' + SELECT).then(pick);

async function fetchUrl(url) {
  // downloadUrl は署名済みの一時 URL。ここに Authorization を付けると逆に弾かれる。
  const r = await fetch(url);
  if (!r.ok) throw new Error('ダウンロード失敗: ' + r.status);
  return r;
}

// 本文と、その本文の版（eTag）を返す。版を先に取ってから中身を取るので、
// 間に書き換えがあっても「古い版の番号で新しい中身」にはならない（逆はありうるが、それは保存時に 412 で分かる）。
export async function readText(id) {
  const m = await meta(id);
  if (!m.url && m.size === 0) return { text: '', eTag: m.eTag, item: m }; // 空のファイル
  const r = await fetchUrl(m.url);
  return { text: await r.text(), eTag: m.eTag, item: m };
}

export async function readBlob(id) {
  const m = await meta(id);
  return (await fetchUrl(m.url)).blob();
}

// 上書き保存。eTag が OneDrive 側と違えば Conflict を投げる。
export async function writeText(id, text, eTag) {
  const headers = { 'Content-Type': 'text/markdown; charset=utf-8' };
  if (eTag) headers['If-Match'] = eTag;
  return pick(await call('/me/drive/items/' + encodeURIComponent(id) + '/content', { method: 'PUT', headers, body: text }));
}

// 新しいファイル。同名があれば Exists を投げる。
export async function createText(fullPath, text) {
  return pick(await call(pathRef(fullPath) + '/content?@microsoft.graph.conflictBehavior=fail', {
    method: 'PUT',
    headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
    body: text,
  }));
}

// OneDrive 全体を検索する（保管庫の外も返るので、呼んだ側で絞る）。
export async function search(q) {
  const j = await call("/me/drive/root/search(q='" + encodeURIComponent(q.replace(/'/g, "''")) + "')?$top=100&$select=id,name");
  return (j.value || []).map((it) => it.id);
}
