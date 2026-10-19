# Requirements — "Bench" (working title)

A durable data-analysis workspace driven by a coding agent.

---

## 1. What this is

Not a data-entry app with a chat sidebar. Three separable pieces:

| piece | role |
|---|---|
| **The log** (`data/events.jsonl`) | append-only truth. Never rewritten. |
| **The CLI** (`bench`) | the control surface — the agent's hands. Every mutation is a command. |
| **The app** (Tauri) | the viewport — eyes on live project state. Plus optional fast manual entry. |

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

Types: `project_created`, `shape_defined`, `shape_extended`, `dataset_created`,
`dataset_version_created`, `dataset_replaced`, `point_recorded`, `point_corrected`,
`point_retracted`, `note_added`, `tag_added`, `import_completed`, `analysis_run`, `view_saved`,
`decision_recorded`.

A point carries: `dataset`, `shape`, `values{}`, `t_observed`, `sources`, `note`, `tags`,
`confidence`, `supersedes`.

**`t_observed` is first-class and distinct from `at` (recording time).** Conflating them makes
"does this drift over time" unanswerable. Auto-filled from `at` when omitted, editable.

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

A dataset is an immutable sequence of versions (`datasets/<id>/versions/0003/`), each with a
manifest: source, hash, row count, time span, parent version.

- **Replace** ("here's the updated export") → new version, diff vs parent (`+120 −3 ~8 rows`).
- **Add point** → a point event, not a new version. Both are cheap and both are recorded.
- Analyses pin what they consumed. **As built**, the pin is the content: a hash of the exact points
  the run read, plus a hash of the recipe file, both recorded in the `analysis_run` event. `bench runs`
  and `STATE.md` then answer *still current* / *stale: 2 point(s) added* / *cannot be checked* without
  recomputing anything, and `bench rerun <recipe>` repeats a run with its recorded parameters.
- Once dataset versions exist, the pin becomes `(dataset, version)` and a version behind means the
  same thing the content hash already reports. Views default to latest and show the **stale** badge
  from this same computation.

Nothing about the old version is ever mutated, so "what did last week's conclusion rest on" stays
answerable.

### 3.5 Derived state

`index.sqlite` is a rebuildable projection of the log — never hand-edited, always disposable. All
querying and plotting reads from it. The binder produces a dataset view plus a content hash; that
hash is what analyses pin.

---

## 4. Views

A **view** is JSON: a grid of panels, each `{dataset, version|latest, query, chart spec, recipe?,
params}`. A tab is a view. Views are files, so the agent writes and the UI renders the same artifact.

**Implemented** ([ADR 0004](adr/0004-views-and-projects.md)): one file per tab in `views/<slug>.json`,
written by `bench view new|add|save` and read by `bench view show|render`. A panel stores the question
(`dataset`, `version`, `query`, `recipe`, `params`) *and* the answer (`chart`, `verdict`, `n`), plus
fingerprints of the rows and recipe it consumed — so a saved tab renders without Python, and still says
when it has gone stale. `query` selects rows (`field`/`op`/`value`, all clauses required) and never
computes: anything derived belongs in a recipe, where it is hashed and reported. `version` is only
`latest` until dataset versions exist. Projects are listed by `bench projects` from a machine-level
registry, so a window has something to switch between.

Charts are a **restricted declarative spec** (select → transform → marks → encodings) rendered on
canvas — fast at 10k+ points, diffable, agent-authorable, undoable. Escape hatch: a raw component
for exotic visuals. Keep the renderer swappable; don't marry Vega-Lite and then die on performance.

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

Panels always show n, parameters, DOF, an uncertainty band (not a bare line), residuals, and the
verdict. Exact-by-construction fits say so in words: *"3 points, 3 parameters — this fit tells you
nothing yet. Add a fourth point to constrain it."*

### Time-variation menu

- **Parameter vs time** — fit in windows, plot coefficients with error bars. Clearest answer.
- **Rolling / local fit** — window size and order as live sliders; cancellable refits. *Not built.*
- **Changepoint detection** — **implemented** as `recipes/drift.py`. It splits the series in time and
  asks whether two lines beat one. When the split is chosen from the data it reports a permutation
  p-value, because selecting the split and then testing at it inflates significance; when the caller
  names the split in advance it uses the textbook Chow test. It reports the split to the day, not a
  bare vertical line, and it says explicitly that a changepoint is not a cause.
- **Residual diagnostics** — runs test, CUSUM. Cheap; catches drift a fit masks.
- **State-space / Kalman** — when parameters should wander smoothly.
- **Model comparison** — AIC/BIC/LOO, so "it curves more than it used to" is measured.

Promise *a menu of legitimate tests with visible uncertainty* — not "hidden pattern detection."

---

## 6. Entry ergonomics — deferred to Phase 5

Per [ADR 0002](adr/0002-agent-only-v1.md), v1 is agent-only: points arrive through `bench add`. The
ergonomics below are the target for when the app lands, not a v1 requirement. When it does land,
manual entry must not feel like a compromise.

- Always-focused entry bar: `1.2  3.4` + Enter commits, focus stays.
- Auto-advance, `Tab`/`Shift+Tab`, `Ctrl+Z`, `Esc` to amend the last point, timestamp editable inline.
- Paste TSV from Excel with preview + confirm (this is the format people actually have).
- Stream mode: one text box, one line per point, commit on blur — for transcribing notebooks.
- Optimistic append; derivation in a worker.
- Inline edit emits `point_corrected`, never mutates.

Targets: keystroke→paint < 100 ms; re-render < 50 ms at 10k points; cold start < 1.5 s;
100 points in under 60 s.

---

## 7. Agent interface

### 7.1 The CLI is the API

`bench` is the single control surface: used by the agent, by scripts, and by the app itself. Rules
that make it agent-safe: **every command has `--json`**, supports `--dry-run`, is non-interactive
(never prompts), takes an optional `--id` for idempotent retries, and fails with an actionable
message plus a meaningful exit code. See `docs/01-agent-interface.md`.

### 7.2 Recipes

A recipe is a Python module with a declared schema:

- typed params with defaults and bounds → the UI renders controls automatically,
- declared inputs (dataset, version, fields) and outputs,
- returns an envelope: `{data, chart, verdict, diagnostics, narrative}`.

Each `analysis_run` records recipe id + content hash, params, input hash, environment lock, output
paths, verdict, and interpretation. Because inputs are pinned by hash, "re-run on new data" is one
command and legitimately updates the graph.

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
Tauri shell (Rust)
├── WebView UI (TS) ── reads index.sqlite, renders charts, entry bar
├── bench CLI (TS)  ── append API, validation, state generation
└── runner (Python, long-lived) ── JSON-RPC over stdio, cancellable
```

- Embedded CPython via `python-build-standalone`, deps via `uv` + lockfile. No system Python.
- Runner speaks newline-delimited JSON: request `{id, kind, recipe, params, input}` → response
  envelope echoing `id`. The client keeps one process alive for many requests; the CLI currently
  starts one per command, which is enough without an interactive surface.
- **Cancellation is specified but not implemented.** Live slider refits will need it, and it will
  need a worker or thread on the Python side, since the loop is strictly sequential today.
- Results cached by `(recipe hash, params hash, data hash)` → re-render is instant; recompute is
  debounced ~250 ms after entry settles and streamed in.
- Runner crash degrades to "charts work, analysis panel shows stale + reason."

Costs accepted: ~120MB bundled runtime, a second language, IPC, Windows packaging/signing care.
Bought: mature numerics (scipy/statsmodels/sklearn/pymc/pandas), and an agent writing real,
reviewable code instead of a hand-rolled TypeScript statistics library.

---

## 9. Stack (decided)

| concern | choice | status |
|---|---|---|
| shell | **Tauri 2** — small exe, MSI/NSIS, per-user install, no admin, WebView2 ships with Win10/11 | deferred, Phase 5 |
| UI | **Svelte 5** + Vite | deferred, Phase 5 |
| charts | restricted declarative spec; SVG renderer today, canvas when the app lands — swappable either way | **in use** (`bench chart`) |
| analysis | **Python** sidecar, pinned env, JSON envelope, no Python in the entry path | **in use** (`bench run`) |
| storage | JSONL event log (truth) | **in use** |
| index | SQLite derived projection | deferred until a measured query is slow |
| shapes | declared by log events, validated on write | **in use** (extend/migrate not built) |
| agent | repo agent only; no in-app LLM, no API keys in the hot path | **in use** |

Windows from day one: DPI at 100/125/150/200% and fractional scaling, long paths, CRLF tolerance,
Excel-clipboard tables, Start-menu launch, file association so double-clicking a project opens it.

---

## 10. Quality process

- **Definition of done** per step: works + tests + screenshot at 100/125/150% + keyboard-only pass +
  error/empty state + perf check + no silent new dependency.
- **UI approval is a gate.** Every visual step ends with a screenshot and a two-line "what to look
  at" note. The user approves; the agent never self-approves visuals. Log in `docs/ui-review-log.md`.
- **Small steps**: one user-visible capability, aim ≤ ~400 line diff, reviewable in 10 minutes.
- **ADRs** for irreversible choices (shell, storage, chart contract, stats runtime) in `docs/adr/`.
- **Design tokens** in one file (color, spacing, type scale, radii, motion). Prevents visual drift.
- **Golden snapshots** for charts; numeric assertions on fits against closed-form references.
- **Fixture datasets**: 2 points, 5 points, 1e5 points, duplicate timestamps, out-of-order entry,
  retracted points, unicode, missing values, garbage paste, huge/tiny magnitudes, post-migration mixes.

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
