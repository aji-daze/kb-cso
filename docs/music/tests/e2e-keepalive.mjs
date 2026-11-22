// 裏で曲が切り替わるときに再生が途切れないための仕掛け（無音の見張り役）のテスト。
// 使い方: node docs/music/tests/e2e-keepalive.mjs
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { makeMp3 } from './mkmp3.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8906;
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
  const page = await (await browser.newContext({ viewport: { width: 412, height: 892 } })).newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('ERR_TUNNEL_CONNECTION_FAILED') && errors.push(m.text()));
  await page.goto(`${BASE}/index.html`);
  const SONGS = [1, 2, 3].map((n) => ({ name: `k${n}.mp3`, buf: makeMp3({ title: `Song ${n}`, artist: 'A', album: 'B', trackNo: n, seconds: n === 1 ? 3 : 30 }) }));
  await page.locator('#filePick').setInputFiles(SONGS.map((s) => ({ name: s.name, mimeType: 'audio/mpeg', buffer: s.buf })));
  await page.waitForFunction(() => document.querySelectorAll('#view .row[data-act="play"]').length >= 3, null, { timeout: 20000 });
  const ka = () => page.evaluate(async () => (await import('./js/player.js')).keepAliveState());
  const readLog = async () => {
    await page.click('#btnSettings');
    await page.waitForSelector('#sheetSettings.open');
    await page.click('#settingsBody [data-act="playLog"]');
    await page.waitForSelector('#dialogWrap:not([hidden])');
    const t = await page.locator('#dialog').innerText();
    await page.click('#plClose');
    await page.click('#sheetSettings [data-close]');
    await sleep(300);
    return t;
  };

  await step('再生を始めると、無音の見張り役も鳴り始める', async () => {
    await page.locator('#view .row[data-act="play"]').filter({ hasText: 'Song 1' }).first().click();
    await sleep(600);
    assert((await ka()) === 'on', `見張り役=${await ka()}`);
  });

  await step('曲が終わって次の曲へ移る間も、見張り役は一度も止まらない', async () => {
    // Song 1 は3秒。終わって Song 2 に移るまでの間、20ms ごとに見張り役を見張る
    const seen = await page.evaluate(async () => {
      const P = await import('./js/player.js');
      const states = new Set();
      const t0 = Date.now();
      while (Date.now() - t0 < 5000) {
        states.add(P.keepAliveState());
        if (document.querySelector('#miniTitle').textContent === 'Song 2' && !P.audio.paused && P.audio.currentTime > 0.3) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      return { states: [...states], title: document.querySelector('#miniTitle').textContent };
    });
    assert(seen.title === 'Song 2', `次の曲に進んでいない title=${seen.title}`);
    assert(seen.states.length === 1 && seen.states[0] === 'on', `切り替えの間に見張り役の状態が変わった: ${seen.states.join(',')}`);
  });

  await step('自分で一時停止すると、見張り役も止まる', async () => {
    await page.click('#miniPlay');
    await sleep(300);
    assert((await ka()) === 'off', `見張り役=${await ka()}`);
  });

  await step('再開すると見張り役も戻り、■で終えると止まる', async () => {
    await page.click('#miniPlay');
    await sleep(400);
    assert((await ka()) === 'on', `再開後の見張り役=${await ka()}`);
    await page.click('#miniStop');
    await sleep(300);
    assert((await ka()) === 'off', `■のあとの見張り役=${await ka()}`);
  });

  await step('切り替え直後の再開を繰り返して位置が2秒まで進んでも、「曲の途中」扱いで諦めない', async () => {
    await page.locator('#view .row[data-act="play"]').filter({ hasText: 'Song 3' }).first().click();
    await sleep(300);
    const before = (await readLog()).length;
    const pause = () => page.evaluate(async () => (await import('./js/player.js')).audio.pause());
    await pause(); // 位置0秒 → 切り替え直後と判定（1回目）
    await sleep(1300); // 再開を待つ
    await page.evaluate(async () => {
      const P = await import('./js/player.js');
      P.audio.currentTime = 2.2; // 記録と同じく、再開を重ねて2秒まで進んだ状況
    });
    await sleep(100);
    await pause(); // ここで「曲の途中」に落ちて諦めていたのが前の不具合
    await sleep(300);
    const log = await readLog();
    const added = log.slice(0, log.length - before);
    assert(added.includes('曲の切り替え直後に止められた。再開を試みる（2回目）'), `2回目が切り替え直後として扱われていない: ${added.slice(0, 900)}`);
    assert(!added.includes('外部の要求と判断して諦める'), `諦めてしまった: ${added.slice(0, 300)}`);
  });

  await step('■で終えたあとに別の曲を鳴らすと、端末に止められた pause が「■で終了」と取り違えられない', async () => {
    // ■ は pause() の直後に load() するので、仕様上 pause イベントが捨てられ、理由が残りやすい。
    // 前の項目の結果に左右されないよう、まず確実に鳴っている状態を作ってから ■ を押す
    await page.locator('#view .row[data-act="play"]').filter({ hasText: 'Song 3' }).first().click();
    await page.waitForFunction(async () => !(await import('./js/player.js')).audio.paused, null, { timeout: 5000 });
    await sleep(300);
    await page.click('#miniStop');
    await sleep(300);
    await page.locator('#view .row[data-act="play"]').filter({ hasText: 'Song 2' }).first().click();
    await sleep(2500); // 曲を進めて「曲の途中」にする
    const before = (await readLog()).length;
    await page.evaluate(async () => (await import('./js/player.js')).audio.pause());
    await sleep(1500);
    const log = await readLog();
    const added = log.slice(0, log.length - before);
    assert(!added.includes('［■で終了］'), `古い理由が付いてしまった: ${added.slice(0, 300)}`);
    assert(added.includes('一時停止［外部'), `外部要因として記録されていない: ${added.slice(0, 300)}`);
    assert(added.includes('再開を試みる'), `自動再開が働いていない: ${added.slice(0, 300)}`);
  });

  await step('一時停止の記録に見張り役の状態が出る', async () => {
    const log = await readLog();
    assert(/見張り=(on|off|none)/.test(log), '記録に見張り役の状態が無い');
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
