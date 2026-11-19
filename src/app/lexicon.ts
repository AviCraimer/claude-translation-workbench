// English -> lexicon entry lookup, built from each entry's lookupTerms.

import type { LexEntry, LexiconBundle, LexHit } from "../core/formats";

const ARTICLES = /^(the|a|an|to|its|his|her|their)\s+/;

export function normalize(s: string): string {
  let t = s.toLowerCase().replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}' -]+/gu, " ").replace(/\s+/g, " ").trim();
  for (let i = 0; i < 2; i++) t = t.replace(ARTICLES, "");
  return t;
}

export function stem(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 4 && /(s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}
const stemPhrase = (p: string) => { const ws = p.split(" "); ws[ws.length - 1] = stem(ws[ws.length - 1]); return ws.join(" "); };

export interface LexIndex {
  entries: Map<string, LexEntry>;
  byTerm: Map<string, Set<string>>;
  maxWords: number;
}

export function buildIndex(b: LexiconBundle): LexIndex {
  const entries = new Map(b.entries.map(e => [e.key, e]));
  const byTerm = new Map<string, Set<string>>();
  let maxWords = 1;
  const add = (t: string, key: string) => {
    if (!t) return;
    (byTerm.get(t) ?? byTerm.set(t, new Set()).get(t)!).add(key);
    maxWords = Math.max(maxWords, t.split(" ").length);
  };
  for (const e of b.entries) for (const raw of e.lookupTerms) {
    const n = normalize(raw);
    if (n.length < 2) continue;
    add(n, e.key); add(stemPhrase(n), e.key);
  }
  return { entries, byTerm, maxWords: Math.min(maxWords, 6) };
}

const WORD_RE = /[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)*/gu;

export interface LookupResult {
  query: string; // the word or phrase that matched (or the word clicked)
  keys: string[]; // matching entry keys, best first
}

/** Find entries for the word at `pos` in `text`, preferring the longest phrase. */
export function lookupAt(idx: LexIndex, text: string, pos: number, hits: LexHit[]): LookupResult | null {
  const words: { w: string; from: number; to: number }[] = [];
  for (const m of text.matchAll(WORD_RE)) words.push({ w: m[0], from: m.index!, to: m.index! + m[0].length });
  let i = words.findIndex(w => pos >= w.from && pos <= w.to);
  if (i < 0) return null;
  const inHebrew = new Set(hits.map(h => h.key));
  for (let n = idx.maxWords; n >= 1; n--) {
    const found: { q: string; keys: string[] }[] = [];
    for (let s = Math.max(0, i - n + 1); s <= i && s + n <= words.length; s++) {
      const phrase = words.slice(s, s + n).map(w => w.w).join(" ");
      const norm = normalize(phrase);
      const set = idx.byTerm.get(norm) ?? idx.byTerm.get(stemPhrase(norm));
      if (set) found.push({ q: phrase, keys: [...set] });
    }
    if (found.length) {
      const keys = [...new Set(found.flatMap(f => f.keys))];
      keys.sort((a, b) => Number(inHebrew.has(b)) - Number(inHebrew.has(a)));
      return { query: found[0].q, keys };
    }
  }
  return { query: words[i].w, keys: [] };
}
