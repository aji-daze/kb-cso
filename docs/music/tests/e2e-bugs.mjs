// 監査で見つかった不具合の再発防止テスト。
// 使い方: node docs/music/tests/e2e-bugs.mjs
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { makeMp3 } from './mkmp3.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8903;
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
  const page = await browser.newPage({ viewport: { width: 412, height: 892 } });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !m.text().includes('ERR_TUNNEL_CONNECTION_FAILED') && errors.push(m.text()));
  await page.goto(`${BASE}/index.html`);

  const SONGS = [1, 2, 3, 4, 5].map((n) => ({ name: `song${n}.mp3`, buf: makeMp3({ title: `Song ${n}`, artist: 'A', album: 'B', trackNo: n, seconds: 30 }) }));
  await page.locator('#filePick').setInputFiles(SONGS.map((s) => ({ name: s.name, mimeType: 'audio/mpeg', buffer: s.buf })));
  await page.waitForFunction(() => document.querySelectorAll('#view .row[data-act="play"]').length >= 5, null, { timeout: 20000 });

  const row = (t) => page.locator('#view .row[data-act="play"]').filter({ hasText: t }).first();
  const mini = () => page.evaluate(() => document.querySelector('#miniTitle').textContent);
  const playFrom3 = async () => {
    await row('Song 3').click();
    await page.waitForFunction(() => document.querySelector('#miniTitle').textContent === 'Song 3');
    await sleep(300);
  };
  const deleteByLongPress = async (title) => {
    const b = await row(title).boundingBox();
    await page.mouse.move(b.x + 40, b.y + 20);
    await page.mouse.down();
    await sleep(700);
    await page.mouse.up();
    await sleep(150);
    await page.click('#selectBar [data-act="selDelete"]');
    await page.waitForSelector('#dialogWrap:not([hidden])');
    await page.click('#dialog button:has-text("削除")');
    await sleep(700);
  };
  const clickNext = async () => {
    await page.click('#miniNext');
    await sleep(400);
  };

  await step('再生中より前の曲を消しても、再生中の曲はそのままで「次へ」で次の曲に進む', async () => {
    await playFrom3();
    await deleteByLongPress('Song 1');
    assert((await mini()) === 'Song 3', `削除後の表示=${await mini()}`);
    const hl = await page.evaluate(() => document.querySelector('#view .row.playing .t')?.textContent);
    assert(hl === 'Song 3', `一覧で再生中と強調されている曲=${hl}`);
    await clickNext();
    assert((await mini()) === 'Song 4', `「次へ」のあと=${await mini()}（Song 4 のはず）`);
  });

  await step('再生中の曲そのものを消すと、次の曲が読み込まれて止まった状態になる', async () => {
    // いま Song 4 を再生中
    await deleteByLongPress('Song 4');
    assert((await mini()) === 'Song 5', `削除後の表示=${await mini()}`);
    const paused = await page.evaluate(async () => (await import('./js/player.js')).audio.paused);
    assert(paused, '勝手に鳴り出してはいけない');
  });

  await step('保存時の番号がずれていても、再読み込みで同じ曲に復元される', async () => {
    // 残り: Song 2, 3, 5。Song 3 の位置を保存したことにしてから、前にある Song 2 を DB から直接消す
    await page.evaluate(async () => {
      const open = () => new Promise((r) => { const q = indexedDB.open('kbmusic'); q.onsuccess = () => r(q.result); });
      const db = await open();
      const all = await new Promise((r) => { const q = db.transaction('tracks').objectStore('tracks').getAll(); q.onsuccess = () => r(q.result); });
      const id = (t) => all.find((x) => x.title === t).id;
      const ids = ['Song 2', 'Song 3', 'Song 5'].map(id);
      await new Promise((r) => {
        const tx = db.transaction(['settings', 'tracks'], 'readwrite');
        tx.objectStore('settings').put({ ids, base: ids, i: 1, id: ids[1], pos: 7, label: 'x' }, 'lastPlayback');
        tx.objectStore('tracks').delete(ids[0]);
        tx.oncomplete = r;
      });
    });
    await page.reload();
    await page.waitForFunction(() => !document.querySelector('#mini').hidden, null, { timeout: 10000 });
    await sleep(500);
    assert((await mini()) === 'Song 3', `復元された曲=${await mini()}（Song 3 のはず）`);
    const pos = await page.evaluate(async () => (await import('./js/player.js')).audio.currentTime);
    assert(pos > 5 && pos < 9, `再生位置=${pos}（7秒前後のはず）`);
  });

  await step('スリープタイマーのフェード中に取り消すと、止まらずに音量も戻る', async () => {
    const r = await page.evaluate(async () => {
      const P = await import('./js/player.js');
      P.audio.volume = 0.8;
      await P.audio.play().catch(() => {});
      P.fadeOutAndPause(1000);
      await new Promise((x) => setTimeout(x, 400));
      P.cancelSleep();
      await new Promise((x) => setTimeout(x, 1200));
      return { paused: P.audio.paused, vol: P.audio.volume };
    });
    assert(!r.paused, 'フェード取り消し後に止まってしまった');
    assert(Math.abs(r.vol - 0.8) < 0.01, `音量が戻っていない vol=${r.vol}`);
  });

  await step('画面が消えている間でもスリープタイマーで止まる（requestAnimationFrame に頼らない）', async () => {
    const r = await page.evaluate(async () => {
      const P = await import('./js/player.js');
      await P.audio.play().catch(() => {});
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      // requestAnimationFrame が動かない状況を再現する
      const raf = window.requestAnimationFrame;
      window.requestAnimationFrame = () => 0;
      P.fadeOutAndPause(1000);
      await new Promise((x) => setTimeout(x, 1500));
      window.requestAnimationFrame = raf;
      delete document.visibilityState;
      return { paused: P.audio.paused };
    });
    assert(r.paused, '画面が消えているとスリープタイマーで止まらない');
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
