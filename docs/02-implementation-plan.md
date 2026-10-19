# Implementation plan

Status: Phases 0-3 largely complete (2026-10-19); the shape registry and dataset versions are next.
Supersedes §13 of [00-requirements.md](00-requirements.md) (slices).

## Progress

| step | state | evidence |
|---|---|---|
| 0 decisions + scaffold | done | [ADR 0002](adr/0002-agent-only-v1.md); TypeScript runs directly on Node 24, no build step |
| 0 fix AGENTS.md layouts | done | app-repo vs project-folder layouts separated below |
| 1.1 event log core | done | append-only verified by byte-prefix test; torn tail tolerated |
| 1.2 init / add / state / check | done | `fixtures/projects/drift-sensor` built entirely through the CLI |
| 1.3 chart artifact | done | `bench chart` writes SVG; renderer is a core module, not CLI glue |
| 1.4 entry ergonomics | **superseded** | ADR 0002: v1 is agent-only, so the entry bar moved to Phase 5 |
| 2.1 corrections + retractions | done early | `bench correct` / `bench retract`; original records preserved in the log |
| 2.2 shapes registry + validation | partial | read + validate exist; `shape extend` and migrations do not |
| 3.1 Python runner | done | JSON over stdio, `uv`-pinned 3.13 env, id echoed, crash contained |
| 3.2 one honest fit recipe | done | band, DOF, F test, verdict; refuses to draw when DOF ≤ 0 |
| 3.3 cache / debounce / cancel | **not done** | every run recomputes; fine at this scale, needed for live sliders |
| 3.4 changepoint | done | `recipes/drift.py`: Chow test at a given split, permutation test when the data chooses the split |
| 3.5 analysis freshness + `runs` / `rerun` | done | three states (current / stale / cannot-be-checked) from the recorded input and recipe hashes; `STATE.md` carries it |
| 4.3 csv / tsv / jsonl import | done | all-or-nothing, content-addressed `data/raw/` copy, hash dedupe; 7 CLI tests |
| 4.x views / UI | not done | deferred per ADR 0002 |
| windowed / rolling fit | not done | the third item on the time-variation menu |
| dataset versions / replace / diff | not done | next; `dataset_version_created` is already a log type |
| `shape extend` + migrations | not done | next; shape 2.2 is read-only today |

Verification so far: 103 tests pass and `tsc --noEmit` is clean. `tests/cli.test.ts` runs the actual
binary, which is the only way to catch a difference between what the test runner's transpiler accepts
and what Node's type stripping accepts — that gap hid a dead CLI behind 38 green tests once already.

### Two layouts, kept separate

- **This repo is the app**: `src/core` (no UI imports), `src/cli`, `tests/`, `fixtures/projects/`.
- **A user project** (created by `bench init`): `project.json`, `data/events.jsonl`, `data/raw/`,
  `shapes/`, `views/`, `artifacts/`, `AGENTS.md`, `STATE.md`.

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
- **Perf harness exists from step 4 and never regresses**: `pnpm perf` measures
  keystroke→paint and re-render at 10k points and exits non-zero over budget.
- **Visual steps**: screenshot at 100/125/150% + a two-line "what to look at" note, logged in
  [ui-review-log.md](ui-review-log.md). I never self-approve.
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

Gate: screenshot at three scalings + the perf number, in front of you. This is the "it's alive"
moment and the first real design review.

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

Gate: your approval on the real UI, then an installer you can run.

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
