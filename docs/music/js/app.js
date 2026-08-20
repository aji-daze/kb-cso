// 画面まわりと全体の制御。
import * as db from './db.js';
import { readTags, readDuration, readDurationFast } from './tags.js';
import * as P from './player.js';
import * as drive from './drive.js';
import * as art from './art.js';

const APP_VERSION = '1.3.1';

/* ---- ホーム画面へのインストール ----
   Chrome は条件を満たすと beforeinstallprompt をくれるので、それを取っておいて
   設定画面のボタンから出せるようにする。iPhone はこのイベントが無いので手順を案内する。 */
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  if (document.querySelector('#sheetSettings.open')) renderSettings();
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  toast('ホーム画面に追加しました');
  if (document.querySelector('#sheetSettings.open')) renderSettings();
});

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

/* ============================ 小道具 ============================ */
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const norm = (s) => String(s || '').trim().normalize('NFKC').toLowerCase();
const collator = new Intl.Collator('ja'); // 数千曲を並べ替えるので、都度 localeCompare より速い比較器を使う
const jcmp = (a, b) => collator.compare(String(a || ''), String(b || ''));
const NONE_FOLDER = '__none__'; // フォルダなしの曲をまとめるキー

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60) % 60;
  const h = Math.floor(sec / 3600);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
function fmtLong(sec) {
  const m = Math.round((sec || 0) / 60);
  if (m < 60) return `${m}分`;
  return `${Math.floor(m / 60)}時間${m % 60}分`;
}
function fmtSize(b) {
  if (!b) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  return (b / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i];
}

let toastTimer;
function toast(msg, ms = 2400) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}

/* ---- 戻る操作のスタック（Android の戻るボタンにも対応） ---- */
const navStack = [];
function pushNav(close) {
  navStack.push(close);
  history.pushState({ n: navStack.length }, '');
}
function popNav() {
  if (navStack.length) history.back();
}
window.addEventListener('popstate', () => {
  const close = navStack.pop();
  if (close) close();
});

function openSheet(id) {
  const s = $('#' + id);
  s.classList.add('open');
  pushNav(() => s.classList.remove('open'));
}

/* ---- ダイアログ ---- */
function openDialog(html, onmount) {
  $('#dialog').innerHTML = html;
  $('#dialogWrap').hidden = false;
  pushNav(() => {
    $('#dialogWrap').hidden = true;
    $('#dialog').innerHTML = '';
  });
  if (onmount) onmount($('#dialog'));
}
const closeDialog = () => popNav();

function menuDialog(title, options) {
  const html =
    (title ? `<h3>${esc(title)}</h3>` : '') +
    options
      .map((o, i) => `<div class="opt${o.danger ? ' danger' : ''}${o.sel ? ' sel' : ''}" data-i="${i}">${o.icon ? `<svg><use href="#i-${o.icon}"/></svg>` : ''}<span>${esc(o.label)}</span></div>`)
      .join('');
  openDialog(html, (root) => {
    root.querySelectorAll('.opt').forEach((n) =>
      n.addEventListener('click', () => {
        const o = options[+n.dataset.i];
        closeDialog();
        setTimeout(() => o.run && o.run(), 60);
      })
    );
  });
}

function promptDialog(title, value, placeholder) {
  return new Promise((resolve) => {
    let done = false;
    openDialog(
      `<h3>${esc(title)}</h3><div class="pad"><input id="pv" type="text" value="${esc(value || '')}" placeholder="${esc(placeholder || '')}"></div>
       <div class="actions"><button class="btn ghost" id="pc">キャンセル</button><button class="btn primary" id="po">OK</button></div>`,
      (root) => {
        const input = $('#pv', root);
        setTimeout(() => input.focus(), 80);
        const ok = () => {
          if (done) return;
          done = true;
          const v = input.value.trim();
          closeDialog();
          resolve(v || null);
        };
        $('#po', root).onclick = ok;
        input.onkeydown = (e) => e.key === 'Enter' && ok();
        $('#pc', root).onclick = () => {
          if (done) return;
          done = true;
          closeDialog();
          resolve(null);
        };
      }
    );
  });
}

function confirmDialog(title, okLabel = 'OK', danger = false) {
  return new Promise((resolve) => {
    let done = false;
    openDialog(
      `<h3>${esc(title)}</h3><div class="actions"><button class="btn ghost" id="cc">キャンセル</button><button class="btn ${danger ? 'danger' : 'primary'}" id="co">${esc(okLabel)}</button></div>`,
      (root) => {
        $('#co', root).onclick = () => {
          if (done) return;
          done = true;
          closeDialog();
          resolve(true);
        };
        $('#cc', root).onclick = () => {
          if (done) return;
          done = true;
          closeDialog();
          resolve(false);
        };
      }
    );
  });
}

/* ---- 進捗表示 ----
   画面全体を覆うパネル。ドライブのフォルダ走査やジャケットの一括取得など、
   短時間で終わる処理で使う。曲の取り込みはこちらを使わず #importBar（下の帯）を使う。 */
let progCancelled = false;
function showProgress(text) {
  progCancelled = false;
  $('#progress').hidden = false;
  setProgress(0, text);
}
function setProgress(ratio, text) {
  $('#progBar').style.width = Math.max(0, Math.min(1, ratio)) * 100 + '%';
  if (text != null) $('#progText').textContent = text;
}
const hideProgress = () => ($('#progress').hidden = true);

/* ---- 取り込みの帯 ----
   画面を塞がずに、ミニプレーヤーの上（無ければ画面下）に出る細い帯。
   取り込み中も他の画面操作ができるよう、こちらは #progress のパネルを使わない。 */
let importRunning = false; // 二重に取り込みが走らないようにするガード
function showImportBar(text) {
  progCancelled = false;
  importRunning = true;
  $('#importBar').hidden = false;
  setImportBar(0, text);
}
function setImportBar(ratio, text) {
  $('#importBarFill').style.width = Math.max(0, Math.min(1, ratio)) * 100 + '%';
  if (text != null) $('#importText').textContent = text;
}
function hideImportBar() {
  importRunning = false;
  $('#importBar').hidden = true;
}

/* ============================ 状態 ============================ */
const state = {
  tracks: [],
  byId: new Map(),
  playlists: [],
  routes: [{ name: 'songs' }],
  query: '',
  searchOpen: false,
  base: [],   // シャッフル前の並び
  queue: [],  // 実際の再生順（トラックID）
  qi: -1,
  shuffle: false,
  repeat: 'off', // off | all | one
  objectUrl: null,
  ctxLabel: '',
  selectMode: false, // 複数選択モード
  selected: new Set(), // 選択中の曲ID
};

const route = () => state.routes[state.routes.length - 1];

/* ---- ジャケットの Object URL キャッシュ ---- */
const artUrls = new Map();
async function artUrl(id) {
  if (!id) return null;
  if (artUrls.has(id)) return artUrls.get(id);
  const blob = await db.get('art', id);
  const url = blob ? URL.createObjectURL(blob) : null;
  artUrls.set(id, url);
  return url;
}
function dropArtUrl(id) {
  const u = artUrls.get(id);
  if (u) URL.revokeObjectURL(u);
  artUrls.delete(id);
}

/* ============================ ライブラリ ============================ */
function albumKeyOf(t) {
  const album = String(t.album || '').trim();
  const who = String(t.albumArtist || t.artist || '').trim();
  return album ? 'a:' + norm(who) + '|' + norm(album) : '';
}

async function loadLibrary() {
  state.tracks = await db.getAll('tracks');
  state.tracks.sort((a, b) => jcmp(a.title, b.title));
  state.byId = new Map(state.tracks.map((t) => [t.id, t]));
  state.playlists = await db.getAll('playlists');
  state.playlists.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/* ---- ライブラリの間引き更新 ----
   取り込み中、まとめ書きが済むたびに一覧へ反映したいが、毎回全再描画すると重いし、
   複数選択モード・ダイアログ・シートが開いているときに再描画すると操作の邪魔になる。
   そこで「反映したい」という予約だけ立てておき、都合のよいタイミングでまとめて反映する。 */
let libRefreshQueued = false;
let lastLibRefresh = 0;
const LIB_REFRESH_GAP = 2000; // これより短い間隔では再描画しない

function uiBusyForRefresh() {
  return state.selectMode || !$('#dialogWrap').hidden || !!document.querySelector('.sheet.open');
}

function queueLibraryRefresh() {
  libRefreshQueued = true;
  tryFlushLibraryRefresh();
}

function tryFlushLibraryRefresh() {
  if (!libRefreshQueued) return;
  if (uiBusyForRefresh()) return; // 操作中は見送る。後で（次のまとめ書きや定期リトライで）また試す
  if (Date.now() - lastLibRefresh < LIB_REFRESH_GAP) return;
  libRefreshQueued = false;
  lastLibRefresh = Date.now();
  sortTracksIfNeeded();
  render();
}

/* ---- 取り込み中の一覧更新 ----
   以前はまとめ書きのたびに loadLibrary()（＝全曲を読み直し）していたが、
   これは曲数に比例して重くなり、数千曲では取り込みが進まなくなる。
   書いた中身は手元にあるので、追加分だけを足す。並べ替えは描画の直前にまとめて行う。 */
let tracksDirty = false;

function appendTracksToState(tracks) {
  let n = 0;
  for (const t of tracks) {
    if (state.byId.has(t.id)) continue;
    state.byId.set(t.id, t);
    state.tracks.push(t);
    n++;
  }
  if (n) tracksDirty = true;
}

function sortTracksIfNeeded() {
  if (!tracksDirty) return;
  tracksDirty = false;
  state.tracks.sort((a, b) => jcmp(a.title, b.title));
}

function groupAlbums(tracks = state.tracks) {
  const m = new Map();
  for (const t of tracks) {
    const key = t.albumKey || 'x:' + t.id;
    if (!m.has(key)) {
      m.set(key, {
        key,
        album: t.album || '不明なアルバム',
        artist: t.albumArtist || t.artist || '不明なアーティスト',
        artId: t.artId,
        tracks: [],
      });
    }
    const g = m.get(key);
    g.tracks.push(t);
    if (!g.artId && t.artId) g.artId = t.artId;
  }
  const list = [...m.values()];
  list.forEach((g) => g.tracks.sort((a, b) => (a.trackNo || 999) - (b.trackNo || 999) || jcmp(a.title, b.title)));
  list.sort((a, b) => jcmp(a.artist, b.artist) || jcmp(a.album, b.album));
  return list;
}

function groupArtists(tracks = state.tracks) {
  const m = new Map();
  for (const t of tracks) {
    const key = norm(t.artist || '') || 'unknown';
    if (!m.has(key)) m.set(key, { key, name: t.artist || '不明なアーティスト', tracks: [], albums: new Set() });
    const g = m.get(key);
    g.tracks.push(t);
    if (t.albumKey) g.albums.add(t.albumKey);
  }
  const list = [...m.values()];
  list.sort((a, b) => jcmp(a.name, b.name));
  return list;
}

function filtered() {
  const q = norm(state.query);
  if (!q) return state.tracks;
  return state.tracks.filter(
    (t) => norm(t.title).includes(q) || norm(t.artist).includes(q) || norm(t.album).includes(q) || norm(t.folder || '').includes(q)
  );
}

// フォルダのフルパス（末尾の名前 / それより上位のパス）に分ける
function folderNameParts(folder) {
  const parts = String(folder || '').split('/').filter(Boolean);
  const name = parts.pop() || folder || '';
  return { name, parent: parts.join('/') };
}

function folderLabel(g) {
  return g.key === NONE_FOLDER ? '未分類' : folderNameParts(g.folder).name;
}

// フォルダごとに曲をまとめる。既存トラックには folder が無いことがあるので t.folder || '' で扱う
function groupFolders(tracks = state.tracks) {
  const m = new Map();
  for (const t of tracks) {
    const folder = t.folder || '';
    const key = folder ? t.folderKey || norm(folder) : NONE_FOLDER;
    if (!m.has(key)) m.set(key, { key, folder, tracks: [] });
    m.get(key).tracks.push(t);
  }
  const list = [...m.values()];
  list.forEach((g) => g.tracks.sort((a, b) => String(a.fileName || '').localeCompare(String(b.fileName || ''), 'ja', { numeric: true })));
  // フルパス昇順。未分類は最後。
  list.sort((a, b) => (a.key === NONE_FOLDER ? 1 : b.key === NONE_FOLDER ? -1 : jcmp(a.folder, b.folder)));
  return list;
}

function builtinPlaylist(key) {
  const ts = state.tracks;
  if (key === 'fav') return { name: 'お気に入り', tracks: ts.filter((t) => t.favorite).sort((a, b) => jcmp(a.title, b.title)) };
  if (key === 'recent') return { name: '最近追加した曲', tracks: [...ts].sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).slice(0, 100) };
  if (key === 'top') return { name: 'よく聴く曲', tracks: ts.filter((t) => t.playCount).sort((a, b) => b.playCount - a.playCount).slice(0, 100) };
  if (key === 'played') return { name: '最近再生した曲', tracks: ts.filter((t) => t.lastPlayed).sort((a, b) => b.lastPlayed - a.lastPlayed).slice(0, 100) };
  return null;
}

/* ============================ 画面描画 ============================ */
const view = $('#view');

function render() {
  const r = route();
  const isRoot = state.routes.length === 1;
  $('#btnBack').hidden = isRoot;
  $('#tabs').hidden = !isRoot;
  $('#btnSearch').hidden = !isRoot;
  $('#searchWrap').hidden = !(isRoot && state.searchOpen);
  view.innerHTML = '';

  if (isRoot) {
    $('#mainTitle').textContent = 'ミュージック';
    [...$('#tabs').children].forEach((b) => b.classList.toggle('on', b.dataset.tab === r.name));
    if (r.name === 'songs') renderSongs();
    else if (r.name === 'albums') renderAlbums();
    else if (r.name === 'artists') renderArtists();
    else if (r.name === 'folders') renderFolders();
    else renderPlaylists();
  } else if (r.name === 'album') renderAlbumDetail(r.key);
  else if (r.name === 'artist') renderArtistDetail(r.key);
  else if (r.name === 'folder') renderFolderDetail(r.key);
  else if (r.name === 'playlist') renderPlaylistDetail(r.key);
  syncSelectUI();
}

function pushRoute(r) {
  if (state.selectMode) {
    // 選択モード中に画面遷移が起きるときは、まず選択を解除してから遷移する
    exitSelectMode();
    setTimeout(() => pushRoute(r), 0);
    return;
  }
  state.routes.push(r);
  pushNav(() => {
    state.routes.pop();
    render();
  });
  render();
}

function emptyState(msg) {
  return `<div class="empty">${msg}</div>`;
}

function songRowHTML(t, i, opts = {}) {
  const sub = [t.artist, t.album].filter(Boolean).join(' · ');
  return `<div class="row" data-act="play" data-id="${t.id}" data-i="${i}">
    <div class="chk"><svg><use href="#i-check"/></svg></div>
    ${opts.num ? `<div class="num">${t.trackNo || i + 1}</div>` : ''}
    <div class="txt"><div class="t">${esc(t.title)}</div><div class="s">${esc(sub || '不明')}${t.duration ? ' · ' + fmtTime(t.duration) : ''}</div></div>
    ${t.favorite ? '<svg style="width:14px;height:14px;color:var(--acc);flex:none"><use href="#i-heart"/></svg>' : ''}
    <button class="icon" data-act="menu" data-id="${t.id}"><svg><use href="#i-more"/></svg></button>
  </div>`;
}

// 大量の曲でも固まらないように少しずつ描く
function mountChunked(container, items, makeHTML, chunk = 120, after) {
  let n = 0;
  const step = () => {
    const part = items.slice(n, n + chunk);
    if (!part.length) return;
    const frag = document.createElement('div');
    frag.innerHTML = part.map((it, i) => makeHTML(it, n + i)).join('');
    while (frag.firstChild) container.appendChild(frag.firstChild);
    n += part.length;
    if (after) after(container);
    if (n < items.length) {
      const s = document.createElement('div');
      s.style.height = '1px';
      container.appendChild(s);
      const io = new IntersectionObserver((e) => {
        if (e[0].isIntersecting) {
          io.disconnect();
          s.remove();
          step();
        }
      });
      io.observe(s);
    }
  };
  step();
}

async function fillArt(container) {
  const imgs = container.querySelectorAll('img[data-art]:not([data-done])');
  for (const img of imgs) {
    img.dataset.done = '1';
    const u = await artUrl(img.dataset.art);
    if (u) img.src = u;
  }
}

function playContext(tracks, index, label) {
  playList(tracks.map((t) => t.id), index, label);
}

function renderSongs() {
  const list = filtered();
  if (!list.length) {
    view.innerHTML = state.query
      ? emptyState('見つかりませんでした')
      : emptyState('まだ曲がありません。<br>右上の設定から、端末や microSD の曲、<br>または Google ドライブの曲を取り込んでください。');
    return;
  }
  const head = document.createElement('div');
  head.className = 'detail-actions';
  head.style.padding = '10px 14px';
  head.innerHTML = `<button class="btn" data-act="playall">すべて再生</button><button class="btn" data-act="shuffleall">シャッフル再生</button><span class="muted" style="align-self:center;font-size:12px">${list.length} 曲</span>`;
  view.appendChild(head);
  const box = document.createElement('div');
  view.appendChild(box);
  mountChunked(box, list, (t, i) => songRowHTML(t, i), 120, syncSelectUI);
  box.dataset.ctx = 'songs';
}

function renderAlbums() {
  const groups = groupAlbums(filtered());
  if (!groups.length) return (view.innerHTML = emptyState('アルバムがありません'));
  const grid = document.createElement('div');
  grid.className = 'grid';
  view.appendChild(grid);
  mountChunked(
    grid,
    groups,
    (g) => `<div class="card" data-act="album" data-key="${esc(g.key)}">
      <div class="cover"><img data-art="${esc(g.artId || '')}" alt=""><svg class="ph"><use href="#i-note"/></svg></div>
      <div class="t">${esc(g.album)}</div><div class="s">${esc(g.artist)} · ${g.tracks.length}曲</div>
    </div>`,
    30,
    fillArt
  );
}

function renderArtists() {
  const groups = groupArtists(filtered());
  if (!groups.length) return (view.innerHTML = emptyState('アーティストがいません'));
  const box = document.createElement('div');
  view.appendChild(box);
  mountChunked(
    box,
    groups,
    (g) => `<div class="row" data-act="artist" data-key="${esc(g.key)}">
      <div class="txt"><div class="t">${esc(g.name)}</div><div class="s">${g.albums.size ? g.albums.size + 'アルバム · ' : ''}${g.tracks.length}曲</div></div>
    </div>`
  );
}

function renderFolders() {
  const groups = groupFolders(filtered());
  const real = groups.filter((g) => g.key !== NONE_FOLDER);
  if (!real.length) {
    view.innerHTML = emptyState(
      state.query
        ? '見つかりませんでした'
        : 'フォルダの情報がありません。<br>設定の「フォルダごと取り込む」から取り込むと、フォルダ構成のまま分類されます。'
    );
    return;
  }
  const box = document.createElement('div');
  view.appendChild(box);
  mountChunked(box, groups, (g) => {
    if (g.key === NONE_FOLDER) {
      return `<div class="row" data-act="folder" data-key="${NONE_FOLDER}">
        <div class="txt"><div class="t">未分類</div><div class="s">${g.tracks.length}曲</div></div>
      </div>`;
    }
    const { name, parent } = folderNameParts(g.folder);
    const sub = [parent, `${g.tracks.length}曲`].filter(Boolean).join(' · ');
    return `<div class="row" data-act="folder" data-key="${esc(g.key)}">
      <div class="txt"><div class="t">${esc(name)}</div><div class="s">${esc(sub)}</div></div>
    </div>`;
  });
}

function renderPlaylists() {
  const built = [
    { key: 'fav', name: 'お気に入り', n: state.tracks.filter((t) => t.favorite).length },
    { key: 'recent', name: '最近追加した曲', n: Math.min(100, state.tracks.length) },
    { key: 'played', name: '最近再生した曲', n: state.tracks.filter((t) => t.lastPlayed).length },
    { key: 'top', name: 'よく聴く曲', n: state.tracks.filter((t) => t.playCount).length },
  ];
  let html = built
    .map((b) => `<div class="row" data-act="playlist" data-key="${b.key}"><div class="txt"><div class="t">${b.name}</div><div class="s">${b.n} 曲</div></div></div>`)
    .join('');
  html += `<div class="sectitle">自分のプレイリスト</div>`;
  html += `<div class="row" data-act="newpl"><div class="txt"><div class="t" style="color:var(--acc)">＋ 新しいプレイリスト</div></div></div>`;
  html += state.playlists
    .map(
      (p) => `<div class="row" data-act="playlist" data-key="${esc(p.id)}">
        <div class="txt"><div class="t">${esc(p.name)}</div><div class="s">${p.trackIds.length} 曲</div></div>
        <button class="icon" data-act="plmenu" data-key="${esc(p.id)}"><svg><use href="#i-more"/></svg></button>
      </div>`
    )
    .join('');
  view.innerHTML = html;
}

function renderAlbumDetail(key) {
  const g = groupAlbums().find((x) => x.key === key);
  if (!g) return (view.innerHTML = emptyState('アルバムが見つかりません'));
  $('#mainTitle').textContent = g.album;
  const total = g.tracks.reduce((s, t) => s + (t.duration || 0), 0);
  view.innerHTML = `
    <div class="detail-head">
      <div class="cover"><img data-art="${esc(g.artId || '')}" alt=""><svg class="ph"><use href="#i-note"/></svg></div>
      <div><h2>${esc(g.album)}</h2><div class="s">${esc(g.artist)}<br>${g.tracks.length}曲 · ${fmtLong(total)}</div></div>
    </div>
    <div class="detail-actions">
      <button class="btn primary" data-act="playall">再生</button>
      <button class="btn" data-act="shuffleall">シャッフル</button>
      <button class="btn" data-act="findart" data-key="${esc(key)}">ジャケット</button>
      <button class="btn" data-act="albummenu" data-key="${esc(key)}">…</button>
    </div>
    <div id="albumTracks">${g.tracks.map((t, i) => songRowHTML(t, i, { num: true })).join('')}</div>`;
  fillArt(view);
  view.dataset.ctx = JSON.stringify({ type: 'album', key });
}

function renderArtistDetail(key) {
  const g = groupArtists().find((x) => x.key === key);
  if (!g) return (view.innerHTML = emptyState('アーティストが見つかりません'));
  $('#mainTitle').textContent = g.name;
  const albums = groupAlbums(g.tracks);
  let html = `<div class="detail-actions" style="padding:14px">
      <button class="btn primary" data-act="playall">再生</button>
      <button class="btn" data-act="shuffleall">シャッフル</button>
      <span class="muted" style="align-self:center;font-size:12px">${g.tracks.length}曲</span>
    </div>`;
  if (albums.length > 1) {
    html += `<div class="sectitle">アルバム</div><div class="grid">` +
      albums
        .map(
          (a) => `<div class="card" data-act="album" data-key="${esc(a.key)}">
        <div class="cover"><img data-art="${esc(a.artId || '')}" alt=""><svg class="ph"><use href="#i-note"/></svg></div>
        <div class="t">${esc(a.album)}</div><div class="s">${a.tracks.length}曲</div></div>`
        )
        .join('') + `</div>`;
  }
  html += `<div class="sectitle">曲</div>` + g.tracks.map((t, i) => songRowHTML(t, i)).join('');
  view.innerHTML = html;
  fillArt(view);
  view.dataset.ctx = JSON.stringify({ type: 'artist', key });
}

function renderFolderDetail(key) {
  const g = groupFolders().find((x) => x.key === key);
  if (!g) return (view.innerHTML = emptyState('フォルダが見つかりません'));
  $('#mainTitle').textContent = folderLabel(g);
  const total = g.tracks.reduce((s, t) => s + (t.duration || 0), 0);
  view.innerHTML = `
    <div class="detail-actions" style="padding:14px">
      <button class="btn primary" data-act="playall">再生</button>
      <button class="btn" data-act="shuffleall">シャッフル</button>
      ${g.tracks.length ? `<button class="btn" data-act="folderAlbum" data-key="${esc(key)}">このフォルダをアルバムにする</button>` : ''}
      <span class="muted" style="align-self:center;font-size:12px">${g.tracks.length}曲 · ${fmtLong(total)}</span>
    </div>
    ${g.tracks.length ? g.tracks.map((t, i) => songRowHTML(t, i)).join('') : emptyState('曲がありません')}`;
  view.dataset.ctx = JSON.stringify({ type: 'folder', key });
}

function renderPlaylistDetail(key) {
  const b = builtinPlaylist(key);
  const pl = b ? null : state.playlists.find((p) => p.id === key);
  if (!b && !pl) return (view.innerHTML = emptyState('プレイリストが見つかりません'));
  const name = b ? b.name : pl.name;
  const tracks = b ? b.tracks : pl.trackIds.map((id) => state.byId.get(id)).filter(Boolean);
  $('#mainTitle').textContent = name;
  const total = tracks.reduce((s, t) => s + (t.duration || 0), 0);
  view.innerHTML = `
    <div class="detail-actions" style="padding:14px">
      <button class="btn primary" data-act="playall">再生</button>
      <button class="btn" data-act="shuffleall">シャッフル</button>
      ${pl ? `<button class="btn" data-act="plmenu" data-key="${esc(pl.id)}">…</button>` : ''}
      <span class="muted" style="align-self:center;font-size:12px">${tracks.length}曲 · ${fmtLong(total)}</span>
    </div>
    ${tracks.length ? tracks.map((t, i) => songRowHTML(t, i, { num: !!pl })).join('') : emptyState('曲がありません')}`;
  view.dataset.ctx = JSON.stringify({ type: 'playlist', key });
}

// いま画面に出ている曲の並び（再生の文脈）を取り出す
function currentListTracks() {
  const r = route();
  if (r.name === 'album') {
    const g = groupAlbums().find((x) => x.key === r.key);
    return { tracks: g ? g.tracks : [], label: g ? g.album : '' };
  }
  if (r.name === 'artist') {
    const g = groupArtists().find((x) => x.key === r.key);
    return { tracks: g ? g.tracks : [], label: g ? g.name : '' };
  }
  if (r.name === 'folder') {
    const g = groupFolders().find((x) => x.key === r.key);
    return { tracks: g ? g.tracks : [], label: g ? folderLabel(g) : '' };
  }
  if (r.name === 'playlist') {
    const b = builtinPlaylist(r.key);
    if (b) return { tracks: b.tracks, label: b.name };
    const pl = state.playlists.find((p) => p.id === r.key);
    return { tracks: pl ? pl.trackIds.map((id) => state.byId.get(id)).filter(Boolean) : [], label: pl ? pl.name : '' };
  }
  return { tracks: filtered(), label: state.query ? '検索結果' : 'すべての曲' };
}

/* ============================ 再生 ============================ */
const audio = P.audio;

function shuffled(ids, firstId) {
  const rest = ids.filter((id) => id !== firstId);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return firstId ? [firstId, ...rest] : rest;
}

function playList(ids, index, label) {
  if (!ids.length) return;
  state.base = ids.slice();
  state.ctxLabel = label || '';
  if (state.shuffle) {
    state.queue = shuffled(ids, ids[index]);
    state.qi = 0;
  } else {
    state.queue = ids.slice();
    state.qi = index;
  }
  loadCurrent(true);
}

async function loadCurrent(autoplay, seekTo = 0) {
  const id = state.queue[state.qi];
  const t = state.byId.get(id);
  if (!t) return;
  const blob = await db.get('blobs', id);
  if (!blob) {
    toast('ファイルの実体が見つかりません');
    return;
  }
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = URL.createObjectURL(blob);
  audio.src = state.objectUrl;
  try {
    audio.currentTime = 0;
  } catch {}
  if (seekTo) {
    audio.addEventListener('loadedmetadata', () => { try { audio.currentTime = seekTo; } catch {} }, { once: true });
  }
  await updateNowUI(t);
  if (autoplay) {
    try {
      await P.resumeContext();
      await audio.play();
    } catch (e) {
      toast('再生できませんでした');
    }
    t.playCount = (t.playCount || 0) + 1;
    t.lastPlayed = Date.now();
    db.put('tracks', t);
  }
  savePlayback();
}

function currentTrack() {
  return state.byId.get(state.queue[state.qi]) || null;
}

async function updateNowUI(t) {
  $('#mini').hidden = false;
  $('#miniTitle').textContent = t.title;
  $('#miniSub').textContent = [t.artist, t.album].filter(Boolean).join(' · ');
  $('#nowTitle').textContent = t.title;
  $('#nowSub').textContent = [t.artist, t.album].filter(Boolean).join(' · ');
  $('#nowFrom').textContent = state.ctxLabel || '再生中';
  $('#tFav').classList.toggle('on', !!t.favorite);
  $('#durTime').textContent = fmtTime(t.duration || 0);

  const u = await artUrl(t.artId);
  const mini = $('#miniArt');
  const now = $('#nowArt');
  if (u) {
    mini.src = u;
    now.src = u;
  } else {
    mini.removeAttribute('src');
    now.removeAttribute('src');
  }
  updateMediaSession(t, u);
  highlightPlaying();
}

function highlightPlaying() {
  const id = state.queue[state.qi];
  document.querySelectorAll('#view .row[data-id]').forEach((n) => n.classList.toggle('playing', n.dataset.id === id));
}

function updateMediaSession(t, artUrlStr) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title,
      artist: t.artist || '',
      album: t.album || '',
      artwork: artUrlStr ? [{ src: artUrlStr, sizes: '512x512', type: 'image/jpeg' }] : [],
    });
  } catch {}
}

function setupMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const set = (a, fn) => {
    try {
      navigator.mediaSession.setActionHandler(a, fn);
    } catch {}
  };
  set('play', () => togglePlay(true));
  set('pause', () => togglePlay(false));
  set('previoustrack', () => prev());
  set('nexttrack', () => next(false));
  set('seekbackward', (d) => (audio.currentTime = Math.max(0, audio.currentTime - (d.seekOffset || 10))));
  set('seekforward', (d) => (audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + (d.seekOffset || 10))));
  set('seekto', (d) => {
    if (d.fastSeek && audio.fastSeek) audio.fastSeek(d.seekTime);
    else audio.currentTime = d.seekTime;
  });
  set('stop', () => stopPlayback());
}

async function togglePlay(force) {
  const want = force === undefined ? audio.paused : force;
  if (want) {
    if (state.qi < 0) {
      const { tracks, label } = currentListTracks();
      if (tracks.length) return playContext(tracks, 0, label);
      return;
    }
    await P.resumeContext();
    audio.play().catch(() => toast('再生できませんでした'));
  } else audio.pause();
}

function next(auto = false) {
  if (!state.queue.length) return;
  if (auto && P.consumeTrackEndSleep()) {
    audio.pause();
    toast('スリープタイマーで停止しました');
    return;
  }
  if (state.qi < state.queue.length - 1) {
    state.qi++;
    loadCurrent(true);
  } else if (state.repeat === 'all') {
    if (state.shuffle) state.queue = shuffled(state.base);
    state.qi = 0;
    loadCurrent(true);
  } else {
    audio.pause();
    audio.currentTime = 0;
  }
}

function prev() {
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  if (state.qi > 0) {
    state.qi--;
    loadCurrent(true);
  } else audio.currentTime = 0;
}

// ■ 再生を終わらせる。一時停止と違って、頭に戻して表示も通知も片付ける。
function stopPlayback() {
  audio.pause();
  try {
    audio.currentTime = 0;
  } catch {}
  audio.removeAttribute('src');
  audio.load(); // これでメディア通知が消える
  if (state.objectUrl) {
    URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = null;
  }
  state.queue = [];
  state.base = [];
  state.qi = -1;
  state.ctxLabel = '';

  P.cancelSleep();
  clearTimeout(saveTimer);
  db.setSetting('lastPlayback', null); // 次に開いたときは何も鳴っていない状態から

  $('#mini').hidden = true;
  if ($('#sheetNow').classList.contains('open')) popNav();

  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.playbackState = 'none';
      navigator.mediaSession.metadata = null;
    } catch {}
  }
  $('#miniBar').firstElementChild.style.width = '0';
  highlightPlaying();
  syncControls();
  applyUpdateIfPossible();
}

function toggleShuffle() {
  state.shuffle = !state.shuffle;
  const cur = state.queue[state.qi];
  if (state.shuffle) {
    state.queue = shuffled(state.base.length ? state.base : state.queue, cur);
    state.qi = 0;
  } else {
    if (state.base.length) {
      state.queue = state.base.slice();
      state.qi = Math.max(0, state.queue.indexOf(cur));
    }
  }
  db.setSetting('shuffle', state.shuffle);
  syncControls();
}

/* 1曲リピートはブラウザ本体の loop に任せる。
   「終わったら JS で頭に戻して play() し直す」を毎周やると、端末によっては数周で
   オーディオの再生権を失って止まることがある。loop なら再生が途切れない。
   ただし「この曲の終わりで停止」を仕掛けているときは、終わりを検知する必要があるので loop は使わない。 */
function syncLoopFlag() {
  audio.loop = state.repeat === 'one' && P.sleepState().mode !== 'trackEnd';
}

function cycleRepeat() {
  state.repeat = state.repeat === 'off' ? 'all' : state.repeat === 'all' ? 'one' : 'off';
  db.setSetting('repeat', state.repeat);
  syncLoopFlag();
  syncControls();
}

function syncControls() {
  $('#btnShuffle').classList.toggle('on', state.shuffle);
  const rb = $('#btnRepeat');
  syncLoopFlag();
  rb.classList.toggle('on', state.repeat !== 'off');
  rb.querySelector('use').setAttribute('href', state.repeat === 'one' ? '#i-repeat1' : '#i-repeat');
  const playing = !audio.paused;
  $('#btnPlay').querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play');
  $('#miniPlay').querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play');
  $('#tSpeed').querySelector('span').textContent = audio.playbackRate.toFixed(audio.playbackRate % 1 === 0 ? 1 : 2) + 'x';
  $('#tEq').classList.toggle('on', P.eqEnabled());
  $('#tTimer').classList.toggle('on', P.sleepState().mode !== 'off');
}

let seeking = false;
function syncTime() {
  const d = audio.duration || currentTrack()?.duration || 0;
  const c = audio.currentTime || 0;
  if (!seeking) $('#seek').value = d ? Math.round((c / d) * 1000) : 0;
  $('#curTime').textContent = fmtTime(c);
  $('#durTime').textContent = fmtTime(d);
  $('#miniBar').firstElementChild.style.width = d ? (c / d) * 100 + '%' : '0';
  if ('mediaSession' in navigator && navigator.mediaSession.setPositionState && d) {
    try {
      navigator.mediaSession.setPositionState({ duration: d, position: Math.min(c, d), playbackRate: audio.playbackRate });
    } catch {}
  }
}

let saveTimer = 0;
function savePlayback() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    db.setSetting('lastPlayback', {
      ids: state.queue,
      base: state.base,
      i: state.qi,
      pos: audio.currentTime || 0,
      label: state.ctxLabel,
    });
  }, 400);
}

/* ============================ 曲メニュー ============================ */
function trackMenu(id) {
  const t = state.byId.get(id);
  if (!t) return;
  menuDialog(t.title, [
    { label: '再生', icon: 'play', run: () => playSingle(t) },
    { label: '選択する', run: () => enterSelectMode(id) },
    { label: '次に再生', icon: 'queue', run: () => insertNext(t.id) },
    { label: 'キューの最後に追加', icon: 'plus', run: () => { state.queue.push(t.id); state.base.push(t.id); toast('キューに追加しました'); } },
    { label: t.favorite ? 'お気に入りから外す' : 'お気に入りに追加', icon: 'heart', run: () => toggleFav(t) },
    { label: 'プレイリストに追加', icon: 'plus', run: () => addToPlaylistDialog([t.id]) },
    { label: '曲の情報', icon: 'note', run: () => trackInfo(t) },
    { label: '端末から削除', icon: 'trash', danger: true, run: () => deleteTracks([t.id], t.title) },
  ]);
}

function playSingle(t) {
  const { tracks, label } = currentListTracks();
  const i = tracks.findIndex((x) => x.id === t.id);
  if (i >= 0) playContext(tracks, i, label);
  else playList([t.id], 0, '');
}

function insertNext(id) {
  if (state.qi < 0) return playList([id], 0, '');
  state.queue.splice(state.qi + 1, 0, id);
  toast('次に再生します');
}

async function toggleFav(t) {
  t.favorite = !t.favorite;
  await db.put('tracks', t);
  if (currentTrack() && currentTrack().id === t.id) $('#tFav').classList.toggle('on', !!t.favorite);
  toast(t.favorite ? 'お気に入りに追加しました' : 'お気に入りから外しました');
  render();
}

function trackInfo(t) {
  const rows = [
    ['曲名', t.title],
    ['アーティスト', t.artist || '—'],
    ['アルバム', t.album || '—'],
    ['年', t.year || '—'],
    ['長さ', fmtTime(t.duration || 0)],
    ['サイズ', fmtSize(t.size)],
    ['形式', t.mime || '—'],
    ['ファイル名', t.fileName || '—'],
    ['取り込み元', t.source === 'drive' ? 'Google ドライブ' : '端末'],
    ['再生回数', String(t.playCount || 0)],
  ];
  openDialog(
    `<h3>曲の情報</h3><div class="pad" style="font-size:13px;line-height:2">` +
      rows.map(([k, v]) => `<div style="display:flex;gap:10px"><span class="muted" style="width:6.5em;flex:none">${k}</span><span style="word-break:break-all">${esc(v)}</span></div>`).join('') +
      `</div><div class="actions"><button class="btn full" id="ic">閉じる</button></div>`,
    (root) => ($('#ic', root).onclick = closeDialog)
  );
}

async function deleteTracks(ids, name) {
  const ok = await confirmDialog(ids.length === 1 ? `「${name}」を端末から削除しますか？` : `${ids.length}曲を端末から削除しますか？`, '削除', true);
  if (!ok) return;
  await db.deleteTracks(ids);
  const set = new Set(ids);
  if (set.has(state.queue[state.qi])) audio.pause();
  state.queue = state.queue.filter((x) => !set.has(x));
  state.base = state.base.filter((x) => !set.has(x));
  for (const pl of state.playlists) {
    const before = pl.trackIds.length;
    pl.trackIds = pl.trackIds.filter((x) => !set.has(x));
    if (pl.trackIds.length !== before) await db.put('playlists', pl);
  }
  await loadLibrary();
  render();
  toast('削除しました');
}

/* ============================ 複数選択 ============================ */
function enterSelectMode(id) {
  state.selectMode = true;
  state.selected = new Set(id ? [id] : []);
  pushNav(() => {
    state.selectMode = false;
    state.selected = new Set();
    syncSelectUI();
  });
  syncSelectUI();
}

function exitSelectMode() {
  if (state.selectMode) popNav(); // pushNav で登録した後始末（上の関数）を戻る操作として実行する
}

function toggleSelect(id) {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  if (state.selected.size === 0) {
    exitSelectMode();
    return;
  }
  syncSelectUI();
}

// 選択モードの見た目（上部バー・下部アクションバー・各行のチェック）をまとめて同期する。
// render() の最後や、選択の増減のたびに呼ぶ。選択モードでないときはただ後片付けするだけ。
function syncSelectUI() {
  document.body.classList.toggle('select-mode', state.selectMode);
  $('#topbar').hidden = state.selectMode;
  $('#topbarSelect').hidden = !state.selectMode;
  $('#selectBar').hidden = !state.selectMode;
  if (state.selectMode) $('#selTitle').textContent = `${state.selected.size}曲を選択中`;
  document.querySelectorAll('#view .row[data-id]').forEach((row) => {
    row.classList.toggle('sel', state.selected.has(row.dataset.id));
  });
}

/* ---- 曲IDの配列を、指定したアルバム名にまとめる共通処理 ----
   選択モードの「アルバムにまとめる」、アルバム詳細の「アルバム名を変える」「別のアルバムに統合」、
   フォルダ詳細の「このフォルダをアルバムにする」は、すべてここを通る。
   albumArtist を渡したときだけ選択曲の albumArtist を上書きする（渡さなければ曲ごとの値のまま）。 */
async function moveTracksToAlbum(ids, albumName, albumArtist) {
  const name = String(albumName || '').trim();
  if (!name) return null;
  const targets = ids.map((id) => state.byId.get(id)).filter(Boolean);
  if (!targets.length) return null;

  // albumKey はアーティスト名込みで作られるので、まとめる曲のアルバムアーティストを
  // 揃えないと「同じアルバム名なのに別アルバム」になってしまう。
  if (albumArtist === undefined) {
    const artists = [...new Set(targets.map((t) => String(t.albumArtist || t.artist || '').trim()).filter(Boolean))];
    albumArtist = artists.length === 1 ? artists[0] : artists.length === 0 ? '' : 'さまざまなアーティスト';
  }
  for (const t of targets) {
    t.album = name;
    t.albumArtist = albumArtist;
  }
  const oldArtIds = targets.map((t) => t.artId);
  for (const t of targets) t.albumKey = albumKeyOf(t);
  const newKey = targets[0].albumKey; // 通常は全曲が同じアルバム名・アーティストになるので同じキーになる

  // ジャケットの引き継ぎ: 移動先にまだ無ければ、選択曲のどれかが持っているものをコピーする
  if (newKey && !(await db.has('art', newKey))) {
    for (const oldId of oldArtIds) {
      if (oldId && oldId !== newKey && (await db.has('art', oldId))) {
        const blob = await db.get('art', oldId);
        if (blob) {
          await db.put('art', blob, newKey);
          dropArtUrl(newKey);
        }
        break;
      }
    }
  }

  for (const t of targets) {
    t.artId = t.albumKey || null;
    await db.put('tracks', t);
  }

  await loadLibrary();
  render();
  const cur = currentTrack();
  if (cur && targets.some((t) => t.id === cur.id)) updateNowUI(state.byId.get(cur.id));
  return { name, count: targets.length };
}

async function runMoveToAlbum(ids, name, albumArtist) {
  const res = await moveTracksToAlbum(ids, name, albumArtist);
  if (!res) return;
  exitSelectMode(); // 用が済んだら選択モードから抜ける（選択中はタブが隠れているため）
  toast(`${res.count}曲を「${res.name}」にまとめました`);
}

// 「アルバムにまとめる」「別のアルバムに統合」共通のダイアログ。既存アルバムから選ぶか、新しい名前を入力する。
function chooseAlbumDialog(ids, { title = 'アルバムにまとめる', excludeKey } = {}) {
  const groups = groupAlbums().filter((g) => g.key !== excludeKey);
  const opts = [
    {
      label: '＋ 新しいアルバム名を入力',
      icon: 'plus',
      run: async () => {
        const name = await promptDialog('アルバム名', '', '例）青の記録');
        if (!name) return;
        await runMoveToAlbum(ids, name, undefined);
      },
    },
    ...groups.map((g) => ({
      label: `${g.album}（${g.artist}・${g.tracks.length}曲）`,
      // 統合先の曲も対象に含めることで、両者のアルバムアーティストが必ず揃う
      run: () => runMoveToAlbum([...new Set([...ids, ...g.tracks.map((t) => t.id)])], g.album, undefined),
    })),
  ];
  menuDialog(title, opts);
}

async function folderToAlbum(folderKey) {
  const g = groupFolders().find((x) => x.key === folderKey);
  if (!g || !g.tracks.length) return;
  const initial = g.key === NONE_FOLDER ? '' : folderNameParts(g.folder).name;
  const name = await promptDialog('アルバム名', initial, '例）青の記録');
  if (!name) return;
  await runMoveToAlbum(g.tracks.map((t) => t.id), name, undefined);
}

async function moveTracksArtist(ids, name) {
  const targets = ids.map((id) => state.byId.get(id)).filter(Boolean);
  for (const t of targets) {
    const oldKey = t.albumKey;
    t.artist = name;
    t.artistKey = norm(name);
    t.albumKey = albumKeyOf(t);
    if (t.artId === oldKey && t.artId !== t.albumKey) t.artId = t.albumKey || null;
    await db.put('tracks', t);
  }
  await loadLibrary();
  render();
  const cur = currentTrack();
  if (cur && targets.some((t) => t.id === cur.id)) updateNowUI(state.byId.get(cur.id));
}

async function renameArtistDialog(ids) {
  const first = state.byId.get(ids[0]);
  const name = await promptDialog('アーティスト名', first ? first.artist : '', '例）新しい名前');
  if (!name) return;
  await moveTracksArtist(ids, name);
  exitSelectMode();
  toast(`${ids.length}曲のアーティストを「${name}」に変更しました`);
}

/* ============================ プレイリスト ============================ */
async function newPlaylist(withTracks = []) {
  const name = await promptDialog('プレイリスト名', '', '例）お気に入り2026');
  if (!name) return null;
  const pl = { id: uid(), name, trackIds: withTracks.slice(), createdAt: Date.now(), updatedAt: Date.now() };
  await db.put('playlists', pl);
  await loadLibrary();
  render();
  toast(`「${name}」を作成しました`);
  return pl;
}

function addToPlaylistDialog(ids) {
  const opts = [
    { label: '＋ 新しいプレイリストを作る', icon: 'plus', run: () => newPlaylist(ids) },
    ...state.playlists.map((p) => ({
      label: `${p.name}（${p.trackIds.length}）`,
      run: async () => {
        const set = new Set(p.trackIds);
        const add = ids.filter((i) => !set.has(i));
        p.trackIds.push(...add);
        p.updatedAt = Date.now();
        await db.put('playlists', p);
        await loadLibrary();
        render();
        toast(add.length ? `${add.length}曲を追加しました` : '追加済みでした');
      },
    })),
  ];
  menuDialog('プレイリストに追加', opts);
}

function playlistMenu(id) {
  const pl = state.playlists.find((p) => p.id === id);
  if (!pl) return;
  menuDialog(pl.name, [
    { label: '再生', icon: 'play', run: () => { const ts = pl.trackIds.map((i) => state.byId.get(i)).filter(Boolean); playContext(ts, 0, pl.name); } },
    {
      label: '名前を変える',
      run: async () => {
        const n = await promptDialog('プレイリスト名', pl.name);
        if (!n) return;
        pl.name = n;
        pl.updatedAt = Date.now();
        await db.put('playlists', pl);
        await loadLibrary();
        render();
      },
    },
    {
      label: 'プレイリストを削除',
      icon: 'trash',
      danger: true,
      run: async () => {
        if (!(await confirmDialog(`「${pl.name}」を削除しますか？（曲は残ります）`, '削除', true))) return;
        await db.del('playlists', pl.id);
        await loadLibrary();
        if (route().name === 'playlist' && route().key === pl.id) popNav();
        else render();
        toast('削除しました');
      },
    },
  ]);
}

/* ============================ 取り込み ============================ */
function fingerprint(name, size) {
  return `${name}|${size}`;
}

// webkitRelativePath からフォルダのフルパスを取り出す（個別選択やドライブ取り込みでは空文字）
// 例: "Music/邦楽/青の記録/01.mp3" → "Music/邦楽/青の記録"
function folderOfPath(relPath) {
  if (!relPath) return '';
  const parts = String(relPath).split('/');
  parts.pop(); // ファイル名を除く
  return parts.join('/');
}

const IMPORT_CONCURRENCY = 4; // 同時に処理するファイル数
const IMPORT_BATCH_SIZE = 15; // このトラック数ごとに1トランザクションでまとめて書く

/* ---- 取り込み中の通知 ----
   ページ自体がバックグラウンドで凍結されることがあるので、Service Worker の登録経由で出す
   （new Notification() は Android では使えない）。通知が使えない環境では黙って諦める。 */
const IMPORT_NOTIF_TAG = 'import-progress';
let lastImportNotifAt = 0;
const IMPORT_NOTIF_GAP = 1000; // 進捗通知の更新間隔（間引き）

function importNotifyEnabled() {
  return db.setting('importNotify', true);
}

// 許可も拒否もされていなければ尋ねる。取り込みはユーザー操作から始まるので呼んでよい。
// 拒否されている・API が無い場合は何もせず false を返す（呼び出し側はアプリ内の帯だけで進める）。
async function ensureNotifyPermission() {
  if (!importNotifyEnabled()) return false;
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try {
    return (await Notification.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

async function swRegistration() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    return (await navigator.serviceWorker.getRegistration()) || null;
  } catch {
    return null;
  }
}

async function showAppNotification(title, opts) {
  if (!importNotifyEnabled()) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const reg = await swRegistration();
  if (!reg) return;
  try {
    await reg.showNotification(title, opts);
  } catch (e) {
    console.warn('通知を表示できませんでした', e);
  }
}

// 進捗通知の更新は1秒に1回程度に間引く（毎曲更新すると重い）
function updateImportNotification(done, total) {
  const now = Date.now();
  if (now - lastImportNotifAt < IMPORT_NOTIF_GAP) return;
  lastImportNotifAt = now;
  showAppNotification('取り込み中', {
    tag: IMPORT_NOTIF_TAG,
    body: `${done} / ${total} 曲`,
    silent: true,
    renotify: false,
    requireInteraction: true,
  });
}

async function closeImportNotification() {
  const reg = await swRegistration();
  if (!reg) return;
  try {
    const list = await reg.getNotifications({ tag: IMPORT_NOTIF_TAG });
    list.forEach((n) => n.close());
  } catch {}
}

async function finishImportNotification(title, body) {
  await closeImportNotification();
  await showAppNotification(title, { body, requireInteraction: false, silent: false, renotify: false });
}

async function importFiles(files, source = 'local') {
  const list = [...files].filter((f) => f.type.startsWith('audio/') || /\.(mp3|m4a|aac|flac|wav|ogg|oga|opus|m4b)$/i.test(f.name));
  if (!list.length) {
    toast('音声ファイルが見つかりませんでした');
    return;
  }
  if (importRunning) {
    // 取り込み中に同じフォルダをもう一度取り込もうとした場合などのガード。二重に走らせない。
    toast('取り込み中です');
    return;
  }
  // ここで同期的に確定させる。この下のどこかで最初に await を挟むと、ほぼ同時に呼ばれた
  // 2つの呼び出しが両方とも上のガードを通り抜けてしまう（await の前まではどちらも同期的に進むため）。
  importRunning = true;
  try {
    if (!(await confirmEnoughSpace(list))) return;
    await importFilesInner(list, source);
  } finally {
    importRunning = false; // 正常終了時は hideImportBar() で既に false になっているが、例外時の保険として必ず解放する
  }
}

/* ============================ 被り曲の判定 ============================
   同じ曲が二重に入るのを防ぐ。判断材料は2つ。
   1. 曲名・アーティストが同じで、長さもほぼ同じ → 同じ曲とみなす（別ファイルでも弾ける）
   2. ファイルサイズが同じものがあるときだけ、中身の指紋（先頭と末尾のハッシュ）を比べる
      → ファイル名が違うだけの複製を弾ける。全体を読まないので軽い */

function metaKeyOf(t) {
  return norm(t.title) + '|' + norm(t.artist);
}

// 先頭と末尾の 64KB だけを読んで指紋を作る（ファイル全体は読まない）
async function contentSig(blob) {
  if (!crypto.subtle) return null;
  const n = Math.min(65536, blob.size);
  const head = new Uint8Array(await blob.slice(0, n).arrayBuffer());
  const tail = new Uint8Array(await blob.slice(Math.max(0, blob.size - n)).arrayBuffer());
  const buf = new Uint8Array(head.length + tail.length);
  buf.set(head, 0);
  buf.set(tail, head.length);
  const dig = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return blob.size + ':' + Array.from(dig.slice(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
}

// 既存の曲の指紋は、必要になったときだけ作って覚えておく（サイズが一致したときしか呼ばれない）。
// この取り込みで入れたばかりでまだ DB に書けていない曲は、手元の File から読む。
async function sigOfTrack(t, runFiles) {
  if (t.sig) return t.sig;
  try {
    const hint = runFiles && runFiles.get(t.id);
    const blob = hint || (await db.get('blobs', t.id));
    if (!blob) return null;
    t.sig = await contentSig(blob);
    if (t.sig && !hint) await db.put('tracks', t); // 既に保存済みの曲なら覚えさせておく
    return t.sig;
  } catch {
    return null;
  }
}

// 取り込み中に使う索引をまとめて作る
function buildDupIndex(tracks) {
  const byMeta = new Map(); // 「曲名|アーティスト」→ 長さの一覧
  const bySize = new Map(); // サイズ → その大きさの曲
  const sigs = new Set();
  for (const t of tracks) {
    const mk = metaKeyOf(t);
    if (!byMeta.has(mk)) byMeta.set(mk, []);
    byMeta.get(mk).push(t.duration || 0);
    if (t.size) {
      if (!bySize.has(t.size)) bySize.set(t.size, []);
      bySize.get(t.size).push(t);
    }
    if (t.sig) sigs.add(t.sig);
  }
  return { byMeta, bySize, sigs };
}

// 長さは端末やタグの違いで数秒ずれることがあるので、少し幅を持たせる
function sameSong(durations, d) {
  return durations.some((x) => Math.abs((x || 0) - (d || 0)) <= 2);
}

// 取り込みは SD の曲を端末内にコピーするので、ライブラリが大きいと保存上限に当たる。
// 始める前に数字を出して確かめてもらう（見積もれないときは黙って進める）。
async function confirmEnoughSpace(list) {
  const need = list.reduce((n, f) => n + (f.size || 0), 0);
  const est = await db.estimate();
  if (!est || !est.quota) return true;
  const free = est.quota - (est.usage || 0);
  if (need < free * 0.9) return true;
  return confirmDialog(
    `選んだ曲は ${fmtSize(need)} ですが、このアプリに残っている空きは ${fmtSize(free)} です。` +
      `途中で容量が尽きると、そこまでの曲だけが取り込まれます。このまま続けますか？`,
    '続ける'
  );
}

async function importFilesInner(list, source) {
  const startCount = state.tracks.length; // 実際に増えた曲数は、最後に数え直して求める
  const known = new Set(state.tracks.map((t) => t.fp));
  const dupSkip = db.setting('dupSkip', true); // 被り曲を自動で飛ばすか
  const dup = buildDupIndex(state.tracks);
  const runFiles = new Map(); // この取り込みで入れた曲の id → File（指紋を作るときの読み元）
  let dupped = 0;
  // ジャケットの既存キーは取り込み開始時に1回だけまとめて取得しておく（1曲ごとに db.has() を呼ばない）
  const existingArt = new Set(await db.getAllKeys('art'));
  let added = 0,
    skipped = 0,
    done = 0;
  let importFailure = null; // 書き込みに失敗したらここに入れて、以降のバッチを試さない
  const total = list.length;
  showImportBar(`取り込み中 0 / ${total}`);
  // 許可を尋ねるが、取り込み自体はそれを待たずに始める
  // （requestPermission() は環境によっては解決が遅れることがあり、取り込みを止めたくない）。
  let notifyOn = false;
  ensureNotifyPermission()
    .then((v) => (notifyOn = v))
    .catch(() => {});

  // 取り込み中、選択モードやダイアログでライブラリの再読み込みが見送られたままにならないよう、
  // 定期的にリトライする（実際の反映は queueLibraryRefresh 側の間引き・busy 判定に従う）
  const refreshRetryTimer = setInterval(tryFlushLibraryRefresh, 700);

  const pending = []; // まだ DB に書いていない { track, blob, art }
  let flushChain = Promise.resolve(); // まとめ書きは重ならないよう直列に鎖でつなぐ
  const flushBatch = (items) => {
    flushChain = flushChain
      .then(() => (importFailure ? null : db.addTracks(items)))
      .then(() => {
        if (importFailure) return;
        appendTracksToState(items.map((it) => it.track)); // 追加分だけ手元に足す（全件読み直しはしない）
        queueLibraryRefresh();
      })
      .catch((e) => {
        // 保存容量が尽きた場合など。黙って握りつぶすと「曲が欠けたのに成功に見える」ので、ここで止める
        importFailure = e;
        progCancelled = true;
        console.error('まとめ書き失敗', e);
      });
    return flushChain;
  };
  const maybeFlush = (force = false) => {
    if (!pending.length) return Promise.resolve();
    if (!force && pending.length < IMPORT_BATCH_SIZE) return Promise.resolve();
    const items = pending.splice(0, pending.length);
    return flushBatch(items);
  };

  let nextIndex = 0;
  const bump = (f) => {
    done++;
    setImportBar(done / total, `取り込み中 ${done} / ${total}`);
    if (notifyOn) updateImportNotification(done, total);
  };

  async function worker() {
    while (true) {
      if (progCancelled) return;
      const i = nextIndex++;
      if (i >= total) return;
      const f = list[i];
      const fp = f.driveId ? 'drive:' + f.driveId : fingerprint(f.name, f.size);
      if (known.has(fp)) {
        skipped++;
        bump(f);
        continue;
      }
      known.add(fp); // 同期的に確保するので、同時実行でも二重取り込みにならない
      try {
        const tags = await readTags(f);
        let duration = await readDurationFast(f);
        if (!duration) duration = await readDuration(f); // ヘッダから求まらなかったときだけ <audio> にフォールバック

        if (dupSkip) {
          // 1) 曲名・アーティスト・長さがほぼ同じなら、同じ曲とみなす
          const mk = norm(tags.title || f.name) + '|' + norm(tags.artist || '');
          const seen = dup.byMeta.get(mk);
          if (seen && sameSong(seen, duration)) {
            dupped++;
            bump(f);
            continue;
          }
          // 2) 同じサイズの曲があるときだけ、中身の指紋を比べる（無ければ読まない）
          const sameSize = dup.bySize.get(f.size);
          if (sameSize && sameSize.length) {
            const sig = await contentSig(f);
            if (sig) {
              let hit = dup.sigs.has(sig);
              if (!hit) {
                for (const other of sameSize) {
                  if ((await sigOfTrack(other, runFiles)) === sig) {
                    dup.sigs.add(sig);
                    hit = true;
                    break;
                  }
                }
              }
              if (hit) {
                dupped++;
                bump(f);
                continue;
              }
            }
          }
        }
        const id = uid();
        const folder = folderOfPath(f.webkitRelativePath || '');
        const track = {
          id,
          fp,
          title: tags.title || f.name,
          artist: tags.artist || '',
          album: tags.album || '',
          albumArtist: tags.albumArtist || '',
          trackNo: tags.trackNo || 0,
          year: tags.year || '',
          genre: tags.genre || '',
          duration,
          size: f.size,
          mime: f.type || '',
          fileName: f.name,
          folder,
          folderKey: norm(folder),
          source,
          driveId: f.driveId || null,
          addedAt: Date.now(),
          playCount: 0,
          lastPlayed: 0,
          favorite: false,
          artId: null,
        };
        track.albumKey = albumKeyOf(track);
        track.artistKey = norm(track.artist);
        track.artId = track.albumKey || 'track:' + id;
        if (dupSkip) {
          // 同じ取り込みの中でも二重に入らないよう、その場で索引に足す
          const mk = metaKeyOf(track);
          if (!dup.byMeta.has(mk)) dup.byMeta.set(mk, []);
          dup.byMeta.get(mk).push(track.duration || 0);
          if (!dup.bySize.has(track.size)) dup.bySize.set(track.size, []);
          dup.bySize.get(track.size).push(track);
          runFiles.set(track.id, f); // 同じサイズの曲が後から来たとき、ここから指紋を作る
        }
        let artBlob = null;
        if (tags.picture && !existingArt.has(track.artId)) {
          artBlob = tags.picture;
          existingArt.add(track.artId); // 同じ取り込み内で同アルバムの2曲目以降は重ねて書かない
        }
        // 元ファイルを消したり SD を抜いても再生できるよう、file.slice() で参照を確定させて保存する
        // （実験で確認済み: File/Blob は IndexedDB に入れた時点で内容が保存され、元ファイル削除後も読み出せる。
        //   arrayBuffer() でファイル全体を JS メモリにコピーする必要はない）
        const stored = f.slice(0, f.size, f.type || 'audio/mpeg');
        pending.push({ track, blob: stored, art: artBlob });
        added++;
        await maybeFlush(false);
      } catch (e) {
        console.error('取り込み失敗', f.name, e);
      }
      bump(f);
    }
  }

  const workers = Array.from({ length: Math.min(IMPORT_CONCURRENCY, total) }, () => worker());
  await Promise.all(workers);
  await maybeFlush(true);
  await flushChain;
  clearInterval(refreshRetryTimer);

  hideImportBar();
  await loadLibrary(); // 取り込みが終わったところで一度だけ整合を取る
  render();
  added = Math.max(0, state.tracks.length - startCount); // 書けなかった分を含めない実数

  const failed = !!importFailure;
  const quotaFull = failed && /quota|storage/i.test(`${importFailure.name || ''} ${importFailure.message || ''}`);
  const cancelled = progCancelled && !failed;
  let summary;
  if (quotaFull) summary = `端末の空き容量が足りず中断しました（${added}曲を追加）`;
  else if (failed) summary = `保存に失敗して中断しました（${added}曲を追加）`;
  else if (cancelled) summary = `中止しました（${added}曲を追加）`;
  else {
    const notes = [];
    if (skipped) notes.push(`${skipped}曲は取り込み済み`);
    if (dupped) notes.push(`${dupped}曲は同じ曲のため飛ばしました`);
    summary = `${added}曲を追加${notes.length ? `（${notes.join('・')}）` : ''}`;
  }

  toast(failed || cancelled ? `${summary}。同じフォルダを選び直すと、残りだけが追加されます` : summary, 6000);
  finishImportNotification(failed ? '取り込みを中断しました' : cancelled ? '取り込みを中止しました' : '取り込み完了', summary);

  // 取り込み直後の自動ジャケット取得は、対象が多いと延々と続いて「終わらない」ように見えるので控える
  if (added && !failed && db.setting('autoArt', true)) fetchMissingArt(true, 40);
}

/* ---- ジャケットをネットから探す ---- */
async function fetchMissingArt(silent = false, maxTargets = 0) {
  if (!navigator.onLine) {
    if (!silent) toast('オフラインです');
    return;
  }
  // 既存のジャケットは1回だけまとめて取得する（アルバムごとに db.has() を呼ぶと数百枚で重くなる）
  const haveArt = new Set(await db.getAllKeys('art'));
  const targets = groupAlbums().filter((g) => g.album && g.album !== '不明なアルバム' && !(g.artId && haveArt.has(g.artId)));
  if (!targets.length) {
    if (!silent) toast('不足しているジャケットはありません');
    return;
  }
  // 自動実行で対象が多すぎるときは走らせない。1枚ずつネットに問い合わせるので、
  // 数百枚あると延々と続き「終わらない」ように見えてしまう。
  if (maxTargets && targets.length > maxTargets) {
    toast(`ジャケット未設定が${targets.length}枚あります。設定から「まとめて取得」で取り込めます`, 6000);
    return;
  }
  // 自動実行のときは画面を塞がず、裏でゆっくり探す
  if (silent) toast(`ジャケットを探しています（${targets.length}件）`);
  else showProgress('ジャケットを探しています…');
  let got = 0;
  for (let i = 0; i < targets.length; i++) {
    if (!silent && progCancelled) break;
    const g = targets[i];
    if (!silent) setProgress(i / targets.length, `${i + 1} / ${targets.length}\n${g.album}`);
    try {
      const blob = await art.autoFind(g.album, g.artist);
      if (blob) {
        await db.put('art', blob, g.key);
        dropArtUrl(g.key);
        for (const t of g.tracks) {
          if (t.artId !== g.key) {
            t.artId = g.key;
            await db.put('tracks', t);
          }
        }
        got++;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!silent) hideProgress();
  await loadLibrary();
  render();
  if (got) toast(`${got}件のジャケットを設定しました`);
  else if (!silent) toast('ジャケットは見つかりませんでした');
}

async function findArtDialog(albumKey) {
  const g = groupAlbums().find((x) => x.key === albumKey);
  if (!g) return;
  const run = async (term) => {
    openDialog(`<h3>ジャケットを探す</h3><div class="pad muted">検索中…</div>`);
    let results = [];
    try {
      results = await art.search(term);
    } catch (e) {
      closeDialog();
      toast(e.message || '検索できませんでした');
      return;
    }
    const html =
      `<h3>ジャケットを選ぶ</h3>
       <div class="pad"><input id="at" type="text" value="${esc(term)}"></div>
       <div class="actions"><button class="btn" id="ar">この言葉で再検索</button></div>` +
      (results.length
        ? `<div class="art-grid">${results
            .map((r, i) => `<button data-i="${i}"><img src="${esc(r.thumb)}" alt=""><div class="cap">${esc(r.album)}<br>${esc(r.artist)}</div></button>`)
            .join('')}</div>`
        : `<div class="pad muted">見つかりませんでした</div>`) +
      `<div class="actions"><button class="btn ghost full" id="ax">閉じる</button></div>`;
    closeDialog();
    setTimeout(() => {
      openDialog(html, (root) => {
        $('#ax', root).onclick = closeDialog;
        $('#ar', root).onclick = () => {
          const v = $('#at', root).value.trim();
          closeDialog();
          setTimeout(() => run(v), 80);
        };
        root.querySelectorAll('.art-grid button').forEach((b) =>
          b.addEventListener('click', async () => {
            const r = results[+b.dataset.i];
            closeDialog();
            try {
              toast('取得中…');
              const blob = await art.fetchImage(r.url);
              await db.put('art', blob, g.key);
              dropArtUrl(g.key);
              for (const t of g.tracks) {
                t.artId = g.key;
                await db.put('tracks', t);
              }
              await loadLibrary();
              render();
              const cur = currentTrack();
              if (cur && g.tracks.some((t) => t.id === cur.id)) updateNowUI(state.byId.get(cur.id));
              toast('ジャケットを設定しました');
            } catch (e) {
              toast(e.message || '画像を取得できませんでした');
            }
          })
        );
      });
    }, 60);
  };
  run(`${g.artist} ${g.album}`.trim());
}

/* ============================ Google ドライブ ============================ */
const driveState = { path: [], items: [], busy: false };

function openDriveSheet() {
  openSheet('sheetDrive');
  renderDrive();
}

function renderDrive() {
  const body = $('#driveBody');
  const clientId = db.setting('driveClientId', '');
  if (!drive.hasToken()) {
    body.innerHTML = `
      <div class="sec">Google ドライブに接続</div>
      <div class="field">
        <div class="s muted" style="font-size:12px;line-height:1.8;margin-bottom:8px">
          自分の Google Cloud で作った OAuth クライアントID（ウェブアプリ）を貼り付けてください。<br>
          手順は README.md に書いてあります。
        </div>
        <input id="cid" type="text" placeholder="xxxxxxx.apps.googleusercontent.com" value="${esc(clientId)}">
      </div>
      <div class="field"><button class="btn primary full" id="connect">接続する</button></div>
      <div class="sec">ヒント</div>
      <div class="item"><div class="txt"><div class="s">曲はダウンロードして端末に保存されます。取り込んだあとはオフラインでも再生できます。</div></div></div>`;
    $('#connect').onclick = async () => {
      const id = $('#cid').value.trim();
      if (!id) return toast('クライアントIDを入力してください');
      await db.setSetting('driveClientId', id);
      try {
        toast('Google の画面を開きます…');
        await drive.authorize(id);
        driveState.path = [{ id: 'root', name: 'マイドライブ' }];
        await loadDriveFolder();
      } catch (e) {
        toast(e.message || '接続できませんでした');
      }
    };
    return;
  }
  const crumbs = driveState.path.map((p, i) => `<span data-crumb="${i}" style="color:${i === driveState.path.length - 1 ? 'var(--tx)' : 'var(--acc)'}">${esc(p.name)}</span>`).join('<span class="muted"> / </span>');
  const folders = driveState.items.filter((f) => f.mimeType === 'application/vnd.google-apps.folder');
  const audios = driveState.items.filter((f) => drive.isAudio(f));
  body.innerHTML = `
    <div class="sec" id="crumbs" style="line-height:1.9">${crumbs}</div>
    <div class="detail-actions">
      <button class="btn primary" id="importFolder">このフォルダを取り込む</button>
      <button class="btn" id="signout">切断</button>
    </div>
    ${folders.map((f) => `<div class="item" data-folder="${esc(f.id)}" data-name="${esc(f.name)}"><svg style="color:var(--sub)"><use href="#i-folder"/></svg><div class="txt"><div class="t">${esc(f.name)}</div></div></div>`).join('')}
    ${audios.map((f) => `<div class="item" data-file="${esc(f.id)}" data-name="${esc(f.name)}"><svg style="color:var(--sub)"><use href="#i-note"/></svg><div class="txt"><div class="t">${esc(f.name)}</div><div class="s">${f.size ? fmtSize(+f.size) : ''}</div></div></div>`).join('')}
    ${!folders.length && !audios.length ? emptyState('このフォルダには音声ファイルがありません') : ''}`;

  body.querySelectorAll('[data-crumb]').forEach((n) =>
    n.addEventListener('click', () => {
      driveState.path = driveState.path.slice(0, +n.dataset.crumb + 1);
      loadDriveFolder();
    })
  );
  body.querySelectorAll('[data-folder]').forEach((n) =>
    n.addEventListener('click', () => {
      driveState.path.push({ id: n.dataset.folder, name: n.dataset.name });
      loadDriveFolder();
    })
  );
  body.querySelectorAll('[data-file]').forEach((n) =>
    n.addEventListener('click', async () => {
      const f = driveState.items.find((x) => x.id === n.dataset.file);
      await importFromDrive([f]);
    })
  );
  $('#signout').onclick = () => {
    drive.signOut();
    driveState.items = [];
    renderDrive();
  };
  $('#importFolder').onclick = async () => {
    const cur = driveState.path[driveState.path.length - 1];
    showProgress('フォルダの中を調べています…');
    try {
      const files = await drive.collectAudio(cur.id, (n) => setProgress(0, `${n} 曲みつかりました…`));
      hideProgress();
      if (!files.length) return toast('音声ファイルがありませんでした');
      if (await confirmDialog(`${files.length}曲を取り込みますか？`, '取り込む')) await importFromDrive(files);
    } catch (e) {
      hideProgress();
      toast(e.message || '読み取れませんでした');
    }
  };
}

async function loadDriveFolder() {
  const cur = driveState.path[driveState.path.length - 1];
  $('#driveTitle').textContent = cur.name;
  showProgress('読み込み中…');
  try {
    driveState.items = await drive.listChildren(cur.id);
  } catch (e) {
    toast(e.message || '読み取れませんでした');
    driveState.items = [];
  }
  hideProgress();
  renderDrive();
}

async function importFromDrive(files) {
  const known = new Set(state.tracks.map((t) => t.fp));
  const todo = files.filter((f) => !known.has('drive:' + f.id));
  if (!todo.length) {
    toast('すべて取り込み済みです');
    return;
  }
  showProgress('ダウンロード中…');
  const blobs = [];
  for (let i = 0; i < todo.length; i++) {
    if (progCancelled) break;
    const f = todo[i];
    setProgress(i / todo.length, `${i + 1} / ${todo.length}\n${f.name}`);
    try {
      const blob = await drive.download(f.id);
      const file = new File([blob], f.name, { type: blob.type || f.mimeType || 'audio/mpeg' });
      file.driveId = f.id;
      blobs.push(file);
    } catch (e) {
      console.error('ダウンロード失敗', f.name, e);
    }
  }
  hideProgress();
  if (blobs.length) await importFiles(blobs, 'drive');
}

/* ============================ 設定画面 ============================ */
async function renderSettings() {
  const body = $('#settingsBody');
  const est = await db.estimate();
  const used = est ? fmtSize(est.usage || 0) : '—';
  const quota = est && est.quota ? fmtSize(est.quota) : '—';
  const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false;
  const unplug = db.setting('unplug', 'pause');
  const dupSkip = db.setting('dupSkip', true);
  const autoArt = db.setting('autoArt', true);
  const importNotify = db.setting('importNotify', true);
  const totalSize = state.tracks.reduce((s, t) => s + (t.size || 0), 0);

  const installed = isStandalone();
  const installSub = installed
    ? 'ホーム画面のアイコンから起動しています'
    : installPrompt
    ? 'タップするとホーム画面に追加できます'
    : '追加のしかたを表示します';

  body.innerHTML = `
    <div class="sec">アプリとして使う</div>
    <div class="item" data-act="install"><svg style="color:${installed ? 'var(--acc)' : 'var(--sub)'}"><use href="#i-install"/></svg>
      <div class="txt"><div class="t">${installed ? 'インストール済み' : 'ホーム画面に追加'}</div><div class="s">${installSub}</div></div></div>

    <div class="sec">曲を取り込む</div>
    <div class="item" data-act="pickFiles"><svg style="color:var(--sub)"><use href="#i-note"/></svg>
      <div class="txt"><div class="t">端末・microSD から選ぶ</div><div class="s">ファイルを選んでアプリ内に保存します</div></div></div>
    <div class="item" data-act="pickDir"><svg style="color:var(--sub)"><use href="#i-folder"/></svg>
      <div class="txt"><div class="t">フォルダごと取り込む</div><div class="s">端末によっては使えないことがあります</div></div></div>
    <div class="item" data-act="drive"><svg style="color:var(--sub)"><use href="#i-cloud"/></svg>
      <div class="txt"><div class="t">Google ドライブから取り込む</div><div class="s">初回だけクライアントIDの設定が必要です</div></div></div>
    <div class="item" data-act="toggleImportNotify"><div class="txt"><div class="t">取り込みの進捗を通知に出す</div><div class="s">ホーム画面に追加していると、通知欄でも進み具合を確認できます</div></div>
      <div class="switch ${importNotify ? 'on' : ''}"></div></div>
    <div class="item" data-act="toggleDupSkip"><div class="txt"><div class="t">同じ曲は取り込まない</div><div class="s">曲名・アーティスト・長さが同じもの、中身が同じファイルを飛ばします</div></div>
      <div class="switch ${dupSkip ? 'on' : ''}"></div></div>
    <div class="item" data-act="findDups"><svg style="color:var(--sub)"><use href="#i-trash"/></svg>
      <div class="txt"><div class="t">重複した曲を探す</div><div class="s">すでに入っている被りを見つけて、1曲だけ残して片づけます</div></div></div>

    <div class="sec">ジャケット</div>
    <div class="item" data-act="toggleArt"><div class="txt"><div class="t">取り込んだら自動で探す</div><div class="s">タグに画像がない曲だけ、ネットから検索します</div></div>
      <div class="switch ${autoArt ? 'on' : ''}"></div></div>
    <div class="item" data-act="fetchArt"><div class="txt"><div class="t">足りないジャケットをまとめて取得</div></div><svg style="color:var(--sub)"><use href="#i-img"/></svg></div>

    <div class="sec">再生</div>
    <div class="item"><div class="txt"><div class="t">イヤホンが外れたとき</div><div class="s">端末が自動で止める場合もあります</div></div>
      <select data-act="unplug">
        <option value="pause" ${unplug === 'pause' ? 'selected' : ''}>停止する</option>
        <option value="mute" ${unplug === 'mute' ? 'selected' : ''}>消音する</option>
        <option value="off" ${unplug === 'off' ? 'selected' : ''}>何もしない</option>
      </select></div>
    <div class="item" data-act="eq"><div class="txt"><div class="t">イコライザ</div><div class="s">${P.eqEnabled() ? 'オン' : 'オフ'}</div></div><svg style="color:var(--sub)"><use href="#i-eq"/></svg></div>

    <div class="sec">保存</div>
    <div class="item"><div class="txt"><div class="t">曲のデータ</div><div class="s">${state.tracks.length}曲 / ${fmtSize(totalSize)}</div></div></div>
    <div class="item"><div class="txt"><div class="t">アプリの使用容量</div><div class="s">${used} / 上限のめやす ${quota}</div></div></div>
    <div class="item" data-act="persist"><div class="txt"><div class="t">保存を固定する</div><div class="s">${persisted ? '有効（端末の空き不足でも消されにくい）' : '無効（タップして有効化）'}</div></div></div>
    <div class="item" data-act="wipe"><div class="txt"><div class="t" style="color:var(--danger)">ライブラリを全部消す</div><div class="s">曲・ジャケット・プレイリストをすべて削除します</div></div></div>

    <div class="sec">このアプリ</div>
    <div class="item"><div class="txt"><div class="t">バージョン</div><div class="s">${APP_VERSION}${navigator.onLine ? '' : ' · オフライン'}</div></div></div>`;

  body.querySelectorAll('[data-act]').forEach((n) => {
    const act = n.dataset.act;
    if (act === 'unplug') {
      n.onchange = () => db.setSetting('unplug', n.value);
      return;
    }
    n.onclick = async () => {
      if (act === 'install') await installFlow();
      else if (act === 'pickFiles') $('#filePick').click();
      else if (act === 'pickDir') $('#dirPick').click();
      else if (act === 'drive') openDriveSheet();
      else if (act === 'toggleArt') {
        await db.setSetting('autoArt', !db.setting('autoArt', true));
        renderSettings();
      } else if (act === 'toggleImportNotify') {
        await db.setSetting('importNotify', !db.setting('importNotify', true));
        renderSettings();
      } else if (act === 'toggleDupSkip') {
        await db.setSetting('dupSkip', !db.setting('dupSkip', true));
        renderSettings();
      } else if (act === 'findDups') await findDuplicatesDialog();
      else if (act === 'fetchArt') await fetchMissingArt();
      else if (act === 'eq') openEq();
      else if (act === 'persist') {
        const ok = await db.persist();
        toast(ok ? '保存を固定しました' : '端末が対応していないか、拒否されました');
        renderSettings();
      } else if (act === 'wipe') {
        if (!(await confirmDialog('本当にすべて削除しますか？この操作は戻せません。', '全部消す', true))) return;
        audio.pause();
        await db.clear('tracks');
        await db.clear('blobs');
        await db.clear('art');
        await db.clear('playlists');
        artUrls.forEach((u) => u && URL.revokeObjectURL(u));
        artUrls.clear();
        state.queue = [];
        state.base = [];
        state.qi = -1;
        $('#mini').hidden = true;
        await db.setSetting('lastPlayback', null);
        await loadLibrary();
        render();
        renderSettings();
        toast('削除しました');
      }
    };
  });
}

async function installFlow() {
  if (isStandalone()) {
    toast('すでにホーム画面のアイコンから起動しています');
    return;
  }
  if (installPrompt) {
    const p = installPrompt;
    installPrompt = null;
    try {
      p.prompt();
      const { outcome } = await p.userChoice;
      if (outcome !== 'accepted') {
        installPrompt = p; // 断られたらまた出せるように戻す
        toast('追加をやめました');
      }
    } catch {
      installPrompt = p;
    }
    renderSettings();
    return;
  }

  // イベントが来ない環境（iPhone や、アプリ内ブラウザなど）向けの案内
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const inApp = /(FBAN|FBAV|Instagram|Line\/|Twitter|MicroMessenger)/i.test(ua);
  const swOk = !!navigator.serviceWorker.controller;

  const steps = ios
    ? `<b>Safari</b> でこのページを開き<br>
       1. 下（または上）の <b>共有ボタン</b>（□に↑）をタップ<br>
       2. メニューを下にたどって <b>「ホーム画面に追加」</b><br>
       3. 追加されたアイコンから起動する<br><br>
       ※ Chrome アプリではなく Safari で開く必要があります。`
    : `<b>Chrome</b> でこのページを開き<br>
       1. 右上の <b>⋮</b>（メニュー）をタップ<br>
       2. <b>「アプリをインストール」</b> または <b>「ホーム画面に追加」</b><br>
       3. 追加されたアイコンから起動する`;

  const warn = inApp
    ? `<div style="color:var(--acc);margin-bottom:10px">いまアプリ内ブラウザで開いています。メニューから「ブラウザで開く」を選んでから、もう一度お試しください。</div>`
    : !swOk
    ? `<div style="color:var(--acc);margin-bottom:10px">オフライン用の準備がまだ終わっていません。ページを一度再読み込みしてから、もう一度お試しください。</div>`
    : '';

  const diag = await installDiagnostics();

  openDialog(
    `<h3>ホーム画面に追加する</h3>
     <div class="pad" style="font-size:13px;line-height:1.9">
       ${warn}${steps}
     </div>
     <div class="pad">
       <button class="btn full" id="indiag">うまくいかないときの状態を見る</button>
     </div>
     <div class="pad" id="indiagbody" hidden style="font-size:11.5px;line-height:1.8">
       ${diag
         .map(([k, v]) => `<div style="display:flex;gap:8px"><span class="muted" style="width:8.5em;flex:none">${esc(k)}</span><span style="word-break:break-all">${esc(v)}</span></div>`)
         .join('')}
     </div>
     <div class="actions"><button class="btn full" id="insc">閉じる</button></div>`,
    (root) => {
      $('#insc', root).onclick = closeDialog;
      $('#indiag', root).onclick = () => {
        const b = $('#indiagbody', root);
        b.hidden = !b.hidden;
      };
    }
  );
}

// インストールできないときに、どこで引っかかっているかを見るための情報
async function installDiagnostics() {
  const ua = navigator.userAgent;
  const rows = [];
  rows.push(['表示モード', isStandalone() ? 'アプリとして起動中' : 'ブラウザのタブ']);

  let reg = null;
  try {
    reg = await navigator.serviceWorker.getRegistration();
  } catch {}
  rows.push([
    'オフライン準備',
    navigator.serviceWorker.controller ? '完了（このページを制御中）' : reg ? '登録済み・未制御（再読み込みで有効）' : '未登録',
  ]);

  try {
    const r = await fetch('manifest.json', { cache: 'no-store' });
    if (r.ok) {
      const m = await r.json();
      const icons = m.icons || [];
      const big = icons.filter((i) => String(i.type || '').includes('png') && parseInt(i.sizes, 10) >= 192);
      rows.push(['manifest', '読み込みOK']);
      rows.push(['アイコン', `${icons.length}件 / 192px以上のPNG ${big.length}件`]);
    } else {
      rows.push(['manifest', 'エラー ' + r.status]);
    }
  } catch {
    rows.push(['manifest', '取得できません']);
  }

  rows.push(['インストール要求', installPrompt ? '受け取り済み' : 'まだ来ていない']);
  const inApp = /(FBAN|FBAV|Instagram|Line\/|Twitter|MicroMessenger)/i.test(ua);
  rows.push(['ブラウザ', inApp ? 'アプリ内ブラウザ' : /CriOS/.test(ua) ? 'iOS版Chrome' : /Chrome\//.test(ua) ? 'Chrome系' : 'その他']);
  rows.push(['アプリ版', APP_VERSION]);
  rows.push(['UA', ua]);
  return rows;
}

// すでに取り込んである曲の中から被りを探して片づける。
// 残すのは「お気に入り > ファイルが大きい（音質が良いことが多い） > 先に入れた」の順。
async function findDuplicatesDialog() {
  const groups = new Map();
  for (const t of state.tracks) {
    const mk = metaKeyOf(t);
    if (!groups.has(mk)) groups.set(mk, []);
    groups.get(mk).push(t);
  }
  const dupSets = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    // 長さが近いものだけを1組とみなす
    const rest = list.slice().sort((a, b) => (a.duration || 0) - (b.duration || 0));
    let cur = [rest[0]];
    for (let i = 1; i < rest.length; i++) {
      if (Math.abs((rest[i].duration || 0) - (cur[cur.length - 1].duration || 0)) <= 2) cur.push(rest[i]);
      else {
        if (cur.length > 1) dupSets.push(cur);
        cur = [rest[i]];
      }
    }
    if (cur.length > 1) dupSets.push(cur);
  }

  if (!dupSets.length) {
    toast('重複した曲は見つかりませんでした');
    return;
  }
  const extra = dupSets.reduce((n, g) => n + g.length - 1, 0);
  const sample = dupSets
    .slice(0, 8)
    .map((g) => `<div style="display:flex;gap:8px"><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(g[0].title)}</span><span class="muted">${g.length}件</span></div>`)
    .join('');

  openDialog(
    `<h3>重複した曲</h3>
     <div class="pad" style="font-size:13px;line-height:1.9">
       ${dupSets.length}組・あわせて${extra}曲が余分に入っています。<br>
       <span class="muted" style="font-size:11.5px">各組で1曲だけ残します。お気に入り、次にファイルが大きいものを優先して残します。プレイリストからも取り除かれます。</span>
       <div style="margin-top:10px;font-size:12px">${sample}${dupSets.length > 8 ? '<div class="muted">…ほか</div>' : ''}</div>
     </div>
     <div class="actions"><button class="btn ghost" id="dupNo">閉じる</button><button class="btn danger" id="dupGo">${extra}曲を削除</button></div>`,
    (root) => {
      $('#dupNo', root).onclick = closeDialog;
      $('#dupGo', root).onclick = async () => {
        closeDialog();
        const remove = [];
        for (const g of dupSets) {
          const sorted = g.slice().sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0) || (b.size || 0) - (a.size || 0) || (a.addedAt || 0) - (b.addedAt || 0));
          remove.push(...sorted.slice(1).map((t) => t.id));
        }
        await db.deleteTracks(remove);
        const set = new Set(remove);
        if (set.has(state.queue[state.qi])) stopPlayback();
        state.queue = state.queue.filter((x) => !set.has(x));
        state.base = state.base.filter((x) => !set.has(x));
        for (const pl of state.playlists) {
          const before = pl.trackIds.length;
          pl.trackIds = pl.trackIds.filter((x) => !set.has(x));
          if (pl.trackIds.length !== before) await db.put('playlists', pl);
        }
        await loadLibrary();
        render();
        renderSettings();
        toast(`${remove.length}曲の重複を削除しました`);
      };
    }
  );
}

/* ============================ イコライザ ============================ */
let eqPreset = '—';

function openEq() {
  openSheet('sheetEq');
  renderEq();
}

function renderEq() {
  const body = $('#eqBody');
  const on = P.eqEnabled();
  const gains = P.getEqGains();
  body.innerHTML = `
    <div class="item" data-act="toggle"><div class="txt"><div class="t">イコライザ</div><div class="s">オフのほうが安定して鳴ります</div></div>
      <div class="switch ${on ? 'on' : ''}"></div></div>
    <div class="item"><div class="txt"><div class="t">プリセット</div></div>
      <select id="preset">${['—', ...Object.keys(P.EQ_PRESETS)].map((k) => `<option${k === eqPreset ? ' selected' : ''}>${k}</option>`).join('')}</select></div>
    <div class="eq-wrap" style="${on ? '' : 'opacity:.4;pointer-events:none'}">
      ${P.EQ_BANDS.map(
        (hz, i) => `<div class="eq-band">
          <div class="v" id="v${i}">${gains[i] > 0 ? '+' : ''}${gains[i]}</div>
          <input type="range" min="-12" max="12" step="1" value="${gains[i]}" data-band="${i}">
          <div class="hz">${hz >= 1000 ? hz / 1000 + 'k' : hz}Hz</div>
        </div>`
      ).join('')}
    </div>
    <div class="field"><button class="btn full" id="eqReset">フラットに戻す</button></div>
    <div class="sec">再生速度</div>
    <div class="item"><div class="txt"><div class="t">速度</div><div class="s" id="rateLabel">${audio.playbackRate.toFixed(2)}x</div></div></div>
    <div class="field"><input id="rate" type="range" min="50" max="200" step="5" value="${Math.round(audio.playbackRate * 100)}"></div>`;

  body.querySelector('[data-act="toggle"]').onclick = async () => {
    P.setEqEnabled(!P.eqEnabled());
    await db.setSetting('eqOn', P.eqEnabled());
    syncControls();
    renderEq();
  };
  body.querySelectorAll('input[data-band]').forEach((s) => {
    s.oninput = () => {
      const i = +s.dataset.band;
      const v = +s.value;
      $('#v' + i, body).textContent = (v > 0 ? '+' : '') + v;
      P.setEqGain(i, v);
      if (eqPreset !== '—') {
        eqPreset = '—';
        $('#preset', body).value = '—';
      }
    };
  });
  $('#preset', body).onchange = (e) => {
    const p = P.EQ_PRESETS[e.target.value];
    if (!p) return;
    eqPreset = e.target.value;
    P.setEqGains(p);
    renderEq();
  };
  $('#eqReset', body).onclick = () => {
    eqPreset = 'フラット';
    P.setEqGains([0, 0, 0, 0, 0]);
    renderEq();
  };
  $('#rate', body).oninput = (e) => {
    const r = +e.target.value / 100;
    P.setRate(r);
    $('#rateLabel', body).textContent = r.toFixed(2) + 'x';
    db.setSetting('rate', r);
    syncControls();
  };
}

/* ============================ イベント配線 ============================ */
function wire() {
  // タブ
  $('#tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    const go = () => {
      state.routes = [{ name: b.dataset.tab }];
      render();
    };
    if (state.selectMode) {
      exitSelectMode();
      setTimeout(go, 0); // 選択解除（popNav の非同期な後始末）を待ってから切り替える
    } else go();
  });

  $('#btnBack').onclick = () => popNav();
  $('#btnSettings').onclick = () => {
    openSheet('sheetSettings');
    renderSettings();
  };
  $('#btnSearch').onclick = () => {
    state.searchOpen = !state.searchOpen;
    if (!state.searchOpen) {
      $('#q').value = '';
      state.query = '';
    }
    render();
    if (state.searchOpen) $('#q').focus();
  };
  let qTimer;
  $('#q').addEventListener('input', (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      state.query = e.target.value;
      render();
    }, 180);
  });

  // 曲行の長押しで複数選択モードに入る（タッチ・マウス両対応）
  const lp = { timer: 0, id: null, moved: false, x: 0, y: 0, suppressClick: false };
  const cancelLongPress = () => { clearTimeout(lp.timer); lp.timer = 0; };
  view.addEventListener('pointerdown', (e) => {
    const row = e.target.closest('.row[data-id]');
    if (!row) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    lp.id = row.dataset.id;
    lp.moved = false;
    lp.x = e.clientX;
    lp.y = e.clientY;
    cancelLongPress();
    lp.timer = setTimeout(() => {
      lp.timer = 0;
      if (lp.moved) return;
      lp.suppressClick = true;
      if (state.selectMode) toggleSelect(lp.id);
      else enterSelectMode(lp.id);
    }, 500);
  });
  view.addEventListener('pointermove', (e) => {
    if (!lp.timer) return;
    if (Math.abs(e.clientX - lp.x) > 8 || Math.abs(e.clientY - lp.y) > 8) cancelLongPress();
  });
  view.addEventListener('pointerup', cancelLongPress);
  view.addEventListener('pointercancel', cancelLongPress);
  view.addEventListener('pointerleave', cancelLongPress, true);

  // 複数選択モードの上部バー・下部アクションバー
  $('#btnSelClose').onclick = () => exitSelectMode();
  $('#btnSelAll').onclick = () => {
    const { tracks } = currentListTracks();
    state.selected = new Set(tracks.map((t) => t.id));
    syncSelectUI();
  };
  $('#selectBar').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const ids = [...state.selected];
    if (!ids.length) return;
    const act = b.dataset.act;
    if (act === 'selAlbum') chooseAlbumDialog(ids);
    else if (act === 'selArtist') renameArtistDialog(ids);
    else if (act === 'selPlaylist') addToPlaylistDialog(ids);
    else if (act === 'selDelete') {
      deleteTracks(ids, `${ids.length}曲`).then(() => {
        state.selected = new Set([...state.selected].filter((id) => state.byId.has(id)));
        if (state.selected.size === 0) exitSelectMode();
        else syncSelectUI();
      });
    }
  });

  // 一覧のタップ
  view.addEventListener('click', (e) => {
    const n = e.target.closest('[data-act]');
    if (!n) return;
    const act = n.dataset.act;
    if (act === 'play') {
      if (lp.suppressClick) { lp.suppressClick = false; return; } // 長押しで選択モードに入った直後のクリックは無視
      if (state.selectMode) { toggleSelect(n.dataset.id); return; }
      const { tracks, label } = currentListTracks();
      const i = tracks.findIndex((t) => t.id === n.dataset.id);
      playContext(tracks, i < 0 ? 0 : i, label);
    } else if (act === 'menu') trackMenu(n.dataset.id);
    else if (act === 'album') pushRoute({ name: 'album', key: n.dataset.key });
    else if (act === 'artist') pushRoute({ name: 'artist', key: n.dataset.key });
    else if (act === 'folder') pushRoute({ name: 'folder', key: n.dataset.key });
    else if (act === 'playlist') pushRoute({ name: 'playlist', key: n.dataset.key });
    else if (act === 'plmenu') playlistMenu(n.dataset.key);
    else if (act === 'newpl') newPlaylist();
    else if (act === 'findart') findArtDialog(n.dataset.key);
    else if (act === 'albummenu') albumMenu(n.dataset.key);
    else if (act === 'folderAlbum') folderToAlbum(n.dataset.key);
    else if (act === 'playall') {
      const { tracks, label } = currentListTracks();
      playContext(tracks, 0, label);
    } else if (act === 'shuffleall') {
      const { tracks, label } = currentListTracks();
      if (!tracks.length) return;
      if (!state.shuffle) toggleShuffle();
      playList(shuffled(tracks.map((t) => t.id)), 0, label);
    }
  });

  // ミニプレーヤー
  $('#mini').addEventListener('click', (e) => {
    if (e.target.closest('#miniPlay')) return togglePlay();
    if (e.target.closest('#miniNext')) return next();
    if (e.target.closest('#miniStop')) return stopPlayback();
    openSheet('sheetNow');
  });

  // 再生中画面
  $('#btnPlay').onclick = () => togglePlay();
  $('#btnNext').onclick = () => next();
  $('#btnPrev').onclick = () => prev();
  $('#btnShuffle').onclick = toggleShuffle;
  $('#btnRepeat').onclick = cycleRepeat;
  $('#nowQueue').onclick = showQueue;
  $('#nowStop').onclick = stopPlayback;
  document.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => popNav()));
  $('#dialogWrap').querySelector('.backdrop').onclick = () => closeDialog();

  const seek = $('#seek');
  seek.addEventListener('input', () => {
    seeking = true;
    const d = audio.duration || 0;
    $('#curTime').textContent = fmtTime((seek.value / 1000) * d);
  });
  seek.addEventListener('change', () => {
    const d = audio.duration || 0;
    if (d) audio.currentTime = (seek.value / 1000) * d;
    seeking = false;
  });

  $('#tSpeed').onclick = speedDialog;
  $('#tEq').onclick = openEq;
  $('#tFav').onclick = () => {
    const t = currentTrack();
    if (t) toggleFav(t);
  };
  $('#tAdd').onclick = () => {
    const t = currentTrack();
    if (t) addToPlaylistDialog([t.id]);
  };
  $('#tTimer').onclick = timerDialog;
  $('#tVol').onclick = () => {
    const w = $('#volWrap');
    w.hidden = !w.hidden;
  };
  $('#vol').addEventListener('input', (e) => {
    P.setVolume(e.target.value / 100);
    db.setSetting('volume', e.target.value / 100);
  });

  // ファイル選択
  $('#filePick').addEventListener('change', (e) => {
    importFiles(e.target.files);
    e.target.value = '';
  });
  $('#dirPick').addEventListener('change', (e) => {
    importFiles(e.target.files);
    e.target.value = '';
  });
  $('#progCancel').onclick = () => {
    progCancelled = true;
    toast('中止しています…');
  };
  $('#importCancel').onclick = () => {
    progCancelled = true;
    toast('中止しています…');
  };

  // audio のイベント
  audio.addEventListener('play', () => {
    syncControls();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  });
  audio.addEventListener('pause', () => {
    syncControls();
    savePlayback();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
    scheduleUpdateCheck();
  });
  audio.addEventListener('ended', () => {
    // 「この曲の終わりで停止」は、1曲リピートより先に見る。
    // 後ろに置くと、リピート中は曲が終わっても判定に到達せずタイマーが効かない。
    if (P.consumeTrackEndSleep()) {
      audio.pause();
      toast('スリープタイマーで停止しました');
      return;
    }
    if (state.repeat === 'one') {
      audio.currentTime = 0;
      audio.play().catch(() => {});
      return;
    }
    next(true);
    scheduleUpdateCheck();
  });
  let tick = 0;
  audio.addEventListener('timeupdate', () => {
    syncTime();
    if (Date.now() - tick > 5000) {
      tick = Date.now();
      savePlayback();
    }
  });
  audio.addEventListener('loadedmetadata', async () => {
    const t = currentTrack();
    if (t && (!t.duration || Math.abs(t.duration - audio.duration) > 1) && isFinite(audio.duration)) {
      t.duration = audio.duration;
      await db.put('tracks', t);
    }
    syncTime();
  });
  audio.addEventListener('error', () => {
    if (audio.src) toast('この曲は再生できませんでした');
  });

  P.onChange((type) => {
    if (type === 'sleep') syncControls();
    if (type === 'unplug') toast('イヤホンが外れたので止めました');
  });

  window.addEventListener('online', () => toast('オンラインになりました', 1400));
}

function speedDialog() {
  const rates = [0.75, 0.9, 1.0, 1.1, 1.25, 1.5, 2.0];
  menuDialog(
    '再生速度',
    rates.map((r) => ({
      label: r.toFixed(2) + 'x',
      sel: Math.abs(audio.playbackRate - r) < 0.001,
      run: () => {
        P.setRate(r);
        db.setSetting('rate', r);
        syncControls();
      },
    }))
  );
}

function timerDialog() {
  const s = P.sleepState();
  const opts = [
    ...[5, 10, 15, 30, 45, 60, 90].map((m) => ({ label: `${m}分後に停止`, run: () => { P.sleepAfterMinutes(m); toast(`${m}分後に停止します`); } })),
    { label: 'この曲の終わりで停止', sel: s.mode === 'trackEnd', run: () => { P.sleepAfterTrack(); toast('この曲の終わりで停止します'); } },
  ];
  if (s.mode !== 'off') opts.push({ label: 'タイマーを解除', danger: true, run: () => { P.cancelSleep(); toast('タイマーを解除しました'); } });
  const title = s.mode === 'time' ? `あと ${fmtTime(s.remain / 1000)}` : s.mode === 'trackEnd' ? 'この曲の終わりで停止' : 'スリープタイマー';
  menuDialog(title, opts);
}

function showQueue() {
  const items = state.queue.map((id) => state.byId.get(id)).filter(Boolean);
  const html =
    `<h3>再生キュー（${items.length}曲）</h3>` +
    items
      .map((t, i) => `<div class="opt${i === state.qi ? ' sel' : ''}" data-i="${i}"><span>${i + 1}. ${esc(t.title)}<br><span class="muted" style="font-size:11px">${esc(t.artist || '')}</span></span></div>`)
      .join('') +
    `<div class="actions"><button class="btn ghost full" id="qc">閉じる</button></div>`;
  openDialog(html, (root) => {
    $('#qc', root).onclick = closeDialog;
    root.querySelectorAll('.opt[data-i]').forEach((n) =>
      n.addEventListener('click', () => {
        state.qi = +n.dataset.i;
        closeDialog();
        loadCurrent(true);
      })
    );
    const sel = root.querySelector('.opt.sel');
    if (sel) sel.scrollIntoView({ block: 'center' });
  });
}

function albumMenu(key) {
  const g = groupAlbums().find((x) => x.key === key);
  if (!g) return;
  menuDialog(g.album, [
    { label: 'プレイリストに追加', icon: 'plus', run: () => addToPlaylistDialog(g.tracks.map((t) => t.id)) },
    {
      label: 'アルバム名を変える',
      run: async () => {
        const name = await promptDialog('アルバム名', g.album);
        if (!name) return;
        await runMoveToAlbum(g.tracks.map((t) => t.id), name, undefined);
      },
    },
    {
      label: '別のアルバムに統合',
      run: () => chooseAlbumDialog(g.tracks.map((t) => t.id), { title: '別のアルバムに統合', excludeKey: g.key }),
    },
    { label: 'ジャケットを探す', icon: 'img', run: () => findArtDialog(key) },
    {
      label: 'ジャケットを消す',
      run: async () => {
        await db.del('art', g.key);
        dropArtUrl(g.key);
        render();
        toast('消しました');
      },
    },
    { label: 'このアルバムを削除', icon: 'trash', danger: true, run: () => deleteTracks(g.tracks.map((t) => t.id), g.album) },
  ]);
}

/* ============================ バックグラウンド更新 ============================ */
// 新しい版が来ても、再生中やダイアログ表示中に急に切り替わると困るので、
// 安全なタイミングになるまで保留してから location.reload() する。
let swReg = null;
let updatePending = false; // 新しい版が来ていて、適用待ち
let updateReloading = false; // 二重に reload しないためのガード
let lastUpdateCheck = 0;
const UPDATE_CHECK_VISIBLE_GAP = 5 * 60 * 1000; // 表示に戻ったとき、前回確認から5分以上なら確認する
const UPDATE_CHECK_INTERVAL = 60 * 60 * 1000; // 開いている間は60分ごとに確認する

// いま新しい版を適用してよい状態か（再生中でなく、シート／ダイアログ／進捗表示も出ていない）
function canApplyUpdateNow() {
  if (!audio.paused) return false;
  if (document.querySelector('.sheet.open')) return false;
  if (!$('#dialogWrap').hidden) return false;
  if (!$('#progress').hidden) return false;
  if (importRunning) return false; // 取り込み中に reload すると取り込みが止まってしまう
  return true;
}

// 保留中の更新があり、かつ今が安全なタイミングなら適用する
function applyUpdateIfPossible() {
  if (!updatePending || updateReloading) return;
  if (!canApplyUpdateNow()) return;
  updateReloading = true;
  sessionStorage.setItem('kbmusic-updated', '1'); // 次の起動時に一度だけ知らせる
  location.reload();
}

// 曲が次へ切り替わる一瞬は audio.paused が true になるため、そこで更新を適用すると
// アルバム再生の途中で music が止まってしまう。少し置いてから状態を見直す。
let updateSettleTimer = 0;
function scheduleUpdateCheck() {
  if (!updatePending || updateReloading) return;
  clearTimeout(updateSettleTimer);
  updateSettleTimer = setTimeout(applyUpdateIfPossible, 1500);
}

function checkForUpdate() {
  lastUpdateCheck = Date.now();
  if (swReg) swReg.update().catch(() => {});
}

/* ============================ 起動 ============================ */
async function restorePlayback() {
  const last = db.setting('lastPlayback', null);
  if (!last || !last.ids || !last.ids.length) return;
  const ids = last.ids.filter((id) => state.byId.has(id));
  if (!ids.length) return;
  state.queue = ids;
  state.base = (last.base || ids).filter((id) => state.byId.has(id));
  state.qi = Math.min(Math.max(0, last.i || 0), ids.length - 1);
  state.ctxLabel = last.label || '';
  await loadCurrent(false, last.pos || 0);
}

async function init() {
  history.replaceState({ n: 0 }, '');
  await db.loadSettings();

  state.shuffle = db.setting('shuffle', false);
  state.repeat = db.setting('repeat', 'off');
  P.setRate(db.setting('rate', 1));
  P.setVolume(db.setting('volume', 1));
  $('#vol').value = Math.round(db.setting('volume', 1) * 100);
  if (db.setting('eqOn', false)) P.setEqEnabled(true);
  P.setupUnplugGuard(() => db.setting('unplug', 'pause'));

  wire();
  setupMediaSession();

  await loadLibrary();
  render();
  syncControls();
  await restorePlayback();
  db.persist();

  if (sessionStorage.getItem('kbmusic-updated')) {
    sessionStorage.removeItem('kbmusic-updated');
    toast('新しい版に更新しました');
  }

  setupServiceWorker();
}

// 新しい版を入れたとき、古いキャッシュを掴んだままにならないよう、裏で確認して安全なときに切り替える
async function setupServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || updateReloading) return; // 初回登録時は入れ替えではないので何もしない
    updatePending = true;
    applyUpdateIfPossible(); // 今すぐ適用できなければ保留し、あとで再生終了・停止・表示復帰時に再判定する
  });

  try {
    swReg = await navigator.serviceWorker.register('sw.js');
    checkForUpdate(); // 起動時に1回確認
  } catch (e) {
    console.warn('Service Worker を登録できませんでした', e);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    applyUpdateIfPossible();
    if (Date.now() - lastUpdateCheck > UPDATE_CHECK_VISIBLE_GAP) checkForUpdate();
  });

  setInterval(checkForUpdate, UPDATE_CHECK_INTERVAL);
}

init();
