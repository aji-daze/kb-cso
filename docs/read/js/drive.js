// Google ドライブからの取り込み（任意機能）。
// ミュージックの drive.js と同じ作り。使うときだけ Google のスクリプトを読むので、
// オフライン起動の邪魔はしない。
// 本棚フォルダ（青空文庫の本を置く共有の棚）へ書き込むので、読み書きの権限を取る。
// drive.file では、アプリが作ったのではない既存のフォルダに置けないため。
const SCOPE = 'https://www.googleapis.com/auth/drive';
const GIS = 'https://accounts.google.com/gsi/client';

export const key = 'drive';
export const label = 'Google ドライブ';

let tokenClient = null;
let token = null;
let tokenExp = 0;
let clientIdUsed = '';

function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector('script[src="' + src + '"]')) return res();
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = () => res();
    s.onerror = () => rej(new Error('Google のスクリプトを読み込めませんでした（オフライン？）'));
    document.head.appendChild(s);
  });
}

export const hasToken = () => !!token && Date.now() < tokenExp;

export function signOut() {
  if (token && window.google && window.google.accounts && window.google.accounts.oauth2) {
    try { window.google.accounts.oauth2.revoke(token, () => {}); } catch { /* 失効済みでも構わない */ }
  }
  token = null; tokenExp = 0;
}

export async function connect(clientId) {
  if (hasToken() && clientIdUsed === clientId) return token;
  if (!clientId) throw new Error('クライアント ID が設定されていません');
  await loadScript(GIS);
  if (!window.google || !window.google.accounts || !window.google.accounts.oauth2) {
    throw new Error('Google の認証を初期化できませんでした');
  }
  if (!tokenClient || clientIdUsed !== clientId) {
    clientIdUsed = clientId;
    tokenClient = window.google.accounts.oauth2.initTokenClient({ client_id: clientId, scope: SCOPE, callback: () => {} });
  }
  return new Promise((ok, ng) => {
    tokenClient.callback = (r) => {
      if (r.error) return ng(new Error(r.error_description || r.error));
      token = r.access_token;
      tokenExp = Date.now() + (Number(r.expires_in || 3600) - 60) * 1000;
      ok(token);
    };
    tokenClient.error_callback = (e) => ng(new Error((e && e.message) || '認証がキャンセルされました'));
    try { tokenClient.requestAccessToken({ prompt: '' }); } catch (e) { ng(e); }
  });
}

async function api(path, params) {
  const url = new URL('https://www.googleapis.com/drive/v3/' + path);
  Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) throw new Error('ドライブ API エラー: ' + r.status);
  return r.json();
}

const COMMON = {
  supportsAllDrives: 'true',
  includeItemsFromAllDrives: 'true',
  fields: 'nextPageToken, files(id,name,mimeType,size,modifiedTime)',
  pageSize: '200',
};
const FOLDER = 'application/vnd.google-apps.folder';

export async function list(folderId) {
  const id = folderId || 'root';
  const out = [];
  let pageToken;
  do {
    const res = await api('files', {
      ...COMMON,
      q: "'" + id + "' in parents and trashed = false",
      orderBy: 'folder,name_natural',
      ...(pageToken ? { pageToken } : {}),
    });
    out.push(...(res.files || []));
    pageToken = res.nextPageToken;
  } while (pageToken);
  return out.map((f) => ({
    id: f.id, name: f.name, isFolder: f.mimeType === FOLDER, size: Number(f.size || 0), mtime: f.modifiedTime || '',
  }));
}

// 1件の今の版（開くとき、取り込んだときから書き換わっていないかを見る）。消えていれば null。
export async function stat(id) {
  const r = await fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id) +
    '?fields=id,name,size,modifiedTime,trashed&supportsAllDrives=true', { headers: { Authorization: 'Bearer ' + token } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('ドライブ API エラー: ' + r.status);
  const f = await r.json();
  return f.trashed ? null : { id: f.id, name: f.name, size: Number(f.size || 0), mtime: f.modifiedTime || '' };
}

// フォルダにファイルを置く（同じ名前があれば中身を差し替える）
export async function upload(folderId, name, blob) {
  const q = "'" + folderId + "' in parents and trashed = false and name = '" + name.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
  const hit = await api('files', { q, fields: 'files(id)', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' });
  const id = hit.files && hit.files[0] && hit.files[0].id;
  const meta = id ? {} : { name, parents: [folderId] };
  const body = new FormData();
  body.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
  body.append('file', blob, name);
  const url = 'https://www.googleapis.com/upload/drive/v3/files' + (id ? '/' + id : '') +
    '?uploadType=multipart&supportsAllDrives=true&fields=id,name,size,modifiedTime';
  const r = await fetch(url, { method: id ? 'PATCH' : 'POST', headers: { Authorization: 'Bearer ' + token }, body });
  if (!r.ok) throw new Error('ドライブに置けませんでした: ' + r.status);
  const f = await r.json();
  return { id: f.id, name: f.name, size: Number(f.size || 0), mtime: f.modifiedTime || '' };
}

export async function download(item) {
  const r = await fetch(
    'https://www.googleapis.com/drive/v3/files/' + item.id + '?alt=media&supportsAllDrives=true',
    { headers: { Authorization: 'Bearer ' + token } }
  );
  if (!r.ok) throw new Error('ダウンロード失敗: ' + r.status);
  return r.blob();
}

export const setupText =
  '<b>初回だけ、自分の Google アカウントで OAuth クライアント ID を作る必要があります。</b><br>' +
  '1. Google Cloud Console でプロジェクトを作る<br>' +
  '2. Google Drive API を有効にする<br>' +
  '3. OAuth 同意画面を作り、自分をテストユーザーに入れる<br>' +
  '4. 認証情報 → OAuth クライアント ID → <b>ウェブアプリケーション</b><br>' +
  '5. 承認済みの JavaScript 生成元に <code>' + location.origin + '</code> を入れる<br>' +
  '6. 出てきたクライアント ID を下に貼る<br>' +
  'ミュージックで作ったものがあれば、それをそのまま使えます。' +
  'アクセス権は<b>読み書き</b>です。書き込むのは、青空文庫から落とした本を本棚フォルダに置くときだけで、' +
  'それ以外のファイルには触りません（前に読み取り専用で許可していた場合は、一度だけ許可し直す画面が出ます）。';
