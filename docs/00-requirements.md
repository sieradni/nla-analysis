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
9. **The window speaks to the person; the log speaks to the agent.** Record ids, event names, dataset
   and shape ids, versions and hashes are agent vocabulary. The window shows values, units, what
   changed and what to do; an id is available by copying it, never as the primary label
   ([ADR 0015](adr/0015-user-surface.md)).
10. **Everything is recoverable; not everything is recorded.** Undo and redo cover every reversible
    action. The log keeps corrections and retractions, but the window does not ask for a reason for a
    routine mistake or narrate the event it wrote. Integrity is the agent's job; recoverability is the
    window's.

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

Types as built: `project_created`, `shape_defined`, `shape_extended`, `shape_time_designated`,
`dataset_created`, `dataset_version_created`, `point_recorded`, `point_corrected`,
`point_retracted`, `point_restored`, `import_completed`, `analysis_run`, `decision_recorded`.

`dataset_replaced` was superseded by `dataset_version_created` ([ADR
0012](adr/0012-dataset-versions.md)). Views record no events at all ([ADR
0004](adr/0004-views-and-projects.md)), and a note or tag travels on the point event rather than in
separate `note_added`/`tag_added` events.

**Built 2026-10-20:** `point_restored`, the inverse of a retraction, so undoing a removal brings the
same record back instead of re-recording its values under a new id. It names the retraction it
reverses and repeats none of the record's values, and it is the only event the user surface added
([ADR 0016](adr/0016-point-restore.md), roadmap U5).

A point carries: `dataset`, `shape`, `values{}`, `t_observed`, `version`, `note`, `tags`; a
correction names the point it `supersedes`. `sources` and `confidence` are not in the model. They
were specified and never decided; adding either is a new decision, not an existing promise.

**`t_observed` is first-class and distinct from `at` (recording time).** Conflating them makes
"does this drift over time" unanswerable. An import never fills the time from `at` or the moment of
import; it either uses a column in the file or says out loud that it is using the row order as an
estimate. **Changed 2026-10-20** ([ADR 0015](adr/0015-user-surface.md)): the previous rule refused a
file with no time column. The rule is now *state the assumption, make it correctable* — an untimed
import is allowed with an explicit `estimated` marker, and a real observation time can replace it
from the window. The window's sheet preselects the column it believes, says so in one line, and offers
**Change**; it does not make the person choose before it will plan. An agent importing on the user's
behalf states the column (or the estimate) and asks before writing (U23). A single `bench add` may
omit `--at`; it is stamped once, at the moment it is recorded.

A shape may instead designate one of its own fields as the observation time ([ADR
0014](adr/0014-observation-time.md)). Once it does, that field is the only source: `bench add`,
`bench correct` and both import doors canonicalise its value to UTC and use the same instant for
`t_observed`, so the field and the instant cannot disagree. An explicit `--at` or a second import
time column is still accepted when it names the same instant, and refused when it does not. Shapes
that designate nothing, and events written before a designation, keep the rules above exactly; a
designation never rewrites a point.

### 3.3 Shapes

Shapes are declared by `shape_defined` events in the log, so there is no separate registry file that
can drift out of sync with the data. A shape is referenced by id (`reading.v1`). Extending one
([ADR 0013](adr/0013-shape-extension.md)):

- appends `shape_extended` with the complete next declaration and the one appended field,
- bumps the version (`reading.v1 → reading.v2`), and
- moves the dataset to the new declaration while every old point keeps the shape id it was recorded
  with.

There is no backfill and no upcast. A field added later has no value on older points, and a query
reports it as absent rather than inventing `null` or a default; that is the observable form of
"never mix observed and derived values". A rename, retype, unit change or reorder is refused: it is a
different shape, not an extension.

A shape may designate a required `instant` field as its observation time ([ADR
0014](adr/0014-observation-time.md)). The declaration is its own event, `shape_time_designated`,
and its own version: the field list is unchanged, the dataset moves to the new declaration, and
every existing point keeps the shape it was recorded with. `bench shape designate <id> --time-field
<name>` is the only door. An extension preserves the designation; moving it is refused because it
would reinterpret points already written. With a designation in place, the field is not a second
opinion about the time: it is the time, canonicalised in the row and in `t_observed` together.

Every field name used by an event is validated against the declaration that was current when the
point was recorded. A typo becomes a warning from `bench check`, not a silently split dataset, and
a later extension cannot make an older row retroactively incomplete.

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

A **view** is JSON: a grid of panels, each `{dataset, version|latest, query, x_field?, y_field?, chart
spec, recipe?, params}`. A tab is a view. Views are files, so the agent writes and the UI renders the
same artifact. A plain plot may name its fields; absent `x_field`/`y_field` mean the historical `x`
and `y`.

**Implemented** ([ADR 0004](adr/0004-views-and-projects.md)): one file per tab in `views/<slug>.json`,
written by `bench view new|add|save` and read by `bench view show|render`. A panel stores the question
(`dataset`, `version`, `query`, `x_field`/`y_field`, `recipe`, `params`) *and* the answer (`chart`,
`verdict`, `n`), plus
fingerprints of the rows and recipe it consumed — so a saved tab renders without Python, and still says
when it has gone stale. `query` selects rows (`field`/`op`/`value`, all clauses required) and never
computes: anything derived belongs in a recipe, where it is hashed and reported. `version` pins the
version the panel was drawn from; a hand-written view may say `latest`
([ADR 0012](adr/0012-dataset-versions.md)). Projects are listed by `bench projects` from a
machine-level registry, so a window has something to switch between.

Charts are a **restricted declarative spec** (select → transform → marks → encodings), rendered by
the core as SVG — diffable, agent-authorable, undoable, and fast enough at 10k points. The window
paints the marks on a canvas between two halves of that SVG, so the artifact stays one document and
a rescale does not build ten thousand nodes (plan 5.6). Escape hatch: a raw component for exotic
visuals. Keep the renderer swappable; don't marry Vega-Lite and then die on performance.

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

In the window, the verdict word carries a hover sentence in consequences — why it is uncertain, what
would strengthen it, and what the reader can do — because the four words above are log vocabulary
([ADR 0015](adr/0015-user-surface.md), U12). A panel that is up to date shows no badge; a badge exists
to ask for an action, not to say "everything is fine".

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
correction by selecting a mark are in use. Auto-advance, paste-TSV preview and stream mode are **not
built**; the plan's progress table records them as not done. `Ctrl+Z` in an empty bar reverses the later of the last point added here and the last point removed
from this tab, and `Esc` cancels a correction ([plan](02-implementation-plan.md)).

**Undo and redo (decided 2026-10-20, [ADR 0015](adr/0015-user-surface.md)):** one history covers add,
remove, correct, tab create/delete and import; `Ctrl+Z`, `Ctrl+Shift+Z` and `Ctrl+Y`; visible buttons
naming the action. A removed point is restored by `point_restored` — the same record, not a lookalike
([ADR 0016](adr/0016-point-restore.md)) — and **that part is built**: remove from a point's menu,
undo from the status line or the keyboard, redo to remove it again. The rest of the history (a
correction's undo, tab create/delete, an import's restore version) is not built yet (roadmap U4).
Text fields keep their own undo while focused.

**Buttons, not commands (decided 2026-10-20):** every action a person needs is reachable from the
window. A CLI command may appear only inside a collapsed "for agents" detail, never as the only way
forward. A state the window can fix cheaply and safely is fixed automatically — a stale plot panel
refreshes after a write; a stale recipe panel offers **Refresh** and says why it will not rerun by
itself. The empty first tab and the empty project offer **Add a point**, **Create a tab…** and
**Import…**, not `bench init` or `bench add` (roadmap U21/U22).

- Always-focused entry bar: `1.2  3.4` + Enter commits, focus stays.
- Auto-advance, `Tab`/`Shift+Tab`, `Ctrl+Z`, `Esc` to amend the last point, timestamp editable inline.
- Paste TSV from Excel with preview + confirm (this is the format people actually have).
- Stream mode: one text box, one line per point, commit on blur — for transcribing notebooks.
- Optimistic append; derivation in a worker.
- Inline edit emits `point_corrected`, never mutates.

Targets: keystroke→paint < 100 ms; re-render < 50 ms at 10k points; cold start < 1.5 s;
100 points in under 60 s.

**Measured 2026-10-19** in the window (`pnpm app:measure`, 10,000 points, one plot panel, eight typed
points per run): keystroke→paint a median of **22.2–25.8 ms** across runs (p90 28.0–32.4 ms) when the
point lands inside the axes the tab already draws — the log append is 12–16 ms of it, the mark rebuild
0.1–0.2 ms, and the paint 2–9 ms. A point that *rescales* the axes is a full redraw at **35.1–47.4 ms**
across runs (rebuild 12–18, paint 11–14), **within the 50 ms re-render budget**: the marks are painted
on a canvas between two halves of the core's SVG, so ten thousand observations cost one draw rather
than ten thousand DOM nodes. The pre-canvas renderer took 147.0–173.6 ms for the same sample, which is
what triggered the change. The tab's saved file catches up 20–22 ms after the paint, off the keystroke
path. `pnpm app:measure` now exits non-zero when either budget misses, when no full-redraw
sample arrived, when the window patched a rescale instead of redrawing it, or when an entry had to be
submitted programmatically rather than typed. See
[ADR 0006](adr/0006-window-write-path.md) and the evidence table in
[03-roadmap.md](03-roadmap.md#verified-on-this-tree-2026-10-19).

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
| charts | restricted declarative spec; the core's SVG for axes, grid, fits and labels, zoom/pan by `viewBox`, and the marks on a canvas between the two SVG halves (37–43 ms for a 10k rescale, 2026-10-19). `bench chart` still writes the whole drawing as one SVG | **in use** (`bench chart`, the window) |
| analysis | **Python** sidecar, pinned env, JSON envelope, no Python in the entry path | **in use** (`bench run`) |
| storage | JSONL event log (truth) | **in use** |
| index | SQLite derived projection | deferred until a measured query is slow |
| shapes | declared by log events, validated on write | **in use** (extend and observation-time designation; value migrations not built) |
| agent | repo agent only; no in-app LLM, no API keys in the hot path | **in use** |

Windows from day one: DPI at 100/125/150/200% and fractional scaling, long paths, CRLF tolerance.
**Not built**: Excel-clipboard tables (deferred with paste, §6), Start-menu launch and the file
association that opens a project on double-click (deferred with the installer, plan 5.7).

---

## 10. Quality process

- **Definition of done** per step: works + tests + screenshot at 100/125/150% + keyboard-only pass +
  error/empty state + perf check + no silent new dependency.
- **UI approval is a gate.** Every visual step ends with a screenshot and a readable row — screen,
  check, wrong looks like, your call — under the protocol in `docs/ui-review-log.md`. The user approves;
  the agent never self-approves visuals. **Changed 2026-10-20:** the user may close a batch of frames
  by stating a direction instead of approving each one; that is recorded with their words and is a
  decision about the direction, not a claim that every pixel was inspected. New frames still follow
  the readable protocol.
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

**Resolved 2026-10-20** by [ADR 0015](adr/0015-user-surface.md): the window's vocabulary, undo/redo
coverage, removal without a reason prompt, the import-time confirmation model, the review gate, tab
deletion, UI preferences, and shape display labels. The itemised list is
[05-user-surface.md](05-user-surface.md) §8; the work is [03-roadmap.md](03-roadmap.md) §6.

Still open:

1. How much of `STATE.md` is generated versus written by the agent?
2. When does an in-memory projection stop being enough and SQLite start earning its keep?
