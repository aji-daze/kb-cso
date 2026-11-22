// 再生エンジン。<audio> を素で鳴らすのが一番安定するので、
// イコライザを使うときだけ Web Audio のグラフを後から挿し込む。
import * as db from './db.js';

export const audio = new Audio();
audio.preload = 'auto';

// pause() を呼ぶたびに理由を控えておき、'pause' イベント側でログに出せるようにする。
// 端末や他アプリがこちらの知らないところで止めた場合は理由が無いままになる。
// 理由には期限を付ける。pause() の直後に load() や src の差し替えをすると、HTML の仕様で
// 'pause' イベントが捨てられ、理由が使われないまま残る。残った理由が、あとで端末に止められた
// ときの pause に誤って付き、「自分で止めた」扱いになって自動再開が働かなかった。
let pauseReason = null;
let pauseReasonAt = 0;
// keep: true のときは無音の見張り役を止めない（読み直しなど、すぐ鳴らし直す前提の一時停止）
export function pauseWith(reason, { keep = false } = {}) {
  pauseReason = reason;
  pauseReasonAt = Date.now();
  if (!keep) stopKeepAlive();
  audio.pause();
}

// ---------- 無音の見張り役（keepalive） ----------
// Android は、裏で再生が一瞬でも途切れると「再生していないアプリ」とみなし、
// そこから新しく音を鳴らし始めるのを止めてしまうことがある（曲の切り替え直後に
// 位置0〜2秒で何度再開しても即座に止められる、という記録がこれに当たる）。
// そこで、本体とは別の <audio> で無音をループ再生し続け、曲の切り替えで本体が
// 一瞬止まっても「このアプリは再生中」の状態が途切れないようにする。
// Web Audio にはつながない（イコライザとは無関係）。音量は普通のまま、中身が無音。
let ka = null;
function silentWavUrl(seconds = 10, rate = 8000) {
  const n = seconds * rate;
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + n, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  str(36, 'data'); v.setUint32(40, n, true);
  new Uint8Array(buf, 44).fill(128); // 8bit PCM の無音
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}
export function startKeepAlive() {
  if (!ka) {
    ka = new Audio(silentWavUrl());
    ka.loop = true;
    ka.preload = 'auto';
  }
  if (!ka.paused) return Promise.resolve(true);
  return ka.play().then(() => true, () => false);
}
export function stopKeepAlive() {
  if (ka && !ka.paused) ka.pause();
}
export function keepAliveState() {
  return !ka ? 'none' : ka.paused ? 'off' : 'on';
}
export function takePauseReason() {
  const r = Date.now() - pauseReasonAt < 1500 ? pauseReason : null;
  pauseReason = null;
  return r;
}
// 再生が始まったら、使われずに残っている理由は捨てる
export function clearPauseReason() {
  pauseReason = null;
}

export const EQ_BANDS = [60, 230, 910, 3600, 14000];
export const EQ_PRESETS = {
  フラット: [0, 0, 0, 0, 0],
  ロック: [5, 3, -1, 3, 4],
  ポップ: [-1, 2, 4, 2, -1],
  ジャズ: [4, 2, -1, 2, 5],
  クラシック: [4, 2, -1, 3, 4],
  低音強調: [8, 5, 0, 0, 0],
  ボーカル: [-2, 0, 5, 3, 0],
};

let ctx = null;
let srcNode = null;
let filters = [];
let gainNode = null;
let eqOn = false;

function buildGraph() {
  if (ctx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  srcNode = ctx.createMediaElementSource(audio);
  filters = EQ_BANDS.map((hz, i) => {
    const f = ctx.createBiquadFilter();
    f.type = i === 0 ? 'lowshelf' : i === EQ_BANDS.length - 1 ? 'highshelf' : 'peaking';
    f.frequency.value = hz;
    f.Q.value = 1.0;
    f.gain.value = 0;
    return f;
  });
  gainNode = ctx.createGain();
  let node = srcNode;
  for (const f of filters) {
    node.connect(f);
    node = f;
  }
  node.connect(gainNode);
  gainNode.connect(ctx.destination);
}

export function eqEnabled() {
  return eqOn;
}

// 一度 MediaElementSource を作ると外せないので、OFF はゲインを素通しにして表現する。
// つまみが全部 0 のまま ON にしても、鳴らす音に違いが出ないので Web Audio へはつながない
// （つながずに済む間は素の <audio> のまま。つまみを動かした時点で必要になり次第つなぐ）。
export function setEqEnabled(on) {
  eqOn = !!on;
  if (eqOn && getEqGains().some((v) => v)) buildGraph();
  if (ctx) {
    const gains = eqOn ? getEqGains() : [0, 0, 0, 0, 0];
    filters.forEach((f, i) => {
      f.gain.value = gains[i] || 0;
    });
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  }
}

export function getEqGains() {
  return db.setting('eqGains', [0, 0, 0, 0, 0]).slice();
}

export async function setEqGain(index, value) {
  const g = getEqGains();
  g[index] = value;
  await db.setSetting('eqGains', g);
  if (eqOn && value && !ctx) buildGraph();
  if (ctx && eqOn && filters[index]) filters[index].gain.value = value;
}

export async function setEqGains(values) {
  await db.setSetting('eqGains', values.slice());
  if (eqOn && values.some((v) => v) && !ctx) buildGraph();
  if (ctx && eqOn) filters.forEach((f, i) => (f.gain.value = values[i] || 0));
}

export function setVolume(v) {
  audio.volume = Math.max(0, Math.min(1, v));
}

export function setRate(r) {
  audio.playbackRate = r;
  if ('preservesPitch' in audio) audio.preservesPitch = true;
  if ('mozPreservesPitch' in audio) audio.mozPreservesPitch = true;
  if ('webkitPreservesPitch' in audio) audio.webkitPreservesPitch = true;
}

export async function resumeContext() {
  if (ctx && ctx.state === 'suspended') {
    try {
      await ctx.resume();
    } catch {}
  }
}

export function contextState() {
  return ctx ? ctx.state : 'none';
}

// ---------- スリープタイマー ----------
let sleepTimer = null;
let sleepAt = 0;
let sleepAtTrackEnd = false;
const listeners = new Set();

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(type, detail) {
  listeners.forEach((fn) => fn(type, detail));
}

export function sleepState() {
  if (sleepAtTrackEnd) return { mode: 'trackEnd' };
  if (!sleepTimer) return { mode: 'off' };
  return { mode: 'time', remain: Math.max(0, sleepAt - Date.now()) };
}

export function cancelSleep() {
  if (sleepTimer) clearTimeout(sleepTimer);
  sleepTimer = null;
  stopFade(true); // フェードの途中で取り消されたら、音量を戻して止めない
  sleepAtTrackEnd = false;
  emit('sleep');
}

export function sleepAfterMinutes(min) {
  cancelSleep();
  sleepAt = Date.now() + min * 60000;
  sleepTimer = setTimeout(() => {
    fadeOutAndPause();
    sleepTimer = null;
    emit('sleep');
  }, min * 60000);
  emit('sleep');
}

export function sleepAfterTrack() {
  cancelSleep();
  sleepAtTrackEnd = true;
  emit('sleep');
}

export function consumeTrackEndSleep() {
  if (!sleepAtTrackEnd) return false;
  sleepAtTrackEnd = false;
  emit('sleep');
  return true;
}

// フェードは setInterval で刻む。requestAnimationFrame は画面が消えている間まったく動かないので、
// 寝る前にかけたタイマーが永遠に止まらない、ということが起きていた。
// 途中で cancelSleep() されたら音量を戻して中止する。
let fadeTimer = null;
let fadeStartVol = 1;
function stopFade(restore) {
  if (!fadeTimer) return;
  clearInterval(fadeTimer);
  fadeTimer = null;
  if (restore) audio.volume = fadeStartVol;
}
export function fadeOutAndPause(ms = 4000) {
  stopFade(true);
  // 画面が消えているとタイマーは間引かれて段階的なフェードにならないので、そのまま止める
  if (document.visibilityState !== 'visible') {
    pauseWith('スリープタイマー');
    return;
  }
  fadeStartVol = audio.volume;
  const t0 = Date.now();
  fadeTimer = setInterval(() => {
    const p = (Date.now() - t0) / ms;
    if (p >= 1) {
      stopFade(false);
      pauseWith('スリープタイマー');
      audio.volume = fadeStartVol;
      return;
    }
    audio.volume = fadeStartVol * (1 - p);
  }, 50);
}

// ---------- イヤホンが外れたときの保護 ----------
// Android/Chrome は「becoming noisy」で自動停止することが多いが、
// 端末によっては効かないので出力デバイスの増減も見張る。
let lastOutputs = -1;

// 曲が切り替わった直後は、出力の付け替えで devicechange が飛ぶことがある。
// そこで数え直すと「減った＝抜けた」と誤判定して再生を止めてしまうので、少しの間は見送る。
let guardQuietUntil = 0;
export function quietUnplugGuard(ms = 3000) {
  guardQuietUntil = Date.now() + ms;
}

export function setupUnplugGuard(getMode, onLog) {
  const countOutputs = async () => {
    const devs = await navigator.mediaDevices.enumerateDevices();
    return devs.filter((d) => d.kind === 'audiooutput').length;
  };
  const check = async () => {
    const mode = getMode();
    if (mode === 'off' || audio.paused) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    if (Date.now() < guardQuietUntil) {
      if (onLog) onLog('出力の変化を検知（曲の切り替え直後なので無視）');
      return;
    }
    try {
      const n = await countOutputs();
      // 0 件は「数えられない」であって「抜けた」ではない。Android は権限が無いと
      // 出力の一覧をまともに返さないことがあるので、0 は判断材料にしない。
      if (!(lastOutputs > 0 && n > 0 && n < lastOutputs)) {
        if (n > 0) lastOutputs = n;
        return;
      }
      // 一瞬の揺れで止めないよう、少し置いてもう一度数える
      await new Promise((r) => setTimeout(r, 700));
      const again = await countOutputs();
      if (again > 0 && again < lastOutputs && !audio.paused) {
        if (onLog) onLog(`イヤホンが外れたと判断（出力 ${lastOutputs} → ${again}）`);
        if (mode === 'mute') audio.volume = 0;
        else pauseWith('イヤホンが外れた');
        emit('unplug');
      } else if (onLog) {
        onLog(`出力が減ったが戻った（${lastOutputs} → ${n} → ${again}）ので止めない`);
      }
      if (again > 0) lastOutputs = again;
    } catch {}
  };
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', check);
  }
  // 初期値を控えておく
  if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
    navigator.mediaDevices
      .enumerateDevices()
      .then((d) => (lastOutputs = d.filter((x) => x.kind === 'audiooutput').length))
      .catch(() => {});
  }
}
