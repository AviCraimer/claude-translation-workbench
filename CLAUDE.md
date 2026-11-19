# Claude Translation Workbench

A desktop editor (a Claude artifact) where Avi revises draft translations by hand and Claude reviews the revisions. Avi edits; Claude never changes his text. Claude answers in comment threads and records reviews in the artifact's database.

- **Left column:** lexicon entries Avi pins with Ctrl+click or Ctrl+D, newest at the bottom.
- **Centre column:** one CodeMirror editor per segment. Markup becomes `_italic_`, `**bold**` and locked `⟦n⟧` tokens.
- **Right column:** the General chat, plus comment threads anchored to passages.

Stack: Solid 2.0 and CodeMirror 6, built with Vite into `dist/` and published as a multi-file artifact. Before changing app code, read `node_modules/solid-js/skills/solid-2.0/SKILL.md`. The 2.0 API is not 1.x.

## Projects

| Project | Artifact | Project repo | Adapter |
|---|---|---|---|
| Pardes Rimmonim | slug `f83c8c18-5724-4998-b997-943063db97e6` (https://claude.ai/artifact/XetiENXMYMuF1n9kzwTKt1) | AviCraimer/Pardes_Rimmonim_Reader | `src/adapters/pardes.ts` |

Each project has its own artifact, and so its own database.

## Layout

- `src/core/formats.ts`: the neutral formats, described in `FORMATS.md`. The app reads only these.
- `src/core/markup.ts`: HTML ⇄ editable text with locked tokens. It must round-trip exactly; check with `npx tsx tools/ctw.ts roundtrip`.
- `src/adapters/<project>.ts`: the only project-specific code. It implements `ProjectAdapter`: `units`, `exportUnit`, `exportLexicon` and `applyEdits`.
- `tools/ctw.ts`: the CLI, `npx tsx tools/ctw.ts <cmd> --repo <project clone> [--adapter pardes]`.
- `src/app/`: the artifact page.
- `artifact-data/`: generated data (manifest, lexicon, units). It is not committed; regenerate it from the project repo.

## Database layout (artifact `db`)

`<key>` is the segment ref with `:` replaced by `.`, e.g. `edits/1.1.3`.

| Path | Written by | Fields |
|---|---|---|
| `edits/<key>` | page only | `ref, unit, text, baseHash, rev, finalized, finalizedRev, updatedAt` |
| `reviews/<key>` | Claude | `ref, rev, verdict ("ok" or "issues"), summary, at` |
| `commits/<key>` | Claude | `ref, rev, sha, at` |
| `threads/<id>` | page or Claude | `kind: "anchor", unit, ref, from, to, quote, resolved, createdBy, createdAt` |
| `messages/<id>` | page or Claude | `thread, by ("human" or "claude"), text, at` (ISO time) |

The General chat is thread id `general`, and it has no thread document. A review counts only while `review.rev == edit.rev`, and a commit only while `commit.rev == edit.rev`. A thread is waiting for Claude when its last message has `by: "human"`.

**Never write `edits/*`.** That is Avi's text. Claude writes reviews, commits, messages, and threads that Claude starts.

## Procedures

### Load a chapter (or reload one after commits)
1. Clone or pull the project repo.
2. Run `npx tsx tools/ctw.ts export-unit G:C [G:C ...] --repo <clone>`. Run `export-lexicon` as well if the lexicon changed.
3. Call `list_files` on the artifact. Then `publish_files` (patch mode) with `data/units/G-C.json`, `data/manifest.json`, and `data/lexicon.json` if it changed. No app rebuild is needed.
4. A republish reloads open views, so tell Avi.

### Update the app
Run `npm run build`. Then `publish_files` with `dist/index.html` and the new `dist/assets/*`, and pass the old hashed asset names in `remove`.

### Wakes from the page
The page wakes the session that published the artifact by posting an artifact comment (`comments.sendToClaude`). It arrives as an `[Artifact comment sent to Claude]` turn. There are two kinds:
- **`Workbench chat: new message in … (message <id>)`**: answer only that message. Read `messages` (and the thread document if it names one), write one `messages/<id>` reply from Claude, and run no review.
- **`Workbench review: …`**: run the full review below.

The artifact comment tools can't see these relay threads ("not found"). Answer in the workbench, and put one short line in the session.

### "Check the workbench" (review)
1. `db_list` the `edits`, `reviews`, `threads` and `messages` collections.
2. Pending review means an edit whose text differs from the bundle text and has no review with the same `rev`. Waiting means a thread whose last message is human (include `general`).
3. For each pending edit:
   - Read the Hebrew (`python3 tools/show_paragraphs.py G:C:P --he` in the project repo) and the relevant lexicon entries (`tools/lexicon_digest.py --entry KEY`).
   - Check the rewrite for accuracy against the Hebrew, for consistency with the lexicon rulings and `TRANSLATION_CONVENTIONS.md`, and for broken markup.
   - Write `reviews/<key>` with the edit's current `rev`.
   - For each specific problem, create a thread on the passage: compute `from`/`to` with `indexOf(quote)` in the edit text, `createdBy: "claude"`, and add a first message from Claude. Don't rewrite the passage yourself; describe the problem and suggest wording.
4. Answer every waiting thread with a `messages/<id>` doc.
5. Report briefly in the chat.

`db_write` takes at most 50 ops per call and needs `ifVersion` for documents that already exist.

### Commit finalized paragraphs
1. Attach the project repo with push access.
2. Collect the edits where `finalized && finalizedRev == rev` and no commit has the same `rev`. Write `{"edits":[{ref,text,baseHash,rev}]}` to a file.
3. Run `npx tsx tools/ctw.ts apply-edits FILE --repo <clone> --dry-run`, then again without `--dry-run`. A conflict means the repo paragraph changed since export; tell Avi in a thread and don't force it.
4. Run the project's checks, then commit and push following the project repo's CLAUDE.md (for Pardes: `git pull --rebase` before pushing).
5. Write `commits/<key>` with `rev` and the commit `sha`.
6. Re-export and republish the unit, so that later edits start from the committed text.

## Known pitfalls
- Snapshot data from `db` is frozen. Clone it (`structuredClone`) before mutating.
- In Solid 2.0, signal reads lag writes until the next microtask. Pass values along instead of re-reading a signal you just set.
- `room.sendToClaudeSession` needs a chat open beside the artifact, and it failed on mobile. Wakes use `comments.sendToClaude` instead (see "Wakes from the page"), which reaches only the session that published the artifact. If a different chat takes over, it should republish the artifact so that wakes reach it.
