// 画面全体のつなぎ。テーマ、設定、メモ、キーボード操作、書き出し／読み込み。

(() => {
  // ---------- テーマ ----------
  function applyTheme() {
    const t = Store.get().settings.theme;
    const dark = t === 'dark' || (t === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    const meta = document.querySelector('meta[name=theme-color]');
    if (meta) meta.content = dark ? '#0b0b0d' : '#eceef1';
  }

  function toggleTheme() {
    const s = Store.get();
    s.settings.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    Store.save();
  }

  // ---------- メモ（打ち終わりから少し待って保存） ----------
  let noteTimer = null;
  function bindNotes() {
    const ta = U.el('notes');
    ta.value = Store.get().notes || '';
    ta.addEventListener('input', () => {
      clearTimeout(noteTimer);
      U.el('noteSaved').textContent = '…';
      noteTimer = setTimeout(() => {
        Store.get().notes = ta.value;
        Store.save();
        U.el('noteSaved').textContent = '保存済み';
        setTimeout(() => { U.el('noteSaved').textContent = ''; }, 1500);
      }, 600);
    });
  }

  // ---------- 設定 ----------
  function openSettings() {
    const s = Store.get().settings;
    U.el('setStart').value = s.dayStart;
    U.el('setEnd').value = s.dayEnd;
    U.el('setFocus').value = s.focusMin;
    U.el('setBreak').value = s.breakMin;
    U.el('setTheme').value = s.theme;
    Links.render();
    U.el('settingsModal').hidden = false;
  }

  function readSettings() {
    const s = Store.get().settings;
    s.dayStart = U.el('setStart').value || s.dayStart;
    s.dayEnd = U.el('setEnd').value || s.dayEnd;
    s.focusMin = Math.min(120, Math.max(5, parseInt(U.el('setFocus').value, 10) || 25));
    s.breakMin = Math.min(60, Math.max(1, parseInt(U.el('setBreak').value, 10) || 5));
    s.theme = U.el('setTheme').value;
    if (U.min(s.dayEnd) <= U.min(s.dayStart)) s.dayEnd = U.hm(Math.min(U.min(s.dayStart) + 60, 23 * 60 + 59));
    Store.save();
    applyTheme();
  }

  function bindSettings() {
    U.el('btnSettings').addEventListener('click', openSettings);
    U.el('setClose').addEventListener('click', () => { readSettings(); U.el('settingsModal').hidden = true; });
    U.el('settingsModal').addEventListener('click', (e) => {
      if (e.target.id === 'settingsModal') { readSettings(); U.el('settingsModal').hidden = true; }
    });
    ['setStart', 'setEnd', 'setFocus', 'setBreak', 'setTheme'].forEach((id) => {
      U.el(id).addEventListener('change', readSettings);
    });

    U.el('btnExport').addEventListener('click', () => {
      const blob = new Blob([Store.export()], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `desk-${U.dateKey(new Date())}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    });

    U.el('btnImport').addEventListener('click', () => U.el('importFile').click());
    U.el('importFile').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        try {
          const data = JSON.parse(r.result);
          if (!confirm('いまのデータを、読み込んだ内容で置き換える。よいか？')) return;
          Store.replace(data);
          applyTheme();
          renderAll();
        } catch (err) {
          alert('このファイルは読めない。');
        }
      };
      r.readAsText(f);
      e.target.value = '';
    });
  }

  // ---------- ヘルプ ----------
  function bindHelp() {
    U.el('btnHelp').addEventListener('click', () => { U.el('helpModal').hidden = false; });
    U.el('helpClose').addEventListener('click', () => { U.el('helpModal').hidden = true; });
    U.el('helpModal').addEventListener('click', (e) => { if (e.target.id === 'helpModal') U.el('helpModal').hidden = true; });
  }

  // ---------- キーボード ----------
  function bindKeys() {
    document.addEventListener('keydown', (e) => {
      const tag = (e.target.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || tag === 'select';

      if (e.key === 'Escape') {
        ['blockModal', 'settingsModal', 'helpModal'].forEach((id) => { U.el(id).hidden = true; });
        if (typing) e.target.blur();
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

      const k = e.key.toLowerCase();
      if (k === 'n') { e.preventDefault(); U.el('taskInput').focus(); }
      else if (k === 'b') { e.preventDefault(); Timeline.open(null); }
      else if (k === 'f') { e.preventDefault(); Timer.toggle(); }
      else if (k === 't') { e.preventDefault(); Timeline.scrollToNow(); }
      else if (k === 'd') { e.preventDefault(); toggleTheme(); applyTheme(); }
      else if (k === '?' || (e.shiftKey && k === '/')) { U.el('helpModal').hidden = false; }
    });
  }

  function renderAll() {
    Timeline.render();
    Tasks.render();
    Timer.render();
    Links.render();
    Clock.refresh();
    U.el('notes').value = Store.get().notes || '';
  }

  // ---------- 起動 ----------
  function init() {
    applyTheme();
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

    U.el('btnTheme').addEventListener('click', () => { toggleTheme(); applyTheme(); });

    Timeline.bind();
    Tasks.bind();
    Timer.bind();
    Links.bind();
    bindNotes();
    bindSettings();
    bindHelp();
    bindKeys();

    renderAll();
    Clock.start();
    setTimeout(Timeline.scrollToNow, 60);

    // 日付が変わったら表示を作り直す
    let day = U.dateKey(new Date());
    setInterval(() => {
      const now = U.dateKey(new Date());
      if (now !== day) { day = now; renderAll(); }
    }, 60 * 1000);

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
