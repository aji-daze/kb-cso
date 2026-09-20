// ぽちゃ文庫 — 画面制御。
import * as DB from './db.js';
import * as Paper from './paper.js';
import * as Notes from './notes.js';
import * as Stats from './stats.js';
import * as Aozora from './aozora.js';
import * as Font from './font.js';
import * as Drive from './drive.js';
import * as OneDrive from './onedrive.js';
import * as Bear from './bear.js';
import { Pager } from './pager.js';
import { mdToChapters, txtToChapters } from './md.js';
import { readEpub } from './epub.js';
import { supported as zipOK } from './zip.js';

const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const plain = (html) => { const d = document.createElement('div'); d.innerHTML = html; d.querySelectorAll('rt,rp').forEach((x) => x.remove()); return d.textContent || ''; };

const KINDS = { epub: 'EPUB', md: 'Markdown', txt: 'テキスト', aozora: '青空文庫', paper: '紙', kindle: 'Kindle' };
const STATUS = { reading: '読んでいる', stack: '積んでいる', done: '読んだ' };

const S = {
  view: 'now',
  shelfTab: 'reading',
  noteTag: null,
  chrome: { theme: 'sumi', accent: 'kohaku', font: 'system' },
  paper: Paper.defaults(),
  books: [],
  covers: new Map(),
};

// ---------------------------------------------------------------- 共通 UI
let toastT = null;
function toast(msg) {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => { el.hidden = true; }, 2600);
}

let sheetEl = null, scrimEl = null;
function closeSheet() {
  if (sheetEl) sheetEl.remove();
  if (scrimEl) scrimEl.remove();
  sheetEl = scrimEl = null;
}
function sheet(html, onMount) {
  closeSheet();
  scrimEl = document.createElement('div');
  scrimEl.className = 'scrim';
  scrimEl.onclick = closeSheet;
  sheetEl = document.createElement('div');
  sheetEl.className = 'sheet';
  sheetEl.innerHTML = '<div class="grab"></div>' + html;
  document.body.append(scrimEl, sheetEl);
  if (onMount) onMount(sheetEl);
  return sheetEl;
}
function confirmSheet(title, body, okLabel, danger) {
  return new Promise((done) => {
    sheet('<h3>' + esc(title) + '</h3><p style="color:var(--sub);font-size:13.5px;line-height:1.8;margin:0">' + body + '</p>' +
      '<div class="actions"><button class="btn" id="c-no">やめる</button>' +
      '<button class="btn ' + (danger ? 'danger' : 'primary') + '" id="c-ok">' + esc(okLabel || 'する') + '</button></div>',
      (el) => {
        $('#c-no', el).onclick = () => { closeSheet(); done(false); };
        $('#c-ok', el).onclick = () => { closeSheet(); done(true); };
      });
  });
}

function coverStyle(b) {
  const url = S.covers.get(b.id);
  if (url) return 'background-image:url(' + url + ')';
  // 書影が無い本は、題名から作った色で塗る
  let h = 0;
  for (const c of (b.title || '?')) h = (h * 31 + c.codePointAt(0)) % 360;
  return 'background:linear-gradient(160deg,hsl(' + h + ' 18% 32%),hsl(' + ((h + 28) % 360) + ' 20% 17%))';
}

// ---------------------------------------------------------------- 見た目（アプリ側）
function applyChrome() {
  const r = document.documentElement;
  r.dataset.theme = S.chrome.theme;
  r.dataset.accent = S.chrome.accent;
  r.dataset.font = S.chrome.font;
  const bg = getComputedStyle(document.body).backgroundColor;
  Paper.tint(bg);
}

// ================================================================ 本の取り込み
function chapChars(chapters) { return chapters.map((c) => plain(c.html).length); }

async function addBook(meta, chapters) {
  const counts = chapChars(chapters);
  const book = {
    id: DB.uid('b'),
    title: meta.title || '(無題)',
    author: meta.author || '',
    kind: meta.kind,
    source: meta.source || '',
    status: 'reading',
    added: Date.now(),
    finished: 0,
    vertical: !!meta.vertical,
    mood: meta.vertical ? 'wa_v' : (meta.kind === 'md' ? 'memo' : 'wa_v'),
    chapChars: counts,
    chars: counts.reduce((a, b) => a + b, 0),
    cover: meta.cover || null,
    manual: meta.manual || null,
  };
  await DB.put('books', book);
  if (chapters) await DB.put('files', { id: book.id, chapters });
  await loadBooks();
  return book;
}

export const BOOK_EXT = /\.(epub|md|markdown|txt|text)$/i;
const isBookName = (n) => BOOK_EXT.test(n || '');

// 取り込みの本体。ファイル選択・Google ドライブ・OneDrive のどれからでもここに来る。
async function importBlob(filename, blob, source) {
  const name = String(filename).replace(/\.[^.]+$/, '');
  if (/\.epub$/i.test(filename) || blob.type === 'application/epub+zip') {
    if (!zipOK()) throw new Error('この端末のブラウザは EPUB の展開に対応していません');
    const b = await readEpub(blob);
    return addBook({
      title: b.title || name, author: b.author, kind: 'epub',
      vertical: b.vertical, cover: b.cover, source: source || filename,
    }, b.chapters);
  }
  const text = await blob.text();
  const isMd = /\.(md|markdown)$/i.test(filename);
  const chs = isMd ? mdToChapters(text, name) : txtToChapters(text, name);
  return addBook({
    title: name, kind: isMd ? 'md' : 'txt',
    vertical: !isMd && /[《》｜]/.test(text), source: source || filename,
  }, chs);
}

async function importFiles(files) {
  let n = 0, err = 0;
  for (const f of files) {
    try { await importBlob(f.name, f); n++; }
    catch (e) { console.warn(e); err++; }
  }
  if (n) toast(n + '冊を棚に入れました' + (err ? '（' + err + '件は読めませんでした）' : ''));
  else if (err) toast('読み込めませんでした');
  render();
}

// 最初に開いたとき棚が空だと何も確かめられないので、自前の短い文章を1つ入れておく。
const SAMPLE = `# ぽちゃ文庫のこと

紙の本を読むとき、指は次のページの端をさわっている。残りがどれだけあるかを、数えずに知っている。画面にはこれが無い。だから残量は数字で補うしかないのだが、ページ数は補いになっていない。読む速さを知らない数字だからだ。

このアプリは、ページを送った間隔からあなたの速さを測る。十ページも読めば、残りが何分かを出せるようになる。「あと四十二ページ」より「あと十八分」のほうが、寝る前に読み続けるかどうかを決められる。

## 紙のこと

画面は発光しているので、紙にはならない。できるのは、発光している感じを減らすところまでだ。

設定（画面の中央をタップ）から、紙の色・紙の目・綴じ側の陰り・インクの濃さを動かせる。強くすれば紙らしくなると思うかもしれないが、実際には文字と地の差が縮まって読みにくくなるだけである。効くのは、効いていると気づかない程度までだ。

> 迷ったら「雰囲気」から選び直せばいい。プリセットは出発点であって、固定ではない。

## 組み方のこと

日本語の小説は縦で書かれ、縦で読まれることを前提に句読点の位置が決まっている。横に流し替えた瞬間、息の切れる場所がずれる。だから縦組みは飾りではなく、もとの形に戻す作業にあたる。

もっとも、すべてを縦にすればいいわけでもない。箇条書きと引用が交互に出てくる文章を縦に組むと、どこを見ればいいかわからなくなる。この文章自体がそうで、だから覚え書きの雰囲気では横組みになる。

## 使いかた

- 画面の左右をタップしてページを送る（縦組みでは左が先へ進む）
- 中央をタップすると、上に目次、下に設定が出る
- 本文を長押しして選ぶと、そのまま抜き書きにできる
- 読み終えたら、いちばん残った一文をひとつだけ選ぶ

この本は見本なので、読み終えたら棚から消してかまわない。
`;

async function addSample() {
  await addBook({ title: 'ぽちゃ文庫のこと', author: '見本', kind: 'md' }, mdToChapters(SAMPLE, 'ぽちゃ文庫のこと'));
  toast('見本を入れました');
  render();
}

// ================================================================ 棚
async function loadBooks() {
  S.books = (await DB.all('books')).sort((a, b) => (b.added || 0) - (a.added || 0));
  for (const b of S.books) {
    if (b.cover && !S.covers.has(b.id)) {
      try { S.covers.set(b.id, URL.createObjectURL(b.cover)); } catch { /* 表紙が壊れていても本は読める */ }
    }
  }
  return S.books;
}

async function markOf(id) { return (await DB.get('marks', id)) || { id, ch: 0, off: 0, pct: 0, lastLine: '' }; }

function progressOf(b, m) {
  if (b.manual) {
    const t = Math.max(1, b.manual.total || 1);
    return Math.min(1, (b.manual.cur || 0) / t);
  }
  return m ? (m.pct || 0) : 0;
}

function remainLabel(b, m) {
  if (b.status === 'done') return '読了';
  if (b.manual) {
    const u = b.manual.unit === 'percent' ? '%' : 'p.';
    return u === '%' ? (b.manual.cur || 0) + '%' : 'p.' + (b.manual.cur || 0);
  }
  const left = Math.max(0, (b.chars || 0) * (1 - (m ? m.pct : 0)));
  const mins = Stats.minutesFor(left);
  if (!b.chars) return '';
  return mins >= 60 ? Math.floor(mins / 60) + '時間' + (mins % 60 ? (mins % 60) + '分' : '') : mins + '分';
}

// ================================================================ 画面: つづき
async function renderNow() {
  const el = $('#v-now');
  const reading = S.books.filter((b) => b.status === 'reading');
  if (!S.books.length) {
    el.innerHTML = '<div class="empty"><b>棚に本がありません</b>' +
      'EPUB・Markdown・テキストを取り込むか、青空文庫から落としてください。</div>' +
      '<div style="display:flex;flex-direction:column;gap:10px;align-items:center">' +
      '<button class="btn primary wide" id="n-add">本を入れる</button>' +
      '<button class="btn wide" id="n-sample">見本を入れて試す</button></div>';
    $('#n-add', el).onclick = addSheet;
    $('#n-sample', el).onclick = addSample;
    return;
  }

  let cur = null, mark = null;
  const lastId = await DB.setting('lastBook');
  cur = reading.find((b) => b.id === lastId) || reading[0] || S.books[0];
  mark = await markOf(cur.id);

  const now = new Date();
  const mStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const inM = S.books.filter((b) => b.added >= mStart).length;
  const outM = S.books.filter((b) => b.finished && b.finished >= mStart).length;
  const pct = Math.round(progressOf(cur, mark) * 100);

  el.innerHTML =
    '<div class="now">' +
      '<div class="cover' + (S.covers.has(cur.id) ? ' has-img' : '') + '" style="' + coverStyle(cur) + '"><span>' + esc(cur.title) + '</span></div>' +
      '<div><h2>' + esc(cur.title) + '</h2><div class="meta">' +
        (cur.author ? esc(cur.author) + ' · ' : '') + esc(KINDS[cur.kind] || '') +
        (pct ? ' · ' + pct + '%' : '') +
        (remainLabel(cur, mark) && !cur.manual ? ' · 残り ' + remainLabel(cur, mark) : '') +
      '</div></div>' +
      (mark.lastLine ? '<div class="lastline">…' + esc(mark.lastLine) + '</div>' : '') +
      (cur.manual
        ? '<button class="btn wide" id="n-manual">進みを書き込む</button>'
        : '<button class="btn primary wide" id="n-open">' + (mark.pct ? '続きから読む' : '読みはじめる') + '</button>') +
      '<div class="flow-row">' +
        '<div><b>' + reading.length + '</b><span>読んでいる</span></div>' +
        '<div><b>' + (inM ? '+' + inM : '0') + '</b><span>今月 入った</span></div>' +
        '<div><b>' + (outM ? '−' + outM : '0') + '</b><span>今月 出た</span></div>' +
      '</div>' +
    '</div>';

  if ($('#n-open', el)) $('#n-open', el).onclick = () => openBook(cur.id);
  if ($('#n-manual', el)) $('#n-manual', el).onclick = () => manualSheet(cur);
}

// ================================================================ 画面: 棚
async function renderShelf() {
  const el = $('#v-shelf');
  const list = S.books.filter((b) => b.status === S.shelfTab);
  const marks = new Map();
  for (const b of list) marks.set(b.id, await markOf(b.id));

  el.innerHTML =
    '<div class="seg" id="s-seg">' +
      Object.entries(STATUS).map(([k, v]) =>
        '<button data-k="' + k + '" aria-pressed="' + (S.shelfTab === k) + '">' + v + '</button>').join('') +
    '</div>' +
    (list.length
      ? list.map((b) => {
          const m = marks.get(b.id);
          const p = Math.round(progressOf(b, m) * 100);
          return '<button class="row' + (b.status === 'done' ? ' done' : '') + '" data-id="' + b.id + '">' +
            '<span class="sc" style="' + coverStyle(b) + '"></span>' +
            '<span class="rt"><b>' + esc(b.title) + '</b>' +
            '<span>' + (b.author ? esc(b.author) + ' · ' : '') + esc(KINDS[b.kind] || '') + '</span>' +
            '<span class="prog"><i style="width:' + p + '%"></i></span></span>' +
            '<span class="rmin">' + esc(remainLabel(b, m)) + '</span></button>';
        }).join('')
      : '<div class="empty">ここには何もありません</div>') +
    '<div class="actions" style="margin-top:20px"><button class="btn primary" id="s-add">＋ 本を入れる</button></div>';

  $$('#s-seg button', el).forEach((b) => { b.onclick = () => { S.shelfTab = b.dataset.k; renderShelf(); }; });
  $$('.row', el).forEach((r) => { r.onclick = () => bookSheet(r.dataset.id); });
  $('#s-add', el).onclick = addSheet;
}

// ================================================================ 画面: 抜き書き
async function renderNotes() {
  const el = $('#v-notes');
  const rows = await Notes.list();
  const tags = await Notes.allTags();
  const rec = await Notes.recall();
  const shown = S.noteTag ? rows.filter((r) => (r.tags || []).includes(S.noteTag)) : rows;

  el.innerHTML =
    (rec ? '<div class="recall"><div class="lbl">' + esc(rec.label) + '</div>' +
      '<q>' + esc(rec.row.quote) + '</q>' +
      '<div class="src">' + esc(rec.row.bookTitle) + (rec.row.chapter ? ' · ' + esc(rec.row.chapter) : '') + '</div></div>' : '') +
    (rows.length
      ? '<div class="h">' + rows.length + '件' + (S.noteTag ? '（#' + esc(S.noteTag) + ' で絞り込み中）' : '') + '</div>' +
        (tags.length ? '<div>' + tags.map(([t, n]) =>
          '<button class="chip" data-t="' + esc(t) + '" aria-pressed="' + (S.noteTag === t) + '">#' + esc(t) + ' ' + n + '</button>').join('') + '</div>' : '') +
        shown.map((r) =>
          '<button class="note" data-id="' + r.id + '">' +
          '<q>' + esc(r.quote) + '</q>' +
          '<span class="src">' + esc(r.bookTitle) + (r.chapter ? ' · ' + esc(r.chapter) : '') + ' · ' + when(r.at) + '</span>' +
          (r.note ? '<span class="me">' + esc(r.note) + '</span>' : '') +
          ((r.tags || []).length ? '<span>' + r.tags.map((t) => '<span class="chip">#' + esc(t) + '</span>').join('') + '</span>' : '') +
          '</button>').join('') +
        '<div class="actions"><button class="btn" id="n-export">Markdown で書き出す</button></div>'
      : '<div class="empty"><b>まだ抜き書きがありません</b>本文を長押しして選ぶと、そのまま残せます。</div>');

  $$('.chip[data-t]', el).forEach((c) => {
    c.onclick = () => { S.noteTag = S.noteTag === c.dataset.t ? null : c.dataset.t; renderNotes(); };
  });
  $$('.note', el).forEach((n) => { n.onclick = () => noteSheet(rows.find((r) => r.id === n.dataset.id)); });
  if ($('#n-export', el)) $('#n-export', el).onclick = () => exportNotes(shown);
}

function when(t) {
  const d = Math.floor((Date.now() - t) / 86400000);
  if (d <= 0) return '今日';
  if (d === 1) return '昨日';
  if (d < 30) return d + '日前';
  const x = new Date(t);
  return (x.getMonth() + 1) + '月' + x.getDate() + '日';
}

function exportNotes(rows) {
  const md = Notes.toMarkdown(rows, '抜き書き');
  sheet('<h3>書き出し</h3><p style="font-size:12.5px;color:var(--sub);margin:0 0 10px">' +
    'この文章をコピーして、ThinkOS のノートに貼ってください。同じ形式なので読み戻せます。</p>' +
    '<label class="field"><textarea id="ex" readonly style="min-height:200px;font-size:12.5px"></textarea></label>' +
    '<div class="actions"><button class="btn" id="ex-close">閉じる</button><button class="btn primary" id="ex-copy">コピー</button></div>',
    (el) => {
      $('#ex', el).value = md;
      $('#ex-close', el).onclick = closeSheet;
      $('#ex-copy', el).onclick = async () => {
        try { await navigator.clipboard.writeText(md); toast('コピーしました'); }
        catch { $('#ex', el).select(); toast('選択しました。長押しでコピーしてください'); }
      };
    });
}

function noteSheet(row) {
  if (!row) return;
  sheet('<h3>抜き書き</h3>' +
    '<blockquote style="margin:0 0 14px;padding-left:12px;border-left:2px solid var(--acc);font-size:14px;line-height:1.9">' + esc(row.quote) + '</blockquote>' +
    '<label class="field"><span>自分の反応</span><textarea id="nn"></textarea></label>' +
    '<label class="field"><span>タグ（空白区切り・# は不要）</span><input type="text" id="nt"></label>' +
    '<div class="actions"><button class="btn danger" id="nd">消す</button>' +
    '<button class="btn primary" id="ns">保存</button></div>',
    (el) => {
      $('#nn', el).value = row.note || '';
      $('#nt', el).value = (row.tags || []).join(' ');
      $('#ns', el).onclick = async () => {
        row.note = $('#nn', el).value;
        row.tags = $('#nt', el).value.split(/\s+/).map((t) => t.replace(/^#/, '')).filter(Boolean);
        await Notes.update(row); closeSheet(); renderNotes(); toast('保存しました');
      };
      $('#nd', el).onclick = async () => {
        if (!(await confirmSheet('この抜き書きを消しますか', '元に戻せません。', '消す', true))) return;
        await Notes.remove(row.id); renderNotes(); toast('消しました');
      };
    });
}

// ================================================================ 画面: 記録
async function renderLog() {
  const el = $('#v-log');
  const days = await Stats.daily(28);
  const tot = await Stats.totals();
  const max = Math.max(1, ...days.map((d) => d.ms));
  const today = days[days.length - 1];
  const week = days.slice(-7).reduce((a, d) => a + d.ms, 0);
  const done = S.books.filter((b) => b.status === 'done').length;

  const fmt = (ms) => {
    const m = Math.round(ms / 60000);
    return m >= 60 ? Math.floor(m / 60) + '時間' + (m % 60 ? (m % 60) + '分' : '') : m + '分';
  };

  const todayMin = Math.round(today.ms / 60000);
  const bearState = Bear.stateFor(todayMin);

  el.innerHTML =
    '<div class="bearbox" data-bear="' + bearState + '">' +
      '<div class="art">' + Bear.svg() + '</div>' +
      '<div class="say">' + esc(Bear.line(bearState, todayMin)) + '</div>' +
    '</div>' +
    '<div class="stat">' +
      '<div><b>' + fmt(today.ms) + '</b><span>今日</span></div>' +
      '<div><b>' + fmt(week) + '</b><span>この7日</span></div>' +
      '<div><b>' + done + '</b><span>読んだ本</span></div>' +
    '</div>' +
    '<div class="h">この4週間</div>' +
    '<div class="bars">' + days.map((d) =>
      '<div class="' + (d.ms ? '' : 'zero') + '" style="height:' + Math.max(2, Math.round(d.ms / max * 84)) + 'px" title="' + fmt(d.ms) + '"></div>').join('') + '</div>' +
    '<div class="barlbl"><span>4週間前</span><span>今日</span></div>' +
    '<div class="h">読む速さ</div>' +
    '<div style="color:var(--sub);font-size:13px;line-height:1.85">' +
      (Stats.measured()
        ? '実測 <b style="color:var(--tx)">' + Stats.speed() + '</b> 文字/分（' + Stats.measured() + 'ページ分から）。残り時間はこの値で出しています。'
        : 'まだ測れていません。10ページほど読むと、残り時間が実測の速さに切り替わります（いまは仮の値 ' + Stats.speed() + ' 文字/分）。') +
    '</div>' +
    '<div class="h">合計</div>' +
    '<div style="color:var(--sub);font-size:13px">' + fmt(tot.ms) + ' / ' + tot.n + '回</div>';
}

// ================================================================ 本の詳細・登録
function addSheet() {
  sheet('<h3>本を入れる</h3>' +
    '<button class="item" id="a-file"><span class="mark">▤</span><span><b>端末から選ぶ</b>' +
      '<span>EPUB（DRM の無いもの）・Markdown・テキスト。取り込むと端末内に保存され、以後はオフラインで読めます</span></span></button>' +
    '<button class="item" id="a-aozora"><span class="mark">青</span><span><b>青空文庫から探す</b>' +
      '<span>著作権の切れた作品を、アプリの中で検索して落とします</span></span></button>' +
    '<button class="item" id="a-drive"><span class="mark">G</span><span><b>Google ドライブから取り込む</b>' +
      '<span>フォルダを辿って、本を選んで落とします。落としたあとはオフラインで読めます</span></span></button>' +
    '<button class="item" id="a-od"><span class="mark">OD</span><span><b>OneDrive から取り込む</b>' +
      '<span>同上。初回だけ Microsoft 側でのアプリ登録が必要です</span></span></button>' +
    '<button class="item" id="a-manual"><span class="mark">▭</span><span><b>紙・Kindle の本を登録する</b>' +
      '<span>本文は開けません。棚に置いて、進みを手で書き込みます</span></span></button>' +
    '<button class="item" id="a-sample"><span class="mark">?</span><span><b>見本を入れる</b>' +
      '<span>使い方を書いた短い文章。読み終えたら消してかまいません</span></span></button>',
    (el) => {
      $('#a-file', el).onclick = () => { closeSheet(); $('#pick').click(); };
      $('#a-aozora', el).onclick = aozoraSheet;
      $('#a-drive', el).onclick = () => cloudSheet(Drive);
      $('#a-od', el).onclick = () => cloudSheet(OneDrive);
      $('#a-manual', el).onclick = manualNewSheet;
      $('#a-sample', el).onclick = () => { closeSheet(); addSample(); };
    });
}

function manualNewSheet() {
  sheet('<h3>紙・Kindle の本</h3>' +
    '<label class="field"><span>題名</span><input type="text" id="m-t"></label>' +
    '<label class="field"><span>著者</span><input type="text" id="m-a"></label>' +
    '<label class="field"><span>形式</span><select id="m-k"><option value="paper">紙</option><option value="kindle">Kindle</option></select></label>' +
    '<label class="field"><span>進みの単位</span><select id="m-u"><option value="page">ページ</option><option value="percent">％</option></select></label>' +
    '<label class="field"><span>全体（ページ数。％なら 100 のまま）</span><input type="number" id="m-n" value="300" min="1"></label>' +
    '<div class="actions"><button class="btn" id="m-c">やめる</button><button class="btn primary" id="m-s">棚に置く</button></div>',
    (el) => {
      $('#m-c', el).onclick = closeSheet;
      $('#m-u', el).onchange = () => { $('#m-n', el).value = $('#m-u', el).value === 'percent' ? 100 : 300; };
      $('#m-s', el).onclick = async () => {
        const t = $('#m-t', el).value.trim();
        if (!t) { toast('題名を入れてください'); return; }
        const unit = $('#m-u', el).value;
        await addBook({
          title: t, author: $('#m-a', el).value.trim(), kind: $('#m-k', el).value,
          manual: { unit, total: Math.max(1, +$('#m-n', el).value || 1), cur: 0 },
        }, null);
        closeSheet(); render(); toast('棚に置きました');
      };
    });
}

function manualSheet(b) {
  const unit = b.manual.unit === 'percent' ? '％' : 'ページ';
  sheet('<h3>' + esc(b.title) + '</h3>' +
    '<label class="field"><span>いま何' + unit + '目か（全 ' + b.manual.total + '）</span>' +
    '<input type="number" id="p-n" value="' + (b.manual.cur || 0) + '" min="0" max="' + b.manual.total + '"></label>' +
    '<div class="actions"><button class="btn" id="p-c">やめる</button><button class="btn primary" id="p-s">書き込む</button></div>',
    (el) => {
      $('#p-c', el).onclick = closeSheet;
      $('#p-s', el).onclick = async () => {
        b.manual.cur = Math.max(0, Math.min(b.manual.total, +$('#p-n', el).value || 0));
        if (b.manual.cur >= b.manual.total && b.status !== 'done') { b.status = 'done'; b.finished = Date.now(); }
        await DB.put('books', b); await loadBooks(); closeSheet(); render(); toast('書き込みました');
      };
    });
}

async function bookSheet(id) {
  const b = S.books.find((x) => x.id === id);
  if (!b) return;
  const m = await markOf(id);
  const ns = await Notes.ofBook(id);
  const p = Math.round(progressOf(b, m) * 100);
  sheet('<h3>' + esc(b.title) + '</h3>' +
    '<p style="color:var(--sub);font-size:12.5px;margin:0 0 12px">' +
      (b.author ? esc(b.author) + ' · ' : '') + esc(KINDS[b.kind]) + ' · ' + p + '%' +
      (b.chars ? ' · ' + b.chars.toLocaleString() + '文字' : '') +
      (ns.length ? ' · 抜き書き ' + ns.length + '件' : '') + '</p>' +
    (b.manual
      ? '<button class="item" id="b-manual"><span class="mark">✎</span><span><b>進みを書き込む</b></span></button>'
      : '<button class="item" id="b-open"><span class="mark">▶</span><span><b>' + (m.pct ? '続きから読む' : '読む') + '</b></span></button>') +
    Object.entries(STATUS).filter(([k]) => k !== b.status).map(([k, v]) =>
      '<button class="item" data-st="' + k + '"><span class="mark">·</span><span><b>「' + v + '」に移す</b></span></button>').join('') +
    '<button class="item" id="b-del"><span class="mark">✕</span><span><b style="color:var(--danger)">棚から消す</b>' +
      '<span>本文も抜き書きも消えます</span></span></button>',
    (el) => {
      if ($('#b-open', el)) $('#b-open', el).onclick = () => { closeSheet(); openBook(id); };
      if ($('#b-manual', el)) $('#b-manual', el).onclick = () => manualSheet(b);
      $$('[data-st]', el).forEach((x) => {
        x.onclick = async () => {
          b.status = x.dataset.st;
          if (b.status === 'done' && !b.finished) b.finished = Date.now();
          if (b.status !== 'done') b.finished = 0;
          await DB.put('books', b); await loadBooks(); closeSheet(); render();
        };
      });
      $('#b-del', el).onclick = async () => {
        if (!(await confirmSheet('「' + b.title + '」を消しますか', '本文も、この本の抜き書きも消えます。元に戻せません。', '消す', true))) return;
        for (const n of ns) await Notes.remove(n.id);
        await DB.del('files', id); await DB.del('marks', id); await DB.del('books', id);
        S.covers.delete(id);
        await loadBooks(); render(); toast('消しました');
      };
    });
}

// ================================================================ 青空文庫
function aozoraSheet() {
  sheet('<h3>青空文庫</h3><div id="az"></div>', async (el) => {
    const box = $('#az', el);
    const info = await Aozora.indexInfo();
    if (!info) {
      box.innerHTML = '<p style="color:var(--sub);font-size:13px;line-height:1.8;margin:0 0 14px">' +
        '<b style="color:var(--tx)">先に目録（作品の一覧）だけを落とします。</b>本文は入りません。<br>' +
        '一度入れれば検索は通信なしで動き、<b style="color:var(--tx)">読みたい作品だけ、その都度</b>本文を落とします。<br>' +
        '取得元はこの順に試します：' + esc(Aozora.sources().join(' → ')) + '</p>' +
        '<div class="actions"><button class="btn primary" id="az-get">目録を取り込む</button></div>' +
        '<div id="az-msg" style="font-size:12.5px;color:var(--sub);margin-top:10px;white-space:pre-wrap"></div>';
      $('#az-get', box).onclick = async () => {
        const msg = $('#az-msg', box);
        $('#az-get', box).disabled = true;
        try {
          const n = await Aozora.buildIndex((s) => { msg.textContent = s; });
          toast(n.toLocaleString() + '作品の目録を入れました');
          aozoraSheet();
        } catch (e) {
          msg.innerHTML = '<b style="color:var(--danger)">取得できませんでした。</b>\n' + esc(e.message) +
            '\n\n回線か、配信元の設定が変わっている可能性があります。' +
            'この文面をそのまま伝えてもらえれば原因が絞れます。他の機能には影響しません。';
          $('#az-get', box).disabled = false;
        }
      };
      return;
    }
    box.innerHTML = '<label class="field"><span>作者名・作品名で探す（目録 ' + info.n.toLocaleString() + '作品・本文は選んだときに落とします）</span>' +
      '<input type="text" id="az-q" placeholder="例: 宮沢賢治 銀河" autocomplete="off"></label>' +
      '<div id="az-hit"></div>' +
      '<div class="actions"><button class="btn sm ghost" id="az-re">目録を入れ直す</button></div>';
    const q = $('#az-q', box), hit = $('#az-hit', box);
    let t = null;
    q.oninput = () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        const rows = await Aozora.search(q.value, 40);
        if (!rows || !rows.length) { hit.innerHTML = q.value.trim() ? '<div class="empty">見つかりません</div>' : ''; return; }
        hit.innerHTML = rows.map((r, i) =>
          '<button class="item" data-i="' + i + '"><span class="mark">·</span><span><b>' + esc(r.title) + '</b><span>' + esc(r.author) + '</span></span></button>').join('');
        $$('.item', hit).forEach((b) => { b.onclick = () => getAozora(rows[+b.dataset.i]); });
      }, 200);
    };
    q.focus();
    $('#az-re', box).onclick = async () => { await Aozora.dropIndex(); aozoraSheet(); };
  });
}

async function getAozora(row) {
  toast('落としています…');
  try {
    const w = await Aozora.fetchWork(row.url);
    await addBook({
      title: w.title || row.title, author: w.author || row.author,
      kind: 'aozora', vertical: true, source: row.url,
    }, w.chapters);
    closeSheet(); render(); toast('「' + (w.title || row.title) + '」を入れました');
  } catch (e) {
    toast('取れませんでした: ' + e.message);
  }
}

// ================================================================ クラウド（Google ドライブ / OneDrive）
const CID_KEY = { drive: 'driveClientId', onedrive: 'onedriveClientId' };

function cloudSetupSheet(prov, current) {
  sheet('<h3>' + esc(prov.label) + 'の設定</h3>' +
    '<p style="color:var(--sub);font-size:12.5px;line-height:1.85;margin:0 0 12px">' + prov.setupText + '</p>' +
    '<label class="field"><span>クライアント ID</span><input type="text" id="cid" autocomplete="off" spellcheck="false"></label>' +
    '<div class="actions"><button class="btn" id="cid-c">やめる</button>' +
    '<button class="btn primary" id="cid-s">保存してつなぐ</button></div>',
    (el) => {
      $('#cid', el).value = current || '';
      $('#cid-c', el).onclick = closeSheet;
      $('#cid-s', el).onclick = async () => {
        const v = $('#cid', el).value.trim();
        if (!v) { toast('クライアント ID を入れてください'); return; }
        await DB.setting(CID_KEY[prov.key], v);
        cloudSheet(prov);
      };
    });
}

async function cloudSheet(prov) {
  const clientId = await DB.setting(CID_KEY[prov.key]);
  if (!clientId) return cloudSetupSheet(prov, '');

  sheet('<h3>' + esc(prov.label) + '</h3><div id="cl" style="color:var(--sub);font-size:13px">つないでいます…</div>');
  const box = () => $('#cl');

  try {
    if (prov.key === 'onedrive') {
      const ok = await prov.resume();
      if (!ok) {
        // 認証画面へ飛ぶ。戻ってきたら boot がこのシートを開き直す
        await DB.setting('cloudReopen', prov.key);
        await prov.connect(clientId);
        return;
      }
    } else {
      await prov.connect(clientId);
    }
  } catch (e) {
    if (!box()) return;
    box().innerHTML = '<b style="color:var(--danger)">つなげませんでした。</b><br>' + esc(e.message) +
      '<div class="actions"><button class="btn sm" id="cl-set">設定をやり直す</button></div>';
    $('#cl-set', box()).onclick = () => cloudSetupSheet(prov, clientId);
    return;
  }
  cloudBrowse(prov, [{ id: null, name: prov.label }]);
}

async function cloudBrowse(prov, stack) {
  const here = stack[stack.length - 1];
  const el = sheetEl;
  if (!el) return;
  const crumb = stack.map((f, i) => '<button class="chip" data-i="' + i + '">' + esc(f.name) + '</button>').join(' ');
  el.innerHTML = '<div class="grab"></div><h3>' + esc(prov.label) + '</h3>' +
    '<div style="margin-bottom:8px">' + crumb + '</div>' +
    '<div id="cl-list" style="color:var(--sub);font-size:13px">読み込んでいます…</div>';

  $$('.chip[data-i]', el).forEach((c) => {
    c.onclick = () => cloudBrowse(prov, stack.slice(0, +c.dataset.i + 1));
  });

  let items;
  try { items = await prov.list(here.id); }
  catch (e) { $('#cl-list', el).innerHTML = '<b style="color:var(--danger)">一覧が取れませんでした。</b><br>' + esc(e.message); return; }

  const books = items.filter((x) => !x.isFolder && BOOK_EXT.test(x.name));
  const list = $('#cl-list', el);
  list.innerHTML =
    (books.length ? '<div class="actions" style="margin:0 0 6px"><button class="btn sm primary" id="cl-all">' +
      'このフォルダの本を全部取り込む（' + books.length + '）</button></div>' : '') +
    (items.length
      ? items.map((x, i) => {
          const ok = x.isFolder || BOOK_EXT.test(x.name);
          const mb = x.size ? '　' + (x.size / 1048576).toFixed(1) + ' MB' : '';
          return '<button class="item" data-i="' + i + '"' + (ok ? '' : ' disabled style="opacity:.35"') + '>' +
            '<span class="mark">' + (x.isFolder ? '▸' : '·') + '</span><span><b>' + esc(x.name) + '</b>' +
            '<span>' + (x.isFolder ? 'フォルダ' : (ok ? '本' + mb : '対応していない形式')) + '</span></span></button>';
        }).join('')
      : '<div class="empty">空です</div>') +
    '<div id="cl-msg" style="font-size:12px;color:var(--sub);margin-top:10px"></div>';

  const msg = $('#cl-msg', el);
  $$('.item[data-i]', list).forEach((b) => {
    b.onclick = async () => {
      const x = items[+b.dataset.i];
      if (x.isFolder) return cloudBrowse(prov, stack.concat([{ id: x.id, name: x.name }]));
      await cloudGet(prov, [x], msg);
    };
  });
  if ($('#cl-all', list)) $('#cl-all', list).onclick = () => cloudGet(prov, books, msg);
}

async function cloudGet(prov, items, msg) {
  let n = 0, err = 0;
  for (const x of items) {
    if (msg) msg.textContent = '落としています… ' + (n + err + 1) + ' / ' + items.length + '：' + x.name;
    try {
      const blob = await prov.download(x);
      await importBlob(x.name, blob, prov.label + ':' + x.name);
      n++;
    } catch (e) { console.warn(e); err++; }
  }
  if (msg) msg.textContent = n + '冊を棚に入れました' + (err ? '（' + err + '件は取れませんでした）' : '');
  toast(n ? n + '冊を棚に入れました' : '取り込めませんでした');
  render();
}

// ================================================================ 読書画面
const R = {
  book: null, chapters: [], ch: 0, pager: null,
  open: false, turnAt: 0, saveT: null, selTimer: null,
  off: 0,   // 落ち着いた時点の文字位置。組み直しのときはここへ戻す
};

function readerEls() {
  return {
    root: $('#reader'), flow: $('#rflow'), page: $('#rpage'), bar: $('#rbar'),
    top: $('#rtop'), bot: $('#rbot'), toc: $('#toc'), chap: $('#r-chap'), left: $('#r-left'), title: $('#r-title'),
  };
}

function applyPaper() {
  const e = readerEls();
  Paper.apply(e.root, S.paper);
  e.root.dataset.style = S.paper.style || 'ja';
  e.flow.dataset.dir = S.paper.dir;
  if (R.pager) R.pager.dir = S.paper.dir;
  if (R.open) Paper.tint(getComputedStyle(e.root).backgroundColor);
}

async function openBook(id) {
  const b = S.books.find((x) => x.id === id);
  if (!b) return;
  if (b.manual) { manualSheet(b); return; }
  const file = await DB.get('files', id);
  if (!file || !file.chapters) { toast('本文が見つかりません'); return; }

  R.book = b;
  R.chapters = file.chapters;
  const m = await markOf(id);
  R.ch = Math.min(m.ch || 0, R.chapters.length - 1);

  // この本に覚えさせてある雰囲気を出す
  if (b.mood && Paper.MOODS[b.mood]) S.paper = Paper.moodSettings(b.mood, S.paper);
  applyPaper();

  const e = readerEls();
  e.root.hidden = false;
  R.open = true;
  e.title.textContent = b.title;
  R.pager = new Pager(e.page, e.flow);
  R.pager.dir = S.paper.dir;

  await showChapter(R.ch, m.off || 0);
  Stats.begin(b.id);
  R.turnAt = Date.now();
  await DB.setting('lastBook', b.id);
  if (b.status !== 'reading') { b.status = 'reading'; b.finished = 0; await DB.put('books', b); await loadBooks(); }
}

async function showChapter(i, off) {
  const e = readerEls();
  R.ch = Math.min(Math.max(0, i), R.chapters.length - 1);
  R.pager.setHTML(R.chapters[R.ch].html);
  // レイアウトは描画が落ち着いてから測る
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  R.pager.layout();
  if (off) R.pager.go(R.pager.pageOf(off));
  else R.pager.go(0);
  paintFoot();
}

function paintFoot() {
  const e = readerEls();
  const p = R.pager;
  if (!p) return;
  const off = p.offsetAt(p.i);
  R.off = off;
  const before = (R.book.chapChars || []).slice(0, R.ch).reduce((a, b) => a + b, 0);
  const pct = R.book.chars ? Math.min(1, (before + off) / R.book.chars) : (p.i + 1) / p.n;
  e.bar.style.width = (pct * 100).toFixed(1) + '%';
  e.chap.textContent = R.chapters[R.ch].title || ('第' + (R.ch + 1) + '節');
  const leftChars = Math.max(0, p.total - off);
  const mins = Stats.minutesFor(leftChars);
  e.left.textContent = (R.ch < R.chapters.length - 1 ? 'この章' : '終わりまで') + ' あと ' + (mins || 1) + ' 分 · ' + (p.i + 1) + '/' + p.n;
  saveMark(pct, off);
}

function saveMark(pct, off) {
  clearTimeout(R.saveT);
  R.saveT = setTimeout(async () => {
    const p = R.pager;
    if (!p || !R.book) return;
    const to = p.offsetAt(p.i + 1);
    const line = p.text(Math.max(0, to - 70), to).replace(/\s+/g, ' ').trim();
    await DB.put('marks', { id: R.book.id, ch: R.ch, off, pct, lastLine: line, updated: Date.now() });
  }, 500);
}

async function turn(d) {
  const p = R.pager;
  if (!p) return;
  // 送る前のページの文字数と、掛かった時間から読む速さを測る
  const dt = Date.now() - R.turnAt;
  if (d > 0) {
    const n = p.charsOn(p.i);
    Stats.addPage(n, dt);
    Stats.tickChars(n);
  }
  R.turnAt = Date.now();

  if (d > 0 && p.atEnd) {
    if (R.ch < R.chapters.length - 1) { await showChapter(R.ch + 1, 0); return; }
    finishSheet();
    return;
  }
  if (d < 0 && p.atStart) {
    if (R.ch > 0) {
      await showChapter(R.ch - 1, 0);
      R.pager.go(R.pager.n - 1);
      paintFoot();
    }
    return;
  }
  p.go(p.i + d);
  paintFoot();
}

function closeReader() {
  const e = readerEls();
  const s = Stats.end();
  if (s && R.book) Stats.publishToDesk(R.book.title, s.ms);
  e.root.hidden = true;
  e.top.hidden = e.bot.hidden = e.toc.hidden = true;
  R.open = false; R.book = null; R.pager = null;
  applyChrome();
  loadBooks().then(render);
}

// 読み終わり
function finishSheet() {
  const b = R.book;
  sheet('<h3>読み終えましたか</h3>' +
    '<p style="color:var(--sub);font-size:13px;line-height:1.8;margin:0 0 4px">' +
    '星はつけません。代わりに、一番残った一文をひとつだけ選びます。</p>' +
    '<div id="f-q"></div>' +
    '<div class="actions"><button class="btn" id="f-no">まだ読む</button>' +
    '<button class="btn primary" id="f-yes">読み終えた</button></div>',
    async (el) => {
      const ns = await Notes.ofBook(b.id);
      const box = $('#f-q', el);
      if (ns.length) {
        box.innerHTML = '<div class="h">この本の抜き書きから</div>' + ns.map((n) =>
          '<button class="item" data-id="' + n.id + '"><span class="mark">·</span><span><b style="font-weight:400;line-height:1.8">' +
          esc(n.quote.slice(0, 70)) + (n.quote.length > 70 ? '…' : '') + '</b></span></button>').join('');
        $$('.item', box).forEach((x) => {
          x.onclick = async () => {
            b.best = x.dataset.id;
            $$('.item', box).forEach((y) => y.style.opacity = y === x ? '1' : '.4');
          };
        });
      } else {
        box.innerHTML = '<p style="color:var(--sub);font-size:12.5px">この本には抜き書きがありません。選ぶものが無いので、このまま閉じます。</p>';
      }
      $('#f-no', el).onclick = closeSheet;
      $('#f-yes', el).onclick = async () => {
        b.status = 'done'; b.finished = Date.now();
        await DB.put('books', b);
        closeSheet(); closeReader(); toast('読了にしました');
      };
    });
}

// --- 目次
function tocOpen() {
  const e = readerEls();
  e.toc.hidden = false;
  e.toc.innerHTML = '<button class="rbtn" id="toc-x" style="margin-bottom:12px">閉じる</button>' +
    R.chapters.map((c, i) =>
      '<button data-i="' + i + '" aria-current="' + (i === R.ch) + '">' + esc(c.title || ('第' + (i + 1) + '節')) +
      '<span class="n">' + ((R.book.chapChars || [])[i] || 0).toLocaleString() + '文字</span></button>').join('');
  $('#toc-x', e.toc).onclick = () => { e.toc.hidden = true; };
  $$('#toc button[data-i]').forEach((b) => {
    b.onclick = async () => { e.toc.hidden = true; hideUI(); await showChapter(+b.dataset.i, 0); };
  });
}

function hideUI() { const e = readerEls(); e.top.hidden = e.bot.hidden = true; }
function toggleUI() {
  const e = readerEls();
  const show = e.top.hidden;
  e.top.hidden = e.bot.hidden = !show;
  if (show) { buildReadSheet(); e.bot.scrollTop = 0; }
}

// ---------------------------------------------------------------- 設定シート（紙）
function buildReadSheet() {
  const e = readerEls();
  const s = S.paper;
  const opts = (id, map, cur) =>
    '<div class="opts" id="' + id + '">' + Object.entries(map).map(([k, v]) =>
      '<button class="rbtn' + (cur === k ? ' on' : '') + '" data-v="' + k + '">' + esc(v.label || v) + '</button>').join('') + '</div>';
  const slider = (key) => {
    const r = Paper.RANGES[key];
    return '<div class="ctl"><label class="lbl" for="sl-' + key + '">' + r.label + '</label>' +
      '<input type="range" id="sl-' + key + '" min="' + r.min + '" max="' + r.max + '" step="' + r.step + '" value="' + s[key] + '">' +
      '<span class="val" id="vl-' + key + '">' + s[key] + '</span></div>';
  };

  e.bot.innerHTML =
    '<div class="ctl"><span class="lbl">雰囲気</span>' + opts('g-mood', Paper.MOODS, s.mood) + '</div>' +
    '<div class="rhint">選ぶと下の値がまとめて動きます。そのあと個別に触れます。</div>' +
    '<div class="rsep"></div>' +
    '<div class="ctl"><span class="lbl">組み方</span>' + opts('g-dir', { v: { label: '縦組み' }, h: { label: '横組み' } }, s.dir) + '</div>' +
    '<div class="ctl"><span class="lbl">書体</span>' + opts('g-fam', Paper.FAMS, s.fam) + '</div>' +
    slider('fs') + slider('lh') + slider('ls') + slider('margin') +
    '<div class="rsep"></div>' +
    '<div class="ctl"><span class="lbl">紙</span>' + opts('g-paper', Paper.PAPERS, s.paper) + '</div>' +
    slider('grain') + slider('fine') + slider('gutter') + slider('ink') +
    '<div class="rhint">紙の目は強くしても読みやすくはなりません。文字と地の差が縮むだけです。効くのは、効いていると気づかない程度までです。' +
      '暗い紙にのせると画面が真っ黒でなくなるので、有機 EL の省電力は効かなくなります。</div>' +
    '<div class="rsep"></div>' +
    '<div class="ctl"><span class="lbl">ページ送り</span>' + opts('g-anim', { none: { label: 'なし' }, fade: { label: '薄く' } }, s.anim) + '</div>' +
    '<div class="ctl" style="gap:8px;padding-top:12px">' +
      '<button class="rbtn" id="g-reset">既定に戻す</button>' +
      '<button class="rbtn" id="g-close">閉じる</button></div>';

  const group = (id, fn) => {
    const g = $('#' + id, e.bot);
    if (!g) return;
    g.onclick = (ev) => {
      const b = ev.target.closest('button');
      if (!b) return;
      $$('button', g).forEach((x) => x.classList.toggle('on', x === b));
      fn(b.dataset.v);
    };
  };

  group('g-mood', async (v) => { S.paper = Paper.moodSettings(v, S.paper); await commitPaper(true); buildReadSheet(); });
  group('g-dir', async (v) => { S.paper.dir = v; await commitPaper(true); });
  group('g-fam', async (v) => { S.paper.fam = v; await commitPaper(true); });
  group('g-paper', async (v) => { S.paper.paper = v; await commitPaper(false); });
  group('g-anim', async (v) => { S.paper.anim = v; await commitPaper(false); });

  const RELAYOUT = new Set(['fs', 'lh', 'ls', 'margin']);
  for (const key of Object.keys(Paper.RANGES)) {
    const el = $('#sl-' + key, e.bot);
    if (!el) continue;
    el.oninput = () => {
      S.paper[key] = +el.value;
      $('#vl-' + key, e.bot).textContent = el.value;
      commitPaper(RELAYOUT.has(key));
    };
  }
  $('#g-reset', e.bot).onclick = async () => { S.paper = Paper.defaults(); await commitPaper(true); buildReadSheet(); };
  $('#g-close', e.bot).onclick = hideUI;
}

let relayoutT = null;
async function commitPaper(relayout) {
  // 組み直しが要るときは、見た目を変える前の文字位置を押さえておく。
  // 変えたあとで測ると、もう別の場所を指している。
  const off = R.pager ? R.off : 0;
  applyPaper();
  await DB.setting('paper', S.paper);
  if (R.book) { R.book.mood = S.paper.mood; DB.put('books', R.book); }
  if (!relayout || !R.pager) return;
  clearTimeout(relayoutT);
  relayoutT = setTimeout(() => {
    if (!R.pager) return;
    R.pager.layout();
    R.pager.go(R.pager.pageOf(off));
    paintFoot();
  }, 90);
}

// ---------------------------------------------------------------- 選択 → 抜き書き
function selectionOffsets() {
  const sel = getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  if (!$('#rflow').contains(r.commonAncestorContainer)) return null;
  const text = sel.toString().replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const off = R.pager ? R.pager.offsetOfNode(r.startContainer, r.startOffset) : 0;
  return { text, off };
}

function onSelChange() {
  if (!R.open) return;
  clearTimeout(R.selTimer);
  R.selTimer = setTimeout(() => {
    const s = selectionOffsets();
    $('#selbar').hidden = !s;
  }, 180);
}

function saveSelection() {
  const s = selectionOffsets();
  if (!s) return;
  $('#selbar').hidden = true;
  sheet('<h3>抜き書き</h3>' +
    '<blockquote style="margin:0 0 14px;padding-left:12px;border-left:2px solid var(--acc);font-size:14px;line-height:1.9">' + esc(s.text) + '</blockquote>' +
    '<label class="field"><span>自分の反応（あとで効くのはここ）</span><textarea id="q-n" placeholder="なぜ引いたのか、一行でいい"></textarea></label>' +
    '<label class="field"><span>タグ（空白区切り）</span><input type="text" id="q-t"></label>' +
    '<div class="actions"><button class="btn" id="q-c">やめる</button><button class="btn primary" id="q-s">残す</button></div>',
    (el) => {
      $('#q-c', el).onclick = closeSheet;
      $('#q-s', el).onclick = async () => {
        await Notes.add({
          bookId: R.book.id, bookTitle: R.book.title,
          chapter: R.chapters[R.ch].title, ch: R.ch, off: s.off,
          quote: s.text, note: $('#q-n', el).value,
          tags: $('#q-t', el).value.split(/\s+/).map((t) => t.replace(/^#/, '')).filter(Boolean),
        });
        closeSheet();
        getSelection().removeAllRanges();
        toast('残しました');
      };
      $('#q-n', el).focus();
    });
}

// ---------------------------------------------------------------- アプリ設定
async function gearSheet() {
  const u = await DB.usage();
  const mb = (n) => (n / 1048576).toFixed(0) + ' MB';
  const themes = { sumi: '墨', kiri: '霧', hai: '灰', aitetsu: '藍鉄', kinari: '生成り', hakuji: '白磁', shirokuma: 'しろくま' };
  const accents = { kohaku: '琥珀', sabi: '錆', koke: '苔', fuji: '藤', toki: '鴇', asagi: '浅葱', ai: '藍', karashi: '芥子', kuwa: '桑', mizu: '水色', mono: 'モノクロ' };
  const fonts = { system: 'システム標準', gothic: 'ゴシック', mincho: '明朝', maru: '丸ゴシック' };
  const row = (label, id, map, cur) =>
    '<div class="h">' + label + '</div><div id="' + id + '">' + Object.entries(map).map(([k, v]) =>
      '<button class="chip" data-v="' + k + '" aria-pressed="' + (cur === k) + '">' + v + '</button>').join('') + '</div>';

  sheet('<h3>設定</h3>' +
    row('テーマ（アプリの画面）', 'g-theme', themes, S.chrome.theme) +
    row('アクセント', 'g-accent', accents, S.chrome.accent) +
    row('フォント', 'g-font', fonts, S.chrome.font) +
    '<div class="h">クラウド</div>' +
    '<div id="g-cloud"></div>' +
    '<div class="h">明朝（本文の書体）</div>' +
    '<div id="g-mincho"></div>' +
    '<div class="h">保存</div>' +
    '<div style="color:var(--sub);font-size:12.5px;line-height:1.8">' +
      (u && u.usage != null ? '使用 ' + mb(u.usage) + ' / 空き見込み ' + mb(u.quota || 0) + '<br>' : '') +
      '本の中身はこの端末の中だけに入ります。ブラウザの「サイトデータを削除」を実行すると全部消えます。</div>' +
    '<div class="actions"><button class="btn sm" id="g-persist">保存を固定する</button>' +
    '<button class="btn sm" id="g-export">全部を書き出す</button></div>' +
    '<div class="h">この画面について</div>' +
    '<div style="color:var(--sub);font-size:12.5px;line-height:1.8">ぽちゃ文庫 v0.5 — 端末の中だけで動きます。どこにも送りません。</div>',
    (el) => {
      const bind = (id, key) => {
        $('#' + id, el).onclick = async (ev) => {
          const b = ev.target.closest('button'); if (!b) return;
          S.chrome[key] = b.dataset.v;
          $$('button', $('#' + id, el)).forEach((x) => x.setAttribute('aria-pressed', x === b));
          applyChrome();
          await DB.setting('chrome', S.chrome);
        };
      };
      bind('g-theme', 'theme'); bind('g-accent', 'accent'); bind('g-font', 'font');
      cloudPanel($('#g-cloud', el));
      minchoPanel($('#g-mincho', el));
      $('#g-persist', el).onclick = async () => {
        const ok = await DB.persist();
        toast(ok ? '固定しました' : '固定できませんでした（端末の判断です）');
      };
      $('#g-export', el).onclick = async () => {
        const rows = await Notes.list();
        exportNotes(rows);
      };
    });
}

async function cloudPanel(box) {
  const rows = [];
  for (const prov of [Drive, OneDrive]) {
    const cid = await DB.setting(CID_KEY[prov.key]);
    const linked = prov.key === 'onedrive' ? await prov.linked() : false;
    const state = !cid ? '未設定' : (prov.key === 'onedrive' ? (linked ? 'つながっています' : 'クライアント ID のみ設定済み') : 'クライアント ID 設定済み');
    rows.push('<button class="item" data-k="' + prov.key + '"><span class="mark">' + (cid ? '●' : '○') + '</span>' +
      '<span><b>' + esc(prov.label) + '</b><span>' + state + '</span></span></button>');
  }
  box.innerHTML = rows.join('') +
    '<div style="color:var(--sub);font-size:12px;line-height:1.7;margin-top:8px">' +
    '読み取り専用でつなぎます。落とした本は端末に保存され、以後はオフラインで読めます。' +
    'クライアント ID と認証の記録はこの端末の中にだけ残ります。</div>';
  $$('.item[data-k]', box).forEach((b) => {
    b.onclick = () => cloudManageSheet(b.dataset.k === 'drive' ? Drive : OneDrive);
  });
}

async function cloudManageSheet(prov) {
  const cid = await DB.setting(CID_KEY[prov.key]);
  const linked = prov.key === 'onedrive' ? await prov.linked() : false;
  sheet('<h3>' + esc(prov.label) + '</h3>' +
    '<button class="item" id="m-open"><span class="mark">▸</span><span><b>フォルダを開いて取り込む</b></span></button>' +
    '<button class="item" id="m-set"><span class="mark">✎</span><span><b>クライアント ID を' + (cid ? '変える' : '入れる') + '</b>' +
      (cid ? '<span style="word-break:break-all">' + esc(cid.slice(0, 44)) + (cid.length > 44 ? '…' : '') + '</span>' : '') + '</span></button>' +
    (linked || prov.key === 'drive'
      ? '<button class="item" id="m-out"><span class="mark">✕</span><span><b style="color:var(--danger)">つなぎを切る</b>' +
        '<span>取り込み済みの本はそのまま残ります</span></span></button>' : ''),
    (el) => {
      $('#m-open', el).onclick = () => cloudSheet(prov);
      $('#m-set', el).onclick = () => cloudSetupSheet(prov, cid || '');
      if ($('#m-out', el)) $('#m-out', el).onclick = async () => {
        await prov.signOut();
        closeSheet(); toast('切りました');
      };
    });
}

// 明朝の取り込み。端末に明朝がある人（iOS など）は落とす必要がない。
async function minchoPanel(box) {
  const have = Font.deviceMincho();
  const got = await Font.info();
  const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

  if (have && !got) {
    box.innerHTML = '<div style="color:var(--sub);font-size:12.5px;line-height:1.8">' +
      'この端末には明朝（' + esc(have) + '）が入っています。<b style="color:var(--tx)">取り込む必要はありません。</b></div>' +
      '<div class="actions"><button class="btn sm ghost" id="mi-get">それでも取り込む</button></div>';
  } else if (got) {
    box.innerHTML = '<div style="color:var(--sub);font-size:12.5px;line-height:1.8">' +
      '取り込み済み（' + mb(got.bytes) + '・' + got.n + '個）。' +
      (got.failed ? '<b style="color:var(--danger)">' + got.failed + '個は落とせませんでした。</b>一部の字がゴシックのまま出ます。' : 'オフラインでも明朝で出ます。') +
      (have ? '<br>この端末には ' + esc(have) + ' もあるので、そちらが優先されます。' : '') + '</div>' +
      '<div class="actions">' + (got.failed ? '<button class="btn sm" id="mi-get">取り直す</button>' : '') +
      '<button class="btn sm ghost" id="mi-del">消す</button></div>';
  } else {
    box.innerHTML = '<div style="color:var(--sub);font-size:12.5px;line-height:1.8">' +
      '<b style="color:var(--tx)">この端末には明朝が入っていません。</b>' +
      'Android の標準はゴシックだけなので、書体で「明朝」を選んでも黙ってゴシックで出ます。<br>' +
      '一度だけ落として端末に置くと、以後はオフラインでも明朝で読めます（約 3.8 MB）。' +
      '必要な字の分だけ読み込むので、表示が重くなることはありません。</div>' +
      '<div class="actions"><button class="btn sm primary" id="mi-get">明朝を取り込む</button></div>';
  }
  box.insertAdjacentHTML('beforeend', '<div id="mi-msg" style="font-size:12px;color:var(--sub);margin-top:8px"></div>');

  const msg = $('#mi-msg', box);
  const get = $('#mi-get', box);
  if (get) get.onclick = async () => {
    get.disabled = true;
    try {
      const r = await Font.download((s2) => { msg.textContent = s2; });
      toast('明朝を取り込みました（' + mb(r.bytes) + '）');
      minchoPanel(box);
    } catch (e) {
      msg.innerHTML = '<b style="color:var(--danger)">取り込めませんでした。</b>' + esc(e.message) +
        '<br>回線を確かめてやり直してください。他の機能には影響しません。';
      get.disabled = false;
    }
  };
  const del = $('#mi-del', box);
  if (del) del.onclick = async () => {
    if (!(await confirmSheet('取り込んだ明朝を消しますか', '読むのに支障はありません。書体はゴシックで出るようになります。', '消す', true))) return;
    await Font.remove();
    toast('消しました。次に開き直すと外れます');
    minchoPanel(box);
  };
}

// ---------------------------------------------------------------- 画面切替
function render() {
  $('#v-now').hidden = S.view !== 'now';
  $('#v-shelf').hidden = S.view !== 'shelf';
  $('#v-notes').hidden = S.view !== 'notes';
  $('#v-log').hidden = S.view !== 'log';
  $('#btn-search').hidden = S.view !== 'shelf';
  $('#top-title').textContent = { now: 'ぽちゃ文庫', shelf: '棚', notes: '抜き書き', log: '記録' }[S.view];
  $$('#tabs button').forEach((b) => b.setAttribute('aria-current', b.dataset.view === S.view));
  ({ now: renderNow, shelf: renderShelf, notes: renderNotes, log: renderLog })[S.view]();
}

function searchSheet() {
  sheet('<h3>棚を探す</h3><label class="field"><input type="text" id="sq" placeholder="題名・著者" autocomplete="off"></label><div id="sr"></div>',
    (el) => {
      const q = $('#sq', el), out = $('#sr', el);
      q.oninput = () => {
        const v = q.value.trim();
        if (!v) { out.innerHTML = ''; return; }
        const hit = S.books.filter((b) => (b.title + ' ' + (b.author || '')).includes(v)).slice(0, 30);
        out.innerHTML = hit.length ? hit.map((b) =>
          '<button class="item" data-id="' + b.id + '"><span class="mark">·</span><span><b>' + esc(b.title) + '</b>' +
          '<span>' + esc(b.author || '') + ' · ' + STATUS[b.status] + '</span></span></button>').join('')
          : '<div class="empty">見つかりません</div>';
        $$('.item', out).forEach((x) => { x.onclick = () => { closeSheet(); bookSheet(x.dataset.id); }; });
      };
      q.focus();
    });
}

// ---------------------------------------------------------------- 起動
async function boot() {
  await DB.open();
  const chrome = await DB.setting('chrome');
  if (chrome) Object.assign(S.chrome, chrome);
  const paper = await DB.setting('paper');
  if (paper) S.paper = Object.assign(Paper.defaults(), paper);
  applyChrome();
  Font.install().catch(() => {});
  await Stats.load();
  await loadBooks();
  render();

  $$('#tabs button').forEach((b) => { b.onclick = () => { S.view = b.dataset.view; render(); }; });
  $('#btn-gear').onclick = gearSheet;
  $('#btn-search').onclick = searchSheet;
  $('#pick').onchange = (e) => { importFiles([...e.target.files]); e.target.value = ''; };

  // 読書画面
  const uiOpen = () => !$('#rtop').hidden || !$('#toc').hidden;
  const z = (which) => async () => {
    // 操作を出している間は、どこを触っても片づけるだけ。送らない。
    if (uiOpen()) { $('#toc').hidden = true; hideUI(); return; }
    // 縦組みは右から左へ進むので、左のタップが「次」になる
    const fwd = S.paper.dir === 'v' ? (which === 'a') : (which === 'b');
    await turn(fwd ? 1 : -1);
  };
  $('#z-a').onclick = z('a');
  $('#z-b').onclick = z('b');
  $('#z-ui').onclick = () => { if (!$('#toc').hidden) { $('#toc').hidden = true; hideUI(); return; } toggleUI(); };
  $('#r-close').onclick = closeReader;
  $('#r-toc').onclick = tocOpen;
  $('#sel-note').onclick = saveSelection;
  $('#sel-cancel').onclick = () => { getSelection().removeAllRanges(); $('#selbar').hidden = true; };
  document.addEventListener('selectionchange', onSelChange);

  document.addEventListener('keydown', (e) => {
    if (!R.open) return;
    if (e.key === 'Escape') { if (!$('#toc').hidden) { $('#toc').hidden = true; return; } if (!$('#rtop').hidden) { hideUI(); return; } closeReader(); }
    if (e.key === 'ArrowLeft') turn(S.paper.dir === 'v' ? 1 : -1);
    if (e.key === 'ArrowRight') turn(S.paper.dir === 'v' ? -1 : 1);
    if (e.key === ' ') { e.preventDefault(); turn(1); }
  });

  let rsT = null;
  addEventListener('resize', () => {
    if (!R.open || !R.pager) return;
    clearTimeout(rsT);
    const off = R.pager.offsetAt(R.pager.i);
    rsT = setTimeout(() => { R.pager.layout(); R.pager.go(R.pager.pageOf(off)); paintFoot(); }, 160);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { Stats.pause(); R.turnAt = Date.now(); }
    else { Stats.resume(); R.turnAt = Date.now(); }
  });
  addEventListener('pagehide', () => { const s = Stats.end(); if (s && R.book) Stats.publishToDesk(R.book.title, s.ms); });

  // OneDrive の認証から戻ってきていたら受け取って、開いていたシートを開き直す
  try {
    const r = await OneDrive.finishSignIn();
    if (r) {
      const reopen = await DB.setting('cloudReopen');
      await DB.del('settings', 'cloudReopen');
      if (r.ok) { toast('OneDrive につながりました'); if (reopen === 'onedrive') cloudSheet(OneDrive); }
      else toast('OneDrive につなげませんでした: ' + r.message);
    }
  } catch (e) { console.warn(e); }

  DB.persist();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

boot();
