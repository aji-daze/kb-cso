// 書影（本の表紙の画像）をネットから探す。
//
// 送るのは題名と著者名（と、見つかった本の ISBN）だけ。本文もメモも送らない。
// 底本の出版社名は送らない。返ってきた候補との照合に端末の中で使う。
// 押されたときだけ動く。取り込みのついでに勝手に探すことはしない。
//
// 取得元。どれも鍵なしで使える公開 API。
//   Google Books … 題名・著者で探せる。出版社・ISBN・縮小画像が返る
//   国立国会図書館サーチ（NDL）… 日本の本の版がいちばん揃っている。ISBN から書影も出る
//   openBD … ISBN から版元の書影
// ブラウザから読めるか（CORS）・1日の上限は端末で試すまで分からないものがある。
// 1つが駄目でも他で続け、どこが駄目だったかは結果に残して画面に出す。

const norm = (s) => String(s || '').normalize('NFKC')
  .replace(/[\s・「」『』（）()〈〉《》【】\[\]\-－—―‐:：,，、。.]/g, '').toLowerCase();

// 本から検索の条件を作る。著者欄に訳者が入っていることがある（「ドストエフスキー 米川正夫訳」）。
export function queryOf(book) {
  const parts = String(book.author || '').split(/\s+/).filter(Boolean);
  const author = (parts.find((p) => !/訳$/.test(p)) || '').trim();
  const translator = (parts.find((p) => /訳$/.test(p)) || '').replace(/訳$/, '');
  const tb = book.teihon || {};
  return {
    title: book.title || '', author, translator,
    edition: tb.name || '', series: tb.series || '', publisher: tb.publisher || '', year: tb.year || '',
  };
}

async function getText(url) {
  const r = await fetch(url, { referrerPolicy: 'no-referrer' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.text();
}
const getJSON = async (url) => JSON.parse(await getText(url));

// ISBN-10 → ISBN-13（国会図書館の書影は13桁で引く）
export function isbn13(s) {
  const d = String(s || '').replace(/[^0-9Xx]/g, '').toUpperCase();
  if (d.length === 13) return d;
  if (d.length !== 10) return '';
  const b = '978' + d.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += +b[i] * (i % 2 ? 3 : 1);
  return b + ((10 - (sum % 10)) % 10);
}

async function fromGoogle(q) {
  const terms = ['intitle:' + q.title];
  if (q.author) terms.push('inauthor:' + q.author);
  const url = 'https://www.googleapis.com/books/v1/volumes?q=' + encodeURIComponent(terms.join(' ')) +
    '&maxResults=20&printType=books';
  const d = await getJSON(url);
  return (d.items || []).map((it) => {
    const v = it.volumeInfo || {};
    const ids = v.industryIdentifiers || [];
    const id = ids.find((x) => x.type === 'ISBN_13') || ids.find((x) => x.type === 'ISBN_10');
    const im = v.imageLinks || {};
    const img = String(im.thumbnail || im.smallThumbnail || '')
      .replace(/^http:/, 'https:').replace(/&edge=curl/, '');
    return {
      title: (v.title || '') + (v.subtitle ? ' ' + v.subtitle : ''),
      creators: (v.authors || []).join(' '), publisher: v.publisher || '', series: '',
      year: String(v.publishedDate || '').slice(0, 4), isbn: id ? isbn13(id.identifier) : '',
      imgs: img ? [img] : [],
    };
  });
}

async function fromNDL(q) {
  const u = new URL('https://ndlsearch.ndl.go.jp/api/opensearch');
  u.searchParams.set('title', q.title);
  if (q.author) u.searchParams.set('creator', q.author);
  u.searchParams.set('cnt', '30');
  const xml = new DOMParser().parseFromString(await getText(u.href), 'application/xml');
  if (xml.getElementsByTagName('parsererror').length) throw new Error('応答が読めません');
  return [...xml.getElementsByTagName('item')].map((it) => {
    const all = (tag) => [...it.getElementsByTagName(tag)].map((e) => e.textContent.trim()).filter(Boolean);
    const isbnEl = [...it.getElementsByTagName('dc:identifier')]
      .find((e) => /ISBN/i.test(e.getAttribute('xsi:type') || ''));
    const isbn = isbnEl ? isbn13(isbnEl.textContent) : '';
    return {
      title: (all('title')[0] || ''), creators: all('dc:creator').concat(all('author')).join(' '),
      publisher: all('dc:publisher').join(' '), series: all('dcndl:seriesTitle').join(' '),
      year: String(all('dcterms:issued')[0] || all('dc:date')[0] || '').replace(/\D/g, '').slice(0, 4),
      isbn, imgs: isbn ? ['https://ndlsearch.ndl.go.jp/thumbnail/' + isbn + '.jpg'] : [],
    };
  });
}

async function fromOpenBD(isbns) {
  const out = new Map();
  for (let i = 0; i < isbns.length; i += 100) {
    const part = isbns.slice(i, i + 100);
    const d = await getJSON('https://api.openbd.jp/v1/get?isbn=' + part.join(','));
    (d || []).forEach((x, k) => { if (x && x.summary && x.summary.cover) out.set(part[k], x.summary.cover); });
  }
  return out;
}

// 候補の点数。底本と同じ文庫・出版社、同じ訳者を強く推す。
export function score(c, q) {
  let s = 0;
  const T = norm(c.title), qt = norm(q.title), qe = norm(q.edition);
  if (!qt) return -99;
  if (T === qt || (qe && T === qe)) s += 30;
  else if (T.startsWith(qt) || (qe && T.startsWith(qe))) s += 22;
  else if (T.includes(qt)) s += 12;
  else return -99;                                   // 題名が違うものは候補にしない
  const C = norm(c.creators);
  if (q.author && C.includes(norm(q.author))) s += 10;
  if (q.translator) s += (C.includes(norm(q.translator)) || T.includes(norm(q.translator))) ? 30 : -15;
  const P = norm(c.publisher + ' ' + c.series + ' ' + c.title);
  if (q.series && P.includes(norm(q.series))) s += 40;
  if (q.publisher && norm(c.publisher).includes(norm(q.publisher))) s += 20;
  if (q.year && c.year === q.year) s += 5;
  if (c.imgs.length) s += 8;
  return s;
}

// 底本と同じ文庫・出版社の版か（画面に「底本と同じ版」と出すのに使う）
export function sameEdition(c, q) {
  const P = norm(c.publisher + ' ' + c.series + ' ' + c.title);
  return !!((q.series && P.includes(norm(q.series))) || (!q.series && q.publisher && norm(c.publisher).includes(norm(q.publisher))));
}

// 探す。返すのは点数順の候補と、取得元ごとの結果（画面に出す）。
export async function search(book) {
  const q = queryOf(book);
  const status = {};
  const got = [];
  const run = async (name, fn) => {
    try { const r = await fn(); status[name] = r.length + '件'; got.push(...r); }
    catch (e) { status[name] = '取れません（' + (e.message === 'Failed to fetch' ? '通信できない・CORS' : e.message) + '）'; }
  };
  await Promise.all([run('Google Books', () => fromGoogle(q)), run('国会図書館', () => fromNDL(q))]);

  // 同じ ISBN はまとめる（画像は両方の候補を残し、読めた方を使う）
  const by = new Map();
  const loose = [];
  for (const c of got) {
    if (!c.isbn) { loose.push(c); continue; }
    const o = by.get(c.isbn);
    if (!o) { by.set(c.isbn, { ...c, imgs: [...c.imgs] }); continue; }
    for (const k of ['title', 'creators', 'publisher', 'series', 'year']) if (!o[k] && c[k]) o[k] = c[k];
    if (c.series && !o.series.includes(c.series)) o.series = (o.series + ' ' + c.series).trim();
    for (const u of c.imgs) if (!o.imgs.includes(u)) o.imgs.push(u);
  }
  // openBD で版元の書影を足す
  const isbns = [...by.keys()];
  if (isbns.length) {
    try {
      const m = await fromOpenBD(isbns);
      for (const [isbn, url] of m) by.get(isbn).imgs.unshift(url);
      status.openBD = m.size + '件';
    } catch (e) {
      status.openBD = '取れません（' + (e.message === 'Failed to fetch' ? '通信できない・CORS' : e.message) + '）';
    }
  }
  const list = [...by.values(), ...loose]
    .map((c) => ({ ...c, score: score(c, q), same: sameEdition(c, q) }))
    .filter((c) => c.score > -99 && c.imgs.length)
    .sort((a, b) => b.score - a.score);
  return { q, list, status };
}

// 画像が本当に出るか。1x1 の透明画像や「画像なし」の小さな絵を弾く。CORS が無くても寸法は取れる。
export function probe(url, ms = 9000) {
  return new Promise((ok) => {
    const im = new Image();
    const t = setTimeout(() => ok(false), ms);
    im.referrerPolicy = 'no-referrer';
    im.onload = () => { clearTimeout(t); ok(im.naturalWidth >= 40 && im.naturalHeight >= 60); };
    im.onerror = () => { clearTimeout(t); ok(false); };
    im.src = url;
  });
}

// 候補の中で最初に出る画像の URL
export async function firstImage(c) {
  for (const u of c.imgs) if (await probe(u)) return u;
  return '';
}

// 自動で選ぶ。題名が合い、著者も合う（訳本なら訳者も合う）ものだけ。合わなければ選ばない。
export const AUTO_MIN = 40;
export async function pickBest(result) {
  for (const c of result.list) {
    if (c.score < AUTO_MIN) break;
    if (result.q.translator && !norm(c.creators + c.title).includes(norm(result.q.translator))) continue;
    const url = await firstImage(c);
    if (url) return { ...c, url };
  }
  return null;
}

// 画像を端末に取り込む。CORS が許されていれば Blob にして持つ（通信なしでも出る）。
// 許されていなければ null を返し、呼ぶ側は URL のまま持つ（通信できるときに出る）。
export async function fetchBlob(url) {
  try {
    const r = await fetch(url, { mode: 'cors', referrerPolicy: 'no-referrer' });
    if (!r.ok) return null;
    const b = await r.blob();
    return /^image\//.test(b.type) && b.size > 800 ? b : null;
  } catch { return null; }
}
