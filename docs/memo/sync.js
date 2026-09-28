// Google ドライブ同期。設定したときだけ index.html が読み込む。
//
// 正本は端末（localStorage）。ドライブは「マイドライブ / MEMO」に1件1ファイルの .md で置く。
// 書くたびに index.html が送信待ち（memo.q）に ID を残すので、オフラインの間はそこにたまり、
// つながったらまとめて送る。権限は drive.file（このアプリが作ったファイルだけ）。
//
// ログインは Google の画面へ移って戻ってくる方式（ポップアップを使わない）。
// ホーム画面に追加した iPhone のアプリでもポップアップは戻ってこないことがあるため。
// サーバーを持たないので許可は1時間で切れる。切れたらバーの「再ログイン」を押す。
// 書くことと端末への保存は、ログインが切れていても止まらない。
(function () {
  'use strict';
  var M = window.MEMO, LS = localStorage;
  var API = 'https://www.googleapis.com/drive/v3/';
  var UP = 'https://www.googleapis.com/upload/drive/v3/files';
  var SCOPE = 'https://www.googleapis.com/auth/drive.file';
  var FOLDER = 'application/vnd.google-apps.folder';
  var SK = 'memo.s', TK = 'memo.tok', STK = 'memo.st';

  // S = { cid: クライアントID, folder: MEMO フォルダの ID, map: { メモID: { f: ファイルID, v: 最後に揃えたときの版 } }, last: 最終同期 }
  function loadS() { try { return JSON.parse(LS.getItem(SK)); } catch (e) { return null; } }
  var S = loadS();
  function saveS() { if (S) LS.setItem(SK, JSON.stringify(S)); }
  function tok() { try { var t = JSON.parse(LS.getItem(TK)); return t && t.exp > Date.now() ? t.t : null; } catch (e) { return null; } }

  var running = false, again = false, kT = 0, err = '';

  // ---- ログイン（Google の画面から戻ってきたとき） ----
  (function () {
    var h = location.hash;
    if (!/[#&](access_token|error)=/.test(h)) return;
    var p = new URLSearchParams(h.slice(1)), st = LS.getItem(STK);
    history.replaceState(null, '', location.pathname + location.search);
    LS.removeItem(STK);
    if (!st || p.get('state') !== st) { M.toast('ログインの応答を確かめられませんでした。もう一度試してください'); return; }
    if (p.get('error')) { M.toast(p.get('error') === 'access_denied' ? 'ログインを取り消しました' : 'ログインできませんでした: ' + p.get('error')); return; }
    LS.setItem(TK, JSON.stringify({ t: p.get('access_token'), exp: Date.now() + (Number(p.get('expires_in') || 3600) - 60) * 1000 }));
    M.toast('Google ドライブにつながりました');
  })();

  function login() {
    if (!S || !S.cid) { panel(); return; }
    M.save();
    var st = Math.random().toString(36).slice(2) + Date.now().toString(36);
    LS.setItem(STK, st);
    var u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    u.searchParams.set('client_id', S.cid);
    u.searchParams.set('redirect_uri', redirect());
    u.searchParams.set('response_type', 'token');
    u.searchParams.set('scope', SCOPE);
    u.searchParams.set('include_granted_scopes', 'true');
    u.searchParams.set('state', st);
    if (S.hint) u.searchParams.set('login_hint', S.hint);
    location.assign(u.toString());
  }
  function redirect() { return location.origin + location.pathname; }

  // ---- ドライブ API ----
  function E(msg, status) { var e = new Error(msg); e.status = status; return e; }
  function req(url, opt) {
    var t = tok();
    if (!t) return Promise.reject(E('auth', 401));
    opt = opt || {};
    opt.headers = Object.assign({ Authorization: 'Bearer ' + t }, opt.headers || {});
    return fetch(url, opt).then(function (r) {
      if (r.status === 401) { LS.removeItem(TK); throw E('auth', 401); }
      if (!r.ok) return r.text().then(function (b) { throw E('Drive ' + r.status + ' ' + b.slice(0, 200), r.status); });
      return r;
    });
  }
  function json(url, opt) { return req(url, opt).then(function (r) { return r.json(); }); }
  function qs(o) { return Object.keys(o).map(function (k) { return k + '=' + encodeURIComponent(o[k]); }).join('&'); }

  // メモ本文と情報を1回で送る（multipart）
  function upload(fileId, meta, text) {
    var b = 'memo' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    var body = '--' + b + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) +
      '\r\n--' + b + '\r\nContent-Type: text/markdown; charset=UTF-8\r\n\r\n' + text + '\r\n--' + b + '--';
    var url = UP + (fileId ? '/' + fileId : '') + '?uploadType=multipart&fields=id,version';
    return json(url, { method: fileId ? 'PATCH' : 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + b }, body: body });
  }

  // ドライブ上のファイル名。1行目を題名にする（記号とファイル名に使えない文字は除く）
  function fname(t) {
    var l = t.replace(/<\/?u>/g, '').split('\n').map(function (x) { return x.replace(/^```.*$/, '').trim(); }).filter(Boolean)[0] || 'memo';
    return l.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 40).trim() + '.md';
  }

  function ensureFolder() {
    var p = S.folder
      ? json(API + 'files/' + S.folder + '?fields=id,trashed').then(function (f) { return f.trashed ? null : f.id; }, function (e) { if (e.status === 404) return null; throw e; })
      : Promise.resolve(null);
    return p.then(function (id) {
      if (id) return id;
      // フォルダが無い（初回、またはドライブで消された）: 作り直して全件を送り直す
      if (S.folder) { S.map = {}; M.all().forEach(function (m) { markDirty(m.id); }); }
      var q = "name='MEMO' and mimeType='" + FOLDER + "' and trashed=false and 'root' in parents";
      return json(API + 'files?' + qs({ q: q, fields: 'files(id)', spaces: 'drive' })).then(function (r) {
        if (r.files && r.files.length) return r.files[0].id;
        return json(API + 'files?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'MEMO', mimeType: FOLDER }) }).then(function (f) { return f.id; });
      });
    }).then(function (id) { S.folder = id; saveS(); });
  }

  function listRemote() {
    var out = [];
    function page(tokn) {
      var o = { q: "'" + S.folder + "' in parents and trashed=false", fields: 'nextPageToken,files(id,version,modifiedTime,appProperties)', pageSize: 1000, spaces: 'drive' };
      if (tokn) o.pageToken = tokn;
      return json(API + 'files?' + qs(o)).then(function (r) {
        out = out.concat(r.files || []);
        return r.nextPageToken ? page(r.nextPageToken) : out;
      });
    }
    return page();
  }

  function markDirty(id) { var q = M.getQ(); q.dirty[id] = 1; LS.setItem('memo.q', JSON.stringify(q)); }

  // ---- 同期本体: 先にドライブの変更を取り込み、次にたまった変更を送る ----
  function run() {
    clearTimeout(kT);
    if (!S || !S.cid) return Promise.resolve();
    if (running) { again = true; return Promise.resolve(); }
    if (!navigator.onLine || !tok()) { ui(); return Promise.resolve(); }
    // 複数のタブで同時に走らせない（同じメモが二重に作られるのを防ぐ）
    if (navigator.locks) return navigator.locks.request('memo-sync', { ifAvailable: true }, function (l) { return l ? body() : null; });
    return body();
  }

  function body() {
    running = true; ui();
    M.save();   // 書きかけを先に保存して送信待ちに入れる（取り込みで上書きしないため）
    var changed = [], conflicts = 0, now = Date.now();
    return ensureFolder().then(listRemote).then(function (files) {
      var q = M.getQ(), seen = {}, byFile = {};
      Object.keys(S.map).forEach(function (id) { byFile[S.map[id].f] = id; });
      // 取り込み（1件ずつ順番に）
      return files.reduce(function (p, f) {
        return p.then(function () {
          var id = (f.appProperties && f.appProperties.memoId) || byFile[f.id];
          if (!id) return;
          seen[id] = 1;
          var e = S.map[id];
          if (e && e.f !== f.id) return;                 // 同じメモの二重ファイル。手元が指している方を正とする
          if (e && e.v === f.version) return;            // 変わっていない
          if (q.del[id]) return;                         // 手元で消した。送る段で消す
          return req(API + 'files/' + f.id + '?alt=media').then(function (r) { return r.text(); }).then(function (text) {
            var local = M.get(id), ru = Date.parse(f.modifiedTime) || now;
            if (q.dirty[id] && local) {
              // 両方で変わった: 手元の版はそのまま送る。ドライブの版は別のメモとして残す
              if (local.t !== text) { M.setM(M.nid(), { t: '（競合: 別の端末の版）\n' + text, c: now, u: ru }); conflicts++; }
            } else if (!local || local.t !== text) {
              M.putRaw(id, { t: text, c: Number(f.appProperties && f.appProperties.c) || ru, u: ru });
              changed.push(id);
            }
            S.map[id] = { f: f.id, v: f.version };
          });
        });
      }, Promise.resolve()).then(function () {
        // ドライブで消された（ゴミ箱に入れられた）メモ
        Object.keys(S.map).forEach(function (id) {
          if (seen[id]) return;
          if (!q.dirty[id] && !q.del[id] && M.get(id)) { M.rmRaw(id); changed.push(id); }
          delete S.map[id];                               // 手元で書き換えていれば、送る段で新しいファイルとして作り直す
        });
        saveS();
      });
    }).then(function () {
      // 送信（削除 → 更新・作成）
      var q = M.getQ();
      var dels = Object.keys(q.del), dirty = Object.keys(q.dirty);
      var p = dels.reduce(function (p, id) {
        return p.then(function () {
          var e = S.map[id];
          var go = e ? req(API + 'files/' + e.f, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) })
            .catch(function (x) { if (x.status !== 404) throw x; }) : Promise.resolve();
          return go.then(function () { delete S.map[id]; saveS(); M.unq(id, 'del'); });
        });
      }, Promise.resolve());
      return dirty.reduce(function (p, id) {
        return p.then(function () {
          var m = M.get(id);
          if (!m) { M.unq(id, 'dirty'); return; }
          var e = S.map[id];
          var meta = { name: fname(m.t), modifiedTime: new Date(m.u).toISOString(), appProperties: { memoId: id, c: String(m.c) } };
          var put = e ? upload(e.f, meta, m.t).catch(function (x) { if (x.status === 404) return null; throw x; }) : Promise.resolve(null);
          return put.then(function (r) {
            if (r) return r;
            meta.parents = [S.folder]; meta.mimeType = 'text/markdown';
            return upload(null, meta, m.t);
          }).then(function (r) {
            S.map[id] = { f: r.id, v: r.version }; saveS();
            var m2 = M.get(id);
            if (!m2 || m2.u === m.u) M.unq(id, 'dirty');   // 送っている間に書き足されたら、次の回にもう一度送る
          });
        });
      }, p);
    }).then(function () {
      S.last = Date.now(); err = ''; saveS();
      changed.forEach(M.remote);
      if (conflicts) M.toast('別の端末と同時に書き換えたメモが' + conflicts + '件あり、両方を残しました');
    }, function (x) {
      err = x.status === 401 ? '' : (x.message || String(x));
    }).then(function () {
      running = false; ui(); refresh();
      if (again) { again = false; kT = setTimeout(run, 500); }
    });
  }

  // ---- 表示 ----
  function pending() { var q = M.getQ(); return Object.keys(q.dirty).length + Object.keys(q.del).length; }
  function ui() {
    var sy = M.sy;
    if (!S || !S.cid) { sy.hidden = true; return; }
    var n = pending(), tail = n ? ' · 未送信' + n : '';
    sy.hidden = false;
    sy.textContent = running ? '同期中' : !tok() ? '再ログイン' + tail : !navigator.onLine ? 'オフライン' + tail : err ? '同期エラー' : n ? '未送信' + n : '同期済';
    sy.title = err || (S.last ? '最終同期 ' + M.fmt(S.last) : '');
  }

  // 設定画面
  var pv = null;
  function panel() {
    if (!pv) {
      var st = document.createElement('style');
      st.textContent = '#syp{position:fixed;inset:0;z-index:11;background:var(--bg);overflow:auto;display:none}#syp.on{display:block}' +
        '#syp .in{max-width:660px;margin:0 auto;padding:calc(20px + env(safe-area-inset-top)) 24px calc(32px + env(safe-area-inset-bottom))}' +
        '#syp .hd{display:flex;align-items:center;justify-content:space-between;height:52px}#syp .hd b{font-weight:400;letter-spacing:.08em}' +
        '#syp .hd button{width:44px;height:44px;margin-right:-12px;color:var(--sub);font-size:20px}' +
        '#syp p{font-size:14px;color:var(--sub);margin:14px 0;line-height:1.8}#syp p b{color:var(--fg);font-weight:400}' +
        '#syp input{width:100%;padding:6px 0;border:0;border-bottom:1px solid var(--faint);background:none;color:inherit;font:14px/1.6 ui-monospace,Menlo,Consolas,monospace;outline:0;border-radius:0}' +
        '#syp input:focus{border-color:var(--sub)}#syp code{font:12px ui-monospace,Menlo,Consolas,monospace;color:var(--fg);word-break:break-all}' +
        '#syp .bt{display:flex;flex-wrap:wrap;gap:8px 28px;margin-top:24px}#syp .bt button,#syp .bt a{font-size:13px;letter-spacing:.08em;color:var(--fg);text-decoration:underline;text-underline-offset:4px}' +
        '#syp .bt .dim{color:var(--sub)}#syp p a{color:var(--fg);text-underline-offset:4px}#syp ol{font-size:13px;color:var(--sub);padding-left:1.4em;line-height:1.9}';
      document.head.appendChild(st);
      pv = document.createElement('div'); pv.id = 'syp';
      pv.innerHTML = '<div class="in"><div class="hd"><b>Google ドライブ同期</b><button aria-label="閉じる">×</button></div><div class="bd"></div></div>';
      document.body.appendChild(pv);
      pv.querySelector('.hd button').onclick = function () { pv.className = ''; };
      pv.addEventListener('click', function (e) {
        var a = e.target.getAttribute && e.target.getAttribute('data-a');
        if (a === 'connect') {
          var v = pv.querySelector('input').value.trim();
          if (!/^\d+-[\w-]+\.apps\.googleusercontent\.com$/.test(v)) { M.toast('クライアント ID の形が違います（…apps.googleusercontent.com）'); return; }
          S = { cid: v, map: {}, last: 0 }; saveS();
          M.all().forEach(function (m) { markDirty(m.id); });   // 手元のメモを全部送る
          login();
        } else if (a === 'login') login();
        else if (a === 'sync') { run(); }
        else if (a === 'off') {
          if (!confirm('同期をやめますか？ 端末のメモとドライブのファイルはどちらも残ります。')) return;
          var t = tok(); if (t) fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(t), { method: 'POST' }).catch(function () {});
          LS.removeItem(SK); LS.removeItem(TK); S = null; ui(); refresh();
        }
      });
    }
    pv.className = 'on';
    refresh();
  }
  function esc(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;'); }
  function refresh() {
    if (!pv || !pv.className) return;
    var bd = pv.querySelector('.bd'), h = '';
    if (!S || !S.cid) {
      h = '<p>メモを Google ドライブの「MEMO」フォルダに、1件1ファイルの .md で保存して、別の端末と揃えます。' +
        'オフラインの間の変更は端末にためておき、つながったときにまとめて送ります。</p>' +
        '<p>OAuth クライアント ID</p><input spellcheck="false" autocomplete="off" autocapitalize="off" placeholder="000000000000-xxxx.apps.googleusercontent.com">' +
        '<p>read / music で使っているものと同じ ID でかまいません。Google Cloud のその ID の設定で、次の2つを済ませておきます。</p>' +
        '<ol><li>「承認済みのリダイレクト URI」に <code>' + esc(redirect()) + '</code> を追加</li>' +
        '<li>OAuth 同意画面の「データアクセス」に <code>' + SCOPE + '</code> を追加し、公開ステータスを「本番環境」にする（「テスト」のままだと7日ごとに承認し直しになる）</li></ol>' +
        '<div class="bt"><button data-a="connect">つなぐ</button></div>';
      bd.innerHTML = h;
      detectCid().then(function (id) { var i = pv.querySelector('input'); if (id && i && !i.value) i.value = id; });
      return;
    }
    var n = pending();
    h = '<p>保存先 <b>マイドライブ / MEMO</b>' + (S.folder ? '　<a href="https://drive.google.com/drive/folders/' + esc(S.folder) + '" target="_blank" rel="noopener">開く</a>' : '') + '</p>' +
      '<p>状態 <b>' + esc(M.sy.textContent) + '</b></p>' +
      '<p>最終同期 <b>' + (S.last ? M.fmt(S.last) : 'まだ') + '</b>　未送信 <b>' + n + '件</b></p>' +
      (err ? '<p>' + esc(err) + '</p>' : '') +
      (tok() ? '' : '<p>Google の許可は1時間で切れます。切れても書くことと端末への保存は続けられ、変更は未送信としてたまります。「ログイン」で再開します。</p>') +
      '<div class="bt">' + (tok() ? '<button data-a="sync">今すぐ同期</button>' : '<button data-a="login">ログイン</button>') +
      '<button class="dim" data-a="off">同期をやめる</button></div>';
    bd.innerHTML = h;
  }

  // read / music に設定済みのクライアント ID があれば借りる（同じサイトなので読める）
  function detectCid() {
    if (!window.indexedDB || !indexedDB.databases) return Promise.resolve('');
    function get(name, pick) {
      return new Promise(function (ok) {
        var r = indexedDB.open(name);
        r.onerror = function () { ok(''); };
        r.onsuccess = function () {
          var db = r.result;
          try {
            var g = db.transaction('settings').objectStore('settings').get('driveClientId');
            g.onsuccess = function () { db.close(); ok(pick(g.result) || ''); };
            g.onerror = function () { db.close(); ok(''); };
          } catch (e) { db.close(); ok(''); }
        };
      });
    }
    return indexedDB.databases().then(function (list) {
      var names = list.map(function (d) { return d.name; });   // 無い DB を open すると空の DB ができてしまうので、あるものだけ開く
      var p = names.indexOf('shiori') >= 0 ? get('shiori', function (x) { return x && x.v; }) : Promise.resolve('');
      return p.then(function (id) { return id || (names.indexOf('kbmusic') >= 0 ? get('kbmusic', function (x) { return typeof x === 'string' ? x : ''; }) : ''); });
    }).catch(function () { return ''; });
  }

  // ---- いつ同期するか ----
  function kick() { ui(); clearTimeout(kT); kT = setTimeout(run, 3000); }   // 書いてから3秒止まったら
  addEventListener('online', function () { run(); });
  addEventListener('offline', ui);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && S && Date.now() - (S.last || 0) > 20000) run(); });
  setInterval(function () { if (!document.hidden && S && Date.now() - (S.last || 0) > 60000) run(); }, 30000);

  window.MemoSync = {
    kick: kick, run: run, panel: panel,
    tap: function () { if (S && S.cid && !tok()) login(); else panel(); }
  };
  ui();
  setTimeout(run, 500);
})();
