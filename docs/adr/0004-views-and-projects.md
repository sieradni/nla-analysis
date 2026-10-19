# ADR 0004 — A tab is a view file; projects are a registry of folders

Date: 2026-10-19
Status: accepted; **superseded in part** by [0012](0012-dataset-versions.md) for the `version` field
Related: [0002](0002-agent-only-v1.md) (agent-only v1), [0003](0003-in-process-core.md) (the write path)

## Context

Requirements §4 says a view is JSON — *"a grid of panels, each `{dataset, version|latest, query, chart
spec, recipe?, params}`. A tab is a view. Views are files, so the agent writes and the UI renders the
same artifact."* Until now that folder existed and nothing read it, and "switching projects" meant
typing a different `--project` path. A window cannot list what it has never been told about, and it
cannot draw a tab it cannot parse.

Two questions had to be answered before this could be built:

1. **Does a view store a question or an answer?** Storing only `{recipe, params}` means every repaint
   runs Python; storing only a chart spec means the query that produced it is lost.
2. **Where does "which projects exist" live?** It cannot live in a project, because a project must
   open without any other project's state, and the list has to exist before one is opened.

## Decision

1. **A view is a file: `views/<slug>.json`, schema v1.** Panels carry both halves — what was asked
   (`dataset`, `version`, `query`, `recipe`, `params`) and what was drawn (`chart`, `verdict`, `n`,
   `input_hash`, `recipe_hash`). The spec is materialized, so a tab renders without Python and
   without reading the log; the question is kept, so a tab can be re-asked with `--refresh`.
2. **Rendering never computes.** `bench view render` reads the file and draws it. `--refresh` is the
   explicit act that re-reads the data and re-runs any recipe, and it rewrites the file. A repaint
   cannot silently become an analysis.
3. **A view records no log events.** `bench run` remains the way to record an analysis; a saved
   question is not evidence, and a tab that logged on every refresh would bury the log in renders.
   The price is that a panel is not in `bench runs`; the panel's own fingerprints answer the question
   that matters — whether it still describes the project.
4. **Queries select rows and do nothing else.** `{"where":[{field, op, value}]}` with `> >= < <= == !=`,
   all clauses required to hold. No arithmetic, no aggregation, no transforms: anything computed
   would be a derived value in a place the honesty rules do not reach. Transformations live in a
   recipe, where they are hashed and reported.
5. **A panel is current, stale, missing or unchecked** — the same three-state honesty as a recorded
   run, plus "the dataset is gone". It compares `input_hash` against the rows the query selects now,
   and `recipe_hash` against the recipe file, so neither moved data nor an edited recipe can pass.
6. **Unknown fields are refused.** A view file is an interface between an agent and a window; a typo
   that is ignored is a typo that silently does nothing. `n` must also match the marks the chart draws.
7. **The registry is app-level: `$BENCH_HOME/projects.json` (`~/.bench` by default).** Entries are
   `{name, dir, created, lastOpened}`, keyed by directory, rewritten atomically, read tolerantly — a
   corrupt file is reported as a problem, never as "you have no projects". Opening a project records
   a recent. `--project` accepts a registered name, and `bench projects --scan <dir>` finds folders
   that were never registered, without registering them.
8. **Deleting a view or a registry entry is not a CLI operation.** A view the user built is history;
   replacing one is explicit (`--force`).

`version` is now a pinned dataset version; `latest` survives only as the value a hand-written view may
use before its first render. The revisit condition ("dataset versions land") has happened, and
[0012](0012-dataset-versions.md) records the answer.

## Consequences

- The window has what it needs to start: a list to switch between, a tab format to render, and a
  status per panel to show honestly.
- `views/` is no longer a folder nothing reads. Both recipes echo point ids, so a rendered tab can map
  a mark back to a log record.
- A view can be authored by hand and validated on save (`bench view save --file`), or produced by the
  CLI (`view new`, `view add`). Both go through one validator.
- Panels store an artifact spec, not an artifact path: `view render` returns a canvas, and a tab does
  not depend on an SVG written months ago.
- A view whose panel came from a recipe is not reproducible from the view alone: the recipe still has
  to exist, and the panel says so when it does not (`missing`) or has changed (`stale`).
- The registry is disposable. Losing it loses recency; the projects stay openable by path.

## Revisit if

- A panel needs derived values on the chart (a rolling fit, a residual plot): the query language must
  stay select-only, so that work belongs in a recipe that returns a spec, not in the view format.
- The registry needs more than recency (tags, workspaces, a "last open tab"): that is a UI concern,
  and it should arrive with the UI rather than as speculative fields.
