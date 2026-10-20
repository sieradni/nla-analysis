# Packaging — a standalone Windows build

The audit's first-ranked gap was that the app existed only as `pnpm app` inside a checkout. This is
the build a person can launch without the repository. See [ADR 0009](adr/0009-packaging.md) for why
it is assembled from the installed Electron runtime rather than a packager that downloads one.

## Build it

```sh
pnpm app:package           # app:build, then scripts/package-app.mjs
```

Output: **`artifacts/bench-win32-x64/`**, ~369 MB, of which the application is about 1 MB.

```
artifacts/bench-win32-x64/
  bench.exe                  <- double-click this (the window)
  bench.cmd                  <- the CLI, run by the artifact's Electron runtime
  LAUNCH.txt                 <- what a person receiving the folder needs
  resources/
    app/
      main.js  preload.cjs  core.bundle.mjs  package.json
      src/cli/index.mjs      the bundled CLI that bench.cmd runs
      renderer/              index.html, app.css, tokens.css, and the ES modules the window loads:
                              app.js, copy.js (every word a person reads), chart.js, state.js,
                              rail.js, panels.js, entry.js, tabs.js, projects.js, import.js,
                              navigation.js — the list is explicit in scripts/package-app.mjs, so a
                              new module that is missing from it breaks the artifact, not the tests
      recipes/               runner.py, fit.py, drift.py, requirements.lock.txt
    app.asar                 (absent on purpose — the app is plain files)
```

Electron 44 no longer fetches its runtime from a `postinstall`, so `app:package` runs
`pnpm exec install-electron` first: a no-op when `node_modules/electron/dist` is already there, a
one-time download otherwise. The build then copies that folder, renames `electron.exe` to
`bench.exe`, and drops the application into `resources/app` from an explicit file list.

## Launch it

Double-click `bench.exe`. No installer, no terminal, no repository. The window opens the most recent
project from `%USERPROFILE%\.bench\projects.json`, or the empty state if there is none. `Open…` takes
an existing project folder; `New…` creates one and its shape. A specific project can be opened on
launch with `set BENCH_APP_PROJECT=C:\path\to\project` — useful for shortcuts.

`LAUNCH.txt` in the artifact root says the same thing, because the folder is what gets handed to
someone.

Every project records the CLI that created it in its own `AGENTS.md`: a project made from the
artifact names this folder's `bench.cmd` by absolute path, and a project made from a checkout names
that checkout's `pnpm bench`. A later session handed only the project folder can therefore find and
call the CLI without being told where the app lives. The CLI refreshes that line whenever it writes
the project brief (`state`, and every mutation), so a project made by an older build, or one whose
folder moved, is healed by ordinary use rather than left pointing at a path that is gone.

## The CLI is in the artifact

`bench.cmd` beside `bench.exe` runs the **same CLI** as `pnpm bench`, bundled from `src/cli/index.ts`
to `resources/app/src/cli/index.mjs` and executed by the artifact's own Electron binary in Node mode
(`ELECTRON_RUN_AS_NODE`). It needs no Node install, no `pnpm`, and no repository:

```sh
cd C:\data\sensor
C:\path\to\bench-win32-x64\bench.cmd state
C:\path\to\bench-win32-x64\bench.cmd --project C:\data\sensor import readings.csv --time t_observed
C:\path\to\bench-win32-x64\bench.cmd --project C:\data\sensor view new "readings" --dataset main
```

Do **not** put the artifact folder on `PATH` and expect `bench` to mean the CLI: `bench.exe` is the
window, and Windows resolves `.exe` before `.cmd`. Call the launcher by name (`bench.cmd`) or by path.

An agent can therefore create a project, add and import points, check the log, manage views and draw
plots with only this folder. Analysis is the one part that still needs an interpreter: `bench run fit`
and `bench run drift` look for `resources/app/recipes/.venv` or a Python on `PATH` with the pinned
dependencies. That is unchanged from the window, which already says why no recipe is offered.

## What it does not carry, and what that costs

| excluded | why | what a person sees |
|---|---|---|
| `fixtures/` (82 KB) | review data for tests, not user data | nothing — projects come from the user |
| `tests/`, `node_modules/`, `docs/` | development tooling | nothing |
| `recipes/.venv` (164 MB) | this machine's Python environment | tab dialog offers plot panels only, and says why |
| git history | not runtime | nothing |

The recipe **source** (`recipes/*.py` and the lock file) *is* shipped: a panel's freshness is a hash
of its recipe file, so a build without them could not tell whether a drawn panel still holds. What is
missing is the interpreter that runs them. In that state the tab dialog reads:

> No recipe is offered because the analysis runtime is not available: no Python interpreter at
> "python" and none on PATH — recipes need the analysis environment

and a plot tab is still created. Data entry, corrections, project creation and every existing tab keep
working. If a machine does have a working environment (a `recipes/.venv` beside the app, or a Python
on `PATH` with numpy and scipy), recipe panels work there too.

## Prove it

```sh
pnpm app:package:check     # after pnpm app:package
```

This launches **`bench.exe` itself** (not the dev shell) with the analysis runtime deliberately
removed from `PATH`, on a scratch copy of the committed fixture, then runs **`bench.cmd`** with the
same stripped environment. It fails unless:

- the app reports `app.isPackaged`, Electron 44.9.0, and a window URL inside `resources/app`;
- it painted the project — 2 panels, 28 marks, `n = 14`, entry fields `x,y`;
- the tab dialog opened with exactly one option (`plot`) and a note naming the missing runtime;
- `fixtures/`, `tests/`, `node_modules/`, `docs/`, `data/`, `recipes/.venv` and `recipes/__pycache__`
  are **not** in `resources/app`, while `main.js`, `preload.cjs`, `core.bundle.mjs`, the renderer and
  `recipes/runner.py` **are**;
- the shipped CLI created a fresh project, imported a timed table, made and rendered a view, passed
  `bench check`, and reported version 1 — with no Node install and no Python;
- that project's generated `AGENTS.md` names this artifact's `bench.cmd` by absolute path and the
  project by its path, and the check runs that recorded line itself from a folder unrelated to both
  the repository and the project — so the file an agent reads is the one that was proved;
- the shipped CLI ran a **recipe-backed** `fit` and a `view new --recipe`, proving the bundled CLI
  resolves `recipes/` through the one `APP_ROOT` in `src/core/analysis.ts` rather than counting its
  way up from the bundle, using the repository's `recipes\.venv` (run `pnpm setup:recipes` first;
  `pnpm verify` needs the same environment);
- that analysis left no `recipes/__pycache__` in the artifact — the recipe runner spawns Python
  with `PYTHONDONTWRITEBYTECODE`, so analysis-then-check passes twice without repackaging;
- `bench.cmd` and `resources/app/src/cli/index.mjs` are present;
- Electron's fallback `default_app.asar` is gone, and the artifact is under 450 MB.

It writes a frame from that run to `docs/ui-review/app-packaged.png` and a receipt to
`docs/ui-review/app-packaged.json` — the receipt is committed so the check's claims survive the run
that made them. The frame is in the contact sheet with the others.

This is separate from `pnpm verify`: rebuilding and launching a 369 MB artifact on every unit-test run
would make the suite useless as a quick check. `pnpm verify` stays the code gate; this is the packaging
gate.

## Out of scope, on purpose

No code signing, no MSI or installer, no auto-update. The artifact is a folder to copy or zip; it will
trigger Windows SmartScreen because it is unsigned, and that is the honest consequence of leaving
signing out.

**Decided 2026-10-20:** the portable build ships **unsigned**. SmartScreen's warning is documented
here and is not a blocker for `0.1.0`; a certificate, an installer and auto-update are later decisions
on their own ([ADR 0015](adr/0015-user-surface.md), roadmap §4).
