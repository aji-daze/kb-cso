// Markdown を画面に出す。Obsidian の書き方のうち、よく使うものを拾う：
//   [[ノート]] [[ノート|別名]] [[ノート#見出し]] ![[画像.png]] ![[画像.png|300]] ![[ノート]]
//   ==強調== #タグ %%コメント%% > [!note] コールアウト  - [ ] チェックボックス  --- のプロパティ
// 構文解析は marked、出力の消毒は DOMPurify（どちらも vendor/ に同梱）。
import { Marked } from '../vendor/marked.js';
import DOMPurify from '../vendor/purify.js';
import * as V from './vault.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let from = ''; // いま描いているノートのパス。リンク先の探索に使う

// 「ノート#見出し|別名」を分ける
export function parseLink(raw) {
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
    const hit = t.target ? V.resolve(t.target, from) : null;
    const path = t.target ? (hit ? hit.path : t.target) : from; // [[#見出し]] は同じノートの中
    const label = t.alias || (t.target ? t.target + (t.heading ? ' › ' + t.heading : '') : t.heading);
    return '<a class="wl' + (hit || !t.target ? '' : ' missing') + '" href="#" data-note="' + esc(path) +
      '" data-heading="' + esc(t.heading) + '">' + esc(label) + '</a>';
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
    const hit = V.resolve(t.target, from);
    if (/\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(t.target)) {
      const w = /^\d+(x\d+)?$/.test(t.alias) ? t.alias.split('x')[0] : '';
      return '<img class="att" alt="' + esc(t.target) + '" data-file="' + esc(hit ? hit.path : '') + '"' +
        (w ? ' width="' + w + '"' : '') + '>';
    }
    if (hit && V.isNote(hit.path)) {
      return '<span class="embed" data-embed="' + esc(hit.path) + '" data-heading="' + esc(t.heading) + '"></span>';
    }
    return '<a class="wl' + (hit ? '' : ' missing') + '" href="#" data-note="' + esc(hit ? hit.path : t.target) +
      '" data-heading="">' + esc(t.alias || t.target) + '</a>';
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
  renderer(t) { return '<a class="tag" href="#" data-tag="' + esc(t.name) + '">#' + esc(t.name) + '</a>'; },
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

const md = new Marked({ gfm: true, breaks: true });
md.use({
  extensions: [embed, wikilink, highlight, tag, commentBlock, commentInline],
  renderer: {
    checkbox({ checked }) { return '<input type="checkbox" class="task"' + (checked ? ' checked' : '') + '> '; },
  },
});

// 先頭の --- で挟まれたプロパティ（YAML）。中身は厳密には読まず、「キー: 値」と「- 値」だけ拾う。
const FM = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function splitFrontmatter(src) {
  const m = FM.exec(src);
  if (!m) return { props: null, body: src, offset: 0 };
  const props = [];
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([^\s:#][^:]*):\s*(.*)$/.exec(line);
    const li = /^\s+-\s+(.*)$/.exec(line);
    if (kv) props.push({ k: kv[1].trim(), v: kv[2].trim() ? [kv[2].trim()] : [] });
    else if (li && props.length) props[props.length - 1].v.push(li[1].trim());
  }
  return { props, body: src.slice(m[0].length), offset: m[0].split('\n').length - 1 };
}

// チェックボックスの行番号（全文の何行目か）を上から順に。コードブロックの中は数えない。
// 画面の n 番目のチェックボックス ↔ ここの n 番目の行、で対応させる。
export function taskLines(src) {
  const { offset, body } = splitFrontmatter(src);
  const out = [];
  let fence = null;
  body.split('\n').forEach((line, i) => {
    const f = /^\s*(```+|~~~+)/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      return;
    }
    if (!fence && /^\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[[ xX]\]/.test(line)) out.push(offset + i);
  });
  return out;
}

export function toggleTask(src, n, checked) {
  const lines = src.split('\n');
  const at = taskLines(src)[n];
  if (at === undefined) return null;
  lines[at] = lines[at].replace(/\[[ xX]\]/, checked ? '[x]' : '[ ]');
  return lines.join('\n');
}

function propsHtml(props) {
  if (!props || !props.length) return '';
  const rows = props.map(({ k, v }) => {
    const vals = v.map((x) => x.replace(/^["']|["']$/g, '').replace(/^\[|\]$/g, ''))
      .flatMap((x) => x.split(/,\s*/)).filter(Boolean);
    const cell = k === 'tags' || k === 'tag'
      ? vals.map((t) => '<a class="tag" href="#" data-tag="' + esc(t.replace(/^#/, '')) + '">#' + esc(t.replace(/^#/, '')) + '</a>').join(' ')
      : esc(vals.join(', '));
    return '<dt>' + esc(k) + '</dt><dd>' + cell + '</dd>';
  }).join('');
  return '<details class="props"><summary>プロパティ</summary><dl>' + rows + '</dl></details>';
}

export function render(src, path) {
  from = path || '';
  const { props, body } = splitFrontmatter(src);
  const html = propsHtml(props) + md.parse(body);
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
}

// 見出し → 見出しの文字列で探せるように
const slug = (s) => s.trim().toLowerCase().replace(/\s+/g, '-');

// 描いたあとの仕上げ。コールアウト、見出しの目印、ふつうの [文字](パス) リンクと画像。
export function decorate(el, path) {
  for (const h of el.querySelectorAll('h1,h2,h3,h4,h5,h6')) h.id = 'h-' + slug(h.textContent);

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
    if (m[2] === '+') box.open = true;
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

  const here = V.dirName(path || '');
  for (const a of el.querySelectorAll('a[href]:not([data-note]):not([data-tag])')) {
    const href = a.getAttribute('href');
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) { a.target = '_blank'; a.rel = 'noopener'; continue; }
    if (href.startsWith('#')) { a.dataset.note = path; a.dataset.heading = decodeURIComponentSafe(href.slice(1)); continue; }
    const [p, h] = href.split('#');
    const rel = decodeURIComponentSafe(p);
    const hit = V.get(V.joinPath(here, rel)) || V.resolve(rel, path);
    a.dataset.note = hit ? hit.path : rel;
    a.dataset.heading = h ? decodeURIComponentSafe(h) : '';
    if (!hit) a.classList.add('missing');
    a.setAttribute('href', '#');
  }
  for (const img of el.querySelectorAll('img:not([data-file])')) {
    const src = img.getAttribute('src') || '';
    if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src)) continue;
    const rel = decodeURIComponentSafe(src);
    const hit = V.get(V.joinPath(here, rel)) || V.resolve(rel, path);
    img.removeAttribute('src');
    img.classList.add('att');
    img.dataset.file = hit ? hit.path : '';
  }
}

function decodeURIComponentSafe(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

export function findHeading(el, heading) {
  if (!heading) return null;
  return el.querySelector('#' + CSS.escape('h-' + slug(heading))) ||
    [...el.querySelectorAll('h1,h2,h3,h4,h5,h6')].find((h) => h.textContent.trim().toLowerCase().includes(heading.toLowerCase())) || null;
}
