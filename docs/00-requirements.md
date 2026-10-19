# Requirements — "Bench" (working title)

A durable data-analysis workspace driven by a coding agent.

---

## 1. What this is

Not a data-entry app with a chat sidebar. Three separable pieces:

| piece | role |
|---|---|
| **The log** (`data/events.jsonl`) | append-only truth. Never rewritten. |
| **The CLI** (`bench`) | the control surface — the agent's hands. Every mutation is a command. |
| **The app** (Electron, [ADR 0005](adr/0005-desktop-shell.md); originally planned as Tauri) | the viewport — eyes on live project state. Plus optional fast manual entry. |

The scenario this exists for: *"ask an agent to analyze and graph something, except it's durable —
new points can be added over time, and you don't have to re-explain the project every session."*

Therefore the hard problems, in order of importance:

1. **Cold-start context** — a fresh agent session must become fully oriented in seconds. (§7)
2. **Adaptation without drift** — the data model must flex per request without making last month's
   data uninterpretable. (§3)
3. **Honesty** — a curve is never shown without its uncertainty and its degrees of freedom. (§5)
4. **Durability of requests** — an answer is a re-runnable artifact, not a paragraph. (§7)
5. Entry speed — real, but secondary. The agent often adds the point.

---

## 2. Principles

1. **The log is truth.** Nothing is overwritten; corrections are new events. Undo, audit, and
   "what did we believe at the time" all fall out of this for free.
2. **Agent is the operator, the app is the viewport.** The app never holds state the log doesn't.
3. **Weak schemas, strong conventions.** Storage is schema-less; point shapes are versioned; both
   are enforced by a `bench check` validator rather than by a rigid relational database.
4. **Observed ≠ derived.** Points a human or an import produced and values a model produced live in
   different namespaces forever. Fitted values never enter the dataset.
5. **Every chart shows its evidence.** n, DOF, interval band, verdict badge. (§5)
6. **No Python in the entry path.** Typing a number never waits on an interpreter or a model.
7. **Never destroy a dataset version.** Replacing data is a new version with a diff.
8. **Guidelines over gates.** AGENTS.md + STATE.md shape each new session; they don't police it.

---

## 3. Data model

### 3.1 Three layers, three different rates of change

Conflating these is the main trap. "The data model adapts" is true for layers 2 and 3, never for 1.

| layer | changes | mechanism |
|---|---|---|
| **1. Storage** | never | events with a sparse `values` map |
| **2. Point shape** (fields, units, semantics) | occasionally | registry + versioned migration |
| **3. Analysis model** (linear, exponential, state-space, seasonal, …) | constantly | a recipe *parameter* |

Most natural-language adaptation is layer 3 and requires no schema work at all. Layer 2 changes are
explicit, recorded, and reversible.

### 3.2 Event log

One JSON object per line: `{v, id (ULID), type, at, session, payload}`.

Types as built: `project_created`, `shape_defined`, `dataset_created`,
`dataset_version_created`, `point_recorded`, `point_corrected`, `point_retracted`,
`import_completed`, `analysis_run`, `decision_recorded`.

`shape_extended` arrives with shape extension (deferred, §3.3 and plan 2.2). `dataset_replaced` was
superseded by `dataset_version_created` ([ADR 0012](adr/0012-dataset-versions.md)). Views record no
events at all ([ADR 0004](adr/0004-views-and-projects.md)), and a note or tag travels on the point
event rather than in separate `note_added`/`tag_added` events.

A point carries: `dataset`, `shape`, `values{}`, `t_observed`, `version`, `note`, `tags`; a
correction names the point it `supersedes`. `sources` and `confidence` are not in the model. They
were specified and never decided; adding either is a new decision, not an existing promise.

**`t_observed` is first-class and distinct from `at` (recording time).** Conflating them makes
"does this drift over time" unanswerable. An import must name a time column in both doors — `bench import` refuses a file without
one, and the window's sheet asks for it — never filled from `at` or the moment of import. A single
`bench add` may omit `--at`; it is stamped once, at the moment it is recorded.

### 3.3 Shapes

Shapes are declared by `shape_defined` events in the log, so there is no separate registry file that
can drift out of sync with the data. A shape is referenced by id (`reading.v1`). Extending one
(specified, **not built yet** — only shape definition and validation exist today):

- appends `shape_extended` with the new field and a backfill rule (`null` | `const` | transform),
- writes a migration under `migrations/`,
- bumps the version (`reading.v1 → reading.v2`).

Old events keep their original shape. The **binder** upcasts everything to the current version and
records where each value came from, so a query for a post-migration field reports
*"n=0 before 2026-10-18"* instead of pretending the field always existed.

Every field name used by an event is validated against the registry. A typo becomes a warning from
`bench check`, not a silently split dataset.

### 3.4 Dataset versions

A dataset is an immutable sequence of versions recorded in the log itself: `dataset_version_created`
names the source file, its hash, the row count, the parent and the row-level diff. There is no
directory of manifests — a past version is rebuilt by folding the log to its cut
([ADR 0012](adr/0012-dataset-versions.md)), so the old version is readable without a second copy of
the data on disk.

- **Replace** ("here's the updated export") is `bench import` into a populated dataset: it appends a
  version with a parent and prints the diff (`+120 −3 ~8 rows`). A separate `bench dataset replace`
  command is not built; the importer is the replace surface
  ([ADR 0011](adr/0011-import-door.md), [ADR 0012](adr/0012-dataset-versions.md)).
- **Add point** → a point event in the current version, not a new version. Both are cheap and both are
  recorded.
- Analyses pin `(dataset, version)`: the `analysis_run` records the version it read alongside hashes of
  the exact points and the recipe file. `bench runs` and `STATE.md` then answer *still current* /
  *stale: 2 point(s) added* / *stale: the dataset moved on to version N* / *cannot be checked* without
  recomputing anything, and `bench rerun <recipe>` repeats a run with its recorded parameters.
- Panels pin the version they were materialized from, so a tab drawn before an import shows the
  **stale** badge and names the version it came from. A hand-written view may still say `latest`.

Nothing about the old version is ever mutated, so "what did last week's conclusion rest on" stays
answerable.

### 3.5 Derived state

`index.sqlite` is specified and **not built**. Querying and plotting read the in-memory projection
the binder produces from the log; SQLite stays deferred until a measured query is slow (plan 2.3 and
the open question in §14). A project today has no `index.sqlite`.

---

## 4. Views

A **view** is JSON: a grid of panels, each `{dataset, version|latest, query, chart spec, recipe?,
params}`. A tab is a view. Views are files, so the agent writes and the UI renders the same artifact.

**Implemented** ([ADR 0004](adr/0004-views-and-projects.md)): one file per tab in `views/<slug>.json`,
written by `bench view new|add|save` and read by `bench view show|render`. A panel stores the question
(`dataset`, `version`, `query`, `recipe`, `params`) *and* the answer (`chart`, `verdict`, `n`), plus
fingerprints of the rows and recipe it consumed — so a saved tab renders without Python, and still says
when it has gone stale. `query` selects rows (`field`/`op`/`value`, all clauses required) and never
computes: anything derived belongs in a recipe, where it is hashed and reported. `version` pins the
version the panel was drawn from; a hand-written view may say `latest`
([ADR 0012](adr/0012-dataset-versions.md)). Projects are listed by `bench projects` from a
machine-level registry, so a window has something to switch between.

Charts are a **restricted declarative spec** (select → transform → marks → encodings), rendered by
the core as SVG today — diffable, agent-authorable, undoable, and fast enough at 10k points except
when a point rescales the axes. Canvas is the measured next step and is not built (plan 5.6). Escape
hatch: a raw component for exotic visuals. Keep the renderer swappable; don't marry Vega-Lite and
then die on performance.

---

## 5. The honesty layer

The flagship scenario — two points, find the curve, tell me if it changes over time — is exactly
where software lies most easily. Two points fit every two-parameter model exactly. Three points fit
every quadratic exactly. A confident parabola through three points is a lie the interface told you.

Every analysis artifact therefore carries a machine-checkable verdict:

| verdict | meaning |
|---|---|
| `insufficient` | free parameters ≥ data points; the answer is unconstrained |
| `tentative` | identifiable, but wide intervals or no out-of-sample support |
| `supported` | beats a null model on held-out / information-criterion grounds |
| `contradicted` | a competing model or the null wins |

**Implemented** in `recipes/fit.py`: `insufficient` when DOF ≤ 0 (no curve drawn at all), otherwise an
F test against a mean-only model decides `contradicted` / `tentative` / `supported`, with a higher-degree
term whose interval spans zero downgrading a fit to `tentative`. Charts carry the verdict, n, DOF and
the band in the footer, plus the conclusion written on the artifact as a caption.

Panels always show n, parameters, DOF, an uncertainty band (not a bare line), and the verdict.
Residuals are computed by the fit and returned in its diagnostics, but no residual panel is built;
that display has no decision behind it and is deferred. Exact-by-construction fits say so in words:
*"3 points, 3 parameters — this fit tells you nothing yet. Add a fourth point to constrain it."*

### Time-variation menu

- **Parameter vs time** — fit in windows, plot coefficients with error bars. Clearest answer. *Not built.*
- **Rolling / local fit** — window size and order as live sliders; cancellable refits. *Not built.*
- **Changepoint detection** — **implemented** as `recipes/drift.py`. It splits the series in time and
  asks whether two lines beat one. When the split is chosen from the data it reports a permutation
  p-value, because selecting the split and then testing at it inflates significance; when the caller
  names the split in advance it uses the textbook Chow test. It reports the split to the day, not a
  bare vertical line, and it says explicitly that a changepoint is not a cause.
- **Residual diagnostics** — runs test, CUSUM. Cheap; catches drift a fit masks. *Not built.*
- **State-space / Kalman** — when parameters should wander smoothly. *Not built.*
- **Model comparison** — AIC/BIC/LOO, so "it curves more than it used to" is measured. *Not built.*

Promise *a menu of legitimate tests with visible uncertainty* — not "hidden pattern detection."

---

## 6. Entry ergonomics

Per [ADR 0002](adr/0002-agent-only-v1.md), v1 was agent-only: points arrive through `bench add`. The
window has since landed, and part of this list with it: the always-focused bar, optimistic append, and
correction by selecting a mark are in use. Auto-advance, paste-TSV preview, stream mode and
`Ctrl+Z`/`Esc` shortcuts are **not built**; the plan's progress table records them as not done
([plan](02-implementation-plan.md)).

- Always-focused entry bar: `1.2  3.4` + Enter commits, focus stays.
- Auto-advance, `Tab`/`Shift+Tab`, `Ctrl+Z`, `Esc` to amend the last point, timestamp editable inline.
- Paste TSV from Excel with preview + confirm (this is the format people actually have).
- Stream mode: one text box, one line per point, commit on blur — for transcribing notebooks.
- Optimistic append; derivation in a worker.
- Inline edit emits `point_corrected`, never mutates.

Targets: keystroke→paint < 100 ms; re-render < 50 ms at 10k points; cold start < 1.5 s;
100 points in under 60 s.

**Measured 2026-10-19** in the window (`pnpm app:measure`, 10,000 points, one plot panel, eight typed
points): keystroke→paint a median of **24.6 ms** (p90 40.1 ms) when the point lands inside the axes the
tab already draws — the log append is 14.1 ms of it, the mark rebuild 1.1 ms, and the paint 8.8 ms. A
point that *rescales* the axes is a full redraw at 133.8 ms, which is over this budget and is the
measured trigger for the canvas renderer. The tab's saved file catches up 33.6 ms after the paint,
off the keystroke path. See [ADR 0006](adr/0006-window-write-path.md).

---

## 7. Agent interface

### 7.1 The CLI is the API

`bench` is the single control surface: used by the agent, by scripts, and by the app itself. Rules
that make it agent-safe: every command is non-interactive, fails with an actionable message and a
meaningful exit code, and every command that returns data has `--json`. **As built**, `--dry-run`
exists on `import` only; `--dry-run` on the other mutating commands and the optional `--id` for
idempotent retries are specified and not implemented (`docs/01-agent-interface.md` names the gap).

### 7.2 Recipes

A recipe is a Python module with a declared schema:

- typed params with defaults and bounds → the UI renders controls automatically,
- declared inputs (dataset, version, fields) and outputs,
- returns an envelope: `{data, chart, verdict, diagnostics, narrative}`.

Each `analysis_run` records recipe id + content hash, params, input hash, output path, verdict, and
interpretation. The per-run environment lock is **not recorded**; the environment is pinned at the
app level by `recipes/requirements.lock.txt`, which is not yet the same guarantee. Because inputs are
pinned by hash, "re-run on new data" is one command and legitimately updates the graph.

Recipes are what stop a project from rotting into two hundred one-off scripts.

### 7.3 Cold-start context

The failure mode of "durable over time" is a new session that re-litigates everything. Solved with
two generated documents:

- **`STATE.md`** — auto-generated by `bench state`: datasets + current versions + shapes, views and
  what they show, analyses with verdicts, open questions, recent decisions, stale analyses.
  Regenerated on every mutation, so it cannot go stale.
- **`AGENTS.md`** — the standing working agreement (step size, UI gate, non-negotiables).

A new session reads those two files and is oriented in ~2k tokens. Everything else is discovered
through `bench`, which is why the CLI must answer "what's here?" in one call.

### 7.4 What the agent may and may not do

| may | may not |
|---|---|
| append events through `bench` | edit `data/events.jsonl` directly |
| add/extend shapes via migration | mutate `data/raw/` |
| write recipes and views | delete a dataset version |
| re-run analyses | put analysis in the entry path |

---

## 8. Runtime architecture

**Python computes. TypeScript renders. JSON is the contract.**

```
Electron shell (Node main process)          [ADR 0005; was: Tauri shell (Rust)]
├── WebView renderer ── draws the core's chart specs; hover, pan, zoom; tabs
├── src/core (TS, bundled) ── the same seam the CLI wraps; no second write path
├── bench CLI (TS)  ── argument parsing over that seam
└── runner (Python, long-lived) ── JSON-RPC over stdio, cancellable
```

The shell hosts the core **in process** ([ADR 0003](adr/0003-in-process-core.md), measured at 15.7 ms
per keystroke against a 160 ms floor for starting a command), so the core imports directly into the
main process rather than being reached through a subprocess. [ADR 0005](adr/0005-desktop-shell.md)
weighs Electron against Tauri-with-a-Node-sidecar and records the costs it accepted.

- Embedded CPython via `python-build-standalone`, deps via `uv` + lockfile. No system Python.
- Runner speaks newline-delimited JSON: request `{id, kind, recipe, params, input}` → response
  envelope echoing `id`. The client keeps one process alive for many requests; the CLI currently
  starts one per command, which is enough without an interactive surface.
- **Cancellation is specified but not implemented.** Live slider refits will need it, and it will
  need a worker or thread on the Python side, since the loop is strictly sequential today.
- Results cached by `(recipe hash, params hash, data hash)` → re-render is instant; recompute is
  debounced ~250 ms after entry settles. **Not built**: every run recomputes (plan 3.3).
- Runner crash degrades to "charts work, analysis panel shows stale + reason."

Costs accepted: ~120MB bundled runtime, a second language, IPC, Windows packaging/signing care.
Bought: mature numerics (scipy/statsmodels/sklearn/pymc/pandas), and an agent writing real,
reviewable code instead of a hand-rolled TypeScript statistics library.

---

## 9. Stack (decided)

| concern | choice | status |
|---|---|---|
| shell | **Electron** ([ADR 0005](adr/0005-desktop-shell.md)) — the core is TypeScript and must run in process; ~370 MB dev install, ~490 MB working set, no installer built yet. Tauri 2 was the earlier plan; it needs a Node sidecar to host this core | **in use, unbuilt for distribution** (`pnpm app`) |
| UI | hand-written HTML/CSS/JS in `app/renderer`, no framework yet. Svelte 5 remains the plan if the renderer outgrows it | **in use**: projects, tabs, hover, pan/zoom, point entry and undo |
| charts | restricted declarative spec; the core's SVG today, zoom/pan by `viewBox`, and a typed point drawn as one mark the core placed — canvas when a measurement says so (133.8 ms for a rescale) | **in use** (`bench chart`, the window) |
| analysis | **Python** sidecar, pinned env, JSON envelope, no Python in the entry path | **in use** (`bench run`) |
| storage | JSONL event log (truth) | **in use** |
| index | SQLite derived projection | deferred until a measured query is slow |
| shapes | declared by log events, validated on write | **in use** (extend/migrate not built) |
| agent | repo agent only; no in-app LLM, no API keys in the hot path | **in use** |

Windows from day one: DPI at 100/125/150/200% and fractional scaling, long paths, CRLF tolerance.
**Not built**: Excel-clipboard tables (deferred with paste, §6), Start-menu launch and the file
association that opens a project on double-click (deferred with the installer, plan 5.7).

---

## 10. Quality process

- **Definition of done** per step: works + tests + screenshot at 100/125/150% + keyboard-only pass +
  error/empty state + perf check + no silent new dependency.
- **UI approval is a gate.** Every visual step ends with a screenshot and a two-line "what to look
  at" note. The user approves; the agent never self-approves visuals. Log in `docs/ui-review-log.md`.
- **Small steps**: one user-visible capability, aim ≤ ~400 line diff, reviewable in 10 minutes.
- **ADRs** for irreversible choices (shell, storage, chart contract, stats runtime) in `docs/adr/`.
- **Design tokens** in one file (color, spacing, type scale, radii, motion). Prevents visual drift.
- **Numeric assertions** on fits against closed-form references — in place. **Golden chart snapshots
  are not built**; no decision record exists for them.
- **Fixture datasets — partly built**: the committed drift-sensor project and the duplicate-time and
  re-export cases. 2-point, 1e5-point, unicode, missing-value, garbage-paste and post-migration
  fixtures are **not built** (plan 2.5, not done).

---

## 11. Non-goals for v1

Cloud sync, multi-user, mobile, plugin marketplace, in-app chatbot, 3D plots, spreadsheet formulas,
unbounded per-project dependency installs.

---

## 12. Risks

1. **Schema drift** — the adaptive model becoming uninterpretable. Mitigated by §3.3 + `bench check`.
2. **Stats theater** — beautiful curves that mean nothing. Mitigated by §5 and numeric tests.
3. **Cold-start rot** — STATE.md drifting from reality. Mitigated by generating it, never writing it.
4. **Session fragmentation** — each session inventing its own conventions. Mitigated by AGENTS.md.
5. **Two-language surface** — more places for the agent to go wrong. Mitigated by making the CLI the
   only mutation path.
6. **Pitch inflation** — "hidden patterns" is a research project; "a legitimate test with visible
   uncertainty" is a product.

---

## 13. Slices

**Superseded** by [02-implementation-plan.md](02-implementation-plan.md), which phases the work as
walking skeleton → truth → analysis → surface, and defers the UI per [ADR 0002](adr/0002-agent-only-v1.md).
Kept below only as the original proposal; the plan is the authority.

1. Event log + shapes + binder + SQLite index + `bench` core (`init/add/state/check`) — no UI. Tests.
2. Tauri shell + one live chart panel + entry bar + screenshot review.
3. Dataset versions + replace/diff + stale analysis badges.
4. Python runner + 3 recipes (fit with bands, windowed fit, changepoint) + verdict system.
5. Views as JSON + tab strip + project switcher + import/paste.
6. Polish: keyboard map, DPI, installer, file association, empty states.

---

## 14. Open questions

Resolved: Svelte 5, Python analysis, repo-agent-only operation, Tauri deferred, agent-only v1 entry.

**Resolved 2026-10-19** by [ADR 0003](adr/0003-in-process-core.md): the UI binds `src/core` in
process, and `bench` is a thin wrapper over the same `Workspace` seam. Decided on measurement rather
than preference: a keystroke costs 15.7 ms in process at 10k points, while simply starting a command
costs 160 ms against a 100 ms budget.

Still open:

1. How much of `STATE.md` is generated versus written by the agent?
2. When does an in-memory projection stop being enough and SQLite start earning its keep?
