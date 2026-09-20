// 読む速さの実測と、読書セッションの記録。
// 残りは「ページ数」ではなく分で出す。そのための元データをここで作る。
import * as DB from './db.js';

const KEY = 'cpm';            // 1分あたりの文字数
const DEFAULT_CPM = 520;      // 実測が溜まるまでの仮の値
const MAX_PAGE_MS = 180000;   // 3分を超えたページは「読んでいなかった」とみなして捨てる
const MIN_PAGE_MS = 4000;     // 4秒未満は読んでいない（飛ばしている）
const MIN_CPM = 80;           // 人が日本語を読む速さの下限・上限。外はすべて捨てる
const MAX_CPM = 2500;

let samples = [];
let cpm = DEFAULT_CPM;

export async function load() {
  const v = await DB.setting(KEY);
  if (v && v.samples) { samples = v.samples.slice(-120); cpm = v.cpm || DEFAULT_CPM; }
  return cpm;
}
async function save() { await DB.setting(KEY, { cpm, samples: samples.slice(-120) }); }

// 外れ値に引きずられないよう中央値を使う
function median(a) {
  if (!a.length) return DEFAULT_CPM;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function addPage(chars, ms) {
  if (!chars || chars < 40) return;
  if (ms < MIN_PAGE_MS || ms > MAX_PAGE_MS) return;
  const v = chars / (ms / 60000);
  // 飛ばし読みや、置きっぱなしのページに引きずられないよう、人の速さの範囲外は捨てる
  if (v < MIN_CPM || v > MAX_CPM) return;
  samples.push(v);
  if (samples.length > 120) samples = samples.slice(-120);
  cpm = Math.round(median(samples));
  save();
}

export const speed = () => cpm || DEFAULT_CPM;
export const measured = () => samples.length;
export const minutesFor = (chars) => Math.max(0, Math.round(chars / speed()));

// --- セッション -----------------------------------------------------
let cur = null;

export function begin(bookId) {
  if (cur && cur.bookId === bookId) return;
  end();
  cur = { id: DB.uid('s'), bookId, at: Date.now(), ms: 0, chars: 0, t0: Date.now() };
}
export function tickChars(n) { if (cur) cur.chars += n; }

export function end() {
  if (!cur) return null;
  const s = cur; cur = null;
  s.ms += Date.now() - s.t0;
  delete s.t0;
  if (s.ms < 20000) return null;   // 20秒未満は記録しない
  DB.put('sessions', s);
  return s;
}
export function pause() { if (cur) { cur.ms += Date.now() - cur.t0; cur.t0 = Date.now(); } }
export function resume() { if (cur) cur.t0 = Date.now(); }

export async function daily(days) {
  const rows = await DB.all('sessions');
  const out = new Map();
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const from = start.getTime() - (days - 1) * 86400000;
  for (const s of rows) {
    if (s.at < from) continue;
    const d = new Date(s.at); d.setHours(0, 0, 0, 0);
    const k = d.getTime();
    out.set(k, (out.get(k) || 0) + s.ms);
  }
  const list = [];
  for (let i = 0; i < days; i++) {
    const k = from + i * 86400000;
    list.push({ at: k, ms: out.get(k) || 0 });
  }
  return list;
}

export async function totals() {
  const rows = await DB.all('sessions');
  const ms = rows.reduce((a, s) => a + (s.ms || 0), 0);
  return { ms, n: rows.length };
}

// DESK（同じ github.io 配信なので localStorage を共有できる）に今日の読書分数を渡す。
export function publishToDesk(bookTitle, ms) {
  try {
    const raw = localStorage.getItem('desk.sessions');
    const list = raw ? JSON.parse(raw) : [];
    list.push({ kind: 'read', at: Date.now(), minutes: Math.round(ms / 60000), label: bookTitle || '読書' });
    localStorage.setItem('desk.sessions', JSON.stringify(list.slice(-500)));
  } catch { /* DESK が無い環境では何もしない */ }
}
