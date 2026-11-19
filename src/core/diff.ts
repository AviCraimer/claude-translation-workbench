// Word-level diff (LCS) for showing a rewrite against the original.
export type DiffPart = { op: "same" | "ins" | "del"; text: string };

export function wordDiff(a: string, b: string, maxTokens = 4000): DiffPart[] | null {
  const ta = a.match(/\s+|[^\s]+/g) ?? [], tb = b.match(/\s+|[^\s]+/g) ?? [];
  if (ta.length > maxTokens || tb.length > maxTokens) return null;
  const n = ta.length, m = tb.length;
  const L: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    L[i][j] = ta[i] === tb[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: DiffPart[] = [];
  const push = (op: DiffPart["op"], text: string) => {
    const last = out[out.length - 1];
    if (last && last.op === op) last.text += text; else out.push({ op, text });
  };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (ta[i] === tb[j]) { push("same", ta[i]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) push("del", ta[i++]);
    else push("ins", tb[j++]);
  }
  while (i < n) push("del", ta[i++]);
  while (j < m) push("ins", tb[j++]);
  return out;
}
