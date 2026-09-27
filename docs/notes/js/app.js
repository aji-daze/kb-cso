// 画面の組み立て。
//
// 1ノートの一生：
//   開く   → 書きかけ（drafts）があればそれ、なければ端末の控え（files）をすぐ出す
//          → 裏で OneDrive から最新を取り、変わっていれば差し替える
//   書く   → すぐ drafts に控える（閉じても消えない）→ 2 秒止まったら OneDrive へ送る
//   送る   → 読んだときの版（eTag）を添える。食い違えば「競合」を出して選ばせる
import * as DB from './db.js';
import * as Auth from './auth.js';
import * as G from './graph.js';
import * as V from './vault.js';
import * as R from './render.js';

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

function applyTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

const side = {
  open() { document.body.classList.add('side-open'); },
  close() { document.body.classList.remove('side-open'); },
  toggle() { document.body.classList.toggle('side-open'); },
};

// ---------------------------------------------------------------- 一覧（サイドバー）

async function saveTree() {
  await DB.setting('tree', V.items.map(({ url, ...rest }) => rest)); // 一時 URL は1時間で切れるので控えない
}

function renderTree() {
  const open = new Set(JSON.parse(localStorage.getItem('notes.open') || '[]'));
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
  $('tree').innerHTML = node(t, 0) || '<p class="muted pad">ノートがありません</p>';
  $('treeInfo').textContent = V.notes().length ? V.notes().length + ' ノート' : '';
}

$('tree').addEventListener('toggle', (e) => {
  const d = e.target;
  if (!d.matches || !d.matches('details.folder')) return;
  const open = new Set(JSON.parse(localStorage.getItem('notes.open') || '[]'));
  if (d.open) open.add(d.dataset.path); else open.delete(d.dataset.path);
  try { localStorage.setItem('notes.open', JSON.stringify([...open])); } catch { /* 入らなくても困らない */ }
}, true);

async function refreshTree() {
  if (!vault || !(await Auth.signedIn())) return;
  $('treeInfo').textContent = '読み込み中…';
  try {
    const list = await G.walk(vault, (n) => { $('treeInfo').textContent = '読み込み中… ' + n; });
    V.load(list);
    lastTreeAt = Date.now();
    await saveTree();
    renderTree();
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
    const t = f.text.normalize('NFKC').toLowerCase();
    const i = t.indexOf(k);
    if (i < 0) continue;
    const s = Math.max(0, i - 30);
    const snip = esc(f.text.slice(s, i)) + '<mark>' + esc(f.text.slice(i, i + q.length)) + '</mark>' + esc(f.text.slice(i + q.length, i + q.length + 50));
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
  if (location.hash === next) {
    const el = R.findHeading($('view'), heading);
    if (el) el.scrollIntoView();
  } else {
    location.hash = next;
  }
  if (matchMedia('(max-width: 899px)').matches) side.close();
}

window.addEventListener('hashchange', route);

async function showHome() {
  await leave();
  cur = null;
  $('title').textContent = 'ノート';
  $('btnMode').hidden = true;
  $('view').hidden = true;
  $('editor').hidden = true;
  $('home').hidden = false;
  status('');
  renderTree();

  const recent = JSON.parse(localStorage.getItem('notes.recent') || '[]');
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
  if (recent.length) {
    h += '<div class="card"><h2>最近開いたノート</h2>' + recent.map((p) =>
      '<a class="row-link" href="#" data-note="' + esc(p) + '">' + esc(V.title(p)) + '<small>' + esc(V.dirName(p)) + '</small></a>').join('') + '</div>';
  }
  if (!h) h = '<div class="card"><p class="muted">左の一覧からノートを開く。</p></div>';
  $('home').innerHTML = h;
}

function remember(path) {
  let r = JSON.parse(localStorage.getItem('notes.recent') || '[]').filter((p) => p !== path);
  r.unshift(path);
  try { localStorage.setItem('notes.recent', JSON.stringify(r.slice(0, 15))); } catch { /* 入らなくても困らない */ }
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
  else { $('view').hidden = false; $('editor').hidden = true; $('view').innerHTML = '<p class="muted">読み込み中…</p>'; }

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
  $('view').hidden = false;
  $('editor').hidden = true;
  $('btnMode').hidden = true;
  $('view').innerHTML = '<div class="card"><p>「' + esc(V.title(note.path)) + '」はまだありません。</p>' +
    '<button class="btn primary" data-act="create" data-path="' + esc(note.path) + '">作る</button></div>';
}

function show(note, heading, keepScroll) {
  if (cur !== note) return;
  if (note.mode === 'edit') {
    const ed = $('editor');
    if (ed.value !== note.text) ed.value = note.text;
    ed.hidden = false;
    $('view').hidden = true;
    $('btnMode').textContent = '👁';
    $('btnMode').title = '閲覧 (Ctrl+E)';
    return;
  }
  const main = $('main');
  const y = main.scrollTop;
  const view = $('view');
  view.innerHTML = R.render(note.text, note.path);
  R.decorate(view, note.path);
  loadMedia(view);
  loadEmbeds(view, note.path);
  view.hidden = false;
  $('editor').hidden = true;
  $('btnMode').textContent = '✎';
  $('btnMode').title = '編集 (Ctrl+E)';
  if (keepScroll) main.scrollTop = y;
  else {
    const el = R.findHeading(view, heading);
    if (el) el.scrollIntoView(); else main.scrollTop = 0;
  }
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

$('editor').addEventListener('input', () => {
  if (!cur) return;
  cur.text = $('editor').value;
  markDirty(cur);
});

// Tab で字下げ（textarea の既定だとフォーカスが外れる）
$('editor').addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || e.ctrlKey || e.metaKey || e.altKey) return;
  e.preventDefault();
  const ed = e.target;
  const s = ed.selectionStart;
  const lineStart = ed.value.lastIndexOf('\n', s - 1) + 1;
  if (e.shiftKey) {
    if (ed.value.slice(lineStart, lineStart + 1) === '\t') {
      ed.setRangeText('', lineStart, lineStart + 1, 'end');
    }
  } else {
    ed.setRangeText('\t', s, ed.selectionEnd, 'end');
  }
  ed.dispatchEvent(new Event('input'));
});

function toggleMode() {
  if (!cur || !cur.loaded) return;
  cur.mode = cur.mode === 'edit' ? 'view' : 'edit';
  show(cur, '', true);
  if (cur.mode === 'edit') $('editor').focus();
  else if (cur.dirty) schedulePush(0);
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

// ---------------------------------------------------------------- 新しいノート

function createNote(path) {
  if (path) return doCreate(path);
  const dirs = [''].concat(V.items.filter((it) => it.isFolder).map((it) => it.path).sort((a, b) => a.localeCompare(b, 'ja')));
  const here = cur ? V.dirName(cur.path) : '';
  $('newDir').innerHTML = dirs.map((d) => '<option value="' + esc(d) + '"' + (d === here ? ' selected' : '') + '>' + (d ? esc(d) : '（一番上）') + '</option>').join('');
  $('newName').value = '';
  $('newErr').hidden = true;
  $('dlgNew').showModal();
  $('newName').focus();
}

async function doCreate(path) {
  if (!vault) return openSettings();
  try {
    const it = await G.createText(vault + '/' + path, '');
    V.upsert({ ...it, path });
    await DB.put('files', { path, text: '', eTag: it.eTag, at: Date.now() });
    await saveTree();
    renderTree();
    if (cur && cur.path === path) cur = null; // 「まだありません」から作ったときは開き直す
    go(path);
    setTimeout(() => { if (cur && cur.path === path) { cur.mode = 'edit'; show(cur); $('editor').focus(); } }, 50);
    return true;
  } catch (e) {
    if (e instanceof G.Exists) { toast('同じ名前のノートがもうあります'); return false; }
    fail(e);
    return false;
  }
}

$('btnNew').addEventListener('click', () => createNote());
$('btnNewCancel').addEventListener('click', () => $('dlgNew').close());
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
  $('setTheme').value = (await DB.setting('theme')) || 'auto';
  $('setupHelp').open = !$('setClient').value;
  $('picker').hidden = true;
  await refreshSignState();
  $('dlgSettings').showModal();
}

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
  await DB.setting('theme', $('setTheme').value);
  applyTheme($('setTheme').value);
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
$('setTheme').addEventListener('change', () => applyTheme($('setTheme').value));
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

async function start() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  applyTheme(await DB.setting('theme'));

  const back = await Auth.finishSignIn();
  if (back && !back.ok) toast('サインインできませんでした：' + back.message);

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
    if (!(await Auth.getToken())) return needSignIn();
  } catch { return; } // 電波がない。控えで動く
  refreshTree();
}

start();
