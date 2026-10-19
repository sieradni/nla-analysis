# The `bench` CLI — agent interface

`bench` is the **only** way to mutate a project. The agent, scripts, and the app all use it. Because
an agent is the primary user, the contract optimizes for machine calls that a human can also read.

## Implemented today

| working | specified, not built |
|---|---|
| `init`, `add`, `correct`, `retract`, `list`, `state`, `check`, `chart`, `recipes`, `run`, `decide` | `import`, `dataset *`, `shape *`, `runs`, `rerun`, `view *`, `export` |

Available recipes: `fit` (curve, band, verdict) and `drift` (does the relationship change over time).

Exit codes, `--json`, `--project`, and non-interactive behavior are in place. `--dry-run` and
`--id` (idempotent retries) are specified but not yet implemented. Everything in the tables below is
the target contract, not a description of the current binary.

`bench recipes` deliberately does **not** require a project: recipes belong to the application, not
to a data set. `bench run` writes the rendered artifact, appends an `analysis_run` event carrying the
recipe hash, the input hash, the verdict and the narrative, and refreshes `STATE.md`.

## Contract rules

1. **Non-interactive.** Never prompts, never waits. Missing arguments are an error with a fix hint.
2. **`--json` on everything.** Stable envelope. Human-readable output is the default.
3. **`--dry-run` on every mutating command.** Prints the events that would be appended.
4. **`--id <ulid>` for idempotent retries.** Re-running with the same id is a no-op.
5. **Errors are for agents.** `{"ok": false, "code": "...", "message": "...", "hint": "..."}`.
   Exit codes: `0` ok, `1` invalid input, `2` not found, `3` would break an invariant.
6. **Streams over files.** `--stdin` accepts JSONL or TSV; never require an interactive confirm.

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
| `bench state [--json] [--brief]` | regenerate and print the cold-start brief |
| `bench check [--fix]` | validate log, shapes, views, artifacts, orphaned files |
| `bench decide "<text>" [--tag]` | record a decision in the log and `docs/decisions.md` |

`bench state` is the most important command: it is how a new session becomes oriented. It must
answer, in one call: what datasets exist and at which version, what shape each has, what views
exist, which analyses are stale, what the last decisions were, and what is unresolved.

### Data

| command | purpose |
|---|---|
| `bench add --dataset <d> --values '{"x":1.2,"y":3.4}' [--at ISO] [--note] [--tag]` | record a point |
| `bench add --stdin` | bulk points: JSONL or TSV with `--columns x,y,t` |
| `bench correct <point-id> --values '{"y":3.5}' --reason "typo"` | supersede a point |
| `bench retract <point-id> --reason` | mark as withdrawn (kept, excluded from analysis) |
| `bench annotate <point-id> --note/--tag` | add context without changing values |
| `bench import <file> [--format csv\|xlsx\|jsonl] [--map a=x,b=y]` | preserve in `data/raw/`, then load |

### Datasets and versions

| command | purpose |
|---|---|
| `bench dataset list` | id, rows, version, time span, last change |
| `bench dataset show <id>` | shape, fields, units, provenance chain |
| `bench dataset replace <id> --from <file>` | new version + diff vs parent |
| `bench dataset diff <id> <v1> <v2>` | row-level `+n −n ~n`, plus sample changes |
| `bench dataset export <id> [--version] --format csv\|parquet` | analysis-ready copy |

Replace never destroys: it appends `dataset_version_created`, computes the diff, and marks
dependent analyses stale.

### Shapes

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
| `bench runs [--dataset] [--stale]` | not built | run history with verdicts (STATE.md shows the last six) |
| `bench rerun --stale` | not built | re-execute analyses whose inputs changed |

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
| `bench view list` / `show <name>` | tab and panel definitions |
| `bench view create <name> --panels <json>` | write a view file |
| `bench view open <name>` | tell a running app to focus it (fails soft if app is closed) |

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

The `dataset replace` / `rerun --stale` steps below become available in Phase 2.

## Non-goals for the CLI

Interactive editing, TUI, daemon management. Anything that requires a human to answer a question
belongs in the app or in conversation, not in the tool an agent calls unattended.
