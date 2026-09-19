// 集中タイマー（作業→休憩の往復）。終わり時刻を保存するので、
// 画面を閉じて戻ってきても続きから表示される。

const Timer = (() => {
  let tick = null;
  let next = 'focus';  // 次に始めるのは作業か休憩か
  let hint = '';       // 「休憩へ」のような案内

  function state() { return Store.get().timer; }

  function todayLog() {
    const s = Store.get();
    const k = U.dateKey(new Date());
    if (!s.focusLog[k]) s.focusLog[k] = { count: 0, min: 0 };
    return s.focusLog[k];
  }

  function start(mode) {
    const s = Store.get();
    const len = mode === 'break' ? s.settings.breakMin : s.settings.focusMin;
    s.timer = { mode, endsAt: Date.now() + len * 60 * 1000, len };
    Store.save();
    run();
  }

  function stop() {
    if (state()) next = 'focus';  // 手で止めたら作業からやり直す
    hint = '';
    Store.get().timer = null;
    Store.save();
    render();
  }

  function finish() {
    const t = state();
    if (!t) return;
    if (t.mode === 'focus') {
      const log = todayLog();
      log.count += 1;
      log.min += t.len;
    }
    next = t.mode === 'focus' ? 'break' : 'focus';
    Store.get().timer = null;
    Store.save();
    notify(next);
    render();
  }

  function notify(nextMode) {
    try {
      if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 660;
      gain.gain.value = 0.05;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.35);
    } catch (e) { /* 音が出せない環境は黙って無視 */ }
    hint = nextMode === 'break' ? '休憩へ' : '作業へ';
  }

  function run() {
    if (tick) clearInterval(tick);
    tick = setInterval(render, 250);
    render();
  }

  function render() {
    const s = Store.get();
    const t = s.timer;
    const disp = U.el('timerDisplay');

    if (t) {
      const left = Math.max(0, t.endsAt - Date.now());
      const sec = Math.ceil(left / 1000);
      disp.textContent = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
      disp.classList.add('run');
      U.el('timerMode').textContent = t.mode === 'break' ? '休憩中' : '作業中';
      hint = '';
      U.el('btnTimer').textContent = '停止';
      if (left <= 0) finish();
    } else {
      if (tick) { clearInterval(tick); tick = null; }
      disp.classList.remove('run');
      disp.textContent = `${String(next === 'break' ? s.settings.breakMin : s.settings.focusMin).padStart(2, '0')}:00`;
      U.el('timerMode').textContent = hint || (next === 'break' ? '休憩待ち' : '待機');
      U.el('btnTimer').textContent = '開始';
    }

    const log = s.focusLog[U.dateKey(new Date())] || { count: 0, min: 0 };
    U.el('timerDone').textContent = `今日 ${log.count} 本`;
    U.el('timerMin').textContent = `${log.min} 分`;
  }

  function toggle() {
    if (state()) stop(); else start(next);
  }

  function bind() {
    U.el('btnTimer').addEventListener('click', toggle);
    U.el('btnTimerReset').addEventListener('click', stop);
    if (state()) run(); else render();
  }

  return { bind, render, toggle };
})();
