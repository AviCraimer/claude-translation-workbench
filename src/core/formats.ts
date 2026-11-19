// Neutral formats shared by the app and every project adapter.
// The app reads only these shapes; adapters convert a project's own files to
// and from them. See FORMATS.md for the prose description.

/** A locked piece of markup inside editable text, shown as a chip. */
export interface Token {
  id: number; // referenced in text as ⟦id⟧
  html: string; // exact original HTML, restored on write-back
  label: string; // short display text for the chip
  kind: string; // "he", "img", "br", "table", "span", ... (styling hint)
}

/** Target text as the editor sees it: markdown-ish text plus locked tokens. */
export interface EditableText {
  text: string; // _italic_, **bold**, ⟦n⟧ token placeholders
  tokens: Token[];
}

export interface LexHit {
  key: string; // lexicon entry key
  form: string; // the source-language form that matched
}

/** The translator's approval of a segment, as the project records it (optional). */
export interface Approval {
  approvedAt?: string;
  current: boolean; // the project text still equals what was approved
  approvedText?: EditableText; // when !current: the approved version, for showing what changed
  changedBy?: { sha: string; date: string; subject: string }[]; // commits that changed it since
}

export interface Segment {
  ref: string; // project reference, e.g. "1:1:3"
  source: string; // plain source text (no markup)
  target: EditableText;
  baseHash: string; // fingerprint of the target HTML as exported
  lexHits: LexHit[]; // lexicon entries occurring in the source
  approval?: Approval; // present once the translator has approved this segment
}

export interface ChapterBundle {
  schema: "ctw.chapter/1";
  project: string;
  unitId: string; // e.g. "1:1"
  title: string; // e.g. "Gate 1, Chapter 1"
  subtitle?: string; // e.g. the chapter's contents line
  sourceDir: "rtl" | "ltr";
  sourceLang: string;
  targetLang: string;
  segments: Segment[];
}

export interface LexCandidate {
  target: string;
  status: string; // "preferred" | "acceptable" | "rejected" | ...
  gloss?: string;
  notes?: string;
}

export interface LexEntry {
  key: string;
  headword: string;
  transliteration?: string;
  pos?: string;
  rendering: string; // the agreed English
  candidates: LexCandidate[];
  forms: { form: string; rendering?: string }[]; // source forms and per-form renderings
  note?: string; // reader-facing note
  etymology?: string;
  lookupTerms: string[]; // target-language strings that should find this entry
}

export interface LexiconBundle {
  schema: "ctw.lexicon/1";
  project: string;
  entries: LexEntry[];
}

export interface UnitInfo {
  id: string;
  title: string;
  segments: number;
}

/** data/manifest.json in the published artifact. */
export interface Manifest {
  schema: "ctw.manifest/1";
  project: string;
  title: string;
  units: { id: string; title: string; file: string; segments: number }[];
  lexicon?: string; // path of the LexiconBundle
}

/** What Claude exports from the database for write-back. */
export interface EditRecord {
  ref: string;
  text: string;
  baseHash: string;
  rev: number;
}

export interface ApplyReport {
  applied: string[]; // approved (text written if it changed, approval recorded either way)
  changed?: string[]; // the subset whose text changed
  conflicts: { ref: string; reason: string }[];
  errors: { ref: string; reason: string }[];
}

/** A project adapter: the only project-specific code. */
export interface ProjectAdapter {
  project: string;
  title: string;
  units(): UnitInfo[];
  exportUnit(id: string): ChapterBundle;
  exportLexicon(): LexiconBundle;
  applyEdits(edits: EditRecord[], opts?: { dryRun?: boolean }): ApplyReport;
}
