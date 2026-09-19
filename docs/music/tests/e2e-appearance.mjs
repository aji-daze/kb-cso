// 見た目（テーマ・アクセント・フォント）刷新の E2E テスト。
// 使い方: node docs/music/tests/e2e-appearance.mjs
// サーバは自分で起動・停止する。最後に `N passed, M failed` を出して、
// 失敗があれば終了コード 1。
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8902;
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

// ---- WCAG の相対輝度比 ----
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

    // ---- 1. 既定値 ----
    await step('既定で body[data-theme=sumi][data-accent=kohaku][data-font=system]になっている', async () => {
      const ds = await page.evaluate(() => ({ ...document.body.dataset }));
      assert(ds.theme === 'sumi', `theme=${ds.theme}`);
      assert(ds.accent === 'kohaku', `accent=${ds.accent}`);
      assert(ds.font === 'system', `font=${ds.font}`);
    });

    // ---- 2. テーマ「白磁」を選ぶ ----
    await step('設定→テーマで「白磁」を選ぶと data-theme が hakuji になり、下地が明るくなる', async () => {
      await openAppearanceDialog('theme');
      await page.click('.theme-opt[data-id="hakuji"]');
      await page.waitForFunction(() => document.body.dataset.theme === 'hakuji', { timeout: 5000 });
      const bgColor = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      const m = bgColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      assert(m, `unexpected color format: ${bgColor}`);
      const avg = (Number(m[1]) + Number(m[2]) + Number(m[3])) / 3;
      assert(avg >= 200, `avg=${avg} (${bgColor})`);
      await closeSettings();
    });

    // ---- 3. 再読み込みしても維持される ----
    await step('再読み込みしても「白磁」のままである（保存されている）', async () => {
      await page.reload();
      await page.waitForTimeout(500);
      const theme = await page.evaluate(() => document.body.dataset.theme);
      assert(theme === 'hakuji', `theme=${theme}`);
    });

    // ---- 4. アクセント「苔」を選ぶ ----
    await step('アクセントで「苔」を選ぶと data-accent が koke になり、.btn.primary の背景色が一致する', async () => {
      await openAppearanceDialog('accent');
      await page.click('.acc-opt[data-id="koke"]');
      await page.waitForFunction(() => document.body.dataset.accent === 'koke', { timeout: 5000 });
      await closeSettings();

      // .btn.primary を画面に出す（プレイリスト作成ダイアログの「OK」ボタン）
      await page.click('#tabs button[data-tab="playlists"]');
      await page.click('.row[data-act="newpl"]');
      await page.waitForSelector('#dialogWrap:not([hidden])');
      const color = await page.evaluate(() => getComputedStyle(document.querySelector('.btn.primary')).backgroundColor);
      assert(color === 'rgb(131, 148, 114)', `color=${color}`);
      await page.click('#pc'); // キャンセルで閉じる
    });

    // ---- 5. アクセント「モノクロ」 ----
    await step('アクセントで「モノクロ」を選ぶと --acc が --tx と同じ値に解決される', async () => {
      await openAppearanceDialog('accent');
      await page.click('.acc-opt[data-id="mono"]');
      await page.waitForFunction(() => document.body.dataset.accent === 'mono', { timeout: 5000 });
      const { acc, tx } = await page.evaluate(() => {
        const cs = getComputedStyle(document.body);
        return { acc: cs.getPropertyValue('--acc').trim(), tx: cs.getPropertyValue('--tx').trim() };
      });
      assert(acc === tx && acc.length > 0, `acc=${acc} tx=${tx}`);
      await closeSettings();
      // 元に戻しておく（以降のテストへの影響を避ける）
      await openAppearanceDialog('accent');
      await page.click('.acc-opt[data-id="kohaku"]');
      await page.waitForFunction(() => document.body.dataset.accent === 'kohaku', { timeout: 5000 });
      await closeSettings();
    });

    // ---- 6. フォント「明朝」 ----
    await step('フォントで「明朝」を選ぶと data-font が mincho になり、font-family に serif を含む', async () => {
      await openAppearanceDialog('font');
      await page.click('.font-opt[data-id="mincho"]');
      await page.waitForFunction(() => document.body.dataset.font === 'mincho', { timeout: 5000 });
      const ff = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
      assert(ff.includes('serif'), `fontFamily=${ff}`);
      await closeSettings();
    });

    // ---- 7. theme-color メタタグ ----
    await step('<meta name="theme-color"> が選んだテーマの下地色になる', async () => {
      const content = await page.evaluate(() => document.querySelector('meta[name=theme-color]').getAttribute('content'));
      // この時点でテーマは「白磁」のまま（#ffffff）
      assert(content.toLowerCase() === '#ffffff', `content=${content}`);
    });

    // ---- 8. 全テーマでコントラスト比が十分 ----
    const THEME_IDS = ['sumi', 'kiri', 'hai', 'aitetsu', 'kinari', 'hakuji'];
    await step('どのテーマでも文字と下地・補助文字と下地のコントラストが十分（WCAG）', async () => {
      const problems = [];
      for (const id of THEME_IDS) {
        const { bg, tx, sub } = await page.evaluate((themeId) => {
          document.body.dataset.theme = themeId;
          const cs = getComputedStyle(document.body);
          return {
            bg: cs.getPropertyValue('--bg').trim(),
            tx: cs.getPropertyValue('--tx').trim(),
            sub: cs.getPropertyValue('--sub').trim(),
          };
        }, id);
        const txRatio = contrastRatio(tx, bg);
        const subRatio = contrastRatio(sub, bg);
        if (txRatio < 7) problems.push(`${id}: tx/bg=${txRatio.toFixed(2)} (<7)`);
        if (subRatio < 4.5) problems.push(`${id}: sub/bg=${subRatio.toFixed(2)} (<4.5)`);
      }
      // 元のテーマ（白磁）に戻す
      await page.evaluate(() => (document.body.dataset.theme = 'hakuji'));
      assert(problems.length === 0, problems.join(' / '));
    });

    // ---- 9. ページ内エラーが出ていないこと ----
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
