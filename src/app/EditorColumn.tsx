import { createSignal, createMemo, createEffect, onSettled, For, Show } from "solid-js";
import type { Segment } from "../core/formats";
import type { AppState } from "./state";
import type { Ui } from "./ui";
import { createSegmentEditor, type SegmentEditor } from "./segment-editor";
import { wordDiff } from "../core/diff";

const STATUS_LABEL = { untouched: "Untouched", rewritten: "Rewritten", finalized: "Finalized", committed: "Committed", review: "Needs re-review", conflict: "Repo changed" } as const;

export function EditorColumn(props: { app: AppState; ui: Ui }) {
  return (
    <main class="col-editor">
      <Show when={props.app.bundle()} fallback={<div class="empty">{props.app.loadError() ?? "Loading chapter…"}</div>}>
        {b => (
          <div class="chapter">
            <header class="chapter-head">
              <h1>{b().title}</h1>
              <Show when={b().subtitle}><p class="subtitle">{b().subtitle}</p></Show>
            </header>
            <For each={b().segments}>
              {seg => <SegmentCard app={props.app} ui={props.ui} seg={seg} dir={b().sourceDir} />}
            </For>
          </div>
        )}
      </Show>
    </main>
  );
}

function SegmentCard(props: { app: AppState; ui: Ui; seg: Segment; dir: string }) {
  const [editor, setEditor] = createSignal<SegmentEditor | null>(null);
  const [showDiff, setShowDiff] = createSignal(false);
  const [heOpen, setHeOpen] = createSignal<boolean | null>(null);
  const [text, setText] = createSignal(props.app.currentText(props.seg.ref));
  const [floatAt, setFloatAt] = createSignal<{ x: number; y: number } | null>(null);
  let host!: HTMLDivElement;
  let card!: HTMLElement;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  const ref = () => props.seg.ref;
  const status = createMemo(() => props.app.statusOf(ref()));
  const review = createMemo(() => props.app.reviewOf(ref()));
  const problems = createMemo(() => props.app.problemsOf(ref()));
  // open view: highlight open threads only; resolved view: resolved ones only
  const threads = createMemo(() => props.app.threadsForUnit().filter(t => t.ref === ref() && !!t.resolved === (props.ui.ui.commentView === "resolved")));
  const hasSelection = createMemo(() => { const s = props.ui.ui.selection; return !!s && s.ref === ref() && s.to > s.from; });
  const heVisible = () => heOpen() ?? props.ui.ui.showHebrew;
  // Changes: against the text you approved when someone has changed it since; otherwise against the repo text
  const diffBase = () => (status() === "review" && props.seg.approval?.approvedText ? props.seg.approval.approvedText.text : props.seg.target.text);
  const diff = createMemo(() => (showDiff() ? wordDiff(diffBase(), text()) : null));

  onSettled(() => {
    const mount = () => {
      if (editor()) return;
      const ed = createSegmentEditor({
        parent: host,
        text: props.app.currentText(props.seg.ref),
        tokens: props.seg.target.tokens,
        onChange: (t, changes) => {
          setText(t);
          for (const th of props.app.threadsForUnit()) if (th.ref === props.seg.ref) {
            const from = changes.mapPos(th.from, 1), to = changes.mapPos(th.to, -1);
            if (from !== th.from || to !== th.to) props.app.moveAnchor(th.id, from, Math.max(from, to));
          }
          clearTimeout(saveTimer);
          saveTimer = setTimeout(() => props.app.saveText(props.seg.ref, t), 700);
        },
        onLookup: (pos, t) => props.ui.lookup(props.seg.ref, pos, t),
        onSelect: (from, to) => {
          props.ui.setUi(s => { s.selection = { ref: props.seg.ref, from, to }; });
          if (to <= from) { setFloatAt(null); return; }
          // place a floating Comment button just above the end of the selection
          requestAnimationFrame(() => {
            const v = editor()?.view;
            if (!v?.hasFocus) { setFloatAt(null); return; } // only for the viewer's own selections
            const c = v.coordsAtPos(to), r = card.getBoundingClientRect();
            if (c) setFloatAt({ x: Math.max(8, Math.min(c.left - r.left - 50, r.width - 120)), y: c.top - r.top - 32 });
          });
        },
        onThreadClick: id => props.ui.openThread(id),
        onCommentKey: () => { setFloatAt(null); props.ui.startComment(); },
      });
      props.ui.editors.set(props.seg.ref, ed);
      setEditor(ed);
    };
    const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { mount(); io.disconnect(); } }, { rootMargin: "600px" });
    io.observe(host);
    return () => {
      io.disconnect();
      if (saveTimer) { clearTimeout(saveTimer); props.app.saveText(props.seg.ref, text()); }
      props.ui.editors.delete(props.seg.ref);
      editor()?.destroy();
    };
  });

  // keep highlights in step with this segment's threads
  createEffect(
    () => ({ ed: editor(), ranges: threads().map(t => ({ id: t.id, from: t.from, to: t.to, active: t.id === props.ui.ui.activeThread, resolved: !!t.resolved })) }),
    ({ ed, ranges }) => { ed?.setComments(ranges); },
  );
  // text written elsewhere (another tab or device)
  createEffect(
    () => ({ ed: editor(), remote: props.app.savedEditText(props.seg.ref) }),
    ({ ed, remote }) => { if (ed && remote != null) { ed.setText(remote); if (!ed.view.hasFocus) setText(remote); } },
  );

  return (
    <section ref={card} class={["seg", "st-" + status()]} id={"seg-" + props.seg.ref.replace(/:/g, "-")}>
      <Show when={hasSelection() && floatAt()}>
        {p => (
          <button class="float-comment" style={{ left: p().x + "px", top: p().y + "px" }}
            onMouseDown={e => e.preventDefault()}
            onClick={() => { setFloatAt(null); props.ui.startComment(); }}>💬 Comment</button>
        )}
      </Show>
      <div class="seg-bar">
        <span class="seg-ref">{props.seg.ref}</span>
        <span class={["chip", "chip-" + status()]}>{STATUS_LABEL[status()]}</span>
        <Show when={review()}>{r => <span class={["chip", r().verdict === "ok" ? "chip-ok" : "chip-issues"]} title={r().summary ?? ""}>{r().verdict === "ok" ? "✓ Reviewed" : "⚠ Review notes"}</span>}</Show>
        <Show when={problems().length}><span class="chip chip-bad" title={problems().map(p => p.message).join("\n")}>Markup: {problems()[0].message}</span></Show>
        <Show when={props.app.saveErrors()[props.seg.ref]}><span class="chip chip-bad">Not saved: {props.app.saveErrors()[props.seg.ref]}</span></Show>
        <span class="spacer" />
        <button class={["btn-quiet", { on: heVisible() }]} onClick={() => setHeOpen(!heVisible())} title="Show or hide the Hebrew">Hebrew</button>
        <button class={["btn-quiet", { on: showDiff() }]} onClick={() => setShowDiff(!showDiff())}>Changes</button>
        <button class="btn-quiet" disabled={!hasSelection()} onClick={() => props.ui.startComment()} title="Select text in this paragraph first (Ctrl+Alt+M)">Comment</button>
        <Show when={status() !== "committed" && status() !== "conflict"}>
          <button class={["btn-small", status() === "finalized" ? "btn-undo" : "btn-final"]} disabled={problems().length > 0}
            onClick={() => props.app.setFinalized(props.seg.ref, status() !== "finalized")}
            title={status() === "review" ? "Accept the text as it now stands" : ""}>
            {status() === "finalized" ? "Unfinalize" : status() === "review" ? "Approve" : "Finalize"}
          </button>
        </Show>
      </div>
      <Show when={status() === "review"}>
        <div class="banner banner-review">
          <b>Changed since you approved it.</b> Look at <button class="btn-link" onClick={() => setShowDiff(true)}>Changes</button>, then edit or <b>Approve</b> it as it stands.
          <Show when={props.seg.approval?.changedBy?.length}>
            <ul class="changers"><For each={props.seg.approval!.changedBy!}>{c => <li><code>{c.sha.slice(0, 7)}</code> {c.date}: {c.subject}</li>}</For></ul>
          </Show>
        </div>
      </Show>
      <Show when={status() === "conflict"}>
        <div class="banner banner-conflict">
          <b>The repository text changed while you were editing this paragraph.</b> Your draft is kept below; Changes shows it against the new repository text.
          <div class="banner-actions">
            <button class="btn-small" onClick={() => props.app.saveText(props.seg.ref, text())} title="Keep your draft; committing it will replace the new repository text">Keep my version</button>
            <button class="btn-small" onClick={() => { editor()?.forceText(props.seg.target.text); setText(props.seg.target.text); props.app.saveText(props.seg.ref, props.seg.target.text); }} title="Discard your draft and start from the new repository text">Use repository text</button>
          </div>
        </div>
      </Show>
      <Show when={heVisible() && props.seg.source}>
        <p class="src" dir={props.dir as "rtl" | "ltr"} lang="he">{props.seg.source}</p>
      </Show>
      <div class="cm-host" ref={host} />
      <Show when={showDiff()}>
        <div class="diff">
          <Show when={diff()} fallback={<em>Paragraph too long to compare.</em>}>
            {d => (
              <Show when={d().some(p => p.op !== "same")} fallback={<em>No changes from the repository text.</em>}>
                <For each={d()}>{p => <span class={"d-" + p.op}>{p.text}</span>}</For>
              </Show>
            )}
          </Show>
        </div>
      </Show>
      <Show when={threads().length}>
        <div class="seg-threads">
          <For each={threads()}>
            {t => (
              <button class={["thread-pill", { active: t.id === props.ui.ui.activeThread, waiting: props.app.awaitingClaude(t.id), resolved: !!t.resolved }]}
                onClick={() => props.ui.openThread(t.id)} title={t.quote}>
                💬 “{t.quote.length > 28 ? t.quote.slice(0, 26) + "…" : t.quote}”
              </button>
            )}
          </For>
        </div>
      </Show>
    </section>
  );
}
