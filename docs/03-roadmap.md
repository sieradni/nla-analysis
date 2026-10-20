# Roadmap — the open work, in one place

Status: **landed 2026-10-20.** Commit `cb681b2` holds the code, tests, harness and gate scripts, and
was green on that tree (`pnpm verify`, 264 tests; `pnpm app:measure`; `pnpm app:package:check`); the
docs commit after it holds the documentation, and a third commit carries the two follow-ups decided
on the same day: one column below 980 px of viewport, and a packaged check that compares against its
receipt instead of rewriting it. The code landed as **one** commit rather than the slices step 0 asks
for; that is recorded in the step 0 row.

On **2026-10-20** the user reviewed the window and closed the whole visual gate by direction instead
of per-frame verdicts, then listed what the window gets wrong for a person. Those decisions are
[ADR 0015](adr/0015-user-surface.md) and [05-user-surface.md](05-user-surface.md); the work they
create is **§6 below**, and it comes before the remaining finish plan except where a step is its
dependency. Nothing in that backlog waits on the user.

Open work only; completed steps stay in the
[implementation plan](02-implementation-plan.md) progress table. Requirements remain the authority on
*what* ([00-requirements.md](00-requirements.md)); this file is the live, itemised answer to "what is
missing, and what would closing it look like".

## Where it stands

- **Core and CLI:** the append-only log, the `Workspace` write path, imports with dataset
  versions/diffs, shape extension ([ADR 0013](adr/0013-shape-extension.md)) and observation-time
  designation ([ADR 0014](adr/0014-observation-time.md)) are built and tested.
- **Window:** project and tab switching, point entry, correction by selecting a mark, undo, the
  import sheet, version diff, field-pair tabs, and live refresh from another writer are built. Marks
  are painted on a canvas between two halves of the core's SVG, so a 10k rescale is inside the 50 ms
  re-render budget.- **Shipping:** `pnpm app:package` writes a portable Windows build with its own CLI; the release
  workflow is green through artifact upload, but no `v*` tag has been cut.
- **User surface:** specified on 2026-10-20 ([ADR 0015](adr/0015-user-surface.md),
  [05-user-surface.md](05-user-surface.md)) and **not built**. The window still shows record ids in
  tooltips, has no redo, asks for a time column in a form, and offers CLI commands where a button
  belongs. §6 is the list.
- **Not built:** the rows below — point retraction from the window, tab/project management, the
  versions panel, entry extras, the shape flow, a resizable rail, the user-surface pass, and the
  delivery items.

## Verified on this tree (2026-10-19)

Both measurements were run against the same working tree, on the machine that built it. Re-run them
before trusting a number in a later session; a stale measurement is how the canvas verdict nearly
rested on the wrong figure.

| what | command | observed | budget |
|---|---|---|---|
| keystroke → paint, 10k points, point inside the drawn axes | `pnpm app:measure` | **22.2–25.8 ms** median across runs (p90 28.0–32.4); median split record 12–16 · rebuild 0.1–0.2 · paint 2–9 | 100 ms ([ADR 0003](adr/0003-in-process-core.md)) — within |
| full redraw, 10k points, point outside the drawn axes | `pnpm app:measure` | **35.1–47.4 ms** across runs (rebuild 12–18 · paint 11–14), each `[full redraw]`; the pre-canvas renderer measured 147.0–173.6 ms | 50 ms re-render — within; the harness refuses a missing or patched sample, a programmatic submit, or a miss |
| packaged build, GUI and shipped CLI | `pnpm app:package` then `pnpm app:package:check` | exit 0: `packaged=true`, 2 panels / 28 marks, `n = 14`; a second project with shape `load.v1 (mass, extension)` types three points to `n = 3` through the packaged window, the saved tab holds those axes, and hover/selection name the record; with Python removed the tab dialog offers only `plot` and names the missing runtime; `bench.cmd` does init → import → view → render → `run fit` with no Node and no Python; 369 MB | 450 MB ceiling — within |

The draw path is `renderChartLayers` → two SVG halves → a canvas. A rescale no longer builds ten
thousand elements: the core packs the projected positions, the values and the ids into parallel
arrays, and the window paints one path. The incremental path still appends one mark and measures
22–26 ms end to end; the tab file is written by `persistView` after the paint, which took the save
off the keystroke path.

The rescale row is **one sample per run**, and the frame wait is part of the figure: on a display
that stops producing frames (an occluded window) the sample measures the compositor, so the gate is
meaningful on a visible window. A missing full-redraw sample, a sample the window patched instead of
redrawing, and an entry submitted programmatically are each a failure, not an annotated pass. The
packaged check **compares** against the tracked `docs/ui-review/app-packaged.json` and writes it only
with `--record`, so a plain run leaves the tree clean; its frame is git-ignored.

## How this stays current

A plan document cannot prove itself current. These are the rules that keep it honest, and the honest
limit of each:

1. Every row carries a **state** — `done`, `partial`, `missing`, `blocked`, `decision needed` — and
   **evidence**: a test, a command, or a capture path. A row without evidence is a wish, not a plan.
2. The slice that closes a row **updates this file in the same commit**, moving the row to `done` and
   naming what now proves it. [AGENTS.md](../AGENTS.md) makes that part of the definition of done.
3. `done` still means the plan's gates: the behaviour through the interface a user uses, a test that
   would fail if it regressed, `bench check` green, and a screenshot at 100/125/150% for anything
   visual.
4. **Not enforced automatically.** Nothing fails the build when a row goes stale. The only teeth are
   rule 2 and the review at the start of a session. If a generated version is wanted later, the
   progress tables are structured enough to derive one.

## 1. The window: what exists, and what does not

| capability | where it lives | state | evidence / note |
|---|---|---|---|
| open and switch projects, hide missing ones | rail, `Open…` | done | `app/renderer/app.js`; `tests/shell.test.ts` |
| create a project with a chosen shape | `New…` | done | `app-new-project.png`; shell test "creates a project with the shape the dialog chose" |
| tabs: create a plot or a recipe panel | `New tab…` | done | `app-new-tab.png`, `app-version-diff.png` |
| **hover tooltip: id, values, dataset · shape** | chart hover | **done, being replaced** | `chart.js` tooltip block; `app-interaction.png`. The id and the dataset/shape line are scheduled to go (U1), with **Copy details** in the point menu (U2) |
| wheel zoom, keyboard pan, hover ring | chart | done | `app-interaction.png` |
| add a point from the entry bar | entry bar | done | `app-entry.png`; measured 22.2–25.8 ms median (2026-10-19) |
| undo the last point (`Ctrl+Z` in an empty bar) | entry bar | done | `app-undo.png`; redo, correction undo and removal undo are U4/U5 |
| correct a point by clicking its mark | chart selection | done | `app-corrected.png` |
| import CSV/TSV/JSONL with a mapping sheet and a version diff | `Import…` | done | `app-import.png`, `app-version-diff.png` |
| **remove any point, from its menu, with undo** | — | missing | CLI `bench retract` only; the window can undo only the last point. U6 replaces the reason prompt with one action |
| browse dataset versions and diffs | import sheet | partial | `bench dataset list\versions\diff` exists; no panel lists versions or shows a diff outside an import |
| rename / delete / duplicate a tab | — | missing | no `bench view rm` either. U7 moves a deleted tab to `views/.trash/` and offers Undo, so the question is not lost |
| rename a project, or forget it from recents | — | missing | registry has no `forget`; deletion is not offered anywhere and should not be |
| extend a shape / designate its time field / run a migration | — | partial | core/CLI paths for extension and designation are done ([ADR 0013](adr/0013-shape-extension.md), [ADR 0014](adr/0014-observation-time.md)); the window has no flow yet |
| record a decision | — | missing | CLI `bench decide` only |
| paste a TSV block with preview, auto-advance, stream mode | — | missing | requirements §6; plan 5.8 |
| keyboard map / shortcut help | — | missing | `Ctrl+Z`, `Esc`, `Shift+Arrow` exist; nothing lists them. U15 adds the **?** sheet and says what Shift+Arrow does |
| **resize / collapse the rail; hide the entry bar** | — | missing | fixed `--rail-width: 268px` (`tokens.css`), no pointer handler, no persisted width; the entry bar cannot collapse. U19 |
| one column below 980 px of viewport | `.grid` media query (`app.css`) | done | two panels side by side stop being legible at 150% (~170 px each); below 980 px the grid is one column and 150% draws a 519 px panel, while 125% (~1013 px) keeps its two. `pnpm app:capture` computes the column count per scaling and throws when it disagrees with the viewport |
| canvas renderer for a rescale | chart painter | **done** | `src/core/chart.ts` splits the drawing and packs the marks; `app/renderer/chart.js` paints them on a canvas. 10k rescale **35.1–47.4 ms** (was 147.0–173.6); `pnpm app:measure` gates on 50 ms and refuses a missing or patched redraw sample, and `pnpm app:capture` asserts the canvas covers the drawing and has 3,589 painted pixels. plan 5.6 |

### The visual gate was closed by direction on 2026-10-20

`docs/ui-review-log.md` has **25 rows**; 24 were `pending` until the user reviewed the window and
closed the batch by stating the direction, not by approving frames one at a time. The log quotes the
direction and records what each row is now closed against. This is a decision about the direction,
**not** a claim that every pixel was inspected, and it is not a licence to skip the frames: a new
visual change still produces a capture and a row, under the readable protocol in
[05-user-surface.md](05-user-surface.md) §7.

The user also found defects the frames did not make obvious — ids in tooltips, duplicated facts, CLI
instructions in empty states, `New…`/`Open…` spacing, unreadable number formatting. Those are in §6,
not in the log, because the log is for frames and §6 is for the work.

## 2. The finish plan, in order

This is the sequence, not an estimate: each step is one reviewable slice, and a step that needs a
decision below waits for it. Sizes are relative — S is a sitting, M is a day or two, L needs an ADR.

The **user-surface pass in §6 goes first**, because several steps below assume its vocabulary and its
controls: a tab manager that says `main · v2` would have to be rewritten, and point actions that
carry ULIDs would contradict ADR 0015. A step may jump ahead only when it is a dependency of a `U`
row, and that is said in the row.

| # | slice | size | done means | depends on |
|---|---|---|---|---|
| 0 | **Land the tree; close the review gate** | S | **done 2026-10-20** — committed in `cb681b2` plus the docs commit and `a3888b4`; `pnpm verify` is green on the tree (264 tests). It landed as **one** code commit, not slices: `src/core/chart.ts`, the panels moving out of `views.ts`, `app/core.entry.ts` and the renderer share a compile boundary, so a split leaves every intermediate commit failing `tsc` (probe: the new chart alone at the old tree → `app/core.entry.ts(475)` type errors). The review gate was closed **by direction** on 2026-10-20 — 25 rows, no per-frame verdicts, quoted in the log | — |
| 1 | **Canvas renderer** | M | **done 2026-10-19** — a rescale measures 35.1–47.4 ms at 10k (was 147–174), `pnpm app:measure` exits non-zero over 50 ms and when no full-redraw sample arrived or a submit was programmatic, and `pnpm app:capture` checks the canvas's coverage and painted pixels | — |
| 2 | **Resizable rail** | S | drag handle plus `ArrowLeft`/`ArrowRight` when focused; width in `$BENCH_HOME/ui.json`, restored on launch; no reflow jitter; three-scaling screenshot | U19 |
| 3 | **Point actions** | M | right-click **Copy details / Correct… / Remove**; removal is one action with undo, not a reason prompt; a retracted point stays visible as retracted until it is restored | U2, U5, U6 |
| 4 | **Tab and project management** | M | `bench view rm <name>`, a rail action for rename/delete with Undo, and `bench projects --forget <path>` dropping recency only | U7 |
| 5 | **Dataset versions panel** | M | a tab or sheet listing every version with rows and `+n −n ~n`, a diff between any two, and which panels are pinned to which version; reads `Workspace`, runs nothing | — |
| 6 | **Entry extras** | M | paste a TSV block → preview against the shape → commit; auto-advance after Enter; stream mode; requirements §6's targets still hold | `add --stdin` |
| 7 | **Shape extension and designation in the window** | S–M | a flow that says which points lack a field, records the same `shape_extended` / `shape_time_designated` events the CLI does, and shows the new declaration | — |
| 8 | **Delivery hardening** | S–M | README, LICENSE, a first `v*` tag that produces a downloadable release; `0.1.0` is the version, cut only after README and LICENSE (decided 2026-10-20); the packaging check leaves the tree clean (**done 2026-10-20** — it compares against its receipt and needs `--record` to write it) and runs in CI (**open**); the build ships **unsigned** and the docs say SmartScreen will warn (decided 2026-10-20); an installer and auto-update stay out until asked | — |
| 9 | **CI depth** | S | `pnpm setup:recipes` in the job so the 25 analysis-dependent tests run, and `app:package:check` as its own Windows step | 8 |

### How to check this plan

```bash
pnpm verify                 # typecheck, bundle the core and CLI, 264 tests
pnpm app:measure            # real window at 10k; fails over either budget, a missing or patched
                            # redraw sample, or a non-keystroke submit
pnpm app:package            # build the artifact from this tree
pnpm app:package:check      # launch it, type into a custom shape, then run its CLI with Python
                            # removed from PATH
```

`pnpm app:measure` needs a display and a focused OS window. `pnpm app:package:check` compares the
run against the tracked `docs/ui-review/app-packaged.json` and fails on any changed fact; pass
`--record` once, deliberately, to accept a new report. The frame it writes is git-ignored, so a plain
run leaves the tree clean and the check can be a CI step as it stands. A run that prints no report
within 90 s is a failure — the window blocks when it cannot take focus, and a gate that hangs hides
that behind the runner's own timeout.

## 3. Core and CLI gaps

These are specified in [01-agent-interface.md](01-agent-interface.md) and not built. A window feature
that needs one of them waits for it rather than duplicating the logic.

Creating a custom-shaped project (`QP Stats`, 2026-10-19) also found gaps that are not in
[01-agent-interface.md](01-agent-interface.md); the reproduction is in
[04-project-onboarding-frictions.md](04-project-onboarding-frictions.md).

| gap | state | why it matters |
|---|---|---|
| `dataset replace`, `dataset show`, `dataset export` | missing | replace is what a corrected instrument export needs; export is how data leaves |
| `shape extend` | done | add one field as the next version without rewriting points; duplicate/retype/older-version/missing-type refusals; `bench check` re-validates every extension. [ADR 0013](adr/0013-shape-extension.md); `tests/shapes-extension.test.ts`, `tests/cli.test.ts` "extends a declared shape". Evidence on QP Stats: `qp_stats.v1` → `qp_stats.v2` with `b2b:integer`, then the real observation recorded |
| `shape designate` (observation time) | done | designate one required `instant` field as `time_field` in a new declaration; `add`, `correct` and `import` derive `t_observed` from it and canonicalise the field in `values`; a contradicting `--at` or second import time column is refused, and old points are not reinterpreted. [ADR 0014](adr/0014-observation-time.md); `tests/observation.test.ts`, `tests/import.test.ts`, `tests/cli.test.ts` "designates a shape's observation field". Evidence on QP Stats: `qp_stats.v2` → `qp_stats.v3`, a divergent `--at` refused with no event, `bench check` green and the recorded point unchanged |
| `shape list` / `show` / `validate` beyond the registry | missing | plan 2.2; the window's shape editor will need the read side |
| `annotate` | missing | notes on a point or a range are asked for constantly and have no home |
| `add --stdin`, batch input | missing | streaming and paste both want it |
| unmapped import columns | done | an extra column (e.g. `B2B`) now refuses by default and names itself; `--ignore-unmapped <column>` is the explicit per-invocation opt-out, printed by dry-run/apply and recorded as `ignored_columns`. Exact-column imports are unchanged. Evidence: `tests/import.test.ts`, `tests/cli.test.ts` |
| `recipe show` | missing | the window can say a recipe is missing but not what it needs |
| `--dry-run` on every mutating command, `--id` idempotency | partial | `--dry-run` exists on `import` only |
| analysis cache / debounce / cancel (plan 3.3) | missing | every run recomputes; live sliders and recipe panels on the entry path need this |
| windowed / rolling fit | missing | the third item on the time-variation menu (§5) |
| `index.sqlite` derived index (plan 2.3) | missing | the log folds in memory today; fine at 10k, decide at 100k |
| `view rm` / `view rename` | missing | see slice 4 |
| project `forget` | missing | slice 4; the registry grows entries for deleted temp projects otherwise |
| field-pair plotting for custom shapes | done | one resolver ([axes.ts](../src/core/axes.ts)) validates `--x-field`/`--y-field` and the panel's `x_field`/`y_field`; defaults are still `x`/`y`. An `instant` horizontal axis is a real time axis (`Axis.format = 'time'`, clock ticks, a one-day domain for a single point). The window's tab dialog lists the selected shape's fields and refuses a shape with no numeric vertical field. Evidence: QP Stats `altitude over time` and `app against pps`, `tests/axes.test.ts`, `tests/chart.test.ts`, `tests/views.test.ts`, `tests/cli.test.ts`, [app-field-pair-altitude-100.png](ui-review/app-field-pair-altitude-100.png) |
| shape field display labels | missing | names are lowercase identifiers, so `APP` renders as `app`; `unit` is not a label. Needs a shape change |
| observation-time field in a shape | done | `bench shape designate <id> --time-field date` appends a declaration; `add`/`correct`/`import` derive and canonicalise `t_observed` from the field and refuse a contradiction. [ADR 0014](adr/0014-observation-time.md); evidence in `tests/observation.test.ts`, `tests/import.test.ts`, `tests/cli.test.ts`, and QP Stats at `qp_stats.v3` with its original point untouched |
| shape-aware CLI hints | done | [hints.ts](../src/core/hints.ts) is the one owner: `init`, `view list`, `add`/recipe refusals, the empty chart, and the window's no-tabs state all derive their sample command from the declared shape. A custom shape gets `add --values '{…}'` and a `view new … --x-field … --y-field …` pair it can actually run; the window receives the same hint through `entry.nextTab`. Evidence: `tests/cli.test.ts` "takes a custom shape from init through a real first tab", `tests/shell.test.ts` axes candidates |
| empty panel before the first point | done | a plain `view new` with no active rows now saves a real panel: `n = 0`, axes named, and a centered sentence naming the shape's own `add` command. `bench chart` on the same project writes `(0 points)` instead of refusing; a recipe with no rows still refuses, with a shape-derived hint. Evidence: `tests/views.test.ts`, `tests/chart.test.ts`, `tests/cli.test.ts`, [app-empty-tab-100.png](ui-review/app-empty-tab-100.png) |

## 4. Quality and delivery gaps

| gap | state | note |
|---|---|---|
| fixture matrix (plan 2.5) | partial | drift-sensor, duplicate-time, re-export exist; 2-point, 1e5-point, unicode, missing-value, garbage-paste, post-migration do not |
| golden chart snapshots | missing | fits are checked numerically; nothing catches a chart that regresses visually |
| analysis tests in CI | skipped | 25 analysis-dependent tests skip without `recipes/.venv` (20 in `run.test.ts`, 4 in `cli.test.ts`, 1 in `shell.test.ts`); the release job packages code those tests never exercise |
| `app:package:check` in CI | partial | the check passes locally (2026-10-20, exit 0) and proves the packaged window, a typed custom-axis tab to `n = 3` with hover and selection, the Python-absent degradation and `bench.cmd`; it compares against its receipt and writes it only with `--record`, so it is clean-tree safe, but it is still absent from `release.yml` and has never run on a Windows runner |
| README | missing | a fresh clone lands on a bare GitHub page; `AGENTS.md` is a rulebook for agents, not a front door. Needs install, run, and where the `.exe` comes from |
| first Release | not cut | the workflow is green through the 147.4 MB zip upload, but no `v*` tag has been pushed, so there is nothing to download; the `gh release create` step has never run. The version is **`0.1.0`**, cut only after README and LICENSE (decided 2026-10-20) |
| LICENSE | missing | a public repo with no license is not usable by anyone else |
| code signing | missing | **decided 2026-10-20: ship unsigned.** SmartScreen will warn on first launch; `docs/packaging.md` says so, and a certificate is a later decision on its own, not a blocker for the portable build |
| installer / auto-update | missing | portable zip only; ADR 0009 records that choice |
| Python not bundled | by design for now | recipe source ships; `run fit`/`drift` need a `recipes/.venv` or numpy/scipy on PATH |

## 5. Decisions closed on 2026-10-20

These were open and are now decided by the user's direction; the full reasoning and the affected
surfaces are in [05-user-surface.md](05-user-surface.md) §8 and [ADR 0015](adr/0015-user-surface.md).
None of them is waiting on the user, and none should be reopened without changing those documents.

| # | question | decision | carried by |
|---|---|---|---|
| 1 | deleting a tab | move to `views/.trash/`, offer Undo; no log event, no confirmation dialog | U7 |
| 2 | where UI preferences live | `$BENCH_HOME/ui.json`, disposable app state, never project data | U19 |
| 3 | tooltip identity | no id in the UI; values only; **Copy details** lives in the point menu | U1, U2 |
| 4 | retraction in the window | a point-menu action, one click, no reason prompt; undo restores the same record | U5, U6 |
| 5 | keep the time picker visible | no: a stated guess with **Change**; the picker opens on request | U8 |
| 6 | refuse an untimed re-export | no: import with a labelled estimate that can be corrected; row-order matching is stated | U9 |
| 7 | one column below 980 px | keep it; 125% keeps two columns, 150% becomes legible | done (`a3888b4`) |
| 8 | name both datasets in a mixed strip | no tab-level lists; a per-panel label only where panels differ | U18 |
| 9 | caption in the accessible name | keep the conclusion, drop the duplicate footer/caption and internal names | U27 |
| 10 | unsigned portable build | ship unsigned, document SmartScreen; signing is a later decision on its own | done ([packaging.md](packaging.md)) |
| 11 | version `0.1.0` | cut only after README and LICENSE exist | finish plan 8 |
| 12 | the receipt behind `--record` | `--record` is the only writer; a plain run compares and leaves the tree clean | done (`a3888b4`) |
| 13 | `label`/`unit` as a declaration-only version | `label` yes, as a recorded declaration-only version; a unit change is still refused | U28 |
| 14 | frames without verdicts | closed by direction on 2026-10-20; the log quotes the direction and the new protocol | U25, U26 |

## 6. User surface — the backlog

The details, the wording the user used, and the acceptance test for each row are in
[05-user-surface.md](05-user-surface.md). This table is the order of work. Everything here is not
started; nothing is waiting on a decision.

### 6.1 A point, and what hovering one says

| id | slice | size | done means |
|---|---|---|---|
| **U1** | Tooltip is a value readout | S | values with labels and units; time only when it is not an axis; no ULID, dataset, shape, recipe or version. `app-interaction` recaptured |
| **U2** | Point menu: Copy details / Correct… / Remove | S–M | right-click and Shift+F10 open it; copied text identifies the point without the person reading an id; keyboard reachable; Escape returns focus |
| **U3** | Correction strip and statuses in plain words | S | `Editing x 6.5, y 16.4 · observed 19 Oct 06:00`; `Saved` / `Corrected` / `Removed`; no event names or ids in primary text |

### 6.2 Undo, redo, removal

| id | slice | size | done means |
|---|---|---|---|
| **U4** | One undo/redo history for the tab | M | add / remove / correct / tab / import each undo and redo; `Ctrl+Z`, `Ctrl+Shift+Z`, `Ctrl+Y`; visible buttons naming the action; redo cleared by a new action; text fields keep their own undo; an import undo appends a restore version, never deletes one |
| **U5** | `point_restored` event | M | undo of a removal restores the *same* id, values, time and version; one event per undo; `bench check` green; redo removes it again |
| **U6** | Remove is one action, no ceremony | S | one click from the menu; status `Removed · Undo`; no reason prompt; CLI/agent may still record a reason |
| **U7** | Tab delete is recoverable | S | moves to `views/.trash/<slug>-<timestamp>.json`; Undo restores the exact file and reopens the tab; no log event; trash is bounded and disposable |

### 6.3 Time, imports, confirmation

| id | slice | size | done means |
|---|---|---|---|
| **U8** | Time column is a stated guess | S | `Time: taken_at — change` above the preview; plans immediately; Change opens the full choice; no picker homework |
| **U9** | Untimed files import with a labelled estimate | M | `No time column — use the file order (estimated)`; rows carry the estimate; diff says so; a real time can replace it; a file *with* a clock never falls back |
| **U10** | Import summary in plain language | S | `5 rows · 1 added, none removed, none changed`; version and `+1 −0 ~0` behind **Details**; button says `Import 5 rows` |
| **U11** | Correct the observation time from the window | S–M | a date/time input in the correction row; an estimated time can be replaced; the mark moves on a time axis; status says what changed |

### 6.4 Explanation: badges, captions, numbers

| id | slice | size | done means |
|---|---|---|---|
| **U12** | No `current`; explain the rest | S | silence when current; `Out of date` + **Refresh** + why; `Data gone` + action; verdict hover says what it means and what would strengthen it; DOF spelled out |
| **U13** | One number format | S | one module for tooltips, axes, captions, statuses: 3 significant digits, thousands separators, `1.23 to 2.35`, units, `19 Oct 2026, 06:00`, `1 point`/`14 points` |
| **U14** | One title, and numbers with names | S | no duplicate title; no `main <recipe>` panel title; the caption leads with the conclusion; every number has a word saying what it is |
| **U15** | Hints that say what happens | S | `Click a point to edit it`; a **?** help sheet; Shift+Arrow described as next/previous *point*; every shortcut in the sheet |
| **U16** | Truncated text is readable | S | app tooltip with the full value on hover; context-menu **Copy**; rail paths, tab names, panel titles, long statuses |

### 6.5 Show each fact once

| id | slice | size | done means |
|---|---|---|---|
| **U17** | Rail controls that do not look broken | S | `New project` / `Open project` / `New tab`, no ellipsis, grouped with their headings, readable at 100/125/150% |
| **U18** | Deduplicate the facts | M | `main` absent from a single-dataset project; tab name not repeated in the panel; `n` once per panel; stage count only when panels disagree; per-panel version only where it differs |
| **U19** | Resizable, collapsible rail; hideable entry | M | drag + keyboard resize, `Ctrl+B`, min/max, width in `$BENCH_HOME/ui.json`, persisted; entry bar collapses to one line with undo still reachable; no layout shift |
| **U20** | 150% keeps pairs side by side | S | axis pickers and entry fields stay in a row at 150% (stack only when genuinely narrow); the sheet fits the viewport; measured at all three scalings |
| **U27** | Accessible names say the conclusion | S | title, axes with units, `n`, verdict in visible words, one interaction hint; under ~25 words; no id or internal name; caption available as a description |
| **U28** | Shape display labels | M | `label` on a field, set by a recorded declaration-only version; used on every surface a person reads; a unit change is still refused; points keep their shape |

### 6.6 Buttons, not commands

| id | slice | size | done means |
|---|---|---|---|
| **U21** | The window offers the action | M | stale plot refreshes itself after a write; stale recipe offers **Refresh** and says why; CLI text only in a collapsed **For agents** detail; every error ends with an action |
| **U22** | The empty first tab teaches by doing | S | one sentence, cursor in the first field, **Add the first point**, **Import…**, **Create a tab…**; no command in primary text; zero to first mark without a terminal |

### 6.7 The agent's half of the contract

| id | slice | size | done means |
|---|---|---|---|
| **U23** | State the assumption, then the change | S (docs) | application and project `AGENTS.md` carry the rule: say the guessed time/field/estimate before the write, summarise the change after; no confirmation for a routine reversible action |
| **U24** | CLI human output matches the window | S | first line of a mutation is the change in plain words (`1 row added, none removed, none changed → version 5`); id/event on the next line; `--json` and exit codes unchanged; tests assert the line |

### 6.8 The review process

| id | slice | size | done means |
|---|---|---|---|
| **U25** | A readable review row | S (docs) | four parts — screen, check, wrong looks like, your call — with no internal names; glossary at the top; historical rows keep their text but are closed |
| **U26** | A contact sheet with a start-here path | S | opens with the three scalings and one sentence each for hover, entry, undo, refusal, import, packaged; captions say what a frame demonstrates; filename in small type |
