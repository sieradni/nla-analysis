# Implementation plan

Status: Phases 0-3 complete (2026-10-19); the in-process seam ([ADR 0003](adr/0003-in-process-core.md)), the tab/project layer ([ADR 0004](adr/0004-views-and-projects.md)), a first desktop window ([ADR 0005](adr/0005-desktop-shell.md)), its write path ([ADR 0006](adr/0006-window-write-path.md)) and dataset versions ([ADR 0012](adr/0012-dataset-versions.md)) landed, and the release workflow builds a portable Windows build and, on `v0.1.0` (2026-10-22), published it: [releases/tag/v0.1.0](https://github.com/sieradni/nla-analysis/releases/tag/v0.1.0) carries the 147.5 MB zip and the source archives. The **user surface was specified on 2026-10-20** ([ADR 0015](adr/0015-user-surface.md), [05-user-surface.md](05-user-surface.md)) and is roadmap §6, where 16 of the 30 rows are done. The **open work is itemised in [03-roadmap.md](03-roadmap.md)**, which is updated in the same commit as each slice; this file keeps the phase structure and the history.
Supersedes §13 of [00-requirements.md](00-requirements.md) (slices).

Where an early phase below says Tauri, `src/ui`, or `bench/perf.ts`, the shipped tree is Electron
([ADR 0005](adr/0005-desktop-shell.md)), `app/renderer`, and `scripts/measure-window.mjs` — read
those passages as the plan as it was written, not as a description of today's layout.

## Progress

| step | state | evidence |
|---|---|---|
| 0 decisions + scaffold | done | [ADR 0002](adr/0002-agent-only-v1.md); TypeScript runs directly on Node 24, no build step |
| 0 fix AGENTS.md layouts | done | app-repo vs project-folder layouts separated below |
| 1.1 event log core | done | append-only verified by byte-prefix test; torn tail tolerated |
| 1.2 init / add / state / check | done | `fixtures/projects/drift-sensor` built entirely through the CLI |
| 1.3 chart artifact | done | `bench chart` writes SVG; renderer is a core module, not CLI glue |
| 1.4 entry ergonomics | **partial** | ADR 0002 made v1 agent-only; the bar, optimistic append, correction, undo and its Ctrl+Z/Esc keys landed with the window (5.4). Paste, stream and auto-advance are not built |
| 2.1 corrections + retractions | done early | `bench correct` / `bench retract`; original records preserved in the log |
| 2.2 shapes registry + validation | done | read, validate, append-only extension, and observation-time designation exist; value migrations are deliberately out of scope ([ADR 0013](adr/0013-shape-extension.md), [ADR 0014](adr/0014-observation-time.md)) |
| 3.1 Python runner | done | JSON over stdio, `uv`-pinned 3.13 env, id echoed, crash contained |
| 3.2 one honest fit recipe | done | band, DOF, F test, verdict; refuses to draw when DOF ≤ 0 |
| 3.3 cache / debounce / cancel | **not done** | every run recomputes; fine at this scale, needed for live sliders |
| 3.4 changepoint | done | `recipes/drift.py`: Chow test at a given split, permutation test when the data chooses the split |
| 3.5 analysis freshness + `runs` / `rerun` | done | three states (current / stale / cannot-be-checked) from the recorded input and recipe hashes; `STATE.md` carries it |
| 4.3 csv / tsv / jsonl import | done | all-or-nothing, content-addressed `data/raw/` copy, hash dedupe; 9 CLI tests |
| 4.4 in-process seam (`Workspace`) | done | [ADR 0003](adr/0003-in-process-core.md); one append and analysis path for CLI and UI. `rerun` had 52 of its 85 lines identical to `run`; that body now lives in `Workspace.recordAnalysis`, and each command is argument parsing, the call, and printing |
| 4.5 artifact identity + provenance | done | `ChartSpec.points[].id` and `provenance`; both recipes echo ids; `data-point-id` on every mark, covered by tests |
| 4.6 project registry | done | [ADR 0004](adr/0004-views-and-projects.md); `bench projects`, recents, `--project <name>`, `--scan`; atomic writes, tolerant reads |
| 4.7 view files (§4) | done | `views/<slug>.json` with materialized specs; `view list\|show\|new\|add\|save\|render`; per-panel `input_hash`/`recipe_hash` staleness; grid render needs no Python |
| 4.8 field-pair plotting | done | one resolver ([axes.ts](../src/core/axes.ts)) for `bench chart`, saved panels, and the window's tab dialog; `x_field`/`y_field` default to `x`/`y`; numeric pairs and an `instant` time axis (clock ticks, one-day domain for a single point). QP Stats' two views are the live evidence |
| 5.1 UI write path | decided | in process, not through the CLI: 15.7 ms versus 160 ms+ per command (ADR 0003) |
| 5.2 shell: Electron vs Tauri+sidecar | decided | [ADR 0005](adr/0005-desktop-shell.md): Electron, because the core is TypeScript and stays in one process. Measured here: 369 MB dev install, 205–242 ms cold start, 466–514 MB working set (summed, so an upper bound) |
| 5.3 first window slice | done | `pnpm app`: projects and tabs switch, a tab's panels draw from their stored specs, hover resolves a mark to its record id, wheel zoom and pan move the `viewBox`. Frames in `docs/ui-review/`; their verdicts are closed by the advisory-review direction (2026-10-21) |
| 5.4 window write path | done | [ADR 0006](adr/0006-window-write-path.md): the entry bar appends through `Workspace` in process, a point inside the drawn axes arrives as one mark the core placed (0.8 ms), a point that rescales the axes asks for a full redraw, the tab file catches up after the paint, and undo is a `point_retracted` event. Refusals keep the typed values and name the field |
| 5.5 entry-path measurement | done | `pnpm app:measure` builds a 10k-point project and types into the real window: **median 22.2–25.8 ms** keystroke→paint (p90 28.0–32.4 across runs, measured 2026-10-19) against the 100 ms budget; record 12–16 · rebuild 0.1–0.2 · paint 2–9, tab file 20–22 ms later. The rescale sample is 35.1–47.4 ms — see 5.6. The first run recorded 24.6 / 133.8 ms; the pre-canvas rescale was 147.0–173.6 ms. The harness fails when either budget misses, when the full-redraw sample is missing or was patched, and when any entry had to be submitted programmatically. |
| 5.6 canvas renderer | done | `src/core/chart.ts` splits a chart into the layers before and after its marks and packs the projected marks (`Float32Array`), the point values and the ids; `app/renderer/chart.js` parses two small SVGs and paints every mark on a canvas between them, with hit-testing, hover, selection, zoom/pan and the incremental one-mark path. A 10k full redraw measured **35.1–47.4 ms** on 2026-10-19 (rebuild 12–18 · paint 11–14), down from 147–174; `pnpm app:measure` exits non-zero over 50 ms and refuses a missing or patched full-redraw sample, and `pnpm app:capture` asserts the canvas covers the drawing and paints 3,589 pixels. The window's tab file is now saved after the paint (`persistView`), not on the keystroke path |
| 5.7 installer / signing | **partial** | [docs/packaging.md](packaging.md): `pnpm app:package` writes a portable `artifacts/bench-win32-x64/` with the CLI beside it, and `.github/workflows/release.yml` builds, tests and zips it on a `v*` tag. The build ships **unsigned by decision on 2026-10-20** and the docs say SmartScreen will warn; an installer and auto-update stay out until asked (roadmap §4) |
| 5.9 CI release | done | **2026-10-22:** manual dispatch [39872696449](https://github.com/sieradni/nla-analysis/actions/runs/39872696449) is green end to end — verify (382 tests), package (369 MB), the packaged check, the CLI smoke, the zip (147.5 MB) and the upload — and tagged run [39873160362](https://github.com/sieradni/nla-analysis/actions/runs/39873160362) adds `Publish the release`, which created [v0.1.0](https://github.com/sieradni/nla-analysis/releases/tag/v0.1.0). The first attempt had never run a step: `astral-sh/setup-uv@v10` does not exist, and the pin is now `v10.3.2`. Earlier, [run 39245803884](https://github.com/sieradni/nla-analysis/actions/runs/39245803884) was green through artifact upload with the release step skipped on manual dispatch |
| 5.8 entry extras (paste, stream, auto-advance) | not done | the entry bar and its undo keys are built; these are not |
| 5.10 user surface pass | **partial** | specified 2026-10-20 by the user's review: no ids or event names in the window, a point menu (copy/correct/remove), full undo/redo, removal without a reason prompt, a stated time guess instead of a form, plain import summaries, no `current` badge, explained verdicts, one number format, one fact once, resizable/collapsible rail, hideable entry bar, buttons instead of CLI commands. The hover, point menu, removal, undo/redo, import words, explained verdicts, plain drawing, empty states, tab close/reopen, a date/time gap, and — 2026-10-21 — the import's time honesty (a stated guess, a labelled estimate, and its replacement from the strip) are in; roadmap §6 (U1–U30) is the live list and the only authority on what is left. [ADR 0015](adr/0015-user-surface.md), [05-user-surface.md](05-user-surface.md) |
| 5.11 undo/redo | **done** | one bounded history per tab covers adding, removing, correcting and importing, in both directions: the bar's undo names the act, the status offers its redo, a new act clears the redo branch, and 50 acts is the limit. A removal is reversed by `point_restored` naming the exact retraction ([ADR 0016](adr/0016-point-restore.md), U5); a correction is reversed by writing the earlier values as another correction; an append's redo restores the same record; an import is undone and redone through `restoreVersion`, which writes a new version holding the older rows ([ADR 0012](adr/0012-dataset-versions.md), [01-agent-interface](01-agent-interface.md)). The core refuses a retraction that is no longer in force, so undo can never reverse a later act by accident. A refusal carries the core's `kind` to the window (`refusalOf` in the bundle), so an act whose record has moved is dropped from the stack and its control disabled, while an unclassified failure stays retryable. A tab's creation is the fifth kind (2026-10-21): undo closes it through the project's own close path, so its file waits in the trash with its acts, and the redo moves that archive home; `bench view rm` / rename / duplicate and the menu on a tab's row are built too (U7). A tab that is *closed* by a person is still reopened from the project's trash by `Ctrl+Shift+T`, including after a relaunch, and that is a window act outside this history. Evidence: `tests/history.test.mjs`, `tests/version-restore.test.ts`, `tests/cli.test.ts` (`dataset restore`), `tests/shell.test.ts`, `pnpm app:capture` (U4) |
| 4.x Tauri shell / views UI | superseded | the shell landed as Electron instead ([ADR 0005](adr/0005-desktop-shell.md)) |
| windowed / rolling fit | not done | the third item on the time-variation menu |
| 2.4 dataset versions / replace / diff | done | [ADR 0012](adr/0012-dataset-versions.md): an import into a populated dataset writes `dataset_version_created` with a parent and a `+n −n ~n` diff, the parent's rows are retracted/corrected rather than rewritten, and `foldVersion` rebuilds any older version from the log. Runs and panels pin `(dataset, version)`; `bench dataset versions\|diff` and the window's sheet read the same plan; an import with no observation time is refused in both doors, and the sheet picks the column that holds it |
| 2.5 fixture matrix | **partial** | the committed drift-sensor project plus duplicate-time and re-export cases exist; 2-point, 1e5-point, unicode, missing-value, garbage-paste and post-migration fixtures do not |
| `shape extend` | done | [ADR 0013](adr/0013-shape-extension.md): `shape_extended` appends a full next declaration plus one field; old points keep their shape, datasets move forward, and `bench check` re-validates every extension. No backfill. The window flow and value migrations are not built |
| observation-time designation | done | [ADR 0014](adr/0014-observation-time.md): `shape_time_designated` names one required `instant` field; `add`, `correct` and `import` derive and canonicalise `t_observed` from it and refuse a contradiction. Shapes without a designation keep the old `--at`/time-column rules. `tests/observation.test.ts` (19), `tests/import.test.ts`, `tests/cli.test.ts`; QP Stats at `qp_stats.v3` with its original point untouched |
| chart golden snapshots | not done | no snapshot tests; fits are checked numerically against closed-form results. Nothing in docs/ decides the format |

## Window structure (2026-10-19)

The desktop shell has two layers. `app/main.js` owns the Electron window, the watcher and the IPC
surface; `app/harness/` holds the capture, measure and smoke runs that drive it. The renderer is split
by concern in `app/renderer/`: `state.js` (shared state and the guarded core call), `copy.js` (every
word a person reads and every number format — ADR 0015; `format.js` was folded into it),
`rail.js` (projects, tabs, folder), `panels.js` (panel mount, statuses, watcher, rebuilding the tab
after a point moves), `fields.js` (the bar's fields and the values they hand the core), `status.js`
(the status row, its only writer), `entry.js` (the bar's drawing), `correction.js` (the strip that
edits one record), `point-actions.js` (the writes the bar and a point's menu make: add, remove, copy,
and the tab catching up after one), `acts.js` (the one table of act kinds, both directions of each,
and the shortcuts), `chart.js` (the drawing's interaction; an ES module mounted by `panels.js`),
`tabs.js` (tab sheet, the name sheet and axes), `tab-actions.js` (the open tab's lifecycle: open,
close, reopen, the trash load, rename, duplicate, undo of a creation, and the rail menu),
`menu.js` (the one popover: placement, keys, dismissal, `aria-expanded` and where the keyboard goes
back), `projects.js` (project sheet and shape flow), `import.js` (import sheet), `navigation.js` (the
few cross-module shell actions), and `app.js` (the project and the boot — the open tab's lifecycle
moved to `tab-actions.js` in 2026-10-21). New window work lands in the module that owns its surface
rather than in `app.js`.

Verification so far: 382 tests in 24 files pass and `tsc --noEmit` is clean. `pnpm verify` also bundles the core
(`pnpm app:build`) before the suite, because the desktop shell loads that bundle rather than `src/core`,
and a bundle that is only exercised by launching an app breaks silently — it did, once. The entry path is measured, not
assumed: 15.7 ms keystroke→paint in process at 10k points against a 100 ms budget (ADR 0003), and
24.6 ms for the whole path in the window, including the append and the paint
([ADR 0006](adr/0006-window-write-path.md)).
`tests/cli.test.ts` runs the actual binary, which is the only way to catch a difference between what
the test runner's transpiler accepts and what Node's type stripping accepts — that gap hid a dead CLI
behind 38 green tests once, and again behind a parameter property in this step.

### Two layouts, kept separate

- **This repo is the app**: `src/core` (no UI imports), `src/cli`, `tests/`, `fixtures/projects/`.
- **A user project** (created by `bench init`): `project.json`, `data/events.jsonl`, `data/raw/`,
  `shapes/`, `views/`, `artifacts/`, `AGENTS.md`, `STATE.md`.
- **Machine-level app state**: `$BENCH_HOME/projects.json` (`~/.bench` by default) — the list a window
  switches between. Disposable: losing it loses recency, never a project.

`views/` is no longer a folder nothing reads. One JSON file per tab, format in
[ADR 0004](adr/0004-views-and-projects.md), rendered by `bench view render` from the stored specs
(no Python), and refreshed explicitly with `--refresh`. The committed fixture ships a two-panel tab
whose staleness is asserted against the committed log, so the example cannot quietly rot.

## Environment (verified 2026-10-18, not assumed)

| tool | version | note |
|---|---|---|
| node / pnpm | 24.9.0 / 11.25.0 | fine |
| rust / cargo | 1.98.0, `x86_64-pc-windows-msvc` | Tauri will build |
| MSVC | VS Community 2022 + VC++ tools | present |
| WebView2 | 155.0.4283.62 | present |
| python / uv | 3.14.2 / 0.13.1 | dev only; analysis env pinned to 3.13 for wheel safety |

No blockers. The full Tauri + embedded-Python chain is buildable on this machine today, which means
the integration risk can be retired in the first step instead of the last.

## My interpretation — correct me where this is wrong

1. **This repo is the app. It is not a data project.** The app opens *project folders* created
   elsewhere by `bench init`. We develop against a fixture project in `fixtures/projects/`.
   (This means [AGENTS.md](../AGENTS.md) currently conflates two layouts — fixed in step 0.3.)
2. **You will mostly drive it by talking to me.** The CLI is the control surface; the app is the
   viewport. In-app manual entry is real but secondary, and "fast" there means the loop, not feature
   count.
3. **"Durable" is a context problem.** A new session should orient from `STATE.md` + `bench`, not
   from chat history or your memory of what we decided.
4. **The data model adapts at two layers only:** point shape (versioned, migrated, recorded) and
   analytical model (a recipe parameter). Storage never changes.
5. **Every number on screen traces to an event.** Derived values are labeled as derived, forever.
6. **Honesty beats beauty when they conflict:** bands, n, DOF, and verdicts always ship together with
   the curve. A pretty chart that implies false certainty is a defect.
7. **"Fast" means a sub-100 ms feedback loop and small reviewable steps** — not rushing the data
   model. I will not trade correctness in the log or the statistics for schedule.

## How every step is gated

- **Size**: one capability, ≤ ~400 line diff, reviewable in ~10 minutes.
- **Tests**: logic gets a test that would fail if the behavior regressed. Stats get numeric
  assertions against closed-form or reference values, not shape checks.
- **Perf harness exists from step 4 and never regresses**: `pnpm app:measure` measures
  keystroke→paint at 10k points in the real window and exits non-zero when the median is over budget;
  it also fails when no full-redraw sample arrived, when that sample was patched, or when an entry
  was submitted programmatically.
- **Visual steps**: a frame at 100/125/150% plus a readable row when one is produced, logged in
  [ui-review-log.md](ui-review-log.md). **Direction 2026-10-21: review is advisory, not a gate.** A
  step is done when the code is green and the states behave; the user reports defects from use, and
  each report becomes a roadmap row. Capture and measure harnesses open a window that takes focus, so
  they run only when the machine is free.
- **`bench check` green** at the end of every phase.

---

## Phase 0 — decisions and skeleton (one sitting)

**0.1 Lock the three open decisions** (see questions at end): UI framework, first milestone shape,
v1 entry scope. Written into an ADR so they are never relitigated.

**0.2 Scaffold the repo.** Single package, no premature monorepo:

```
package.json            pnpm scripts: dev, test, check, perf
tsconfig.json
src/core/               event log, shapes, binder, index — pure TS, zero UI imports
src/cli/                bench
src/ui/                 app shell, entry bar, chart canvas
src-tauri/              Rust shell + MSI config
fixtures/projects/      dev project(s), incl. the ugly ones
bench/perf.ts           latency harness
recipes/                Python analysis
docs/
```

**0.3 Fix AGENTS.md** to separate *app repo layout* from *project folder layout*. Right now it
describes a project as if it were the repo.

**0.4 ADR 0002** recording the framework + entry-scope decisions.

Gate: `pnpm test` runs (one trivial test), `pnpm tauri dev` opens a blank window.

## Phase 1 — walking skeleton: prove the whole chain

The point of this phase is that the riskiest thing (Tauri ↔ TS store ↔ file log ↔ live redraw) is
proven end-to-end before any of it gets elaborate.

**1.1 Event log core.** Append-only JSONL writer with fsync-safe append, ULID ids, reader that
tolerates a torn final line, and an invariant test suite (never rewrites, stable ordering,
concurrent-append safety).

**1.2 `bench init` / `bench add` / `bench state` (minimal).** Init scaffolds a project folder with
`AGENTS.md` + empty log + a first shape. Add appends one point. State prints a short brief.

**1.3 App window reads the log.** Open a project, list points, draw them on a canvas. No styling
beyond tokens.

**1.4 Entry bar.** Type `x  y`, Enter, point appended, chart updates, focus stays. Wire
`bench/perf.ts` and measure it honestly.

Gate (as rewritten 2026-10-21): a frame at three scalings, when the machine is free, plus the perf
number — the number is the check. This is the "it's alive" moment; review is advisory, so it does not
wait on a verdict.

## Phase 2 — make the truth trustworthy

**2.1 Shapes registry + validation.** Unknown field names become warnings, not silent splits.
**2.2 Corrections and retractions.** `supersedes` chains; the reader resolves current state; UI edits
append instead of mutating.
**2.3 Binder + SQLite index.** Rebuild from log, content hash, `bench check` verifies log↔index
agreement.
**2.4 Dataset versions + replace + diff.** Immutable versions, `+n −n ~n` diff, stale markers.
**2.5 Fixture matrix.** 2 points, 5 points, 1e5 points, duplicate timestamps, out-of-order entry,
retractions, unicode, missing values, garbage paste, mixed shape versions. Tests run over all of them.

Gate: fixture matrix green; `bench check` catches a deliberately corrupted log.

## Phase 3 — analysis worth trusting

**3.1 Python runner.** Long-lived process, JSON-RPC over stdio, `uv`-pinned 3.13 env, warm at launch,
crash isolation (charts keep working).

**3.2 One recipe done properly.** Polynomial fit with prediction band, DOF, and verdict, including
the exact-by-construction case. Numeric tests against known least-squares results.

**3.3 Cache, debounce, cancel.** Results keyed by `(recipe, params, data hash)`; recompute ~250 ms
after entry settles; slider refits cancel the previous request.

**3.4 Two more recipes.** Windowed/local fit and changepoint detection — both with uncertainty, both
tested on synthetic data with a *known* changepoint.

Gate: verdict correctness demonstrated on 2-, 3-, and 40-point fixtures; perf still under budget with
the runner alive.

## Phase 4 — product surface and shipping

**4.1 Views as JSON + tabs + panel grid.** The agent can write a tab; the UI renders it.
**4.2 Project switcher** and file association so double-clicking a project opens it.
**4.3 Import/paste** (Excel TSV is the format people actually have), plus inline correction.
**4.4 States and polish**: empty, loading, error, single-point; keyboard map; DPI pass; no layout
shift on update.
**4.5 MSI packaging** and a smoke test on a clean user profile.

Gate: the window at its best and the checks green (review is advisory as of 2026-10-21; defects reported
from use become roadmap rows), then an installer you can run.

---

## Deliberately not building

Cloud sync, multi-user, mobile, in-app chatbot, plugin marketplace, 3D, spreadsheet formulas, a web
deployment. Any of these would be a different project.

## What would change this plan

- **Writing from the UI turns out slow** through a single append path → in-process library, ADR.
- **Python startup or IPC adds visible latency** → move the first fit into TS as a stopgap.
- **10k points don't hit the re-render budget** → renderer swap (canvas → WebGL) before more recipes.
- **A real dataset of yours contradicts the shape model** → fix the shape model before Phase 3.

## First commands, after the three decisions

```bash
pnpm init && pnpm add -D typescript vitest @tauri-apps/cli
# scaffold src/core, src/cli, src/ui, src-tauri
pnpm test          # log invariants
pnpm tauri dev     # blank window
```
