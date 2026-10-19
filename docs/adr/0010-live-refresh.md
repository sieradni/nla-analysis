# ADR 0010 — The open tab follows the project on disk

Date: 2026-10-19
Status: accepted
Related: [0007](0007-freshness-before-writes.md) (read before write), [0006](0006-window-write-path.md)
(the window's write path), [0003](0003-in-process-core.md) (in-process seam, 100 ms entry budget),
[0005](0005-desktop-shell.md) (the window)

## Context

ADR 0007 made every write read the log first, so the window cannot persist numbers the file has
moved past. It left the display behind: an idle window keeps drawing what it last read. That is the
central workflow's blind spot, because the product is an agent operating the project while a window
is open. The audit's shape:

1. Window open on `drift over time`, `n = 14`.
2. An agent appends a point, or replaces the tab, or deletes it.
3. The window shows 14 marks until someone clicks the tab again. Nothing on screen says it is old.

The window must notice the project change, redraw the whole tab, and never patch the drawing it has
(ADR 0007, decision 5). It must also not take the cursor away from someone who is halfway through
typing a number.

## Options, priced

| option | cost | catches |
|---|---|---|
| renderer polls every second | one IPC + two `stat`s per second, forever, plus screen state waking an otherwise idle process; still up to 1 s stale | everything, eventually |
| `fs.watch` and redraw on every event | none while idle | most things, and it loops: the window's own `refreshView` saves the tab, which is another event |
| **`fs.watch` + a stamp check in the core** (chosen) | 0.25 ms per event at 10k points, 0.48 ms at 14 | everything the event delivers, including its own writes without a loop |

Measured on this machine, bundle and core as the window loads them:

- **A watched event with nothing behind it**: median **0.25 ms** at 10 000 points, **0.48 ms** at the
  14-point fixture. Two `stat`s and a compare; no read, no render.
- **A change that needs a redraw**: median **17 ms** at the fixture, **225 ms** at 10 000 points
  (range 104–244). This is the whole tab re-materialized and re-rendered, and it happens only when
  another writer actually moved the file.
- **A window's own keystroke**: no extra work. `Workspace.append` records the log stamp after its
  own write and `refreshView` records the tab file's stamp after its save, so the event the watcher
  sees touches files that are already the ones the session holds.

Polling was rejected because the cost is paid while nothing happens and the staleness is still
bounded by the timer. Unconditional redraw was rejected because the window saves the tab after a
rebuild, and that save is a filesystem event: without a stamp comparison it would repaint forever.

`fs.watch` is not reliable on network shares or everywhere on every platform. That is acceptable
here because an event is only a hint: the check that follows is a `stat`. A missed event means one
stale frame until the next write, tab click or watcher event — stated below rather than papered over.

## Decision

1. **The main process watches, the core decides.** `watchProject(dir, onChange)` watches `data/` and
   `views/` with `fs.watch`, coalesces a burst into one callback after 150 ms, and closes cleanly.
   The renderer says which tab is on screen (`bench:watch`, one at a time, `null` to stop); a project
   switch or a closed window stops it. The window never polls the disk.
2. **A change is a question, not an instruction.** `reloadTab(dir, name)` returns `same`, `redrawn`
   or `gone`. It compares the workspace's log stamp and the tab file's stamp against what the
   session last read or wrote. `same` is the common answer for the window's own writes and costs two
   `stat`s; nothing is sent to the renderer then.
3. **A redraw is a whole tab.** `redrawn` is `refreshView(dir, name, { draw: true })`: plot panels
   are re-materialized from the new log, a recipe panel is kept and reported `stale`, and the tab
   file is rewritten only when a panel was rebuilt. The renderer replaces its state and draws the
   new SVGs; it never patches marks onto the old drawing.
4. **Replaced and deleted are different answers.** A view file replaced by `bench view new --force`
   has the same name and a new stamp: the cached copy is dropped and the file is read again. A file
   that is gone answers `gone`: the rail loses the tab, the stage shows a named empty state saying
   the file is no longer there, and the entry bar falls back to the project's first dataset so a
   point can still be typed.
5. **The bar is not part of the drawing.** The fields are rebuilt only when the target changes
   (dataset, shape, field list, add-versus-correct), so half-typed text and the cursor survive a
   redraw. A redraw restores focus to the same panel index when the keyboard was in a chart. A
   refusal the user is reading is not replaced by a redraw notice.
6. **Failures are shown, not swallowed.** A tab that cannot be re-read (corrupt JSON, a race with a
   writer) sends `error`; the bar says what failed and keeps the last drawing, which is honestly
   what this window last read. The next event tries again. A watcher that cannot be armed at all
   says so in the bar too, rather than leaving a window that quietly stopped following the project.

## Costs, stated

- **225 ms of main-process CPU** for a redraw at 10 000 points, on top of a 150 ms debounce. It is
  not on the keystroke path — a window's own writes answer `same` — but a sustained external writer
  (an agent appending every 100 ms) would keep the window redrawing and competing with typing.
  Incremental patching would be faster and is exactly what ADR 0007 forbids for a changed log.
- **One queued reload** at a time: events that arrive during a reload schedule one more pass, not a
  queue of passes.
- **Windows and network shares.** `fs.watch` can miss events on some shares; the stamps still make
  each event correct, but a missed one leaves the tab stale until the next event, tab click or
  keystroke. There is no timer backstop by design.
- **One window, one tab.** The watcher is armed for the tab on screen. Two windows on one project
  are still outside this ADR; each would watch what it draws.
- **A recipe panel does not refit.** Live refresh follows ADR 0007: a panel drawn by a recipe goes
  `stale` and says so. Refitting would need the analysis runtime on a filesystem event, which is a
  different decision.

## Proof

- `tests/watch.test.ts`: a burst of writes across `data/` and `views/` is one callback, and `stop()`
  silences the watcher.
- `tests/shell.test.ts`, against the bundle the window loads: no change → `same`; the window's own
  write → still `same`; an agent's append → `redrawn`, plot panel at `n = 16`, fitted panel `stale`;
  a replaced file → the new one-panel tab; a deleted file → `gone` with the project's entry target.
- `pnpm app:capture`, in the real window on a scratch copy: half of a number (`4`) typed into the
  bar, then the real `bench` binary appends a point while nothing is typed. The frame
  [app-live.png](../ui-review/app-live.png) shows `n = 15`, 15 marks in the plot, `4` still in the
  field and the cursor still there; the capture fails if any of that is untrue. Replacing the open
  tab with `bench view new --force` redraws it as one panel
  ([app-tab-replaced.png](../ui-review/app-tab-replaced.png)); deleting the file leaves
  [app-tab-gone.png](../ui-review/app-tab-gone.png) with the empty state, no rail entry, and
  `n = 15` still in the bar.
- `pnpm app:measure` (10k points, 8 typed points) after the change: median **33.0 ms**
  (record 22.5 · rebuild 1.3 · paint 10.2), within the 100 ms budget. The watcher's own events
  during that run answered `same`; an earlier version of the handshake redrew the tab once after a
  keystroke and that run's median was 101 ms, which is how the race was found.
- `pnpm app:package:check` still passes: the packaged build draws its project and reports the
  missing analysis runtime, with the watcher armed exactly as in development.

## Revisit if

- A 10 000-point redraw at 225 ms becomes visible as jank under a sustained writer. The fix is an
  incremental renderer or a worker, not a looser freshness rule.
- A second window or a shared drive needs watching with a different reliability story.
- Users want the bar to follow a correction made elsewhere: today a correction in progress keeps the
  values it was opened with, and saving it appends a correction of that id.
