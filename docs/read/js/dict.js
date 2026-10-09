// 辞書。読んでいて選んだ語の意味と読みを引く。
// 日本語はウィクショナリー（無ければウィキペディアの要約）、英語は英語版ウィクショナリー。
// どちらも CORS が開いている公開 API なので、サーバーを持たずにブラウザから直接引ける。
// 語をネットに送るのは「辞書」を押したときだけ。同じ語は二度引かない（開いているあいだ控える）。
const cache = new Map();
const JA = /[぀-ヿ㐀-鿿]/;

async function getJSON(url, ms = 8000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { signal: c.signal });
    return r.ok ? await r.json() : null;
  } catch { return null; }
  finally { clearTimeout(t); }
}

// HTML の定義文を文字だけにする（DOMParser の文書はスクリプトも画像も動かない）
const textOf = (html) => new DOMParser().parseFromString(String(html || ''), 'text/html').body.textContent.trim();

// 「== 日本語 ==」の節だけを取り出し、見出しを【】にする
function jaSection(t) {
  const m = /(?:^|\n)==\s*日本語\s*==\n([\s\S]*?)(?=\n==\s*[^=\n][^\n]*==\s*(?:\n|$)|$)/.exec(t);
  const body = m ? m[1] : t;
  return body
    .replace(/^=+\s*(.+?)\s*=+\s*$/gm, '【$1】')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 1800);
}

async function wiktJa(w) {
  const j = await getJSON('https://ja.wiktionary.org/w/api.php?action=query&prop=extracts&explaintext=1' +
    '&exsectionformat=wiki&redirects=1&format=json&origin=*&titles=' + encodeURIComponent(w));
  const p = j && j.query && Object.values(j.query.pages || {})[0];
  if (!p || 'missing' in p || !p.extract || !p.extract.trim()) return null;
  return { from: 'ウィクショナリー', title: p.title, text: jaSection(p.extract),
    url: 'https://ja.wiktionary.org/wiki/' + encodeURIComponent(p.title) };
}

async function wikiJa(w) {
  const j = await getJSON('https://ja.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(w));
  if (!j || !j.extract || j.type === 'disambiguation') return null;
  return { from: 'ウィキペディア', title: j.title, text: j.extract.slice(0, 1200),
    url: (j.content_urls && j.content_urls.mobile && j.content_urls.mobile.page) || 'https://ja.wikipedia.org/wiki/' + encodeURIComponent(w) };
}

async function wiktEn(w) {
  const word = w.toLowerCase();
  const j = await getJSON('https://en.wiktionary.org/api/rest_v1/page/definition/' + encodeURIComponent(word) + '?redirect=true');
  const en = j && j.en;
  if (!en || !en.length) return null;
  const text = en.slice(0, 4).map((p) =>
    '【' + p.partOfSpeech + '】\n' + (p.definitions || []).map((d) => textOf(d.definition)).filter(Boolean)
      .slice(0, 4).map((d, i) => (i + 1) + '. ' + d).join('\n')).join('\n\n');
  return { from: 'Wiktionary', title: word, text, url: 'https://en.wiktionary.org/wiki/' + encodeURIComponent(word) };
}

// 送り仮名つきで選んだとき（「邂逅した」）は、語幹（「邂逅」）でも引き直す
function candidates(w) {
  const out = [w];
  const stem = w.replace(/[ぁ-ゟ]+$/, '');
  if (stem && stem !== w && JA.test(stem)) out.push(stem);
  return out;
}

export async function lookup(word) {
  const w = String(word || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!w) return null;
  if (cache.has(w)) return cache.get(w);
  if (!navigator.onLine) return { offline: true };
  let r = null;
  if (JA.test(w)) {
    for (const c of candidates(w)) { r = await wiktJa(c); if (r) break; }
    if (!r) r = await wikiJa(w);
  } else {
    r = await wiktEn(w.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, ''));
  }
  cache.set(w, r);
  return r;
}

// 引けなかったとき・もっと知りたいときの外のリンク
export function links(word) {
  const q = encodeURIComponent(word);
  return JA.test(word)
    ? [['Weblio 辞書', 'https://www.weblio.jp/content/' + q], ['Google', 'https://www.google.com/search?q=' + q + '+意味+読み方']]
    : [['Cambridge', 'https://dictionary.cambridge.org/dictionary/english/' + q], ['Google', 'https://www.google.com/search?q=' + q + '+meaning']];
}
