# ADR 0009 — A standalone Windows build from the installed Electron runtime

Date: 2026-10-19
Status: accepted
Related: [0005](0005-desktop-shell.md) (the shell), [0008](0008-three-doors-in-the-window.md) (the
doors a build has to keep), [docs/packaging.md](../packaging.md) (the command and the artifact)

## Context

The audit ranked "they cannot get the app" first: the only launch was `pnpm app` inside a checkout,
with no executable, no icon and no double-click. Everything built since then is invisible to anyone
who does not have the repository.

Two constraints shaped the answer:

1. **The network is unreliable here.** A packager that fetches its own Electron (`electron-forge`,
   `electron-builder`, `@electron/packager` with a cold `@electron/get` cache) spends the build on a
   download that has already needed a retry once. The runtime is already installed and in use by
   `pnpm app:capture` and `pnpm app:measure`.
2. **A build must not quietly become a different product.** The window degrades without Python — it
   says a recipe panel needs the runtime — and that story has to survive shipping, not turn into a
   crash or a silent empty dialog.

## Decision

1. **Copy the installed runtime; do not fetch one.** `scripts/package-app.mjs` copies
   `node_modules/electron/dist` (Electron 44.9.0, already present) into `artifacts/bench-win32-x64`,
   renames `electron.exe` to `bench.exe`, and removes Electron's `default_app.asar` so there is no
   second app to wonder about. No archive, no asar for our own files, no network.
2. **Ship an explicit file list, not a filtered repository.** The application is `main.js`,
   `preload.cjs`, `core.bundle.mjs`, the five renderer files, and `recipes/*.py` with the lock file.
   Fixtures, tests, node_modules, docs, data and `.venv` are not excluded by pattern — they were never
   included. Exclusions that are patterns break silently when the repository grows.
3. **The recipes ship as data, not as an environment.** A panel's freshness is a hash of its recipe
   file (`assessRuns`), so shipping the `.py` files is what lets a packaged build say "this panel is
   stale" instead of "unverifiable". The 164 MB virtualenv stays behind; without an interpreter the
   tab dialog offers a plot only and names the reason.
4. **The degradation gets a real message.** `RecipeRunner.start` now waits for the spawn to settle and
   turns `ENOENT` into "no Python interpreter at … and none on PATH — recipes need the analysis
   environment", instead of letting the first request race the failure and report "analysis runtime is
   not running". A raw `spawn python ENOENT` in the dialog would be a stack trace shown to a user.
5. **Proof is the artifact running, not the build succeeding.** `scripts/check-packaged.mjs` launches
   `bench.exe` with the analysis runtime removed from `PATH`, has the app report `app.isPackaged`, the
   panels and marks it drew, and what the tab dialog offered; then it inspects the artifact for the
   things that must not be in it. It writes the frame and compares the run against a committed
   receipt, comparing facts rather than this machine's timing; only `--record` rewrites it, so the
   check can gate a clean tree.
6. **No signing, no installer, no auto-update.** Out of scope as asked. The artifact is a folder;
   SmartScreen will warn because it is unsigned, and the documentation says so.

## Costs, stated

- **369 MB on disk**, all of it the Electron runtime. Trimming locales would save ~50 MB and is not
  worth the risk to font rendering for a first build.
- **The launch gap closes only halfway**: a person can double-click `bench.exe`, but a new user still
  needs a project. `New…` covers that — the artifact plus the doors from ADR 0008 is a usable first
  five minutes, which was the point of the ranking.
- **No code signature**: Windows will show a SmartScreen warning. Say so rather than pretend the
  build is finished.
- **Two gates, not one**: `pnpm verify` stays the code gate; `pnpm app:package:check` is the packaging
  gate. Running a 369 MB build inside `verify` would make the quick check slow enough that people skip
  it.

## Revisit if

- Signing or an installer is wanted: that is a certificate, a build pipeline and a release decision,
  not a change to this script.
- The recipe environment should travel with the build. Then the artifact grows by ~164 MB, or the app
  learns to create an environment on first use — a different decision, with its own refusal paths.
