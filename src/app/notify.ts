// Wake the Claude session that published this artifact, via the artifact's
// comment store (comments.sendToClaude). Two kinds of wake:
//   "chat":   "Workbench chat: …"   -> Claude answers only the named message
//   "review": "Workbench review: …" -> Claude runs a full review of changes
// Each kind reuses one artifact comment thread per visit (replies, not new threads).
import { createSignal } from "solid-js";

export type WakeKind = "chat" | "review";

export function createNotifier(comments: any) {
  const [avail, setAvail] = createSignal<string>("off");
  const [status, setStatus] = createSignal<string>("");
  const threads: Partial<Record<WakeKind, string>> = {};
  let anchorEl: HTMLElement | null = null;

  function check() {
    if (!comments?.canSendToClaude) { setAvail("off"); return; }
    comments.canSendToClaude().then((v: string) => setAvail(v)).catch(() => setAvail("off"));
  }
  const setAnchor = (el: HTMLElement) => { anchorEl = el; };

  /** Call from the viewer's own click or key press, before awaiting anything else. */
  async function wake(kind: WakeKind, text: string): Promise<boolean> {
    if (avail() !== "available") return false;
    setStatus(kind === "review" ? "Asking Claude to review…" : "Sending to Claude…");
    try {
      const tid = threads[kind];
      let r: any;
      if (tid) {
        try { r = await comments.sendToClaude({ threadId: tid, text }); }
        catch (e: any) { if (e?.code !== "not_found") throw e; delete threads[kind]; }
      }
      if (!r) {
        const anchor = await comments.anchorFor(anchorEl ?? document.body);
        r = await comments.sendToClaude({ anchor, text });
      }
      threads[kind] = r.threadId;
      setStatus(kind === "review" ? "Claude is reviewing — notes will appear here." : "Sent — Claude will answer here.");
      return true;
    } catch (e: any) {
      setStatus("Couldn't reach Claude (" + (e?.code || e) + "). Tell Claude in your chat instead.");
      check();
      return false;
    }
  }
  return { avail, status, check, setAnchor, wake };
}
export type Notifier = ReturnType<typeof createNotifier>;
