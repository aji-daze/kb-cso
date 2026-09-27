// Microsoft アカウントへのサインイン。栞の onedrive.js と同じ「認可コード + PKCE」。
// ブラウザだけで完結し、秘密鍵（client secret）は持たない。
//
// 栞と違うのは、書き込むので Files.ReadWrite を取ること。
// 更新用トークンは SPA 向けには 24 時間しか持たないので、1日に1回くらいはサインインし直しになる。
// Microsoft 側にログインが残っていれば、ボタンを押すだけで戻ってくる。
import * as DB from './db.js';
import { CLIENT_ID } from '../config.js';

const SCOPE = 'Files.ReadWrite offline_access User.Read';
const VERIFIER_KEY = 'notes.auth.verifier';
const STATE_KEY = 'notes.auth.state';
const RETURN_KEY = 'notes.auth.return';

export const redirectUri = () => location.origin + location.pathname;

let token = null;
let tokenExp = 0;
let refreshing = null;

const endpoint = (tenant, kind) => 'https://login.microsoftonline.com/' + (tenant || 'common') + '/oauth2/v2.0/' + kind;

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

export async function clientId() {
  return (await DB.setting('clientId')) || CLIENT_ID || '';
}
const tenant = async () => (await DB.setting('tenant')) || 'common';

// 認証画面へ飛ばす。戻ってきたときは finishSignIn() が受け取る。
export async function signIn() {
  const id = await clientId();
  if (!id) throw new Error('クライアント ID が設定されていません');
  const verifier = randomString(64);
  const state = randomString(16);
  try {
    sessionStorage.setItem(VERIFIER_KEY, verifier);
    sessionStorage.setItem(STATE_KEY, state);
    sessionStorage.setItem(RETURN_KEY, location.hash);
  } catch {
    throw new Error('この画面では認証を保持できません（プライベートモード？）');
  }
  const u = new URL(endpoint(await tenant(), 'authorize'));
  u.searchParams.set('client_id', id);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', redirectUri());
  u.searchParams.set('scope', SCOPE);
  u.searchParams.set('code_challenge', await challenge(verifier));
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', state);
  location.assign(u.toString());
  return new Promise(() => {}); // 戻ってくるまで先へ進まない
}

async function exchange(body) {
  const id = await clientId();
  const r = await fetch(endpoint(await tenant(), 'token'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: id, scope: SCOPE, ...body }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j.error_description || j.error || ('トークンの取得に失敗しました（HTTP ' + r.status + '）'));
    e.fatal = r.status === 400 || r.status === 401; // invalid_grant など。やり直しても通らない
    throw e;
  }
  token = j.access_token;
  tokenExp = Date.now() + (Number(j.expires_in || 3600) - 120) * 1000;
  if (j.refresh_token) await DB.setting('refresh', j.refresh_token);
  return token;
}

// 起動時に呼ぶ。認証から戻ってきていれば受け取って、URL を掃除する。
export async function finishSignIn() {
  const q = new URLSearchParams(location.search);
  const code = q.get('code');
  const err = q.get('error');
  if (!code && !err) return null;

  let verifier = null, want = null, ret = '';
  try {
    verifier = sessionStorage.getItem(VERIFIER_KEY);
    want = sessionStorage.getItem(STATE_KEY);
    ret = sessionStorage.getItem(RETURN_KEY) || '';
    for (const k of [VERIFIER_KEY, STATE_KEY, RETURN_KEY]) sessionStorage.removeItem(k);
  } catch { /* 取れなければ下で弾く */ }
  history.replaceState(null, '', location.pathname + ret);

  if (err) return { ok: false, message: q.get('error_description') || err };
  if (!verifier) return { ok: false, message: '認証の途中経過が失われました。もう一度サインインしてください' };
  if (!want || want !== q.get('state')) return { ok: false, message: '認証の照合に失敗しました。もう一度サインインしてください' };
  try {
    await exchange({ grant_type: 'authorization_code', code, redirect_uri: redirectUri(), code_verifier: verifier });
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

// 使えるアクセストークンを返す。切れていれば更新用トークンで取り直す。
// 取れなければ null（サインインし直しが要る）。
// 同時に何本も呼ばれても、取り直しは1回だけにする。更新用トークンは使うたびに入れ替わるので、
// 並んで取り直すと後の方が古いトークンを出して弾かれる。
export async function getToken(force = false) {
  if (!force && token && Date.now() < tokenExp) return token;
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const refresh = await DB.setting('refresh');
    if (!refresh || !(await clientId())) return null;
    try {
      return await exchange({ grant_type: 'refresh_token', refresh_token: refresh });
    } catch (e) {
      if (e.fatal) { await DB.setting('refresh', null); return null; }
      throw e; // 通信の失敗。トークンは残しておき、電波が戻ったらまた使う
    }
  })().finally(() => { refreshing = null; });
  return refreshing;
}

export async function signedIn() {
  return !!(token && Date.now() < tokenExp) || !!(await DB.setting('refresh'));
}

export async function signOut() {
  token = null; tokenExp = 0;
  await DB.setting('refresh', null);
}
