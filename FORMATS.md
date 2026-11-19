# Neutral formats

The app never reads a project's own files. An adapter converts them into these shapes; the TypeScript definitions are in `src/core/formats.ts`.

## Manifest: `data/manifest.json`
```json
{ "schema": "ctw.manifest/1", "project": "pardes-rimmonim", "title": "Pardes Rimmonim",
  "units": [{ "id": "1:1", "title": "Gate 1, Chapter 1 · Ten and Not Nine", "file": "units/1-1.json", "segments": 11 }],
  "lexicon": "lexicon.json" }
```

## Chapter bundle: `data/units/<id>.json`
```json
{ "schema": "ctw.chapter/1", "unitId": "1:1", "title": "…", "subtitle": "…",
  "sourceDir": "rtl", "sourceLang": "he", "targetLang": "en",
  "segments": [{
    "ref": "1:1:3",
    "source": "plain source text",
    "target": { "text": "_italic_, **bold**, ⟦0⟧ token", "tokens": [{ "id": 0, "html": "<span dir=\"rtl\" lang=\"he\">…</span>", "label": "…", "kind": "he" }] },
    "baseHash": "16 hex chars of sha256(original target HTML)",
    "lexHits": [{ "key": "lexicon entry key", "form": "source form found in this segment" }]
  }] }
```
- **Markup:** each adapter passes its `MarkupRules` to `toEditable`. These say which tags become markers and how tokens are labelled. Everything not turned into a marker becomes a locked token holding its exact original HTML.
- **`lexHits`:** project-specific matching, done once at export. It ranks lookup results and shows "in this paragraph's Hebrew".

## Lexicon bundle: `data/lexicon.json`
```json
{ "schema": "ctw.lexicon/1", "entries": [{
  "key": "…", "headword": "…", "transliteration": "…", "pos": "…", "rendering": "agreed English",
  "candidates": [{ "target": "…", "status": "preferred|acceptable|rejected", "gloss": "…", "notes": "…" }],
  "forms": [{ "form": "source form", "rendering": "English for that form" }],
  "note": "reader note", "etymology": "…",
  "lookupTerms": ["English strings that should find this entry"] }] }
```
The app normalises the `lookupTerms`: lower case, leading articles and "to" removed, and the last word singularised. It then matches phrases of up to six words around the clicked word, longest first.

## Edits, for write-back
```json
{ "edits": [{ "ref": "1:1:3", "text": "editable text", "baseHash": "…", "rev": 4 }] }
```
The adapter's `applyEdits` refuses any segment whose current project text no longer matches `baseHash`. That segment is reported as a conflict.

## Writing an adapter for a new project
Implement `ProjectAdapter` in `src/adapters/<name>.ts`, register it in `tools/ctw.ts`, and check `roundtrip` against the project's corpus. The app, the database layout and the review workflow don't change.
