# bench

A durable, agent-operated data-analysis workspace for Windows.

The truth is an append-only event log in a **project folder**. The `bench` CLI is the only way to
mutate it, and an Electron window is a viewport onto it. Every import, correction, removal and
analysis is a recorded event with a time and a reason, so a later session — or a later person — can
read what happened without being told again.

Version `0.1.0`. The window is a portable, **unsigned** Windows build; no release has been cut yet,
so you build it yourself (see [the desktop build](#the-desktop-build)).

It is not a spreadsheet: nothing is edited in place, and a dataset's history is kept. It is not a
service: a project is a folder you can copy, back up, or hand to someone else.

## Prerequisites

| need | why |
|---|---|
| **Node.js 22.18 or newer** (`engines`; CI runs 24) | the CLI runs TypeScript directly, with no build step |
| **pnpm** (CI pins 11) | the scripts, the tests and the window |
| **uv** — only for analysis recipes | creates the pinned Python environment in `recipes/.venv` |
| **Windows** — only for the desktop build | `pnpm app:package` produces `bench-win32-x64` |

Electron is a dev dependency. Its runtime is fetched on demand: `pnpm app:package` runs
`pnpm exec install-electron`, which downloads the runtime only when `node_modules/electron/dist` is
not already there.

## Install

```sh
git clone https://github.com/sieradni/nla-analysis.git
cd nla-analysis
pnpm install
pnpm setup:recipes     # optional: the analysis environment; needs uv
pnpm verify            # typecheck, bundle the core and CLI, run the tests
```

`pnpm verify` is the always-safe gate: it opens no window. It reports **379 tests in 24 files** on a
complete tree. Without `recipes/.venv` the 24 tests that need a recipe skip with a warning and the
rest still pass — that is the state a fresh clone is in until `setup:recipes` has run.

## First run

From the repository root, using the commands as the CLI accepts them. The output lines quoted are
what this tree prints.

**1. Create a project.** A project is a folder. The shape (`x:number`, `y:number`) and one dataset,
`main`, are chosen here and recorded in the log.

```sh
pnpm bench init ../bench-demo --name demo
# created project "demo" at …/bench-demo
#   shape xy.v1 (x, y) · dataset main
#   next: … add --values '{"x":1.2,"y":1.2}' --at …
```

**2. Bring data in.** Save a CSV anywhere — here `readings.csv` — with a clock column. `--time` names
that column; it is the explicit form of the guess the window's import sheet shows and lets you
change.

```csv
t_observed,x,y
2026-01-01T00:00:00Z,1,2.5
2026-01-02T00:00:00Z,2,5.1
2026-01-03T00:00:00Z,3,7.8
2026-01-04T00:00:00Z,4,10.4
```

```sh
pnpm bench --project ../bench-demo import readings.csv --time t_observed
# imported 4 row(s) into main as version 1 from readings.csv
#   first version of main · 4 row(s)
#   preserved as data/raw/571b8eb7932a-readings.csv
#   x <= x
#   y <= y
#   t_observed <= t_observed
```

The imported file is copied into `data/raw/` untouched and content-addressed; it is evidence, not
something the import reads twice. `--dry-run` reports the same plan and writes nothing. A file with
no clock can be imported with `--estimate-time`, and every row is then labelled an estimate in the
log and in every readout until a correction replaces it.

**3. Record a measurement.** Values can be flags for the default shape, or one JSON object for any
shape (`--values '{"x":5,"y":13.1}'`).

```sh
pnpm bench --project ../bench-demo add --x 5 --y 13.1
# recorded 01M5H7…  x=5 y=13.1  at 2026-10-22T07:23:50.602Z  (5 active in main)
```

**4. Draw it, and analyse it.** A tab is a saved view: a plot, or a recipe panel with its own
parameters. `run` records the analysis, so a later reader can tell whether it still holds.

```sh
pnpm bench --project ../bench-demo view new "first tab" --x-field x --y-field y
pnpm bench --project ../bench-demo view render "first tab"
# wrote …/artifacts/view-first-tab.svg  (1 panel(s))

pnpm bench --project ../bench-demo run fit --param degree=1
# SUPPORTED  … points, … degrees of freedom; … 95% confidence band …
# wrote …/artifacts/fit-main.svg
```

`run` needs the analysis environment from `pnpm setup:recipes`. It prints a verdict — `SUPPORTED`,
`TENTATIVE`, `CONTRADICTED` or `INSUFFICIENT` — with the number of points, the degrees of freedom and
an interval; it refuses to draw a curve the data cannot justify.

**5. Read the brief, then open the window.** `state` regenerates the project's `STATE.md`, which is
what a new session reads first.

```sh
pnpm bench --project ../bench-demo state
pnpm app
```

In the window, open the project folder with **Open…**, or name it at launch:

```sh
BENCH_APP_PROJECT=../bench-demo pnpm app        # bash, zsh, Git Bash
set BENCH_APP_PROJECT=..\bench-demo && pnpm app # cmd.exe
```

`pnpm app` opens a real window and brings it to the front. The entry bar records points in process —
it never waits on Python — and every act has an undo. Importing into a dataset that already holds
rows creates a new version: rows the file does not contain are withdrawn, not deleted, and
`bench dataset versions` / `bench dataset diff` show what changed.

## The CLI

`pnpm bench` is `node src/cli/index.ts`. Every command accepts `--project <dir|name>`, `--json` and
`-h`; `pnpm bench help` prints the whole surface, including every flag and exit code
(`0` ok, `1` invalid input, `2` not found, `3` an invariant would break).

| group | commands |
|---|---|
| project | `init` · `projects` · `state` · `check` · `decide` |
| points | `add` · `list` · `correct` · `retract` · `restore` |
| shapes | `shape extend` · `shape designate` |
| data | `import` · `dataset list\|versions\|diff\|restore` |
| views (tabs) | `view list\|show\|new\|add\|save\|render\|rm\|rename\|duplicate` |
| analysis | `recipes` · `run` · `runs` · `rerun` · `chart` |

**Not built yet.** `dataset replace|show|export`, `shape list|validate` beyond what `init` prints,
`annotate`, `add --stdin`, `recipe show`, `--dry-run` outside `import`, and forgetting a project from
the recent list. The window has no shape editor, no dataset-versions panel, no resizable rail and no
shortcut sheet. [docs/03-roadmap.md](docs/03-roadmap.md) is the live list, with the evidence for what
is done; do not assume a feature from this README that the roadmap marks open.

## The desktop build

```sh
pnpm app:package          # → artifacts/bench-win32-x64/
pnpm app:package:check    # launch it, then launch its CLI with Python removed from PATH
```

Double-click `bench.exe` — no installer, no terminal, no repository. Beside it, `bench.cmd` runs the
same CLI through the artifact's own Electron binary, so an agent can operate a project on a machine
with no Node and no checkout. The folder is about 369 MB, most of it Electron; the application is
about 1 MB of plain files.

The build is **unsigned**: Windows SmartScreen will warn on first launch. There is no installer and
no auto-update; both are later decisions, recorded in
[ADR 0009](docs/adr/0009-packaging.md). `pnpm app:package:check` compares the run against
`docs/ui-review/app-packaged.json` and writes that file only with `--record`, so a plain run leaves
the tree clean. Details: [docs/packaging.md](docs/packaging.md).

## A project, and this repository

Two layouts that are easy to confuse. **This repository is the application.** A **project** is a
folder created by `bench init`, wherever you want it:

```
data/events.jsonl   the truth; append-only, written only through bench
data/raw/           untouched imports (content-addressed copies)
shapes/             the shape registry's folder; the declarations themselves are events in the log
views/              one JSON file per tab; views/.trash/ holds the last 20 closed tabs
artifacts/          generated output — regenerable, safe to delete
project.json        the project's name and creation time, plus the file-format version; the shape
                    and dataset it started with are declared in the log, not here
AGENTS.md           the rules for an agent working in this project, with its launcher line
STATE.md            generated cold-start brief — never edit by hand
```

The application's own rules — including why the log is never edited by hand and where each kind of
work lives — are in [AGENTS.md](AGENTS.md). If you are an agent handed this repository rather than a
project, read that first.

## Where the rest is written down

- [docs/00-requirements.md](docs/00-requirements.md) — what the product must do, and the authority on *what*
- [docs/01-agent-interface.md](docs/01-agent-interface.md) — the CLI contract: commands, flags, exit codes, JSON
- [docs/02-implementation-plan.md](docs/02-implementation-plan.md) — the plan as it was built
- [docs/03-roadmap.md](docs/03-roadmap.md) — the open work, row by row, with its evidence
- [docs/05-user-surface.md](docs/05-user-surface.md) — what the window says, and why
- [docs/adr/](docs/adr/) — the decisions that are expensive to reverse

## License

MIT — see [LICENSE](LICENSE).
