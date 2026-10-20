# Roadmap — the open work, in one place

Status: **landed 2026-10-20.** Commit `cb681b2` holds the code, tests, harness and gate scripts, and
was green on that tree (`pnpm verify`, 264 tests; `pnpm app:measure`; `pnpm app:package:check`); this
commit holds the documentation it left out. It landed as **one** commit rather than the slices step 0
asks for, and the visual gate is still open — both are recorded in the step 0 row.
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
  re-render budget.
- **Shipping:** `pnpm app:package` writes a portable Windows build with its own CLI; the release
  workflow is green through artifact upload, but no `v*` tag has been cut.
- **Not built:** the rows below — point retraction from the window, tab/project management, the
  versions panel, entry extras, the shape flow, a resizable rail, and the delivery items. Step 0 of
  the plan comes first.

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
packaged check rewrites the tracked `docs/ui-review/app-packaged.json`; restore it afterwards if the
tree must stay clean.

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
| **hover tooltip: id, values, dataset · shape** | chart hover | **done** | `chart.js` tooltip block; `app-interaction.png`. The earlier note "no hover tooltips" is out of date |
| wheel zoom, keyboard pan, hover ring | chart | done | `app-interaction.png` |
| add a point from the entry bar | entry bar | done | `app-entry.png`; measured 22.2–25.8 ms median (2026-10-19) |
| undo the last point (`Ctrl+Z` in an empty bar) | entry bar | done | `app-undo.png` |
| correct a point by clicking its mark | chart selection | done | `app-corrected.png` |
| import CSV/TSV/JSONL with a mapping sheet and a version diff | `Import…` | done | `app-import.png`, `app-version-diff.png` |
| **retract any point, with a reason** | — | missing | CLI `bench retract` only; the window can undo only the last point |
| browse dataset versions and diffs | import sheet | partial | `bench dataset list\versions\diff` exists; no panel lists versions or shows a diff outside an import |
| rename / delete / duplicate a tab | — | missing | no `bench view rm` either; a tab is a file, and deleting it loses the question it asked |
| rename a project, or forget it from recents | — | missing | registry has no `forget`; deletion is not offered anywhere and should not be |
| extend a shape / designate its time field / run a migration | — | partial | core/CLI paths for extension and designation are done ([ADR 0013](adr/0013-shape-extension.md), [ADR 0014](adr/0014-observation-time.md)); the window has no flow yet |
| record a decision | — | missing | CLI `bench decide` only |
| paste a TSV block with preview, auto-advance, stream mode | — | missing | requirements §6; plan 5.8 |
| keyboard map / shortcut help | — | missing | `Ctrl+Z`, `Esc`, `Shift+Arrow` exist; nothing lists them |
| **resize the rail** | — | missing | fixed `--rail-width: 268px` (`tokens.css`), no pointer handler, no persisted width |
| canvas renderer for a rescale | chart painter | **done** | `src/core/chart.ts` splits the drawing and packs the marks; `app/renderer/chart.js` paints them on a canvas. 10k rescale **35.1–47.4 ms** (was 147.0–173.6); `pnpm app:measure` gates on 50 ms and refuses a missing or patched redraw sample, and `pnpm app:capture` asserts the canvas covers the drawing and has 3,589 painted pixels. plan 5.6 |

### The visual gate is still open

`docs/ui-review-log.md` has **24 rows, 23 of them still `pending`** (the first row approved the design
direction, not a frame). The captures exist and the assertions behind them run in
`pnpm app:capture`, but no frame has a verdict. Any UI slice below should be reviewed together with
the frames already waiting, or the log stops being a gate and becomes a diary.

## 2. The finish plan, in order

This is the sequence, not an estimate: each step is one reviewable slice, and a step that needs a
decision below waits for it. Sizes are relative — S is a sitting, M is a day or two, L needs an ADR.

| # | slice | size | done means | depends on |
|---|---|---|---|---|
| 0 | **Land the tree; close the review gate** | S | **partial 2026-10-20** — committed (`cb681b2` plus this docs commit) and `pnpm verify` is green on it, but as **one** code commit, not slices: `src/core/chart.ts`, the panels moving out of `views.ts`, `app/core.entry.ts` and the renderer share a compile boundary, so a split leaves every intermediate commit failing `tsc` (probe: the new chart alone at the old tree → `app/core.entry.ts(475)` type errors). The review gate is **open**: 24 rows, 23 `pending` | — |
| 1 | **Canvas renderer** | M | **done 2026-10-19** — a rescale measures 35.1–47.4 ms at 10k (was 147–174), `pnpm app:measure` exits non-zero over 50 ms and when no full-redraw sample arrived or a submit was programmatic, and `pnpm app:capture` checks the canvas's coverage and painted pixels | — |
| 2 | **Resizable rail** | S | drag handle plus `ArrowLeft`/`ArrowRight` when focused; width in `$BENCH_HOME/ui.json`, restored on launch; no reflow jitter; three-scaling screenshot | decision 2 |
| 3 | **Point actions** | M | selecting a mark offers Correct / Retract… / Copy id; retraction requires a reason and writes the same event the CLI writes; a retracted point stays visible as retracted | decision 4 |
| 4 | **Tab and project management** | M | `bench view rm <name>`, a rail action for rename/delete, and `bench projects --forget <path>` dropping recency only | decision 1 |
| 5 | **Dataset versions panel** | M | a tab or sheet listing every version with rows and `+n −n ~n`, a diff between any two, and which panels are pinned to which version; reads `Workspace`, runs nothing | — |
| 6 | **Entry extras** | M | paste a TSV block → preview against the shape → commit; auto-advance after Enter; stream mode; requirements §6's targets still hold | `add --stdin` |
| 7 | **Shape extension and designation in the window** | S–M | a flow that says which points lack a field, records the same `shape_extended` / `shape_time_designated` events the CLI does, and shows the new declaration | — |
| 8 | **Delivery hardening** | S–M | README, LICENSE, a first `v*` tag that produces a downloadable release; the packaging check leaves the tree clean and runs in CI; the signing/installer decision is recorded | user decision on signing |
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

`pnpm app:measure` needs a display and a focused OS window. `pnpm app:package:check` rewrites the
tracked `docs/ui-review/app-packaged.json` (timing, byte counts and the custom-axis facts), so a
clean-tree gate needs that side effect removed first.

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
| `app:package:check` in CI | skipped | the check itself passes locally (2026-10-19, exit 0) and proves the packaged window, a typed custom-axis tab to `n = 3` with hover and selection, the Python-absent degradation and `bench.cmd`; it is still absent from `release.yml`, and it rewrites the tracked `docs/ui-review/app-packaged.json`, so a clean-tree gate fails until that side effect is removed |
| README | missing | a fresh clone lands on a bare GitHub page; `AGENTS.md` is a rulebook for agents, not a front door. Needs install, run, and where the `.exe` comes from |
| first Release | not cut | the workflow is green through the 147.4 MB zip upload, but no `v*` tag has been pushed, so there is nothing to download; the `gh release create` step has never run |
| LICENSE | missing | a public repo with no license is not usable by anyone else |
| code signing | missing | SmartScreen warns on first launch; needs a certificate, so it is a user decision |
| installer / auto-update | missing | portable zip only; ADR 0009 records that choice |
| Python not bundled | by design for now | recipe source ships; `run fit`/`drift` need a `recipes/.venv` or numpy/scipy on PATH |

## 5. Decisions needed before the related slice

1. **Deleting a tab.** A view is a file, not a log event, so deleting it destroys a question with no
   record. Options: `views/.trash/<slug>.json` (recoverable, easy), a `view_deleted` event in the log
   (auditable, but views were deliberately kept out of the log), or no deletion at all (rename and
   replace only). The cheapest defensible choice is trash-with-a-name, but it is the user's call.
2. **Where UI preferences live.** Rail width, last tab, panel scroll. `$BENCH_HOME/ui.json` keeps the
   window consistent across launches and out of projects; `localStorage` is simpler but per-profile
   and invisible to an agent. Recommend `$BENCH_HOME/ui.json`, matching the registry.
3. **Tooltip identity.** The review log already asks: the raw ULID is traceable, shortened ids are
   readable. A prefix plus a copy action may be the answer; decide once, because it appears on every
   hover.
4. **Retraction in the window.** Whether a point's menu is the primary path or a fallback to undo, and
   whether the reason is free text or a short list. The log records the string either way.
