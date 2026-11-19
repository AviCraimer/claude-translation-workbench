// One CodeMirror 6 editor per segment.
// - ⟦n⟧ placeholders render as locked chips (atomic: cursor skips them, deleted whole)
// - _italic_ and **bold** are styled live; markers stay visible but dimmed
// - comment threads are highlighted ranges that move with edits
// - Ctrl/Cmd+click and Ctrl/Cmd+D ask for a lexicon lookup at that position

import { EditorState, StateEffect, StateField, RangeSetBuilder, type Range, type ChangeSet } from "@codemirror/state";
import { EditorView, Decoration, type DecorationSet, ViewPlugin, type ViewUpdate, WidgetType, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import type { Token } from "../core/formats";
import { TOKEN_RE } from "../core/markup";

class TokenWidget extends WidgetType {
  constructor(readonly tok: Token | undefined, readonly raw: string) { super(); }
  eq(o: TokenWidget) { return o.raw === this.raw && o.tok === this.tok; }
  toDOM() {
    const s = document.createElement("span");
    s.className = "tok tok-" + (this.tok?.kind ?? "missing");
    s.textContent = this.tok ? this.tok.label : this.raw;
    if (this.tok?.kind === "he") { s.dir = "rtl"; s.lang = "he"; }
    s.title = this.tok ? "Locked markup — delete or move it as a whole" : "Unknown token";
    return s;
  }
  ignoreEvent() { return false; }
}

function buildDecorations(doc: string, tokens: Map<number, Token>): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  // tokens
  for (const m of doc.matchAll(TOKEN_RE)) {
    const from = m.index!, to = from + m[0].length;
    ranges.push(Decoration.replace({ widget: new TokenWidget(tokens.get(+m[1]), m[0]) }).range(from, to));
  }
  // markers: toggle parse, same rules as checkEditable
  const stack: { mk: string; pos: number }[] = [];
  let i = 0;
  while (i < doc.length) {
    if (doc[i] === "⟦") { const m = /^⟦\d+⟧/.exec(doc.slice(i)); if (m) { i += m[0].length; continue; } }
    const mk = doc.startsWith("**", i) ? "**" : doc[i] === "_" ? "_" : null;
    if (!mk) { i++; continue; }
    const top = stack[stack.length - 1];
    if (top && top.mk === mk) {
      stack.pop();
      const cls = mk === "**" ? "cm-strong" : "cm-em";
      ranges.push(Decoration.mark({ class: "cm-marker" }).range(top.pos, top.pos + mk.length));
      if (i > top.pos + mk.length) ranges.push(Decoration.mark({ class: cls }).range(top.pos + mk.length, i));
      ranges.push(Decoration.mark({ class: "cm-marker" }).range(i, i + mk.length));
    } else stack.push({ mk, pos: i });
    i += mk.length;
  }
  for (const o of stack) ranges.push(Decoration.mark({ class: "cm-marker cm-marker-bad", attributes: { title: `Unclosed "${o.mk}"` } }).range(o.pos, o.pos + o.mk.length));
  return Decoration.set(ranges, true);
}

export interface CommentRange { id: string; from: number; to: number; active: boolean }
const setComments = StateEffect.define<CommentRange[]>();
const commentField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) if (e.is(setComments)) {
      const b = new RangeSetBuilder<Decoration>();
      const sorted = [...e.value].filter(r => r.to > r.from && r.to <= tr.state.doc.length).sort((a, c) => a.from - c.from);
      for (const r of sorted) b.add(r.from, r.to, Decoration.mark({ class: r.active ? "cm-comment cm-comment-active" : "cm-comment", attributes: { "data-thread": r.id } }));
      deco = b.finish();
    }
    return deco;
  },
  provide: f => EditorView.decorations.from(f),
});

export interface SegmentEditorOpts {
  parent: HTMLElement;
  text: string;
  tokens: Token[];
  onChange: (text: string, changes: ChangeSet) => void;
  onLookup: (pos: number, text: string) => void;
  onSelect: (from: number, to: number) => void;
  onThreadClick: (id: string) => void;
}

export function createSegmentEditor(o: SegmentEditorOpts) {
  const tokMap = new Map(o.tokens.map(t => [t.id, t]));
  const markup = ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(v: EditorView) { this.decorations = buildDecorations(v.state.doc.toString(), tokMap); }
    update(u: ViewUpdate) { if (u.docChanged) this.decorations = buildDecorations(u.state.doc.toString(), tokMap); }
  }, {
    decorations: v => v.decorations,
    provide: p => EditorView.atomicRanges.of(view => {
      // only the token widgets are atomic
      const b = new RangeSetBuilder<Decoration>();
      for (const m of view.state.doc.toString().matchAll(TOKEN_RE)) b.add(m.index!, m.index! + m[0].length, Decoration.mark({}));
      return b.finish();
    }),
  });

  let applyingRemote = false;
  const view = new EditorView({
    parent: o.parent,
    state: EditorState.create({
      doc: o.text,
      extensions: [
        history(),
        keymap.of([
          { key: "Mod-d", preventDefault: true, run: v => { o.onLookup(v.state.selection.main.head, v.state.doc.toString()); return true; } },
          ...defaultKeymap, ...historyKeymap,
        ]),
        EditorView.lineWrapping,
        markup,
        commentField,
        EditorView.domEventHandlers({
          mousedown(e, v) {
            if (e.ctrlKey || e.metaKey) {
              const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
              if (pos != null) { e.preventDefault(); o.onLookup(pos, v.state.doc.toString()); return true; }
            }
            const el = (e.target as HTMLElement).closest("[data-thread]") as HTMLElement | null;
            if (el) o.onThreadClick(el.dataset.thread!);
            return false;
          },
        }),
        EditorView.updateListener.of(u => {
          if (u.docChanged && !applyingRemote) o.onChange(u.state.doc.toString(), u.changes);
          if (u.selectionSet || u.docChanged) { const r = u.state.selection.main; o.onSelect(r.from, r.to); }
        }),
      ],
    }),
  });

  return {
    view,
    setComments(ranges: CommentRange[]) { view.dispatch({ effects: setComments.of(ranges) }); },
    /** Replace the content from outside (another tab/device), unless the user is typing here. */
    setText(text: string) {
      if (view.hasFocus || view.state.doc.toString() === text) return;
      applyingRemote = true;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
      applyingRemote = false;
    },
    select(from: number, to: number) {
      const len = view.state.doc.length;
      view.dispatch({ selection: { anchor: Math.min(from, len), head: Math.min(to, len) }, scrollIntoView: true });
    },
    destroy() { view.destroy(); },
  };
}
export type SegmentEditor = ReturnType<typeof createSegmentEditor>;
