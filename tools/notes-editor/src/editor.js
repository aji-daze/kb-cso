// ノートの編集欄。CodeMirror 6 をもとに、Markdown を「書いたまま見出しは大きく、マーカーは色付き」で見せる。
// ファイルの中身はふつうの Markdown のまま（Obsidian 側でそのまま読める）。
//
// ビルド：tools/notes-editor で npm install && npm run build → docs/notes/vendor/editor.js
import { EditorState, EditorSelection, RangeSetBuilder } from '@codemirror/state';
import { EditorView, keymap, placeholder, drawSelection, Decoration, ViewPlugin } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo } from '@codemirror/commands';
// markdown() は HTML・CSS・JS の文法まで抱えて重いので、Markdown の文法と改行時の続き記号だけ取る
import { markdownLanguage, insertNewlineContinueMarkup, deleteMarkupBackward } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

const style = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.55em', fontWeight: '700', lineHeight: '1.4' },
  { tag: t.heading2, fontSize: '1.3em', fontWeight: '700', lineHeight: '1.4' },
  { tag: t.heading3, fontSize: '1.13em', fontWeight: '700' },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: '700' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.link, t.url], color: 'var(--link)' },
  { tag: t.monospace, fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: '.9em', backgroundColor: 'var(--code)' },
  { tag: t.quote, color: 'var(--sub)' },
  { tag: [t.processingInstruction, t.contentSeparator, t.meta], color: 'var(--missing)', fontWeight: '400' },
]);

// ==マーカー== / <mark style="background: …">（Highlightr と同じ形）/ [[リンク]]
// マーカーの記号やタグは、カーソルがそこに無いあいだは隠して色だけ見せる（WordPress のように）。
// カーソルを入れると元の書き方が出てくるので、そのまま直せる。
const MARK = /==(?!\s)((?:(?!==)[^\n])+?)==|<mark\s+style="background:\s*([^;"]+);?\s*">((?:(?!<\/mark>)[^\n])*)<\/mark>|\[\[[^[\]\n]+\]\]/g;
const hide = Decoration.replace({});
const dim = Decoration.mark({ class: 'cm-dim' });

function buildMarks(view) {
  const b = new RangeSetBuilder();
  const sel = view.state.selection.ranges;
  const near = (from, to) => sel.some((r) => r.from <= to && r.to >= from);
  for (const { from: vf, to: vt } of view.visibleRanges) {
    const text = view.state.doc.sliceString(vf, vt);
    MARK.lastIndex = 0;
    for (let m; (m = MARK.exec(text));) {
      const from = vf + m.index, to = from + m[0].length;
      if (m[0].startsWith('[[')) { b.add(from, to, Decoration.mark({ class: 'cm-wl' })); continue; }
      const open = m[2] ? m[0].indexOf('>') + 1 : 2;
      const close = m[2] ? 7 : 2;
      const body = Decoration.mark({ class: 'cm-hl', attributes: m[2] ? { style: 'background:' + m[2] } : {} });
      const shown = near(from, to);
      b.add(from, from + open, shown ? dim : hide);
      if (to - close > from + open) b.add(from + open, to - close, body);
      b.add(to - close, to, shown ? dim : hide);
    }
  }
  return b.finish();
}
const marks = ViewPlugin.fromClass(class {
  constructor(v) { this.decorations = buildMarks(v); }
  update(u) { if (u.docChanged || u.viewportChanged || u.selectionSet) this.decorations = buildMarks(u.view); }
}, { decorations: (v) => v.decorations });

const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'transparent', color: 'var(--tx)', fontSize: 'var(--fs)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font)', lineHeight: 'var(--lh)', overflow: 'visible' },
  '.cm-content': { maxWidth: 'var(--measure)', margin: '0 auto', padding: '8px 0 40vh', caretColor: 'var(--acc)' },
  '.cm-line': { padding: '0 2px' },
  '.cm-cursor': { borderLeftColor: 'var(--acc)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--sel) !important' },
  '.cm-hl': { backgroundColor: 'var(--mark)', borderRadius: '2px' },
  '.cm-wl': { color: 'var(--link)' },
  '.cm-dim': { color: 'var(--missing)', fontSize: '.85em' },
  '.cm-placeholder': { color: 'var(--missing)' },
});

export function createEditor(parent, { onChange, onSave } = {}) {
  let silent = false;
  const extensions = [
    history(),
    drawSelection(),
    EditorView.lineWrapping,
    markdownLanguage,
    syntaxHighlighting(style),
    marks,
    theme,
    placeholder('ここに書く'),
    // カーソルが上の帯・下の道具帯（スマホ）に隠れないよう、その分を空けてスクロールする
    EditorView.scrollMargins.of(() => ({ top: 70, bottom: 80 })),
    EditorView.contentAttributes.of({ spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' }),
    keymap.of([
      { key: 'Mod-b', run: () => (api.wrap('**', '**'), true) },
      { key: 'Mod-i', run: () => (api.wrap('*', '*'), true) },
      { key: 'Mod-Shift-m', run: () => (api.marker(null), true) },
      { key: 'Mod-s', run: () => (onSave && onSave(), true) },
      { key: 'Enter', run: insertNewlineContinueMarkup },
      { key: 'Backspace', run: deleteMarkupBackward },
      ...defaultKeymap, ...historyKeymap, indentWithTab,
    ]),
    EditorView.updateListener.of((u) => { if (u.docChanged && !silent && onChange) onChange(u.state.doc.toString()); }),
  ];
  const view = new EditorView({ parent, state: EditorState.create({ doc: '', extensions }) });

  const lines = (state) => {
    const out = [];
    for (const r of state.selection.ranges) {
      for (let pos = r.from; ;) {
        const l = state.doc.lineAt(pos);
        if (!out.some((x) => x.number === l.number)) out.push(l);
        if (l.to >= r.to) break;
        pos = l.to + 1;
      }
    }
    return out;
  };

  // 行頭の記号をまとめて付け替える。全部の行がもう同じ形なら外す（押し直しで戻る）
  function relines(test, strip, add) {
    const st = view.state;
    const ls = lines(st);
    const all = ls.every((l) => test(l.text));
    const changes = ls.map((l) => {
      const body = strip(l.text);
      return { from: l.from, to: l.to, insert: all ? body : add(body) };
    });
    view.dispatch({ changes, scrollIntoView: true });
    view.focus();
  }

  const LIST = /^(\s*)(?:[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+|>\s?)/;
  const HEAD = /^#{1,6}\s+/;

  const api = {
    view,
    getText: () => view.state.doc.toString(),
    setText(text) {
      silent = true;
      view.setState(EditorState.create({ doc: text, extensions })); // 履歴もノートごとに作り直す
      silent = false;
    },
    // 外からの差し替え（OneDrive の新しい版）。カーソル位置はできるだけ残す
    replaceText(text) {
      const cur = view.state.doc.toString();
      if (cur === text) return;
      silent = true;
      const head = Math.min(view.state.selection.main.head, text.length);
      view.dispatch({ changes: { from: 0, to: cur.length, insert: text }, selection: { anchor: head } });
      silent = false;
    },
    focus: () => view.focus(),
    undo: () => { undo(view); view.focus(); },
    redo: () => { redo(view); view.focus(); },

    // 0 = 本文、1〜3 = 見出しの大きさ
    heading(level) {
      const mark = '#'.repeat(level) + ' ';
      relines(
        (s) => (level ? s.startsWith(mark) && !s.startsWith(mark.trim() + '#') : !HEAD.test(s)),
        (s) => s.replace(HEAD, ''),
        (s) => (level ? mark + s : s),
      );
    },

    // 'ul' 箇条書き / 'ol' 番号 / 'task' チェック / 'quote' 引用
    list(kind) {
      const pre = { ul: '- ', ol: '1. ', task: '- [ ] ', quote: '> ' }[kind];
      const is = {
        ul: /^\s*[-*+]\s+(?!\[[ xX]\])/, ol: /^\s*\d+[.)]\s+/, task: /^\s*[-*+]\s+\[[ xX]\]\s+/, quote: /^\s*>\s?/,
      }[kind];
      relines((s) => is.test(s), (s) => s.replace(LIST, '$1'), (s) => {
        const ind = /^\s*/.exec(s)[0];
        return ind + pre + s.slice(ind.length);
      });
    },

    // 選んだ所を before/after で挟む。もう挟まれていれば外す
    wrap(before, after) {
      const st = view.state;
      const tr = st.changeByRange((r) => {
        const inner = st.sliceDoc(r.from, r.to);
        const outerFrom = r.from - before.length, outerTo = r.to + after.length;
        if (outerFrom >= 0 && st.sliceDoc(outerFrom, r.from) === before && st.sliceDoc(r.to, outerTo) === after) {
          return {
            changes: [{ from: outerFrom, to: r.from }, { from: r.to, to: outerTo }],
            range: EditorSelection.range(outerFrom, r.to - before.length),
          };
        }
        if (inner.startsWith(before) && inner.endsWith(after) && inner.length >= before.length + after.length) {
          const body = inner.slice(before.length, inner.length - after.length);
          return { changes: { from: r.from, to: r.to, insert: body }, range: EditorSelection.range(r.from, r.from + body.length) };
        }
        return {
          changes: { from: r.from, to: r.to, insert: before + inner + after },
          range: r.empty ? EditorSelection.cursor(r.from + before.length) : EditorSelection.range(r.from + before.length, r.to + before.length),
        };
      });
      view.dispatch(tr, { scrollIntoView: true });
      view.focus();
    },

    // マーカー。color が null なら黄（==…==、Obsidian の標準）、色文字列なら <mark style>、'off' なら外す。
    // カーソルが既存のマーカーの中にあれば、そのマーカーの色を変える（'off' なら外す）
    marker(color) {
      const st = view.state;
      const r = st.selection.main;
      const line = st.doc.lineAt(r.from);
      const wrapText = (s) => (color ? '<mark style="background: ' + color + ';">' + s + '</mark>' : '==' + s + '==');
      MARK.lastIndex = 0;
      for (let m; (m = MARK.exec(line.text));) {
        if (m[0].startsWith('[[')) continue;
        const from = line.from + m.index, to = from + m[0].length;
        if (r.from >= from && r.to <= to) {
          const body = m[1] !== undefined ? m[1] : m[3];
          const next = color === 'off' ? body : wrapText(body);
          view.dispatch({ changes: { from, to, insert: next }, selection: { anchor: from, head: from + next.length } });
          view.focus();
          return;
        }
      }
      if (color === 'off') { view.focus(); return; }
      if (color) api.wrap('<mark style="background: ' + color + ';">', '</mark>');
      else api.wrap('==', '==');
    },

    insert(text, cursorBack = 0) {
      const r = view.state.selection.main;
      view.dispatch({ changes: { from: r.from, to: r.to, insert: text }, selection: { anchor: r.from + text.length - cursorBack }, scrollIntoView: true });
      view.focus();
    },

    // 何行目にカーソルがあるか（閲覧 ⇄ 編集で位置を合わせるのに使う）
    topLine() {
      const b = view.lineBlockAtHeight(view.scrollDOM.getBoundingClientRect().top - view.documentTop + 1);
      return view.state.doc.lineAt(b.from).number;
    },
  };
  return api;
}
