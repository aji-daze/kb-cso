// 今日ぶんのタイムライン。1日を時間の箱として並べ、いまどこにいるかを線で示す。

const Timeline = (() => {
  let editing = null; // 編集中のブロック id（新規は null）

  function hourPx() {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--hour');
    return parseFloat(v) || 58;
  }

  // 繰り返し条件を見て、今日出すブロックだけ取り出す
  function todaysBlocks(d) {
    const day = d || new Date();
    const key = U.dateKey(day);
    const dow = day.getDay();
    const fromContodo = Bridge.available() ? Bridge.blocks(key) : [];
    return Store.get().blocks
      .filter((b) => {
        if (b.repeat === 'daily') return true;
        if (b.repeat === 'weekdays') return dow >= 1 && dow <= 5;
        if (b.repeat === 'weekly') return b.dow === dow;
        return b.date === key;
      })
      .concat(fromContodo)
      .sort((a, b) => U.min(a.start) - U.min(b.start));
  }

  // 重なったブロックを横に割るための列決め
  function lanes(blocks) {
    const out = [];
    let group = [];
    let groupEnd = -1;

    const flush = () => {
      if (!group.length) return;
      const ends = [];
      group.forEach((b) => {
        let lane = ends.findIndex((e) => e <= U.min(b.start));
        if (lane === -1) { lane = ends.length; ends.push(0); }
        ends[lane] = U.min(b.end);
        b._lane = lane;
      });
      group.forEach((b) => { b._lanes = ends.length; });
      out.push.apply(out, group);
      group = [];
      groupEnd = -1;
    };

    blocks.forEach((b) => {
      if (group.length && U.min(b.start) >= groupEnd) flush();
      group.push(b);
      groupEnd = Math.max(groupEnd, U.min(b.end));
    });
    flush();
    return out;
  }

  function render() {
    const s = Store.get();
    const wrap = U.el('timeline');
    const blocks = lanes(todaysBlocks());
    const now = new Date();
    const cur = now.getHours() * 60 + now.getMinutes();

    // 表示する時間帯：就業時間に、はみ出したブロックを足す
    let from = Math.floor(U.min(s.settings.dayStart) / 60);
    let to = Math.ceil(U.min(s.settings.dayEnd) / 60);
    blocks.forEach((b) => {
      from = Math.min(from, Math.floor(U.min(b.start) / 60));
      to = Math.max(to, Math.ceil(U.min(b.end) / 60));
    });
    if (to <= from) to = from + 1;

    const px = hourPx();
    const workFrom = U.min(s.settings.dayStart);
    const workTo = U.min(s.settings.dayEnd);

    let html = '';
    for (let h = from; h < to; h++) {
      const off = h * 60 + 59 < workFrom || h * 60 >= workTo ? ' off' : '';
      html += `<div class="hour${off}" data-hour="${h}"><span class="h-label">${String(h).padStart(2, '0')}:00</span></div>`;
    }

    blocks.forEach((b) => {
      const st = U.min(b.start);
      const en = Math.max(U.min(b.end), st + 15); // 短すぎても字が読める高さは残す
      const top = ((st - from * 60) / 60) * px;
      const hgt = ((en - st) / 60) * px - 2;
      const live = st <= cur && en > cur ? ' now' : (en <= cur ? ' past' : '');
      const lane = b._lane || 0;
      const n = b._lanes || 1;
      html += `<div class="block k-${b.kind || 'work'}${live}" data-id="${b.id}"
        style="top:${top}px;height:${hgt}px;left:calc(48px + (100% - 52px) * ${lane} / ${n});width:calc((100% - 52px) / ${n} - 2px)">
        <b>${esc(b.title)}</b><span>${b.start}–${b.end}${b.src === 'contodo' ? ' · ConTodo' : ''}</span></div>`;
    });

    if (cur >= from * 60 && cur <= to * 60) {
      html += `<div class="nowline" style="top:${((cur - from * 60) / 60) * px}px"></div>`;
    }
    if (!blocks.length) {
      html += '<div class="tl-empty">予定なし。右上の「＋ ブロック」か、時間の行を押して追加する。</div>';
    }

    wrap.innerHTML = html;
    wrap.dataset.from = from;
  }

  function esc(t) {
    return String(t || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function scrollToNow() {
    const wrap = U.el('timelineWrap');
    const from = parseInt(U.el('timeline').dataset.from || '0', 10);
    const now = new Date();
    const cur = now.getHours() * 60 + now.getMinutes();
    const y = ((cur - from * 60) / 60) * hourPx() - wrap.clientHeight / 3;
    wrap.scrollTop = Math.max(0, y);
  }

  // ---------- 追加・編集 ----------
  function open(id, hour) {
    // ConTodo から来たブロックは向こうが持ち主。こちらでは編集しない。
    if (id && String(id).indexOf('ct-') === 0) return;
    editing = id || null;
    const b = id ? Store.get().blocks.find((x) => x.id === id) : null;
    const base = b || defaultBlock(hour);
    U.el('blockModalTitle').textContent = b ? 'ブロックを編集' : 'ブロックを追加';
    U.el('blkTitle').value = base.title || '';
    U.el('blkStart').value = base.start;
    U.el('blkEnd').value = base.end;
    U.el('blkRepeat').value = base.repeat || 'none';
    U.el('blkKind').value = base.kind || 'work';
    U.el('blkDelete').hidden = !b;
    U.el('blockModal').hidden = false;
    U.el('blkTitle').focus();
  }

  function defaultBlock(hour) {
    const now = new Date();
    let st;
    if (typeof hour === 'number') st = hour * 60;
    else st = Math.ceil((now.getHours() * 60 + now.getMinutes()) / 30) * 30;
    return { title: '', start: U.hm(st), end: U.hm(Math.min(st + 60, 23 * 60 + 59)), repeat: 'none', kind: 'work' };
  }

  function close() { U.el('blockModal').hidden = true; editing = null; }

  function save() {
    const s = Store.get();
    const today = new Date();
    const start = U.el('blkStart').value || '09:00';
    let end = U.el('blkEnd').value || '10:00';
    if (U.min(end) <= U.min(start)) end = U.hm(Math.min(U.min(start) + 30, 23 * 60 + 59));

    const data = {
      title: U.el('blkTitle').value.trim() || '（無題）',
      start, end,
      repeat: U.el('blkRepeat').value,
      kind: U.el('blkKind').value,
      date: U.dateKey(today),
      dow: today.getDay(),
    };

    const cur = editing && s.blocks.find((b) => b.id === editing);
    if (cur) Object.assign(cur, data);
    else s.blocks.push(Object.assign({ id: U.id() }, data));

    Store.save();
    close();
  }

  function remove() {
    const s = Store.get();
    s.blocks = s.blocks.filter((b) => b.id !== editing);
    Store.save();
    close();
  }

  function bind() {
    U.el('btnAddBlock').addEventListener('click', () => open(null));
    U.el('btnNow').addEventListener('click', scrollToNow);
    U.el('blkSave').addEventListener('click', save);
    U.el('blkCancel').addEventListener('click', close);
    U.el('blkDelete').addEventListener('click', remove);
    U.el('blockModal').addEventListener('click', (e) => { if (e.target.id === 'blockModal') close(); });

    U.el('timeline').addEventListener('click', (e) => {
      const blk = e.target.closest('.block');
      if (blk) return open(blk.dataset.id);
      const hour = e.target.closest('.hour');
      if (hour) open(null, parseInt(hour.dataset.hour, 10));
    });

    Store.subscribe(render);
    setInterval(render, 60 * 1000); // 現在線を進める
  }

  return { render, bind, scrollToNow, todaysBlocks, open, close };
})();
