// 画面の組み立て。
//
// 1ノートの一生：
//   開く   → 書きかけ（drafts）があればそれ、なければ端末の控え（files）をすぐ出す
//          → 裏で OneDrive から最新を取り、変わっていれば差し替える
//   書く   → すぐ drafts に控える（閉じても消えない）→ 2 秒止まったら OneDrive へ送る
//   送る   → 読んだときの版（eTag）を添える。食い違えば「競合」を出して選ばせる
import * as DB from './store.js';
import * as Auth from './auth.js';
import * as L from './lock.js';
import * as G from './graph.js';
import * as V from './vault.js';
import * as R from './render.js';
import * as RD from './reader.js';
import { createEditor } from '../vendor/editor.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let vault = '';          // OneDrive の一番上からの保管庫のパス
let cur = null;          // いま開いているノート { path, text, baseETag, dirty, mode, conflict }
let lastTreeAt = 0;
let pushTimer = 0;
let draftTimer = 0;
let retryTimer = 0;
let pushing = null;
const blobUrls = new Map();
// 開いたフォルダと最近のノート。ノート名が入るので localStorage ではなく暗号化して控える
let openFolders = new Set();
let recent = [];
const wide = () => matchMedia('(min-width: 1200px)').matches;
const touch = () => matchMedia('(pointer: coarse)').matches;

// 編集欄（CodeMirror）。中身はノートを開くたびに差し替える
let editorPath = null;
const editor = createEditor($('editor'), {
  onChange: (text) => { if (!cur) return; cur.text = text; markDirty(cur); },
  onSave: () => { if (cur && cur.dirty) schedulePush(0); },
});

// ---------------------------------------------------------------- 表示の小物

function status(text, kind = '') {
  const el = $('status');
  el.hidden = !text;
  el.textContent = text;
  el.className = 'status ' + kind;
}

let bannerAction = null;
function banner(html, action) {
  const el = $('banner');
  el.hidden = !html;
  el.innerHTML = html || '';
  bannerAction = action || null;
}
$('banner').addEventListener('click', (e) => {
  if (e.target.closest('button') && bannerAction) bannerAction();
});

function toast(msg) {
  for (const old of document.querySelectorAll('.toast')) old.remove();
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

function needSignIn() {
  banner('サインインの期限が切れました。書きかけは端末に残っています。<button class="btn small primary">サインイン</button>',
    () => Auth.signIn().catch((e) => toast(e.message)));
  status('要サインイン', 'warn');
}

function fail(e) {
  if (e instanceof G.NeedSignIn) return needSignIn();
  console.error(e);
  toast(navigator.onLine ? e.message : '電波がありません');
}


// ---------------------------------------------------------------- 端末の「戻る」
// スマホで一覧や目次を開いたとき、履歴を1つ積んでおく。Android の「戻る」でそれを閉じる
// （積まないと、戻るで前のノートへ行ってしまう）。
let overlays = 0;
const narrow = () => matchMedia('(max-width: 899px)').matches;
function pushOverlay() {
  history.pushState({ overlay: true }, '');
  overlays++;
}
// 画面の操作で閉じたとき：積んだ分を取り消す
function popOverlay() {
  if (!overlays) return;
  overlays--;
  history.back();
}
window.addEventListener('popstate', () => {
  if (!overlays) return;
  overlays--;
  if (document.body.classList.contains('side-open') && narrow()) { document.body.classList.remove('side-open'); return; }
  if (!$('outline').hidden && !wide()) { $('outline').hidden = true; }
});

const side = {
  open() {
    if (document.body.classList.contains('side-open')) return;
    document.body.classList.add('side-open');
    if (narrow()) pushOverlay();
  },
  close() {
    if (!document.body.classList.contains('side-open')) return;
    document.body.classList.remove('side-open');
    if (narrow()) popOverlay();
  },
  toggle() { if (document.body.classList.contains('side-open')) side.close(); else side.open(); },
};

// ---------------------------------------------------------------- 一覧（サイドバー）

async function saveTree() {
  await DB.setting('tree', V.items.map(({ url, ...rest }) => rest)); // 一時 URL は1時間で切れるので控えない
}

function renderTree() {
  const open = new Set(openFolders);
  if (cur) {
    // いま開いているノートの親フォルダは開いて見せる
    let d = V.dirName(cur.path);
    while (d) { open.add(d); d = V.dirName(d); }
  }
  const y = $('tree').scrollTop;
  const t = V.tree();
  const node = (n, depth) => {
    let h = '';
    for (const f of n.folders) {
      h += '<details class="folder"' + (open.has(f.path) ? ' open' : '') + ' data-path="' + esc(f.path) + '">' +
        '<summary style="--d:' + depth + '">' + esc(f.name) + '</summary>' + node(f, depth + 1) + '</details>';
    }
    for (const it of n.files) {
      h += '<a class="file' + (cur && cur.path === it.path ? ' on' : '') + '" style="--d:' + depth + '" href="#" data-note="' +
        esc(it.path) + '">' + esc(V.title(it.name)) + '</a>';
    }
    return h;
  };
  $('tree').innerHTML = node(t, 0) || '<p class="muted pad">' + (vault ? 'ノートがありません' : '保管庫がまだ選ばれていません') + '</p>';
  $('tree').scrollTop = y;
  const on = $('tree').querySelector('.file.on');
  if (on) {
    const r = on.getBoundingClientRect(), box = $('tree').getBoundingClientRect();
    if (r.top < box.top || r.bottom > box.bottom) on.scrollIntoView({ block: 'center' });
  }
  $('treeInfo').textContent = V.notes().length ? V.notes().length + ' ノート' : '';
}

$('tree').addEventListener('toggle', (e) => {
  const d = e.target;
  if (!d.matches || !d.matches('details.folder')) return;
  if (d.open) openFolders.add(d.dataset.path); else openFolders.delete(d.dataset.path);
  DB.setting('open', [...openFolders]).catch(() => {});
}, true);

let treeJob = null;
function refreshTree() {
  if (!treeJob) treeJob = loadTree().finally(() => { treeJob = null; });
  return treeJob;
}
async function loadTree() {
  if (!vault || !(await Auth.signedIn())) return;
  $('treeInfo').textContent = '読み込み中…';
  try {
    const list = await G.walk(vault, (n) => { $('treeInfo').textContent = '読み込み中… ' + n; });
    V.load(list);
    lastTreeAt = Date.now();
    await saveTree();
    renderTree();
    // 一覧が無いうちに開こうとしたノート（初回起動・控えを消した後）は、ここで開き直す
    if (cur && !cur.loaded && V.get(cur.path)) { cur = null; route(); }
    pushDrafts();
  } catch (e) {
    renderTree();
    if (e instanceof G.NotFound) toast('保管庫のフォルダが見つかりません：' + vault);
    else fail(e);
  }
}

// ---------------------------------------------------------------- 検索

let searchSeq = 0;

function filterByName(q) {
  const k = q.normalize('NFKC').toLowerCase();
  return V.notes().filter((it) => it.path.normalize('NFKC').toLowerCase().includes(k)).slice(0, 200);
}

function showResults(list, note) {
  const el = $('results');
  el.hidden = false;
  $('tree').hidden = true;
  el.innerHTML = (note ? '<p class="muted pad">' + note + '</p>' : '') + (list.length
    ? list.map((r) => '<a class="hit" href="#" data-note="' + esc(r.path) + '"><b>' + esc(V.title(r.path)) + '</b>' +
      '<small>' + esc(V.dirName(r.path)) + '</small>' + (r.snip ? '<span>' + r.snip + '</span>' : '') + '</a>').join('')
    : '<p class="muted pad">見つかりません</p>');
}

function clearSearch() {
  $('results').hidden = true;
  $('tree').hidden = false;
}

async function fullSearch(q) {
  const seq = ++searchSeq;
  const k = q.normalize('NFKC').toLowerCase();
  const hits = new Map();
  for (const it of filterByName(q)) hits.set(it.path, { path: it.path });

  // 端末の控えから本文を探す
  const files = await DB.all('files');
  for (const f of files) {
    if (!V.get(f.path)) continue;
    // 抜粋の位置は元の文字で取る（正規化すると長さが変わる文字があり、ずれる）
    let i = f.text.toLowerCase().indexOf(q.toLowerCase());
    let len = q.length;
    if (i < 0) {
      if (!f.text.normalize('NFKC').toLowerCase().includes(k)) continue;
      i = 0; len = 0; // 正規化で初めて当たった。場所は示さず冒頭を出す
    }
    const s = Math.max(0, i - 30);
    const snip = esc(f.text.slice(s, i)) + (len ? '<mark>' + esc(f.text.slice(i, i + len)) + '</mark>' : '') + esc(f.text.slice(i + len, i + len + 60));
    hits.set(f.path, { path: f.path, snip });
  }
  const local = files.length;
  showResults([...hits.values()], local < V.notes().length ? '本文は端末に控えたノートから探しています。OneDrive にも問い合わせ中…' : '');

  // 控えていないノートもあるので OneDrive の検索にも聞く（索引の反映は少し遅れる）
  if (!navigator.onLine || local >= V.notes().length) return;
  try {
    const ids = new Set(await G.search(q));
    if (seq !== searchSeq) return;
    for (const it of V.notes()) if (ids.has(it.id) && !hits.has(it.path)) hits.set(it.path, { path: it.path, snip: '<i>OneDrive の検索で見つかった</i>' });
    showResults([...hits.values()]);
  } catch (e) {
    if (seq === searchSeq) showResults([...hits.values()], 'OneDrive の検索には失敗しました');
  }
}

$('q').addEventListener('input', () => {
  const q = $('q').value.trim();
  if (!q) return clearSearch();
  showResults(filterByName(q).map((it) => ({ path: it.path })), 'Enter で本文も探す');
});
$('q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && $('q').value.trim()) { e.preventDefault(); fullSearch($('q').value.trim()); }
  if (e.key === 'Escape') { $('q').value = ''; clearSearch(); }
});

// ---------------------------------------------------------------- 画面の切り替え

function route() {
  if (!L.unlocked()) return;
  if (location.hash === '#new' || location.hash === '#search') {
    const what = location.hash;
    history.replaceState(null, '', location.pathname);
    showHome();
    if (what === '#new') createNote();
    else { side.open(); $('q').focus(); }
    return;
  }
  const h = new URLSearchParams(location.hash.slice(1));
  const path = h.get('n');
  if (path) openNote(path, h.get('h') || '');
  else showHome();
}

function go(path, heading = '') {
  const h = new URLSearchParams();
  h.set('n', path);
  if (heading) h.set('h', heading);
  const next = '#' + h.toString();
  if (overlays) {
    // 一覧・目次を開いたまま移る。積んだ履歴の上書きで移れば「戻る」で前のノートに戻れる
    overlays = 0;
    document.body.classList.remove('side-open');
    if (!wide()) $('outline').hidden = true;
    history.replaceState(null, '', next);
    route();
    return;
  }
  if (location.hash === next) {
    const el = R.findHeading($('view'), heading);
    if (el) el.scrollIntoView();
  } else {
    location.hash = next;
  }
  if (narrow()) side.close();
}

window.addEventListener('hashchange', route);

async function showHome() {
  await leave();
  cur = null;
  $('title').textContent = 'ノート';
  document.title = 'ノート';
  $('crumb').hidden = true;
  $('btnMode').hidden = true;
  $('btnOutline').hidden = true;
  $('outline').hidden = true;
  document.body.classList.remove('editing');
  $('view').hidden = true;
  $('editwrap').hidden = true;
  $('home').hidden = false;
  status('');
  renderTree();

  const drafts = await DB.all('drafts');
  let h = '';
  if (!vault || !(await Auth.clientId())) {
    h += '<div class="card"><h2>はじめに</h2><p>右上の ⚙ から、Microsoft アカウントでサインインして、Obsidian の保管庫のフォルダを選んでください。</p>' +
      '<button class="btn primary" data-act="settings">設定を開く</button></div>';
  }
  if (drafts.length) {
    h += '<div class="card"><h2>OneDrive にまだ送っていない変更</h2>' + drafts.map((d) =>
      '<a class="row-link" href="#" data-note="' + esc(d.path) + '">' + esc(V.title(d.path)) +
      (d.conflict ? ' <span class="pill warn">競合・開いて選ぶ</span>' : ' <span class="pill">未送信</span>') + '</a>').join('') + '</div>';
  }
  const updated = V.notes().filter((it) => it.mtime).sort((a, b) => (a.mtime < b.mtime ? 1 : -1)).slice(0, 8);
  if (updated.length) {
    h += '<div class="card"><h2>最近更新されたノート <small class="muted">PC で書いたものも</small></h2>' + updated.map((it) =>
      '<a class="row-link" href="#" data-note="' + esc(it.path) + '">' + esc(V.title(it.path)) +
      '<small>' + esc(when(it.mtime)) + (V.dirName(it.path) ? ' · ' + esc(V.dirName(it.path)) : '') + '</small></a>').join('') + '</div>';
  }
  if (recent.length) {
    h += '<div class="card"><h2>最近開いたノート</h2>' + recent.map((p) =>
      '<a class="row-link" href="#" data-note="' + esc(p) + '">' + esc(V.title(p)) + '<small>' + esc(V.dirName(p)) + '</small></a>').join('') + '</div>';
  }
  if (!h) h = '<div class="card"><p class="muted">左の一覧からノートを開く。</p></div>';
  $('home').innerHTML = h;
}

// 「たった今」「3 時間前」「9/27」
function when(iso) {
  const t = new Date(iso).getTime();
  if (!t) return '';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'たった今';
  if (m < 60) return m + ' 分前';
  if (m < 24 * 60) return Math.round(m / 60) + ' 時間前';
  const d = new Date(t);
  return (d.getFullYear() === new Date().getFullYear() ? '' : d.getFullYear() + '/') + (d.getMonth() + 1) + '/' + d.getDate();
}

function remember(path) {
  recent = [path].concat(recent.filter((p) => p !== path)).slice(0, 15);
  DB.setting('recent', recent).catch(() => {});
}

// 別のノートへ移る前に、書きかけを控えて送る
async function leave() {
  if (!cur) return;
  clearTimeout(pushTimer);
  clearTimeout(draftTimer);
  if (cur.dirty) {
    await saveDraft(cur);
    push(cur);
  }
}

// ---------------------------------------------------------------- ノートを開く

async function openNote(path, heading) {
  if (cur && cur.path === path) {
    const el = R.findHeading($('view'), heading);
    if (el) el.scrollIntoView();
    return;
  }
  await leave();
  const note = { path, text: '', baseETag: null, dirty: false, mode: 'view', conflict: false, loaded: false };
  cur = note;
  remember(path);
  if (matchMedia('(max-width: 899px)').matches) side.close();
  $('home').hidden = true;
  $('title').textContent = V.title(path);
  document.title = V.title(path) + ' - ノート';
  $('btnMode').hidden = false;
  renderTree();
  status('');

  const draft = await DB.get('drafts', path);
  const cached = await DB.get('files', path);
  if (cur !== note) return;
  if (draft) {
    Object.assign(note, { text: draft.text, baseETag: draft.baseETag, dirty: true, loaded: true });
    status('未送信', 'warn');
  } else if (cached) {
    Object.assign(note, { text: cached.text, baseETag: cached.eTag, loaded: true });
  }
  if (note.loaded) show(note, heading);
  else { $('view').hidden = false; $('editwrap').hidden = true; $('view').innerHTML = '<p class="muted">読み込み中…</p>'; }

  const item = V.get(path);
  if (!item) {
    if (!note.loaded) showMissing(note);
    return;
  }
  try {
    const r = await G.readText(item.id);
    if (cur !== note) return;
    V.upsert({ ...item, eTag: r.eTag, mtime: r.item.mtime });
    if (note.dirty) {
      // 書きかけがある。OneDrive 側の版が控えと違えば、送るときに競合として扱われる
      schedulePush(0);
      return;
    }
    await DB.put('files', { path, text: r.text, eTag: r.eTag, at: Date.now() });
    const changed = !note.loaded || note.text !== r.text;
    note.baseETag = r.eTag;
    note.text = r.text;
    note.loaded = true;
    if (changed) show(note, heading, true);
  } catch (e) {
    if (cur !== note) return;
    if (e instanceof G.NotFound) {
      toast('OneDrive から消えたか、名前が変わったようです');
      refreshTree();
      if (!note.loaded) showMissing(note);
    } else {
      if (!note.loaded) $('view').innerHTML = '<p class="muted">読み込めませんでした（' + esc(e.message) + '）</p>';
      fail(e);
    }
  }
}

function showMissing(note) {
  $('crumb').hidden = true;
  $('view').hidden = false;
  $('editwrap').hidden = true;
  $('btnMode').hidden = true;
  $('btnOutline').hidden = true;
  $('view').innerHTML = '<div class="card"><p>「' + esc(V.title(note.path)) + '」はまだありません。</p>' +
    '<button class="btn primary" data-act="create" data-path="' + esc(note.path) + '">作る</button></div>';
}

function show(note, heading, keepScroll) {
  if (cur !== note) return;
  hidePalette();
  if (note.mode === 'edit') {
    if (editorPath !== note.path) { editor.setText(note.text); editorPath = note.path; }
    else editor.replaceText(note.text);
    $('editwrap').hidden = false;
    $('view').hidden = true;
    $('btnMode').textContent = '閲覧';
    $('btnMode').title = '閲覧に戻る (Ctrl+E)';
    $('btnOutline').hidden = true;
    $('outline').hidden = true;
    $('crumb').hidden = true;
    document.body.classList.add('editing');
    return;
  }
  document.body.classList.remove('editing');
  const main = $('main');
  const y = main.scrollTop;
  const view = $('view');
  view.innerHTML = R.render(note.text, note.path);
  R.decorate(view, note.path);
  loadMedia(view);
  loadEmbeds(view, note.path);
  showCrumb(note);
  view.hidden = false;
  $('editwrap').hidden = true;
  $('btnMode').textContent = '編集';
  $('btnMode').title = '編集する (Ctrl+E)';
  $('btnOutline').hidden = false;
  if (wide() && localStorage.getItem('notes.outline') === '1') $('outline').hidden = false;
  renderOutline();
  if (keepScroll) main.scrollTop = y;
  else {
    const el = R.findHeading(view, heading);
    if (el) el.scrollIntoView(); else main.scrollTop = 0;
  }
}

// ノートの上に、置き場所と最終更新を小さく出す
function showCrumb(note) {
  const it = V.get(note.path);
  const dir = V.dirName(note.path);
  const parts = [];
  if (dir) parts.push(esc(dir.split('/').join(' › ')));
  if (it && it.mtime) parts.push('更新 ' + esc(when(it.mtime)));
  // 記号（# や - や ** など）は数えない。画面に出ている本文の文字数
  const view = $('view').cloneNode(true);
  for (const x of view.querySelectorAll('.props, .embed')) x.remove();
  const words = view.textContent.replace(/\s+/g, '').length;
  if (words) parts.push(words.toLocaleString() + ' 字');
  $('crumb').innerHTML = parts.join('<span class="dot">·</span>');
  $('crumb').hidden = !parts.length;
}

function loadMedia(root) {
  for (const img of root.querySelectorAll('img.att')) {
    const it = img.dataset.file && V.get(img.dataset.file);
    if (!it) { img.classList.add('broken'); continue; }
    if (blobUrls.has(it.path)) { img.src = blobUrls.get(it.path); continue; }
    G.readBlob(it.id).then((b) => {
      const u = URL.createObjectURL(b);
      blobUrls.set(it.path, u);
      img.src = u;
    }).catch(() => img.classList.add('broken'));
  }
}

// ![[ノート]] と ![[ノート#見出し]]。埋め込みの中の埋め込みは開かない（入れ子で止まらなくなる）
function section(text, heading) {
  if (!heading) return text;
  const lines = text.split('\n');
  const want = heading.trim().toLowerCase();
  const at = lines.findIndex((l) => { const m = /^(#{1,6})\s+(.*)$/.exec(l); return m && m[2].trim().toLowerCase() === want; });
  if (at < 0) return text;
  const lv = /^#+/.exec(lines[at])[0].length;
  let end = lines.findIndex((l, i) => i > at && /^(#{1,6})\s/.test(l) && /^#+/.exec(l)[0].length <= lv);
  if (end < 0) end = lines.length;
  return lines.slice(at, end).join('\n');
}

async function loadEmbeds(root, fromPath) {
  for (const sp of root.querySelectorAll('span.embed')) {
    const path = sp.dataset.embed;
    const box = document.createElement('div');
    box.className = 'embed';
    box.innerHTML = '<a class="embed-title wl" href="#" data-note="' + esc(path) + '" data-heading="' + esc(sp.dataset.heading) + '">' +
      esc(V.title(path)) + (sp.dataset.heading ? ' › ' + esc(sp.dataset.heading) : '') + '</a><div class="embed-body muted">読み込み中…</div>';
    sp.replaceWith(box);
    let text = null;
    const cached = await DB.get('files', path);
    if (cached) text = cached.text;
    try {
      const it = V.get(path);
      if (it && (!cached || cached.eTag !== it.eTag)) {
        const r = await G.readText(it.id);
        text = r.text;
        await DB.put('files', { path, text: r.text, eTag: r.eTag, at: Date.now() });
      }
    } catch { /* 控えがあればそれを出す */ }
    const body = box.querySelector('.embed-body');
    if (text === null) { body.textContent = '読み込めませんでした'; continue; }
    body.className = 'embed-body';
    body.innerHTML = R.render(section(text, sp.dataset.heading), path);
    R.decorate(body, path);
    for (const inner of body.querySelectorAll('span.embed')) inner.replaceWith(Object.assign(document.createElement('span'), { className: 'muted', textContent: '（埋め込み）' }));
    for (const cb of body.querySelectorAll('input.task')) cb.disabled = true;
    loadMedia(body);
  }
}

// ---------------------------------------------------------------- 書く・送る

function markDirty(note) {
  note.dirty = true;
  if (!note.conflict) status('未保存', 'warn');
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => saveDraft(note), 300);
  schedulePush(2000);
}

function saveDraft(note) {
  if (!note.dirty) return Promise.resolve();
  return DB.put('drafts', { path: note.path, text: note.text, baseETag: note.baseETag, at: Date.now() });
}

function schedulePush(ms) {
  clearTimeout(pushTimer);
  const note = cur;
  pushTimer = setTimeout(() => push(note), ms);
}

async function push(note) {
  if (!note || !note.dirty || note.conflict) return;
  if (pushing) { await pushing.catch(() => {}); return push(note); }
  const item = V.get(note.path);
  if (!item) { status('未送信', 'warn'); return; }
  const snap = note.text;
  if (cur === note) status('保存中…');
  pushing = (async () => {
    try {
      const res = await G.writeText(item.id, snap, note.baseETag);
      note.baseETag = res.eTag;
      V.upsert({ ...item, eTag: res.eTag, mtime: res.mtime, size: res.size });
      await DB.put('files', { path: note.path, text: snap, eTag: res.eTag, at: Date.now() });
      if (note.text === snap) {
        note.dirty = false;
        await DB.del('drafts', note.path);
        if (cur === note) status('保存済み', 'ok');
        setTimeout(() => { if (cur === note && !note.dirty) status(''); }, 2500);
      } else {
        await saveDraft(note);
        if (cur === note) schedulePush(1000);
      }
      banner('');
    } catch (e) {
      if (e instanceof G.Conflict) {
        note.conflict = true;
        await DB.put('drafts', { path: note.path, text: note.text, baseETag: note.baseETag, at: Date.now(), conflict: true });
        if (cur === note) openConflict(note);
      } else if (e instanceof G.NeedSignIn) {
        needSignIn();
      } else {
        if (cur === note) status('未送信', 'warn');
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => push(note), 20000);
      }
    }
  })();
  try { await pushing; } finally { pushing = null; }
}

// 開いていないノートの書きかけを送る。版が食い違うものは残して、開いたときに選ばせる。
async function pushDrafts() {
  const drafts = await DB.all('drafts');
  for (const d of drafts) {
    if (cur && cur.path === d.path) continue;
    const it = V.get(d.path);
    if (!it || d.conflict) continue;
    try {
      const res = await G.writeText(it.id, d.text, d.baseETag);
      V.upsert({ ...it, eTag: res.eTag });
      await DB.put('files', { path: d.path, text: d.text, eTag: res.eTag, at: Date.now() });
      await DB.del('drafts', d.path);
    } catch (e) {
      if (e instanceof G.Conflict) await DB.put('drafts', { ...d, conflict: true });
      else if (e instanceof G.NeedSignIn) return needSignIn();
      else return; // 電波など。次の機会に
    }
  }
  if (!cur) showHome();
}

// ---------------------------------------------------------------- 競合

function openConflict(note) {
  status('競合', 'bad');
  const it = V.get(note.path);
  $('conflictInfo').textContent = '「' + V.title(note.path) + '」' + (it && it.mtime ? ' / OneDrive 側の更新: ' + new Date(it.mtime).toLocaleString('ja-JP') : '');
  $('dlgConflict').showModal();
}

async function takeRemote(note) {
  const it = V.get(note.path);
  const r = await G.readText(it.id);
  Object.assign(note, { text: r.text, baseETag: r.eTag, dirty: false, conflict: false });
  await DB.put('files', { path: note.path, text: r.text, eTag: r.eTag, at: Date.now() });
  await DB.del('drafts', note.path);
  status('');
  show(note, '', true);
}

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + p(d.getMinutes());
};

$('cfRemote').addEventListener('click', async () => {
  $('dlgConflict').close();
  if (cur) await takeRemote(cur).catch(fail);
});
$('cfMine').addEventListener('click', async () => {
  $('dlgConflict').close();
  const note = cur;
  if (!note) return;
  try {
    const m = await G.meta(V.get(note.path).id);
    Object.assign(note, { baseETag: m.eTag, conflict: false });
    await saveDraft(note);
    push(note);
  } catch (e) { fail(e); }
});
$('cfBoth').addEventListener('click', async () => {
  $('dlgConflict').close();
  const note = cur;
  if (!note) return;
  const dir = V.dirName(note.path);
  const rel = (dir ? dir + '/' : '') + V.title(note.path) + ' (競合 ' + stamp() + ').md';
  try {
    const it = await G.createText(vault + '/' + rel, note.text);
    V.upsert({ ...it, path: rel });
    await DB.put('files', { path: rel, text: note.text, eTag: it.eTag, at: Date.now() });
    await saveTree();
    await takeRemote(note);
    renderTree();
    toast('自分の版を「' + V.title(rel) + '」に保存しました');
  } catch (e) { fail(e); }
});

// ---------------------------------------------------------------- 閲覧中の操作

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-note], a[data-tag], [data-act]');
  if (!a) return;
  e.preventDefault();
  if (a.dataset.act === 'settings') return openSettings();
  if (a.dataset.act === 'create') return createNote(a.dataset.path);
  if (a.dataset.tag) {
    $('q').value = '#' + a.dataset.tag;
    side.open();
    return fullSearch('#' + a.dataset.tag);
  }
  const path = a.dataset.note;
  if (a.classList.contains('missing')) {
    const target = /\.md$/i.test(path) ? path : path + '.md';
    if (confirm('「' + V.title(target) + '」はまだありません。作りますか？')) createNote(target);
    return;
  }
  go(path, a.dataset.heading || '');
});

$('view').addEventListener('change', (e) => {
  const cb = e.target;
  if (!cb.matches('input.task') || !cur) return;
  const boxes = [...$('view').querySelectorAll(':scope input.task')].filter((x) => !x.closest('.embed'));
  const n = boxes.indexOf(cb);
  const lines = R.taskLines(cur.text);
  // 画面と本文でチェックボックスの数が合わないときは、どの行か確信できないので触らない
  if (boxes.length !== lines.length || n < 0) {
    cb.checked = !cb.checked;
    toast('この場所のチェックは編集画面で直してください');
    return;
  }
  const next = R.toggleTask(cur.text, n, cb.checked);
  if (next === null) return;
  cur.text = next;
  markDirty(cur);
});

// 閲覧 ⇄ 編集。読んでいた位置（全体の何割か）を引き継ぐ
function toggleMode() {
  if (!cur || !cur.loaded) return;
  const main = $('main');
  const ratio = main.scrollTop / Math.max(1, main.scrollHeight - main.clientHeight);
  cur.mode = cur.mode === 'edit' ? 'view' : 'edit';
  show(cur, '', true);
  requestAnimationFrame(() => { main.scrollTop = ratio * (main.scrollHeight - main.clientHeight); });
  // スマホ・タブレットはすぐキーボードを出さない（読んでいた所が隠れる）。書きたい所を押せば出る
  if (cur.mode === 'edit' && !touch()) editor.focus();
  else if (cur.mode === 'view' && cur.dirty) schedulePush(0);
}
$('btnMode').addEventListener('click', toggleMode);

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'e') { e.preventDefault(); toggleMode(); }
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); if (cur && cur.dirty) schedulePush(0); }
  if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); side.open(); $('q').focus(); $('q').select(); }
});

$('btnMenu').addEventListener('click', side.toggle);
$('scrim').addEventListener('click', side.close);
$('btnRefresh').addEventListener('click', refreshTree);

// ---------------------------------------------------------------- 編集の道具帯

// 押しても編集欄からフォーカスを奪わない（キーボードが引っ込まない）
$('tools').addEventListener('pointerdown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
$('tools').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-cmd]');
  if (!b || !cur) return;
  const c = b.dataset.cmd;
  if (/^h[0-3]$/.test(c)) editor.heading(Number(c[1]));
  else if (c === 'bold') editor.wrap('**', '**');
  else if (['ul', 'ol', 'task', 'quote'].includes(c)) editor.list(c);
  else if (c === 'link') editor.insert('[[]]', 2);
  else if (c === 'hr') editor.insert('\n---\n');
  else if (c === 'undo') editor.undo();
  else if (c === 'redo') editor.redo();
  else if (c === 'marker') {
    hlTarget = { kind: 'editor' };
    openPalette(b.getBoundingClientRect(), true);
  }
});

// ---------------------------------------------------------------- マーカー

let hlTarget = null; // { kind: 'sel', range } / { kind: 'mark', el } / { kind: 'editor' }
let selTimer = 0;

$('hlColors').innerHTML = RD.COLORS.map((c, i) =>
  '<button type="button" data-i="' + i + '" title="' + c.name + '" style="background:' + c.css + '"></button>').join('');

function openPalette(rect, canRemove) {
  const pop = $('hlPop');
  $('hlOff').hidden = !canRemove;
  pop.hidden = false;
  const w = pop.offsetWidth, h = pop.offsetHeight;
  const vw = document.documentElement.clientWidth, vh = window.innerHeight;
  let top = rect.bottom + 10;
  if (top + h > vh - 8) top = rect.top - h - 10;
  pop.style.left = Math.max(8, Math.min(vw - w - 8, rect.left + rect.width / 2 - w / 2)) + 'px';
  pop.style.top = Math.max(8, top) + 'px';
}

function hidePalette() {
  $('hlPop').hidden = true;
  hlTarget = null;
}

function applyMarker(color, remove) {
  const t = hlTarget;
  hidePalette();
  if (!t || !cur) return;
  if (t.kind === 'editor') { editor.marker(remove ? 'off' : color.md); return; }
  const res = t.kind === 'sel'
    ? RD.markSelection(cur.text, $('view'), t.range, color)
    : RD.editMark(cur.text, $('view'), t.el, { color, remove });
  getSelection().removeAllRanges();
  if (!res.text) { if (res.error) toast(res.error); return; }
  cur.text = res.text;
  markDirty(cur);
  show(cur, '', true);
}

// ボタンは pointerdown で受ける。click まで待つと、その前に選択が外れて対象が消える
$('hlPop').addEventListener('pointerdown', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  e.preventDefault();
  if (b.id === 'hlOff') applyMarker(null, true);
  else applyMarker(RD.COLORS[Number(b.dataset.i)], false);
});

// 閲覧中に文字を選ぶと色が出る
document.addEventListener('selectionchange', () => {
  clearTimeout(selTimer);
  selTimer = setTimeout(() => {
    if (!cur || cur.mode !== 'view') return;
    const sel = getSelection();
    if (!sel.rangeCount || sel.isCollapsed) {
      if (hlTarget && hlTarget.kind === 'sel') hidePalette();
      return;
    }
    const r = sel.getRangeAt(0);
    const view = $('view');
    if (!view.contains(r.startContainer) || !view.contains(r.endContainer)) return;
    const el = (n) => (n.nodeType === 3 ? n.parentElement : n);
    if (el(r.startContainer).closest('.embed, .props') || !r.toString().trim()) return;
    hlTarget = { kind: 'sel', range: r.cloneRange() };
    openPalette(r.getBoundingClientRect(), false);
  }, 250);
});

// 引いてあるマーカーを押すと、色を変える・外す
$('view').addEventListener('click', (e) => {
  const m = e.target.closest('mark');
  if (!m || m.closest('.embed') || !getSelection().isCollapsed) return;
  hlTarget = { kind: 'mark', el: m };
  openPalette(m.getBoundingClientRect(), true);
});

document.addEventListener('pointerdown', (e) => {
  if ($('hlPop').hidden || e.target.closest('#hlPop, mark, .hl-btn')) return;
  if (hlTarget && hlTarget.kind === 'sel') return; // 選択中は selectionchange 側で閉じる
  hidePalette();
});
$('main').addEventListener('scroll', () => { if (hlTarget && hlTarget.kind !== 'sel') hidePalette(); }, { passive: true });

// ---------------------------------------------------------------- 目次・マーカー一覧

let olTab = 'heads';
let olItems = [];

function renderOutline() {
  if ($('outline').hidden || !cur) return;
  const { heads, marks } = RD.outline($('view'));
  for (const b of $('outline').querySelectorAll('[data-tab]')) b.classList.toggle('on', b.dataset.tab === olTab);
  const body = $('olBody');
  if (olTab === 'heads') {
    olItems = heads.map((h) => h.el);
    body.innerHTML = heads.length
      ? heads.map((h, i) => '<a href="#" class="ol-h" data-i="' + i + '" style="--lv:' + (h.level - 1) + '">' + esc(h.text) + '</a>').join('')
      : '<p class="muted pad">見出しがありません</p>';
  } else {
    olItems = marks.map((m) => m.el);
    body.innerHTML = marks.length
      ? marks.map((m, i) => '<a href="#" class="ol-m" data-i="' + i + '"><i style="background:' + esc(m.color || 'var(--mark)') + '"></i>' + esc(m.text) + '</a>').join('')
      : '<p class="muted pad">マーカーはまだありません。本文の文字を選ぶと引けます。</p>';
  }
}

function toggleOutline(open) {
  const el = $('outline');
  const was = !el.hidden;
  el.hidden = open === undefined ? !el.hidden : !open;
  if (!wide() && was !== !el.hidden) { if (el.hidden) popOverlay(); else pushOverlay(); }
  if (wide()) try { localStorage.setItem('notes.outline', el.hidden ? '0' : '1'); } catch { /* 無視 */ }
  renderOutline();
}

$('btnOutline').addEventListener('click', () => toggleOutline());
$('btnOutlineClose').addEventListener('click', () => toggleOutline(false));
$('outline').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab) { olTab = tab.dataset.tab; renderOutline(); return; }
  const a = e.target.closest('a[data-i]');
  if (!a) return;
  e.preventDefault();
  e.stopPropagation();
  const el = olItems[Number(a.dataset.i)];
  if (!el) return;
  el.scrollIntoView({ block: olTab === 'heads' ? 'start' : 'center', behavior: 'smooth' });
  if (olTab === 'marks') { el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1200); }
  if (!wide()) toggleOutline(false);
});

// ---------------------------------------------------------------- 文字の見え方

function syncLook() {
  const p = RD.prefs();
  $('lookFs').value = p.fs;
  $('lookFsV').textContent = p.fs + 'px';
  $('lookLh').value = p.lh;
  $('lookLhV').textContent = Number(p.lh).toFixed(1);
  for (const seg of $('dlgLook').querySelectorAll('.seg')) {
    for (const b of seg.querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === p[seg.dataset.k]);
  }
}
function setLook(k, v) {
  RD.setPrefs({ ...RD.prefs(), [k]: v });
  syncLook();
}
$('btnLook').addEventListener('click', () => { syncLook(); $('dlgLook').showModal(); });
$('lookFs').addEventListener('input', (e) => setLook('fs', Number(e.target.value)));
$('lookLh').addEventListener('input', (e) => setLook('lh', Number(e.target.value)));
$('dlgLook').addEventListener('click', (e) => {
  const b = e.target.closest('.seg button');
  if (b) setLook(b.closest('.seg').dataset.k, b.dataset.v);
});

// ---------------------------------------------------------------- 新しいノート

function createNote(path) {
  if (path) return doCreate(path);
  const dirs = [''].concat(V.items.filter((it) => it.isFolder).map((it) => it.path).sort((a, b) => a.localeCompare(b, 'ja')));
  const here = cur ? V.dirName(cur.path) : '';
  $('newDir').innerHTML = dirs.map((d) => '<option value="' + esc(d) + '"' + (d === here ? ' selected' : '') + '>' + (d ? esc(d) : '（一番上）') + '</option>').join('');
  $('newName').value = sharedTitle || '';
  sharedTitle = '';
  $('newErr').hidden = true;
  $('dlgNew').showModal();
  $('newName').focus();
}

let shared = '';
let sharedTitle = '';   // ほかのアプリから「共有」で受け取った文字。次に作るノートの中身にする

async function doCreate(path) {
  if (!vault) return openSettings();
  const body = shared;
  try {
    const it = await G.createText(vault + '/' + path, body);
    shared = '';
    V.upsert({ ...it, path });
    await DB.put('files', { path, text: body, eTag: it.eTag, at: Date.now() });
    await saveTree();
    renderTree();
    if (cur && cur.path === path) cur = null; // 「まだありません」から作ったときは開き直す
    go(path);
    setTimeout(() => { if (cur && cur.path === path) { cur.mode = 'edit'; show(cur); editor.focus(); } }, 50);
    return true;
  } catch (e) {
    if (e instanceof G.Exists) { toast('同じ名前のノートがもうあります'); return false; }
    fail(e);
    return false;
  }
}

$('btnNew').addEventListener('click', () => createNote());
$('btnSideNew').addEventListener('click', () => { if (narrow()) side.close(); createNote(); });
$('btnNewCancel').addEventListener('click', () => { shared = ''; $('dlgNew').close(); });
$('formNew').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('newName').value.trim().replace(/\.md$/i, '');
  if (!name || /[\\/:*?"<>|#^[\]]/.test(name)) {
    $('newErr').textContent = '名前に使えない文字があります（\\ / : * ? " < > | # ^ [ ]）';
    $('newErr').hidden = false;
    return;
  }
  const dir = $('newDir').value;
  const path = (dir ? dir + '/' : '') + name + '.md';
  if (V.get(path)) { $('newErr').textContent = '同じ名前のノートがもうあります'; $('newErr').hidden = false; return; }
  $('btnNewOk').disabled = true;
  const ok = await doCreate(path);
  $('btnNewOk').disabled = false;
  if (ok) $('dlgNew').close();
});

// ---------------------------------------------------------------- 設定

async function openSettings() {
  $('redirectUri').textContent = Auth.redirectUri();
  $('setClient').value = await Auth.clientId();
  $('setTenant').value = (await DB.setting('tenant')) || 'common';
  $('setVault').value = vault;
  $('setupHelp').open = !$('setClient').value;
  $('picker').hidden = true;
  await refreshSignState();
  await refreshLockState();
  $('dlgSettings').showModal();
}

async function refreshLockState() {
  $('setRemember').checked = await L.remembered();
  $('setAutolock').value = String(lockAfter());
  $('setAutolock').disabled = $('setRemember').checked;
}
$('setRemember').addEventListener('change', async (e) => {
  if (e.target.checked) await L.rememberNow(); else await L.forget();
  refreshLockState();
});
$('setAutolock').addEventListener('change', (e) => {
  try { localStorage.setItem('notes.autolock', e.target.value); } catch { /* 無視 */ }
});
$('btnLockNow').addEventListener('click', async () => {
  if (cur && cur.dirty) await saveDraft(cur);
  L.lockNow();
});
$('btnChangePw').addEventListener('click', () => {
  for (const id of ['pwOld', 'pwNew', 'pwNew2']) $(id).value = '';
  $('pwErr').hidden = true;
  $('dlgPw').showModal();
});
$('btnPwCancel').addEventListener('click', () => $('dlgPw').close());
$('formPw').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = (m) => { $('pwErr').textContent = m; $('pwErr').hidden = false; };
  const nw = $('pwNew').value;
  if (nw.length < 6) return err('6 文字以上にしてください');
  if (nw !== $('pwNew2').value) return err('新しいパスワードの 2 回の入力が違います');
  const btn = $('btnPwOk');
  btn.disabled = true;
  btn.textContent = '入れ直し中…';
  try {
    if (await L.change($('pwOld').value, nw)) { $('dlgPw').close(); toast('パスワードを変えました'); }
    else err('今のパスワードが違います');
  } catch (x) {
    err('変えられませんでした：' + x.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '変える';
  }
});

async function refreshSignState() {
  const on = await Auth.signedIn();
  $('signState').textContent = on ? 'サインイン済み' : '未サインイン';
  $('btnSignIn').hidden = on;
  $('btnSignOut').hidden = !on;
  $('btnPick').disabled = !on;
  $('btnPrefetch').disabled = !on;
}

async function storeSettings() {
  await DB.setting('clientId', $('setClient').value.trim() || null);
  await DB.setting('tenant', $('setTenant').value);
  const v = $('setVault').value.trim().replace(/^\/+|\/+$/g, '');
  if (v !== vault) {
    vault = v;
    await DB.setting('vault', v);
    V.load([]);
    await DB.setting('tree', null);
    renderTree();
    refreshTree();
  }
}

$('btnSettings').addEventListener('click', openSettings);
// 入力欄で Enter を押すと、既定では保存せずにダイアログが閉じる。保存してから閉じる
$('dlgSettings').querySelector('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('btnSaveSettings').click();
});
$('btnSaveSettings').addEventListener('click', async () => {
  await storeSettings();
  $('dlgSettings').close();
  if (!cur) showHome();
});
$('btnSignIn').addEventListener('click', async () => {
  await storeSettings();
  if (!(await Auth.clientId())) { toast('先にクライアント ID を入れてください'); return; }
  Auth.signIn().catch((e) => toast(e.message));
});
$('btnSignOut').addEventListener('click', async () => {
  await Auth.signOut();
  refreshSignState();
});

// OneDrive のフォルダを1段ずつたどって選ぶ
async function pick(path) {
  const box = $('picker');
  box.hidden = false;
  box.innerHTML = '<p class="muted">読み込み中…</p>';
  try {
    const list = await G.children(path);
    const isVault = list.some((it) => it.name === '.obsidian');
    const dirs = list.filter((it) => it.isFolder && !it.name.startsWith('.'));
    box.innerHTML = '<div class="picker-head"><b>/' + esc(path) + '</b>' + (isVault ? ' <span class="pill ok">Obsidian の保管庫</span>' : '') + '</div>' +
      (path ? '<button type="button" class="pick-row" data-up="1">↑ 上へ</button>' : '') +
      dirs.map((d) => '<button type="button" class="pick-row" data-dir="' + esc((path ? path + '/' : '') + d.name) + '">📁 ' + esc(d.name) + '</button>').join('') +
      '<div class="row"><button type="button" class="btn primary" data-here="1">このフォルダにする</button></div>';
    box.onclick = (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.up) pick(V.dirName(path));
      else if (b.dataset.dir) pick(b.dataset.dir);
      else if (b.dataset.here) { $('setVault').value = path; box.hidden = true; }
    };
  } catch (e) {
    box.innerHTML = '<p class="err">' + esc(e.message) + '</p>';
  }
}
$('btnPick').addEventListener('click', () => pick($('setVault').value.trim().replace(/^\/+|\/+$/g, '')).catch(fail));

// 全ノートの本文を端末に控える。版（eTag）が同じものは取り直さない。
$('btnPrefetch').addEventListener('click', async () => {
  const btn = $('btnPrefetch');
  btn.disabled = true;
  const info = $('prefetchInfo');
  try {
    if (!V.items.length || Date.now() - lastTreeAt > 30 * 60 * 1000) { info.textContent = '一覧を取得中…'; await refreshTree(); }
    const have = new Map((await DB.all('files')).map((f) => [f.path, f.eTag]));
    const todo = V.notes().filter((it) => have.get(it.path) !== it.eTag);
    let done = 0, bad = 0;
    const next = async () => {
      while (todo.length) {
        const it = todo.shift();
        try {
          const r = await G.readText(it.id);
          await DB.put('files', { path: it.path, text: r.text, eTag: r.eTag, at: Date.now() });
        } catch (e) {
          if (e instanceof G.NeedSignIn) throw e;
          bad++;
        }
        info.textContent = ++done + ' 件取得' + (bad ? '（失敗 ' + bad + '）' : '');
      }
    };
    await Promise.all([next(), next(), next(), next()]);
    info.textContent = '完了：' + V.notes().length + ' ノート（今回 ' + done + ' 件取得' + (bad ? '、失敗 ' + bad : '') + '）';
  } catch (e) {
    info.textContent = '';
    fail(e);
  } finally {
    btn.disabled = false;
  }
});

$('btnClearCache').addEventListener('click', async () => {
  const drafts = await DB.all('drafts');
  if (!confirm('端末に控えたノート本文を消します。' + (drafts.length ? '\n未送信の変更 ' + drafts.length + ' 件は残します。' : '') + '\nOneDrive のファイルは消えません。')) return;
  await DB.clear('files');
  toast('消しました');
});

// ---------------------------------------------------------------- 起動

window.addEventListener('online', () => {
  if (cur && cur.dirty) schedulePush(0);
  pushDrafts();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (cur && cur.dirty) { clearTimeout(draftTimer); saveDraft(cur); push(cur); }
    return;
  }
  // 戻ってきた。PC 側で書き換えられているかもしれないので確かめる
  if (!L.unlocked()) return;
  if (Date.now() - lastTreeAt > 5 * 60 * 1000) refreshTree();
  if (cur && !cur.dirty && cur.loaded && V.get(cur.path)) {
    const note = cur;
    G.meta(V.get(note.path).id).then(async (m) => {
      if (cur !== note || note.dirty || m.eTag === note.baseETag) return;
      const r = await G.readText(m.id);
      if (cur !== note || note.dirty) return;
      Object.assign(note, { text: r.text, baseETag: r.eTag });
      await DB.put('files', { path: note.path, text: r.text, eTag: r.eTag, at: Date.now() });
      show(note, '', true);
      toast('OneDrive の新しい版を読み込みました');
    }).catch(() => {});
  }
});

// ---------------------------------------------------------------- パスワード

// 鍵が開くまで画面を出さない。初めてならパスワードを決めてもらう
async function unlockScreen() {
  const first = !(await L.configured());
  document.body.classList.add('locked');
  $('lock').hidden = false;
  $('lockMsg').textContent = first
    ? 'この端末で使うパスワードを決めてください。端末に控えるノートやサインイン情報は、このパスワードで暗号化されます。'
    : 'パスワードを入れてください。';
  $('lockPw').autocomplete = first ? 'new-password' : 'current-password';
  $('lockPw2').hidden = !first;
  $('lockOk').textContent = first ? '決めて始める' : '開く';
  $('lockForgot').hidden = first;
  $('lockErr').hidden = true;
  setTimeout(() => $('lockPw').focus(), 50);

  await new Promise((done) => {
    const err = (m) => { $('lockErr').textContent = m; $('lockErr').hidden = false; };
    $('lockForm').onsubmit = async (e) => {
      e.preventDefault();
      const pw = $('lockPw').value;
      const label = $('lockOk').textContent;
      $('lockOk').disabled = true;
      $('lockOk').textContent = '確かめています…';
      try {
        if (first) {
          if (pw.length < 6) return err('6 文字以上にしてください');
          if (pw !== $('lockPw2').value) return err('2 回の入力が違います');
          await L.setup(pw);
          if ($('lockRemember').checked) await L.rememberNow();
        } else if (!(await L.unlock(pw, $('lockRemember').checked))) {
          $('lockPw').select();
          return err('パスワードが違います');
        }
        $('lockPw').value = $('lockPw2').value = '';
        done();
      } finally {
        $('lockOk').disabled = false;
        $('lockOk').textContent = label;
      }
    };
  });
  $('lock').hidden = true;
  document.body.classList.remove('locked');
}

$('lockForgot').addEventListener('click', async () => {
  if (!confirm('この端末に控えたノート・書きかけ・サインイン情報をすべて消して、パスワードを決め直します。\n' +
    'OneDrive のファイルは消えません。OneDrive にまだ送っていない書きかけは失われます。')) return;
  await L.reset();
  location.reload();
});

// 画面を離れてしばらく経ったら鍵をかける（「入力を省く」にしていなければ）
let hiddenAt = 0;
const lockAfter = () => Number(localStorage.getItem('notes.autolock') || 5);
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
  const min = lockAfter();
  if (!hiddenAt || min <= 0 || !L.unlocked() || (await L.remembered())) return;
  if (Date.now() - hiddenAt > min * 60 * 1000) {
    if (cur && cur.dirty) await saveDraft(cur);
    L.lockNow();
  }
});

async function start() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  RD.applyPrefs();

  if (!(await L.tryResume())) await unlockScreen();
  document.body.classList.remove('locked');
  openFolders = new Set((await DB.setting('open')) || []);
  recent = (await DB.setting('recent')) || [];

  const back = await Auth.finishSignIn();
  if (back && !back.ok && !back.silent) toast('サインインできませんでした：' + back.message);
  receiveShare();

  vault = (await DB.setting('vault')) || '';
  const tree = await DB.setting('tree');
  if (tree) V.load(tree);
  renderTree();
  if (matchMedia('(min-width: 900px)').matches) side.open();

  route();

  const signed = await Auth.signedIn();
  if (!signed || !vault) {
    if (back && back.ok && !vault) openSettings();
    return;
  }
  // 一覧を取り直す前に更新用トークンが生きているか確かめる。切れていれば案内だけ出す
  try {
    if (!(await Auth.getToken())) {
      // 更新用トークンが切れた（1 日で切れる）。Microsoft 側にログインが残っていれば、
      // 画面を出さずに通り直せるので、1 回だけ試す。だめなら案内を出す
      if (Auth.canTrySilent() && navigator.onLine) return Auth.signIn(true).catch(needSignIn);
      return needSignIn();
    }
  } catch { return; } // 電波がない。控えで動く
  refreshTree();
}

// Android の「共有」でほかのアプリから来たとき（?title=…&text=…&url=…）
function receiveShare() {
  const q = new URLSearchParams(location.search);
  if (!q.has('text') && !q.has('url') && !q.has('title')) return;
  const title = (q.get('title') || '').trim();
  const text = (q.get('text') || '').trim();
  const url = (q.get('url') || '').trim();
  history.replaceState(null, '', location.pathname + location.hash);
  const lines = [];
  if (text) lines.push(text);
  if (url && !text.includes(url)) lines.push(title ? '[' + title.replace(/[[\]]/g, '') + '](' + url + ')' : url);
  shared = lines.join('\n\n') + '\n';
  const d = new Date();
  sharedTitle = (title || text.split('\n')[0] || 'メモ').replace(/[\\/:*?"<>|#^[\]]/g, ' ').trim().slice(0, 40) ||
    ('メモ ' + (d.getMonth() + 1) + '-' + d.getDate());
  setTimeout(() => createNote(), 0);
}

start();
