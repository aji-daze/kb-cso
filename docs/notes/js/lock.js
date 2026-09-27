// パスワードの鍵。端末に置くもの（ノートの控え・書きかけ・サインインのトークン・一覧・履歴）は
// すべてこの鍵で暗号化してから IndexedDB に入れる。パスワードを知らなければ端末を拾っても読めない。
//
//   パスワード ──PBKDF2(SHA-256, 31万回)──▶ 512 bit ─┬─ 前半 256 bit：AES-GCM（中身の暗号化）
//                                                    └─ 後半 256 bit：HMAC（ノート名を伏せた索引）
//
// パスワードそのものはどこにも保存しない。照合用に「決まった文字列を暗号化したもの」だけを置く。
// 鍵は取り出せない形（extractable: false）で作るので、「この端末では入力を省く」を選んでも
// 鍵の中身が文字として残ることはない。
import * as DB from './db.js';

const ITER = 310000;
const CHECK = 'notes-lock-ok';
const te = new TextEncoder();
const td = new TextDecoder();

let aes = null;
let mac = null;

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export const unlocked = () => !!aes;
export const configured = async () => !!(await DB.setting('lock'));

async function derive(password, salt, iter) {
  const base = await crypto.subtle.importKey('raw', te.encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, 512));
  const a = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const m = await crypto.subtle.importKey('raw', bits.slice(32), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  bits.fill(0);
  return { a, m };
}

export async function encrypt(value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, te.encode(JSON.stringify(value)));
  return { iv: b64(iv), ct: b64(ct) };
}

export async function decrypt(box, key = aes) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.ct));
  return JSON.parse(td.decode(pt));
}

// ノートのパスを伏せた索引にする（同じパスからは同じ値。パスには戻せない）
const idCache = new Map();
export async function id(text) {
  if (idCache.has(text)) return idCache.get(text);
  const sig = await crypto.subtle.sign('HMAC', mac, te.encode(text));
  const out = [...new Uint8Array(sig)].map((x) => x.toString(16).padStart(2, '0')).join('');
  idCache.set(text, out);
  return out;
}

// 初めて使うとき。前の控え（鍵なしで入ったもの）は念のため消す
export async function setup(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const k = await derive(password, salt, ITER);
  aes = k.a; mac = k.m; idCache.clear();
  for (const s of ['files', 'drafts']) await DB.clear(s);
  await DB.clear('settings');
  await DB.setting('lock', { salt: b64(salt), iter: ITER, check: await encrypt(CHECK) });
}

export async function unlock(password, remember) {
  const lock = await DB.setting('lock');
  const k = await derive(password, unb64(lock.salt), lock.iter);
  try {
    if ((await decrypt(lock.check, k.a)) !== CHECK) return false;
  } catch {
    return false;
  }
  aes = k.a; mac = k.m; idCache.clear();
  if (remember) await DB.setting('lockKeys', { a: aes, m: mac, at: Date.now() });
  return true;
}

// 「入力を省く」にしてあれば、置いてある鍵で開ける。
// サインインで Microsoft へ行って戻ってくる間だけ置く鍵（lockHandoff、10 分まで）もここで拾う。
export async function tryResume() {
  const hand = await DB.setting('lockHandoff');
  if (hand) {
    await DB.setting('lockHandoff', null);
    if (Date.now() - hand.at < 10 * 60 * 1000) { aes = hand.a; mac = hand.m; return true; }
  }
  const keep = await DB.setting('lockKeys');
  if (keep) { aes = keep.a; mac = keep.m; return true; }
  return false;
}

export async function handoff() {
  if (aes) await DB.setting('lockHandoff', { a: aes, m: mac, at: Date.now() });
}

export const remembered = async () => !!(await DB.setting('lockKeys'));
export async function forget() { await DB.setting('lockKeys', null); }
export async function rememberNow() { if (aes) await DB.setting('lockKeys', { a: aes, m: mac, at: Date.now() }); }

// 鍵をかける：覚えた鍵を消し、画面を読み直してメモリ上の中身も捨てる
export async function lockNow() {
  await forget();
  aes = null; mac = null;
  location.reload();
}

// パスワードを変える。控えを全部読み直して新しい鍵で入れ直す
export async function change(oldPw, newPw) {
  const lock = await DB.setting('lock');
  const old = await derive(oldPw, unb64(lock.salt), lock.iter);
  try { if ((await decrypt(lock.check, old.a)) !== CHECK) return false; } catch { return false; }

  const rows = {};
  for (const s of ['files', 'drafts', 'settings']) rows[s] = await DB.all(s);
  const plain = {};
  for (const s of ['files', 'drafts']) plain[s] = await Promise.all(rows[s].map((r) => decrypt(r, old.a)));
  const sets = [];
  for (const r of rows.settings) if (r.k.startsWith('x.')) sets.push([r.k.slice(2), await decrypt(r.v, old.a)]);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const k = await derive(newPw, salt, ITER);
  aes = k.a; mac = k.m; idCache.clear();
  for (const s of ['files', 'drafts']) {
    await DB.clear(s);
    for (const v of plain[s]) await DB.put(s, { path: await id(v.path), ...(await encrypt(v)) });
  }
  for (const [k2, v] of sets) await DB.put('settings', { k: 'x.' + k2, v: await encrypt(v) });
  await DB.setting('lock', { salt: b64(salt), iter: ITER, check: await encrypt(CHECK) });
  if (await remembered()) await DB.setting('lockKeys', { a: aes, m: mac, at: Date.now() });
  return true;
}

// パスワードを忘れたとき：端末の控えを全部消して最初からにする（OneDrive のファイルは消えない）
export async function reset() {
  for (const s of ['files', 'drafts', 'settings']) await DB.clear(s);
  aes = null; mac = null;
}
