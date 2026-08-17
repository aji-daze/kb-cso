// Google ドライブからの取り込み（任意機能）。
// 使うときだけ Google Identity Services を読み込むので、オフライン起動の邪魔はしない。
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const GIS = 'https://accounts.google.com/gsi/client';

let tokenClient = null;
let token = null;
let tokenExp = 0;
let clientIdUsed = '';

function loadScript(src) {
  return new Promise((res, rej) => {
    if (document.querySelector(`script[src="${src}"]`)) return res();
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => res();
    s.onerror = () => rej(new Error('Google のスクリプトを読み込めませんでした（オフライン？）'));
    document.head.appendChild(s);
  });
}

export function hasToken() {
  return !!token && Date.now() < tokenExp;
}

export function signOut() {
  if (token && window.google?.accounts?.oauth2) {
    try {
      window.google.accounts.oauth2.revoke(token, () => {});
    } catch {}
  }
  token = null;
  tokenExp = 0;
}

export async function authorize(clientId, { interactive = true } = {}) {
  if (hasToken() && clientIdUsed === clientId) return token;
  if (!clientId) throw new Error('クライアントIDが設定されていません');
  await loadScript(GIS);
  if (!window.google?.accounts?.oauth2) throw new Error('Google の認証を初期化できませんでした');

  if (!tokenClient || clientIdUsed !== clientId) {
    clientIdUsed = clientId;
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: () => {},
    });
  }

  return new Promise((resolve, reject) => {
    tokenClient.callback = (resp) => {
      if (resp.error) return reject(new Error(resp.error_description || resp.error));
      token = resp.access_token;
      tokenExp = Date.now() + (Number(resp.expires_in || 3600) - 60) * 1000;
      resolve(token);
    };
    tokenClient.error_callback = (err) => reject(new Error(err?.message || '認証がキャンセルされました'));
    try {
      tokenClient.requestAccessToken({ prompt: interactive ? '' : 'none' });
    } catch (e) {
      reject(e);
    }
  });
}

async function api(path, params = {}) {
  const url = new URL('https://www.googleapis.com/drive/v3/' + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) throw new Error('ドライブ API エラー: ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r.json();
}

const AUDIO_EXT = /\.(mp3|m4a|aac|flac|wav|ogg|oga|opus|weba|m4b)$/i;

export function isAudio(f) {
  return (f.mimeType && f.mimeType.startsWith('audio/')) || AUDIO_EXT.test(f.name || '');
}

const COMMON = {
  supportsAllDrives: 'true',
  includeItemsFromAllDrives: 'true',
  fields: 'nextPageToken, files(id,name,mimeType,size,modifiedTime)',
  pageSize: '200',
};

export async function listChildren(folderId = 'root') {
  const out = [];
  let pageToken;
  do {
    const res = await api('files', {
      ...COMMON,
      q: `'${folderId}' in parents and trashed = false`,
      orderBy: 'folder,name_natural',
      ...(pageToken ? { pageToken } : {}),
    });
    out.push(...(res.files || []));
    pageToken = res.nextPageToken;
  } while (pageToken);
  return out;
}

export async function searchAudio(text) {
  const q = `trashed = false and (mimeType contains 'audio/' or name contains '.mp3' or name contains '.m4a' or name contains '.flac') and name contains '${text.replace(/'/g, "\\'")}'`;
  const res = await api('files', { ...COMMON, q, orderBy: 'name_natural' });
  return res.files || [];
}

// フォルダを再帰的に辿って音声ファイルを集める
export async function collectAudio(folderId, onProgress) {
  const found = [];
  const stack = [folderId];
  const seen = new Set();
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const items = await listChildren(id);
    for (const f of items) {
      if (f.mimeType === 'application/vnd.google-apps.folder') stack.push(f.id);
      else if (isAudio(f)) found.push(f);
    }
    if (onProgress) onProgress(found.length);
  }
  return found;
}

export async function download(fileId) {
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`, {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!r.ok) throw new Error('ダウンロード失敗: ' + r.status);
  return r.blob();
}
