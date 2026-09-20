// 青空文庫からの取り込み。
//
// 本家 www.aozora.gr.jp は CORS ヘッダを返さないのでブラウザからは直接読めない。
// GitHub のミラー（GitHub Pages 配信なので CORS が通る）を叩く。
// 通らない環境では取り込みだけが失敗し、他の機能には影響しない。
import { readZip } from './zip.js';
import * as DB from './db.js';

const MIRROR = 'https://aozorabunko.github.io/aozorabunko/';
const INDEX_ZIP = MIRROR + 'index_pages/list_person_all_extended_utf8.zip';

export const toMirror = (url) =>
  String(url || '').replace(/^https?:\/\/(www\.)?aozora\.gr\.jp\//, MIRROR);

function parseCSV(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// 索引を落として端末に入れる。以後の検索はオフラインで済む。
export async function buildIndex(onStep) {
  const say = (s) => onStep && onStep(s);
  say('索引をダウンロードしています…');
  const res = await fetch(INDEX_ZIP, { mode: 'cors' });
  if (!res.ok) throw new Error('索引が取得できません（HTTP ' + res.status + '）');
  const zip = await readZip(await res.blob());
  const name = zip.names().find((n) => /\.csv$/i.test(n));
  if (!name) throw new Error('索引に CSV が入っていません');

  say('索引を読み込んでいます…');
  const rows = parseCSV(await zip.text(name));
  const head = rows.shift() || [];
  const at = (label) => head.indexOf(label);
  const iId = at('作品ID'), iTitle = at('作品名'), iKana = at('作品名読み');
  const iSei = at('姓'), iMei = at('名');
  const iFree = at('作品著作権フラグ');
  const iHtml = head.findIndex((h) => /XHTML\/HTML/.test(h));
  const iTxt = head.findIndex((h) => /^テキストファイルURL$/.test(h));
  if (iTitle < 0 || iHtml < 0) throw new Error('索引の形式が変わっています');

  const out = [];
  for (const r of rows) {
    if (!r[iTitle]) continue;
    if (iFree >= 0 && r[iFree] !== 'なし') continue;   // 著作権が切れているものだけ
    const url = r[iHtml] || (iTxt >= 0 ? r[iTxt] : '');
    if (!url) continue;
    out.push([
      r[iId] || '',
      r[iTitle],
      (r[iKana] || ''),
      ((r[iSei] || '') + (r[iMei] || '')).trim(),
      toMirror(url),
    ]);
  }
  say('索引を保存しています…');
  await DB.put('aozora', { id: 'index', at: Date.now(), rows: out });
  return out.length;
}

let _cache = null;
export async function index() {
  if (_cache) return _cache;
  const row = await DB.get('aozora', 'index');
  _cache = row ? row.rows : null;
  return _cache;
}
export async function indexInfo() {
  const row = await DB.get('aozora', 'index');
  return row ? { at: row.at, n: row.rows.length } : null;
}
export async function dropIndex() { _cache = null; return DB.del('aozora', 'index'); }

export async function search(q, limit) {
  const rows = await index();
  if (!rows) return null;
  const words = String(q || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hit = [];
  for (const r of rows) {
    const hay = r[1] + '\u0000' + r[2] + '\u0000' + r[3];
    let ok = true;
    for (const w of words) if (!hay.includes(w)) { ok = false; break; }
    if (ok) {
      hit.push({ id: r[0], title: r[1], author: r[3], url: r[4] });
      if (hit.length >= (limit || 60)) break;
    }
  }
  return hit;
}

// --- 本文の取り出し -------------------------------------------------
const P = new DOMParser();
const KEEP = new Set(['P','DIV','SPAN','BR','H1','H2','H3','H4','EM','I','STRONG','B','RUBY','RT','RB',
  'BLOCKQUOTE','UL','OL','LI','HR','SUP','SUB','S','SMALL']);

function clean(node, out) {
  for (const c of [...node.childNodes]) {
    if (c.nodeType === 3) { out.push(c.nodeValue.replace(/[&<>]/g, (x) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[x]))); continue; }
    if (c.nodeType !== 1) continue;
    const tag = c.tagName.toUpperCase();
    if (tag === 'RP' || tag === 'SCRIPT' || tag === 'STYLE' || tag === 'IMG') continue;
    if (tag === 'DIV' && /注記|bibliographical|after_text/.test(c.className || '')) continue;
    if (!KEEP.has(tag)) { clean(c, out); continue; }
    if (tag === 'BR' || tag === 'HR') { out.push('<' + tag.toLowerCase() + '>'); continue; }
    const t = tag === 'RB' ? 'span' : tag.toLowerCase();
    const inner = clean(c, []).join('');
    if (!inner.trim() && t !== 'span') continue;
    if (t === 'div' || t === 'span') { out.push(inner); continue; }
    out.push('<' + t + '>' + inner + '</' + t + '>');
  }
  return out;
}

export async function fetchWork(url) {
  const res = await fetch(toMirror(url), { mode: 'cors' });
  if (!res.ok) throw new Error('本文が取得できません（HTTP ' + res.status + '）');
  const buf = await res.arrayBuffer();
  // 青空文庫の XHTML は Shift_JIS。ブラウザ標準のデコーダで読める。
  let html = new TextDecoder('shift_jis').decode(buf);
  if (!/main_text|<body/i.test(html)) html = new TextDecoder('utf-8').decode(buf);

  const doc = P.parseFromString(html, 'text/html');
  const title = (doc.querySelector('.title') || {}).textContent || '';
  const author = (doc.querySelector('.author') || {}).textContent || '';
  const main = doc.querySelector('.main_text') || doc.body;
  if (!main) throw new Error('本文が見つかりません');

  // 大見出し・中見出しで章に割る
  const parts = clean(main, []).join('');
  const chapters = [];
  const re = /<h([1-4])>([\s\S]*?)<\/h\1>/g;
  let last = 0, m, curTitle = '本文', buf2 = [];
  while ((m = re.exec(parts))) {
    const before = parts.slice(last, m.index);
    if (before.trim()) buf2.push(before);
    if (buf2.join('').replace(/<[^>]+>/g, '').trim()) {
      chapters.push({ title: curTitle, html: buf2.join('') });
      buf2 = [];
    }
    curTitle = m[2].replace(/<[^>]+>/g, '').trim() || curTitle;
    buf2.push(m[0]);
    last = m.index + m[0].length;
  }
  const tail = parts.slice(last);
  if (tail.trim()) buf2.push(tail);
  if (buf2.join('').replace(/<[^>]+>/g, '').trim()) chapters.push({ title: curTitle, html: buf2.join('') });

  return {
    title: title.trim(),
    author: author.trim(),
    vertical: true,
    chapters: chapters.length ? chapters : [{ title: '本文', html: parts }],
  };
}
