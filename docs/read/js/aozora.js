// 青空文庫の目録。
//
// ブラウザから青空文庫のサーバーは読めない（CORS を許可していない）。
// そこで GitHub Actions が目録を取ってきて docs/read/data/ に置き、
// ここでは**自分のサイトから**読む。同一オリジンなので CORS の問題が起きない。
//
// 入っているのは目録だけ（作品名・著者・ダウンロード先の URL）。本文は入っていない。
// 読みたい作品はブラウザで落として、「ファイルを選ぶ」で取り込む。
import * as DB from './db.js';

const URL_PATH = './data/aozora-index.json.gz';

export const cardUrl = (id) =>
  id ? 'https://www.aozora.gr.jp/cards/' : 'https://www.aozora.gr.jp/';

// 目録を落として端末に入れる。以後の検索は通信なしで動く。
export async function buildIndex(onStep) {
  const say = (s) => onStep && onStep(s);
  say('目録を読み込んでいます…');
  const res = await fetch(URL_PATH, { cache: 'no-cache' });
  if (res.status === 404) {
    const e = new Error('目録がまだ作られていません');
    e.notBuilt = true;
    throw e;
  }
  if (!res.ok) throw new Error('目録が読めません（HTTP ' + res.status + '）');

  let text;
  if (typeof DecompressionStream === 'function') {
    const ds = new DecompressionStream('gzip');
    text = await new Response(res.body.pipeThrough(ds)).text();
  } else {
    throw new Error('この端末のブラウザは圧縮された目録を展開できません');
  }

  say('端末に入れています…');
  const data = JSON.parse(text);
  const rows = data.rows || [];
  await DB.put('aozora', { id: 'index', at: data.at ? data.at * 1000 : Date.now(), rows });
  _cache = rows;
  return rows.length;
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

// 行の形： [作品ID, 作品名, 読み, 著者, テキストURL, HTMLのURL]
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
      hit.push({ id: r[0], title: r[1], author: r[3], txt: r[4], html: r[5] });
      if (hit.length >= (limit || 60)) break;
    }
  }
  return hit;
}
