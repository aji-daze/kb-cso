// OneDrive からの取り込み（任意機能）。Microsoft Graph を使う。
//
// 認証は「認可コード + PKCE」。ブラウザだけで完結し、秘密鍵（client secret）は持たない。
// 一度つなぐと更新用のトークンを端末に置くので、次からは黙ってつながる。
// トークンはこの端末の IndexedDB にだけ入る。どこにも送らない。
import * as DB from './db.js';

export const key = 'onedrive';
export const label = 'OneDrive';

const AUTH = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
const TOKEN = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const SCOPE = 'Files.Read offline_access User.Read';
const VERIFIER_KEY = 'shiori.od.verifier';
const STATE_KEY = 'shiori.od.state';

export const redirectUri = () => location.origin + location.pathname;

let token = null;
let tokenExp = 0;

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function randomString(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return b64url(a).slice(0, n);
}

async function challenge(verifier) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(d);
}

export const hasToken = () => !!token && Date.now() < tokenExp;

// 認証画面へ飛ばす。戻ってきたときは finishSignIn() が受け取る。
export async function connect(clientId) {
  if (!clientId) throw new Error('クライアント ID が設定されていません');
  const verifier = randomString(64);
  const state = randomString(16);
  try {
    sessionStorage.setItem(VERIFIER_KEY, verifier);
    sessionStorage.setItem(STATE_KEY, state);
  } catch {
    throw new Error('この画面では認証を保持できません（プライベートモード？）');
  }
  const u = new URL(AUTH);
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', redirectUri());
  u.searchParams.set('scope', SCOPE);
  u.searchParams.set('code_challenge', await challenge(verifier));
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', state);
  location.assign(u.toString());
  // ここから先は戻ってくるまで進まない
  return new Promise(() => {});
}

async function exchange(clientId, body) {
  const r = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, scope: SCOPE, ...body }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error_description || j.error || ('トークンの取得に失敗しました（HTTP ' + r.status + '）'));
  token = j.access_token;
  tokenExp = Date.now() + (Number(j.expires_in || 3600) - 60) * 1000;
  if (j.refresh_token) await DB.setting('onedriveRefresh', j.refresh_token);
  return token;
}

// 起動時に呼ぶ。認証から戻ってきていれば受け取って、URL を掃除する。
export async function finishSignIn() {
  const q = new URLSearchParams(location.search);
  const code = q.get('code');
  const err = q.get('error');
  if (!code && !err) return null;

  const clean = () => history.replaceState(null, '', location.pathname);
  if (err) { clean(); return { ok: false, message: q.get('error_description') || err }; }

  const state = q.get('state');
  let verifier = null, want = null;
  try {
    verifier = sessionStorage.getItem(VERIFIER_KEY);
    want = sessionStorage.getItem(STATE_KEY);
    sessionStorage.removeItem(VERIFIER_KEY);
    sessionStorage.removeItem(STATE_KEY);
  } catch { /* 取れなければ下で弾く */ }
  clean();

  if (!verifier) return { ok: false, message: '認証の途中経過が失われました。もう一度つないでください' };
  if (!want || want !== state) return { ok: false, message: '認証の照合に失敗しました。もう一度つないでください' };

  const clientId = await DB.setting('onedriveClientId');
  if (!clientId) return { ok: false, message: 'クライアント ID が見つかりません' };
  try {
    await exchange(clientId, { grant_type: 'authorization_code', code, redirect_uri: redirectUri(), code_verifier: verifier });
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

// 置いてある更新用トークンで黙ってつなぎ直す
export async function resume() {
  if (hasToken()) return true;
  const clientId = await DB.setting('onedriveClientId');
  const refresh = await DB.setting('onedriveRefresh');
  if (!clientId || !refresh) return false;
  try {
    await exchange(clientId, { grant_type: 'refresh_token', refresh_token: refresh });
    return true;
  } catch {
    await DB.del('settings', 'onedriveRefresh');
    return false;
  }
}

export async function signOut() {
  token = null; tokenExp = 0;
  await DB.del('settings', 'onedriveRefresh');
}

export async function linked() {
  return !!(await DB.setting('onedriveRefresh'));
}

async function api(url) {
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) throw new Error('OneDrive API エラー: ' + r.status);
  return r.json();
}

export async function list(folderId) {
  let url = folderId
    ? GRAPH + '/me/drive/items/' + encodeURIComponent(folderId) + '/children'
    : GRAPH + '/me/drive/root/children';
  url += '?$top=200&$select=id,name,size,folder,file,@microsoft.graph.downloadUrl';
  const out = [];
  while (url) {
    const j = await api(url);
    for (const it of (j.value || [])) {
      out.push({
        id: it.id,
        name: it.name,
        isFolder: !!it.folder,
        size: Number(it.size || 0),
        url: it['@microsoft.graph.downloadUrl'] || '',
      });
    }
    url = j['@odata.nextLink'] || '';
  }
  out.sort((a, b) => (b.isFolder - a.isFolder) || a.name.localeCompare(b.name, 'ja'));
  return out;
}

export async function download(item) {
  // downloadUrl は署名済みの一時 URL。ここに Authorization を付けると逆に弾かれる。
  let url = item.url;
  if (!url) {
    const j = await api(GRAPH + '/me/drive/items/' + encodeURIComponent(item.id) + '?$select=@microsoft.graph.downloadUrl');
    url = j['@microsoft.graph.downloadUrl'];
  }
  if (!url) throw new Error('ダウンロード用の URL が取れませんでした');
  const r = await fetch(url);
  if (!r.ok) throw new Error('ダウンロード失敗: ' + r.status);
  return r.blob();
}

export const setupText =
  '<b>初回だけ、自分の Microsoft アカウントでアプリを登録する必要があります。</b><br>' +
  '1. Azure ポータル → Microsoft Entra ID → <b>アプリの登録</b> → 新規登録<br>' +
  '2. サポートされるアカウントの種類は<b>「個人の Microsoft アカウントを含む」</b>を選ぶ<br>' +
  '3. リダイレクト URI は <b>SPA（シングルページアプリケーション）</b>を選び、<br>' +
  '　 <code>' + redirectUri() + '</code> を入れる（末尾のスラッシュまで一致させる）<br>' +
  '4. 概要ページの<b>アプリケーション (クライアント) ID</b> を下に貼る<br>' +
  'アクセス権は <code>Files.Read</code>（読み取り専用）です。OneDrive 側のファイルは変更しません。<br>' +
  '<b>「SPA」以外（Web など）を選ぶと、ブラウザからトークンを取れずに失敗します。</b>';
