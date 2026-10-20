# 0012 — Dataset versions are a fold, and a row is its instant

**Status**: accepted (2026-10-19)

**Context.** Non-negotiable #3 says never delete a dataset version, and `dataset_version_created` has
been a valid log type since the first slice with nothing emitting it. The workflow that needs it is the
one that happens every week of an instrument's life: the export went out, a reading was transcribed
wrong or a row was dropped, and the corrected file comes back. Importing it into a dataset that already
holds points could have appended the file as more points — the old and the corrected reading sitting
side by side, indistinguishable, in one growing blur. That is the failure this exists to prevent.

The requirements (§3.4) are explicit: an import into a populated dataset is a **new version with a
diff**, and nothing about the old version is mutated. Requirements §3.5 adds the second half: once
versions exist, a panel's and a run's pin is `(dataset, version)`, not only a content hash, so "what did
last week's conclusion rest on" is a thing you can read rather than a hash you can only compare.

Two questions were not settled by the requirements, and both are irreversible once logs are written in
their shape.

**Decisions.**

1. **A version is not a snapshot; it is a fold.** `dataset_version_created` names the version, its
   source file (preserved under `data/raw/`), its hash, its row count, its parent, and its diff. Every
   `point_recorded`, `point_corrected` and `point_retracted` carries a `version`. `foldVersion` replays
   the log up to a cut, so version 1 still reads as it read — including a row a later import corrected
   or withdrew — without a second copy of the data on disk. The log stays the only truth and a version
   is a question you ask of it.
2. **A row is identified by its observation time; within one instant, by its values.** A re-export
   preserves *when* each reading happened, not its values (those are what got corrected) nor its
   position (a sorted export can be reordered). So the diff groups both sides by `t_observed` and then
   matches one-to-one on equal values: equal is unchanged, same instant with different values is `~`
   (a `point_corrected` against the parent's row), only-new is `+`, only-in-parent is `−` (a
   `point_retracted`, so the parent keeps it). A gap filled in counts as a change; calling it unchanged
   is how a diff lies.
3. **An inferred version 1 is written down before it is replaced.** A project that predates version
   records — or a dataset built by hand typing — holds one version, and the binder infers it. When an
   import replaces it, the commit appends a `dataset_version_created` for the parent first, with the row
   count the diff was computed against, so the chain has a readable first link instead of starting
   mid-story.
4. **`bench import` and the window's sheet are the same plan.** `planImport` computes the version, the
   parent and the diff and writes nothing; the sheet shows `version 4 replaces version 3 · +1 −2 ~1`
   before the button is pressed, from the same function the commit runs. One importer, two doors
   (ADR 0011), now with the version as part of what it says.
5. **A row's time is required, not invented.** If no header matches a known time name and the door
   was not told which column holds it, `planImport` refuses. It names the file's columns and says
   how to pick one: `--time <column>` in the CLI, the sheet's time picker in the window. This is
   deliberately not a warning plus a fallback to "now": rows stamped with one invented instant
   cannot be told apart, so a re-import would report every parent row leaving and every replacement
   arriving — a diff about nothing, on the path whose whole purpose is a diff you can trust. The
   same refusal applies to a dataset's first version, because an untimed version 1 would poison
   every comparison made against it later.

**Consequences.**

- Re-importing a corrected export appends a version record, the added rows, the corrections and the
  retractions in one append; the parent's rows are untouched and `bench dataset diff <id> 1 2` rebuilds
  both sides from the log and prints what moved.
- `bench dataset diff` recomputes the counts from both versions' rows and compares them to what the
  writer recorded, reporting a disagreement rather than repeating the claim.
- A run recorded before this change has no `version` and reads as before (hash-only freshness); a new
  run records one, and `bench runs` / `STATE.md` say `version 2` next to the verdict even when the run
  is fresh. A run whose version is behind is stale with that as the reason, before any hash is
  consulted.
- A panel pins the version it materialized, so a tab drawn from version 2 turns `stale` the moment
  version 3 exists, even when the rows happen to hash the same. The window's strip says `main · v2
  (now v3)` when the panel is a recipe it cannot redraw without Python, which is honest about a drawing
  that is behind.
- Cost: two extra events per import (the version, and the parent's inferred record) and one field per
  point event. The diff is O(rows) for a typical export; within-instant collisions are the only
  non-linear case and are rare by construction.
- Typing a point grows the current version rather than creating one. "One more reading" and "here is
  the whole file again" stay different acts.
- A file whose time column is named something bench does not recognise — `taken_at`, say — is read
  correctly when the door is told: `--time taken_at` or the sheet's picker. Both doors pass the same
  `time` option into `planImport`, so the CLI and the window cannot disagree about which instant a
  row has.
- The cost is one refusal where there used to be a silent success: importing a table with no clock
  now fails even as a dataset's first version. That is the intended trade — such a dataset could
  never be re-imported with a meaningful diff, and the refusal says which columns could have held
  the time.

**Not decided here.** Shape extension and migrations (a version of a *shape* is a different axis), how
to browse versions in the window beyond the strip's label, and whether a *typed* point with no `--at`
should keep defaulting to now (it does; a single typed point is an act with a time, not a file
claiming thousands of rows share one).

## Update 2026-10-20 — untimed files are labelled, not refused

Item 5's refusal is narrowed by [ADR 0015](0015-user-surface.md). A file with no clock may now import
with the row order as an explicit **estimated** instant: the plan says so before the write, the rows
carry the estimate, and a real observation time can replace it from the window (roadmap U9/U11). The
original reasoning stands — an invented instant is indistinguishable from a measured one, so it is
never silent, and a re-export of an untimed file must not claim every row is new. What changed is that
the uncertainty is recorded and correctable instead of blocking the import. A file that *has* a time
column never falls back to the estimate.
