// 「外部要因で止まる」対策の E2E テスト。
// 使い方: node docs/music/tests/e2e-resume.mjs
// サーバは自分で起動・停止する。最後に `N passed, M failed` を出して、
// 失敗があれば終了コード 1。
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { makeMp3, selfCheckInBrowser } from './mkmp3.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8899;
const BASE = `http://localhost:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

    // ---- mkmp3 の自己検証 ----
    await step('mkmp3: 生成したMP3をブラウザで読ませるとdurationが指定秒数の±1秒に入る', async () => {
      const buf = makeMp3({ title: 'SelfCheck', artist: 'X', album: 'Y', trackNo: 1, seconds: 5 });
      const { ok, duration } = await selfCheckInBrowser(page, buf, 5);
      assert(ok, `duration=${duration}`);
    });

    // ---- テスト用の曲を用意して取り込む ----
    const SONGS = [1, 2, 3, 4, 5].map((n) => ({
      name: `song${n}.mp3`,
      title: `Song ${n}`,
      buf: makeMp3({ title: `Song ${n}`, artist: 'Test Artist', album: 'Test Album', trackNo: n, seconds: 6 }),
    }));

    await step('取り込み: 数曲を取り込んで一覧に出る', async () => {
      await page.locator('#filePick').setInputFiles(
        SONGS.map((s) => ({ name: s.name, mimeType: 'audio/mpeg', buffer: s.buf }))
      );
      await page.waitForFunction(
        (n) => document.querySelectorAll('#view .row[data-act="play"]').length >= n,
        SONGS.length,
        { timeout: 20000 }
      );
      const count = await page.locator('#view .row[data-act="play"]').count();
      assert(count >= SONGS.length, `count=${count}`);
    });

    // ---- ヘルパー ----
    const rowFor = (title) => page.locator('#view .row[data-act="play"]').filter({ hasText: title });
    const clickSong = async (title) => {
      await rowFor(title).first().click();
      await page.waitForFunction((t) => document.querySelector('#miniTitle')?.textContent === t, title, { timeout: 10000 });
    };
    const audioState = () =>
      page.evaluate(async () => {
        const P = await import('./js/player.js');
        return { paused: P.audio.paused, currentTime: P.audio.currentTime, readyState: P.audio.readyState, ended: P.audio.ended };
      });
    const externalPause = () =>
      page.evaluate(async () => {
        const P = await import('./js/player.js');
        P.audio.pause();
      });
    const currentTitle = () => page.evaluate(() => document.querySelector('#miniTitle')?.textContent || '');

    const openSheetNow = async () => {
      const isOpen = await page.evaluate(() => document.querySelector('#sheetNow').classList.contains('open'));
      if (!isOpen) {
        await page.click('#miniTitle');
        await page.waitForSelector('#sheetNow.open');
      }
    };
    const closeSheetNow = async () => {
      const isOpen = await page.evaluate(() => document.querySelector('#sheetNow').classList.contains('open'));
      if (isOpen) {
        await page.click('#sheetNow [data-close]');
        await page.waitForFunction(() => !document.querySelector('#sheetNow').classList.contains('open'));
      }
    };
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
    const readPlayLog = async () => {
      // #btnSettings は再生中画面（sheetNow）の下に隠れているので、開いていたら一旦閉じる
      const sheetNowWasOpen = await page.evaluate(() => document.querySelector('#sheetNow').classList.contains('open'));
      if (sheetNowWasOpen) await closeSheetNow();
      await openSettings();
      await page.click('#settingsBody [data-act="playLog"]');
      await page.waitForSelector('#dialogWrap:not([hidden])');
      const text = await page.locator('#dialog').innerText();
      await page.click('#plClose');
      await page.waitForFunction(() => document.querySelector('#dialogWrap').hidden === true);
      await closeSettings();
      if (sheetNowWasOpen) await openSheetNow();
      return text;
    };
    const setAutoResume = async (on) => {
      const sheetNowWasOpen = await page.evaluate(() => document.querySelector('#sheetNow').classList.contains('open'));
      if (sheetNowWasOpen) await closeSheetNow();
      await openSettings();
      const isOn = await page.evaluate(
        () => document.querySelector('[data-act="toggleAutoResume"] .switch')?.classList.contains('on') ?? true
      );
      if (isOn !== on) {
        await page.click('#settingsBody [data-act="toggleAutoResume"]');
        await page.waitForFunction(
          (want) => document.querySelector('[data-act="toggleAutoResume"] .switch')?.classList.contains('on') === want,
          on
        );
      }
    };

    // ---- 基本の再生経路: 1曲目を再生 → 曲の終わりで2曲目に自動で進む ----
    await step('基本再生: 1曲目を再生できる', async () => {
      await clickSong('Song 1');
      await sleep(300);
      const s = await audioState();
      assert(!s.paused, 'audio should be playing');
    });

    await step('基本再生: 曲の終わりで2曲目に自動で進み、2曲目も鳴っている', async () => {
      // 6秒の曲。終わるまで待つ（バッファ込みで最大12秒）
      await page.waitForFunction((t) => document.querySelector('#miniTitle')?.textContent === t, 'Song 2', { timeout: 14000 });
      await sleep(300);
      const s = await audioState();
      assert(!s.paused, 'Song 2 should be playing');
    });

    await step('ログ: 自動で進んだときは「次の曲へ（自動）」で［UI］を含まない', async () => {
      const log = await readPlayLog();
      const lines = log.split('\n').filter((l) => l.includes('次の曲へ'));
      const autoLine = lines.reverse().find((l) => l.includes('次の曲へ（自動）'));
      assert(autoLine, `log has no auto-advance line. lines=${JSON.stringify(lines)}`);
      assert(!autoLine.includes('［UI］'), `auto line should not contain ［UI］: ${autoLine}`);
    });
    await closeSettings();

    // ---- #btnNext（再生中画面）を押したときのログ ----
    await step('UIで次へ: #btnNext を押すと3曲目へ進み、ログに「次の曲へ［UI］」', async () => {
      await openSheetNow();
      await page.click('#btnNext');
      await page.waitForFunction((t) => document.querySelector('#nowTitle')?.textContent === t, 'Song 3', { timeout: 8000 });
      const log = await readPlayLog();
      assert(log.includes('次の曲へ［UI］'), 'log missing 次の曲へ［UI］');
    });

    // ---- 一時停止ボタン（ユーザー操作）では自動再開が働かない ----
    await step('ユーザー操作の一時停止では自動再開が働かない', async () => {
      await openSheetNow();
      await page.click('#btnPlay'); // 再生中なので一時停止になる
      await sleep(200);
      let s = await audioState();
      assert(s.paused, 'audio should be paused after btnPlay');
      const logBefore = await readPlayLog();
      assert(logBefore.includes('一時停止［ユーザー操作］'), 'log missing 一時停止［ユーザー操作］');
      await sleep(3000);
      s = await audioState();
      assert(s.paused, 'audio should still be paused (no auto-resume) after user pause');
      const logAfter = await readPlayLog();
      assert(!logAfter.includes('外部で止まったので再開を試みる'), 'should not have attempted auto-resume after user pause');
    });
    await closeSheetNow();

    // ---- 外部pauseからの自動再開（1回目は成功、短い間隔で繰り返すと3回目以降は諦める） ----
    await step('外部pauseの直後、2.5秒以内に再生が自動で再開する', async () => {
      await clickSong('Song 4');
      await sleep(400); // readyState が上がるのを待つ
      await externalPause();
      await sleep(2500);
      const log = await readPlayLog();
      // 曲を選んだ直後・位置ほぼ0秒なので「曲の切り替え直後」と判定されるのが正しい
      assert(log.includes('曲の切り替え直後に止められた。再開を試みる'), 'log missing 切り替え直後の再開');
      assert(log.includes('再開できた'), 'log missing 再開できた');
      const s = await audioState();
      assert(!s.paused, 'audio should have resumed');
    });

    await step('同じ曲で外部pauseを短い間隔で繰り返すと3回目以降は再開しない', async () => {
      // 再開直後（5秒以内）にもう一度外部pause → 本物とみなして諦める
      await externalPause();
      await sleep(300);
      let log = await readPlayLog();
      assert(log.includes('外部の要求と判断して諦める'), 'log missing 諦める');
      let s = await audioState();
      assert(s.paused, 'audio should remain paused after quick repeat pause');

      // 手動で再生に戻してから、もう一度外部pauseしても再開されない（3回目以降）
      await openSheetNow();
      await page.click('#btnPlay');
      await sleep(300);
      s = await audioState();
      assert(!s.paused, 'manual resume should work');
      const logBefore = await readPlayLog();
      await externalPause();
      await sleep(2500);
      s = await audioState();
      assert(s.paused, 'audio should stay paused (3rd external pause, no more attempts)');
      const logAfter = await readPlayLog();
      // ログは新しい行ほど前に出る（表示は新しい順）ので、増えた分は先頭側に出る
      const added = logAfter.slice(0, Math.max(0, logAfter.length - logBefore.length));
      assert(!added.includes('外部で止まったので再開を試みる'), `should not attempt a 3rd resume. added=${added}`);
    });
    await closeSheetNow();

    // ---- 設定で自動再開をオフにすると復帰しない ----
    await step('設定オフ: 外部pauseのあと止まったままになる', async () => {
      await setAutoResume(false);
      await closeSettings();
      await clickSong('Song 5');
      await sleep(400);
      const logBefore = await readPlayLog();
      await externalPause();
      await sleep(2500);
      const s = await audioState();
      assert(s.paused, 'audio should remain paused when autoResume is off');
      const logAfter = await readPlayLog();
      const added = logAfter.slice(0, Math.max(0, logAfter.length - logBefore.length));
      assert(!added.includes('外部で止まったので再開を試みる'), `should not attempt resume when setting is off. added=${added}`);
      await setAutoResume(true); // 後始末
      await closeSettings();
    });

    // ---- ここから spec-stop3.md の追加確認項目1〜6 ----

    // 1. 曲の切り替え直後（位置0秒）の外部pauseは、2回連続で止められても諦めない
    await step('切り替え直後: 外部pauseが続いても諦めず、読み込みから4秒を越えても粘る', async () => {
      await clickSong('Song 1');
      await sleep(300);
      const before = await readPlayLog();
      const addedSince = (full) => full.slice(0, Math.max(0, full.length - before.length));
      // 「再開できた」相当の動きを自前で作りつつ、位置0秒・読み込み直後のまま外部pauseを繰り返す
      await externalPause(); // 1回目
      await sleep(150);
      await page.evaluate(async () => {
        const P = await import('./js/player.js');
        await P.audio.play().catch(() => {});
      });
      await sleep(80);
      await externalPause(); // 2回目
      await sleep(150);
      await page.evaluate(async () => {
        const P = await import('./js/player.js');
        await P.audio.play().catch(() => {});
      });
      await sleep(80);
      await externalPause(); // 3回目
      await sleep(150);
      let added = addedSince(await readPlayLog());
      assert(added.includes('再開を試みる（3回目）'), `3回目の再開が無い. 増えた分=${added.slice(0, 400)}`);
      assert(!added.includes('外部の要求と判断して諦める'), `切り替え直後に諦めてはいけない. 増えた分=${added.slice(0, 400)}`);

      // 3回目の待ちは4秒。読み込みから4秒を越えたあとの pause でも、位置が0秒のままなら
      // 「切り替え直後」の判定を保って粘ること（ここを取りこぼすと実機で諦めてしまう）
      await sleep(4200);
      await page.evaluate(async () => {
        const P = await import('./js/player.js');
        P.audio.currentTime = 0;
        await P.audio.play().catch(() => {});
      });
      await sleep(80);
      await externalPause(); // 4回目
      await sleep(200);
      added = addedSince(await readPlayLog());
      assert(
        added.includes('再開を試みる（4回目）'),
        `読み込みから4秒を越えると諦めてしまっている. 増えた分=${added.slice(0, 400)}`
      );
      assert(
        !added.includes('外部の要求と判断して諦める'),
        `4秒を越えても「外部の要求」で諦めてはいけない. 増えた分=${added.slice(0, 400)}`
      );
    });

    // 2. 曲の途中での外部pauseは、従来どおり2回で諦める
    await step('曲の途中: 外部pauseは従来どおり2回で諦める', async () => {
      await clickSong('Song 2');
      await sleep(300);
      await page.evaluate(async () => {
        const P = await import('./js/player.js');
        P.audio.currentTime = 3; // 曲の途中まで進める（切り替え直後の判定に入らないように）
      });
      await sleep(100);
      await externalPause(); // 1回目: 再開を試みる
      await sleep(1300); // 900ms後の自動再開が成功するのを待つ
      await page.evaluate(async () => {
        const P = await import('./js/player.js');
        P.audio.currentTime = 3; // 引き続き曲の途中の位置にしておく
      });
      await externalPause(); // 2回目: 再開直後にまた止められた＝本物の要求として諦める
      await sleep(300);
      const log = await readPlayLog();
      assert(log.includes('外部の要求と判断して諦める'), 'log missing 諦める（曲の途中）');
      const s = await audioState();
      assert(s.paused, 'audio should remain paused (曲の途中で2回止められたら諦める)');
    });

    // 3. 曲が終わって次の曲へ進むとき、mediaSession.playbackState が 'paused' にならない
    await step('曲の切り替え中はmediaSession.playbackStateがpausedにならない', async () => {
      await clickSong('Song 3');
      await sleep(300);
      await page.evaluate(() => {
        window.__msStates = [];
        const ms = navigator.mediaSession;
        let val = ms.playbackState;
        Object.defineProperty(ms, 'playbackState', {
          configurable: true,
          get() {
            return val;
          },
          set(v) {
            window.__msStates.push(v);
            val = v;
          },
        });
      });
      // 6秒の曲が終わって次の曲へ進むのを待つ（バッファ込みで最大14秒）
      await page.waitForFunction((t) => document.querySelector('#miniTitle')?.textContent === t, 'Song 4', { timeout: 14000 });
      await sleep(300);
      const states = await page.evaluate(() => window.__msStates);
      assert(!states.includes('paused'), `playbackState should never be 'paused' across a track switch. states=${JSON.stringify(states)}`);
    });

    // 4. 音源を差し替える前に曲情報が端末へ渡っている
    await step('切り替え時: audio.srcを差し替える前にMediaMetadataが新しい曲名で設定される', async () => {
      await openSheetNow();
      const oldTitle = await page.evaluate(() => document.querySelector('#nowTitle')?.textContent || '');
      await page.evaluate(async () => {
        const P = await import('./js/player.js');
        window.__order = [];
        const audio = P.audio;
        const desc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
        Object.defineProperty(audio, 'src', {
          configurable: true,
          get() {
            return desc.get.call(audio);
          },
          set(v) {
            window.__order.push({ type: 'src' });
            return desc.set.call(audio, v);
          },
        });
        window.__origMediaMetadata = window.MediaMetadata;
        const OrigMD = window.__origMediaMetadata;
        window.MediaMetadata = function (init) {
          window.__order.push({ type: 'metadata', title: init && init.title });
          return new OrigMD(init);
        };
      });
      await page.click('#btnNext');
      await page.waitForFunction(
        (old) => document.querySelector('#nowTitle')?.textContent && document.querySelector('#nowTitle').textContent !== old,
        oldTitle,
        { timeout: 8000 }
      );
      const newTitle = await page.evaluate(() => document.querySelector('#nowTitle')?.textContent || '');
      const order = await page.evaluate(() => window.__order);
      // 後始末: フックを外す（以降のテストへ影響しないように）
      await page.evaluate(async () => {
        const P = await import('./js/player.js');
        delete P.audio.src;
        window.MediaMetadata = window.__origMediaMetadata;
      });
      const srcIdx = order.findIndex((e) => e.type === 'src');
      assert(srcIdx >= 0, `src の差し替えを検知できなかった. order=${JSON.stringify(order)}`);
      const metaBefore = order.slice(0, srcIdx).filter((e) => e.type === 'metadata');
      assert(metaBefore.length > 0, `src を差し替える前に MediaMetadata の設定が無い. order=${JSON.stringify(order)}`);
      assert(
        metaBefore[metaBefore.length - 1].title === newTitle,
        `src を差し替える前の MediaMetadata が新しい曲名になっていない. order=${JSON.stringify(order)} newTitle=${newTitle}`
      );
    });
    await closeSheetNow();

    // 5. 諦めたあと、画面表示に戻ると一度だけ再開する
    await step('諦めたあと画面表示に戻ると一度だけ再開する', async () => {
      await clickSong('Song 5');
      await sleep(300);
      await page.evaluate(async () => {
        const P = await import('./js/player.js');
        P.audio.currentTime = 3;
        Object.defineProperty(document, 'visibilityState', {
          configurable: true,
          get: () => window.__fakeVisibility || 'visible',
        });
        window.__fakeVisibility = 'hidden';
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await externalPause(); // 1回目: 再開を試みる（裏）
      await sleep(1300); // 自動再開の成功を待つ
      await page.evaluate(async () => {
        const P = await import('./js/player.js');
        P.audio.currentTime = 3;
      });
      await externalPause(); // 2回目: 本物の要求と判断して裏で諦める
      await sleep(300);
      let log = await readPlayLog();
      assert(log.includes('外部の要求と判断して諦める'), 'log missing 諦める（画面裏）');
      let s = await audioState();
      assert(s.paused, 'audio should remain paused after giving up while hidden');

      // 画面に戻る
      await page.evaluate(() => {
        window.__fakeVisibility = 'visible';
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await sleep(1000);
      log = await readPlayLog();
      assert(log.includes('画面に戻ったので、止まっていた再生を再開する'), 'log missing 画面に戻ったので再開する');
      s = await audioState();
      assert(!s.paused, 'audio should resume once after returning to the foreground');

      // 後始末: 画面表示の偽装を外す
      await page.evaluate(() => {
        delete document.visibilityState;
      });
    });
    await closeSheetNow();

    // 6. つまみが全部0のときはイコライザをオンにしてもWeb Audioにつながらない
    await step('EQのつまみが全部0ならオンにしてもWeb Audioにつながらない。0以外を入れるとつながる', async () => {
      await page.evaluate(async () => {
        const P = await import('./js/player.js');
        P.setEqEnabled(false);
        await P.setEqGains([0, 0, 0, 0, 0]);
      });
      await page.evaluate(async () => {
        const P = await import('./js/player.js');
        P.setEqEnabled(true);
      });
      await sleep(100);
      let ctxState = await page.evaluate(async () => {
        const P = await import('./js/player.js');
        return P.contextState();
      });
      assert(ctxState === 'none', `gains all 0 のとき Web Audio につながってはいけない. ctxState=${ctxState}`);

      await page.evaluate(async () => {
        const P = await import('./js/player.js');
        await P.setEqGain(0, 5);
      });
      await sleep(100);
      ctxState = await page.evaluate(async () => {
        const P = await import('./js/player.js');
        return P.contextState();
      });
      assert(
        ctxState === 'running' || ctxState === 'suspended',
        `0以外のゲインを入れたら Web Audio につながるはず. ctxState=${ctxState}`
      );

      // 後始末: EQをオフに戻す
      await page.evaluate(async () => {
        const P = await import('./js/player.js');
        await P.setEqGains([0, 0, 0, 0, 0]);
        P.setEqEnabled(false);
      });
    });

    // ---- #miniStop（■）で再生が終わり、ミニプレーヤーが隠れる ----
    await step('#miniStop で再生が終わり、ミニプレーヤーが隠れる', async () => {
      await page.click('#miniStop');
      await page.waitForFunction(() => document.querySelector('#mini').hidden === true, { timeout: 5000 });
      const hidden = await page.evaluate(() => document.querySelector('#mini').hidden);
      assert(hidden, 'mini player should be hidden');
    });

    // ---- ページ内エラーが出ていないこと ----
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
