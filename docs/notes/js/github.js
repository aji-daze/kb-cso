// GitHub の非公開リポジトリ（pomera-data）を直接読み書きする。pomenote（pomera-tab）のタブレット側と同じ方式。
// リポジトリの中身は PC の OneDrive と同じ並び（Obsidian/… に保管庫）で、PC の同期（pomera_sync.py）が
// OneDrive ⇄ GitHub をそろえる。ここで保存したものは、PC の同期で C:\Users\A.H\OneDrive\Obsidian に届く。
//
// graph.js と同じ形の関数を出す（backend.js が選んで使う）。
//   id   … 保管庫からのパス（'pvo/小説/第一章.md'）
//   eTag … git の blob sha。保存のときに添え、GitHub 側で書き換わっていれば 409 → Conflict
// 読み書きには、リポジトリの「Contents: Read and write」だけを許したトークン（fine-grained）を使う。
// pomenote で使っているトークンをそのまま使ってよい。トークンは端末の中でパスワードで暗号化して置く。
import { Conflict, Exists, NotFound } from './graph.js';

const API = 'https://api.github.com';
const enc = new TextEncoder();
const dec = new TextDecoder();

let cfg = { owner: '', repo: '', branch: 'main', root: '', token: '' };

export class BadToken extends Error { constructor(m) { super(m || 'GitHub のトークンが無効か期限切れです'); } }

export function configure(c) { cfg = { ...cfg, ...c, root: (c.root ?? cfg.root ?? '').replace(/^\/+|\/+$/g, '') }; }
export const configured = () => !!(cfg.owner && cfg.repo && cfg.token);
export const label = () => cfg.owner + '/' + cfg.repo + (cfg.root ? '/' + cfg.root : '');

const repo = () => '/repos/' + encodeURIComponent(cfg.owner) + '/' + encodeURIComponent(cfg.repo);
const full = (rel) => (cfg.root ? cfg.root + '/' : '') + rel;
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

function b64encode(text) {
  const bytes = enc.encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64bytes(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function gh(method, url, body) {
  if (!configured()) throw new BadToken('GitHub のトークンが設定されていません');
  let res;
  try {
    res = await fetch(API + url, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer ' + cfg.token,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
  } catch {
    throw new Error('GitHub に通信できません（電波がない？）');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (res.ok) return data;
  const msg = (data && data.message) || res.statusText;
  if (res.status === 401) throw new BadToken();
  if (res.status === 403 && /rate limit/i.test(msg)) throw new Error('GitHub の回数制限です。しばらく待ってください');
  if (res.status === 403) throw new BadToken('トークンに書き込み権限（Contents: Read and write）がありません');
  if (res.status === 404) throw new NotFound();
  if (res.status === 409) throw new Conflict();
  // 同じ名前があるのに sha を付けずに作ろうとした
  if (res.status === 422 && /sha/i.test(msg)) throw new Exists();
  throw new Error('GitHub ' + res.status + ': ' + msg);
}

const item = (rel, sha, size, isFolder = false) => ({
  id: rel, path: rel, name: rel.slice(rel.lastIndexOf('/') + 1), isFolder, eTag: sha || '', size: size || 0, mtime: '', url: '',
});

// 最近の更新日時。コミットの題（「update: Obsidian/…md (tablet)」）からパスを拾う。1 回の問い合わせで済む
async function recentTimes() {
  const times = new Map();
  try {
    const list = await gh('GET', repo() + '/commits?per_page=100&sha=' + encodeURIComponent(cfg.branch));
    for (const c of list || []) {
      const at = c.commit && (c.commit.committer || c.commit.author) && (c.commit.committer || c.commit.author).date;
      const msg = (c.commit && c.commit.message) || '';
      // 「update: Obsidian/ホーム.md (notes)」「add: … (tablet)」の形。1 行に 1 つ
      for (const line of msg.split('\n')) {
        const m = /^[\w -]+:\s*(.+?\.(?:md|txt))(?:\s+\(.*\))?\s*$/i.exec(line.trim());
        if (m && !times.has(m[1])) times.set(m[1], at);
      }
    }
  } catch { /* 日時が無くても困らない */ }
  return times;
}

// 保管庫（root の下）を全部たどる。. で始まるもの（.obsidian など）は飛ばす
export async function walk(_vault, onProgress) {
  let tree;
  try {
    tree = await gh('GET', repo() + '/git/trees/' + encodeURIComponent(cfg.branch) + '?recursive=1');
  } catch (e) {
    if (e instanceof NotFound) throw new NotFound();
    throw e;
  }
  if (tree.truncated) throw new Error('リポジトリのファイルが多すぎて一覧を取れません');
  const pre = cfg.root ? cfg.root + '/' : '';
  const times = await recentTimes();
  const out = [];
  for (const t of tree.tree) {
    if (!t.path.startsWith(pre) || t.path === cfg.root) continue;
    const rel = t.path.slice(pre.length);
    if (rel.split('/').some((seg) => seg.startsWith('.'))) continue;
    const it = item(rel, t.type === 'blob' ? t.sha : '', t.size, t.type === 'tree');
    if (!it.isFolder) it.mtime = times.get(t.path) || '';
    out.push(it);
  }
  if (onProgress) onProgress(out.length);
  return out;
}

export async function meta(id) {
  const j = await gh('GET', repo() + '/contents/' + encPath(full(id)) + '?ref=' + encodeURIComponent(cfg.branch));
  if (Array.isArray(j)) throw new NotFound();
  return item(id, j.sha, j.size);
}

const blobCache = new Map(); // sha → 本文（同じ版を何度も取りに行かない）

async function blobText(sha) {
  if (blobCache.has(sha)) return blobCache.get(sha);
  const b = await gh('GET', repo() + '/git/blobs/' + sha);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(b64bytes(b.content)); } catch { throw new Error('UTF-8 でないファイルは開けません'); }
  blobCache.set(sha, text);
  return text;
}

export async function readText(id) {
  const m = await meta(id);
  return { text: await blobText(m.eTag), eTag: m.eTag, item: m };
}

// 画像などはリポジトリに入っていない（PC の同期は .md と .txt だけ）
export async function readBlob(id) {
  const m = await meta(id);
  const b = await gh('GET', repo() + '/git/blobs/' + m.eTag);
  return new Blob([b64bytes(b.content)]);
}

async function put(id, text, sha) {
  const path = full(id);
  const body = { message: (sha ? 'update' : 'add') + ': ' + path + ' (notes)', content: b64encode(text), branch: cfg.branch };
  if (sha) body.sha = sha;
  const res = await gh('PUT', repo() + '/contents/' + encPath(path), body);
  blobCache.set(res.content.sha, text);
  return { ...item(id, res.content.sha, res.content.size), mtime: new Date().toISOString() };
}

// 読んだときの版（sha）のままのときだけ書く。PC の同期やポメラで先に書き換わっていれば Conflict
export async function writeText(id, text, eTag) {
  try {
    return await put(id, text, eTag || null);
  } catch (e) {
    // sha が合わないとき、GitHub は 409 か 422 を返す
    if (e instanceof Exists && eTag) throw new Conflict();
    throw e;
  }
}

export async function createText(id, text) {
  return put(id, text, null);
}

// 本文検索：保管庫の .md を読み（一度読んだ版は覚えておく）、含むものを返す
export async function search(q) {
  const k = q.toLowerCase();
  const list = (await walk()).filter((it) => !it.isFolder && /\.(md|txt)$/i.test(it.path));
  const hits = [];
  let i = 0;
  const next = async () => {
    while (i < list.length) {
      const it = list[i++];
      try { if ((await blobText(it.eTag)).toLowerCase().includes(k)) hits.push(it.id); } catch { /* 読めないものは飛ばす */ }
    }
  };
  await Promise.all([next(), next(), next(), next(), next(), next()]);
  return hits;
}

// つながるか確かめる（設定画面のボタン）
export async function test() {
  const r = await gh('GET', repo());
  if (!r.private) return { ok: true, warn: 'このリポジトリは公開（Public）です。ノートが誰でも読めます。' };
  if (r.permissions && !r.permissions.push) return { ok: false, warn: 'トークンに書き込み権限（Contents: Read and write）がありません。' };
  return { ok: true };
}
