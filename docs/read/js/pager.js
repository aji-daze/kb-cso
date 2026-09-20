// ページ分割。DOM には手を入れず、Range の位置を測って「この文字は何ページ目か」を出す。
// 縦組みは writing-mode: vertical-rl、横組みは段組み（column）。どちらも translateX で送る。

export class Pager {
  constructor(pageEl, flowEl) {
    this.page = pageEl;
    this.flow = flowEl;
    this.nodes = [];
    this.total = 0;
    this.n = 1;      // ページ数
    this.i = 0;      // いま何ページ目
    this.W = 1;
  }

  get dir() { return this.flow.dataset.dir === 'h' ? 'h' : 'v'; }
  set dir(v) { this.flow.dataset.dir = v === 'h' ? 'h' : 'v'; }

  setHTML(html) {
    this.flow.innerHTML = html;
    this._scan();
  }

  _scan() {
    const w = document.createTreeWalker(this.flow, NodeFilter.SHOW_TEXT, {
      acceptNode: (t) => {
        if (!t.nodeValue) return NodeFilter.FILTER_REJECT;
        // ルビの読みは本文の文字数に数えない
        for (let p = t.parentNode; p && p !== this.flow; p = p.parentNode) {
          const tag = p.nodeName;
          if (tag === 'RT' || tag === 'RP') return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    let at = 0, t;
    while ((t = w.nextNode())) {
      const len = t.nodeValue.length;
      if (!len) continue;
      nodes.push({ node: t, start: at, len });
      at += len;
    }
    this.nodes = nodes;
    this.total = at;
  }

  layout() {
    const r = this.page.getBoundingClientRect();
    this.W = Math.max(1, Math.round(r.width));
    const H = Math.max(1, Math.round(r.height));
    const f = this.flow.style;
    f.height = H + 'px';
    if (this.dir === 'v') { f.width = 'auto'; f.columnWidth = ''; }
    else { f.width = this.W + 'px'; f.columnWidth = this.W + 'px'; }
    this.n = Math.max(1, Math.round(this.flow.scrollWidth / this.W));
    if (this.i > this.n - 1) this.i = this.n - 1;
    if (this.i < 0) this.i = 0;
    this.paint();
    return this.n;
  }

  // 落ち着いているときの位置
  baseX() { return this.dir === 'v' ? this.i * this.W : -this.i * this.W; }

  paint() {
    this.flow.style.transform = 'translateX(' + this.baseX() + 'px)';
  }

  // 指に追従させる。アニメーションを切って、そのぶんだけずらす。
  drag(px) {
    this.flow.style.transition = 'none';
    this.flow.style.transform = 'translateX(' + (this.baseX() + px) + 'px)';
  }

  // 追従をやめて、元のアニメーションに戻す
  endDrag() { this.flow.style.transition = ''; }

  go(i) {
    const v = Math.min(this.n - 1, Math.max(0, i));
    const moved = v !== this.i;
    this.i = v;
    this.paint();
    return moved;
  }
  next() { return this.go(this.i + 1); }
  prev() { return this.go(this.i - 1); }
  get atEnd() { return this.i >= this.n - 1; }
  get atStart() { return this.i <= 0; }

  _locate(off) {
    const a = this.nodes;
    if (!a.length) return null;
    let lo = 0, hi = a.length - 1;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (a[m].start <= off) lo = m; else hi = m - 1;
    }
    const e = a[lo];
    return { node: e.node, idx: Math.min(Math.max(0, off - e.start), Math.max(0, e.len - 1)) };
  }

  // 文字位置 → 画面上の位置。transform が掛かっていても差分は変わらないので補正は要らない。
  _rect(off) {
    const p = this._locate(off);
    if (!p) return null;
    const r = document.createRange();
    try {
      r.setStart(p.node, p.idx);
      r.setEnd(p.node, Math.min(p.idx + 1, p.node.nodeValue.length));
    } catch { return null; }
    let box = r.getBoundingClientRect();
    if (!box.width && !box.height) {
      const list = r.getClientRects();
      if (list.length) box = list[0];
      else return null;
    }
    return box;
  }

  pageOf(off) {
    const box = this._rect(off);
    if (!box) return 0;
    const f = this.flow.getBoundingClientRect();
    const d = this.dir === 'v' ? (f.right - box.right) : (box.left - f.left);
    return Math.min(this.n - 1, Math.max(0, Math.floor((d + 1) / this.W)));
  }

  // n ページ目の先頭の文字位置
  offsetAt(n) {
    if (n <= 0) return 0;
    if (n >= this.n) return this.total;
    let lo = 0, hi = this.total;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (this.pageOf(m) >= n) hi = m; else lo = m + 1;
    }
    return lo;
  }

  charsOn(n) {
    const a = this.offsetAt(n), b = n + 1 >= this.n ? this.total : this.offsetAt(n + 1);
    return Math.max(0, b - a);
  }

  text(from, to) {
    let out = '';
    for (const e of this.nodes) {
      if (e.start + e.len <= from) continue;
      if (e.start >= to) break;
      out += e.node.nodeValue.slice(Math.max(0, from - e.start), Math.min(e.len, to - e.start));
    }
    return out;
  }

  // 選択範囲 → 文字位置（抜き書きの保存に使う）
  offsetOfNode(node, idx) {
    for (const e of this.nodes) if (e.node === node) return e.start + idx;
    // テキストノードそのものでない場合は近いところを返す
    for (const e of this.nodes) if (node.contains && node.contains(e.node)) return e.start;
    return 0;
  }
}
