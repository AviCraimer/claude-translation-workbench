// Minimal in-memory stand-in for the artifact `db` capability (local dev only).
// Supports doc get/set/update/delete/onSnapshot and collection onSnapshot/get/add.

import type { Db, DocRef, CollectionRef, DocSnap, QuerySnap, Query } from "./platform";

export function createMockDb(seed?: Record<string, any>): Db {
  const docs = new Map<string, any>(Object.entries(seed ?? {}));
  const listeners = new Set<() => void>();
  const notify = () => queueMicrotask(() => listeners.forEach(l => l()));
  const snap = (path: string): DocSnap => {
    const d = docs.get(path);
    const id = path.split("/").pop()!;
    return { id, exists: d !== undefined, data: () => (d === undefined ? undefined : Object.freeze(structuredClone(d))) };
  };
  const docRef = (path: string): DocRef => ({
    id: path.split("/").pop()!, path,
    get: async () => snap(path),
    set: async d => { docs.set(path, structuredClone(d)); notify(); },
    update: async d => {
      if (!docs.has(path)) throw { code: "invalid_argument", message: "missing" };
      docs.set(path, { ...docs.get(path), ...structuredClone(d) }); notify();
    },
    delete: async () => { docs.delete(path); notify(); },
    onSnapshot(next) { const l = () => next(snap(path)); listeners.add(l); queueMicrotask(l); return () => listeners.delete(l); },
  });
  const query = (coll: string, filters: [string, string, unknown][] = [], order?: [string, string], lim?: number): Query => {
    const run = (): QuerySnap => {
      let out = [...docs.keys()].filter(k => k.startsWith(coll + "/") && k.split("/").length === coll.split("/").length + 1).map(snap);
      for (const [f, op, v] of filters) out = out.filter(s => { const x = s.data()[f]; return op === "==" ? x === v : op === "!=" ? x !== v : op === ">" ? x > (v as any) : op === "<" ? x < (v as any) : true; });
      if (order) out.sort((a, b) => (a.data()[order[0]] > b.data()[order[0]] ? 1 : -1) * (order[1] === "desc" ? -1 : 1));
      if (lim) out = out.slice(0, lim);
      return { docs: out };
    };
    return {
      where: (f, op, v) => query(coll, [...filters, [f, op, v]], order, lim),
      orderBy: (f, dir = "asc") => query(coll, filters, [f, dir], lim),
      limit: n => query(coll, filters, order, n),
      get: async () => run(),
      onSnapshot(next) { const l = () => next(run()); listeners.add(l); queueMicrotask(l); return () => listeners.delete(l); },
    };
  };
  const collRef = (path: string): CollectionRef => Object.assign(query(path), {
    path,
    doc: (id?: string) => docRef(path + "/" + (id ?? Math.random().toString(36).slice(2, 12))),
  });
  const db: Db = { doc: docRef, collection: collRef };
  (window as any).__mockdb = { docs, db };
  return db;
}
