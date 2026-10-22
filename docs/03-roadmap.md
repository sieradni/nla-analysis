# Roadmap — the open work, in one place

Status: **landed 2026-10-20.** Commit `cb681b2` holds the code, tests, harness and gate scripts, and
was green on that tree (`pnpm verify`, 264 tests; `pnpm app:measure`; `pnpm app:package:check`); the
docs commit after it holds the documentation, and a third commit carries the two follow-ups decided
on the same day: one column below 980 px of viewport, and a packaged check that compares against its
receipt instead of rewriting it. The code landed as **one** commit rather than the slices step 0 asks
for; that is recorded in the step 0 row.

On **2026-10-20** the user reviewed the window and closed the whole visual gate by direction instead
of per-frame verdicts, then listed what the window gets wrong for a person. Those decisions are
[ADR 0015](adr/0015-user-surface.md) and [05-user-surface.md](05-user-surface.md); the work they
create is **§6 below**, and it comes before the remaining finish plan except where a step is its
dependency. Nothing in that backlog waits on the user.

**Recorded 2026-10-21:** closing a tab is now undoable across a relaunch — the closed-tab list is the
project's `views/.trash/`, read when a project opens (U7) — and two gaps were named rather than
guessed at: the acts inside a reopened tab do not cross the process (the bar is empty, and the window
does not yet say so), and a date/time field is still the one value a person has to hand-type (**U29**).

**Recorded 2026-10-21 (second pass):** U29 is built, and with it the clock every readout uses — the
window was formatting instants in UTC while the reader is not there, so a point taken at 05:10 read as
12:10. The control, the local formatter and the time axis are one slice; what that does not reach is
named in the U11 row (an estimate is not yet a thing the log can hold, and a shape that designates no
time field still has no door to its canonical instant).

**Recorded 2026-10-21 (third pass):** a tab's own acts are reachable from the window. Every tab row in
  the rail carries a menu — **Rename… / Duplicate… / Close tab** — and the CLI has the same three
  (`bench view rm`, `rename`, `duplicate`), so a tab can be removed, renamed or copied without a
  terminal and without a second way to make one vanish. Creating a tab is now undoable: it is the fifth
  kind in the tab's history, and its undo is the project's own close, so the file waits in the trash and
  the redo brings it home. The open tab's lifecycle moved out of `app.js` into
  `app/renderer/tab-actions.js` rather than growing the shell.

**Recorded 2026-10-21 (fourth pass):** imports tell the truth about time. The sheet states the clock
it found (`Time: from the “taken_at” column`) and opens the full choice only on **Change** (U8); a file
with no clock is imported with every row labelled an estimate, matched by row order on a re-read (U9);
and an estimate is replaced from the strip by a measured instant, through one widened
`Workspace.correctPoint` rather than a second write path (U11). U8, U9 and U11 are closed.

**Direction 2026-10-21 — reviews are advisory.** The UI review loop is on hold: a change is done when
the code is green, the states behave and the work is as good as it can be, not when a frame is
approved. The user reports what is wrong from actual use, and each report becomes a row here. No pass
runs `app:capture`, `app:measure` or `app:package:check` unless the user asks or the machine is free:
each opens a real window that takes focus and interrupts them. The seven rows that were awaiting review
are closed by this direction, and nothing in this file waits on a verdict again.

Open work only; completed steps stay in the
[implementation plan](02-implementation-plan.md) progress table. Requirements remain the authority on
*what* ([00-requirements.md](00-requirements.md)); this file is the live, itemised answer to "what is
missing, and what would closing it look like".

## Where it stands

- **Core and CLI:** the append-only log, the `Workspace` write path, imports with dataset
  versions/diffs, shape extension ([ADR 0013](adr/0013-shape-extension.md)) and observation-time
  designation ([ADR 0014](adr/0014-observation-time.md)) are built and tested.
- **Window:** project and tab switching, point entry, correction by selecting a mark, undo, the
  import sheet, version diff, field-pair tabs, and live refresh from another writer are built. Marks
  are painted on a canvas between two halves of the core's SVG, so a 10k rescale is inside the 50 ms
  re-render budget. A tab closes to the project's trash and comes back with `Ctrl+Shift+T`, including
  in a window started after the one that closed it; any tab — on screen or not — can be renamed,
  copied or closed from its own row, and the tab a person creates can be undone.
- **Shipping:** `pnpm app:package` writes a portable Windows build with its own CLI; the release
  workflow is green through artifact upload, but no `v*` tag has been cut. **README and LICENSE exist
  as of 2026-10-22**, which was the stated precondition for the tag, and the job now sets up the
  analysis environment and runs the packaged check (slice 9).
- **User surface:** specified on 2026-10-20 ([ADR 0015](adr/0015-user-surface.md),
  [05-user-surface.md](05-user-surface.md)) and **partly built**. The hover, the entry-bar statuses,
  a panel's facts and state word, and the stale notice now speak plain words from one owner,
  `app/renderer/copy.js`, and the tab strip no longer names a dataset, shape or version. The point
  menu, removal and its restore, correction undo and import undo are built too: a point can be removed
  from its own menu and brought back as the same record, a correction reversed, and an import undone as
  a new version that holds the rows it replaced. The versions panel, the import
  wording, display labels and the resizable rail are not built. §6 is the list.
- **Time is a control, not a syntax (2026-10-21).** An `instant` field is a date/time control with a
  **Now** button in the entry bar and in the correction strip, which are one builder; the moment a
  person presses is stored as canonical UTC, and every time the window shows — strip, status,
  clipboard, rail day, and the axis ticks of a time drawing — is read on the reader's clock. Two
  refusals were already right and are reused: a blank designated instant is refused and its field
  marked, and a value the core cannot parse is refused in the core's own words (U29).
- **An estimated time is labelled, and replaceable (2026-10-21).** An import whose file has no clock
  writes  `t_estimated` on every row it brings, so the fact is the log's and any reader can see it;
  `bench list`, `bench dataset diff` and `STATE.md` all say so, in the words and the JSON alike. A re-read of an untimed file
  pairs rows by the order they were recorded in and keeps each parent's own instant. The strip shows
  the row's own time for a shape that designates no field, including the word **estimated**, and a
  measured instant typed there is written as one correction with `t_observed` and no marker — through
  `Workspace.correctPoint`'s widened time path, not beside it. A shape that designates its time field
  keeps the field as the authority: a correction that disagrees with it is refused.
- **Not built:** the rows below — project management (`bench projects --forget`), the versions panel,
  entry extras, the
  shape flow, a resizable rail, the rest of the user-surface pass, and the delivery items.

## Verified on this tree (2026-10-19)

Both measurements were run against the same working tree, on the machine that built it. Re-run them
before trusting a number in a later session; a stale measurement is how the canvas verdict nearly
rested on the wrong figure. Both harnesses open a real window and bring it to the front: run them when
the machine is free, never as an unattended step (direction 2026-10-21). `pnpm verify` opens no window.

| what | command | observed | budget |
|---|---|---|---|
| keystroke → paint, 10k points, point inside the drawn axes | `pnpm app:measure` | **22.2–25.8 ms** median across runs (p90 28.0–32.4); median split record 12–16 · rebuild 0.1–0.2 · paint 2–9 | 100 ms ([ADR 0003](adr/0003-in-process-core.md)) — within |
| full redraw, 10k points, point outside the drawn axes | `pnpm app:measure` | **35.1–47.4 ms** across runs (rebuild 12–18 · paint 11–14), each `[full redraw]`; the pre-canvas renderer measured 147.0–173.6 ms | 50 ms re-render — within; the harness refuses a missing or patched sample, a programmatic submit, or a miss |
| packaged build, GUI and shipped CLI | `pnpm app:package` then `pnpm app:package:check` | exit 0: `packaged=true`, 2 panels / 28 marks, `n = 14`; a second project with shape `load.v1 (mass, extension)` types three points to `n = 3` through the packaged window, the saved tab holds those axes, and hover/selection name the record; with Python removed the tab dialog offers only `plot` and names the missing runtime; `bench.cmd` does init → import → view → render → `run fit` with no Node and no Python; 369 MB | 450 MB ceiling — within |

The draw path is `renderChartLayers` → two SVG halves → a canvas. A rescale no longer builds ten
thousand elements: the core packs the projected positions, the values and the ids into parallel
arrays, and the window paints one path. The incremental path still appends one mark and measures
22–26 ms end to end; the tab file is written by `persistView` after the paint, which took the save
off the keystroke path.

The rescale row is **one sample per run**, and the frame wait is part of the figure: on a display
that stops producing frames (an occluded window) the sample measures the compositor, so the gate is
meaningful on a visible window. A missing full-redraw sample, a sample the window patched instead of
redrawing, and an entry submitted programmatically are each a failure, not an annotated pass. The
packaged check **compares** against the tracked `docs/ui-review/app-packaged.json` and writes it only
with `--record`, so a plain run leaves the tree clean; its frame is git-ignored.

**These figures predate the 2026-10-20 plain-words pass.** That pass changed what the window says and
which layer composes it, not how a mark is drawn or painted; the budgets are still the gate, but the
numbers above have not been re-measured since, and a later session should run `pnpm app:measure`
before quoting them for a release.

**Measured again 2026-10-20, with the point menu in the tree: the gate fails, and the machine is why.**
`pnpm app:measure` reported a **44.9 ms** median entry (record 25.5 · rebuild 0.3 · paint 19.5) — within
the 100 ms budget — and a **79.9 ms** full redraw, over the 50 ms re-render budget. The same command on
the tree *without* this change, minutes later, reported 42.7 ms and 89.8 ms: the miss is present before
and after the menu, so it is not this slice. The CPU was running at 2.47 of 4.0 GHz and the GPU logged
`command_buffer_proxy_impl` errors during both runs. The gate must be re-run on an idle machine before
a release; the figures in the table remain the last run that passed.

## How this stays current

A plan document cannot prove itself current. These are the rules that keep it honest, and the honest
limit of each:

1. Every row carries a **state** — `done`, `partial`, `missing`, `blocked`, `deferred`, `decision needed` — and
   **evidence**: a test, a command, or a capture path. A row without evidence is a wish, not a plan.
2. The slice that closes a row **updates this file in the same commit**, moving the row to `done` and
   naming what now proves it. [AGENTS.md](../AGENTS.md) makes that part of the definition of done.
3. `done` still means the plan's gates: the behaviour through the interface a user uses, a test that
   would fail if it regressed, `bench check` green. A frame at 100/125/150% is evidence that a visual
   step was looked at, not the thing that closes it (direction 2026-10-21).
4. **Not enforced automatically.** Nothing fails the build when a row goes stale. The only teeth are
   rule 2 and the review at the start of a session. If a generated version is wanted later, the
   progress tables are structured enough to derive one.

## 1. The window: what exists, and what does not

| capability | where it lives | state | evidence / note |
|---|---|---|---|
| open and switch projects, hide missing ones | rail, `Open…` | done | `app/renderer/app.js`; `tests/shell.test.ts` |
| create a project with a chosen shape | `New…` | done | `app-new-project.png`; shell test "creates a project with the shape the dialog chose" |
| tabs: create a plot or a recipe panel | `New tab…` | done | `app-new-tab.png`, `app-version-diff.png` |
| hover tooltip: values only | chart hover | **done 2026-10-20** | `copy.tooltipLines` composes the readout: values with the axis label and unit, the time only when it is not an axis, and no id, dataset, shape, recipe or version. `app-interaction.png` reads `x 3 · y 8.09`; `tests/window-copy.test.mjs`, and `pnpm app:capture` refuses log vocabulary in the hover |
| wheel zoom, keyboard pan, hover ring | chart | done | `app-interaction.png` |
| add a point from the entry bar | entry bar | done | `app-entry.png`; measured 22.2–25.8 ms median (2026-10-19) |
| **fill an instant field with the current moment; read every time on the reader's clock** | entry bar, correction strip, `copy.js`, `chart.ts` | **done 2026-10-21** | `input[type=datetime-local]` + **Now** from the one field builder both rows use; the pressed moment is stored as canonical UTC and reads back locally (before this, a point taken at 05:10 read `12:10` on a UTC-7 machine). A blank time is refused by the core and marked; a correction that leaves the clock alone keeps it to the millisecond. Time-axis ticks use the same clock. Evidence: U29's row; `tests/window-copy.test.mjs`, `tests/chart.test.ts`, and a 30-check Chromium run against the real modules |
| undo the last point (`Ctrl+Z` in an empty bar) | entry bar | done | `app-undo.png`; the same button names whichever act is later — the last added point, removal or correction — and the status offers the matching redo (U4/U5/U6); a closed tab is reopened by the status's own **Undo tab close** or `Ctrl+Shift+T`, outside that history (U7) |
| correct a point by clicking its mark | chart selection | done | `app-corrected.png` |
| import CSV/TSV/JSONL with a mapping sheet and a version diff | `Import…` | done | `app-import.png`, `app-version-diff.png` |
| **remove any point, from its menu, with undo** | point menu, `app/renderer/chart.js` with its acts in `point-actions.js` | **done 2026-10-20** | right-click or Shift+F10 opens **Copy details / Correct… / Remove**; Remove is one click with no reason prompt, the bar's single undo is labelled **Undo removal**, and undo writes `point_restored` naming the retraction it reverses ([ADR 0016](adr/0016-point-restore.md)) — the window passes that id back, so a later removal is never reversed under an older act's name. Evidence: `tests/binder.test.ts` (a restore event), `tests/workspace.test.ts` (a named removal, and a stale one refused), `tests/shell.test.ts` "brings a removed point back as the same record", `tests/cli.test.ts` (retract → restore → a second restore refused), `pnpm app:capture` (right-click, clipboard, remove with focus back on the chart, undo, redo, keyboard, a menu closed by a repaint, a kept recipe panel that offers no menu, a plain refusal frame), `app-point-menu.png`, `app-point-menu-removed.png`. U2, U5, U6 |
| browse dataset versions and diffs | import sheet | partial | `bench dataset list\versions\diff` exists; no panel lists versions or shows a diff outside an import |
| **undo creating a tab** | entry bar, `app/renderer/history.js` | **done 2026-10-21** | the tab's history has a fifth kind: a tab this window created (by the sheet or by copying one) is its own first act. The bar reads **Undo new tab**, and undo closes it through the project's own close path, so its file waits in the trash with its acts; redo moves that archive home again — **Redo new tab** in the status, `Ctrl+Shift+Z` on the keyboard. One button for the one way back: the close an undo performs does not also offer **Undo tab close**. Frames `app-tab-creation-undone.png`; capture checks the archive, the rail, the labels and a byte-identical log |
| close a tab, and reopen it with `Ctrl+Shift+T` | tab header, `app/renderer/closed-tabs.js` | **done 2026-10-21** | **Close tab** takes the file to `views/.trash/`, the status offers **Undo tab close**, and `Ctrl+Shift+T` moves that archive back — same drawing, same counts, same undo when this window closed it, and it still works after a relaunch because the list is the project's trash — with nothing written to the log. Frames `app-tab-closed-100/125/150.png`, `app-tab-reopened-100/125/150.png`, `app-tab-reopened-relaunch.png` |
| **rename, duplicate, and close any tab from the rail** | tab row menu, `app/renderer/tab-actions.js` | **done 2026-10-21** | every tab's row carries a small **⋯** (announced as *Actions for this tab “drift over time”*) opening **Rename… / Duplicate… / Close tab**; Rename and Duplicate share one sheet (`Rename tab` / `Duplicate tab`, with what each will mean), and a refusal is said in the sheet rather than behind it. Rename keeps the drawing and its acts and moves the file; Duplicate opens the copy as a tab of its own. Close works for a tab that is not on screen, which is the case the header's button cannot reach — a background close leaves the drawing alone. Nothing writes an event. The same three acts are on the CLI: `bench view rm`, `bench view rename <name> <new name>`, `bench view duplicate <name> <new name>`, with `rm` going through the close path whose archives the window's reopen reads. Frames `app-tab-menu-100/125/150.png`, `app-tab-sheet-100/125/150.png`; evidence in U7's row |
| rename a project, or forget it from recents | — | missing | registry has no `forget`; deletion is not offered anywhere and should not be |
| extend a shape / designate its time field / run a migration | — | partial | core/CLI paths for extension and designation are done ([ADR 0013](adr/0013-shape-extension.md), [ADR 0014](adr/0014-observation-time.md)); the window has no flow yet |
| record a decision | — | missing | CLI `bench decide` only |
| paste a TSV block with preview, auto-advance, stream mode | — | missing | requirements §6; plan 5.8 |
| keyboard map / shortcut help | — | missing | `Ctrl+Z`, `Esc`, `Shift+Arrow` exist; nothing lists them. U15 adds the **?** sheet and says what Shift+Arrow does |
| **resize / collapse the rail; hide the entry bar** | — | missing | fixed `--rail-width: 268px` (`tokens.css`), no pointer handler, no persisted width; the entry bar cannot collapse. U19 |
| one column below 980 px of viewport | `.grid` media query (`app.css`) | done | two panels side by side stop being legible at 150% (~170 px each); below 980 px the grid is one column and 150% draws a 519 px panel, while 125% (~1013 px) keeps its two. `pnpm app:capture` computes the column count per scaling and throws when it disagrees with the viewport |
| canvas renderer for a rescale | chart painter | **done** | `src/core/chart.ts` splits the drawing and packs the marks; `app/renderer/chart.js` paints them on a canvas. 10k rescale **35.1–47.4 ms** (was 147.0–173.6); `pnpm app:measure` gates on 50 ms and refuses a missing or patched redraw sample, and `pnpm app:capture` asserts the canvas covers the drawing and has 3,589 painted pixels. plan 5.6 |

### Review is advisory, not a gate (direction 2026-10-21)

`docs/ui-review-log.md` has **32 rows**. The batch of **25** reviewed on 2026-10-20 was closed by the
user stating a direction rather than approving frames one at a time; the **7** added since — plain
words, a first run, the drawing's evidence, the point menu, a correction's undo, a closed tab
(including after a relaunch) and an undone import — are closed by the 2026-10-21 direction, which puts
the whole loop on hold: the user reports defects from use, and a report becomes a row here. Frames are
still welcome when the machine is free and still follow the readable protocol in
[05-user-surface.md](05-user-surface.md) §7, but no step waits for one, and none of this is a claim
that every pixel was inspected.

The user also found defects the frames did not make obvious — ids in tooltips, duplicated facts, CLI
instructions in empty states, `New…`/`Open…` spacing, unreadable number formatting. Those are in §6,
not in the log, because the log is for frames and §6 is for the work.

## 2. The finish plan, in order

This is the sequence, not an estimate: each step is one reviewable slice, and a step that needs a
decision below waits for it. Sizes are relative — S is a sitting, M is a day or two, L needs an ADR.

The **user-surface pass in §6 goes first**, because several steps below assume its vocabulary and its
controls: a tab manager that says `main · v2` would have to be rewritten, and point actions that
carry ULIDs would contradict ADR 0015. A step may jump ahead only when it is a dependency of a `U`
row, and that is said in the row.

| # | slice | size | done means | depends on |
|---|---|---|---|---|
| 0 | **Land the tree; close the review gate** | S | **done 2026-10-20** — committed in `cb681b2` plus the docs commit and `a3888b4`; `pnpm verify` is green on the tree (264 tests). It landed as **one** code commit, not slices: `src/core/chart.ts`, the panels moving out of `views.ts`, `app/core.entry.ts` and the renderer share a compile boundary, so a split leaves every intermediate commit failing `tsc` (probe: the new chart alone at the old tree → `app/core.entry.ts(475)` type errors). The review gate was closed **by direction** on 2026-10-20 — 25 rows, no per-frame verdicts, quoted in the log; since 2026-10-21 review is advisory and blocks nothing | — |
| 1 | **Canvas renderer** | M | **done 2026-10-19** — a rescale measures 35.1–47.4 ms at 10k (was 147–174), `pnpm app:measure` exits non-zero over 50 ms and when no full-redraw sample arrived or a submit was programmatic, and `pnpm app:capture` checks the canvas's coverage and painted pixels | — |
| 2 | **Resizable rail** | S | drag handle plus `ArrowLeft`/`ArrowRight` when focused; width in `$BENCH_HOME/ui.json`, restored on launch; no reflow jitter; three-scaling screenshot | U19 |
| 3 | **Point actions** | M | **done 2026-10-20** — right-click and Shift+F10 (on the selected mark) open **Copy details / Correct… / Remove**; Copy writes one line, values and time first and the record id last; Remove is one action with no reason prompt and one undo button in the bar, labelled with the act it reverses; undo writes `point_restored`, so the same id, values, time and version come back, and redo removes it again. A retracted point leaves the plot panels, the count and every action that names it; a recipe panel that cannot rerun keeps the drawing it was saved with, says it is out of date, and stops offering its marks. The earlier wording here said a removed point should stay *visible* as retracted, which contradicts U6's "the mark disappears"; U6 wins, and the log keeps the record. Evidence: `app-point-menu.png`, the capture's menu/clipboard/remove/undo/redo/keyboard checks, `tests/window-copy.test.mjs`, `tests/binder.test.ts`, `tests/workspace.test.ts`, `tests/shell.test.ts`, `tests/cli.test.ts` | U2, U5, U6 |
| 4 | **Project management** | S | `bench projects --forget <path>` dropping recency only, and a rail action that renames or forgets a project. The tab half landed 2026-10-21: `bench view rm/rename/duplicate`, a menu on every tab row, and undo of creating a tab | U7 |
| 5 | **Dataset versions panel** | M | a tab or sheet listing every version with rows and `+n −n ~n`, a diff between any two, and which panels are pinned to which version; reads `Workspace`, runs nothing | — |
| 6 | **Entry extras** | M | paste a TSV block → preview against the shape → commit; auto-advance after Enter; stream mode; requirements §6's targets still hold | `add --stdin` |
| 7 | **Shape extension and designation in the window** | S–M | a flow that says which points lack a field, records the same `shape_extended` / `shape_time_designated` events the CLI does, and shows the new declaration | — |
| 8 | **Delivery hardening** | S–M | a first `v*` tag that produces a downloadable release; `0.1.0` is the version, cut only after README and LICENSE (decided 2026-10-20) — **both landed 2026-10-22**: `README.md` says what this is, what to install, a quickstart whose commands were run against this tree, the CLI surface with what is not built, and how the `.exe` is made; `LICENSE` is MIT with `license` declared in `package.json` — so the precondition is met and the tag is what is left; the packaging check leaves the tree clean (**done 2026-10-20** — it compares against its receipt and needs `--record` to write it) and runs in CI (**added 2026-10-22**, slice 9); the build ships **unsigned** and the docs say SmartScreen will warn (decided 2026-10-20); an installer and auto-update stay out until asked | — |
| 9 | **CI depth** | S | **wired 2026-10-22, awaiting its first runner** — `release.yml` installs `uv` (`astral-sh/setup-uv@v10`, CPython 3.13) and runs `pnpm setup:recipes` before `pnpm verify`, and runs `pnpm app:package:check` as its own step, gated `if: runner.os == 'Windows'`. Measured effect on this tree: with the environment, `pnpm verify` is 379 tests in 24 files, all passing; with `recipes/.venv` moved aside it is **355 passed, 24 skipped** (`run.test.ts` 19, `cli.test.ts` 4, `shell.test.ts` 1 — the 25 in the older wording was off by one). The wiring and that measurement are the evidence available here; the first dispatch is what proves the two steps on a runner, and the packaged check itself was last re-run on this tree on 2026-10-22 (exit 0, against its receipt) | 8 |

### How to check this plan

```bash
pnpm verify                 # typecheck, bundle the core and CLI, 379 tests in 24 files
pnpm app:measure            # real window at 10k; fails over either budget, a missing or patched
                            # redraw sample, or a non-keystroke submit
pnpm app:package            # build the artifact from this tree
pnpm app:package:check      # launch it, type into a custom shape, then run its CLI with Python
                            # removed from PATH
```

`pnpm app:measure` needs a display and a focused OS window, so it — and `app:capture` and
`app:package:check` — must not run while the user is using the machine (direction 2026-10-21): each
brings a window to the front. `pnpm verify` is the always-safe gate. `pnpm app:package:check` compares the
run against the tracked `docs/ui-review/app-packaged.json` and fails on any changed fact; pass
`--record` once, deliberately, to accept a new report. The frame it writes is git-ignored, so a plain
run leaves the tree clean and the check can be a CI step as it stands. A run that prints no report is
a failure, not a wait: the modules the artifact ships are parsed before it launches, so one that
cannot parse is named in about a second, and a stall at the 90 s deadline says that it stalled and
shows both streams instead of guessing that the window could not take focus.

## 3. Core and CLI gaps

These are specified in [01-agent-interface.md](01-agent-interface.md) and not built. A window feature
that needs one of them waits for it rather than duplicating the logic.

Creating a custom-shaped project (`QP Stats`, 2026-10-19) also found gaps that are not in
[01-agent-interface.md](01-agent-interface.md); the reproduction is in
[04-project-onboarding-frictions.md](04-project-onboarding-frictions.md).

| gap | state | why it matters |
|---|---|---|
| `dataset replace`, `dataset show`, `dataset export` | missing | replace is what a corrected instrument export needs; export is how data leaves |
| `dataset restore` (an older version as a new one) | done | `bench dataset restore <id> <version>` appends a `dataset_version_created` naming the version it restored and the one it replaced, plus the ordinary retraction/restore/correction events that bring the rows back; `--empty` restores the empty dataset before version 1. Nothing is deleted and no past version changes. [ADR 0012](adr/0012-dataset-versions.md); `tests/version-restore.test.ts`, `tests/cli.test.ts` "restores an older version as a new one" and "restores the empty dataset" |
| `shape extend` | done | add one field as the next version without rewriting points; duplicate/retype/older-version/missing-type refusals; `bench check` re-validates every extension. [ADR 0013](adr/0013-shape-extension.md); `tests/shapes-extension.test.ts`, `tests/cli.test.ts` "extends a declared shape". Evidence on QP Stats: `qp_stats.v1` → `qp_stats.v2` with `b2b:integer`, then the real observation recorded |
| `shape designate` (observation time) | done | designate one required `instant` field as `time_field` in a new declaration; `add`, `correct` and `import` derive `t_observed` from it and canonicalise the field in `values`; a contradicting `--at` or second import time column is refused, and old points are not reinterpreted. [ADR 0014](adr/0014-observation-time.md); `tests/observation.test.ts`, `tests/import.test.ts`, `tests/cli.test.ts` "designates a shape's observation field". Evidence on QP Stats: `qp_stats.v2` → `qp_stats.v3`, a divergent `--at` refused with no event, `bench check` green and the recorded point unchanged |
| `shape list` / `show` / `validate` beyond the registry | missing | plan 2.2; the window's shape editor will need the read side |
| `annotate` | missing | notes on a point or a range are asked for constantly and have no home |
| `add --stdin`, batch input | missing | streaming and paste both want it |
| unmapped import columns | done | an extra column (e.g. `B2B`) now refuses by default and names itself; `--ignore-unmapped <column>` is the explicit per-invocation opt-out, printed by dry-run/apply and recorded as `ignored_columns`. Exact-column imports are unchanged. Evidence: `tests/import.test.ts`, `tests/cli.test.ts` |
| `recipe show` | missing | the window can say a recipe is missing but not what it needs |
| `--dry-run` on every mutating command, `--id` idempotency | partial | `--dry-run` exists on `import` only |
| analysis cache / debounce / cancel (plan 3.3) | missing | every run recomputes; live sliders and recipe panels on the entry path need this |
| windowed / rolling fit | missing | the third item on the time-variation menu (§5) |
| `index.sqlite` derived index (plan 2.3) | missing | the log folds in memory today; fine at 10k, decide at 100k |
| `view rm` / `view rename` / `view duplicate` | done | the three acts have a subcommand of their own (`sub === 'rm' \| 'rename' \| 'duplicate'` in [view.ts](../src/cli/view.ts#L272)); `rm` goes through the close path, so the archive it leaves is the one the window's reopen reads. Evidence: `tests/cli.test.ts` "renames a tab, keeping its panels and moving its file", "copies a tab as a tab of its own, and refuses to copy over one that exists", "closes a tab from the CLI into the trash, not out of existence" |
| project `forget` | missing | slice 4; the registry grows entries for deleted temp projects otherwise |
| field-pair plotting for custom shapes | done | one resolver ([axes.ts](../src/core/axes.ts)) validates `--x-field`/`--y-field` and the panel's `x_field`/`y_field`; defaults are still `x`/`y`. An `instant` horizontal axis is a real time axis (`Axis.format = 'time'`, clock ticks, a one-day domain for a single point). The window's tab dialog lists the selected shape's fields and refuses a shape with no numeric vertical field. Evidence: QP Stats `altitude over time` and `app against pps`, `tests/axes.test.ts`, `tests/chart.test.ts`, `tests/views.test.ts`, `tests/cli.test.ts`, [app-field-pair-altitude-100.png](ui-review/app-field-pair-altitude-100.png) |
| shape field display labels | missing | names are lowercase identifiers, so `APP` renders as `app`; `unit` is not a label. Needs a shape change |
| observation-time field in a shape | done | `bench shape designate <id> --time-field date` appends a declaration; `add`/`correct`/`import` derive and canonicalise `t_observed` from the field and refuse a contradiction. [ADR 0014](adr/0014-observation-time.md); evidence in `tests/observation.test.ts`, `tests/import.test.ts`, `tests/cli.test.ts`, and QP Stats at `qp_stats.v3` with its original point untouched |
| shape-aware CLI hints | done | [hints.ts](../src/core/hints.ts) is the one owner: `init`, `view list`, `add`/recipe refusals, the empty chart, and the window's no-tabs state all derive their sample command from the declared shape. A custom shape gets `add --values '{…}'` and a `view new … --x-field … --y-field …` pair it can actually run; the window receives the same hint through `entry.nextTab`. Evidence: `tests/cli.test.ts` "takes a custom shape from init through a real first tab", `tests/shell.test.ts` axes candidates |
| empty panel before the first point | done | a plain `view new` with no active rows now saves a real panel: `n = 0`, axes named, and a centered sentence naming the shape's own `add` command. `bench chart` on the same project writes `(0 points)` instead of refusing; a recipe with no rows still refuses, with a shape-derived hint. Evidence: `tests/views.test.ts`, `tests/chart.test.ts`, `tests/cli.test.ts`, [app-empty-tab-100.png](ui-review/app-empty-tab-100.png) |

## 4. Quality and delivery gaps

| gap | state | note |
|---|---|---|
| fixture matrix (plan 2.5) | partial | drift-sensor, duplicate-time, re-export exist; 2-point, 1e5-point, unicode, missing-value, garbage-paste, post-migration do not |
| golden chart snapshots | missing | fits are checked numerically; nothing catches a chart that regresses visually |
| analysis tests in CI | **done 2026-10-22** | the job sets up `recipes/.venv` (`uv` plus `pnpm setup:recipes`) before `pnpm verify`, so the recipe tests run instead of skipping. Measured by moving the environment aside on this tree: **24 skip without it** (19 in `run.test.ts`, 4 in `cli.test.ts`, 1 in `shell.test.ts`; 355 passed) and none skip with it (379 passed). The step has not yet run on a runner |
| `app:package:check` in CI | partial 2026-10-22 | the check passes locally (exit 0 on 2026-10-20 and again on 2026-10-22) and proves the packaged window, a typed custom-axis tab to `n = 3` with hover and selection, the Python-absent degradation and `bench.cmd`; it compares against its receipt and writes it only with `--record`, so it is clean-tree safe. **2026-10-22:** it is now a step in `release.yml`, gated `if: runner.os == 'Windows'`, after `pnpm app:package` and before the zip; it has still never run on a Windows runner, so what is open is the first run, not the wiring |
| README | **done 2026-10-22** | `README.md` is the front door a fresh clone lands on: what the product is, prerequisites with the reason for each, install (`pnpm install`, `pnpm setup:recipes`, `pnpm verify`), a first run whose every command was executed against this tree (init → import a timed CSV → add → view → render → `run fit` → state → the window), the CLI surface by group with what is not built, how `bench.exe` is built and that it is unsigned, and where the requirements, roadmap and ADRs live |
| first Release | not cut | the workflow is green through the 147.4 MB zip upload, but no `v*` tag has been pushed, so there is nothing to download; the `gh release create` step has never run. The version is **`0.1.0`** and the precondition decided 2026-10-20 is met — README and LICENSE exist as of 2026-10-22 — so the tag is the remaining act, not the documentation |
| LICENSE | **done 2026-10-22** | `LICENSE` is MIT, with the copyright holder taken from the repository's own commit identity (`sieradni`). `package.json` declared no license before this, so MIT was chosen and then declared there (`"license": "MIT"`) rather than the other way round — nothing was relicensed, because there was nothing to relicense |
| code signing | missing | **decided 2026-10-20: ship unsigned.** SmartScreen will warn on first launch; `docs/packaging.md` says so, and a certificate is a later decision on its own, not a blocker for the portable build |
| installer / auto-update | missing | portable zip only; ADR 0009 records that choice |
| Python not bundled | by design for now | recipe source ships; `run fit`/`drift` need a `recipes/.venv` or numpy/scipy on PATH |
| renderer module split | **done 2026-10-21** | the window's renderer is split by concern: `tab-actions.js` holds the open tab's lifecycle, `menu.js` the one popover, and `entry.js` — 1,145 lines before this pass — is now the bar's drawing at 77, with `fields.js` (the fields, their values and where the reader's clock meets the log's), `status.js` (the status row, its only writer), `correction.js` (the strip that edits one record), `point-actions.js` (the writes the bar and a point's menu make, and the tab catching up after one) and `acts.js` (the act table and both directions of every kind) beside it. The import graph is acyclic; the one seam it needs is `actions.actOffer`, for the two controls that show what the table would do. Evidence: `pnpm verify` (the same tests, unchanged; 379 in 24 files on this tree today), `pnpm app:capture` on the entry and correction paths at 100/125/150%, and `scripts/package-app.mjs`, whose explicit file list gained these modules **and the three it had been missing** (`menu.js`, `tab-actions.js`, `closed-tabs.js` — the artifact, not the tests, would have failed) |
| perf receipt re-measured | stale | the 2026-10-19 figures predate two window passes, and the 2026-10-20 run missed the 50 ms re-render budget on a busy machine (the tree before the change missed it too). Run `pnpm app:measure` when the window will not interrupt the user, and before any release claim |
| the capture harness hangs instead of failing | missing | a renderer that throws during boot never reports its first paint, and `pnpm app:capture` waits for it forever instead of exiting non-zero — found 2026-10-21, when a missing `export` broke the window's first import and the run sat silent for ten minutes, which reads as a slow machine rather than a broken window. It needs a bounded wait that prints the renderer's own console error and exits |
| documentation polish | partial | the plan still carries pre-window text (Tauri, `src/ui`, `bench/perf.ts`) and says at the top that it is history; the review log's oldest rows use internal vocabulary. Neither is a correctness risk — one pass folding them into a single historical section is planned when the user-surface list is smaller |
| a corrupt closed-tab archive is silent | missing | `listClosedViews` reports files it could not read, but no surface shows them, so a damaged archive simply never appears; say so once in the no-tabs state rather than letting a tab vanish |
| the hover readout never names a point's time | **done 2026-10-21** | `copy.tooltipLines` had an `Observed …` line no caller could reach: the drawing's point objects are `{ id, x, y }`, so the line never fired. The time now travels with the drawing — `ChartPoint` carries `tObserved` and `timeEstimated`, `renderChartLayers` packs them beside the ids, and a patched mark gets them from the fold — so a hover says when the reading was taken and whether the log calls that time an estimate. A time axis labels the value it already shows instead of repeating the instant. The readout is clamped inside the window, which the two-line popup needed at 150% |

## 5. Decisions closed on 2026-10-20

These were open and are now decided by the user's direction; the full reasoning and the affected
surfaces are in [05-user-surface.md](05-user-surface.md) §8 and [ADR 0015](adr/0015-user-surface.md).
None of them is waiting on the user, and none should be reopened without changing those documents.

| # | question | decision | carried by |
|---|---|---|---|
| 1 | deleting a tab | move to `views/.trash/`, offer Undo; no log event, no confirmation dialog | U7 — **done 2026-10-21** (rail menu, `bench view rm`, undo of creation) |
| 2 | where UI preferences live | `$BENCH_HOME/ui.json`, disposable app state, never project data | U19 |
| 3 | tooltip identity | no id in the UI; values only; **Copy details** lives in the point menu | U1, U2 |
| 4 | retraction in the window | a point-menu action, one click, no reason prompt; undo restores the same record | U5, U6 |
| 5 | keep the time picker visible | no: a stated guess with **Change**; the picker opens on request | U8 |
| 6 | refuse an untimed re-export | no: import with a labelled estimate that can be corrected; row-order matching is stated | U9 |
| 7 | one column below 980 px | keep it; 125% keeps two columns, 150% becomes legible | done (`a3888b4`) |
| 8 | name both datasets in a mixed strip | no tab-level lists; a per-panel label only where panels differ | U18 |
| 9 | caption in the accessible name | keep the conclusion, drop the duplicate footer/caption and internal names | U27 |
| 10 | unsigned portable build | ship unsigned, document SmartScreen; signing is a later decision on its own | done ([packaging.md](packaging.md)) |
| 11 | version `0.1.0` | cut only after README and LICENSE exist | finish plan 8 |
| 12 | the receipt behind `--record` | `--record` is the only writer; a plain run compares and leaves the tree clean | done (`a3888b4`) |
| 13 | `label`/`unit` as a declaration-only version | `label` yes, as a recorded declaration-only version; a unit change is still refused | U28 |
| 14 | frames without verdicts | closed by direction on 2026-10-20; **2026-10-21: reviews are advisory, so no frame waits on a verdict** | U25, U26 — both **deferred 2026-10-22** |

## 6. User surface — the backlog

The details, the wording the user used, and the acceptance test for each row are in
[05-user-surface.md](05-user-surface.md). This table is the order of work. **Of the 30 rows, 16 are
done, four are partial, eight have not started, and two are deferred** — U25 and U26 lost their
consumer when the 2026-10-21 direction put the review loop on hold. Rows U1, U3, U10, U12, U14 and
U22 landed on 2026-10-20 through `app/renderer/copy.js`; **U2, U5 and U6** landed with the point menu
and the restore event; **U4 and U7 are done as of 2026-10-21** — one bounded history covers every kind
of act including creating a tab, and a tab can be closed, reopened, renamed, copied or removed from
the window and from the CLI; U13, U17, U18 and U21 are partly built. **U29 is done** (2026-10-21): a
date/time field is a control with a **Now** button, and every time the window reads is on the reader's
clock. **U8, U9 and U11 are done** (2026-10-21, fourth pass): the time column is a stated guess, an
untimed file imports with a labelled estimate, and an estimate is replaced from the strip. **U30 is
done** (2026-10-22): a tab reopened from an archive this window did not close says its earlier changes
cannot be undone here, in the status rather than as a warning, and a tab whose whole history came
back keeps the plain sentence. Review no longer gates any of it (direction 2026-10-21).

### 6.1 A point, and what hovering one says

| id | slice | size | done means |
|---|---|---|---|
| **U1** | Tooltip is a value readout | S | **done 2026-10-20**, and the time line it promised now actually appears (2026-10-21) — values with labels and units, then the point's own observation time on the reader's clock when time is not an axis, and `(estimated)` when the log says the time is an import's estimate. On a time axis the label rides on the value instead of repeating the instant. No id/dataset/shape/recipe/version. The popup is clamped inside the window, so a two-line readout stays readable at 150%. Evidence: `copy.tooltipLines`, `tests/window-copy.test.mjs` (measured vs estimated, the time-axis case, and no time), `tests/chart.test.ts` (the layers pack each point's time and flag), `tests/views.test.ts` (`plotDataset`, the run input and a patched mark all take it from the fold), the capture's `estimated-hover` / `estimated-copy` / `estimated-readout-fit` and `assertPlainSurface('hover')`, `app-interaction.png` |
| **U2** | Point menu: Copy details / Correct… / Remove | S–M | **done 2026-10-20** — right-click a mark, or Shift+F10 with the chart focused on a selected mark, opens a `role="menu"` with the three actions; the keyboard lands on **Copy details**; Escape closes it and returns focus to the chart; choosing an item closes it; a repaint dismisses it. Copied text is one line — values with units, `observed …`, then `record <id>` last — written to the system clipboard through the shell. Evidence: `app/renderer/chart.js`, `point-actions.js` `pointAction`/`copyPointDetails`, `copy.copiedDetails`, `tests/window-copy.test.mjs` (the line, and that the id appears once and last), `pnpm app:capture` (menu, clipboard contents, Escape/focus, edge-safe geometry), `app-point-menu.png` |
| **U3** | Correction strip and statuses in plain words | S | **done 2026-10-20** — the strip reads `Editing x 6.5 · y 16.4 · observed 19 Oct 2026, 06:00`; statuses read `Saved · 15 points in this tab`, `Corrected …`, `Removed · 14 points left in this tab`; the packaged check now records `Editing mass 1 000 · extension 5 000 …` instead of a ULID. Evidence: `copy.status.*`, `tests/window-copy.test.mjs`, the capture's `assertPlainSurface`, `docs/ui-review/app-packaged.json` |

### 6.2 Undo, redo, removal

| id | slice | size | done means |
|---|---|---|---|
| **U4** | One undo/redo history for the tab | M | **done 2026-10-21** — one bounded history covers adding, removing and correcting a point, importing a version, and creating a tab, in both directions. `Ctrl+Z` picks the newest act whatever its kind, `Ctrl+Shift+Z`/`Ctrl+Y` redo, the bar's one undo names it (**Undo added point** / **Undo removal** / **Undo correction**) and the status carries the matching redo (**Redo added point** / **Redo removal** / **Redo correction**). Undoing an added point retracts it and redo restores the same record naming that retraction; undoing a correction writes the earlier values as a new `point_corrected`, redo writes the later ones; a removal is reversed by the restore that names the exact retraction, and a stale one is dropped rather than guessed at. A new act clears the redo branch; the stacks hold 50 acts and drop the oldest; each Save is its own act, never merged; a text field keeps its own undo. One reset seam (`state.showView`, the only caller of `resetTabHistory`) drops both stacks on every view change — another tab, another project, a watched redraw, or a tab built from the dialog — so the bar never offers an act against a point the current drawing did not show. One act table in `acts.js` gives every kind its label, tooltip and undo/redo function, and the words come from `copy.js`; neither module keeps a second list of kinds. **An import is a version**: undo calls `Workspace.restoreVersion` with the version it replaced (or the empty dataset before version 1), which appends a new version holding those rows through ordinary retraction, restore and correction events; redo restores the imported version the same way. The bar says **Undo import** / **Reapply import** and the status says what came back; the version number is in the CLI and the log, not the window (ADR 0015). **An import ends only the acts it touched**: the write reports the records it withdrew or rewrote, and only the undo entries naming those leave the stack — an act whose record the new version holds unchanged keeps its place, so type a point, import, undo the import, undo the point works end to end, while an act on a row the file withdrew or rewrote is dropped rather than offered and refused. The report is the write's own (`ImportedTable`'s `touched`, `dataset` and `version`), so a caller cannot omit half of it and mean "touched nothing"; a report the window cannot read ends every act, which is the safe direction, and import acts are judged per dataset. **The strip ends with the row it edits**: the strip is the tab's other memory of a record, so every path that withdraws one ends the edit — an import that withdrew or rewrote the row, undoing the add, redoing a removal, and a Save the core refused because the row had already gone (`correctPoint` refuses a withdrawn point as `missing`, so the correction never lands on a row nothing shows; `endEditFor` in `correction.js` is the one seam every such path calls). **A refusal that cannot be reversed is dropped**: the core's `kind` crosses the IPC boundary in an envelope the bundle builds (`refusalOf`), and `history.js` keeps an act only when the failure was not classified — a record another writer withdrew takes its undo control away, while a locked file leaves the button to try again. A tab's creation is the fifth kind: its undo closes the tab through the project's own close path, writing no event, and the redo moves that archive home; renaming, duplicating and removing a tab are U7, not this history. A tab a person closes is reopened from the project's trash, also deliberately outside this history. Evidence: `app/renderer/history.js` (`permanentRefusal`), `app/core.entry.ts` (`refusalOf`), `app/main.js` (`guarded`), `acts.js` (`undoLastAction`/`redoLastAction`, `applyImportVersion`), `import.js` (`noteImport` after the write), `tests/history.test.mjs` (both directions, the branch, the bound, the reset, imports, and an import's kept / dropped / other-dataset / unreadable-report reconciliation), `tests/workspace.test.ts` and `tests/shell.test.ts` "refuses a correction onto a withdrawn row" (the refusal, its `missing` kind across the window's door, and a byte-identical log), `tests/version-restore.test.ts` (rows, empty first version, optional-field exactness), `tests/cli.test.ts` (`dataset restore`, both directions and refusals), `tests/shell.test.ts` (a correction and a version restored through the bundled core), capture's `correction-undo` / `correction-undone` / `correction-redone`, `undo-added` / `redo-added`, `import-undo-ready` / `import-undone` / `import-redone`, `import-keeps` / `import-keeps-undone` / `import-keeps-point-undone` / `import-drops` / `import-drops-strip` / `import-drops-save` / `import-drops-undone` (typing kept across an import and undone after it; a withdrawn typing dropped, with no event written by the next `Ctrl+Z`; the strip opened on the withdrawn row ends with it, and `Enter` writes no correction), `undo-strip` (a strip open on a point, the add undone under it with `Ctrl+Z`, the strip gone and `Enter` writing nothing), `refused-undo` (a record withdrawn under the window, a real `Ctrl+Z`, no event written and the control disabled), the second undo checks with the log read back, `app-correction-undo.png`, `app-import-undone.png` |
| **U5** | `point_restored` event | M | **done 2026-10-20** — `point_restored` carries `dataset`, `restores` (the retraction event) and `version`; it repeats no values, so the same id, values, observation time and version come back. The fold applies it only to the retraction in force, counts it in the version it happened in, and `bench check` reports a chain that does not resolve. One event per undo; `Workspace.restorePoint` refuses an active point, and a caller that names a retraction gets that act reversed or a refusal when it is no longer the one in force. Evidence: `src/core/events.ts`, `binder.ts`, `workspace.ts`, `tests/binder.test.ts`, `tests/workspace.test.ts`, `tests/shell.test.ts`, `tests/cli.test.ts`, [ADR 0016](adr/0016-point-restore.md) |
| **U6** | Remove is one action, no ceremony | S | **done 2026-10-20** — one click in the menu; the status reads `Removed · 14 points left in this tab` and the bar's undo reads **Undo removal**; no reason is asked for and none is recorded (the capture asserts `reason === undefined`); the CLI can still pass one. Evidence: `point-actions.js` `removePoint`, `copy.status.removed`, capture's `removed` check |
| **U7** | Tab delete is recoverable | S | **done 2026-10-21** — **Close tab** moves the file to `views/.trash/<slug>-<timestamp>.json` (last 20 kept, oldest pruned, invisible to `listViews`, ignored by `bench check`) and the window keeps a list of those archives; **Undo tab close** in the status, or `Ctrl+Shift+T` from anywhere including a text field, moves the archive home and reopens it with the same drawing and — when this window was the one that closed it — the same undo. A close is a window act: no event, no confirmation, no entry in the tab's own history, and the list survives a tab switch or a repaint because it lives outside `state.showView` (opening another project refills it — a closed tab belongs to the project it was closed in). **A close outlives the process**: the list is the project's trash, read by `listClosedViews` when a project opens, so a fresh window can reopen what an earlier one closed; the archive is moved, never copied, so a reopen writes no new bytes, and the acts of a tab closed before the window opened are honestly gone (the bar is empty). An empty list does nothing at all rather than refusing. The same three acts are in the CLI — `bench view rm`, `rename <name> <new name>`, `duplicate <name> <new name>` — and `rm` goes through this close path, so the archive it leaves is the one the window reopens (`tests/cli.test.ts`: a rename keeps its panels and moves its file, a copy refuses to overwrite one that exists, a close leaves a restorable archive). Evidence: `src/core/views.ts` (`closeView`, `listClosedViews`, `restoreClosedView`, `trimTrash`), `app/renderer/closed-tabs.js`, `app.js` (`closeOpenTab`/`reopenClosedTab`/`loadClosedTabs`), `history.js` (`snapshotTabHistory`/`restoreTabHistory`), `tests/closed-tabs.test.mjs`, `tests/history.test.mjs`, `tests/views.test.ts` "closing a tab", `tests/shell.test.ts` "closes a tab, lists it for the next window, and moves the same one back", capture's `tab-closed` / `tab-reopened` / `tab-reopen-empty` / `tab-closed-by-key` with real keys and the log read back, then `relaunch-prepared` / `relaunch-start` / `relaunch-reopened` / `relaunch-empty` from a **second Electron process** on the same project, `app-tab-closed-*.png`, `app-tab-reopened-*.png`, `app-tab-reopened-relaunch.png` |
| **U30** | A reopened tab says its earlier changes cannot be undone | S | **done 2026-10-22** — a tab reopened from an archive this window did not close now says so in the status row under the entry bar: `Reopened “drift over time” · changes made before the restart cannot be undone here.` It is one sentence, not a warning box and not a control, and it appears only when the acts are out of reach — a reopen of a tab this window closed keeps the plain `Reopened “…”.` with its undo, a tab whose history came back with nothing in it needs no sentence, a freshly created tab has nothing older to explain, and an empty closed list still does nothing at all. `copy.status.reopenedTab` composes both wordings, `closed-tabs.js`'s `takeClosed` reports `historyLost` (this window holds no acts for that archive), and `tab-actions.js` passes it to the one status row — `#entry-status`, `role="status"` and `aria-live="polite"`, so the sentence is also what assistive tech reads and no `aria-label` shortens it. **Undo itself is untouched**: nothing about the stacks, the refusal policy or the reopen changed except the words. Evidence: `tests/window-copy.test.mjs` (the exact sentence; the plain sentence for a tab this window closed and no caveat for a fresh one; the seam that passes the fact, and that no other renderer module composes the sentence; the live region carrying it), `tests/closed-tabs.test.mjs` (a list restored from the project's trash takes `historyLost: true`; a close in this window takes `false` even with an empty stack) — both failed before the change and pass after, `pnpm verify` 379 tests in 24 files. **Not frame-verified**: the window was not opened (direction 2026-10-21), so that frame is optional rather than owed |

### 6.3 Time, imports, confirmation

| id | slice | size | done means |
|---|---|---|---|
| **U8** | Time column is a stated guess | S | **done 2026-10-21** — one line above the preview, `Time: from the “taken_at” column`, with **Change** beside it; the picker is shut until it is pressed, and the plan is computed from the first paint. The guess is found by header name first and then by the values, so a clock under a name nobody listed (`taken_at`) is found rather than mistaken for a file with no clock — and only an ISO-shaped column counts, so a column of readings is never read as one. **Change** opens the select and puts the keyboard in it; choosing nothing is the one refusal left (`choose the column that holds the observation time, or say the file has none`), and choosing the estimate replaces the line and replans. A shape that designates its time field says `Time: from the “date” field` and has no picker at all. Evidence: `copy.importTimeSaid`/`importTimeChange`, `import.js` (`renderImportTime`, `timeOption`), `suggestTimeColumn`'s value scan, `tests/import.test.ts` "finds a clock under a name it does not know", `tests/window-copy.test.mjs`, capture's `import-named-time-said` and `import-time-choice` (Change opens the picker and focuses it), `app-import-time-choice.png`, `app-import-time.png` |
| **U9** | Untimed files import with a labelled estimate | M | **done 2026-10-21** — the sheet offers `No clock — use the row order (estimated)` and states it before the click (`Time: the row order — every row is marked estimated`); the plan and the status repeat it, and the status says what to do (`correct a point to replace one`). Every row the write brings carries `t_estimated: true` in the log, anchored one millisecond apart in file order, and the import record carries `time_estimated`; the diff of a re-read pairs rows by the order they were recorded in (`diffRowsByOrder`), so a value that moved is one changed row and the parent keeps its own instant, while a re-sorted file honestly reports every disturbed position as changed. `bench list` marks the row `(estimated)`, its JSON carries `t_estimated`, `bench dataset diff` marks an estimated row in its detail lines and as `t_estimated` in JSON (and names the instant a changed row keeps, not the plan's fresh anchor), `STATE.md` says how many active rows have one, and in the window the hover and **Copy details** both say `(estimated)` after the time — with the marker read from the drawing's own point, which the core filled from the fold. A file *with* a clock never falls back: the value scan finds it, and a shape that designates its time field refuses the estimate outright. Evidence: `src/core/import.ts`, `versions.ts` (`diffRowsByOrder`), `import-columns.ts` (`estimate`), `cli/import.ts` (`--estimate-time`, the plan line), `cli/index.ts` (`list`, `correct --at`, `dataset diff`), `cli/diff-output.ts`, `state.ts`, `tests/import.test.ts` (the label, the re-read by position, the re-sort, both refusals), `tests/workspace.test.ts`, `tests/cli.test.ts` "imports an untimed file as a labelled estimate" (including the diff that marks one row and not its measured neighbour), capture's `import-estimate` / `import-estimated-result` / `import-estimated-cli`, `app-import-estimated.png` |
| **U10** | Import summary in plain language | S | **done 2026-10-20** — the sheet reads `5 rows · 5 columns · 2 comment lines skipped · replaces the 14 rows here now`; the plan reads `5 rows · 5 added, 14 removed, none changed · 14 rows not in this file will be withdrawn, not deleted`; the button says `Import 5 rows`. No version number, no `+1 −2 ~1`, no dataset or shape id anywhere in the sheet. Evidence: `copy.importSummary`/`importPlan`/`importButton`, `tests/window-copy.test.mjs`, capture assertions and `assertPlainSurface('the import sheet')` |
| **U11** | Correct the observation time from the window | S–M | **done 2026-10-21** — the correction row draws the same date/time control as the entry bar, opened on the log's own instant; editing it writes a `point_corrected` whose designated field the core re-derives `t_observed` from, the tab is rebuilt so the mark moves on a time axis, and the status reads `Corrected · observed <local time> · n points in this tab`. A correction that edits another field leaves the clock exactly as the log had it, to the millisecond, because the control shows whole minutes and remembers the instant it was filled from. Undo of a time correction comes free: the act stores both sides, and the earlier time is written back as another correction. **An estimated time is replaced from the same row**: a shape that designates no field gets an `observed` date/time control filled from the row's own instant, with the word **estimated** after it while the log says so, and a typed instant is sent as `tObserved` — the widened `Workspace.correctPoint` path, which writes `t_observed` and lets the fold drop the marker, and which still refuses a designated field that disagrees and still refuses an empty correction. The strip then closes and the status reads the measured time without the word. Evidence: `workspace.ts` (`correctPoint`'s `options.tObserved`), `correction.js`, `fields.js` (`renderObservedField`, `observedFieldValue`), `view-session.ts`, `tests/workspace.test.ts` (replace, keep on a value edit, the designated refusal, no-empty), `tests/cli.test.ts` (`correct --at`), capture's `estimated-strip` / `estimated-replaced` (a real click on the mark, the control filled and marked, `Enter` saving, the log read back, and the strip fitting its row at 1/1.25/1.5×), `app-point-estimated.png` |
| **U29** | A date/time field can be filled with the current moment | S | **done 2026-10-21** — an `instant` field is `input[type=datetime-local]` plus a **Now** button, built by the one `buildEntryFields` that draws both the entry bar and the correction strip, so the two cannot drift. **Now** fills the current local wall clock; the moment pressed is stored as canonical UTC (`instantFromInput`), and the same instant reads back on the reader's clock (`instantFromValue`/`formatInstant`). A typed value still works inside the control. A blank field is refused by the core and its field marked and focused, never stamped — so recording is **Now then Add**, two presses, deliberately: a defaulted instant would record a time nobody observed (requirements §7: "a blank time is refused rather than stamped silently"). The control is a native button and input, both keyboard reachable, and `title`/`aria-label` say what Now does. Evidence: `app/renderer/fields.js` (`buildEntryFields`, `coerceValue`, `fieldValueMap`), `app/renderer/copy.js` (`instantInputValue`, `instantFromInput`, `formatInstant`, `formatDay`), `tests/window-copy.test.mjs` (a local wall clock ↔ canonical UTC round trip through the core's own observation decision; the untouched-clock case keeps milliseconds; the strip says the time once and never as ISO; the status names a moved time), `tests/chart.test.ts` (time ticks are on the reader's clock), `tests/shell.test.ts` "moves a designated observation time through the door the time control uses" (the bundled core moves `t_observed` with the field, leaves it alone when another value is corrected, and refuses an unparseable time with the field named and a byte-identical log). Exercised headlessly in Chromium against the real modules — 30 checks across the entry bar and the correction strip on a UTC-7 machine, all passing: the control's type, Now's value, the stored UTC instant, the refusal marking/focus, the correction prefill, an untouched clock kept byte for byte, and a moved time written and said. **Not** frame-verified at 100/125/150%: the window was not opened (direction 2026-10-21), and under that direction no frame is owed — a frame is evidence, not a gate. The real limitation stays recorded where it belongs: at a narrow window the field group wraps even though the control itself stays on one line (U20's territory) |

### 6.4 Explanation: badges, captions, numbers

| id | slice | size | done means |
|---|---|---|---|
| **U12** | No `current`; explain the rest | S | **done 2026-10-20** — `current` is silence, `Out of date` carries a hover sentence and a working **Refresh**, `Data gone` and `Cannot tell` are explained, and `DOF` is always written `degrees of freedom`. The verdict is its own chip under the drawing and explains itself in consequences on hover *and* on keyboard focus (`Tentative. The data cannot rule out no trend yet. More observations would make this test meaningful.`), and the same sentence is in the accessible name. Evidence: `copy.panelStatus`, `copy.notice`, `copy.panelEvidence` (degrees of freedom from the drawing's own numbers), `copy.verdictExplanation`, capture `assertVerdictExplained` (hover, focus, reachable, a sentence, no vocabulary) and `app-verdict.png` |
| **U13** | One number format | S | **partial 2026-10-20** — `copy.formatValue`/`formatInstant`/`plural` now format the hover, statuses, readouts and the rail's date. Not done: the core still formats axis ticks and captions itself, so a caption's interval is still bracketed. Evidence: `tests/window-copy.test.mjs` |
| **U14** | One title, and numbers with names | S | **done 2026-10-20** — the drawing is plain: no title, no `main · drift` subtitle, no footer, no provenance attributes, so the strip is the one place the panel is named. The evidence line under it reads `n = 14 · 2 regimes of 2 parameters · 10 degrees of freedom`, and the caption leads with the conclusion. The evidence line is composed from `chart.evidence` — point count, regimes, parameters, degrees of freedom, band, or the reason no curve is drawn — so no module parses the artifact's footer prose. Evidence: `renderChartLayers(spec, { plain: true })`, `tests/chart.test.ts` (the plain drawing names nothing), `tests/window-copy.test.mjs` (every evidence shape, and the no-footer-read guard), `copy.panelEvidence`, capture's `charts` and `evidence` surfaces |
| **U15** | Hints that say what happens | S | `Click a point to edit it`; a **?** help sheet; Shift+Arrow described as next/previous *point*; every shortcut in the sheet |
| **U16** | Truncated text is readable | S | app tooltip with the full value on hover; context-menu **Copy**; rail paths, tab names, panel titles, long statuses |

### 6.5 Show each fact once

| id | slice | size | done means |
|---|---|---|---|
| **U17** | Rail controls that do not look broken | S | **partial 2026-10-20** — the labels are `New project` / `Open project` / `New tab` / `Import file`, applied from `copy.labels` at boot, so no label ends in `…`. Not done: the header's grouping and spacing. Evidence: `app/renderer/copy.js` `applyStatic`, `app-100/125/150.png` |
| **U18** | Deduplicate the facts | M | **partial 2026-10-20** — `main`, the shape id and the version list are gone from the tab strip and the panel facts (`2 panels · 14 points`); the tab sheet names a dataset only when there is more than one; the verdict is said once, as the chip beside the evidence, not again in the facts; and the drawing no longer repeats the panel's title. Not done: the entry readout still repeats the count. Evidence: `copy.tabFacts`, `copy.datasetOption`, `copy.panelFacts`, capture's strip and drawing assertions |
| **U19** | Resizable, collapsible rail; hideable entry | M | drag + keyboard resize, `Ctrl+B`, min/max, width in `$BENCH_HOME/ui.json`, persisted; entry bar collapses to one line with undo still reachable; no layout shift |
| **U20** | 150% keeps pairs side by side | S | axis pickers and entry fields stay in a row at 150% (stack only when genuinely narrow); the sheet fits the viewport; measured at all three scalings |
| **U27** | Accessible names say the conclusion | S | title, axes with units, `n`, verdict in visible words, one interaction hint; under ~25 words; no id or internal name; caption available as a description |
| **U28** | Shape display labels | M | `label` on a field, set by a recorded declaration-only version; used on every surface a person reads; a unit change is still refused; points keep their shape |

### 6.6 Buttons, not commands

| id | slice | size | done means |
|---|---|---|---|
| **U21** | The window offers the action | M | **partial 2026-10-20** — the stale notice is a sentence plus a working **Refresh** button (capture clicks it and reads `Refreshed the panels it could. 1 panel still needs its analysis run again.`); the empty-tab, tab-gone and no-project states no longer print a command. Not done: a stale plot does not refresh itself, and an error from the core still ends with the core's words. Evidence: capture `notice`/`refreshed`; `app.js` `actions.refreshTab` |
| **U22** | The empty first tab teaches by doing | S | **done 2026-10-20** — the first panel draws `No observations yet. Add the first point below.` from `copy.panelEmpty`, with no command, dataset or shape id; the cursor is in the first field and the bar adds the point. The core's own sentence (which names `add --values …`) is rewritten from the copy owner after mount, and the accessible name uses the same sentence. Evidence: `tests/window-copy.test.mjs`, capture `empty-panel` read and `assertPlainSurface('the empty first panel')` |

### 6.7 The agent's half of the contract

| id | slice | size | done means |
|---|---|---|---|
| **U23** | State the assumption, then the change | S (docs) | application and project `AGENTS.md` carry the rule: say the guessed time/field/estimate before the write, summarise the change after; no confirmation for a routine reversible action |
| **U24** | CLI human output matches the window | S | first line of a mutation is the change in plain words (`1 row added, none removed, none changed → version 5`); id/event on the next line; `--json` and exit codes unchanged; tests assert the line |

### 6.8 The review process

| id | slice | size | done means |
|---|---|---|---|
| **U25** | A readable review row | S (docs) | **deferred 2026-10-22** — no consumer: the 2026-10-21 direction put the review loop on hold, so a frame and its row are evidence rather than an approval request, and a defect reported from use becomes a roadmap row. Re-open it with U26 if frames resume. Original done means: four parts — screen, check, wrong looks like, your call — with no internal names; glossary at the top; historical rows keep their text but are closed |
| **U26** | A contact sheet with a start-here path | S | **deferred 2026-10-22** — no consumer while frames are not being requested (direction 2026-10-21). Original done means: opens with the three scalings and one sentence each for hover, entry, undo, refusal, import, packaged; captions say what a frame demonstrates; filename in small type |
