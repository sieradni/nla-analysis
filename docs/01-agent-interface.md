# The `bench` CLI — agent interface

`bench` is the **only** way to mutate a project. The agent, scripts, and the app all use it. Because
an agent is the primary user, the contract optimizes for machine calls that a human can also read.

## Implemented today

| working | specified, not built |
|---|---|
| `init`, `add`, `correct`, `retract`, `list`, `state`, `check`, `chart`, `import`, `recipes`, `run`, `runs`, `rerun`, `decide`, `projects`, `dataset list\|versions\|diff`, `view list\|show\|new\|add\|save\|render` | `dataset replace\|show\|export`, `shape *`, `annotate`, `add --stdin`, `view create\|open`, `recipe show` |

Available recipes: `fit` (curve, band, verdict) and `drift` (does the relationship change over time).

Exit codes, `--json`, `--project`, and non-interactive behavior are in place. `--dry-run` exists on
`import`; on the other mutating commands, and `--id` (idempotent retries) everywhere, it is specified
but not yet implemented. The tables below mark what is **not built**; a row with no such note is
implemented.

`bench recipes` deliberately does **not** require a project: recipes belong to the application, not
to a data set. `bench run` writes the rendered artifact, appends an `analysis_run` event carrying the
recipe hash, the input hash, the verdict and the narrative, and refreshes `STATE.md`.

## Projects and tabs

`bench projects` lists the projects this machine knows, most recently opened first, marking the one
that contains the working directory. `--scan <dir>` adds project folders that were never registered
(shown as `not registered`, depth-limited to three levels). Registration happens on `init` and on any
command that opens a project; the list lives at `$BENCH_HOME/projects.json` (`~/.bench` by default),
outside every project, and losing it loses recency, not data. `--project` accepts a registered name as
well as a path: `bench --project "sensor a" add --x 1 --y 2`.

A **view is the tab format** ([ADR 0004](adr/0004-views-and-projects.md)): one JSON file per tab in
`views/<slug>.json`.

```json
{
  "v": 1,
  "name": "drift over time",
  "layout": { "columns": 2 },
  "panels": [
    {
      "title": "slope before and after the split",
      "dataset": "main",
      "version": 2,
      "query": { "where": [{ "field": "y", "op": ">", "value": 0 }] },
      "recipe": "drift",
      "params": { "split": "auto" },
      "chart": { "x": { "label": "x" }, "y": { "label": "y" }, "points": [{ "x": 1, "y": 2.55, "id": "01J..." }], "provenance": { "dataset": "main", "shape": "xy.v1", "version": 2 } },
      "verdict": "tentative",
      "n": 14,
      "recipe_hash": "…",
      "input_hash": "…"
    }
  ]
}
```

| command | purpose |
|---|---|
| `bench view list [--json]` | views in this project, with panel counts and recipes |
| `bench view show <name> [--json]` | the view plus one status per panel: `current`, `stale`, `missing`, `unchecked` |
| `bench view new <name> [--dataset] [--recipe] [--param] [--query] [--title] [--columns] [--force]` | create a one-panel tab from the data or a recipe |
| `bench view add <name> [flags]` | append a panel to an existing tab |
| `bench view save [name] --file <json\|->` | validate and store a hand-written view (stdin allowed) |
| `bench view render <name> [--refresh] [--out]` | draw the saved specs to `artifacts/view-<name>.svg` |

`render` never computes: it reads the file and draws it. `--refresh` is the explicit act that re-reads
the data, re-runs any recipe, and rewrites the file. Panels store fingerprint hashes (`input_hash`
over the selected rows, `recipe_hash` over the recipe file), so `view show` notices moved data and an
edited recipe without running anything. A view records **no** log events: `bench run` remains the way
to record an analysis.

The `query` is deliberately tiny — `field`, `op` (`> >= < <= == !=`), `value`, all clauses required.
It selects rows; it never computes with them.

## Where the work happens

Everything a command does to a project goes through one in-process seam, `src/core/workspace.ts`
([ADR 0003](adr/0003-in-process-core.md)). `bench` parses arguments, calls it, and prints; it holds no
project logic of its own. Two consequences worth knowing when reading this document:

- A UI binds the same seam directly rather than shelling out, because starting a command costs more
  than the whole keystroke budget.
- The seam raises refusals instead of exiting, so the CLI — and only the CLI — turns them into exit
  codes. A `--dataset` that does not exist is therefore refused by name everywhere, instead of being
  reported as a dataset that happens to have no points.

## Contract rules

1. **Non-interactive.** Never prompts, never waits. Missing arguments are an error with a fix hint.
2. **`--json` on everything that returns data.** Stable envelope; human-readable output is the
   default. *In place everywhere that matters today; see the status table above.*
3. **`--dry-run` on every mutating command.** Prints the events that would be appended. *In place on
   `import` only.*
4. **`--id <ulid>` for idempotent retries.** Re-running with the same id is a no-op. *Not built.*
5. **Errors are for agents.** `{"ok": false, "code": "...", "message": "...", "hint": "..."}`.
   Exit codes: `0` ok, `1` invalid input, `2` not found, `3` would break an invariant.
6. **Streams over files.** `--stdin` accepts JSONL or TSV; never require an interactive confirm.
   *Not built for `add`; `view save --file -` is the one stdin path today.*

## Response envelope

```json
{ "ok": true, "data": {}, "events": ["01J..."], "warnings": [], "state_stale": false }
```

`events` lists ids appended. `warnings` carries things like "field `temprature` not in shape
`reading.v2` — did you mean `temperature`?".

## Commands

### Project

| command | purpose |
|---|---|
| `bench init <dir> [--name]` | scaffold project, `AGENTS.md`, first shape, `STATE.md` |
| `bench state [--json]` | regenerate and print the cold-start brief. `--brief` is **not built**. |
| `bench check [--json]` | validate the log and shapes. `--fix` is **not built**; nothing is auto-repaired. |
| `bench decide "<text>" [--tag]` | record a decision in the log and `docs/decisions.md` |

`bench state` is the most important command: it is how a new session becomes oriented. It must
answer, in one call: what datasets exist and at which version, what shape each has, what views
exist, which analyses are stale, what the last decisions were, and what is unresolved.

### Data

| command | purpose |
|---|---|
| `bench add --dataset <d> --values '{"x":1.2,"y":3.4}' [--at ISO] [--note] [--tag]` | record a point |
| `bench add --stdin` | bulk points: JSONL or TSV with `--columns x,y,t`. **Not built.** |
| `bench correct <point-id> --values '{"y":3.5}' --reason "typo"` | supersede a point |
| `bench retract <point-id> --reason` | mark as withdrawn (kept, excluded from analysis) |
| `bench annotate <point-id> --note/--tag` | add context without changing values. **Not built**; notes and tags are set when a point is added or corrected. |
| `bench import <file> [--map field=column]… [--time <col>] [--format csv\|tsv\|jsonl] [--dry-run] [--force]` | preserve in `data/raw/`, then load |

#### Import behaviour, as built

- **All or nothing.** Every row is parsed and validated against the shape first. One bad row and
  nothing is written — a half-imported file is worse than a refusal, because the log would then
  disagree with the file it came from. Errors name the line as a person sees it in an editor
  (`row 7`), not an array index.
- **The original is evidence.** It is copied into `data/raw/` before the first event is appended and
  is never read again. The name is content-addressed (`<hash12>-<name>`), so re-importing the same
  bytes lands on the same path instead of accumulating near-duplicates, and a project rebuilt from
  its own script reproduces the same tree. The log records the file, the row count, the full
  content hash, the columns, and the field-to-column mapping.
- **A duplicate is refused, not silently repeated.** If an `import_completed` event with the same
  hash and dataset exists, the import stops and says so. `--force` is the way to mean it.
- **The time column is required.** `--time <column>` names it; otherwise the first header that
  looks like one wins (`t_observed`, `observed_at`, `timestamp`, `time`, `date`, `t`, in that
  order). If neither finds one, the import is refused and the error names the file's columns and the
  flag: a row is identified by its instant, so stamping every row with the moment of import would
  make a re-import read as every row leaving and every replacement arriving. The window's sheet has
  the same decision as a picker and passes the same `time` into the plan. A column that cannot be
  parsed as a time is an error, never a silent fallback to now.
- **Metadata preambles are skipped and counted.** Lines starting with `#` or `//` are dropped and
  reported in the output, because a skipped line could just as easily be a broken row.
- **`--dry-run` writes nothing at all** — no events, no copy under `data/raw/` — and prints the
  mapping it resolved.
- A relative path is looked for in the working directory and then in the project directory, so
  `bench --project ~/lab import readings.csv` works from either place.

### Datasets and versions

| command | purpose |
|---|---|
| `bench dataset list` | id, shape, version, active/recorded rows, time span |
| `bench dataset versions <id>` | every version, the diff that created it, and its row count now |
| `bench dataset diff <id> [v1] [v2]` | row-level `+n −n ~n` between two versions (default: the newest pair) |
| `bench dataset show <id>` | shape, fields, units, provenance chain. **Not built.** |
| `bench dataset replace <id> --from <file>` | new version + diff vs parent. **Not built**; import into a populated dataset is the replace surface. |
| `bench dataset export <id> [--version] --format csv\|parquet` | analysis-ready copy. **Not built.** |

Replacing never destroys: `bench import` into a populated dataset appends `dataset_version_created`
with a parent and a diff, and marks dependent analyses stale. There is deliberately no `dataset
replace` command to duplicate that path ([ADR 0012](adr/0012-dataset-versions.md)).

### Shapes

None of these commands exist yet: the registry is read and validated, but `bench` has no `shape`
subcommand.

| command | purpose |
|---|---|
| `bench shape list` / `show <id>` | registry |
| `bench shape extend <id> --field temp:C [--backfill null\|const:0\|expr]` | new version + migration |
| `bench shape validate` | field names against the registry, units, duplicates |

### Analysis

| command | status | purpose |
|---|---|---|
| `bench recipes [--json]` | **working** | the catalog: each recipe's params, defaults, bounds, and source hash. Needs no project |
| `bench run <recipe> [--param k=v] [--chart path] [--dataset id] [--json]` | **working** | execute, render the artifact, record `analysis_run` |
| `bench recipe show <name>` | not built | full schema for one recipe |
| `bench runs [--json]` | **working** | run history with verdicts and whether each still holds |
| `bench rerun <recipe> [--param k=v]` | **working** | repeat a run with the parameters it recorded, and report what changed |

The remaining filters — `runs --dataset`, `runs --stale`, `rerun --stale` — are not built; `runs`
shows every run, newest first, and `rerun` repeats one by recipe name.

#### Is this result still true?

Every `analysis_run` records the dataset it read, a hash of the exact points it consumed, and a hash
of the recipe file. `bench runs` and `STATE.md` use those to answer, offline and without recomputing:

| answer | meaning |
|---|---|
| `still current` | nothing in the dataset changed after the run, and the recipe is the same file |
| `stale: …` | what changed: `2 point(s) added`, `1 retracted`, `1 corrected`, or `the recipe has changed` |
| `cannot be checked: …` | the run predates the fingerprint, or names a dataset or recipe that is gone |

`cannot be checked` exists because the honest answer to "does this still hold?" is sometimes "nobody
wrote down what it read". It is never reported as current. A stale result is not an error: it is the
normal consequence of adding data, and re-running is one command.

The rules a recipe must obey, and that `bench run` enforces by way of the envelope:

- It returns `verdict` alongside any curve, and `insufficient` means no curve is drawn at all.
- Every number it emits is finite or null. `Infinity` is not valid JSON and is rejected upstream.
- It never writes to the log; the CLI records the run. A recipe that raises returns an error
  envelope and leaves the project untouched.

`bench run` returns the analysis envelope, which the UI renders verbatim:

```json
{
  "ok": true,
  "data": { "series": [ ... ] },
  "chart": { "spec": { ... } },
  "verdict": "insufficient",
  "diagnostics": { "n": 3, "params": 3, "dof": 0, "note": "exact by construction" },
  "narrative": "Three points, three parameters — this fit tells you nothing yet."
}
```

### Views

| command | purpose |
|---|---|
| `bench view list` / `show <name>` | tab and panel definitions — **working** |
| `bench view create <name> --panels <json>` | write a view file. **Not built**; `view new`/`view add`/`view save` cover it. |
| `bench view open <name>` | tell a running app to focus it. **Not built.** |

## Example: the flagship session

```bash
bench init ./drift --name drift
bench --project ./drift add --x 1.02 --y 3.1 --note "first reading"
bench --project ./drift add --x 1.11 --y 3.4 --at 2026-10-01T09:00:00Z

bench --project ./drift run fit --param degree=1
# INSUFFICIENT 2 points, 2 parameters, zero degrees of freedom: this fit is exact by
# construction, so it says nothing about the relationship. Add a 3rd point...
# No curve is drawn, and the artifact says so.

bench --project ./drift run fit --param degree=1 --param level=0.9
bench --project ./drift check
bench --project ./drift state
```

`dataset replace` and `rerun --stale` are not built; the example stops at `check` and `state` for
that reason.

## Non-goals for the CLI

Interactive editing, TUI, daemon management. Anything that requires a human to answer a question
belongs in the app or in conversation, not in the tool an agent calls unattended.
