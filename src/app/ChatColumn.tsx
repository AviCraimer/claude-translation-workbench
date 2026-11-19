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
          <Show when={active()} fallback={<div class="hint"><p>Select text in a paragraph and press <b>Comment</b> to start a thread anchored to it.</p><p>Use ◀ ▶ to step through threads in reading order.</p></div>}>
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
        <NotifyButton app={props.app} />
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
  return (
    <div class="thread">
      <Messages msgs={msgs()} />
      <Composer placeholder={props.placeholder} onSend={t => props.app.sendMessage(props.thread, t)} />
    </div>
  );
}

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
        const id = await props.app.createThread(d.ref, d.from, d.to, d.quote, t);
        props.ui.setUi(s => { s.draft = null; s.activeThread = id; });
      }} />
    </div>
  );
}

/** Optional: post an artifact comment that wakes the Claude session that published this page. */
function NotifyButton(props: { app: AppState }) {
  const [avail, setAvail] = createSignal<string>("off");
  const [msg, setMsg] = createSignal("");
  const c = props.app.platform.comments;
  const check = () => { if (c?.canSendToClaude) c.canSendToClaude().then((v: string) => setAvail(v)).catch(() => setAvail("off")); };
  onSettled(() => { check(); });
  let btn!: HTMLButtonElement;
  const notify = async () => {
    setMsg("Sending…");
    try {
      const anchor = await c.anchorFor(btn);
      await c.sendToClaude({ anchor, text: "Workbench: please check new edits and comments waiting for you." });
      setMsg("Sent — Claude will reply in these threads.");
    } catch (e: any) { setMsg("Couldn't notify (" + (e?.code || e) + "). Tell Claude in your chat instead."); check(); }
  };
  return (
    <Show when={avail() === "available"} fallback={<span class="muted small">Tell Claude in your chat: “check the workbench”.</span>}>
      <button ref={btn} class="btn-small" onClick={notify}>Notify Claude</button>
      <Show when={msg()}><span class="muted small">{msg()}</span></Show>
    </Show>
  );
}
