import { For, Show, createEffect } from "solid-js";
import type { AppState } from "./state";
import type { Ui, LexCard } from "./ui";
import type { LexEntry } from "../core/formats";

export function InfoColumn(props: { app: AppState; ui: Ui }) {
  let list!: HTMLDivElement;
  // newest card at the bottom: keep it in view
  createEffect(() => props.ui.ui.lexCards.length, n => { if (n && list) requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; }); });
  return (
    <aside class="col-info">
      <div class="col-head">
        <h2>Lexicon</h2>
        <Show when={props.ui.ui.lexCards.length}><button class="btn-quiet" onClick={() => props.ui.clearCards()}>Clear</button></Show>
      </div>
      <div class="card-list" ref={list}>
        <Show when={props.ui.ui.lexCards.length} fallback={
          <div class="hint">
            <p><kbd>Ctrl</kbd>+click a word in the English, or put the cursor on it and press <kbd>Ctrl</kbd>+<kbd>D</kbd>.</p>
            <p>Entries stay here as a list, newest at the bottom, until you close them.</p>
            <Show when={!props.app.lexIndex()}><p class="muted">Loading lexicon…</p></Show>
          </div>
        }>
          <For each={props.ui.ui.lexCards}>{card => <CardView app={props.app} ui={props.ui} card={card} />}</For>
        </Show>
      </div>
    </aside>
  );
}

function CardView(props: { app: AppState; ui: Ui; card: LexCard }) {
  const entries = () => props.card.keys.map(k => props.app.lexIndex()?.entries.get(k)).filter(Boolean) as LexEntry[];
  const hitsHere = () => new Map((props.app.bundle()?.segments.find(s => s.ref === props.card.ref)?.lexHits ?? []).map(h => [h.key, h.form]));
  return (
    <article class="lex-card">
      <header>
        <span class="lex-q">“{props.card.query}”</span>
        <button class="lex-ref" onClick={() => props.ui.jumpTo(props.card.ref)}>{props.card.ref}</button>
        <button class="x" title="Remove" onClick={() => props.ui.removeCard(props.card.id)}>×</button>
      </header>
      <Show when={entries().length} fallback={<p class="muted">No lexicon entry.</p>}>
        <For each={entries()}>
          {e => (
            <div class="lex-entry">
              <div class="lex-head">
                <span class="hw" dir="rtl" lang="he">{e.headword}</span>
                <Show when={e.transliteration}><span class="tl">{e.transliteration}</span></Show>
                <Show when={e.pos}><span class="pos">{e.pos}</span></Show>
              </div>
              <div class="rendering">{e.rendering}</div>
              <Show when={hitsHere().get(e.key)}>{f => <div class="here">In this paragraph's Hebrew: <span dir="rtl" lang="he">{f()}</span></div>}</Show>
              <Show when={e.candidates.length}>
                <ul class="cands">
                  <For each={e.candidates}>
                    {c => <li class={"cand-" + c.status}><span class="cs">{c.status}</span> {c.target}<Show when={c.gloss}><div class="gloss">{c.gloss}</div></Show></li>}
                  </For>
                </ul>
              </Show>
              <Show when={e.note}><p class="note">{e.note}</p></Show>
              <Show when={e.forms.some(f => f.rendering)}>
                <details><summary>Forms ({e.forms.length})</summary>
                  <ul class="forms"><For each={e.forms}>{f => <li><span dir="rtl" lang="he">{f.form}</span> — {f.rendering ?? ""}</li>}</For></ul>
                </details>
              </Show>
              <Show when={e.candidates.some(c => c.notes)}>
                <details><summary>Context notes</summary>
                  <For each={e.candidates.filter(c => c.notes)}>{c => <p class="ctx">{c.notes}</p>}</For>
                </details>
              </Show>
              <Show when={e.etymology}><details><summary>Etymology</summary><p class="ctx">{e.etymology}</p></details></Show>
            </div>
          )}
        </For>
      </Show>
    </article>
  );
}
