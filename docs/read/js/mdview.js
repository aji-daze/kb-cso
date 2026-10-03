// 文書（本ではない Markdown）を、横書きの1枚の紙として描く。
// 構文解析は marked、出力の消毒は DOMPurify（どちらも vendor/ に同梱。ノートのアプリと同じ版）。
// Obsidian の書き方のうち、よく使うものを拾う：
//   [[ノート]] [[ノート|別名]] ![[埋め込み]] ==強調== #タグ %%コメント%% > [!note] コールアウト
//   - [ ] チェックボックス  先頭の --- のプロパティ
// 保管庫の中のほかのファイル（画像など）はこのアプリに無いので、名前だけ出す。
import { Marked } from '../vendor/marked.js';
import DOMPurify from '../vendor/purify.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function parseLink(raw) {
  let [target, alias] = raw.split('|');
  let heading = '';
  const h = target.indexOf('#');
  if (h >= 0) { heading = target.slice(h + 1); target = target.slice(0, h); }
  return { target: target.trim(), heading: heading.replace(/^\^/, '').trim(), alias: (alias || '').trim() };
}

const wikilink = {
  name: 'wikilink',
  level: 'inline',
  start: (src) => { const i = src.indexOf('[['); return i < 0 ? undefined : i; },
  tokenizer(src) {
    const m = /^\[\[([^[\]\n]+?)\]\]/.exec(src);
    if (m) return { type: 'wikilink', raw: m[0], ...parseLink(m[1]) };
  },
  renderer(t) {
    const label = t.alias || (t.target ? t.target + (t.heading ? ' › ' + t.heading : '') : t.heading);
    return '<a class="wl" href="#" data-note="' + esc(t.target) + '" data-heading="' + esc(t.heading) + '">' + esc(label) + '</a>';
  },
};

const embed = {
  name: 'embed',
  level: 'inline',
  start: (src) => { const i = src.indexOf('![['); return i < 0 ? undefined : i; },
  tokenizer(src) {
    const m = /^!\[\[([^[\]\n]+?)\]\]/.exec(src);
    if (m) return { type: 'embed', raw: m[0], ...parseLink(m[1]) };
  },
  renderer(t) {
    if (/\.(png|jpe?g|gif|webp|svg|bmp|avif|pdf|mp3|mp4)$/i.test(t.target)) {
      return '<span class="att">' + esc(t.target) + '</span>';
    }
    return '<a class="wl" href="#" data-note="' + esc(t.target) + '" data-heading="' + esc(t.heading) + '">' +
      esc(t.alias || t.target) + '</a>';
  },
};

const highlight = {
  name: 'highlight',
  level: 'inline',
  start: (src) => { const i = src.indexOf('=='); return i < 0 ? undefined : i; },
  tokenizer(src) {
    const m = /^==(?=\S)([^\n]*?\S)==/.exec(src);
    if (m) return { type: 'highlight', raw: m[0], tokens: this.lexer.inlineTokens(m[1]) };
  },
  renderer(t) { return '<mark>' + this.parser.parseInline(t.tokens) + '</mark>'; },
};

// #タグ。前が空白か行頭のときだけ。#123 のような数字だけのものはタグにしない（Obsidian と同じ）
const TAG = /^#((?=[^\s#]*[^\d\s#])[\p{L}\p{N}_\-/]+)/u;
const tag = {
  name: 'tag',
  level: 'inline',
  start(src) {
    const m = /(^|\s)#[\p{L}\p{N}_\-/]/u.exec(src);
    return m ? m.index + m[1].length : undefined;
  },
  tokenizer(src) {
    const m = TAG.exec(src);
    if (m) return { type: 'tag', raw: m[0], name: m[1] };
  },
  renderer(t) { return '<span class="tag">#' + esc(t.name) + '</span>'; },
};

const commentBlock = {
  name: 'commentBlock',
  level: 'block',
  start: (src) => { const m = /(^|\n)%%/.exec(src); return m ? m.index + m[1].length : undefined; },
  tokenizer(src) {
    const m = /^%%[\s\S]*?%%[^\n]*(?:\n|$)/.exec(src);
    if (m) return { type: 'commentBlock', raw: m[0] };
  },
  renderer: () => '',
};
const commentInline = {
  name: 'commentInline',
  level: 'inline',
  start: (src) => { const i = src.indexOf('%%'); return i < 0 ? undefined : i; },
  tokenizer(src) {
    const m = /^%%[\s\S]*?%%/.exec(src);
    if (m) return { type: 'commentInline', raw: m[0] };
  },
  renderer: () => '',
};

// breaks: 段落の中の改行をそのまま改行にする（Obsidian の既定と同じ）
const md = new Marked({ gfm: true, breaks: true });
md.use({
  extensions: [embed, wikilink, highlight, tag, commentBlock, commentInline],
  renderer: {
    // ここでは読むだけなので、チェックボックスは押せない形で出す
    checkbox({ checked }) { return '<input type="checkbox" class="task" disabled' + (checked ? ' checked' : '') + '> '; },
  },
});

// 先頭の --- で挟まれたプロパティ（YAML）。「キー: 値」と「- 値」だけ拾う。
const FM = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
function splitFrontmatter(src) {
  const m = FM.exec(src);
  if (!m) return { props: null, body: src };
  const props = [];
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([^\s:#][^:]*):\s*(.*)$/.exec(line);
    const li = /^\s+-\s+(.*)$/.exec(line);
    if (kv) props.push({ k: kv[1].trim(), v: kv[2].trim() ? [kv[2].trim()] : [] });
    else if (li && props.length) props[props.length - 1].v.push(li[1].trim());
  }
  return { props, body: src.slice(m[0].length) };
}

function propsHtml(props) {
  if (!props || !props.length) return '';
  const rows = props.map(({ k, v }) => {
    const vals = v.map((x) => x.replace(/^["']|["']$/g, '').replace(/^\[|\]$/g, ''))
      .flatMap((x) => x.split(/,\s*/)).filter(Boolean);
    return '<dt>' + esc(k) + '</dt><dd>' + esc(vals.join(', ')) + '</dd>';
  }).join('');
  return '<details class="props"><summary>プロパティ</summary><dl>' + rows + '</dl></details>';
}

export function render(src) {
  const { props, body } = splitFrontmatter(String(src || '').replace(/\r\n?/g, '\n'));
  return DOMPurify.sanitize(propsHtml(props) + md.parse(body));
}

// 前の版で「本」として取り込んだ Markdown は、元の文字列を持っていない。章の HTML をつないで出す。
export function sanitize(html) { return DOMPurify.sanitize(html); }

// 一覧に出す書き出し。記号を落として最初の数十文字。
export function snippet(src, n = 90) {
  const { body } = splitFrontmatter(String(src || '').replace(/\r\n?/g, '\n'));
  return body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/%%[\s\S]*?%%/g, ' ')
    .split('\n')
    .filter((l) => !/^\s*#{1,6}\s/.test(l))                     // 見出しは題名と重なりやすいので飛ばす
    // 行頭の記号（引用・箇条書き・番号・チェックボックス）を落とす
    .map((l) => l.replace(/^\s*(?:>\s*)*(?:\[![^\]]*\][+-]?\s*)?(?:(?:[-*+]|\d+[.)])\s+)?(?:\[[ xX]\]\s*)?/, ''))
    .join(' ')
    .replace(/!?\[\[([^\]|]+)\|?([^\]]*)\]\]/g, (_, a, b) => b || a)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~=>#|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n);
}

// 描いたあとの仕上げ。コールアウト、見出しの目印、外へのリンク。
export function decorate(el) {
  let i = 0;
  for (const h of el.querySelectorAll('h1,h2,h3,h4,h5,h6')) h.id = 'dh-' + (i++);

  for (const q of el.querySelectorAll('blockquote')) {
    const p = q.firstElementChild;
    if (!p || p.tagName !== 'P' || !p.firstChild || p.firstChild.nodeType !== 3) continue;
    const m = /^\[!([\w-]+)\]([+-]?)[ \t]*([^\n]*)/.exec(p.firstChild.nodeValue);
    if (!m) continue;
    p.firstChild.nodeValue = p.firstChild.nodeValue.slice(m[0].length);
    if (p.firstChild.nextSibling && p.firstChild.nextSibling.tagName === 'BR') p.firstChild.nextSibling.remove();
    if (!p.textContent.trim() && !p.querySelector('img,input')) p.remove();

    const type = m[1].toLowerCase();
    const box = document.createElement(m[2] ? 'details' : 'div');
    if (m[2] !== '-') box.open = true;
    box.className = 'callout';
    box.dataset.type = type;
    const head = document.createElement(m[2] ? 'summary' : 'div');
    head.className = 'callout-title';
    head.textContent = m[3] || type.charAt(0).toUpperCase() + type.slice(1);
    const content = document.createElement('div');
    content.className = 'callout-content';
    while (q.firstChild) content.appendChild(q.firstChild);
    box.append(head, content);
    q.replaceWith(box);
  }

  for (const a of el.querySelectorAll('a[href]:not([data-note])')) {
    const href = a.getAttribute('href') || '';
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) { a.target = '_blank'; a.rel = 'noopener'; continue; }
    if (href.startsWith('#')) { a.dataset.heading = decodeSafe(href.slice(1)); a.dataset.note = ''; a.setAttribute('href', '#'); continue; }
    // 保管庫の中への相対リンク：ファイル名（拡張子なし）で文書を探す
    a.dataset.note = decodeSafe(href.split('#')[0]).replace(/^.*\//, '').replace(/\.md$/i, '');
    a.dataset.heading = href.includes('#') ? decodeSafe(href.split('#')[1]) : '';
    a.setAttribute('href', '#');
  }
  // 保管庫の画像は手元に無い。壊れた画像の印を出さず、名前だけにする
  for (const img of el.querySelectorAll('img')) {
    const src = img.getAttribute('src') || '';
    if (/^(https?:|data:)/i.test(src)) continue;
    const s = document.createElement('span');
    s.className = 'att';
    s.textContent = img.getAttribute('alt') || decodeSafe(src.replace(/^.*\//, ''));
    img.replaceWith(s);
  }
}

function decodeSafe(s) { try { return decodeURIComponent(s); } catch { return s; } }

// 目次用：見出しの一覧
export function headings(el) {
  return [...el.querySelectorAll('h1,h2,h3,h4')].map((h) => ({ id: h.id, lv: +h.tagName[1], text: h.textContent.trim() }));
}
