// アプリアイコンをテーマ・アクセントに合わせる機能の E2E テスト。
// 使い方: node docs/music/tests/e2e-icon.mjs
// サーバは自分で起動・停止する。最後に `N passed, M failed` を出して、
// 失敗があれば終了コード 1。
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8903;
const BASE = `http://localhost:${PORT}`;

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? `  (${detail})` : ''));
}
async function step(name, fn) {
  try {
    await fn();
    record(name, true);
  } catch (e) {
    record(name, false, (e && e.message) || String(e));
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

// ---- WCAG の相対輝度比（e2e-appearance.mjs と同じ式） ----
function hexToRgb(hex) {
  hex = String(hex).trim().replace('#', '');
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  const num = parseInt(hex, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}
function relLum([r, g, b]) {
  const f = (c) => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const [rl, gl, bl] = [f(r), f(g), f(b)];
  return 0.2126 * rl + 0.7152 * gl + 0.0722 * bl;
}
function contrastRatio(hexA, hexB) {
  const la = relLum(hexToRgb(hexA));
  const lb = relLum(hexToRgb(hexB));
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// ---- テスト用サーバの起動 ----
function waitForServer(url, timeoutMs = 8000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) reject(new Error('server did not start in time'));
        else setTimeout(tryOnce, 150);
      });
    };
    tryOnce();
  });
}

// ---- ブラウザ内で IndexedDB(kbmusic) の settings ストアから値を読む ----
async function readSetting(page, key) {
  return page.evaluate((k) => {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open('kbmusic');
      r.onerror = () => reject(r.error);
      r.onsuccess = () => {
        const db = r.result;
        const t = db.transaction('settings', 'readonly');
        const g = t.objectStore('settings').get(k);
        g.onsuccess = () => resolve(g.result);
        g.onerror = () => reject(g.error);
      };
    });
  }, key);
}

// ---- Blob の中身をまるごと base64 に変換して Node 側へ持ってくる（画像デコード用） ----
async function blobArrayBufferBase64(page, key) {
  return page.evaluate((k) => {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open('kbmusic');
      r.onerror = () => reject(r.error);
      r.onsuccess = () => {
        const db = r.result;
        const t = db.transaction('settings', 'readonly');
        const g = t.objectStore('settings').get(k);
        g.onsuccess = async () => {
          const blob = g.result;
          if (!blob) return resolve(null);
          const buf = await blob.arrayBuffer();
          const bytes = new Uint8Array(buf);
          let bin = '';
          for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
          resolve({ size: blob.size, base64: btoa(bin) });
        };
        g.onerror = () => reject(g.error);
      };
    });
  }, key);
}

// ---- Blob の先頭 n バイトだけを切り出してから base64 化する（バイト単位のずれなく比較するため） ----
async function blobHeadBase64(page, key, n = 2048) {
  return page.evaluate(
    ({ k, n }) => {
      return new Promise((resolve, reject) => {
        const r = indexedDB.open('kbmusic');
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const db = r.result;
          const t = db.transaction('settings', 'readonly');
          const g = t.objectStore('settings').get(k);
          g.onsuccess = async () => {
            const blob = g.result;
            if (!blob) return resolve(null);
            const buf = await blob.slice(0, n).arrayBuffer();
            const bytes = new Uint8Array(buf);
            let bin = '';
            for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
            resolve(btoa(bin));
          };
          g.onerror = () => reject(g.error);
        };
      });
    },
    { k: key, n }
  );
}

async function main() {
  const serverProc = spawn(process.execPath, [path.join(__dirname, 'serve.cjs')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stderr.on('data', (d) => process.stderr.write(`[serve] ${d}`));
  await waitForServer(`${BASE}/index.html`);

  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'],
  });

  const pageErrors = [];
  try {
    const page = await browser.newPage();
    page.on('pageerror', (err) => pageErrors.push('pageerror: ' + err.message));
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const t = msg.text();
      if (t.includes('ERR_TUNNEL_CONNECTION_FAILED')) return; // ジャケット取得の失敗は除外してよい
      pageErrors.push('console: ' + t);
    });

    await page.goto(`${BASE}/index.html`);
    await page.waitForTimeout(500);

    // ---- ヘルパー ----
    const openSettings = async () => {
      const isOpen = await page.evaluate(() => document.querySelector('#sheetSettings').classList.contains('open'));
      if (!isOpen) {
        await page.click('#btnSettings');
        await page.waitForSelector('#sheetSettings.open');
      }
    };
    const closeSettings = async () => {
      const isOpen = await page.evaluate(() => document.querySelector('#sheetSettings').classList.contains('open'));
      if (isOpen) {
        await page.click('#sheetSettings [data-close]');
        await page.waitForFunction(() => !document.querySelector('#sheetSettings').classList.contains('open'));
      }
    };
    const openAppearanceDialog = async (act) => {
      await openSettings();
      await page.click(`#settingsBody [data-act="${act}"]`);
      await page.waitForSelector('#dialogWrap:not([hidden])');
    };
    const setTheme = async (id) => {
      await openAppearanceDialog('theme');
      await page.click(`.theme-opt[data-id="${id}"]`);
      await page.waitForFunction((v) => document.body.dataset.theme === v, id, { timeout: 5000 });
      await closeSettings();
    };
    const setAccent = async (id) => {
      await openAppearanceDialog('accent');
      await page.click(`.acc-opt[data-id="${id}"]`);
      await page.waitForFunction((v) => document.body.dataset.accent === v, id, { timeout: 5000 });
      await closeSettings();
    };
    const waitForIconKey = async (expectNot) => {
      await page.waitForFunction(
        (notKey) =>
          new Promise((resolve) => {
            const r = indexedDB.open('kbmusic');
            r.onsuccess = () => {
              const db = r.result;
              const t = db.transaction('settings', 'readonly');
              const g = t.objectStore('settings').get('iconKey');
              g.onsuccess = () => resolve(g.result && g.result !== notKey);
              g.onerror = () => resolve(false);
            };
            r.onerror = () => resolve(false);
          }),
        expectNot,
        { timeout: 8000 }
      );
    };

    // ---- 1. settings ストアに icon192 / icon512 / iconMask512 が Blob として入っている ----
    await step('起動後、settings に icon192/icon512/iconMask512 が Blob(size>0) で入っている', async () => {
      // 生成は待たずに走る処理なので、少し待つ
      await page.waitForFunction(
        () =>
          new Promise((resolve) => {
            const r = indexedDB.open('kbmusic');
            r.onsuccess = () => {
              const db = r.result;
              const t = db.transaction('settings', 'readonly');
              const g = t.objectStore('settings').get('icon192');
              g.onsuccess = () => resolve(!!g.result);
              g.onerror = () => resolve(false);
            };
            r.onerror = () => resolve(false);
          }),
        { timeout: 8000 }
      );
      const check = await page.evaluate(() => {
        return new Promise((resolve, reject) => {
          const r = indexedDB.open('kbmusic');
          r.onerror = () => reject(r.error);
          r.onsuccess = () => {
            const db = r.result;
            const t = db.transaction('settings', 'readonly');
            const s = t.objectStore('settings');
            const keys = ['icon192', 'icon512', 'iconMask512'];
            Promise.all(
              keys.map(
                (k) =>
                  new Promise((res2, rej2) => {
                    const g = s.get(k);
                    g.onsuccess = () => res2({ k, isBlob: g.result instanceof Blob, size: g.result ? g.result.size : 0 });
                    g.onerror = () => rej2(g.error);
                  })
              )
            ).then(resolve, reject);
          };
        });
      });
      for (const c of check) {
        assert(c.isBlob, `${c.k} が Blob でない`);
        assert(c.size > 0, `${c.k} の size が 0`);
      }
    });

    // ---- 2. <link rel="icon"> の href が blob: で始まる ----
    await step('<link id="favicon"> の href が blob: で始まる（生成物に差し替わっている）', async () => {
      const href = await page.evaluate(() => document.getElementById('favicon').href);
      assert(href.startsWith('blob:'), `href=${href}`);
    });

    // ---- 3・4. 墨×苔 で画素を確認 ----
    let sumiKokeBase64;
    await step('テーマ「墨」×アクセント「苔」で、192の下地部分が墨の下地色に近い', async () => {
      await setTheme('sumi');
      await setAccent('koke');
      await page.waitForTimeout(300);
      const got = await blobArrayBufferBase64(page, 'icon192');
      assert(got && got.base64, 'icon192 が取れない');
      sumiKokeBase64 = got.base64;

      const pixels = await page.evaluate((b64) => {
        return new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            const size = img.naturalWidth;
            const c = document.createElement('canvas');
            c.width = size;
            c.height = size;
            const ctx = c.getContext('2d');
            ctx.drawImage(img, 0, 0);
            // 角丸（半径 size*0.22）の外側と、中央の音符（おおむね 29%〜73% の範囲）の
            // どちらも避けて、四辺のまん中あたりの「下地しかない場所」を見る
            const a = Math.round(size * 0.08);
            const h = Math.round(size * 0.5);
            const pts = [
              [h, a],
              [h, size - a],
              [a, h],
              [size - a, h],
            ];
            const out = pts.map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data));
            resolve({ size, corners: out });
          };
          img.onerror = reject;
          img.src = 'data:image/png;base64,' + b64;
        });
      }, sumiKokeBase64);

      const bg = [0x0b, 0x0b, 0x0d];
      for (const px of pixels.corners) {
        for (let i = 0; i < 3; i++) {
          assert(Math.abs(px[i] - bg[i]) <= 12, `下地の画素=${JSON.stringify(px)} bg=${JSON.stringify(bg)}`);
        }
      }
    });

    await step('同じ条件で、苔の音符色に近い画素が全画素の3%以上ある', async () => {
      const found = await page.evaluate((b64) => {
        return new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            const size = img.naturalWidth;
            const c = document.createElement('canvas');
            c.width = size;
            c.height = size;
            const ctx = c.getContext('2d');
            ctx.drawImage(img, 0, 0);
            const data = ctx.getImageData(0, 0, size, size).data;
            const target = [0x83, 0x94, 0x72];
            let hit = 0;
            const total = size * size;
            for (let i = 0; i < data.length; i += 4) {
              const dr = Math.abs(data[i] - target[0]);
              const dg = Math.abs(data[i + 1] - target[1]);
              const db2 = Math.abs(data[i + 2] - target[2]);
              if (dr <= 24 && dg <= 24 && db2 <= 24) hit++;
            }
            resolve(hit / total);
          };
          img.onerror = reject;
          img.src = 'data:image/png;base64,' + b64;
        });
      }, sumiKokeBase64);
      assert(found >= 0.03, `note-color ratio=${found}`);
    });

    // ---- 5. アクセントを「錆」に変えると iconKey と 192 の中身が変わる ----
    await step('アクセントを「錆」に変えると iconKey が変わり、192の中身も変わる', async () => {
      const keyBefore = await readSetting(page, 'iconKey');
      const beforeHead = await blobHeadBase64(page, 'icon192', 2048);
      await setAccent('sabi');
      await waitForIconKey(keyBefore);
      const keyAfter = await readSetting(page, 'iconKey');
      assert(keyAfter !== keyBefore, `iconKey が変わっていない: ${keyBefore}`);

      // 同じ size になる可能性があるので、先頭2KBを同じ切り出し方で比較する
      const afterHead = await blobHeadBase64(page, 'icon192', 2048);
      assert(beforeHead && afterHead, '192 の先頭2KBが取れない');
      assert(beforeHead !== afterHead, '苔と錆で 192 の先頭2KBが同じ（中身が変わっていない）');
    });

    // ---- 6. 白磁×芥子でも音符が沈まない ----
    await step('テーマ「白磁」×アクセント「芥子」でも、音符色と下地のコントラストが3.0以上', async () => {
      await setTheme('hakuji');
      await setAccent('karashi');
      await page.waitForTimeout(300);
      const iconKey = await readSetting(page, 'iconKey');
      assert(iconKey && iconKey.includes('|'), `iconKey が不正: ${iconKey}`);
      const [bg, note] = iconKey.split('|');
      const ratio = contrastRatio(note, bg);
      assert(ratio >= 3.0, `iconKey=${iconKey} ratio=${ratio.toFixed(2)}`);
    });

    // ---- 7. Service Worker 経由で icons/icon-192.png を取ると、保存Blobと同じ中身 ----
    await step('Service Worker 経由の icons/icon-192.png が、保存してある icon192 と同じ中身', async () => {
      await page.waitForFunction(() => !!navigator.serviceWorker.controller, { timeout: 10000 }).catch(() => {});
      await page.evaluate(() => navigator.serviceWorker.ready);
      if (!(await page.evaluate(() => !!navigator.serviceWorker.controller))) {
        await page.reload();
        await page.waitForTimeout(500);
        await page.evaluate(() => navigator.serviceWorker.ready);
      }

      const swBase64 = await page.evaluate(async () => {
        const res = await fetch('icons/icon-192.png', { cache: 'no-store' });
        const buf = await res.arrayBuffer();
        const bytes = new Uint8Array(buf).slice(0, 2048);
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin);
      });
      const dbHead = await blobHeadBase64(page, 'icon192', 2048);
      assert(dbHead, 'icon192 が取れない');
      assert(swBase64 === dbHead, 'SW経由のPNGと保存Blobの先頭2KBが一致しない');
    });

    // ---- 8. ページ内エラーが出ていないこと ----
    await step('ページ内エラー（pageerror/console error）が出ていない', () => {
      assert(pageErrors.length === 0, JSON.stringify(pageErrors).slice(0, 500));
    });
  } finally {
    await browser.close();
    serverProc.kill();
  }
}

main()
  .then(() => {
    const passed = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) {
      console.log('\n失敗した項目:');
      for (const r of results.filter((r) => !r.ok)) console.log(` - ${r.name}: ${r.detail}`);
    }
    process.exit(failed > 0 ? 1 : 0);
  })
  .catch((e) => {
    console.error('テスト実行自体が失敗:', e);
    process.exit(1);
  });
