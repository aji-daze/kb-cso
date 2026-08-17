// 再生エンジン。<audio> を素で鳴らすのが一番安定するので、
// イコライザを使うときだけ Web Audio のグラフを後から挿し込む。
import * as db from './db.js';

export const audio = new Audio();
audio.preload = 'auto';

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
export function setEqEnabled(on) {
  eqOn = !!on;
  if (eqOn) buildGraph();
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
  if (ctx && eqOn && filters[index]) filters[index].gain.value = value;
}

export async function setEqGains(values) {
  await db.setSetting('eqGains', values.slice());
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

export function fadeOutAndPause(ms = 4000) {
  const start = audio.volume;
  const t0 = performance.now();
  const step = () => {
    const p = (performance.now() - t0) / ms;
    if (p >= 1) {
      audio.pause();
      audio.volume = start;
      return;
    }
    audio.volume = start * (1 - p);
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---------- イヤホンが外れたときの保護 ----------
// Android/Chrome は「becoming noisy」で自動停止することが多いが、
// 端末によっては効かないので出力デバイスの増減も見張る。
let lastOutputs = -1;

export function setupUnplugGuard(getMode) {
  const check = async () => {
    const mode = getMode();
    if (mode === 'off' || audio.paused) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const n = devs.filter((d) => d.kind === 'audiooutput').length;
      if (lastOutputs >= 0 && n < lastOutputs) {
        if (mode === 'mute') audio.volume = 0;
        else audio.pause();
        emit('unplug');
      }
      lastOutputs = n;
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
