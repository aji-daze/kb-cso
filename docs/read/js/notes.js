// 抜き書き。引用と、そのとき書いた自分の反応を対で持つ。
import * as DB from './db.js';

export async function add({ bookId, bookTitle, chapter, ch, off, quote, note, tags }) {
  const row = {
    id: DB.uid('n'), bookId, bookTitle: bookTitle || '', chapter: chapter || '',
    ch: ch || 0, off: off || 0,
    quote: (quote || '').trim(), note: (note || '').trim(),
    tags: tags || [], at: Date.now(),
  };
  await DB.put('notes', row);
  return row;
}

export const update = (row) => DB.put('notes', row);
export const remove = (id) => DB.del('notes', id);
export const ofBook = (bookId) => DB.byIndex('notes', 'bookId', bookId);

export async function list() {
  const rows = await DB.all('notes');
  return rows.sort((a, b) => b.at - a.at);
}

export async function allTags() {
  const rows = await DB.all('notes');
  const m = new Map();
  for (const r of rows) for (const t of (r.tags || [])) m.set(t, (m.get(t) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

// 「1年前の今日」。無ければ「去年の近い日」→「いちばん古いもの」の順で降りる。
export async function recall() {
  const rows = await DB.all('notes');
  if (!rows.length) return null;
  const now = new Date();
  const pick = (yearsAgo, slack) => {
    const t = new Date(now); t.setFullYear(now.getFullYear() - yearsAgo);
    const lo = t.getTime() - slack, hi = t.getTime() + slack;
    const hit = rows.filter((r) => r.at >= lo && r.at <= hi);
    return hit.length ? hit[Math.floor(seed() * hit.length)] : null;
  };
  // 日替わりで同じものが出るように、日付から乱数の種を作る
  function seed() {
    const d = new Date(); const k = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
    let x = k * 2654435761 % 2147483647;
    x = (x * 16807) % 2147483647;
    return (x % 10000) / 10000;
  }
  for (const y of [1, 2, 3]) {
    const r = pick(y, 3 * 86400000);
    if (r) return { row: r, label: y + '年前の今日' };
  }
  const old = rows.filter((r) => Date.now() - r.at > 30 * 86400000);
  if (old.length) return { row: old[Math.floor(seed() * old.length)], label: 'しばらく前の抜き書き' };
  return null;
}

const pad = (n) => String(n).padStart(2, '0');
const ymd = (t) => { const d = new Date(t); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };

// ThinkOS 側にそのまま置ける形で書き出す。取り込みも同じ形式で読める。
export function toMarkdown(rows, title) {
  const out = ['# ' + (title || '抜き書き'), '', '書き出し: ' + ymd(Date.now()), ''];
  const byBook = new Map();
  for (const r of rows) {
    const k = r.bookTitle || '(書名なし)';
    if (!byBook.has(k)) byBook.set(k, []);
    byBook.get(k).push(r);
  }
  for (const [book, list] of byBook) {
    out.push('## ' + book, '');
    for (const r of list.sort((a, b) => a.ch - b.ch || a.off - b.off)) {
      out.push('> ' + r.quote.replace(/\n+/g, ' '));
      out.push('');
      const meta = [r.chapter, ymd(r.at)].filter(Boolean).join(' · ');
      if (meta) out.push('— ' + meta);
      if (r.note) out.push('', r.note);
      if (r.tags && r.tags.length) out.push('', r.tags.map((t) => '#' + t).join(' '));
      out.push('', '---', '');
    }
  }
  return out.join('\n');
}
