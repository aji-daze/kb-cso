// 明朝の取り込み。
//
// なぜ要るか: iOS / iPadOS にはヒラギノ明朝が入っているが、**Android には明朝が無い**。
// Android の標準は Noto Sans CJK だけなので、「明朝」を選んでも黙ってゴシックに落ちる。
// 縦組みで小説を読むのに明朝が出ないのでは、雰囲気「和・縦」の意味が半分なくなる。
//
// リポジトリには同梱しない。設定から一度だけ落として端末に置く（青空文庫の索引と同じ扱い）。
// 落としたあとはオフラインで効く。端末に明朝がある人は落とす必要がない。
import * as DB from './db.js';

export const FAMILY = 'Shiori Mincho';
const CSS_URL = 'https://fonts.googleapis.com/css2?family=Noto+Serif+JP:wght@400&display=swap';
const FLAG = 'minchoInstalled';

// 端末に明朝が入っているか。canvas で字幅を測って確かめる
// （document.fonts.check はシステム書体に対しては当てにならない）。
const CANDIDATES = ['Hiragino Mincho ProN', 'Hiragino Mincho Pro', 'YuMincho', 'Yu Mincho', 'MS Mincho', 'Noto Serif CJK JP', 'Noto Serif JP'];

export function deviceMincho() {
  let cv;
  try { cv = document.createElement('canvas').getContext('2d'); } catch { return null; }
  if (!cv) return null;
  const probe = '國書永愛鬱';
  const base = {};
  for (const g of ['monospace', 'sans-serif']) {
    cv.font = '48px ' + g;
    base[g] = cv.measureText(probe).width;
  }
  for (const name of CANDIDATES) {
    for (const g of ['monospace', 'sans-serif']) {
      cv.font = '48px "' + name + '", ' + g;
      if (Math.abs(cv.measureText(probe).width - base[g]) > 0.5) return name;
    }
  }
  return null;
}

function parseCSS(css) {
  const out = [];
  const re = /@font-face\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const body = m[1];
    const url = (body.match(/src:\s*url\(([^)]+)\)/) || [])[1];
    const range = (body.match(/unicode-range:\s*([^;]+);/) || [])[1];
    if (url) out.push({ url: url.trim().replace(/^["']|["']$/g, ''), range: range ? range.trim() : '' });
  }
  return out;
}

async function pool(items, n, fn) {
  let i = 0;
  const workers = [];
  for (let k = 0; k < n; k++) {
    workers.push((async () => { while (i < items.length) { const j = i++; await fn(items[j], j); } })());
  }
  await Promise.all(workers);
}

export async function download(onStep) {
  const say = (s) => onStep && onStep(s);
  say('書体の一覧を取っています…');
  const res = await fetch(CSS_URL, { mode: 'cors' });
  if (!res.ok) throw new Error('書体の一覧が取れません（HTTP ' + res.status + '）');
  const faces = parseCSS(await res.text());
  if (!faces.length) throw new Error('書体の一覧を読み取れませんでした');

  let done = 0, bytes = 0, failed = 0;
  const rows = new Array(faces.length);
  await pool(faces, 6, async (f, j) => {
    try {
      const r = await fetch(f.url, { mode: 'cors' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const blob = await r.blob();
      bytes += blob.size;
      rows[j] = { id: 'mincho-' + j, i: j, blob, range: f.range };
    } catch {
      failed++;
    }
    done++;
    say('落としています… ' + done + ' / ' + faces.length + '（' + (bytes / 1048576).toFixed(1) + ' MB）');
  });

  const good = rows.filter(Boolean);
  if (!good.length) throw new Error('1つも落とせませんでした');
  say('端末に入れています…');
  await DB.clear('fonts');
  await DB.putAll('fonts', good);
  await DB.setting(FLAG, { at: Date.now(), n: good.length, bytes, failed });
  await install();
  return { n: good.length, bytes, failed, total: faces.length };
}

let installed = false;

export async function install() {
  if (installed || !window.FontFace || !document.fonts) return false;
  const rows = await DB.all('fonts');
  if (!rows || !rows.length) return false;
  rows.sort((a, b) => a.i - b.i);
  for (const r of rows) {
    try {
      // Blob の URL を渡しておくと、その範囲の字が要るときだけ読み込まれる
      const url = URL.createObjectURL(r.blob);
      const face = new FontFace(FAMILY, 'url(' + url + ')', r.range ? { unicodeRange: r.range } : {});
      document.fonts.add(face);
    } catch { /* 1つ失敗しても残りは効く */ }
  }
  installed = true;
  return true;
}

export async function info() {
  const flag = await DB.setting(FLAG);
  if (!flag) return null;
  return flag;
}

export async function remove() {
  await DB.clear('fonts');
  await DB.del('settings', FLAG);
  installed = false;   // 実際に画面から外れるのは、次に開き直したとき
}
