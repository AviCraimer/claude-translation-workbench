// View state shared by the three columns.
import { createStore } from "solid-js";
import type { AppState } from "./state";
import { lookupAt } from "./lexicon";
import type { SegmentEditor } from "./segment-editor";

export interface LexCard { id: string; ref: string; query: string; keys: string[] }
export interface Draft { ref: string; from: number; to: number; quote: string }

export function createUi(app: AppState) {
  const [ui, setUi] = createStore({
    lexCards: [] as LexCard[],
    chatTab: "general" as "general" | "comments",
    activeThread: null as string | null,
    draft: null as Draft | null,
    showHebrew: true,
    commentView: "open" as "open" | "resolved",
    selection: null as { ref: string; from: number; to: number } | null,
  });
  const editors = new Map<string, SegmentEditor>();

  function lookup(ref: string, pos: number, text: string) {
    const idx = app.lexIndex();
    const seg = app.bundle()?.segments.find(s => s.ref === ref);
    if (!idx || !seg) return;
    const r = lookupAt(idx, text, pos, seg.lexHits);
    if (!r) return;
    const last = ui.lexCards[ui.lexCards.length - 1];
    if (last && last.query === r.query && last.ref === ref) return;
    // an entry already shown moves to the bottom instead of repeating
    setUi(s => {
      if (r.keys.length) s.lexCards = s.lexCards.filter(c => !(c.keys.length === r.keys.length && c.keys.every(k => r.keys.includes(k))));
      s.lexCards.push({ id: Math.random().toString(36).slice(2), ref, query: r.query, keys: r.keys });
    });
  }
  const removeCard = (id: string) => setUi(s => { s.lexCards = s.lexCards.filter(c => c.id !== id); });
  const clearCards = () => setUi(s => { s.lexCards = []; });

  function jumpTo(ref: string, from?: number, to?: number) {
    const el = document.getElementById("seg-" + ref.replace(/:/g, "-"));
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    if (from != null) setTimeout(() => editors.get(ref)?.select(from, to ?? from), 350);
  }
  function openThread(id: string) {
    const t = app.live.threads[id];
    setUi(s => { s.chatTab = "comments"; s.activeThread = id; s.draft = null; });
    if (t) jumpTo(t.ref, t.from, t.to);
  }
  function startComment() {
    const sel = ui.selection;
    if (!sel || sel.to <= sel.from) return;
    const quote = app.currentText(sel.ref).slice(sel.from, sel.to);
    setUi(s => { s.chatTab = "comments"; s.draft = { ...sel, quote }; s.activeThread = null; });
  }

  return { ui, setUi, editors, lookup, removeCard, clearCards, jumpTo, openThread, startComment };
}
export type Ui = ReturnType<typeof createUi>;
