// Workbench CLI. Run with: npx tsx tools/ctw.ts <command> [...]
//
//   units                          list the project's units
//   export-unit <id>               write data/units/<id>.json and update data/manifest.json
//   export-lexicon                 write data/lexicon.json
//   apply-edits <edits.json> [--dry-run]   write finalized edits back into the project
//   roundtrip                      check HTML -> editable -> HTML on every target paragraph
//
// Options: --adapter pardes (default) --repo <path> --data <dir> (default ./artifact-data)

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Manifest, EditRecord, ProjectAdapter } from "../src/core/formats";
import { toEditable, fromEditable } from "../src/core/markup";
import { createPardesAdapter, allTargetHtml, PARDES_RULES } from "../src/adapters/pardes";

const args = process.argv.slice(2);
const opt = (name: string, dflt?: string) => { const i = args.indexOf("--" + name); return i >= 0 ? args.splice(i, 2)[1] : dflt; };
const flag = (name: string) => { const i = args.indexOf("--" + name); if (i >= 0) { args.splice(i, 1); return true; } return false; };

const adapterName = opt("adapter", "pardes")!;
const repo = resolve(opt("repo", process.env.CTW_REPO || "/home/claude/avicraimer/pardes_rimmonim_reader")!);
const dataDir = resolve(opt("data", "artifact-data")!);
const dryRun = flag("dry-run");
const [cmd, ...rest] = args;

const ADAPTERS: Record<string, (repo: string) => ProjectAdapter> = { pardes: createPardesAdapter };
const adapter = ADAPTERS[adapterName]?.(repo);
if (!adapter) throw new Error(`unknown adapter ${adapterName}`);

const fileFor = (id: string) => `units/${id.replace(/:/g, "-")}.json`;
function loadManifest(): Manifest {
  const p = join(dataDir, "manifest.json");
  if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  return { schema: "ctw.manifest/1", project: adapter.project, title: adapter.title, units: [] };
}
const saveManifest = (m: Manifest) => writeFileSync(join(dataDir, "manifest.json"), JSON.stringify(m, null, 1));

switch (cmd) {
  case "units":
    for (const u of adapter.units()) console.log(u.id.padEnd(8), String(u.segments).padStart(5), " ", u.title);
    break;
  case "export-unit": {
    mkdirSync(join(dataDir, "units"), { recursive: true });
    const m = loadManifest();
    for (const id of rest) {
      const b = adapter.exportUnit(id);
      const file = fileFor(id);
      writeFileSync(join(dataDir, file), JSON.stringify(b));
      m.units = m.units.filter(u => u.id !== id).concat({ id, title: b.title, file, segments: b.segments.length });
      const tokens = b.segments.reduce((n, s) => n + s.target.tokens.length, 0);
      const hits = b.segments.reduce((n, s) => n + s.lexHits.length, 0);
      console.log(`${id}: ${b.segments.length} segments, ${tokens} tokens, ${hits} lexicon hits -> ${file}`);
    }
    m.units.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    saveManifest(m);
    break;
  }
  case "export-lexicon": {
    mkdirSync(dataDir, { recursive: true });
    const lex = adapter.exportLexicon();
    writeFileSync(join(dataDir, "lexicon.json"), JSON.stringify(lex));
    const m = loadManifest(); m.lexicon = "lexicon.json"; saveManifest(m);
    console.log(`lexicon: ${lex.entries.length} entries, ${lex.entries.reduce((n, e) => n + e.lookupTerms.length, 0)} lookup terms`);
    break;
  }
  case "apply-edits": {
    const edits: EditRecord[] = JSON.parse(readFileSync(rest[0], "utf8")).edits;
    const r = adapter.applyEdits(edits, { dryRun });
    console.log(JSON.stringify(r, null, 1));
    break;
  }
  case "roundtrip": {
    let ok = 0, bad = 0;
    for (const { ref, html } of allTargetHtml(repo)) {
      try {
        const e = toEditable(html, PARDES_RULES);
        const back = fromEditable(e.text, e.tokens, PARDES_RULES);
        if (back === html) ok++; else { bad++; if (bad <= 5) console.log("MISMATCH", ref); }
      } catch (err: any) { bad++; if (bad <= 5) console.log("ERROR", ref, err.message); }
    }
    console.log(`round-trip: ${ok} exact, ${bad} failed`);
    break;
  }
  default:
    console.log("commands: units | export-unit <id...> | export-lexicon | apply-edits <file> [--dry-run] | roundtrip");
}
