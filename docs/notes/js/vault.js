// 保管庫の目録と、リンク先の探し方。
//
// [[ノート名]] の探し方は Obsidian に合わせる：
//   - 「/」を含まなければファイル名だけで探す。同じ名前が複数あれば、
//     リンク元と同じフォルダ → パスが短いもの の順に選ぶ
//   - 「/」を含めば、パスの末尾が一致するものを探す
//   - 拡張子がなければ .md とみなす
export let items = [];       // walk() の結果そのまま
const byPath = new Map();    // 小文字のパス → item
const byName = new Map();    // 小文字のファイル名 → [item]

const low = (s) => s.normalize('NFC').toLowerCase();
export const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);
export const dirName = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
export const title = (p) => baseName(p).replace(/\.md$/i, '');
export const isNote = (p) => /\.md$/i.test(p);

export function load(list) {
  items = list;
  byPath.clear();
  byName.clear();
  for (const it of list) {
    if (it.isFolder) continue;
    byPath.set(low(it.path), it);
    const k = low(it.name);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(it);
  }
}

export const get = (path) => byPath.get(low(path)) || null;
export const notes = () => items.filter((it) => !it.isFolder && isNote(it.name));

export function upsert(it) {
  const old = get(it.path);
  if (old) Object.assign(old, it);
  else load(items.concat([it]));
}

// 相対パス（../a/b.md）を保管庫からのパスにする
export function joinPath(from, rel) {
  const parts = from ? from.split('/') : [];
  for (const seg of rel.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

export function resolve(target, fromPath = '') {
  let t = target.trim().replace(/^\/+/, '');
  if (!t) return null;
  const hasExt = /\.[A-Za-z0-9]{1,5}$/.test(t);
  const cands = hasExt ? [t, t + '.md'] : [t + '.md'];

  for (const c of cands) {
    if (c.includes('/')) {
      const exact = get(c) || get(joinPath(dirName(fromPath), c));
      if (exact) return exact;
      const tail = '/' + low(c);
      const hits = items.filter((it) => !it.isFolder && ('/' + low(it.path)).endsWith(tail));
      if (hits.length) return shortest(hits, fromPath);
    } else {
      const hits = byName.get(low(c));
      if (hits && hits.length) return shortest(hits, fromPath);
    }
  }
  return null;
}

function shortest(hits, fromPath) {
  const here = low(dirName(fromPath));
  const same = hits.find((it) => low(dirName(it.path)) === here);
  if (same) return same;
  return hits.slice().sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.length - b.path.length)[0];
}

// サイドバー用の木。{ name, path, folders: [...], files: [...] }
export function tree() {
  const root = { name: '', path: '', folders: new Map(), files: [] };
  const folder = (path) => {
    let node = root;
    if (!path) return node;
    let acc = '';
    for (const seg of path.split('/')) {
      acc = acc ? acc + '/' + seg : seg;
      if (!node.folders.has(seg)) node.folders.set(seg, { name: seg, path: acc, folders: new Map(), files: [] });
      node = node.folders.get(seg);
    }
    return node;
  };
  for (const it of items) {
    if (it.isFolder) folder(it.path);
    else if (isNote(it.name)) folder(dirName(it.path)).files.push(it);
  }
  const cmp = (a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true });
  const fin = (n) => ({
    name: n.name,
    path: n.path,
    folders: [...n.folders.values()].sort(cmp).map(fin),
    files: n.files.sort(cmp),
  });
  return fin(root);
}
