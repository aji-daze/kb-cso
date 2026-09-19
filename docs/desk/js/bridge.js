// ConTodo（aji-daze/chakushu）との連携。
// どちらも https://aji-daze.github.io で配信されるため同一オリジンになり、
// localStorage をそのまま読み書きできる。サーバーもトークンも要らない。
//
// 書き込む直前に必ず読み直す。ConTodo を別タブで開いていても、
// 相手の変更を消してしまわないようにするため。

const Bridge = (() => {
  const KEY = 'chakushu.v1';
  const TKEY = 'chakushu.timer.v2';

  function read(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; }
  }

  function state() {
    const s = read(KEY);
    if (!s || typeof s !== 'object') return null;
    ['tasks', 'sessions', 'events', 'shifts', 'jobs', 'parking'].forEach((k) => {
      if (!Array.isArray(s[k])) s[k] = [];
    });
    return s;
  }

  function available() { return !!state(); }

  // 読み直してから書く
  function write(fn) {
    const s = state();
    if (!s) return false;
    fn(s);
    s.rev = Date.now();
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { return false; }
    return true;
  }

  // ---------- タスク ----------
  // ConTodo は「タスク＋小さな一歩（steps）」を持つ。DESK では次の一歩を添えて出す。
  function tasks() {
    const s = state();
    if (!s) return [];
    return s.tasks.filter((t) => !t.sample || !t.done).map((t) => {
      const step = (t.steps || []).find((x) => !x.done) || null;
      return {
        id: t.id,
        text: t.title,
        step: step ? step.text : '',
        stepId: step ? step.id : null,
        done: !!t.done,
        src: 'contodo',
        at: 0,
      };
    });
  }

  // 次の一歩があればそれを、なければタスク自体を完了にする
  function advance(taskId) {
    return write((s) => {
      const t = s.tasks.find((x) => x.id === taskId);
      if (!t) return;
      const step = (t.steps || []).find((x) => !x.done);
      if (step) step.done = true;
      else t.done = !t.done;
    });
  }

  function undone(taskId) {
    return write((s) => {
      const t = s.tasks.find((x) => x.id === taskId);
      if (t) t.done = false;
    });
  }

  // ---------- 予定・シフト → タイムラインのブロック ----------
  function blocks(dateKey) {
    const s = state();
    if (!s) return [];
    const out = [];

    s.events.forEach((e) => {
      if (e.date !== dateKey || !e.start) return;
      out.push({
        id: 'ct-e-' + e.id, title: e.title,
        start: e.start, end: e.end || U.hm(U.min(e.start) + 60),
        kind: 'meet', repeat: 'none', date: dateKey, src: 'contodo',
      });
    });

    s.shifts.forEach((sh) => {
      if (sh.date !== dateKey || !sh.start) return;
      const job = s.jobs.find((j) => j.id === sh.jobId);
      out.push({
        id: 'ct-s-' + sh.id, title: (job && job.name) || 'シフト',
        start: sh.start, end: sh.end || U.hm(U.min(sh.start) + 60),
        kind: 'work', repeat: 'none', date: dateKey, src: 'contodo',
      });
    });

    return out;
  }

  // ---------- 集中の記録 ----------
  function focus(dateKey) {
    const s = state();
    if (!s) return null;
    const today = s.sessions.filter((x) => dayKey(x.at) === dateKey);
    return {
      min: today.reduce((a, x) => a + (x.min || 0), 0),
      count: today.filter((x) => x.complete).length,
      streak: streak(s.sessions),
    };
  }

  function dayKey(ms) { return U.dateKey(new Date(ms)); }

  function streak(sessions) {
    const days = new Set(sessions.map((x) => dayKey(x.at)));
    let n = 0;
    const d = new Date();
    // 今日がまだ0分なら、昨日までの連続として数える
    if (!days.has(U.dateKey(d))) d.setDate(d.getDate() - 1);
    while (days.has(U.dateKey(d))) { n += 1; d.setDate(d.getDate() - 1); }
    return n;
  }

  // DESK で回した集中も ConTodo の記録に入れる（kind で区別できるようにする）
  function logSession(min, complete) {
    return write((s) => {
      s.sessions.push({
        id: 'desk' + Date.now().toString(36),
        at: Date.now(), min, taskId: s.currentId || null,
        complete: !!complete, kind: 'desk', distractions: 0,
      });
    });
  }

  // ConTodo 側で回っているポモドーロ
  function runningTimer() {
    const t = read(TKEY);
    if (!t || !t.running || !t.endAt) return null;
    const left = t.endAt - Date.now();
    if (left <= 0) return null;
    return { phase: t.phase, left, round: t.round || 0 };
  }

  // ---------- 変更の監視 ----------
  // 別タブ（ConTodo）の保存は storage イベントで届く。
  // 同一タブ内の変化と、イベントが来ない場合に備えて rev も見張る。
  function watch(fn) {
    let rev = (state() || {}).rev || 0;
    window.addEventListener('storage', (e) => {
      if (e.key === KEY || e.key === TKEY) { rev = (state() || {}).rev || 0; fn(); }
    });
    setInterval(() => {
      const r = (state() || {}).rev || 0;
      if (r !== rev) { rev = r; fn(); }
    }, 4000);
  }

  return { available, state, tasks, advance, undone, blocks, focus, logSession, runningTimer, watch };
})();
