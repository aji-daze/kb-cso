// UI と Android 連携（戻るボタン・タブ・manifest など）のテスト。
// 使い方: node docs/music/tests/e2e-ui.mjs
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { makeMp3 } from './mkmp3.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8904;
const BASE = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log('PASS - ' + name);
  } catch (e) {
    results.push({ name, ok: false, detail: e.message });
    console.log('FAIL - ' + name + '  (' + e.message + ')');
  }
}
const assert = (c, m) => {
  if (!c) throw new Error(m || 'assertion failed');
};
const waitServer = (url) =>
  new Promise((res, rej) => {
    const t0 = Date.now();
    const go = () =>
      http.get(url, (r) => (r.resume(), res())).on('error', () => (Date.now() - t0 > 8000 ? rej(new Error('server')) : setTimeout(go, 150)));
    go();
  });

const server = spawn(process.execPath, [path.join(__dirname, 'serve.cjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
await waitServer(`${BASE}/index.html`);
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
});
const errors = [];

try {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 892 }, locale: 'ja-JP' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('ERR_TUNNEL_CONNECTION_FAILED') && errors.push(m.text()));
  await page.goto(`${BASE}/index.html`);
  const SONGS = [1, 2, 3].map((n) => ({ name: `s${n}.mp3`, buf: makeMp3({ title: `Track ${n}`, artist: `Artist ${n}`, album: `Album ${n}`, trackNo: n, seconds: 8 }) }));
  await page.locator('#filePick').setInputFiles(SONGS.map((s) => ({ name: s.name, mimeType: 'audio/mpeg', buffer: s.buf })));
  await page.waitForFunction(() => document.querySelectorAll('#view .row[data-act="play"]').length >= 3, null, { timeout: 20000 });

  const activeTab = () => page.evaluate(() => document.querySelector('#tabs button.on')?.dataset.tab);
  const firstTab = () => page.evaluate(() => document.querySelector('#tabs button')?.dataset.tab);

  await step('ホーム以外のタブで戻るボタンを押すと、アプリを閉じずにホーム（左端）のタブへ戻る', async () => {
    const home = await firstTab();
    const other = await page.evaluate((h) => [...document.querySelectorAll('#tabs button')].map((b) => b.dataset.tab).find((t) => t !== h), home);
    await page.click(`#tabs button[data-tab="${other}"]`);
    await sleep(200);
    const other2 = await page.evaluate((a) => [...document.querySelectorAll('#tabs button')].map((b) => b.dataset.tab).filter((t) => t !== a)[1], home);
    await page.click(`#tabs button[data-tab="${other2}"]`); // タブを渡り歩いても戻る1回でホームへ
    await sleep(200);
    await page.goBack();
    await sleep(300);
    assert(page.url().startsWith(BASE), `アプリから出てしまった url=${page.url()}`);
    assert((await activeTab()) === home, `戻ったあとのタブ=${await activeTab()} ホーム=${home}`);
  });

  await step('ホームのタブを押して戻ったあとは、戻る操作が積み残っていない', async () => {
    const home = await firstTab();
    const other = await page.evaluate((h) => [...document.querySelectorAll('#tabs button')].map((b) => b.dataset.tab).find((t) => t !== h), home);
    await page.click(`#tabs button[data-tab="${other}"]`);
    await sleep(200);
    await page.click(`#tabs button[data-tab="${home}"]`);
    await sleep(300);
    const len = await page.evaluate(() => history.state && history.state.n);
    assert(!len, `ホームに戻ったのに戻る操作が残っている n=${len}`);
  });

  await step('検索中に戻るボタンを押すと、アプリを閉じずに検索だけ閉じる', async () => {
    await page.click('#btnSearch');
    await sleep(200);
    await page.fill('#q', 'Track 2');
    await sleep(400);
    await page.goBack();
    await sleep(300);
    assert(page.url().startsWith(BASE), 'アプリから出てしまった');
    const st = await page.evaluate(() => ({ hidden: document.querySelector('#searchWrap').hidden, q: document.querySelector('#q').value, rows: document.querySelectorAll('#view .row[data-act="play"]').length }));
    assert(st.hidden, '検索欄が閉じていない');
    assert(st.q === '', `検索語が残っている q=${st.q}`);
    assert(st.rows >= 3, `絞り込みが解除されていない rows=${st.rows}`);
  });

  await step('検索ボタンでもう一度押して閉じたあと、戻る操作が積み残っていない', async () => {
    await page.click('#btnSearch');
    await sleep(200);
    await page.click('#btnSearch');
    await sleep(300);
    const n = await page.evaluate(() => history.state && history.state.n);
    assert(!n, `戻る操作が残っている n=${n}`);
  });

  await step('タブが画面に収まらないとき、右端をぼかして続きがあることを示す', async () => {
    const r = await page.evaluate(() => {
      const el = document.querySelector('#tabs');
      el.scrollLeft = 0;
      el.dispatchEvent(new Event('scroll'));
      return { over: el.scrollWidth > el.clientWidth + 2, fade: el.classList.contains('fade-r') };
    });
    assert(r.over, '前提: 412px 幅でタブがはみ出していない');
    assert(r.fade, '右端のぼかしが付いていない');
  });

  await step('メニューでアイコンのある項目と無い項目の文字の位置が揃っている', async () => {
    await page.locator('#view .row[data-act="play"] [data-act="menu"]').first().click();
    await page.waitForSelector('#dialogWrap:not([hidden])');
    const xs = await page.evaluate(() => [...document.querySelectorAll('#dialog .opt span')].map((s) => Math.round(s.getBoundingClientRect().left)));
    await page.goBack();
    await sleep(200);
    assert(xs.length > 2 && new Set(xs).size === 1, `文字の左端がばらばら: ${xs.join(',')}`);
  });

  await step('行の⋮とタブは押しやすい大きさ（高さ38px以上）', async () => {
    const r = await page.evaluate(() => ({
      menu: document.querySelector('#view .row [data-act="menu"]').getBoundingClientRect().height,
      tab: document.querySelector('#tabs button').getBoundingClientRect().height,
    }));
    assert(r.menu >= 40, `⋮ の高さ=${r.menu}`);
    assert(r.tab >= 38, `タブの高さ=${r.tab}`);
  });

  await step('manifest の色がテーマに合わせて返る（起動画面の色）', async () => {
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.evaluate(() => new Promise((r) => {
      const q = indexedDB.open('kbmusic');
      q.onsuccess = () => { const tx = q.result.transaction('settings', 'readwrite'); tx.objectStore('settings').put('hakuji', 'theme'); tx.oncomplete = r; };
    }));
    await page.reload();
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10000 });
    await sleep(500);
    const j = await page.evaluate(async () => (await fetch('manifest.json', { cache: 'no-store' })).json());
    assert(j.theme_color === '#ffffff' && j.background_color === '#ffffff', `theme=${j.theme_color} bg=${j.background_color}`);
    assert(j.name && Array.isArray(j.icons) && j.icons.length >= 2, '中身が壊れている');
  });

  await step('ページ内エラーが出ていない', async () => {
    assert(errors.length === 0, errors.join(' / ').slice(0, 400));
  });
} finally {
  await browser.close();
  server.kill();
}
const passed = results.filter((r) => r.ok).length;
console.log(`\n${passed} passed, ${results.length - passed} failed`);
process.exit(passed === results.length ? 0 : 1);
