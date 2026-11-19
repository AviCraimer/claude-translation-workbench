// Access to the artifact runtime (claude.use), with an in-memory fallback so
// the app runs locally for development and screenshots.

import { createMockDb } from "./mockdb";

export interface DocSnap { id: string; exists: boolean; data(): any }
export interface QuerySnap { docs: DocSnap[] }
export interface DocRef {
  id: string; path: string;
  get(): Promise<DocSnap>;
  set(d: Record<string, unknown>): Promise<void>;
  update(d: Record<string, unknown>): Promise<void>;
  delete(): Promise<void>;
  onSnapshot(next: (s: DocSnap) => void, err?: (e: any) => void): () => void;
}
export interface Query {
  where(f: string, op: string, v: unknown): Query;
  orderBy(f: string, dir?: "asc" | "desc"): Query;
  limit(n: number): Query;
  get(): Promise<QuerySnap>;
  onSnapshot(next: (s: QuerySnap) => void, err?: (e: any) => void): () => void;
}
export interface CollectionRef extends Query { path: string; doc(id?: string): DocRef }
export interface Db { doc(p: string): DocRef; collection(p: string): CollectionRef }

export interface Platform {
  mode: "artifact" | "local";
  db: Db | null;
  user: any | null;
  comments: any | null;
}

declare global { interface Window { claude?: { use(name: string): Promise<any> } } }

export async function connect(): Promise<Platform> {
  const c = window.claude;
  if (!c || typeof c.use !== "function") {
    return { mode: "local", db: createMockDb((window as any).__CTW_SEED), user: null, comments: null };
  }
  const [db, user, comments] = await Promise.all(["db", "user", "comments"].map(n => c.use(n).catch(() => null)));
  return { mode: "artifact", db, user, comments };
}
