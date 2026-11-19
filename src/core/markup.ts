// HTML <-> editable text with locked tokens.
//
// Simple formatting tags (by default <em> and <b> with no attributes) become
// markdown markers the translator edits as text: _italic_, **bold**.
// Every other element becomes one locked token, written ⟦n⟧ in the text and
// restored to its exact original HTML on the way back.
// Text is HTML-unescaped for editing and re-escaped on the way back.

import type { EditableText, Token } from "./formats";

export interface MarkupRules {
  /** tag name -> marker, applied only to elements with no attributes */
  markers: Record<string, string>;
  /** classify a token for styling / labelling */
  classify?: (tag: string, attrs: string, html: string) => { kind: string; label?: string };
}

export const DEFAULT_RULES: MarkupRules = { markers: { em: "_", b: "**" } };

export const TOKEN_OPEN = "⟦";
export const TOKEN_CLOSE = "⟧";
export const TOKEN_RE = /⟦(\d+)⟧/g;

const VOID = new Set(["br", "img", "hr", "wbr", "input", "meta", "link", "col", "area", "source"]);

interface TextNode { type: "text"; raw: string }
interface ElNode { type: "el"; tag: string; attrs: string; start: number; end: number; children: Node[] }
type Node = TextNode | ElNode;

const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;

/** Parse an HTML fragment into a shallow tree, keeping source offsets. */
export function parseFragment(html: string): Node[] {
  const root: ElNode = { type: "el", tag: "#root", attrs: "", start: 0, end: html.length, children: [] };
  const stack: ElNode[] = [root];
  let last = 0;
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(html))) {
    const top = stack[stack.length - 1];
    if (m.index > last) top.children.push({ type: "text", raw: html.slice(last, m.index) });
    last = TAG_RE.lastIndex;
    const [whole, close, tagRaw, attrs, selfClose] = m;
    const tag = tagRaw.toLowerCase();
    if (close) {
      // pop to the matching open element
      let i = stack.length - 1;
      while (i > 0 && stack[i].tag !== tag) i--;
      if (i === 0) throw new Error(`unmatched </${tag}> at ${m.index}`);
      while (stack.length > i) {
        const el = stack.pop()!;
        el.end = m.index + whole.length;
      }
      continue;
    }
    const el: ElNode = { type: "el", tag, attrs: attrs.trim(), start: m.index, end: m.index + whole.length, children: [] };
    top.children.push(el);
    if (!selfClose && !VOID.has(tag)) stack.push(el);
  }
  if (last < html.length) stack[stack.length - 1].children.push({ type: "text", raw: html.slice(last) });
  if (stack.length > 1) throw new Error(`unclosed <${stack[stack.length - 1].tag}>`);
  return root.children;
}

const ENT: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };
const unescape = (s: string) => s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, e => ENT[e]);
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function stripTags(html: string) {
  return unescape(html.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

function defaultClassify(tag: string, attrs: string, html: string): { kind: string; label?: string } {
  if (tag === "img") return { kind: "img", label: "image" };
  if (tag === "br") return { kind: "br", label: "↵" };
  if (tag === "table") return { kind: "table", label: "table" };
  if (/dir="rtl"/.test(attrs)) return { kind: "he" };
  return { kind: tag };
}

export function toEditable(html: string, rules: MarkupRules = DEFAULT_RULES): EditableText {
  const tokens: Token[] = [];
  const classify = rules.classify ?? defaultClassify;
  let text = "";
  const walk = (nodes: Node[]) => {
    for (const n of nodes) {
      if (n.type === "text") {
        if (/[⟦⟧]/.test(n.raw)) throw new Error("source text contains token brackets ⟦⟧");
        for (const mk of Object.values(rules.markers)) if (n.raw.includes(mk)) throw new Error(`source text contains marker "${mk}"`);
        text += unescape(n.raw);
        continue;
      }
      const marker = rules.markers[n.tag];
      if (marker && !n.attrs) {
        text += marker;
        walk(n.children);
        text += marker;
        continue;
      }
      const tokHtml = html.slice(n.start, n.end);
      const c = classify(n.tag, n.attrs, tokHtml);
      let label = c.label ?? stripTags(tokHtml);
      if (!label) label = n.tag;
      if (label.length > 60) label = label.slice(0, 57) + "…";
      tokens.push({ id: tokens.length, html: tokHtml, label, kind: c.kind });
      text += TOKEN_OPEN + (tokens.length - 1) + TOKEN_CLOSE;
    }
  };
  walk(parseFragment(html));
  return { text, tokens };
}

export interface MarkupProblem { pos: number; message: string }

/** Convert editable text back to HTML. Throws with a list of problems. */
export function fromEditable(text: string, tokens: Token[], rules: MarkupRules = DEFAULT_RULES): string {
  const r = checkEditable(text, tokens, rules);
  if (r.problems.length) {
    const err = new Error(r.problems.map(p => `@${p.pos}: ${p.message}`).join("; "));
    (err as any).problems = r.problems;
    throw err;
  }
  return r.html;
}

/** Validate editable text and produce HTML; problems are reported, not thrown. */
export function checkEditable(text: string, tokens: Token[], rules: MarkupRules = DEFAULT_RULES): { html: string; problems: MarkupProblem[] } {
  const problems: MarkupProblem[] = [];
  const byId = new Map(tokens.map(t => [t.id, t]));
  // markers sorted longest first so "**" wins over "*"
  const markers = Object.entries(rules.markers).map(([tag, mk]) => ({ tag, mk })).sort((a, b) => b.mk.length - a.mk.length);
  const open: { tag: string; pos: number }[] = [];
  let out = "";
  let buf = "";
  let i = 0;
  const flush = () => { out += escape(buf); buf = ""; };
  outer: while (i < text.length) {
    if (text[i] === TOKEN_OPEN) {
      const m = /^⟦(\d+)⟧/.exec(text.slice(i));
      if (m) {
        const t = byId.get(+m[1]);
        flush();
        if (!t) problems.push({ pos: i, message: `unknown token ${m[0]}` });
        else out += t.html;
        i += m[0].length;
        continue;
      }
      problems.push({ pos: i, message: "stray ⟦" });
    }
    for (const { tag, mk } of markers) {
      if (text.startsWith(mk, i)) {
        flush();
        const top = open[open.length - 1];
        if (top && top.tag === tag) { open.pop(); out += `</${tag}>`; }
        else if (open.some(o => o.tag === tag)) {
          problems.push({ pos: i, message: `"${mk}" closes across another marker` });
          out += `</${tag}>`;
        } else { open.push({ tag, pos: i }); out += `<${tag}>`; }
        i += mk.length;
        continue outer;
      }
    }
    buf += text[i++];
  }
  flush();
  for (const o of open) problems.push({ pos: o.pos, message: `unclosed "${rules.markers[o.tag]}"` });
  return { html: out, problems };
}
