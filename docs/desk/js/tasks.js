// 今日のタスク。未完了を上、完了を下に出す。消すまで残るので持ち越しになる。

const Tasks = (() => {
  function render() {
    const list = U.el('taskList');
    const items = Store.get().tasks.slice().sort((a, b) => (a.done === b.done ? a.at - b.at : a.done ? 1 : -1));
    if (!items.length) {
      list.innerHTML = '<li class="t-empty">タスクなし。</li>';
      return;
    }
    list.innerHTML = items.map((t) => `
      <li class="${t.done ? 'done' : ''}" data-id="${t.id}">
        <button class="tick" aria-label="完了">✓</button>
        <span class="t-text">${esc(t.text)}</span>
        <button class="t-del" aria-label="削除">×</button>
      </li>`).join('');
  }

  function esc(t) {
    return String(t || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function add(text) {
    const v = text.trim();
    if (!v) return;
    Store.get().tasks.push({ id: U.id(), text: v, done: false, at: Date.now() });
    Store.save();
  }

  function toggle(id) {
    const t = Store.get().tasks.find((x) => x.id === id);
    if (!t) return;
    t.done = !t.done;
    Store.save();
  }

  function remove(id) {
    const s = Store.get();
    s.tasks = s.tasks.filter((t) => t.id !== id);
    Store.save();
  }

  // 文字をその場で直す
  function edit(li, id) {
    const t = Store.get().tasks.find((x) => x.id === id);
    if (!t || li.querySelector('.t-edit')) return;
    const span = li.querySelector('.t-text');
    const input = document.createElement('input');
    input.className = 't-edit';
    input.value = t.text;
    span.replaceWith(input);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);

    const commit = () => {
      const v = input.value.trim();
      if (v) { t.text = v; Store.save(); } else render();
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') render();
    });
  }

  function bind() {
    U.el('taskForm').addEventListener('submit', (e) => {
      e.preventDefault();
      add(U.el('taskInput').value);
      U.el('taskInput').value = '';
    });

    U.el('taskList').addEventListener('click', (e) => {
      const li = e.target.closest('li[data-id]');
      if (!li) return;
      const id = li.dataset.id;
      if (e.target.closest('.tick')) return toggle(id);
      if (e.target.closest('.t-del')) return remove(id);
      if (e.target.closest('.t-text')) return edit(li, id);
    });

    U.el('btnClearDone').addEventListener('click', () => {
      const s = Store.get();
      s.tasks = s.tasks.filter((t) => !t.done);
      Store.save();
    });

    Store.subscribe(render);
  }

  return { render, bind };
})();
