// ノートの置き場所への出入り口。2 通りのつなぎ方を同じ形で使えるようにする。
//   'onedrive' … Microsoft でサインインして OneDrive を直接読み書き（スマホ・タブレット・PC）。graph.js
//   'folder'   … PC のフォルダを直接読み書き（パソコンの Chrome／Edge だけ。サインイン不要）。localfs.js
// どちらもパスは保管庫からの相対（'資料/設計.md'）で渡す。
import * as G from './graph.js';
import * as F from './localfs.js';

export { NeedSignIn, Conflict, Exists, NotFound } from './graph.js';
export { NeedPermission } from './localfs.js';

let mode = 'onedrive';
let vault = null; // OneDrive のときの保管庫（OneDrive の一番上からのパス。'' は一番上）

export const setMode = (m) => { mode = m === 'folder' ? 'folder' : 'onedrive'; };
export const getMode = () => mode;
export const isFolder = () => mode === 'folder';
export const setVault = (v) => { vault = v; };
const full = (rel) => (vault ? vault + '/' : '') + rel;
const be = () => (mode === 'folder' ? F : G);

export const walk = (onProgress) => (mode === 'folder' ? F.walk('', onProgress) : G.walk(vault, onProgress));
export const meta = (id) => be().meta(id);
export const readText = (id) => be().readText(id);
export const readBlob = (id) => be().readBlob(id);
export const writeText = (id, text, eTag) => be().writeText(id, text, eTag);
export const createText = (rel, text) => (mode === 'folder' ? F.createText(rel, text) : G.createText(full(rel), text));
export const search = (q) => be().search(q);

// OneDrive だけのもの（設定画面で OneDrive のフォルダを選ぶとき）
export const children = G.children;
export const findVaults = G.findVaults;
export const folder = F;
