// 時計・日付・リング・左下の数字。1秒ごとに時刻、1分ごとに残りの計算をやり直す。

const Clock = (() => {
  const WD = ['日', '月', '火', '水', '木', '金', '土'];
  const C = 2 * Math.PI * 19; // リングの円周

  function ring(elId, ratio) {
    const el = U.el(elId);
    const r = Math.max(0, Math.min(1, ratio || 0));
    el.style.strokeDasharray = C;
    el.style.strokeDashoffset = C * (1 - r);
  }

  function tick() {
    const now = new Date();
    U.el('clock').textContent =
      String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    U.el('clockDate').textContent =
      `${now.getMonth() + 1}月${now.getDate()}日（${WD[now.getDay()]}）`;
  }

  // 1分ごと：進捗リングと「次の予定」まわり
  function refresh() {
    const s = Store.get();
    const now = new Date();
    const cur = now.getHours() * 60 + now.getMinutes();
    const start = U.min(s.settings.dayStart);
    const end = U.min(s.settings.dayEnd);

    const span = Math.max(1, end - start);
    const dayRatio = (cur - start) / span;
    ring('ringDay', dayRatio);
    U.el('dayPct').textContent = Math.round(Math.max(0, Math.min(1, dayRatio)) * 100) + '%';

    const total = s.tasks.length;
    const done = s.tasks.filter((t) => t.done).length;
    ring('ringTask', total ? done / total : 0);
    U.el('taskPct').textContent = total ? Math.round((done / total) * 100) + '%' : '—';
    U.el('statRemain').textContent = total - done;

    // 次に始まるブロック
    const next = Timeline.todaysBlocks().find((b) => U.min(b.start) > cur);
    U.el('statNext').textContent = next ? next.start : '—';
    U.el('barStatus').textContent = nowLabel(cur, next);

    // 就業終了まで
    const left = end - cur;
    U.el('statLeft').textContent = left <= 0 ? '終了' : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  }

  // 上部バーに「いま何の時間か」を出す
  function nowLabel(cur, next) {
    const cu = Timeline.todaysBlocks().find((b) => U.min(b.start) <= cur && U.min(b.end) > cur);
    if (cu) {
      const rest = U.min(cu.end) - cur;
      return `いま：${cu.title}（残り ${rest} 分）`;
    }
    if (next) return `次：${next.start} ${next.title}`;
    return '予定なし';
  }

  return {
    start() {
      tick();
      refresh();
      setInterval(tick, 1000);
      setInterval(refresh, 30 * 1000);
      Store.subscribe(refresh);
    },
    refresh,
  };
})();
