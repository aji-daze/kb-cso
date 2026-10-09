// どの端末でも同じメモを見るための同期。設定したときだけ index.html が読み込む。
//
// 正本は端末（localStorage）。GitHub の非公開リポジトリ（既定は pomenote / notes と同じ
// aji-daze/pomera-data）の Obsidian/wataamemo/ に、1件1ファイルの「題名.md」で置く。
// PC の同期（pomera_sync）が OneDrive の Obsidian とそろえるので、OneDrive・Obsidian・notes・
// ポメラタブからも同じファイルが見える。そちらで書き換えたものも次の同期で取り込む。
//
// 書くたびに index.html が送信待ち（memo.q）に ID を残すので、オフラインの間はそこにたまり、
// つながったらまとめて送る。鍵は fine-grained token（対象1リポジトリ、Contents の読み書きのみ）。
// 公開リポジトリは指定されても使わない。
(function () {
  'use strict';
  var M = window.MEMO, LS = localStorage;
  var API = 'https://api.github.com/repos/';
  var SK = 'memo.s', TK = 'memo.ghtok';
  var DEF_REPO = 'aji-daze/pomera-data', DEF_DIR = 'Obsidian/wataamemo';

  // S = { repo, dir, map: { メモID: { p: リポジトリ上のパス, v: 最後に揃えたときの blob sha, b: そのときの題名 } }, last, v: 2 }
  function loadS() { try { return JSON.parse(LS.getItem(SK)); } catch (e) { return null; } }
  var S = loadS();
  function saveS() { if (S) LS.setItem(SK, JSON.stringify(S)); }
  function tok() { return LS.getItem(TK) || ''; }
  function markDirty(id) { var q = M.getQ(); q.dirty[id] = 1; LS.setItem('memo.q', JSON.stringify(q)); }

  // 前の形（memos/<ID>.md）でつないでいた端末: 題名のファイル名へ付け替える。
  // pomera-data なら置き場所も Obsidian/wataamemo へ移す（他の端末の新しい版と同じ場所にそろえる）
  if (S && S.repo && S.v !== 2) {
    S.dir = S.repo === DEF_REPO ? DEF_DIR : (S.dir || 'memos');
    Object.keys(S.map || {}).forEach(function (id) { S.map[id] = { p: 'memos/' + id + '.md', v: S.map[id].v, b: id }; });
    S.v = 2; saveS();
    M.all().forEach(function (m) { markDirty(m.id); });
  }

  var running = false, again = false, kT = 0, err = '', bad = false;

  // ---- GitHub API ----
  function E(msg, status) { var e = new Error(msg); e.status = status; return e; }
  function gh(path, opt, repo) {
    opt = opt || {};
    opt.headers = Object.assign({ Authorization: 'Bearer ' + tok(), Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, opt.headers || {});
    opt.cache = 'no-store';
    return fetch(API + (repo || S.repo) + path, opt).then(function (r) {
      if (r.status === 401) { bad = true; throw E('トークンが無効です（期限切れか、取り消された）', 401); }
      if (!r.ok) return r.text().then(function (b) { var m = ''; try { m = JSON.parse(b).message; } catch (e) { m = b.slice(0, 120); } throw E('GitHub ' + r.status + ' ' + m, r.status); });
      return r.status === 204 ? null : r.json();
    });
  }
  function encPath(p) { return p.split('/').map(encodeURIComponent).join('/'); }
  function json(method, body) { return { method: method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }; }
  // UTF-8 と base64
  function bytes(t) { return new TextEncoder().encode(t); }
  function b64(t) { var b = bytes(t), s = ''; for (var i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); }
  function unb64(x) { var s = atob(x.replace(/\s/g, '')), b = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return new TextDecoder().decode(b); }
  // git の blob sha を手元で計算する。中身が同じなら送らない・競合と見なさないために使う
  function gitSha(t) {
    var body = bytes(t), head = bytes('blob ' + body.length + '\0'), all = new Uint8Array(head.length + body.length);
    all.set(head); all.set(body, head.length);
    return crypto.subtle.digest('SHA-1', all).then(function (h) { return Array.prototype.map.call(new Uint8Array(h), function (x) { return (x < 16 ? '0' : '') + x.toString(16); }).join(''); });
  }

  // ---- ファイル名 ----
  // 1行目を題名にする。Windows（OneDrive）で使えない文字・末尾の点や空白は除く
  function baseName(t) {
    var l = t.replace(/<\/?u>/g, '').split('\n').map(function (x) { return x.replace(/^```.*$/, '').replace(/^#+\s+/, '').replace(/^（競合: .*）$/, '').trim(); }).filter(Boolean)[0] || '';
    l = l.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').slice(0, 50).replace(/[.\s]+$/, '').replace(/^[.\s]+/, '');
    if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(l)) l = l + '_';
    return l || '無題';
  }
  function stem(p) { return p.slice(p.lastIndexOf('/') + 1).replace(/\.md$/i, '').replace(/ \(\d+\)$/, ''); }
  // 今のパスの題名が変わっていなければそのまま。変わったら空いている名前を探す（大文字小文字は同じと見なす）。
  // Obsidian などで人が付けた名前（前の題名と違う名前）は変えない
  function wantPath(id, m, taken) {
    var b = baseName(m.t), e = S.map[id];
    if (e && (stem(e.p) === b || stem(e.p) !== e.b)) return e.p;
    var p = S.dir + '/' + b + '.md', n = 2;
    while (taken[p.toLowerCase()] && taken[p.toLowerCase()] !== id) p = S.dir + '/' + b + ' (' + (n++) + ').md';
    return p;
  }

  function listRemote() {
    return gh('/contents/' + encPath(S.dir)).then(function (r) {
      return (Array.isArray(r) ? r : []).filter(function (x) { return x.type === 'file' && /\.md$/i.test(x.name); })
        .map(function (x) { return { p: x.path, sha: x.sha }; });
    }, function (e) { if (e.status === 404 || e.status === 409) return []; throw e; });   // フォルダがまだ無い
  }

  // ---- 同期本体: 先に GitHub の変更を取り込み、次にたまった変更を送る ----
  function run() {
    clearTimeout(kT);
    if (!S || !S.repo) return Promise.resolve();
    if (running) { again = true; return Promise.resolve(); }
    if (!navigator.onLine || !tok() || bad) { ui(); return Promise.resolve(); }
    // 複数のタブで同時に走らせない
    if (navigator.locks) return navigator.locks.request('memo-sync', { ifAvailable: true }, function (l) { return l ? body() : null; });
    return body();
  }

  function body() {
    running = true; ui();
    M.save();   // 書きかけを先に保存して送信待ちに入れる（取り込みで上書きしないため）
    var changed = [], conflicts = 0, now = Date.now(), taken = {};
    return listRemote().then(function (files) {
      var q = M.getQ(), seen = {}, byPath = {};
      Object.keys(S.map).forEach(function (id) { byPath[S.map[id].p] = id; });
      files.forEach(function (f) { taken[f.p.toLowerCase()] = byPath[f.p] || '?'; seen[f.p] = 1; });
      return files.reduce(function (p, f) {
        return p.then(function () {
          var id = byPath[f.p];
          if (!id) {
            // よそ（別の端末・Obsidian・notes など）で作られたファイル
            return gh('/git/blobs/' + f.sha).then(function (b) {
              var nid = M.nid(), text = unb64(b.content);
              M.putRaw(nid, { t: text, c: now, u: now });
              S.map[nid] = { p: f.p, v: f.sha, b: baseName(text) }; taken[f.p.toLowerCase()] = nid; changed.push(nid);
            });
          }
          var e = S.map[id];
          if (e.v === f.sha) return;                     // 変わっていない
          if (q.del[id]) return;                         // 手元で消した。送る段で消す
          var local = M.get(id);
          return (local ? gitSha(local.t) : Promise.resolve('')).then(function (ls) {
            if (ls === f.sha) { e.v = f.sha; return; }   // 中身は同じ
            return gh('/git/blobs/' + f.sha).then(function (b) {
              var text = unb64(b.content);
              if (q.dirty[id] && local) {
                // 両方で変わった: 手元の版はそのまま送る。向こうの版は別のメモとして残す
                M.setM(M.nid(), { t: '（競合: 別の端末の版）\n' + text, c: now, u: now }); conflicts++;
              } else {
                M.putRaw(id, { t: text, c: local ? local.c : now, u: now });
                changed.push(id); e.b = baseName(text);
              }
              e.v = f.sha;
            });
          });
        });
      }, Promise.resolve()).then(function () {
        // 向こうで消された（または名前を変えられた）ファイル
        Object.keys(S.map).forEach(function (id) {
          if (seen[S.map[id].p]) return;
          if (S.map[id].p.indexOf(S.dir + '/') !== 0) return;   // 前の置き場所のもの（一覧に入らない）。送る段で移す
          if (!q.dirty[id] && !q.del[id] && M.get(id)) { M.rmRaw(id); changed.push(id); }
          delete S.map[id];                               // 手元で書き換えていれば、送る段で作り直す
        });
        saveS();
      });
    }).then(function () {
      var q = M.getQ();
      var p = Object.keys(q.del).reduce(function (p, id) {
        return p.then(function () {
          var e = S.map[id];
          if (!e) { M.unq(id, 'del'); return; }
          return gh('/contents/' + encPath(e.p), json('DELETE', { message: 'delete: ' + e.p + ' (wataamemo)', sha: e.v }))
            .then(function () { delete S.map[id]; saveS(); M.unq(id, 'del'); }, function (x) {
              if (x.status === 404) { delete S.map[id]; saveS(); M.unq(id, 'del'); return; }
              if (x.status === 409 || x.status === 422) { again = true; return; }   // 取り込んだ後に向こうで変わった。次の回に
              throw x;
            });
        });
      }, Promise.resolve());
      return Object.keys(q.dirty).reduce(function (p, id) {
        return p.then(function () {
          var m = M.get(id);
          if (!m) { M.unq(id, 'dirty'); return; }
          var e = S.map[id], to = wantPath(id, m, taken);
          return gitSha(m.t).then(function (sha) {
            if (e && e.p === to && e.v === sha) { M.unq(id, 'dirty'); return; }   // 変わっていない
            var same = e && e.p === to;
            var b = { message: (same ? 'update: ' : 'add: ') + to + ' (wataamemo)', content: b64(m.t) };
            if (same) b.sha = e.v;
            return gh('/contents/' + encPath(to), json('PUT', b)).then(function (r) {
              taken[to.toLowerCase()] = id;
              // 題名が変わった: 新しい名前で書いてから古いファイルを消す
              var old = e && !same ? gh('/contents/' + encPath(e.p), json('DELETE', { message: 'rename: ' + e.p + ' → ' + to + ' (wataamemo)', sha: e.v }))
                .then(function () { delete taken[e.p.toLowerCase()]; }, function (x) { if (x.status !== 404 && x.status !== 409 && x.status !== 422) throw x; }) : null;
              return Promise.resolve(old).then(function () {
                S.map[id] = { p: to, v: r.content.sha, b: baseName(m.t) }; saveS();
                var m2 = M.get(id);
                if (!m2 || m2.u === m.u) M.unq(id, 'dirty');   // 送っている間に書き足されたら、次の回にもう一度送る
              });
            }, function (x) {
              if (x.status === 409 || x.status === 422) { again = true; return; }   // 向こうが先に変わった。次の回に取り込んで競合として扱う
              throw x;
            });
          });
        });
      }, p);
    }).then(function () {
      S.last = Date.now(); err = ''; saveS();
      changed.forEach(M.remote);
      if (conflicts) M.toast('別の端末と同時に書き換えたメモが' + conflicts + '件あり、両方を残しました');
    }, function (x) {
      err = x.message || String(x);
    }).then(function () {
      running = false; ui(); refresh();
      if (again) { again = false; kT = setTimeout(run, 800); }
    });
  }

  // ---- 表示 ----
  function pending() { var q = M.getQ(); return Object.keys(q.dirty).length + Object.keys(q.del).length; }
  function ui() {
    var sy = M.sy;
    if (!S || !S.repo) { sy.hidden = true; return; }
    var n = pending(), tail = n ? ' · 未送信' + n : '';
    sy.hidden = false;
    sy.textContent = running ? '同期中' : (bad || !tok()) ? 'トークン無効' + tail : !navigator.onLine ? 'オフライン' + tail : err ? '同期エラー' + tail : n ? '未送信' + n : '同期済';
    sy.title = err || (S.last ? '最終同期 ' + M.fmt(S.last) : '');
  }

  var pv = null;
  function panel() {
    if (!pv) {
      var st = document.createElement('style');
      st.textContent = '#syp{position:fixed;inset:0;z-index:11;background:var(--bg);overflow:auto;display:none}#syp.on{display:block}' +
        '#syp .in{max-width:660px;margin:0 auto;padding:calc(20px + env(safe-area-inset-top)) 24px calc(32px + env(safe-area-inset-bottom))}' +
        '#syp .hd{display:flex;align-items:center;justify-content:space-between;height:52px}#syp .hd b{font-weight:400;letter-spacing:.08em}' +
        '#syp .hd button{width:44px;height:44px;margin-right:-12px;color:var(--sub);font-size:20px}' +
        '#syp p{font-size:14px;color:var(--sub);margin:14px 0;line-height:1.8}#syp p b{color:var(--fg);font-weight:400}' +
        '#syp label{display:block;font-size:12px;letter-spacing:.08em;color:var(--sub);margin-top:22px}' +
        '#syp input{width:100%;padding:6px 0;border:0;border-bottom:1px solid var(--faint);background:none;color:inherit;font:15px/1.6 ui-monospace,Menlo,Consolas,monospace;outline:0;border-radius:0}' +
        '#syp input:focus{border-color:var(--sub)}#syp code{font:12px ui-monospace,Menlo,Consolas,monospace;color:var(--fg)}' +
        '#syp a{color:var(--fg);text-underline-offset:4px}' +
        '#syp .bt{display:flex;flex-wrap:wrap;gap:8px 28px;margin-top:28px}#syp .bt button{font-size:13px;letter-spacing:.08em;color:var(--fg);text-decoration:underline;text-underline-offset:4px}' +
        '#syp .bt .dim{color:var(--sub)}#syp ol{font-size:13px;color:var(--sub);padding-left:1.4em;line-height:1.9;margin-top:10px}';
      document.head.appendChild(st);
      pv = document.createElement('div'); pv.id = 'syp';
      pv.innerHTML = '<div class="in"><div class="hd"><b>どの端末でも同じメモにする</b><button aria-label="閉じる">×</button></div><div class="bd"></div></div>';
      document.body.appendChild(pv);
      pv.querySelector('.hd button').onclick = function () { pv.className = ''; };
      pv.addEventListener('click', function (e) {
        var a = e.target.getAttribute && e.target.getAttribute('data-a');
        if (a === 'connect') connect();
        else if (a === 'sync') { bad = false; run(); }
        else if (a === 'retoken') { S.editTok = true; refresh(); }
        else if (a === 'off') {
          if (!confirm('同期をやめますか？ 端末のメモも、GitHub・OneDrive のファイルも残ります。')) return;
          LS.removeItem(SK); LS.removeItem(TK); S = null; ui(); refresh();
        }
      });
    }
    pv.className = 'on';
    refresh();
  }

  // 接続: リポジトリが非公開で、トークンで読めることを確かめてから始める
  function connect() {
    var g = function (id) { var x = pv.querySelector(id); return x ? x.value.trim() : ''; };
    var repo = (g('#gr') || S.repo).replace(/^https:\/\/github\.com\//, '').replace(/\.git$|\/$/g, '');
    var dir = (pv.querySelector('#gd') ? g('#gd') : S.dir).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    var t = g('#gt');
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { M.toast('リポジトリは「持ち主/名前」の形で書きます'); return; }
    if (!dir || /(^|\/)\.\.?(\/|$)|^\./.test(dir)) { M.toast('置き場所のフォルダを書いてください（. で始まる名前は使えません）'); return; }
    if (!t) { M.toast('トークンを貼ってください'); return; }
    var old = tok(); LS.setItem(TK, t); bad = false;
    gh('', null, repo).then(function (r) {
      if (!r.private) { if (old) LS.setItem(TK, old); else LS.removeItem(TK); M.toast('公開リポジトリです。メモが誰でも読めてしまうので使いません'); return; }
      if (!S || S.repo !== repo || S.dir !== dir) { S = { repo: repo, dir: dir, map: {}, last: 0, v: 2 }; M.all().forEach(function (m) { markDirty(m.id); }); }   // 手元のメモを全部送る
      delete S.editTok; saveS(); err = '';
      M.toast('つながりました'); ui(); refresh(); run();
    }, function (x) {
      if (old) LS.setItem(TK, old); else LS.removeItem(TK);
      M.toast(x.status === 404 ? 'リポジトリが見つかりません（名前か、トークンの対象リポジトリを確認）' : x.message);
    });
  }

  function esc(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }
  function refresh() {
    if (!pv || !pv.className) return;
    var bd = pv.querySelector('.bd');
    if (!S || !S.repo || S.editTok) {
      var editing = S && S.repo && S.editTok;
      bd.innerHTML = (editing ? '<p>新しいトークンを貼ってください。</p>' :
        '<p>メモを <b>OneDrive の Obsidian/wataamemo</b> に、1件1ファイルの「題名.md」で置いて、どの端末でも同じ中身にします。' +
        'pomenote・notes と同じ非公開リポジトリ <b>pomera-data</b> を通り、PC の同期で OneDrive に届きます。' +
        'Obsidian・notes で書き換えたものも取り込みます。電波がない間の変更は端末にためて、つながったら送ります。</p>' +
        '<p><b>pomenote / notes で使っているトークンをそのまま貼れます。</b>無ければ ' +
        '<a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">ここで作る</a>' +
        '（Only select repositories → pomera-data、Contents: Read and write）。</p>' +
        '<label for="gr">リポジトリ</label><input id="gr" spellcheck="false" autocomplete="off" autocapitalize="off" value="' + DEF_REPO + '">' +
        '<label for="gd">置き場所（リポジトリの中のフォルダ）</label><input id="gd" spellcheck="false" autocomplete="off" autocapitalize="off" value="' + DEF_DIR + '">') +
        '<label for="gt">トークン</label><input id="gt" type="password" spellcheck="false" autocomplete="off" autocapitalize="off" placeholder="github_pat_…">' +
        '<p>トークンはこの端末のブラウザにだけ保存します。端末ごとに1回貼ります。</p>' +
        '<div class="bt"><button data-a="connect">つなぐ</button></div>';
      return;
    }
    var n = pending();
    bd.innerHTML = '<p>置き場所 <b>' + esc(S.repo) + ' / ' + esc(S.dir) + '</b>　<a href="https://github.com/' + esc(S.repo) + '/tree/HEAD/' + esc(encPath(S.dir)) + '" target="_blank" rel="noopener">開く</a></p>' +
      '<p>状態 <b>' + esc(M.sy.textContent) + '</b></p>' +
      '<p>最終同期 <b>' + (S.last ? M.fmt(S.last) : 'まだ') + '</b>　未送信 <b>' + n + '件</b></p>' +
      (err ? '<p>' + esc(err) + '</p>' : '') +
      '<div class="bt"><button data-a="sync">今すぐ同期</button><button data-a="retoken">トークンを貼り直す</button>' +
      '<button class="dim" data-a="off">同期をやめる</button></div>';
  }

  // ---- いつ同期するか ----
  function kick() { ui(); clearTimeout(kT); kT = setTimeout(run, 3000); }   // 書いてから3秒止まったら
  addEventListener('online', function () { run(); });
  addEventListener('offline', ui);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && S && Date.now() - (S.last || 0) > 20000) run(); });
  setInterval(function () { if (!document.hidden && S && Date.now() - (S.last || 0) > 60000) run(); }, 30000);

  window.MemoSync = { kick: kick, run: run, panel: panel, tap: panel };
  ui();
  setTimeout(run, 500);
})();
