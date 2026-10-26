// どの端末でも同じメモを見るための同期。設定したときだけ index.html が読み込む。
//
// 正本は端末（localStorage）。置き場所は2通りから選ぶ。
//   OneDrive（おすすめ）: Microsoft Graph で OneDrive のフォルダ（既定 メモ-wataamemo）を直接読み書きする。
//                        PC・スマホ・ほかのアプリでそのフォルダを書き換えたものも取り込む。
//   GitHub            : 非公開リポジトリ（既定 aji-daze/pomera-data）の メモ-wataamemo/ を読み書きする。
// どちらも 1件1ファイルの「題名.md」。
//
// 書くたびに index.html が送信待ち（memo.q）に ID を残すので、オフラインの間はそこにたまり、
// つながったらまとめて送る。同期の手順（取り込み → 送る、競合は両方残す）は置き場所によらず同じで、
// 置き場所ごとの違いは「どう読む・書く」（下の OD / GH）だけ。
(function () {
  'use strict';
  var M = window.MEMO, LS = localStorage;
  var SK = 'memo.s', GTK = 'memo.ghtok', OTK = 'memo.od', OPK = 'memo.odp', OSK = 'memo.odsilent';
  var DEF_REPO = 'aji-daze/pomera-data', DEF_DIR = 'メモ-wataamemo', OLD_DIR = 'Obsidian/wataamemo';
  var DEF_OD = 'メモ-wataamemo', IDIR = '画像';
  var loadedAt = Date.now(), typed = false;
  document.addEventListener('input', function () { typed = true; }, { capture: true, once: true });

  // S = { kind: 'onedrive'|'github', last, v: 4,
  //       onedrive: cid（クライアント ID）, place（入力したフォルダ）, folder: { drive, id, name, web }
  //       github  : repo, dir
  //       map: { メモID: { k: 向こうでの鍵（OneDrive は項目 ID、GitHub はパス）, p: ファイル名, v: 版, et: eTag, b: そのときの題名, h: そのときの中身の印, out: 前の置き場所にある } } }
  function loadS() { try { return JSON.parse(LS.getItem(SK)); } catch (e) { return null; } }
  var S = loadS();
  function saveS() { if (S) LS.setItem(SK, JSON.stringify(S)); }
  function markDirty(id) { var q = M.getQ(); q.dirty[id] = 1; LS.setItem('memo.q', JSON.stringify(q)); }
  function markAll() { M.all().forEach(function (m) { markDirty(m.id); }); }
  function base(p) { return p.slice(p.lastIndexOf('/') + 1); }

  // ---- 前の版の設定を今の形に直す（GitHub だけの時代のもの） ----
  if (S && S.repo && !S.kind) {
    var redo = false;
    if (S.v !== 2 && S.v !== 3) {   // いちばん前の形（memos/<ID>.md）
      S.dir = S.repo === DEF_REPO ? DEF_DIR : (S.dir || 'memos');
      Object.keys(S.map || {}).forEach(function (id) { S.map[id] = { p: 'memos/' + id + '.md', v: S.map[id].v, b: id }; });
      redo = true;
    } else if (S.v === 2 && S.repo === DEF_REPO && S.dir === OLD_DIR) { S.dir = DEF_DIR; redo = true; }
    var map = {};
    Object.keys(S.map || {}).forEach(function (id) {
      var e = S.map[id];
      map[id] = { k: e.p, p: base(e.p), v: e.v, b: e.b, out: e.p.indexOf(S.dir + '/') !== 0 };
    });
    S = { kind: 'github', repo: S.repo, dir: S.dir, map: map, last: S.last || 0, v: 4 };
    saveS();
    if (redo) markAll();
  }

  var running = false, again = false, kT = 0, err = '', need = '';   // need: 'signin' | 'token'（人の操作が要る）

  function E(msg, status) { var e = new Error(msg); e.status = status; return e; }
  function bytes(t) { return new TextEncoder().encode(t); }
  function b64url(buf) { return btoa(String.fromCharCode.apply(null, new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function rnd(n) { var a = new Uint8Array(n); crypto.getRandomValues(a); return b64url(a).slice(0, n); }
  // 中身の印（同じ中身なら送らない・競合にしない）。git の blob sha と同じ計算
  function hash(t) {
    var body = bytes(t), head = bytes('blob ' + body.length + '\0'), all = new Uint8Array(head.length + body.length);
    all.set(head); all.set(body, head.length);
    return crypto.subtle.digest('SHA-1', all).then(function (h) { return Array.prototype.map.call(new Uint8Array(h), function (x) { return (x < 16 ? '0' : '') + x.toString(16); }).join(''); });
  }

  // ---- ファイル名 ----
  // 1行目を題名にする。Windows（OneDrive）で使えない文字・末尾の点や空白は除く
  function baseName(t) {
    var l = M.meta(t).t.replace(/<\/?u>/g, '').split('\n').map(function (x) { return x.replace(/^```.*$/, '').replace(/^#+\s+/, '').replace(/^（競合: .*）$/, '').trim(); }).filter(Boolean)[0] || '';
    l = l.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').slice(0, 50).replace(/[.\s]+$/, '').replace(/^[.\s]+/, '');
    if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(l)) l = l + '_';
    return l || '無題';
  }
  function stem(p) { return base(p).replace(/\.(md|txt)$/i, '').replace(/ \(\d+\)$/, ''); }
  // 今の名前の題名が変わっていなければそのまま。変わったら空いている名前を探す（大文字小文字は同じと見なす）。
  // PC やほかのアプリで人が付けた名前（前の題名と違う名前）は変えない。前の置き場所のものは、その名前のまま移す
  function wantName(id, m, taken) {
    var b = baseName(m.t), e = S.map[id], own = e && stem(e.p) !== e.b;
    if (e && !e.out && (stem(e.p) === b || own)) return e.p;
    if (own) b = stem(e.p);
    var name = b + '.md', n = 2;
    while (taken[name.toLowerCase()] && taken[name.toLowerCase()] !== id) name = b + ' (' + (n++) + ').md';
    return name;
  }

  // =====================================================================
  // OneDrive（Microsoft Graph）
  // サインインは「認可コード + PKCE」（栞・ノートと同じ）。秘密鍵は持たない。
  // 更新用トークンで黙ってつなぎ直す。Microsoft の決まりでブラウザ用は 24 時間で切れるので、
  // 切れたら起動直後に一度だけ「画面を出さないサインイン」を試す（Microsoft 側にログインが残っていれば戻ってくる）。
  // =====================================================================
  var GRAPH = 'https://graph.microsoft.com/v1.0';
  var LOGIN = 'https://login.microsoftonline.com/common/oauth2/v2.0/';
  var SCOPE = 'Files.ReadWrite offline_access';
  function redirect() { return location.origin + location.pathname; }
  function odTok() { try { return JSON.parse(LS.getItem(OTK)) || {}; } catch (e) { return {}; } }

  function odSignIn(silent) {
    M.save();
    var v = rnd(64), st = rnd(16);
    LS.setItem(OPK, JSON.stringify({ v: v, s: st, silent: !!silent, t: Date.now() }));
    if (silent) LS.setItem(OSK, String(Date.now()));
    return crypto.subtle.digest('SHA-256', bytes(v)).then(function (d) {
      var u = new URL(LOGIN + 'authorize');
      u.searchParams.set('client_id', S.cid);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('redirect_uri', redirect());
      u.searchParams.set('scope', SCOPE);
      u.searchParams.set('code_challenge', b64url(d));
      u.searchParams.set('code_challenge_method', 'S256');
      u.searchParams.set('state', st);
      if (silent) u.searchParams.set('prompt', 'none');
      location.assign(u.toString());
    });
  }
  function odExchange(body) {
    return fetch(LOGIN + 'token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(Object.assign({ client_id: S.cid, scope: SCOPE }, body)),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw E(j.error_description || j.error || ('サインインに失敗しました（' + r.status + '）'), r.status);
        var t = odTok();
        t.at = j.access_token; t.exp = Date.now() + (Number(j.expires_in || 3600) - 120) * 1000;
        if (j.refresh_token) t.rt = j.refresh_token;
        LS.setItem(OTK, JSON.stringify(t));
        return t.at;
      });
    });
  }
  // 起動時: サインインから戻ってきていれば受け取る
  function odFinish() {
    var q = new URLSearchParams(location.search), code = q.get('code'), er = q.get('error');
    if (!code && !er) return Promise.resolve();
    history.replaceState(null, '', location.pathname);
    var pk = null; try { pk = JSON.parse(LS.getItem(OPK)); } catch (e) { }
    LS.removeItem(OPK);
    if (!S || S.kind !== 'onedrive') return Promise.resolve();
    if (er) {
      // 画面を出さないサインインが「操作が要る」と返ってきたときは黙ってバーに「サインイン」を出す
      if (!(pk && pk.silent)) M.toast('サインインできませんでした: ' + (q.get('error_description') || er).split('\n')[0].slice(0, 80));
      need = 'signin'; return Promise.resolve();
    }
    if (!pk || pk.s !== q.get('state')) { M.toast('サインインの照合に失敗しました。もう一度サインインしてください'); need = 'signin'; return Promise.resolve(); }
    return odExchange({ grant_type: 'authorization_code', code: code, redirect_uri: redirect(), code_verifier: pk.v })
      .then(function () { need = ''; if (!pk.silent) M.toast('OneDrive につながりました'); },
        function (x) { need = 'signin'; M.toast(x.message); });
  }
  function odToken() {
    var t = odTok();
    if (t.at && Date.now() < t.exp) return Promise.resolve(t.at);
    if (!t.rt) return Promise.reject(E('サインインが必要です', 401));
    return odExchange({ grant_type: 'refresh_token', refresh_token: t.rt }).catch(function (x) {
      if (x.status === 400 || x.status === 401) { var u = odTok(); delete u.rt; delete u.at; LS.setItem(OTK, JSON.stringify(u)); throw E('サインインが必要です', 401); }
      throw x;
    });
  }
  function od(path, opt, raw) {
    var go = function (retry) {
      return odToken().then(function (at) {
        var o = Object.assign({}, opt || {});
        o.headers = Object.assign({ Authorization: 'Bearer ' + at }, (opt && opt.headers) || {});
        o.cache = 'no-store';
        return fetch(path.indexOf('https://') === 0 ? path : GRAPH + path, o);
      }).then(function (r) {
        if (r.status === 401 && retry) { var u = odTok(); delete u.at; LS.setItem(OTK, JSON.stringify(u)); return go(false); }
        if (!r.ok) return r.text().then(function (b) { var m = ''; try { m = JSON.parse(b).error.message; } catch (e) { m = b.slice(0, 120); } throw E('OneDrive ' + r.status + ' ' + m, r.status); });
        if (raw) return r;
        return r.status === 204 ? null : r.json();
      });
    };
    return go(true);
  }
  function enc(name) { return name.split('/').map(encodeURIComponent).join('/'); }
  // 置き場所の書き方: Windows のパス・OneDrive の中のパス・共有リンク（1drv.ms / onedrive.live.com）
  function odPlace(v) {
    v = String(v || '').trim().replace(/^"|"$/g, '');
    if (/^https?:\/\//i.test(v)) return { link: v };
    return { path: v.replace(/\\/g, '/').replace(/^[a-z]:\/.*?\/onedrive[^/]*\//i, '').replace(/^\/+|\/+$/g, '') || DEF_OD };
  }
  // フォルダを見つける（無ければ作る）
  function odFolder() {
    if (S.folder && S.folder.id) return Promise.resolve(S.folder);
    var pl = odPlace(S.place), got;
    if (pl.link) {
      var sid = 'u!' + btoa(unescape(encodeURIComponent(pl.link))).replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
      got = od('/shares/' + sid + '/driveItem');
    } else {
      got = od('/me/drive/root:/' + enc(pl.path)).catch(function (x) {
        if (x.status !== 404) throw x;
        var i = pl.path.lastIndexOf('/'), parent = i < 0 ? '/me/drive/root' : '/me/drive/root:/' + enc(pl.path.slice(0, i)) + ':';
        return od(parent + '/children', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: pl.path.slice(i + 1), folder: {}, '@microsoft.graph.conflictBehavior': 'fail' }) });
      });
    }
    return got.then(function (it) {
      if (!it.folder) throw E('そこはフォルダではありません', 0);
      S.folder = { drive: it.parentReference.driveId, id: it.id, name: it.name, web: it.webUrl || '' }; saveS();
      return S.folder;
    });
  }
  function odItem(k) { return '/drives/' + S.folder.drive + '/items/' + k; }
  var OD = {
    label: 'OneDrive',
    ready: function () { return odFolder(); },
    list: function () {
      var out = [];
      var page = function (url) {
        return od(url).then(function (r) {
          (r.value || []).forEach(function (x) {
            if (x.file && /\.(md|txt)$/i.test(x.name)) out.push({ k: x.id, p: x.name, v: x.cTag || x.eTag, et: x.eTag });
          });
          return r['@odata.nextLink'] ? page(r['@odata.nextLink']) : out;
        });
      };
      return odFolder().then(function () { return page(odItem(S.folder.id) + '/children?$select=id,name,eTag,cTag,file&$top=999'); });
    },
    read: function (f) { return od(odItem(f.k) + '/content', null, true).then(function (r) { return r.text(); }); },
    put: function (name, text, e) {
      var up = function (r) { return { k: r.id, p: r.name, v: r.cTag || r.eTag, et: r.eTag }; };
      if (e && !e.out) {
        // 中身を書き換える（読んだ版のときだけ。間に別の端末が書いていれば 412 で断られる）
        return od(odItem(e.k) + '/content', { method: 'PUT', headers: { 'Content-Type': 'text/plain; charset=utf-8', 'If-Match': e.et }, body: text }).then(function (r) {
          if (r.name === name) return up(r);
          // 題名が変わった: 名前を変える（同じ名前があれば今の名前のまま）
          return od(odItem(e.k), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name, '@microsoft.graph.conflictBehavior': 'fail' }) })
            .then(up, function (x) { if (x.status === 409) return up(r); throw x; });
        });
      }
      // 新しく作る（同じ名前があれば (2)…を付ける）
      var stemName = name.replace(/\.md$/i, '');
      var make = function (n) {
        var nm = n ? stemName + ' (' + n + ').md' : name;
        return od(odItem(S.folder.id) + ':/' + encodeURIComponent(nm) + ':/content?@microsoft.graph.conflictBehavior=fail',
          { method: 'PUT', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: text })
          .then(up, function (x) { if (x.status === 409 && n < 50) return make((n || 1) + 1); throw x; });
      };
      return make(0).then(function (r) {
        // 前の置き場所（GitHub など）から移したものは、ここでは古い方を消さない（置き場所が別なので）
        return r;
      });
    },
    remove: function (e) {
      // ごみ箱に入る（OneDrive から戻せる）
      return od(odItem(e.k), { method: 'DELETE' }).then(function () { }, function (x) { if (x.status !== 404) throw x; });
    },
    conflict: function (x) { return x.status === 412 || x.status === 409; },
    // 画像（フォルダの中の 画像/）。名前は作るたびに新しいので、中身は書き換えない
    ilist: function () {
      var out = {};
      var page = function (url) {
        return od(url).then(function (r) {
          (r.value || []).forEach(function (x) { if (x.file) out[x.name] = x.id; });
          return r['@odata.nextLink'] ? page(r['@odata.nextLink']) : out;
        });
      };
      return page(odItem(S.folder.id) + ':/' + encodeURIComponent(IDIR) + ':/children?$select=id,name,file&$top=999')
        .catch(function (x) { if (x.status === 404) return out; throw x; });
    },
    iget: function (k) { return od(odItem(k) + '/content', null, true).then(function (r) { return r.blob(); }); },
    iput: function (n, blob) {
      return od(odItem(S.folder.id) + ':/' + encodeURIComponent(IDIR) + '/' + encodeURIComponent(n) + ':/content?@microsoft.graph.conflictBehavior=replace',
        { method: 'PUT', headers: { 'Content-Type': blob.type || 'image/jpeg' }, body: blob });
    },
  };

  // =====================================================================
  // GitHub（非公開リポジトリ）
  // =====================================================================
  var GAPI = 'https://api.github.com/repos/';
  function gtok() { return LS.getItem(GTK) || ''; }
  function gh(path, opt, repo) {
    opt = opt || {};
    opt.headers = Object.assign({ Authorization: 'Bearer ' + gtok(), Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, opt.headers || {});
    opt.cache = 'no-store';
    return fetch(GAPI + (repo || S.repo) + path, opt).then(function (r) {
      if (r.status === 401) { need = 'token'; throw E('トークンが無効です（期限切れか、取り消された）', 401); }
      if (!r.ok) return r.text().then(function (b) { var m = ''; try { m = JSON.parse(b).message; } catch (e) { m = b.slice(0, 120); } throw E('GitHub ' + r.status + ' ' + m, r.status); });
      return r.status === 204 ? null : r.json();
    });
  }
  function json(method, body) { return { method: method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }; }
  function b64(t) { var b = bytes(t), s = ''; for (var i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); }
  function unb64(x) { var s = atob(x.replace(/\s/g, '')), b = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return new TextDecoder().decode(b); }
  var GH = {
    label: 'GitHub',
    ready: function () { return Promise.resolve(); },
    list: function () {
      return gh('/contents/' + enc(S.dir)).then(function (r) {
        return (Array.isArray(r) ? r : []).filter(function (x) { return x.type === 'file' && /\.(md|txt)$/i.test(x.name); })
          .map(function (x) { return { k: x.path, p: x.name, v: x.sha }; });
      }, function (e) {
        if (e.status === 409) return [];   // 空のリポジトリ
        if (e.status === 404) {            // フォルダがまだ無い。ただしリポジトリが見えない（権限が外れた）ときは空と取り違えない
          return gh('').then(function () { return []; }, function (x) {
            if (x.status === 404) throw E('リポジトリが見えません（トークンの権限を確認してください）。同期を中止しました', 404);
            throw x;
          });
        }
        throw e;
      });
    },
    read: function (f) { return gh('/git/blobs/' + f.v).then(function (b) { return unb64(b.content); }); },
    put: function (name, text, e) {
      var to = S.dir + '/' + name, same = e && e.k === to;
      var body = { message: (same ? 'update: ' : 'add: ') + to + ' (wataamemo)', content: b64(text) };
      if (same) body.sha = e.v;
      return gh('/contents/' + enc(to), json('PUT', body)).then(function (r) {
        var res = { k: to, p: name, v: r.content.sha };
        if (!e || same) return res;
        // 題名が変わった・前の置き場所から移す: 新しい名前で書いてから古いファイルを消す
        return gh('/contents/' + enc(e.k), json('DELETE', { message: 'rename: ' + e.k + ' → ' + to + ' (wataamemo)', sha: e.v }))
          .then(function () { return res; }, function (x) { if (x.status !== 404 && x.status !== 409 && x.status !== 422) throw x; return res; });
      });
    },
    remove: function (e) {
      return gh('/contents/' + enc(e.k), json('DELETE', { message: 'delete: ' + e.k + ' (wataamemo)', sha: e.v }))
        .then(function () { }, function (x) { if (x.status !== 404) throw x; });
    },
    conflict: function (x) { return x.status === 409 || x.status === 422; },
    ilist: function () {
      return gh('/contents/' + enc(S.dir + '/' + IDIR)).then(function (r) {
        var out = {};
        (Array.isArray(r) ? r : []).forEach(function (x) { if (x.type === 'file') out[x.name] = x.sha; });
        return out;
      }, function (x) { if (x.status === 404) return {}; throw x; });
    },
    iget: function (sha) {
      return gh('/git/blobs/' + sha).then(function (b) {
        var s = atob(b.content.replace(/\s/g, '')), u = new Uint8Array(s.length);
        for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
        return new Blob([u], { type: 'image/jpeg' });
      });
    },
    iput: function (n, blob) {
      return blob.arrayBuffer().then(function (buf) {
        var b = new Uint8Array(buf), s = '';
        for (var i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
        var to = S.dir + '/' + IDIR + '/' + n;
        return gh('/contents/' + enc(to), json('PUT', { message: 'add: ' + to + ' (wataamemo)', content: btoa(s) }))
          .catch(function (x) { if (x.status !== 422) throw x; });   // もうある
      });
    },
  };

  // ---- 画像: メモが使っている画像のうち、こちらにだけある物を送り、向こうにだけある物を受け取る ----
  function syncImages() {
    if (!M.img) return;
    var want = {};
    M.all().forEach(function (m) { M.meta(m.t).im.forEach(function (n) { want[n] = 1; }); });
    var names = Object.keys(want);
    if (!names.length) return;
    var b = B(), got = false;
    return Promise.all([b.ilist(), M.img.keys()]).then(function (x) {
      var rem = x[0], loc = {};
      (x[1] || []).forEach(function (k) { loc[k] = 1; });
      return names.reduce(function (p, n) {
        return p.then(function () {
          if (loc[n] && !rem[n]) return M.img.get(n).then(function (bl) { if (bl) return b.iput(n, bl); });
          if (!loc[n] && rem[n]) return b.iget(rem[n]).then(function (bl) { got = true; return M.img.put(n, bl); });
        });
      }, Promise.resolve());
    }).then(function () { if (got) M.imgs(); });
  }

  function B() { return S && S.kind === 'onedrive' ? OD : GH; }
  function connected() { return !!(S && (S.kind === 'onedrive' ? S.cid : S.repo)); }
  function canRun() {
    if (!connected()) return false;
    if (S.kind === 'onedrive') return !!odTok().rt || !!(odTok().at && Date.now() < odTok().exp);
    return !!gtok() && need !== 'token';
  }

  // ---- 同期本体: 先に向こうの変更を取り込み、次にたまった変更を送る ----
  function run() {
    clearTimeout(kT);
    if (!connected()) return Promise.resolve();
    if (running) { again = true; return Promise.resolve(); }
    if (!navigator.onLine || !canRun()) { ui(); return Promise.resolve(); }
    // 複数のタブで同時に走らせない
    if (navigator.locks) return navigator.locks.request('memo-sync', { ifAvailable: true }, function (l) { return l ? body() : null; });
    return body();
  }

  function body() {
    running = true; ui();
    M.save();   // 書きかけを先に保存して送信待ちに入れる（取り込みで上書きしないため）
    var b = B(), changed = [], conflicts = 0, now = Date.now(), taken = {};
    return b.ready().then(b.list).then(function (files) {
      var q = M.getQ(), seen = {}, byKey = {};
      Object.keys(S.map).forEach(function (id) { byKey[S.map[id].k] = id; });
      files.forEach(function (f) { taken[f.p.toLowerCase()] = byKey[f.k] || '?'; seen[f.k] = 1; });
      // 一覧が空、または対応付け済みの大半が消えて見えるときは、向こうで消されたと決めつけず中止する
      var mapped = Object.keys(S.map).filter(function (id) { return !S.map[id].out; });
      var gone = mapped.filter(function (id) { return !seen[S.map[id].k]; }).length;
      if (mapped.length >= 5 && gone * 2 >= mapped.length) throw E(b.label + ' 上のメモの一覧が空、または大半が見えません（' + mapped.length + '件中' + gone + '件）。端末のメモを守るため同期を中止しました', 0);
      return files.reduce(function (p, f) {
        return p.then(function () {
          var id = byKey[f.k];
          if (!id) {
            // よそ（別の端末・PC・ほかのアプリ）で作られたファイル
            return b.read(f).then(function (text) {
              var nid = M.nid();
              M.putRaw(nid, { t: text, c: now, u: now });
              return hash(text).then(function (h) {
                S.map[nid] = { k: f.k, p: f.p, v: f.v, et: f.et, b: baseName(text), h: h }; taken[f.p.toLowerCase()] = nid; changed.push(nid);
              });
            });
          }
          var e = S.map[id];
          if (e.p !== f.p) e.p = f.p;                    // よそで名前を変えた（その名前に合わせる）
          e.et = f.et;
          if (e.v === f.v) return;                       // 変わっていない
          if (q.del[id]) return;                         // 手元で消した。送る段で消す
          var local = M.get(id);
          return b.read(f).then(function (text) {
            return hash(text).then(function (h) {
              if (local && local.t === text) { e.v = f.v; e.h = h; return; }   // 中身は同じ
              if (q.dirty[id] && local) {
                // 両方で変わった: 手元の版はそのまま送る。向こうの版は別のメモとして残す
                M.setM(M.nid(), { t: '（競合: 別の端末の版）\n' + text, c: now, u: now }); conflicts++;
              } else {
                M.putRaw(id, { t: text, c: local ? local.c : now, u: now });
                changed.push(id); e.b = baseName(text);
              }
              e.v = f.v; e.h = h;
            });
          });
        });
      }, Promise.resolve()).then(function () {
        // 向こうで消されたファイル
        Object.keys(S.map).forEach(function (id) {
          var e = S.map[id];
          if (seen[e.k] || e.out) return;                // 前の置き場所のものは一覧に入らない。送る段で移す
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
          if (!e || e.out) { delete S.map[id]; M.unq(id, 'del'); return; }
          return b.remove(e).then(function () { delete S.map[id]; saveS(); M.unq(id, 'del'); }, function (x) {
            if (b.conflict(x)) { again = true; return; }   // 取り込んだ後に向こうで変わった。次の回に
            throw x;
          });
        });
      }, Promise.resolve());
      return Object.keys(q.dirty).reduce(function (p, id) {
        return p.then(function () {
          var m = M.get(id);
          if (!m) { M.unq(id, 'dirty'); return; }
          var e = S.map[id], name = wantName(id, m, taken);
          return hash(m.t).then(function (h) {
            if (e && !e.out && e.p === name && e.h === h) { M.unq(id, 'dirty'); return; }   // 変わっていない
            return b.put(name, m.t, e).then(function (r) {
              if (e && e.p !== r.p) delete taken[e.p.toLowerCase()];
              taken[r.p.toLowerCase()] = id;
              S.map[id] = { k: r.k, p: r.p, v: r.v, et: r.et, b: baseName(m.t), h: h }; saveS();
              var m2 = M.get(id);
              if (!m2 || m2.u === m.u) M.unq(id, 'dirty');   // 送っている間に書き足されたら、次の回にもう一度送る
            }, function (x) {
              if (b.conflict(x)) { again = true; return; }   // 向こうが先に変わった。次の回に取り込んで競合として扱う
              throw x;
            });
          });
        });
      }, p);
    }).then(syncImages).then(function () {
      S.last = Date.now(); err = ''; need = ''; saveS();
      changed.forEach(M.remote);
      if (conflicts) M.toast('別の端末と同時に書き換えたメモが' + conflicts + '件あり、両方を残しました');
    }, function (x) {
      if (x.status === 401) { need = S.kind === 'onedrive' ? 'signin' : 'token'; err = ''; if (S.kind === 'onedrive') silentSoon(); }
      else err = x.message || String(x);
    }).then(function () {
      running = false; ui(); refresh();
      if (again) { again = false; kT = setTimeout(run, 800); }
    });
  }

  // ---- 表示 ----
  function pending() { var q = M.getQ(); return Object.keys(q.dirty).length + Object.keys(q.del).length; }
  function ui() {
    var sy = M.sy;
    if (!connected()) { sy.hidden = true; return; }
    var n = pending(), tail = n ? ' · 未送信' + n : '';
    sy.hidden = false;
    var who = S.kind === 'onedrive' ? (need === 'signin' || !canRun() ? 'サインイン' : '') : (need === 'token' || !gtok() ? 'トークン無効' : '');
    sy.textContent = running ? '同期中' : who ? who + tail : !navigator.onLine ? 'オフライン' + tail : err ? '同期エラー' + tail : n ? '未送信' + n : '同期済';
    sy.title = err || (S.last ? '最終同期 ' + M.fmt(S.last) : '');
  }

  // read（栞）に OneDrive のクライアント ID があれば借りる（同じサイトなので読める）
  function detectCid() {
    if (!window.indexedDB || !indexedDB.databases) return Promise.resolve('');
    return indexedDB.databases().then(function (list) {
      if (!list.some(function (d) { return d.name === 'shiori'; })) return '';   // 無い DB を open すると空の DB ができてしまう
      return new Promise(function (ok) {
        var r = indexedDB.open('shiori');
        r.onerror = function () { ok(''); };
        r.onsuccess = function () {
          var db = r.result;
          try {
            var g = db.transaction('settings').objectStore('settings').get('onedriveClientId');
            g.onsuccess = function () { db.close(); ok((g.result && g.result.v) || ''); };
            g.onerror = function () { db.close(); ok(''); };
          } catch (e) { db.close(); ok(''); }
        };
      });
    }).catch(function () { return ''; });
  }

  // ---- 設定画面 ----
  var pv = null, mode = 'github';
  function panel() {
    if (!pv) {
      var st = document.createElement('style');
      st.textContent = '#syp{position:fixed;inset:0;z-index:11;background:var(--bg);overflow:auto;display:none}#syp.on{display:block}' +
        '#syp .in{max-width:660px;margin:0 auto;padding:calc(20px + env(safe-area-inset-top)) 24px calc(32px + env(safe-area-inset-bottom))}' +
        '#syp .hd{display:flex;align-items:center;justify-content:space-between;height:52px}#syp .hd b{font-weight:500;letter-spacing:.06em}' +
        '#syp .hd button{width:44px;height:44px;margin-right:-12px;color:var(--sub);font-size:20px}' +
        '#syp p{font-size:14px;color:var(--sub);margin:14px 0;line-height:1.8}#syp p b{color:var(--fg);font-weight:500}' +
        '#syp label{display:block;font-size:12px;letter-spacing:.06em;color:var(--sub);margin-top:22px}' +
        '#syp input{width:100%;padding:6px 0;border:0;border-bottom:1px solid var(--faint);background:none;color:inherit;font:15px/1.6 ui-monospace,Menlo,Consolas,monospace;outline:0;border-radius:0}' +
        '#syp input:focus{border-color:var(--sub)}#syp code{font:12px ui-monospace,Menlo,Consolas,monospace;color:var(--fg);word-break:break-all}' +
        '#syp a{color:var(--fg);text-underline-offset:4px}' +
        '#syp .tabs{display:flex;gap:24px;margin:6px 0 4px;border-bottom:1px solid var(--faint)}' +
        '#syp .tabs button{padding:10px 0;font-size:14px;color:var(--sub);border-bottom:2px solid transparent;margin-bottom:-1px}' +
        '#syp .tabs button.on{color:var(--fg);border-color:var(--fg)}' +
        '#syp .bt{display:flex;flex-wrap:wrap;gap:8px 28px;margin-top:28px}#syp .bt button{padding:6px 0;font-size:14px;letter-spacing:.04em;color:var(--fg);text-decoration:underline;text-underline-offset:4px}' +
        '#syp .bt .dim{color:var(--sub)}#syp ol{font-size:13px;color:var(--sub);padding-left:1.4em;line-height:1.9;margin-top:10px}#syp ol li{margin:4px 0}';
      document.head.appendChild(st);
      pv = document.createElement('div'); pv.id = 'syp';
      pv.innerHTML = '<div class="in"><div class="hd"><b>どの端末でも同じメモにする</b><button aria-label="閉じる">×</button></div><div class="bd"></div></div>';
      document.body.appendChild(pv);
      pv.querySelector('.hd button').onclick = function () { pv.className = ''; };
      pv.addEventListener('click', function (e) {
        var a = e.target.getAttribute && e.target.getAttribute('data-a');
        if (!a) return;
        if (a === 'tab-od') { mode = 'onedrive'; refresh(); }
        else if (a === 'tab-gh') { mode = 'github'; refresh(); }
        else if (a === 'connect-od') connectOD();
        else if (a === 'connect-gh') connectGH();
        else if (a === 'sync') { need = ''; run(); }
        else if (a === 'signin') odSignIn(false);
        else if (a === 'retoken') { S.editTok = true; refresh(); }
        else if (a === 'off') {
          if (!confirm('同期をやめますか？ 端末のメモも、' + B().label + ' のファイルも残ります。')) return;
          LS.removeItem(SK); LS.removeItem(GTK); LS.removeItem(OTK); S = null; need = ''; err = ''; ui(); refresh();
        }
      });
    }
    pv.className = 'on';
    refresh();
  }
  function val(id) { var x = pv.querySelector(id); return x ? x.value.trim() : ''; }

  function connectOD() {
    var cid = val('#oc'), place = val('#op') || DEF_OD;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cid)) { M.toast('クライアント ID の形が違います（xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx）'); return; }
    S = { kind: 'onedrive', cid: cid, place: place, map: {}, last: 0, v: 4 };
    saveS(); LS.removeItem(OTK); LS.removeItem(OSK); markAll();   // 手元のメモを全部送る
    odSignIn(false);
  }
  // 接続: リポジトリが非公開で、トークンで読めることを確かめてから始める
  function connectGH() {
    var repo = (val('#gr') || (S && S.repo) || '').replace(/^https:\/\/github\.com\//, '').replace(/\.git$|\/$/g, '');
    var dir = (pv.querySelector('#gd') ? val('#gd') : S.dir).replace(/^"|"$/g, '').replace(/\\/g, '/').replace(/^[a-z]:\/.*?\/onedrive[^/]*\//i, '').replace(/^\/+|\/+$/g, '');
    var t = val('#gt');
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { M.toast('リポジトリは「持ち主/名前」の形で書きます'); return; }
    if (!dir || /(^|\/)\.\.?(\/|$)|^\./.test(dir)) { M.toast('置き場所のフォルダを書いてください（. で始まる名前は使えません）'); return; }
    if (!t) { M.toast('トークンを貼ってください'); return; }
    var old = gtok(); LS.setItem(GTK, t); need = '';
    gh('', null, repo).then(function (r) {
      if (!r.private) { if (old) LS.setItem(GTK, old); else LS.removeItem(GTK); M.toast('公開リポジトリです。メモが誰でも読めてしまうので使いません'); return; }
      if (!S || S.kind !== 'github' || S.repo !== repo || S.dir !== dir) { S = { kind: 'github', repo: repo, dir: dir, map: {}, last: 0, v: 4 }; markAll(); }
      delete S.editTok; saveS(); err = '';
      M.toast('つながりました'); ui(); refresh(); run();
    }, function (x) {
      if (old) LS.setItem(GTK, old); else LS.removeItem(GTK);
      M.toast(x.status === 404 ? 'リポジトリが見つかりません（名前か、トークンの対象リポジトリを確認）' : x.message);
    });
  }

  function esc(t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }
  function where() {
    if (S.kind === 'onedrive') return 'OneDrive\\' + (S.folder && S.folder.name ? S.folder.name : (odPlace(S.place).path || 'リンクのフォルダ').replace(/\//g, '\\'));
    return S.repo === DEF_REPO ? 'OneDrive\\' + S.dir.replace(/\//g, '\\') + '（' + S.repo + ' 経由）' : S.repo + ' / ' + S.dir;
  }
  function refresh() {
    if (!pv || !pv.className) return;
    var bd = pv.querySelector('.bd');
    if (connected() && !S.editTok) {
      var n = pending(), link = S.kind === 'onedrive' ? (S.folder && S.folder.web) : 'https://github.com/' + S.repo + '/tree/HEAD/' + enc(S.dir);
      bd.innerHTML = '<p>置き場所 <b>' + esc(where()) + '</b>' + (link ? '　<a href="' + esc(link) + '" target="_blank" rel="noopener">開く</a>' : '') + '</p>' +
        '<p>状態 <b>' + esc(M.sy.textContent) + '</b></p>' +
        '<p>最終同期 <b>' + (S.last ? M.fmt(S.last) : 'まだ') + '</b>　未送信 <b>' + n + '件</b></p>' +
        (err ? '<p>' + esc(err) + '</p>' : '') +
        (S.kind === 'onedrive' && !canRun() ? '<p>Microsoft のサインインが切れています（ブラウザ用は 24 時間で切れる決まり）。「サインイン」で戻ります。その間も書けて、変更はたまります。</p>' : '') +
        '<div class="bt">' + (canRun() ? '<button data-a="sync">今すぐ同期</button>' : '') +
        (S.kind === 'onedrive' ? '<button data-a="signin">サインイン' + (canRun() ? 'し直す' : '') + '</button>' : '<button data-a="retoken">トークンを貼り直す</button>') +
        '<button class="dim" data-a="off">同期をやめる・置き場所を変える</button></div>';
      return;
    }
    if (S && S.editTok) {
      bd.innerHTML = '<p>新しいトークンを貼ってください。</p><label for="gt">トークン</label><input id="gt" type="password" spellcheck="false" autocomplete="off" autocapitalize="off" placeholder="github_pat_…">' +
        '<div class="bt"><button data-a="connect-gh">つなぐ</button></div>';
      return;
    }
    var tabs = '<div class="tabs"><button data-a="tab-gh" class="' + (mode === 'github' ? 'on' : '') + '">GitHub 経由（おすすめ）</button><button data-a="tab-od" class="' + (mode === 'onedrive' ? 'on' : '') + '">OneDrive に直接</button></div>';
    if (mode === 'onedrive') {
      bd.innerHTML = tabs +
        '<p>wataamemo から <b>OneDrive のフォルダ</b>を直接読み書きします。PC が動いていなくても全端末でそろいます。</p>' +
        '<p><b>Microsoft Entra（Azure）のアプリ登録が要ります。</b>個人の Microsoft アカウントだけでは登録できず'+
        '（「AADSTS16000」と出る）、Azure の無料アカウント（カードと電話番号での本人確認）でディレクトリを作る必要があります。'+
        '登録できない場合は「GitHub 経由」を使ってください。</p>' +
        '<label for="op">フォルダ（C:\\Users\\…\\OneDrive\\… のパス、OneDrive の中の名前、共有リンクのどれでもよい）</label>' +
        '<input id="op" spellcheck="false" autocomplete="off" autocapitalize="off" value="' + esc(DEF_OD) + '">' +
        '<label for="oc">クライアント ID（Microsoft Entra に登録したアプリの ID）</label>' +
        '<input id="oc" spellcheck="false" autocomplete="off" autocapitalize="off" placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx">' +
        '<p>栞（read）の OneDrive 取り込みで登録したものがあれば、それを使えます（あれば自動で入ります）。無ければ最初に1回だけ登録します:</p>' +
        '<ol><li><a href="https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noopener">Microsoft Entra のアプリの登録</a> → 新規登録（名前は wataamemo など）</li>' +
        '<li>サポートされるアカウントの種類: <b>個人用 Microsoft アカウント</b>を含むもの</li>' +
        '<li>リダイレクト URI: <b>シングルページ アプリケーション (SPA)</b> を選び、次の2つを登録する（2つ目は「認証」の画面で足す）<br>' +
        '<code>https://aji-daze.github.io/kb-cso/memo/</code>（Web 版）<br><code>https://appassets.androidplatform.net/memo/index.html</code>（Android アプリ）</li>' +
        '<li>「API のアクセス許可」に Microsoft Graph の <b>Files.ReadWrite</b> があることを確かめる（無ければ足す）</li>' +
        '<li>概要ページの「アプリケーション (クライアント) ID」を上に貼る</li></ol>' +
        '<div class="bt"><button data-a="connect-od">サインインしてつなぐ</button></div>';
      detectCid().then(function (id) { var i = pv.querySelector('#oc'); if (id && i && !i.value) i.value = id; });
    } else {
      bd.innerHTML = tabs +
        '<p>メモを非公開リポジトリ <b>pomera-data</b> の <b>メモ-wataamemo</b> に、1件1ファイルの「題名.md」で置き、どの端末でも同じ中身にします。' +
        'トークンは pomenote・notes と同じものでよい。電波がない間の変更は端末にためて、つながったら送ります。</p>' +
        '<p>PC の <b>OneDrive\\メモ-wataamemo</b> にも置くには、PC に <a href="pc/wataamemo_sync.py" target="_blank" rel="noopener">PC 用の同期（wataamemo_sync）</a> を入れます。' +
        '5分ごとに GitHub と OneDrive のフォルダをそろえ、PC で書き換えたものもスマホに届きます（入れ方は README）。</p>' +
        '<label for="gr">リポジトリ</label><input id="gr" spellcheck="false" autocomplete="off" autocapitalize="off" value="' + DEF_REPO + '">' +
        '<label for="gd">置き場所（リポジトリの中のフォルダ）</label><input id="gd" spellcheck="false" autocomplete="off" autocapitalize="off" value="' + DEF_DIR + '">' +
        '<label for="gt">トークン（pomenote / notes のものでよい）</label><input id="gt" type="password" spellcheck="false" autocomplete="off" autocapitalize="off" placeholder="github_pat_…">' +
        '<div class="bt"><button data-a="connect-gh">つなぐ</button></div>';
    }
  }

  // ---- いつ同期するか ----
  function kick() { ui(); clearTimeout(kT); kT = setTimeout(run, 3000); }   // 書いてから3秒止まったら
  addEventListener('online', function () { run(); });
  addEventListener('offline', ui);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && S && Date.now() - (S.last || 0) > 20000) run(); });
  setInterval(function () { if (!document.hidden && S && Date.now() - (S.last || 0) > 60000) run(); }, 30000);

  window.MemoSync = {
    kick: kick, run: run, panel: panel,
    tap: function () { if (S && S.kind === 'onedrive' && !canRun()) odSignIn(false); else panel(); },
  };

  // OneDrive のサインインが切れていたら、起動直後で、まだ何も打っていないときだけ
  // 画面を出さないサインインを一度試す（6時間に1回まで。Microsoft 側にログインが残っていればすぐ戻ってくる）
  function silentSoon() {
    if (!S || S.kind !== 'onedrive' || !S.cid || !navigator.onLine || typed) return false;
    if (Date.now() - loadedAt > 8000 || Date.now() - Number(LS.getItem(OSK) || 0) < 6 * 3600e3) return false;
    odSignIn(true); return true;
  }
  odFinish().then(function () {
    ui();
    if (S && S.kind === 'onedrive' && !canRun() && silentSoon()) return;
    setTimeout(run, 300);
  });
})();
