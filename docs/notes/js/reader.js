// 読む側の道具：文字の見え方の設定、目次、マーカー。
//
// マーカーの書き方は2通り。どちらも Obsidian でそのまま色が付く。
//   黄   → ==文字==                                   （Obsidian の標準）
//   他色 → <mark style="background: #BBFABBA6;">文字</mark> （Highlightr プラグインと同じ形）
import { splitFrontmatter } from './render.js';

export const COLORS = [
  { key: 'yellow', name: '黄', css: '#FFF3A3A6', md: null },
  { key: 'green', name: '緑', css: '#BBFABBA6', md: '#BBFABBA6' },
  { key: 'blue', name: '青', css: '#ADCCFFA6', md: '#ADCCFFA6' },
  { key: 'pink', name: '桃', css: '#FF5582A6', md: '#FF5582A6' },
  { key: 'purple', name: '紫', css: '#D2B3FFA6', md: '#D2B3FFA6' },
];

// ---------------------------------------------------------------- 見え方

const PREF_KEY = 'notes.view';
const DEFAULTS = { fs: 17, lh: 1.9, font: 'sans', measure: 'normal', theme: 'auto' };
const MEASURE = { narrow: '32em', normal: '40em', wide: '56em' };
const FONTS = {
  sans: '-apple-system, BlinkMacSystemFont, "Noto Sans JP", "Noto Sans CJK JP", "Hiragino Sans", "Yu Gothic UI", "Yu Gothic", Meiryo, sans-serif',
  serif: '"Noto Serif JP", "Noto Serif CJK JP", "Yu Mincho", YuMincho, "Hiragino Mincho ProN", serif',
};

export function prefs() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(PREF_KEY) || '{}') }; } catch { return { ...DEFAULTS }; }
}

export function setPrefs(p) {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch { /* 入らなくても今回は効く */ }
  applyPrefs(p);
}

let watching = false;
export function applyPrefs(p = prefs()) {
  const s = document.documentElement.style;
  s.setProperty('--fs', p.fs + 'px');
  s.setProperty('--lh', String(p.lh));
  s.setProperty('--font', FONTS[p.font] || FONTS.sans);
  s.setProperty('--measure', MEASURE[p.measure] || MEASURE.normal);
  if (p.theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = p.theme;
  // 「自動」のとき、端末側で明暗が切り替わったら上端の色も追いかける
  if (!watching) {
    watching = true;
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyPrefs());
  }
  // Android の上端（ステータスバー）の色を配色に合わせる
  const bar = getComputedStyle(document.documentElement).getPropertyValue('--surface').trim();
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) { m.removeAttribute('media'); m.content = bar || m.content; }
  // 明朝は Android に入っていないことがあるので、選んだときだけ Web フォントを読む
  if (p.font === 'serif' && !document.getElementById('serifFont')) {
    const l = document.createElement('link');
    l.id = 'serifFont';
    l.rel = 'stylesheet';
    l.href = 'https://fonts.googleapis.com/css2?family=Noto+Serif+JP:wght@400;700&display=swap';
    document.head.appendChild(l);
  }
}

// ---------------------------------------------------------------- 目次とマーカー一覧

const inBody = (el) => !el.closest('.embed, .props');

export function outline(view) {
  const heads = [...view.querySelectorAll('h1,h2,h3,h4')].filter(inBody)
    .map((h) => ({ el: h, level: Number(h.tagName[1]), text: h.textContent.trim() }));
  const marks = [...view.querySelectorAll('mark')].filter(inBody)
    .map((m) => ({ el: m, text: m.textContent.trim(), color: m.style.background || '' }));
  return { heads, marks };
}

// ---------------------------------------------------------------- マーカーを本文に書き込む

// 本文の中のマーカー（コードブロックの中は除く）。{ from, to, inner }
const MARK = /==(?!\s)((?:(?!==)[^\n])+?)==|<mark\s+style="background:\s*[^;"]+;?\s*">((?:(?!<\/mark>)[^\n])*)<\/mark>/g;

function codeRanges(src) {
  const out = [];
  const re = /^[ \t]*(```+|~~~+)[^\n]*\n[\s\S]*?(?:^[ \t]*\1[ \t]*$|(?![\s\S]))/gm;
  for (let m; (m = re.exec(src));) out.push([m.index, m.index + m[0].length]);
  const inl = /`[^`\n]+`/g;
  for (let m; (m = inl.exec(src));) out.push([m.index, m.index + m[0].length]);
  return out;
}
const inside = (ranges, i) => ranges.some(([a, b]) => i >= a && i < b);

function bodyStart(src) {
  const { body } = splitFrontmatter(src);
  return src.length - body.length;
}

export function sourceMarks(src) {
  const start = bodyStart(src);
  const code = codeRanges(src);
  const out = [];
  MARK.lastIndex = start;
  for (let m; (m = MARK.exec(src));) {
    if (inside(code, m.index)) continue;
    out.push({ from: m.index, to: m.index + m[0].length, inner: m[1] !== undefined ? m[1] : m[2] });
  }
  return out;
}

function occurrences(hay, needle, from = 0) {
  const out = [];
  for (let i = hay.indexOf(needle, from); i >= 0; i = hay.indexOf(needle, i + 1)) out.push(i);
  return out;
}

// 画面の文字（埋め込みとプロパティを除く）を1本につなげ、選択の始まりが何文字目かを出す
function flatText(view, range) {
  const walker = document.createTreeWalker(view, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (inBody(n.parentElement) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  let text = '', at = -1;
  for (let n; (n = walker.nextNode());) {
    if (n === range.startContainer) at = text.length + range.startOffset;
    else if (at < 0 && range.startContainer.nodeType !== 3 && range.comparePoint(n, 0) >= 0) at = text.length;
    text += n.nodeValue;
  }
  return { text, at };
}

const wrapWith = (s, color) => (color && color.md ? '<mark style="background: ' + color.md + ';">' + s + '</mark>' : '==' + s + '==');

// 選んだ文字にマーカーを引いた本文を返す。本文のどこか確信できなければ { error }。
// 画面で n 番目に出てくる「その文字列」↔ 本文で n 番目の「その文字列」、で対応させる。
export function markSelection(src, view, range, color) {
  let s = range.toString();
  const lead = s.length - s.trimStart().length;
  s = s.trim();
  if (!s) return { error: '' };
  if (/\n/.test(s)) return { error: '段落をまたいでは引けません。段落ごとに選んでください' };

  const { text, at } = flatText(view, range);
  const shown = occurrences(text, s);
  const idx = shown.indexOf(at + lead);

  const start = bodyStart(src);
  const code = codeRanges(src);
  const marks = sourceMarks(src);
  const inMark = (i) => marks.some((m) => i >= m.from && i < m.to);
  const inSrc = occurrences(src, s, start).filter((i) => !inside(code, i));

  if (!inSrc.length) return { error: '太字やリンクをまたぐ範囲には引けません。編集画面で引いてください' };
  let pos;
  if (inSrc.length === 1) pos = inSrc[0];
  else if (idx >= 0 && shown.length === inSrc.length) pos = inSrc[idx];
  else return { error: '同じ文字列が何か所もあって場所を特定できません。もう少し長めに選んでください' };
  if (inMark(pos)) return { error: 'もうマーカーが引いてあります。マーカーを押すと色を変えたり外したりできます' };

  return { text: src.slice(0, pos) + wrapWith(s, color) + src.slice(pos + s.length) };
}

// 画面の n 番目の <mark> を、外す（color = null で remove = true）か色を変える
export function editMark(src, view, markEl, { color, remove }) {
  const shown = [...view.querySelectorAll('mark')].filter(inBody);
  const n = shown.indexOf(markEl);
  const marks = sourceMarks(src);
  if (n < 0 || shown.length !== marks.length) return { error: 'このマーカーは編集画面で直してください' };
  const m = marks[n];
  const next = remove ? m.inner : wrapWith(m.inner, color);
  return { text: src.slice(0, m.from) + next + src.slice(m.to) };
}
