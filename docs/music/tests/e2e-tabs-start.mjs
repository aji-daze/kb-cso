// 起動時にいちばん左のタブが開くことの確認。
// タブの並びを変えたら、最初に出る画面もそれに追従する。
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { spawn } from 'node:child_process';
import { makeMp3 } from './mkmp3.mjs';

const PORT = process.env.PORT || 8901;
const BASE = `http://127.0.0.1:${PORT}`;
const server = spawn(process.execPath, [new URL('./serve.cjs', import.meta.url).pathname], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 700));

const results = [];
const t = async (name, fn) => {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log('PASS -', name);
  } catch (e) {
    results.push({ name, ok: false });
    console.log('FAIL -', name, '::', e.message);
  }
};
const assert = (c, m) => {
  if (!c) throw new Error(m || 'assertion failed');
};

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
});
const ctx = await browser.newContext({ viewport: { width: 412, height: 900 }, locale: 'ja-JP' });
const page = await ctx.newPage();

try {
  await page.goto(BASE + '/index.html');
  await page.waitForTimeout(700);

  // 曲を入れておく（空のライブラリだとどのタブも同じ見た目になるため）
  const files = [
    { name: 'a.mp3', title: 'Alpha', artist: 'A', album: 'AA' },
    { name: 'b.mp3', title: 'Bravo', artist: 'B', album: 'BB' },
  ].map((f, i) => ({ name: f.name, b64: makeMp3({ ...f, trackNo: i + 1, seconds: 3 }).toString('base64') }));
  await page.evaluate((fs) => {
    const dt = new DataTransfer();
    for (const f of fs) {
      const bytes = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
      dt.items.add(new File([bytes], f.name, { type: 'audio/mpeg' }));
    }
    const input = document.querySelector('#filePick');
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, files);
  await page.waitForTimeout(2500);

  const activeTab = () => page.evaluate(() => {
    const el = document.querySelector('#tabs button.on');
    return el ? { id: el.dataset.tab, text: el.textContent.trim() } : null;
  });
  const firstTab = () => page.evaluate(() => {
    const el = document.querySelector('#tabs button');
    return el ? { id: el.dataset.tab, text: el.textContent.trim() } : null;
  });

  await t('起動直後に開いているのは、いちばん左のタブ', async () => {
    await page.reload();
    await page.waitForTimeout(1200);
    const a = await activeTab();
    const f = await firstTab();
    assert(a && f, `tabs not found a=${JSON.stringify(a)} f=${JSON.stringify(f)}`);
    assert(a.id === f.id, `active=${JSON.stringify(a)} first=${JSON.stringify(f)}`);
  });

  await t('タブの並びを変えると、起動時に開く画面もそれに追従する', async () => {
    // 「お気に入り」を左端に持ってくる（設定に保存されている並びを直接書き換える）
    await page.evaluate(() => new Promise((r) => {
      const q = indexedDB.open('kbmusic');
      q.onsuccess = () => {
        const tx = q.result.transaction('settings', 'readwrite');
        tx.objectStore('settings').put(
          [
            { id: 'favorites', on: true },
            { id: 'songs', on: true },
            { id: 'albums', on: true },
            { id: 'artists', on: true },
            { id: 'folders', on: true },
            { id: 'playlists', on: true },
          ],
          'tabs'
        );
        tx.oncomplete = r;
      };
    }));
    await page.reload();
    await page.waitForTimeout(1200);
    const a = await activeTab();
    const f = await firstTab();
    assert(f && f.id === 'favorites', `leftmost should be favorites, got ${JSON.stringify(f)}`);
    assert(a && a.id === 'favorites', `active should be favorites, got ${JSON.stringify(a)}`);
    const label = await page.evaluate(() => document.querySelector('#tabs button.on').textContent.trim());
    assert(label === 'お気に入り', `label=${label}`);
  });

  await t('左端のタブを非表示にすると、次に左にあるタブが開く', async () => {
    await page.evaluate(() => new Promise((r) => {
      const q = indexedDB.open('kbmusic');
      q.onsuccess = () => {
        const tx = q.result.transaction('settings', 'readwrite');
        tx.objectStore('settings').put(
          [
            { id: 'favorites', on: false },
            { id: 'folders', on: true },
            { id: 'songs', on: true },
            { id: 'albums', on: true },
            { id: 'artists', on: true },
            { id: 'playlists', on: true },
          ],
          'tabs'
        );
        tx.oncomplete = r;
      };
    }));
    await page.reload();
    await page.waitForTimeout(1200);
    const a = await activeTab();
    assert(a && a.id === 'folders', `active should be folders, got ${JSON.stringify(a)}`);
  });
} finally {
  await browser.close();
  server.kill();
}

const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
