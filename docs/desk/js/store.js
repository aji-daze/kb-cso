// 保存まわり。データは全部この端末の localStorage に入れる。
// サーバーを持たないので、機種をまたぐ移動は設定の書き出し／読み込みで行う。

const U = {
  // 0:00 からの経過分 → "09:30"
  hm(min) {
    const h = Math.floor(min / 60) % 24;
    const m = Math.round(min) % 60;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  },
  // "09:30" → 570
  min(hm) {
    const p = String(hm || '').split(':');
    return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
  },
  dateKey(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  },
  id() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  },
  el(id) { return document.getElementById(id); },
};

const Store = (() => {
  const KEY = 'desk.v1';

  const DEFAULTS = {
    v: 1,
    settings: { theme: 'dark', dayStart: '09:00', dayEnd: '18:00', focusMin: 25, breakMin: 5 },
    tasks: [],
    blocks: [
      { id: 'b1', title: '朝の確認', start: '09:00', end: '09:30', kind: 'work', repeat: 'weekdays', date: null },
      { id: 'b2', title: '集中ブロック', start: '10:00', end: '12:00', kind: 'focus', repeat: 'weekdays', date: null },
      { id: 'b3', title: '昼休み', start: '12:00', end: '13:00', kind: 'rest', repeat: 'weekdays', date: null },
    ],
    notes: '',
    links: [
      { id: 'l1', label: 'メール', url: 'https://mail.google.com/' },
      { id: 'l2', label: 'カレンダー', url: 'https://calendar.google.com/' },
      { id: 'l3', label: 'ドライブ', url: 'https://drive.google.com/' },
    ],
    focusLog: {},   // { "2026-09-19": { count: 3, min: 75 } }
    timer: null,    // 動作中のタイマー { mode, endsAt }
  };

  let state = read();
  const subs = [];

  function read() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return clone(DEFAULTS);
      const saved = JSON.parse(raw);
      // 壊れた項目があっても既定値で埋めて起動できるようにする。
      const s = clone(DEFAULTS);
      Object.keys(s).forEach((k) => {
        if (saved[k] === undefined || saved[k] === null) return;
        if (k === 'settings') Object.assign(s.settings, saved.settings);
        else s[k] = saved[k];
      });
      return s;
    } catch (e) {
      return clone(DEFAULTS);
    }
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      // 容量不足やプライベートモードでも画面は動かし続ける。
      console.warn('保存できなかった', e);
    }
    subs.forEach((fn) => fn(state));
  }

  return {
    get() { return state; },
    save,
    subscribe(fn) { subs.push(fn); },
    replace(next) { state = Object.assign(clone(DEFAULTS), next); save(); },
    export() { return JSON.stringify(state, null, 2); },
    defaults() { return clone(DEFAULTS); },
  };
})();
