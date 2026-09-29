// ノートの置き場所への出入り口。2 通りのつなぎ方を同じ形で使えるようにする。
//   'onedrive' … Microsoft でサインインして OneDrive を直接読み書き（スマホ・タブレット・PC）。graph.js
//   'folder'   … PC のフォルダを直接読み書き（パソコンの Chrome／Edge だけ。サインイン不要）。localfs.js
//   'github'   … GitHub の非公開リポジトリ（pomera-data）を読み書き。pomenote と同じ。github.js
// どちらもパスは保管庫からの相対（'資料/設計.md'）で渡す。
import * as G from './graph.js';
import * as F from './localfs.js';
import * as H from './github.js';

export { NeedSignIn, Conflict, Exists, NotFound } from './graph.js';
export { NeedPermission } from './localfs.js';
export { BadToken } from './github.js';

let mode = 'onedrive';
let vault = null; // OneDrive のときの保管庫（OneDrive の一番上からのパス。'' は一番上）

export const setMode = (m) => { mode = ['folder', 'github'].includes(m) ? m : 'onedrive'; };
export const getMode = () => mode;
export const isFolder = () => mode === 'folder';
export const isGithub = () => mode === 'github';
// 電波に関係なく全部読めるか（PC のフォルダ）、または自前で全文検索するか
export const setVault = (v) => { vault = v; };
const full = (rel) => (vault ? vault + '/' : '') + rel;
const be = () => (mode === 'folder' ? F : mode === 'github' ? H : G);

export const walk = (onProgress) => (mode === 'onedrive' ? G.walk(vault, onProgress) : be().walk('', onProgress));
export const meta = (id) => be().meta(id);
export const readText = (id) => be().readText(id);
export const readBlob = (id) => be().readBlob(id);
export const writeText = (id, text, eTag) => be().writeText(id, text, eTag);
export const createText = (rel, text) => (mode === 'onedrive' ? G.createText(full(rel), text) : be().createText(rel, text));
export const search = (q) => be().search(q);

// OneDrive だけのもの（設定画面で OneDrive のフォルダを選ぶとき）
export const children = G.children;
export const findVaults = G.findVaults;
export const folder = F;
export const github = H;
