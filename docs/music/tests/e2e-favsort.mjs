// お気に入りの並べ替えのテスト。
// 使い方: node docs/music/tests/e2e-favsort.mjs
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { makeMp3 } from './mkmp3.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8907;
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
  
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
});
const errors = [];

try {
  const page = await (await browser.newContext({ viewport: { width: 412, height: 892 }, locale: 'ja-JP' })).newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('ERR_TUNNEL_CONNECTION_FAILED') && errors.push(m.text()));
  await page.goto(`${BASE}/index.html`);
  // 曲名順と、お気に入りにした順が食い違うように用意する
  const SONGS = ['Apple', 'Banana', 'Cherry'].map((t, i) => ({ name: `f${i}.mp3`, buf: makeMp3({ title: t, artist: 'A', album: 'B', trackNo: i + 1, seconds: 4 }) }));
  await page.locator('#filePick').setInputFiles(SONGS.map((s) => ({ name: s.name, mimeType: 'audio/mpeg', buffer: s.buf })));
  await page.waitForFunction(() => document.querySelectorAll('#view .row[data-act="play"]').length >= 3, null, { timeout: 20000 });

  const fav = async (title) => {
    await page.locator('#view .row[data-act="play"]').filter({ hasText: title }).first().locator('[data-act="menu"]').click();
    await page.waitForSelector('#dialogWrap:not([hidden])');
    await page.click('#dialog .opt:has-text("お気に入り")');
    await sleep(400);
  };
  // Cherry → Apple → Banana の順にお気に入りにする
  for (const t of ['Cherry', 'Apple', 'Banana']) { await fav(t); await sleep(30); }

  const openFavTab = async () => {
    await page.click('#tabs button[data-tab="favorites"]');
    await sleep(300);
  };
  const titles = () => page.$$eval('#view .row[data-act="play"] .t', (n) => n.map((x) => x.textContent));
  const chooseSort = async (label) => {
    await page.click('#view [data-act="sort"]');
    await page.waitForSelector('#dialogWrap:not([hidden])');
    await page.click(`#dialog .opt:has-text("${label}")`);
    await sleep(400);
  };

  await step('お気に入りタブに並べ替えボタンがあり、既定は曲名順（今までどおり）', async () => {
    await openFavTab();
    const btn = await page.textContent('#view [data-act="sort"]');
    assert(btn && btn.includes('曲名順'), `ボタン=${btn}`);
    assert((await titles()).join(',') === 'Apple,Banana,Cherry', (await titles()).join(','));
  });

  await step('「お気に入りにした順」を選ぶと、新しくお気に入りにした曲が先に来る', async () => {
    await chooseSort('お気に入りにした順');
    assert((await titles()).join(',') === 'Banana,Apple,Cherry', (await titles()).join(','));
  });

  await step('もう一度選ぶと古い順になる', async () => {
    await chooseSort('お気に入りにした順');
    assert((await titles()).join(',') === 'Cherry,Apple,Banana', (await titles()).join(','));
  });

  await step('「すべて再生」はいま見えている並びの順で鳴る', async () => {
    await page.click('#view [data-act="playall"]');
    await sleep(500);
    const t = await page.textContent('#miniTitle');
    assert(t === 'Cherry', `最初に鳴った曲=${t}`);
  });

  await step('並びは再読み込みしても残り、プレイリスト一覧から開いたお気に入りとも同じ', async () => {
    await page.reload();
    await page.waitForSelector('#tabs button[data-tab="favorites"]');
    await openFavTab();
    assert((await titles()).join(',') === 'Cherry,Apple,Banana', `再読み込み後=${(await titles()).join(',')}`);
    await page.click('#tabs button[data-tab="playlists"]');
    await sleep(300);
    await page.locator('#view [data-act="playlist"]').filter({ hasText: 'お気に入り' }).first().click();
    await sleep(400);
    assert((await titles()).join(',') === 'Cherry,Apple,Banana', `プレイリスト側=${(await titles()).join(',')}`);
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
