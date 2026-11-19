# Claude Translation Workbench

A desktop editor for human revision of draft translations, with Claude reviewing the edits. It runs as a Claude artifact backed by the artifact database.

- **Left column:** lexicon entries, pinned with Ctrl+click or Ctrl+D.
- **Centre column:** the segment editor, with locked markup tokens.
- **Right column:** a general chat with Claude, plus threads anchored to passages.

Translation projects plug in through adapters that convert their own files into a neutral chapter, lexicon and edits format. The first adapter is for the Pardes Rimmonim Reader.

Status: v1, with Pardes Rimmonim Gate 1, Chapter 1 loaded. `CLAUDE.md` has the workflow and `FORMATS.md` the data formats.
