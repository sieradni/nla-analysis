# 0011 — One importer, two doors

**Status**: accepted (2026-10-19)

**Context.** `bench import` had all the rules — which format, which column maps to which field, when a
row is refused, that the original file is kept as evidence — and the window had no way to use them.
The obvious shortcut was a second importer in the renderer: read the file with `FileReader`, coerce in
JavaScript, send points over IPC. That would have put the validation rules in a place with no tests, in
a language the rest of the core is not written in, and given the two doors different ideas of what a
refusal is. The window is a viewport onto the log, not a second writer (ADR 0003, ADR 0006).

**Decision.** `src/core/import.ts` holds the whole import path, and both doors are wrappers over it.

- `readTable` / `previewImport` answer questions: the columns, a sample as strings, the rows and
  comment lines the parser skipped, the shape's fields, the columns whose names already match them,
  and whether these exact bytes were imported before. Nothing is written.
- `planImport` parses, maps and validates **every** row and returns the plan, or throws naming the
  rows and fields that would not land. Nothing is written.
- `commitImport` is the only writer: the original is copied into `data/raw/` first, then the points and
  the `import_completed` record are appended together.

The window opens a sheet on the preview, one row per shape field with the column choices, and calls
the same `planImport` and `commitImport` the CLI calls. A bad row or an unmappable column is refused
before the first event, so a half-imported file cannot exist. `bench import` keeps its `--map` flags
and now shares the code; `src/cli/import.ts` is its thin command door, and
`src/core/import-columns.ts` owns the mapping and undeclared-column policy both doors use.

**Consequences.**

- A rule about importing changes once, and both doors get it. The CLI tests and the window's capture
  frame are evidence about the same function.
- The window's sheet needs the file's columns and a sample before a mapping exists, which is why
  reading (`readTable`) is separated from planning (`planImport`).
- The window must send a file path, not file contents: the source file stays the evidence, and the
  byte-for-byte copy is what `data/raw/` receives. A future drag-and-drop from outside the filesystem
  would need a real decision about where the bytes live first.
- Types are the core's (`number`, `integer`, `boolean`, `string`); the sheet offers the columns, never
  a type, so the two doors cannot disagree about coercion.

**Not decided here.** Dataset versions (`bench import --version`, a second dataset) and shape editing
after init are untouched: an import still lands in the active dataset under the shape the project
declared.
