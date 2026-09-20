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
  const body = aozoraRuby(esc(src.replace(/\r\n?/g, '\n')));
  const paras = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const parts = [];
  const chs = [];
  let hasBody = false;
  let title = fallbackTitle || '本文';
  for (const p of paras) {
    // 「　　　第一章」のような短い行は見出し扱いにする
    const plain = p.replace(/<[^>]+>/g, '').trim();
    if (plain.length <= 24 && /^[　\s]*(第[^\n]{1,12}[章節話部篇編]|[０-９0-9]{1,3}|[一二三四五六七八九十百]{1,6})[　\s]*$/.test(plain)) {
      // md 側と同じ理由で、中身が入るまでは章を切らない
      if (hasBody) { chs.push({ title, html: parts.join('') }); parts.length = 0; hasBody = false; }
      title = plain;
      parts.push('<h2>' + plain + '</h2>');
      continue;
    }
    hasBody = true;
    parts.push('<p>' + p.replace(/\n/g, '') + '</p>');
  }
  if (parts.length) chs.push({ title, html: parts.join('') });
  return chs.length ? chs : [{ title: fallbackTitle || '本文', html: '<p></p>' }];
}
