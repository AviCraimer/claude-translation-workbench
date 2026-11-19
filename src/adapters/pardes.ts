// Adapter for AviCraimer/Pardes_Rimmonim_Reader.
// Repo layout: translation.json (English, text[g][c][p] HTML),
// Pardes_Rimmonim.json (Hebrew, versions[0].text[g][c][p]),
// lexicon_translation.json + lexicon_reader.json, matcher.js (site matcher).
// Writes go through the repo's own tools/put_paragraphs.py.

import { readFileSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import type { ProjectAdapter, ChapterBundle, LexiconBundle, LexEntry, EditRecord, ApplyReport, UnitInfo, LexHit, Approval } from "../core/formats";
import { toEditable, fromEditable, type MarkupRules } from "../core/markup";
import { fingerprint } from "../core/hash";

const RULES: MarkupRules = {
  markers: { em: "_", b: "**" },
  classify(tag, attrs, html) {
    if (tag === "img") return { kind: "img", label: "image" };
    if (tag === "br") return { kind: "br", label: "↵" };
    if (tag === "table") return { kind: "table", label: "table" };
    if (/gl-entry-title/.test(attrs)) return { kind: "title" };
    if (/dir="rtl"/.test(attrs)) return { kind: "he" };
    return { kind: tag };
  },
};

const plain = (html: string) =>
  html.replace(/<img[^>]*>/g, " ").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

function splitTerms(s: string | undefined): string[] {
  if (!s) return [];
  const out: string[] = [];
  for (const part of s.split(/[;\/,]/)) {
    const t = part.trim();
    if (!t) continue;
    out.push(t);
    const noParen = t.replace(/\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
    if (noParen && noParen !== t) out.push(noParen);
  }
  return out;
}

export function createPardesAdapter(repo: string): ProjectAdapter {
  const read = (f: string) => JSON.parse(readFileSync(join(repo, f), "utf8"));
  let T: any, HE: any, LEX: any, RD: any;
  const load = () => {
    T = read("translation.json");
    HE = read("Pardes_Rimmonim.json");
    LEX = read("lexicon_translation.json");
    RD = read("lexicon_reader.json");
  };
  load();

  // --- form map, same precedence as the site's script.js ---
  function buildMatcher() {
    const FORM_MAP = new Map<string, string>(), RANK = new Map<string, number>();
    const claim = (form: string, key: string, rank: number) => {
      const f = (form || "").trim();
      if (f && rank >= (RANK.get(f) || 0)) { FORM_MAP.set(f, key); RANK.set(f, rank); }
    };
    const readers = RD.entries || {};
    for (const [key, e] of Object.entries<any>(LEX.entries)) {
      const rd = readers[key] || {};
      if (rd.hidden === true) continue;
      const hidden = new Set(rd.hideForms || []);
      const cluster = e.cluster === true;
      if (!cluster) for (const c of e.candidates || []) for (const d of c.decisions || []) {
        if (!d.surfaceForm) continue;
        for (const f of String(d.surfaceForm).split(" / ")) if (f.trim() && !hidden.has(f.trim())) claim(f, key, 1);
      }
      for (const [sf, v] of Object.entries<any>(e.surfaceForms || {})) {
        if (hidden.has(sf)) continue;
        if (cluster && !(v && (v.rendering || v.prefer))) continue;
        claim(sf, key, 2);
      }
    }
    for (const [key, rd] of Object.entries<any>(readers)) {
      if (rd && rd.extraForms && LEX.entries[key]) for (const f of rd.extraForms) claim(f, key, 3);
    }
    const req = createRequire(import.meta.url);
    const { createMatcher } = req(join(repo, "matcher.js"));
    return createMatcher(FORM_MAP, RD.skipTokens || []);
  }

  // Approval state from the repo's own checker (human_revision_status.json)
  const STATUS = join(repo, "human_revision_status.json");
  function approvals(unit: string): Record<string, any> {
    if (!existsSync(join(repo, "tools/revision_check.py")) || !existsSync(STATUS)) return {};
    const out = execFileSync("python3", [join(repo, "tools/revision_check.py"), "--json", "--commits", "--approved-text", "--unit", unit],
      { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    return JSON.parse(out || "{}");
  }
  function toApproval(a: any): Approval | undefined {
    if (!a) return undefined;
    return {
      approvedAt: a.approvedAt, current: !!a.current,
      approvedText: !a.current && a.approvedHtml != null ? toEditable(a.approvedHtml, RULES) : undefined,
      changedBy: a.changedBy?.map((c: any) => ({ sha: c.sha, date: c.date, subject: c.subject })),
    };
  }

  const parseUnit = (id: string) => {
    const [g, c] = id.split(":").map(n => parseInt(n, 10) - 1);
    if (!T.text[g] || !T.text[g][c]) throw new Error(`no unit ${id}`);
    return [g, c];
  };

  return {
    project: "pardes-rimmonim",
    title: "Pardes Rimmonim",

    units(): UnitInfo[] {
      const out: UnitInfo[] = [];
      T.text.forEach((gate: string[][], g: number) => gate.forEach((ch, c) => out.push({
        id: `${g + 1}:${c + 1}`,
        title: `Gate ${g + 1}, Chapter ${c + 1}`,
        segments: ch.length,
      })));
      return out;
    },

    exportUnit(id: string): ChapterBundle {
      const [g, c] = parseUnit(id);
      const { computeRanges } = buildMatcher();
      const en: string[] = T.text[g][c];
      const he: string[] = HE.versions[0].text[g]?.[c] ?? [];
      const gate = T.gates[g] || {};
      const appr = approvals(id);
      return {
        schema: "ctw.chapter/1",
        project: "pardes-rimmonim",
        unitId: id,
        title: `Gate ${g + 1}, Chapter ${c + 1}` + (gate.title ? ` · ${gate.title}` : ""),
        subtitle: plain(gate.chapters?.[c] ?? ""),
        sourceDir: "rtl", sourceLang: "he", targetLang: "en",
        segments: en.map((html, p) => {
          const heHtml = he[p] ?? "";
          const forMatch = heHtml.replace(/<img[^>]*>/g, "").replace(/<[^>]*>/g, "\u0001");
          const seen = new Set<string>(); const lexHits: LexHit[] = [];
          for (const r of computeRanges(forMatch)) {
            const k = r.entryKey + "|" + r.form;
            if (!seen.has(k)) { seen.add(k); lexHits.push({ key: r.entryKey, form: r.form }); }
          }
          const ref = `${g + 1}:${c + 1}:${p + 1}`;
          return { ref, source: plain(heHtml), target: toEditable(html, RULES), baseHash: fingerprint(html), lexHits, approval: toApproval(appr[ref]) };
        }),
      };
    },

    exportLexicon(): LexiconBundle {
      const readers = RD.entries || {};
      const entries: LexEntry[] = [];
      for (const [key, e] of Object.entries<any>(LEX.entries)) {
        // hidden entries are hidden from the reader site, not from the translator: keep them
        const rd = readers[key] || {};
        const forms = Object.entries<any>(e.surfaceForms || {}).map(([form, v]) => ({ form, rendering: v?.rendering || v?.prefer || undefined }));
        const terms = new Set<string>();
        splitTerms(e.rendering).forEach(t => terms.add(t));
        for (const cand of e.candidates || []) if (cand.status !== "rejected") splitTerms(cand.target).forEach(t => terms.add(t));
        for (const f of forms) splitTerms(f.rendering).forEach(t => terms.add(t));
        entries.push({
          key, headword: e.headword ?? key, transliteration: e.transliteration, pos: e.partOfSpeech,
          rendering: e.rendering ?? "",
          candidates: (e.candidates || []).map((cd: any) => ({ target: cd.target, status: cd.status, gloss: cd.gloss, notes: cd.contextNotes })),
          forms, note: rd.note, etymology: rd.etymology,
          lookupTerms: [...terms],
        });
      }
      return { schema: "ctw.lexicon/1", project: "pardes-rimmonim", entries };
    },

    applyEdits(edits: EditRecord[], opts = {}): ApplyReport {
      load(); // always against the current files
      const report: ApplyReport = { applied: [], changed: [], conflicts: [], errors: [] };
      const out: Record<string, string> = {};
      const approved: Record<string, { approvedHash: string; approvedAt: string; workbenchRev: number }> = {};
      const now = new Date().toISOString();
      for (const ed of edits) {
        try {
          const [g, c, p] = ed.ref.split(":").map(n => parseInt(n, 10) - 1);
          const cur: string | undefined = T.text[g]?.[c]?.[p];
          if (cur === undefined) { report.errors.push({ ref: ed.ref, reason: "no such paragraph" }); continue; }
          if (fingerprint(cur) !== ed.baseHash) { report.conflicts.push({ ref: ed.ref, reason: "repo paragraph changed since export" }); continue; }
          const html = fromEditable(ed.text, toEditable(cur, RULES).tokens, RULES);
          if (html !== cur) { out[ed.ref] = html; report.changed!.push(ed.ref); }
          approved[ed.ref] = { approvedHash: fingerprint(html), approvedAt: now, workbenchRev: ed.rev };
          report.applied.push(ed.ref);
        } catch (err: any) {
          report.errors.push({ ref: ed.ref, reason: String(err.message || err) });
        }
      }
      if (!opts.dryRun) {
        if (Object.keys(out).length) {
          const f = join(mkdtempSync(join(tmpdir(), "ctw-")), "edits.json");
          writeFileSync(f, JSON.stringify(out), "utf8");
          execFileSync("python3", [join(repo, "tools/put_paragraphs.py"), f, "--force"], { stdio: "inherit" });
        }
        if (Object.keys(approved).length) {
          const st = existsSync(STATUS) ? JSON.parse(readFileSync(STATUS, "utf8")) : { paragraphs: {} };
          st.paragraphs = { ...(st.paragraphs || {}), ...approved };
          const key = (r: string) => r.split(":").map(n => n.padStart(5, "0")).join(":");
          st.paragraphs = Object.fromEntries(Object.entries(st.paragraphs).sort(([a], [b]) => key(a).localeCompare(key(b))));
          writeFileSync(STATUS, JSON.stringify(st, null, 1) + "\n", "utf8");
        }
      }
      return report;
    },
  };
}

/** For round-trip tests: every target paragraph's HTML. */
export function allTargetHtml(repo: string): { ref: string; html: string }[] {
  const T = JSON.parse(readFileSync(join(repo, "translation.json"), "utf8"));
  const out: { ref: string; html: string }[] = [];
  T.text.forEach((gate: string[][], g: number) => gate.forEach((ch, c) => ch.forEach((html, p) => out.push({ ref: `${g + 1}:${c + 1}:${p + 1}`, html }))));
  (T.introduction || []).forEach((html: string, i: number) => out.push({ ref: `intro:${i + 1}`, html }));
  return out;
}
export { RULES as PARDES_RULES };
