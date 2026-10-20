# ADR 0005 — The desktop shell is Electron, and it binds the core in process

Date: 2026-10-19
Status: accepted
Related: [0001](0001-stack-choices.md) (stack), [0002](0002-agent-only-v1.md) (agent-only v1),
[0003](0003-in-process-core.md) (the write path is in process), [0004](0004-views-and-projects.md) (tabs)

## Context

The user wants a standalone Windows app where projects and tabs switch and charts support hover and
zoom. ADR 0003 already decided that the app binds `src/core` **in process**, on measurement: a
keystroke costs 15.7 ms in the core, while merely starting a command costs 160 ms against a 100 ms
budget. A shell that spawns the CLI per interaction would contradict that decision, so the shell
question is really: which shell can host a TypeScript core in one process?

Two options were considered seriously.

**Electron.** Its main process *is* Node, so `src/core` is imported directly — the same modules the
CLI imports, in the same process, no second runtime. The renderer is Chromium, and the core's own SVG
renderer can be reused verbatim.

**Tauri with a Node sidecar.** Tauri's shell is Rust with a WebView2 front end. Rust cannot run the
TypeScript core, so the core would have to live in a long-lived Node sidecar process (which is *not*
per-keystroke — it is started once — so it does not contradict ADR 0003 the way a CLI-per-keystroke
would), or be reimplemented in Rust, which does. The sidecar is a second runtime to ship, supervise
and package, and every call crosses Rust to reach it.

## Measured, on this machine (2026-10-19)

| fact | value | how |
|---|---|---|
| Electron version | 44.9.0 | `npx electron --version` |
| Electron unpacked install | 369 MB | `du -sh node_modules/electron/dist` (dev dependency; no installer built yet) |
| core bundle for the shell | 58 KB | `pnpm app:build` (esbuild, 6–22 ms) |
| cold start → first paint | 205–242 ms | logged by `app/main.js` when the renderer reports its first paint; five consecutive runs. Earlier runs measured 498–598 ms while a build competed for the CPU — that is why the range is quoted from a quiet machine |
| working set, all Electron processes | 466–514 MB | `app.getAppMetrics()` summed — see the caveat below |
| layout at 100 / 125 / 150% | no overflow, no clipped panel | measured in the live window, per scaling (see review log) |
| hover / zoom / pan cost | no core call at all | interaction frame: the crop moves, the drawing does not redraw |

The working-set number is the sum of per-process working sets, which counts shared pages more than
once; it is an upper bound on what the machine loses, not a private-bytes figure. It is reported here
because it is the number a user will notice, and because hiding it would make the choice look free.

**Tauri's numbers are not measured here.** Its installer is documented in single-digit-to-tens of MB
and this machine already has WebView2 (155.0.4283.62) and Rust 1.98.0 with MSVC 2022, so it *would*
build. What was not done is the work that decides the question: scaffolding, sidecar supervision,
packaging, and a second language in the repo. An unmeasured claim of "smaller" is exactly the kind of
number this project refuses elsewhere, so it is written as a documented expectation, not a result.

## Decision

1. **Electron, because the core stays in one process.** The main process imports the bundled core;
   the window asks it for data. Nothing shells out, per keystroke or otherwise.
2. **The bundle is an interface, and it is tested.** Electron's Node does not strip TypeScript types,
   so `pnpm app:build` (esbuild) produces `app/core.bundle.mjs` from `app/core.entry.ts`, which is
   git-ignored and rebuilt by `pnpm verify` before the suite runs. `tests/shell.test.ts` imports that
   bundle and asserts the window's own path — which is how a real bug was caught: bundled, the core's
   `APP_ROOT` was two directories too high, and every recipe read as missing.
3. **The window does not know how to read a project.** `app/core.entry.ts` is a thin facade over
   `src/core`: list projects, open one, list its tabs, open a tab, hand back the view file plus one
   SVG per panel. `app/workspace-session.ts` keeps the open `Workspace`; `app/view-session.ts` owns
   the view from construction through its cached, staged and saved states. The facade never owns
   that state itself. Anything the window wants that the facade cannot answer belongs in the core.
4. **Charts are the core's SVG, transformed — not redrawn.** Pan and zoom move the SVG's `viewBox`,
   so zooming is a crop of the same drawing: coordinates, labels and `data-point-id` attributes stay
   exactly where the core put them, and nothing is re-rendered per frame. Requirements §4 expects a
   canvas renderer at 10k points; that is deferred until a measurement here says the SVG is too slow
   (today: 28 marks, 2 panels, no frame cost observed).
5. **Hover hit-tests the marks that were drawn.** This was a real bug found by launching: the first
   version compared the pointer against the panel's *data* values, which can never match, because the
   core draws points at projected pixel positions. Hover now finds the nearest drawn mark and resolves
   its `data-point-id` back to the record. The tooltip shows the id — a hover that cannot name the
   record behind the mark is decoration.
6. **The window never writes.** No data entry in this slice, by choice: `bench add` already exists and
   is tested, and an entry bar is only worth building when it can meet the §6 budget. `app/preload.cjs`
   exposes five read calls and `pickProject`; there is no write channel to add later by accident.
7. **Costs accepted, stated:** ~370 MB of dev dependency, ~490 MB working set, a bundle step in
   `pnpm verify`, and one Chromium per window. In exchange: one runtime, one language, one core.

## Consequences

- `pnpm app` launches a window that lists registered projects, lists a project's saved tabs, draws a
  tab's panels from their materialized specs, and switches projects and tabs. `pnpm app:capture`
  drives the same window and writes review frames.
- The registry (ADR 0004) is what makes switching possible in a window at all; the app records a
  recent on open, exactly like the CLI.
- Staleness is visible where a user looks: a panel's badge comes from `panelStatuses`, and the stage
  says how to refresh. The window never claims a panel is current without the fingerprint check.
- Distribution is not built. There is no installer, no code signing, no auto-update; `pnpm app` is how
  it runs today. `electron-builder`/`forge` is the next step when someone needs to *install* it.
- The bundle duplicates the core's code inside `node_modules`-free app output, so a stale
  `app/core.bundle.mjs` is possible if someone runs the app without `pnpm app:build`; the script and
  `pnpm app` both rebuild it first.

## Update 2026-10-19

Chart marks are now painted on a canvas between two SVG layers; zoom and pan still move one shared
`viewBox`, and hover hit-tests the core's projected marks. The 28-mark measurement behind items 4
and 5 is history: at 10k a rescale measures 35.1–47.4 ms (`pnpm app:measure`). The decision that the
window is a viewport onto the core's drawing, not a second renderer, is unchanged.

## Revisit if

- Installer size becomes the deciding constraint. Then build one Electron installer *and* one Tauri
  sidecar prototype, measure both, and re-decide on numbers rather than on this ADR.
- The charts outgrow the canvas mark layer. It already holds 10k points inside the 50 ms redraw
  budget; a different painter would need a measurement that says so, not a different style.
- The core ever moves to Rust (ADR 0001 warned about exactly this drift): the sidecar question
  disappears and Tauri becomes the cheaper shell.
