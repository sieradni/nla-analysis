# ADR 0008 — Creating, correcting and building tabs from the window

Date: 2026-10-19
Status: accepted
Related: [0002](0002-agent-only-v1.md) (agent-only v1), [0003](0003-in-process-core.md) (the seam),
[0004](0004-views-and-projects.md) (tabs are view files), [0006](0006-window-write-path.md) (entry),
[0007](0007-freshness-before-writes.md) (freshness before writes)

## Context

The audit ranked what a first-time user hits, and three of the four were doors that did not exist in
the window:

1. **They cannot create anything.** The two empty states printed CLI commands instead of offering the
   act: `bench init …` and `bench view new …`. With data in a spreadsheet, there was no way in.
2. **They cannot fix a mistake.** `Workspace.correctPoint` existed and was tested, but nothing in the
   window reached it; a wrong point could only be retracted and retyped, which loses its observation
   time and leaves a retraction in the log for an error that was not one.
3. **They cannot create a tab.** Tabs could be opened and switched, never made: the rail listed what
   the CLI had written.

Each is a write. The window's write channel was three calls wide and deliberately narrow
(ADR 0006) — the question was how to open three doors without turning it into a general-purpose shell.

## Decision

### 1. Three calls, one per door, each a core method

`app/core.entry.ts` gains exactly three write calls and no more:

| door | call | core underneath |
|---|---|---|
| create a project | `createProject(parent, name, shape?)` | `initProject` (with a validated shape), `rememberProject` |
| create or replace a tab | `writeView(dir, draft)` | `requireFreeName`, `materializePanel`, `saveView` |
| correct a point | `correctPoint(dir, id, values, viewName?)` | `Workspace.correctPoint`, `writeStateBrief`, `refreshView` |

The preload exposes those three and nothing else. There is still no call that takes a log event, a
file path or a command: the window cannot invent a write the core has not agreed to, and every one of
these is also a `bench` command (`init`, `view new`, `correct`) over the same functions.

### 2. A shape is chosen once, at init, and validated before anything is written

A project's shape is declared by a `shape_defined` event at init and every point inherits it, so
init is the only moment the fields can be picked — and a mistake there is permanent. The create
dialog therefore offers the shape bench ships (`xy.v1`), or custom fields: a shape name and rows of
field name + type, where the types come from the core (`shapeChoice().types`) rather than a second
list in the window. `validateShapeDefinition` refuses duplicate names, unknown types, names the CLI
could not spell as a flag, an id without a version, and a shape with no fields, **before the folder is
created** — a refused project leaves nothing behind.

For parity, `bench init --shape <file.json>` declares the same shape from a JSON file. One core
function, two callers, so an agent can build exactly what a person can click.

### 3. The runner comes back for panel materialization — and only for that

A tab built from a recipe needs the recipe to run; there is no way to write a recipe panel without
materializing it. So `writeView` starts the same `RecipeRunner` the CLI uses, for the length of that
one call, and disposes it. Three limits keep ADR 0002 intact:

- it records **no** `analysis_run` event — the panel is a saved question, not an analysis anyone will
  read later. `bench run` is still the only way to record one;
- the window gains no "run this" call and no free-form request: the recipe list is a fixed catalog,
  and a panel's parameters are the recipe's defaults;
- it is never on the entry path. Typing a number still touches no Python.

If the runtime is missing, `recipes()` returns the problem instead of throwing, the dialog says so,
and a plain plot tab still works. A failed materialization saves nothing: the tab file is written
last, after the panel exists.

### 4. A project with no tab still has an entry bar

Creating a project used to dead-end: no tabs, so the entry bar was hidden, and `view new` refuses an
empty dataset, so a tab could not be made either. `OpenedProject` now carries the same `EntryTarget` a
tab carries — its first dataset's shape — and the bar uses it when no tab is open. One rule, one
function (`targetForDataset`), two callers. A new project takes its first point through the bar it
will keep using.

### 5. Correcting is selecting, and it cannot leave a claim standing

Clicking a mark selects it (dashed ring) and fills the same entry fields with the record's own values,
read from the core — not from the tooltip, which rounds for reading. `Shift`+arrow steps the
selection along x with the chart focused, so a record is reachable without a pointer. Enter saves;
Escape cancels and leaves the record alone.

The correction is a `point_corrected` event: the original stays in the log and the strip says so.
Because a value changed, the facade rebuilds the tab before returning: plot panels are re-materialized
and a recipe panel is **kept and reported stale**, with the status line naming the panel. A correction
that let a fitted curve keep claiming it described the data would be the same class of lie ADR 0007
exists to prevent.

## Costs, stated

- A recipe tab costs the interpreter: ~1.5–4 s on this machine, once per click, in a dialog that is
  already waiting for a name. The catalog is fetched once per session and cached in the window.
- Custom shapes are validated only at declaration. There is no editor afterwards, because
  `shape_extended` is specified and not built; the fix for a wrong shape is a new project.
- A tab still holds one panel built from one dataset and one recipe. Multi-panel tabs remain a CLI
  act (`bench view add`), which is a real limit of this slice, not a design choice.
- The project folder is derived from the name (`load cells` → `load-cells`), shown in the dialog
  before the click. A parent folder that does not exist is refused rather than created, so a typo
  cannot plant a tree.
- `init` now exits 1 rather than 3 on a refused shape, because `fail` maps the refusal's own kind;
  3 was saying "the log is at risk" when nothing had been written.

## Proof

Each door is proven twice: through the bundle (the module the window loads) and through the real
window, where the capture harness fails the run if the outcome is wrong.

| door | bundle test (`tests/shell.test.ts`) | window (`pnpm app:capture`) |
|---|---|---|
| correct | `corrects a selected point as an event…` — one `point_corrected`, count unchanged, recipe panel kept and stale | `app-corrected.png`: click a mark, prefilled `1` / `2.55`, type `24.5`, Enter |
| tab | `writes a tab from a chosen dataset…`, `builds a recipe panel…` — file, `n`, verdict `tentative`, replace only with `replace` | `app-new-tab.png`: dialog → dataset `main`, recipe `drift`, `Created tab “regimes” … tentative · n = 14` |
| project | `creates a project with the shape the dialog chose…` — folder, `shape_defined`, entry fields, point validated against it, bad shape leaves nothing | `app-new-project.png`: custom shape `load.v1 (mass, extension)`, then `2.5` / `12` recorded as `n = 1` |

## Revisit if

- Someone needs to change a shape after init. That is `shape_extended` and a migration, a separate
  decision with its own cost.
- A tab needs more than one panel from the window, at which point `writeView` takes a panel list and
  the dialog becomes a small editor rather than three selects.
