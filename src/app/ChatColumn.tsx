import { createSignal, createMemo, createEffect, onSettled, For, Show } from "solid-js";
import type { AppState, MessageDoc } from "./state";
import type { Ui } from "./ui";

const fmtTime = (iso: string) => {
  const d = new Date(iso), today = new Date();
  const t = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === today.toDateString() ? t : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + t;
};

export function ChatColumn(props: { app: AppState; ui: Ui }) {
  const ui = () => props.ui.ui;
  const visibleThreads = createMemo(() => props.app.threadsForUnit().filter(t => ui().showResolved || !t.resolved));
  const openCount = createMemo(() => props.app.threadsForUnit().filter(t => !t.resolved).length);
  const waiting = createMemo(() => props.app.threadsForUnit().filter(t => !t.resolved && props.app.awaitingClaude(t.id)).length + (props.app.awaitingClaude("general") ? 1 : 0));
  const index = createMemo(() => visibleThreads().findIndex(t => t.id === ui().activeThread));
  const active = createMemo(() => (ui().activeThread ? props.app.live.threads[ui().activeThread!] : undefined));

  const step = (d: number) => {
    const list = visibleThreads(); if (!list.length) return;
    const i = index();
    const next = i < 0 ? (d > 0 ? 0 : list.length - 1) : (i + d + list.length) % list.length;
    props.ui.openThread(list[next].id);
  };

  return (
    <aside class="col-chat">
      <div class="tabs">
        <button class={{ on: ui().chatTab === "general" }} onClick={() => props.ui.setUi(s => { s.chatTab = "general"; })}>
          General<Show when={props.app.awaitingClaude("general")}><span class="dot" title="Waiting for Claude" /></Show>
        </button>
        <button class={{ on: ui().chatTab === "comments" }} onClick={() => props.ui.setUi(s => { s.chatTab = "comments"; })}>
          Comments <span class="count">{openCount()}</span>
        </button>
      </div>

      <Show when={ui().chatTab === "general"}>
        <Thread app={props.app} thread="general" placeholder="Ask Claude anything…" />
      </Show>

      <Show when={ui().chatTab === "comments"}>
        <div class="thread-nav">
          <button class="btn-quiet" onClick={() => step(-1)} disabled={!visibleThreads().length}>◀</button>
          <span>{visibleThreads().length ? `${index() >= 0 ? index() + 1 : "–"} of ${visibleThreads().length}` : "No comments"}</span>
          <button class="btn-quiet" onClick={() => step(1)} disabled={!visibleThreads().length}>▶</button>
          <label class="toggle"><input type="checkbox" checked={ui().showResolved} onChange={e => props.ui.setUi(s => { s.showResolved = e.currentTarget.checked; })} /> resolved</label>
        </div>
        <Show when={ui().draft} fallback={
          <Show when={active()} fallback={<div class="hint"><p>Select text in a paragraph, then click the <b>💬 Comment</b> button that appears beside it (or press <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>M</kbd>). A box to type your comment opens here.</p><p>Use ◀ ▶ to step through threads in reading order.</p></div>}>
            {t => (
              <>
                <div class="quote-box">
                  <button class="lex-ref" onClick={() => props.ui.jumpTo(t().ref, t().from, t().to)}>{t().ref}</button>
                  <blockquote>{t().quote}</blockquote>
                  <div class="thread-actions">
                    <Show when={props.app.awaitingClaude(t().id)}><span class="chip chip-wait">Waiting for Claude</span></Show>
                    <span class="spacer" />
                    <button class="btn-quiet" onClick={() => props.app.setResolved(t().id, !t().resolved)}>{t().resolved ? "Reopen" : "Resolve"}</button>
                  </div>
                </div>
                <Thread app={props.app} thread={t().id} placeholder="Reply…" />
              </>
            )}
          </Show>
        }>
          {d => <NewThread app={props.app} ui={props.ui} quote={d().quote} refLabel={d().ref} />}
        </Show>
      </Show>

      <footer class="chat-foot">
        <Show when={waiting()} fallback={<span class="muted">Nothing waiting for Claude.</span>}>
          <span><b>{waiting()}</b> waiting for Claude.</span>
        </Show>
        <ReviewButton app={props.app} />
        <Show when={props.app.notifier.status()}><div class="wake-status muted small">{props.app.notifier.status()}</div></Show>
      </footer>
    </aside>
  );
}

function Messages(props: { msgs: MessageDoc[] }) {
  let box!: HTMLDivElement;
  createEffect(() => props.msgs.length, () => { requestAnimationFrame(() => { if (box) box.scrollTop = box.scrollHeight; }); });
  return (
    <div class="msgs" ref={box}>
      <For each={props.msgs}>
        {m => (
          <div class={["msg", "by-" + m.by]}>
            <div class="msg-meta">{m.by === "claude" ? "Claude" : "You"} · {fmtTime(m.at)}</div>
            <div class="msg-text">{m.text}</div>
          </div>
        )}
      </For>
    </div>
  );
}

function Composer(props: { placeholder: string; onSend: (t: string) => Promise<unknown> | void; label?: string; autofocus?: boolean }) {
  const [draft, setDraft] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  let ta!: HTMLTextAreaElement;
  const send = async () => {
    const t = draft().trim(); if (!t || busy()) return;
    setBusy(true);
    try { await props.onSend(t); setDraft(""); ta.value = ""; } finally { setBusy(false); }
  };
  return (
    <div class="composer">
      <textarea ref={el => { ta = el; if (props.autofocus) setTimeout(() => el.focus(), 0); }} placeholder={props.placeholder} rows={3}
        onInput={e => setDraft(e.currentTarget.value)}
        onKeyDown={e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } }} />
      <div class="composer-bar"><span class="muted">Ctrl+Enter to send</span><button class="btn-small btn-final" disabled={busy() || !draft().trim()} onClick={send}>{props.label ?? "Send"}</button></div>
    </div>
  );
}

function Thread(props: { app: AppState; thread: string; placeholder: string }) {
  const msgs = createMemo(() => props.app.messagesOf(props.thread));
  const send = (t: string) => {
    const id = props.app.newId();
    const t0 = props.app.live.threads[props.thread];
    const where = props.thread === "general" ? "the General chat" : `the comment thread on ${t0?.ref ?? "?"} (thread ${props.thread})`;
    // wake first, while the click still counts as the viewer's gesture
    const woke = props.app.notifier.wake("chat", chatWakeText(where, id, t));
    return Promise.all([woke, props.app.sendMessage(props.thread, t, id)]);
  };
  return (
    <div class="thread">
      <Messages msgs={msgs()} />
      <Composer placeholder={props.placeholder} onSend={send} />
    </div>
  );
}

const chatWakeText = (where: string, id: string, text: string) =>
  `Workbench chat: new message in ${where} (message ${id}). Answer only this message in the workbench; no review.\n\n"${text.length > 300 ? text.slice(0, 297) + "…" : text}"`;

function NewThread(props: { app: AppState; ui: Ui; quote: string; refLabel: string }) {
  return (
    <div class="thread">
      <div class="quote-box">
        <span class="lex-ref">{props.refLabel}</span>
        <blockquote>{props.quote}</blockquote>
        <div class="thread-actions"><span class="muted">New comment</span><span class="spacer" />
          <button class="btn-quiet" onClick={() => props.ui.setUi(s => { s.draft = null; })}>Cancel</button></div>
      </div>
      <div class="msgs" />
      <Composer placeholder="What should Claude look at here?" label="Start thread" autofocus onSend={async t => {
        const d = props.ui.ui.draft; if (!d) return;
        const tid = props.app.newId(), mid = props.app.newId();
        const woke = props.app.notifier.wake("chat", chatWakeText(`a new comment thread on ${d.ref} (thread ${tid})`, mid, t));
        const id = await props.app.createThread(d.ref, d.from, d.to, d.quote, t, tid, mid);
        props.ui.setUi(s => { s.draft = null; s.activeThread = id; });
        await woke;
      }} />
    </div>
  );
}

/** Wakes Claude for a full review of changes (artifact comment -> publishing session). */
function ReviewButton(props: { app: AppState }) {
  const n = props.app.notifier;
  onSettled(() => { n.check(); });
  return (
    <Show when={n.avail() === "available"} fallback={<span class="muted small">To reach Claude, use your chat: “check the workbench”.</span>}>
      <button ref={el => n.setAnchor(el)} class="btn-small btn-final" onClick={() => n.wake("review", "Workbench review: please run a full review of the changes (new rewrites and waiting threads).")}>Claude Review Changes</button>
    </Show>
  );
}
