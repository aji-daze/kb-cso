// 紙・組み方の設定。ここがこのアプリの調整の本体。
// 値はすべて CSS カスタムプロパティとして読書画面のルート要素に書き込む。

export const PAPERS = {
  hakuji: { label: '白磁', bg: [0, 0, 100], ink: [240, 6, 10], dark: false },
  kinari: { label: '生成り', bg: [40, 26, 94], ink: [35, 14, 13], dark: false },
  koshi:  { label: '古紙', bg: [40, 34, 86], ink: [34, 26, 16], dark: false },
  sepia:  { label: 'セピア', bg: [37, 42, 80], ink: [28, 42, 18], dark: false },
  kiri:   { label: '霧', bg: [215, 10, 13], ink: [210, 10, 86], dark: true },
  sumi:   { label: '墨', bg: [220, 8, 5], ink: [40, 6, 85], dark: true },
};

export const FAMS = {
  // 端末に明朝があればそれを使う。無い端末（Android）では、取り込んだ書体が効く。
  serif:   { label: '明朝', css: '"Hiragino Mincho ProN","Yu Mincho",YuMincho,"Noto Serif CJK JP","Shiori Mincho",serif' },
  sans:    { label: 'ゴシック', css: '-apple-system,"Hiragino Sans","Noto Sans JP","Yu Gothic UI",Roboto,sans-serif' },
  maru:    { label: '丸ゴシック', css: '"Hiragino Maru Gothic ProN","Rounded Mplus 1c","Yu Gothic UI",sans-serif' },
  enserif: { label: '欧文セリフ', css: 'Iowan Old Style,"Palatino Linotype",Palatino,Georgia,"Hiragino Mincho ProN",serif' },
};

// 雰囲気。触るのはここだけで、下の細かい値がまとめて動く。
export const MOODS = {
  wa_v:   { label: '和・縦', s: { dir: 'v', fam: 'serif',   fs: 17, lh: 205, ls: 4, paper: 'kinari', grain: 46, fine: 55, gutter: 40, ink: 100, margin: 26, style: 'ja' } },
  memo:   { label: '覚え書き', s: { dir: 'h', fam: 'sans',  fs: 16, lh: 185, ls: 2, paper: 'hakuji', grain: 0,  fine: 50, gutter: 16, ink: 100, margin: 24, style: 'ja' } },
  yo:     { label: '洋・古典', s: { dir: 'h', fam: 'enserif', fs: 18, lh: 165, ls: 0, paper: 'koshi', grain: 52, fine: 62, gutter: 34, ink: 96,  margin: 40, style: 'en' } },
  kenkyu: { label: '研究',   s: { dir: 'h', fam: 'sans',    fs: 15, lh: 180, ls: 2, paper: 'hakuji', grain: 0,  fine: 50, gutter: 10, ink: 100, margin: 14, style: 'ja' } },
  yoru:   { label: '夜',     s: { dir: 'v', fam: 'serif',   fs: 17, lh: 210, ls: 4, paper: 'sumi',   grain: 22, fine: 45, gutter: 26, ink: 88,  margin: 26, style: 'ja' } },
};

export function defaults() {
  return Object.assign({ mood: 'wa_v', anim: 'fade' }, MOODS.wa_v.s);
}

// 触れる値の一覧。設定画面はこの表から組み立てる。
export const RANGES = {
  fs:     { min: 12, max: 30, step: 1,  label: '文字の大きさ', unit: 'px' },
  lh:     { min: 130, max: 280, step: 5, label: '行間', unit: '%' },
  ls:     { min: 0, max: 16, step: 1,   label: '字送り', unit: '/100em' },
  margin: { min: 6, max: 72, step: 2,   label: '版面の余白', unit: 'px' },
  grain:  { min: 0, max: 100, step: 1,  label: '紙の目', unit: '' },
  fine:   { min: 0, max: 100, step: 1,  label: '目の細かさ', unit: '' },
  gutter: { min: 0, max: 100, step: 1,  label: '綴じ側の陰り', unit: '' },
  ink:    { min: 55, max: 100, step: 1, label: 'インクの濃さ', unit: '' },
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function hsl(h, s, l) { return 'hsl(' + h.toFixed(1) + ' ' + clamp(s, 0, 100).toFixed(1) + '% ' + clamp(l, 0, 100).toFixed(1) + '%)'; }

// 紙の目は SVG のノイズを1枚敷くだけ。画像を読み込まないので軽い。
function grainURL(fine) {
  const f = (0.35 + (fine / 100) * 1.15).toFixed(2);
  const svg =
    "<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'>" +
    "<filter id='n'><feTurbulence type='fractalNoise' baseFrequency='" + f + "' numOctaves='3' stitchTiles='stitch'/></filter>" +
    "<rect width='200' height='200' filter='url(%23n)'/></svg>";
  return 'url("data:image/svg+xml,' + svg.replace(/</g, '%3C').replace(/>/g, '%3E').replace(/#/g, '%23').replace(/"/g, "'") + '")';
}

export function apply(el, s) {
  const p = PAPERS[s.paper] || PAPERS.kinari;
  const [bh, bs, bl] = p.bg;
  const [ih, is, il] = p.ink;

  el.style.setProperty('--pg', hsl(bh, bs, bl));
  // 面（設定シートなど）は紙よりわずかに沈める／浮かせる
  el.style.setProperty('--pg2', hsl(bh, bs, p.dark ? bl + 5 : bl - 7));
  el.style.setProperty('--pg3', hsl(bh, bs, p.dark ? bl + 10 : bl - 14));

  // インクの濃さ＝紙に向かってどれだけ寄せるか
  const k = clamp(s.ink, 55, 100) / 100;
  el.style.setProperty('--ink', hsl(ih, is * k, il + (bl - il) * (1 - k)));
  el.style.setProperty('--ink-2', hsl(ih, is * k, il + (bl - il) * (1 - k * 0.55)));

  el.style.setProperty('--grain-img', grainURL(s.fine));
  el.style.setProperty('--grain', (clamp(s.grain, 0, 100) / 100 * 0.82).toFixed(3));
  el.style.setProperty('--grain-blend', p.dark ? 'screen' : 'multiply');
  el.style.setProperty('--gutter', (clamp(s.gutter, 0, 100) / 100 * 0.9).toFixed(3));

  el.style.setProperty('--mg', clamp(s.margin, 6, 72) + 'px');
  el.style.setProperty('--fs', clamp(s.fs, 12, 30) + 'px');
  el.style.setProperty('--lh', (clamp(s.lh, 130, 280) / 100).toFixed(2));
  el.style.setProperty('--ls', (clamp(s.ls, 0, 16) / 100).toFixed(2) + 'em');
  el.style.setProperty('--fam', (FAMS[s.fam] || FAMS.serif).css);

  el.dataset.paper = s.paper;
  el.dataset.dark = p.dark ? '1' : '0';
  el.dataset.dirmode = s.dir;
  el.dataset.anim = s.anim || 'fade';
  return s;
}

// 端末の通知バーの色を紙に合わせる（ミュージックと同じ扱い）
export function tint(color) {
  let m = document.querySelector('meta[name="theme-color"]');
  if (!m) { m = document.createElement('meta'); m.name = 'theme-color'; document.head.appendChild(m); }
  m.content = color;
}

export function moodSettings(key, base) {
  const m = MOODS[key];
  if (!m) return base;
  return Object.assign({}, base, m.s, { mood: key });
}
