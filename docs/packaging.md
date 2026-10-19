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
  bench.exe                  <- double-click this
  LAUNCH.txt                 <- what a person receiving the folder needs
  resources/
    app/
      main.js  preload.cjs  core.bundle.mjs  package.json
      renderer/              index.html, app.js, chart.js, app.css, tokens.css
      recipes/               runner.py, fit.py, drift.py, requirements.lock.txt
    app.asar                 (absent on purpose — the app is plain files)
```

No download happens during the build. It copies `node_modules/electron/dist`, which the install
already put there, renames `electron.exe` to `bench.exe`, and drops the application into
`resources/app` from an explicit file list.

## Launch it

Double-click `bench.exe`. No installer, no terminal, no repository. The window opens the most recent
project from `%USERPROFILE%\.bench\projects.json`, or the empty state if there is none. `Open…` takes
an existing project folder; `New…` creates one and its shape. A specific project can be opened on
launch with `set BENCH_PROJECT=C:\path\to\project` — useful for shortcuts.

`LAUNCH.txt` in the artifact root says the same thing, because the folder is what gets handed to
someone.

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
removed from `PATH`, on a scratch copy of the committed fixture, and fails unless:

- the app reports `app.isPackaged`, Electron 44.9.0, and a window URL inside `resources/app`;
- it painted the project — 2 panels, 28 marks, `n = 14`, entry fields `x,y`;
- the tab dialog opened with exactly one option (`plot`) and a note naming the missing runtime;
- `fixtures/`, `tests/`, `node_modules/`, `docs/`, `data/`, `recipes/.venv` and `recipes/__pycache__`
  are **not** in `resources/app`, while `main.js`, `preload.cjs`, `core.bundle.mjs`, the renderer and
  `recipes/runner.py` **are**;
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
