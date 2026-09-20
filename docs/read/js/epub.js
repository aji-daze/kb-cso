// EPUB の取り込み。zip + XHTML なので zip.js で展開して中身を読むだけ。
// 画像はこの版では落とす（本文だけ取り出す）。表紙だけは書影として拾う。
import { readZip } from './zip.js';

const dirOf = (p) => p.replace(/[^/]*$/, '');
function resolve(base, rel) {
  if (/^[a-z]+:/i.test(rel)) return rel;
  const parts = (dirOf(base) + rel).split('/');
  const out = [];
  for (const s of parts) {
    if (s === '.' || s === '') { if (out.length === 0 && s === '') continue; continue; }
    if (s === '..') out.pop(); else out.push(s);
  }
  return out.join('/');
}

const P = new DOMParser();

// 本文だけ残す。スクリプト・スタイル・画像・リンク先は落とす。ルビは残す。
const KEEP = new Set(['P','DIV','SPAN','BR','H1','H2','H3','H4','H5','H6','EM','I','STRONG','B','RUBY','RT','RP','RB',
  'BLOCKQUOTE','UL','OL','LI','HR','SECTION','ARTICLE','SUP','SUB','S','SMALL','CODE','PRE','TABLE','TR','TD','TH','TBODY','THEAD','A','FIGURE','FIGCAPTION']);

function clean(node, out) {
  for (const c of [...node.childNodes]) {
    if (c.nodeType === 3) { out.push(c.nodeValue.replace(/[&<>]/g, (x) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[x]))); continue; }
    if (c.nodeType !== 1) continue;
    const tag = c.tagName.toUpperCase();
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'IMG' || tag === 'SVG' || tag === 'IMAGE') continue;
    if (!KEEP.has(tag)) { clean(c, out); continue; }
    const t = tag.toLowerCase();
    const cls = (c.getAttribute('class') || '');
    const vert = /vertical|tcy/.test(cls) ? ' class="' + cls + '"' : '';
    if (t === 'a') { const inner = []; clean(c, inner); out.push(inner.join('')); continue; }
    if (t === 'br' || t === 'hr') { out.push('<' + t + '>'); continue; }
    const inner = [];
    clean(c, inner);
    const body = inner.join('');
    if (!body.trim() && t !== 'td' && t !== 'th') continue;
    out.push('<' + t + vert + '>' + body + '</' + t + '>');
  }
  return out;
}

function bodyHtml(xml) {
  const doc = P.parseFromString(xml, 'application/xhtml+xml');
  let body = doc.querySelector('body');
  if (!body) {
    const d2 = P.parseFromString(xml, 'text/html');
    body = d2.body;
  }
  if (!body) return '';
  return clean(body, []).join('');
}

function titleOf(xml) {
  const doc = P.parseFromString(xml, 'text/html');
  const h = doc.querySelector('h1,h2,h3,title');
  return h ? h.textContent.trim().slice(0, 60) : '';
}

export async function readEpub(blob) {
  const zip = await readZip(blob);

  const container = await zip.text('META-INF/container.xml');
  const cdoc = P.parseFromString(container, 'application/xml');
  const rootfile = cdoc.querySelector('rootfile');
  const opfPath = rootfile && rootfile.getAttribute('full-path');
  if (!opfPath) throw new Error('EPUB の構成ファイルが見つかりません');

  const opf = P.parseFromString(await zip.text(opfPath), 'application/xml');
  const title = (opf.querySelector('metadata > *|title, title') || {}).textContent || '';
  const creator = (opf.querySelector('metadata > *|creator, creator') || {}).textContent || '';
  const lang = (opf.querySelector('metadata > *|language, language') || {}).textContent || '';
  const pageDir = (opf.querySelector('spine') || {}).getAttribute
    ? (opf.querySelector('spine').getAttribute('page-progression-direction') || '')
    : '';

  const items = {};
  let coverId = '';
  for (const m of opf.querySelectorAll('manifest > item')) {
    const id = m.getAttribute('id');
    items[id] = {
      href: resolve(opfPath, m.getAttribute('href') || ''),
      type: m.getAttribute('media-type') || '',
      props: m.getAttribute('properties') || '',
    };
    if ((m.getAttribute('properties') || '').includes('cover-image')) coverId = id;
  }
  if (!coverId) {
    const meta = opf.querySelector('metadata > meta[name="cover"]');
    if (meta) coverId = meta.getAttribute('content') || '';
  }

  const spine = [...opf.querySelectorAll('spine > itemref')]
    .map((r) => items[r.getAttribute('idref')])
    .filter((it) => it && /xhtml|html/.test(it.type));

  const chapters = [];
  for (const it of spine) {
    let xml;
    try { xml = await zip.text(it.href); } catch { continue; }
    const html = bodyHtml(xml);
    if (!html.replace(/<[^>]+>/g, '').trim()) continue;
    chapters.push({ title: titleOf(xml) || ('第' + (chapters.length + 1) + '節'), html });
  }
  if (!chapters.length) throw new Error('本文が取り出せませんでした');

  let cover = null;
  if (coverId && items[coverId]) {
    try { cover = new Blob([await zip.bytes(items[coverId].href)], { type: items[coverId].type }); } catch { /* 表紙が無くても読める */ }
  }

  return {
    title: title.trim(),
    author: creator.trim(),
    lang: lang.trim(),
    vertical: pageDir === 'rtl' || /^ja/i.test(lang),
    chapters,
    cover,
  };
}
