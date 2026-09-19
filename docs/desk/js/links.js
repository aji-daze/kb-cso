// 下のドック。よく開くページを並べておくランチャー。

const Links = (() => {
  function mark(label) { return (label || '?').trim().charAt(0).toUpperCase(); }

  function esc(t) {
    return String(t || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function safe(url) {
    // javascript: のような scheme を弾く
    try {
      const u = new URL(url, location.href);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
    } catch (e) { return null; }
  }

  function render() {
    const links = Store.get().links;
    const dock = U.el('dock');
    dock.innerHTML = links.length
      ? links.map((l) => {
          const href = safe(l.url);
          if (!href) return '';
          return `<a href="${esc(href)}" target="_blank" rel="noopener"><span class="mark">${esc(mark(l.label))}</span>${esc(l.label)}</a>`;
        }).join('')
      : '<span class="dock-empty">設定（≡）からショートカットを追加できる。</span>';
    renderEditor();
  }

  function renderEditor() {
    const ul = U.el('linkEdit');
    if (!ul) return;
    const links = Store.get().links;
    ul.innerHTML = links.map((l) => `
      <li data-id="${l.id}">
        <b>${esc(l.label)}</b><span class="u">${esc(l.url)}</span>
        <button class="btn sm danger" data-del="${l.id}">削除</button>
      </li>`).join('') || '<li class="muted">未登録</li>';
  }

  function bind() {
    U.el('linkForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const label = U.el('linkLabel').value.trim();
      const url = U.el('linkUrl').value.trim();
      if (!label || !safe(url)) return;
      Store.get().links.push({ id: U.id(), label, url });
      Store.save();
      U.el('linkLabel').value = '';
      U.el('linkUrl').value = '';
    });

    U.el('linkEdit').addEventListener('click', (e) => {
      const id = e.target.dataset.del;
      if (!id) return;
      const s = Store.get();
      s.links = s.links.filter((l) => l.id !== id);
      Store.save();
    });

    Store.subscribe(render);
  }

  return { render, bind };
})();
