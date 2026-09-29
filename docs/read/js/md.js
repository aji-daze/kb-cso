// Markdown とプレーンテキストの取り込み。ライブラリは使わない。
// 出力は章の配列 [{ title, html }]。見出し（# / ##）で章に割る。

const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function inline(s) {
  let t = esc(s);
  t = t.replace(/`([^`]+)`/g, (_, c) => '<code>' + c + '</code>');
  t = t.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1');            // 画像は文字だけ残す
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" rel="noopener" target="_blank">$1</a>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  t = t.replace(/~~([^~]+)~~/g, '<s>$1</s>');
  t = t.replace(/\{([^{}|]+)\|([^{}]+)\}/g, '<ruby>$1<rt>$2</rt></ruby>'); // {漢字|かんじ}
  return t;
}

export function mdToBlocks(src) {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const L = lines[i];

    if (/^```/.test(L)) {
      const body = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push({ t: 'code', html: '<pre><code>' + esc(body.join('\n')) + '</code></pre>' });
      continue;
    }
    const h = L.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const lv = h[1].length;
      out.push({ t: 'h', lv, text: h[2].trim(), html: '<h' + Math.min(lv, 4) + '>' + inline(h[2].trim()) + '</h' + Math.min(lv, 4) + '>' });
      i++; continue;
    }
    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(L)) { out.push({ t: 'hr', html: '<hr>' }); i++; continue; }

    if (/^\s*>/.test(L)) {
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push({ t: 'quote', html: '<blockquote>' + inline(body.join(' ')) + '</blockquote>' });
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s+/.test(L)) {
      const ordered = /^\s*\d+\./.test(L);
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        items.push(inline(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, '')));
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push({ t: 'list', html: '<' + tag + '>' + items.map((x) => '<li>' + x + '</li>').join('') + '</' + tag + '>' });
      continue;
    }
    if (!L.trim()) { i++; continue; }

    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*>|\s*([-*+]|\d+\.)\s)/.test(lines[i])) para.push(lines[i++]);
    out.push({ t: 'p', html: '<p>' + inline(para.join('')) + '</p>' });
  }
  return out;
}

// 青空文庫のテキスト記法のうち、ルビだけ拾う（｜漢字《かんじ》 / 漢字《かんじ》）。
export function aozoraRuby(s) {
  return s
    .replace(/｜([^｜《》]+)《([^》]+)》/g, '<ruby>$1<rt>$2</rt></ruby>')
    .replace(/([一-鿿々-〇]+)《([^》]+)》/g, '<ruby>$1<rt>$2</rt></ruby>')
    .replace(/［＃[^］]*］/g, '');
}

export function mdToChapters(src, fallbackTitle) {
  const blocks = mdToBlocks(src);
  const chs = [];
  // 見出しが続いているあいだは章を切らない。切ると中身の無い章ができる
  // （「# 題名」の直後に「## 第一節」が来る形はごく普通にある）。
  let cur = { title: fallbackTitle || '本文', parts: [], body: false };
  for (const b of blocks) {
    const head = b.t === 'h' && b.lv <= 2;
    if (head && cur.body) {
      chs.push({ title: cur.title, html: cur.parts.join('') });
      cur = { title: b.text, parts: [b.html], body: false };
      continue;
    }
    if (head) cur.title = b.text; else cur.body = true;
    cur.parts.push(b.html);
  }
  if (cur.body) chs.push({ title: cur.title, html: cur.parts.join('') });
  else if (cur.parts.length && chs.length) chs[chs.length - 1].html += cur.parts.join('');
  else if (cur.parts.length) chs.push({ title: cur.title, html: cur.parts.join('') });
  return chs.length ? chs : [{ title: fallbackTitle || '本文', html: '<p></p>' }];
}

// プレーンテキスト。空行で段落を切る。青空文庫のルビ記法が入っていれば拾う。
export function txtToChapters(src, fallbackTitle) {
  const text = src.replace(/\r\n?/g, '\n');
  // 日本語か。日本語のテキスト（青空文庫を含む）は「1行＝1段落」で、段落の間に空行が無い。
  // 英語などは行の途中で折り返してあり、段落は空行で分かれている。
  const cjk = (text.match(/[぀-鿿＀-￯]/g) || []).length;
  const jp = cjk > text.replace(/\s/g, '').length * 0.2;
  const body = aozoraRuby(esc(text));

  const units = [];   // { text, gap }（gap: 直前に空行があった）
  if (jp) {
    let gap = false;
    for (const line of body.split('\n')) {
      // 行末の空白だけ落とす。行頭の全角空白は字下げで、本文のうち
      const t = line.replace(/[ \t　]+$/, '');
      if (!t.replace(/[\s　]/g, '')) { gap = true; continue; }
      units.push({ text: t, gap });
      gap = false;
    }
  } else {
    // 折り返しの改行は空白に戻す（そのまま消すと単語同士がくっつく）
    for (const block of body.split(/\n\s*\n/)) {
      const t = block.split('\n').map((l) => l.trim()).filter(Boolean).join(' ');
      if (t) units.push({ text: t, gap: false });
    }
  }

  const parts = [];
  const chs = [];
  let hasBody = false;
  let title = fallbackTitle || '本文';
  for (const u of units) {
    // 「　　　第一章」のような短い行は見出し扱いにする
    const plain = u.text.replace(/<[^>]+>/g, '').trim();
    if (plain.length <= 24 && /^[　\s]*(第[^\n]{1,12}[章節話部篇編]|[０-９0-9]{1,3}|[一二三四五六七八九十百]{1,6})[　\s]*$/.test(plain)) {
      // md 側と同じ理由で、中身が入るまでは章を切らない
      if (hasBody) { chs.push({ title, html: parts.join('') }); parts.length = 0; hasBody = false; }
      title = plain;
      parts.push('<h2>' + plain + '</h2>');
      continue;
    }
    // 日本語の段落は元の字下げ（全角空白）で組む。CSS の字下げを重ねないよう class="t"。
    // 空行は1行ぶん空ける（文字は足さない。しおりの位置がずれないように）
    if (jp && u.gap && hasBody) parts.push('<p class="t sp"></p>');
    hasBody = true;
    parts.push(jp ? '<p class="t">' + u.text + '</p>' : '<p>' + u.text + '</p>');
  }
  if (parts.length) chs.push({ title, html: parts.join('') });
  return chs.length ? chs : [{ title: fallbackTitle || '本文', html: '<p></p>' }];
}

// 前の版で取り込んだ本の段落を切り直す。前の版は行の改行を消して1段落につないでいた。
// 青空文庫の段落は全角空白（字下げ）か「『（で始まり、行は。」』などで終わるので、
// その境目で区切る。文字は1字も足さず減らさない（区切りを入れるだけ）ので、
// しおり・抜き書きの位置（章と文字の位置）はそのまま使える。
const LINE_END = '。」』）！？!?…';
const LINE_START = '　「『（';
export function resplitParagraphs(html) {
  return html.replace(/<p>([\s\S]*?)<\/p>/g, (whole, inner) => {
    const pieces = [];
    let cur = '', prev = '', inRt = false;
    for (let i = 0; i < inner.length;) {
      if (inner[i] === '<') {
        const j = inner.indexOf('>', i);
        if (j < 0) { cur += inner.slice(i); break; }
        const tag = inner.slice(i, j + 1);
        if (/^<rt[\s>]/i.test(tag)) inRt = true;
        else if (/^<\/rt>/i.test(tag)) inRt = false;
        cur += tag; i = j + 1;
        continue;
      }
      let len = 1;
      if (inner[i] === '&') { const j = inner.indexOf(';', i); if (j > i && j - i < 10) len = j + 1 - i; }
      const ch = inner.slice(i, i + len);
      if (!inRt && prev && LINE_END.includes(prev) && LINE_START.includes(ch) && cur) { pieces.push(cur); cur = ''; }
      cur += ch;
      if (!inRt) prev = ch;
      i += len;
    }
    if (cur) pieces.push(cur);
    if (pieces.length < 2) return whole;
    // 最初の塊は前の版で行頭の字下げが落ちているので CSS の字下げのまま。2つ目からは元の字下げで組む
    return pieces.map((x, k) => (k ? '<p class="t">' : '<p>') + x + '</p>').join('');
  });
}

// 青空文庫のテキストファイルを、題名・著者・本文に分ける。
//
// 実ファイルはこういう形をしている：
//   題名 / （副題）/ 著者名 / （訳者名）
//   （空行）
//   -------------------------------------------------------
//   【テキスト中に現れる記号について】… 凡例
//   -------------------------------------------------------
//   本文…
//   底本：「…」…  ← 以降は奥付
//
// 凡例と奥付を落とさないと、それが本文として棚に並ぶ。
export function splitAozora(raw) {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');

  // 先頭の空行を飛ばし、最初の空行までを見出しの塊とする
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i++;
  const head = [];
  while (i < lines.length && lines[i].trim()) head.push(lines[i++].trim());

  const title = head[0] || '';
  // 2行目に題名の読み（仮名だけの行）が入ることがある。著者に混ぜない。
  const rest = head.slice(1).filter((l) => !/^[\u3040-\u309F\u30A0-\u30FF\u30FC\s]+$/.test(l));
  const author = rest.join(' ').trim();

  let body = lines.slice(i);

  // 凡例（----- で挟まれた塊）を落とす
  const isRule = (l) => /^-{10,}$/.test(l.trim());
  const first = body.findIndex(isRule);
  if (first >= 0) {
    const second = body.findIndex((l, k) => k > first && isRule(l));
    if (second > first) body = body.slice(0, first).concat(body.slice(second + 1));
  }

  // 奥付（底本：以降）を落とす
  const end = body.findIndex((l) => /^\s*底本[：:]/.test(l));
  if (end >= 0) body = body.slice(0, end);

  // 先頭の空行と末尾の空白だけ落とす。trim() だと最初の行の字下げ（全角空白）まで消える
  return { title, author, body: body.join('\n').replace(/^(?:[ \t\u3000]*\n)+/, '').replace(/\s+$/, '') };
}

// テキストの文字コードを判別して読む。
// 青空文庫のテキストは Shift_JIS。UTF-8 として読むと文字化けするので、
// まず UTF-8 で厳密に試し、通らなければ Shift_JIS とみなす。
export function decodeText(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { /* UTF-8 ではなかった */ }
  try { return new TextDecoder('shift_jis').decode(buf); }
  catch { return new TextDecoder('utf-8').decode(buf); }
}

// 青空文庫のテキストかどうか。奥付か凡例があれば、そう扱ってよい。
export function looksAozora(text) {
  const head = text.slice(0, 4000);
  return /^\s*底本[：:]/m.test(text) || /^-{10,}$/m.test(head) || /《[^》]+》/.test(head);
}
