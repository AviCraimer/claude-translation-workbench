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

export interface EditDoc { ref: string; unit: string; text: string; baseHash: string; rev: number; finalized?: boolean; finalizedRev?: number; updatedAt?: string }
export interface ReviewDoc { ref: string; rev: number; verdict: "ok" | "issues"; summary?: string; at?: string }
export interface CommitDoc { ref: string; rev: number; sha: string; at?: string }
export interface ThreadDoc { id: string; kind: "anchor"; unit: string; ref: string; from: number; to: number; quote: string; resolved?: boolean; createdBy: "human" | "claude"; createdAt: string }
export interface MessageDoc { id: string; thread: string; by: "human" | "claude"; text: string; at: string }

export type Status = "untouched" | "rewritten" | "finalized" | "committed";

export const refKey = (ref: string) => ref.replace(/:/g, ".");
const now = () => new Date().toISOString();
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export function createAppState(platform: Platform) {
  const db = platform.db;
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
  /** Latest text for a segment: local pending > database > bundle. */
  function currentText(ref: string): string {
    return pending.get(ref)?.text ?? live.edits[ref]?.text ?? segOf(ref)?.target.text ?? "";
  }
  function saveText(ref: string, text: string) {
    const seg = segOf(ref); if (!seg) return;
    const prev = pending.get(ref) ?? live.edits[ref];
    const doc: EditDoc = {
      ref, unit: unitId()!, text, baseHash: seg.baseHash,
      rev: (prev?.rev ?? 0) + 1, finalized: false, updatedAt: now(),
    };
    setLive(s => { s.edits[ref] = doc; });
    queueWrite(ref, doc);
  }
  function setFinalized(ref: string, on: boolean) {
    const seg = segOf(ref); if (!seg) return;
    const prev = pending.get(ref) ?? live.edits[ref];
    const text = prev?.text ?? seg.target.text;
    const doc: EditDoc = { ref, unit: unitId()!, text, baseHash: seg.baseHash, rev: (prev?.rev ?? 0) + (prev ? 0 : 1), finalized: on, updatedAt: now() };
    if (on) doc.finalizedRev = doc.rev;
    setLive(s => { s.edits[ref] = doc; });
    queueWrite(ref, doc);
  }

  function statusOf(ref: string): Status {
    const e = live.edits[ref];
    if (!e) return "untouched";
    const c = live.commits[ref];
    if (c && c.rev === e.rev) return "committed";
    if (e.finalized && e.finalizedRev === e.rev) return "finalized";
    const seg = segOf(ref);
    if (seg && e.text === seg.target.text) return "untouched";
    return "rewritten";
  }
  function reviewOf(ref: string): ReviewDoc | null {
    const e = live.edits[ref], r = live.reviews[ref];
    return e && r && r.rev === e.rev ? r : null;
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

  async function sendMessage(thread: string, text: string) {
    if (!db || !text.trim()) return;
    const id = newId();
    const m: MessageDoc = { id, thread, by: "human", text: text.trim(), at: now() };
    setLive(s => { s.messages.push(m); });
    await db.doc("messages/" + id).set({ thread, by: "human", text: m.text, at: m.at });
  }
  async function createThread(ref: string, from: number, to: number, quote: string, firstMessage: string): Promise<string | null> {
    if (!db) return null;
    const id = newId();
    const t: ThreadDoc = { id, kind: "anchor", unit: unitId()!, ref, from, to, quote, resolved: false, createdBy: "human", createdAt: now() };
    setLive(s => { s.threads[id] = t; });
    const { id: _omit, ...data } = t;
    await db.doc("threads/" + id).set(data);
    await sendMessage(id, firstMessage);
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
    platform, manifest, unitId, bundle, lexIndex, loadError, dbState, live, saveErrors,
    loadStatic, openUnit, subscribe, currentText, saveText, setFinalized, statusOf, reviewOf, problemsOf,
    threadsForUnit, messagesOf, awaitingClaude, sendMessage, createThread, setResolved, moveAnchor,
  };
}
export type AppState = ReturnType<typeof createAppState>;
