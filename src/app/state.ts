// App state: static data (manifest, chapter bundles, lexicon) and live
// database state (edits, reviews, commits, threads, messages).
//
// Database layout (all written as plain JSON):
//   edits/<key>    page-owned  {ref, unit, text, baseHash, rev, finalized, finalizedRev, updatedAt}
//   reviews/<key>  Claude      {ref, rev, verdict: "ok"|"issues", summary, at}
//   commits/<key>  Claude      {ref, rev, sha, at}
//   threads/<id>   page or Claude {kind: "anchor", unit, ref, from, to, quote, resolved, createdBy, createdAt}
//   messages/<id>  page or Claude {thread, by: "human"|"claude", text, at}
// <key> is the segment ref with ":" replaced by "." (e.g. 1.1.3).
// The general chat is thread id "general" (no thread document needed).

import { createSignal, createStore, createMemo } from "solid-js";
import type { ChapterBundle, LexiconBundle, Manifest, Segment } from "../core/formats";
import { checkEditable } from "../core/markup";
import type { Platform } from "./platform";
import { buildIndex, type LexIndex } from "./lexicon";
import { createNotifier } from "./notify";

export interface EditDoc { ref: string; unit: string; text: string; baseHash: string; rev: number; finalized?: boolean; finalizedRev?: number; updatedAt?: string }
export interface ReviewDoc { ref: string; rev: number; verdict: "ok" | "issues"; summary?: string; at?: string }
export interface CommitDoc { ref: string; rev: number; sha: string; at?: string }
export interface ThreadDoc { id: string; kind: "anchor"; unit: string; ref: string; from: number; to: number; quote: string; resolved?: boolean; createdBy: "human" | "claude"; createdAt: string }
export interface MessageDoc { id: string; thread: string; by: "human" | "claude"; text: string; at: string }

export type Status = "untouched" | "rewritten" | "finalized" | "committed" | "review" | "conflict";

export const refKey = (ref: string) => ref.replace(/:/g, ".");
const now = () => new Date().toISOString();
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export function createAppState(platform: Platform) {
  const db = platform.db;
  const notifier = createNotifier(platform.comments);
  const [manifest, setManifest] = createSignal<Manifest | null>(null);
  const [unitId, setUnitId] = createSignal<string | null>(null);
  const [bundle, setBundle] = createSignal<ChapterBundle | null>(null);
  const [lexIndex, setLexIndex] = createSignal<LexIndex | null>(null);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [dbState, setDbState] = createSignal<"connecting" | "live" | "offline" | "slow">(db ? "connecting" : "offline");

  const [live, setLive] = createStore({
    edits: {} as Record<string, EditDoc>,
    reviews: {} as Record<string, ReviewDoc>,
    commits: {} as Record<string, CommitDoc>,
    threads: {} as Record<string, ThreadDoc>,
    messages: [] as MessageDoc[],
  });

  // ---- static data ----
  async function fetchJson<T>(path: string): Promise<T> {
    const r = await fetch(path);
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return r.json();
  }
  async function loadStatic() {
    try {
      const m = await fetchJson<Manifest>("data/manifest.json");
      setManifest(m);
      if (m.lexicon) fetchJson<LexiconBundle>("data/" + m.lexicon).then(b => setLexIndex(buildIndex(b))).catch(e => console.warn(e));
      const want = location.hash.slice(1).replace(/-/g, ":");
      const first = m.units.find(u => u.id === want) ?? m.units[0];
      if (first) await openUnit(first.id, m);
    } catch (e: any) { setLoadError(String(e.message || e)); }
  }
  // (signal reads lag writes until the next microtask, so take the manifest explicitly)
  async function openUnit(id: string, m: Manifest | null = manifest()) {
    const u = m?.units.find(x => x.id === id);
    if (!u) return;
    setUnitId(id);
    try { location.hash = id.replace(/:/g, "-"); } catch {}
    setBundle(await fetchJson<ChapterBundle>("data/" + u.file));
  }

  // ---- live data ----
  function subscribe() {
    if (!db) return;
    const timer = setTimeout(() => setDbState("slow"), 10000);
    const sub = <T,>(coll: string, apply: (docs: { id: string; data: T }[]) => void) =>
      db.collection(coll).onSnapshot(
        s => { clearTimeout(timer); setDbState("live"); apply(s.docs.filter(d => d.exists).map(d => ({ id: d.id, data: structuredClone(d.data()) as T }))); },
        e => { console.warn(coll, e); setDbState("offline"); },
      );
    sub<EditDoc>("edits", docs => setLive(s => { s.edits = Object.fromEntries(docs.map(d => [d.data.ref, d.data])); }));
    sub<ReviewDoc>("reviews", docs => setLive(s => { s.reviews = Object.fromEntries(docs.map(d => [d.data.ref, d.data])); }));
    sub<CommitDoc>("commits", docs => setLive(s => { s.commits = Object.fromEntries(docs.map(d => [d.data.ref, d.data])); }));
    sub<ThreadDoc>("threads", docs => setLive(s => { s.threads = Object.fromEntries(docs.map(d => [d.id, { ...d.data, id: d.id }])); }));
    sub<MessageDoc>("messages", docs => setLive(s => { s.messages = docs.map(d => ({ ...d.data, id: d.id })).sort((a, b) => a.at.localeCompare(b.at)); }));
  }

  // ---- edits: one write at a time per document ----
  const chains = new Map<string, Promise<void>>();
  const pending = new Map<string, EditDoc>();
  const [saveErrors, setSaveErrors] = createSignal<Record<string, string>>({});
  function queueWrite(ref: string, doc: EditDoc) {
    pending.set(ref, doc);
    const prev = chains.get(ref) ?? Promise.resolve();
    const next = prev.then(async () => {
      const d = pending.get(ref);
      if (!d || !db) return;
      pending.delete(ref);
      try {
        await db.doc("edits/" + refKey(ref)).set({ ...d });
        setSaveErrors(e => { const c = { ...e }; delete c[ref]; return c; });
      } catch (e: any) {
        setSaveErrors(x => ({ ...x, [ref]: e?.code || String(e) }));
      }
    });
    chains.set(ref, next);
  }

  const segOf = (ref: string): Segment | undefined => bundle()?.segments.find(s => s.ref === ref);

  /** The edit that applies to the text now loaded:
   *  - an edit made on this base text applies;
   *  - an older-base edit that was committed is history (the repo now has it): ignored;
   *  - an older-base edit that was NOT committed is a conflict: the repo changed under it. */
  function editFor(ref: string): { edit: EditDoc; stale: boolean } | null {
    const seg = segOf(ref);
    const e = pending.get(ref) ?? live.edits[ref];
    if (!e || !seg) return null;
    if (e.baseHash === seg.baseHash) return { edit: e, stale: false };
    const c = live.commits[ref];
    if (c && c.rev === e.rev) return null;
    return { edit: e, stale: true };
  }
  /** Latest text for a segment: the applicable edit (pending or saved), else the bundle text. */
  function currentText(ref: string): string {
    return editFor(ref)?.edit.text ?? segOf(ref)?.target.text ?? "";
  }
  /** Text of the saved edit, for syncing other tabs; null when no edit applies. */
  const savedEditText = (ref: string): string | null => {
    const seg = segOf(ref), e = live.edits[ref];
    if (!seg || !e) return null;
    const c = live.commits[ref];
    return e.baseHash === seg.baseHash || !(c && c.rev === e.rev) ? e.text : null;
  };
  const lastRev = (ref: string) => (pending.get(ref) ?? live.edits[ref])?.rev ?? 0;
  function saveText(ref: string, text: string) {
    const seg = segOf(ref); if (!seg) return;
    const doc: EditDoc = { ref, unit: unitId()!, text, baseHash: seg.baseHash, rev: lastRev(ref) + 1, finalized: false, updatedAt: now() };
    setLive(s => { s.edits[ref] = doc; });
    queueWrite(ref, doc);
  }
  /** Finalize (approve) the current text, or unfinalize. Approving unchanged repo text is allowed:
   *  that is how a paragraph changed by someone else gets re-approved. */
  function setFinalized(ref: string, on: boolean) {
    const seg = segOf(ref); if (!seg) return;
    const cur = editFor(ref);
    const sameRev = cur && !cur.stale;
    const doc: EditDoc = { ref, unit: unitId()!, text: currentText(ref), baseHash: seg.baseHash, rev: sameRev ? cur!.edit.rev : lastRev(ref) + 1, finalized: on, updatedAt: now() };
    if (on) doc.finalizedRev = doc.rev;
    setLive(s => { s.edits[ref] = doc; });
    queueWrite(ref, doc);
  }

  function statusOf(ref: string): Status {
    const seg = segOf(ref);
    const cur = editFor(ref);
    if (cur?.stale) return "conflict";
    if (cur) {
      const e = cur.edit, c = live.commits[ref];
      if (c && c.rev === e.rev) return "committed";
      if (e.finalized && e.finalizedRev === e.rev) return "finalized";
      if (!seg || e.text !== seg.target.text) return "rewritten";
    }
    const a = seg?.approval;
    if (a) return a.current ? "committed" : "review";
    return "untouched";
  }
  function reviewOf(ref: string): ReviewDoc | null {
    const cur = editFor(ref), r = live.reviews[ref];
    return cur && !cur.stale && r && r.rev === cur.edit.rev ? r : null;
  }
  const problemsOf = (ref: string) => {
    const seg = segOf(ref);
    return seg ? checkEditable(currentText(ref), seg.target.tokens).problems : [];
  };

  // ---- threads & messages ----
  const threadsForUnit = createMemo(() => {
    const b = bundle(); if (!b) return [] as ThreadDoc[];
    const order = new Map(b.segments.map((s, i) => [s.ref, i]));
    return Object.values(live.threads)
      .filter(t => t.unit === b.unitId)
      .sort((a, b2) => (order.get(a.ref)! - order.get(b2.ref)!) || a.from - b2.from);
  });
  const messagesOf = (thread: string) => live.messages.filter(m => m.thread === thread);
  const awaitingClaude = (thread: string) => { const ms = messagesOf(thread); return ms.length > 0 && ms[ms.length - 1].by === "human"; };

  async function sendMessage(thread: string, text: string, id: string = newId()) {
    if (!db || !text.trim()) return;
    const m: MessageDoc = { id, thread, by: "human", text: text.trim(), at: now() };
    setLive(s => { s.messages.push(m); });
    await db.doc("messages/" + id).set({ thread, by: "human", text: m.text, at: m.at });
  }
  async function createThread(ref: string, from: number, to: number, quote: string, firstMessage: string, id: string = newId(), msgId?: string): Promise<string | null> {
    if (!db) return null;
    const t: ThreadDoc = { id, kind: "anchor", unit: unitId()!, ref, from, to, quote, resolved: false, createdBy: "human", createdAt: now() };
    setLive(s => { s.threads[id] = t; });
    const { id: _omit, ...data } = t;
    await db.doc("threads/" + id).set(data);
    await sendMessage(id, firstMessage, msgId);
    return id;
  }
  async function setResolved(id: string, resolved: boolean) {
    if (!db) return;
    setLive(s => { if (s.threads[id]) s.threads[id].resolved = resolved; });
    await db.doc("threads/" + id).update({ resolved });
  }
  // anchor positions move as the text is edited; write them back lazily
  const anchorTimers = new Map<string, ReturnType<typeof setTimeout>>();
  function moveAnchor(id: string, from: number, to: number) {
    setLive(s => { const t = s.threads[id]; if (t) { t.from = from; t.to = to; } });
    clearTimeout(anchorTimers.get(id));
    anchorTimers.set(id, setTimeout(() => { db?.doc("threads/" + id).update({ from, to }).catch(() => {}); }, 1500));
  }

  return {
    platform, notifier, newId, manifest, unitId, bundle, lexIndex, loadError, dbState, live, saveErrors,
    loadStatic, openUnit, subscribe, currentText, savedEditText, segOf, saveText, setFinalized, statusOf, reviewOf, problemsOf,
    threadsForUnit, messagesOf, awaitingClaude, sendMessage, createThread, setResolved, moveAnchor,
  };
}
export type AppState = ReturnType<typeof createAppState>;
