# ADR 0007 — A write is never built on a bind the log has moved past

Date: 2026-10-19
Status: accepted
Related: [0003](0003-in-process-core.md) (in-process seam, 100 ms entry budget),
[0006](0006-window-write-path.md) (the window's write path), [0005](0005-desktop-shell.md) (the window)

## Context

ADR 0006 left the window holding a `Workspace` and stated the cost plainly: an append made by the
CLI while the window is open is invisible until a tab is reopened. That was written as a staleness
limitation. It is worse than that, and the audit measured it on a scratch copy of the fixture:

1. Open the window on a project with 14 active points.
2. Append one point through the real CLI. The log now holds 15.
3. Type a point into the window. It appends, then reports **15 active** — its cached bind plus its
   own event — and writes that number into `STATE.md` and into the tab's saved view.

The log was never damaged. But `STATE.md` and the tab file — the two things another session reads to
find out what is true — both said 15 when the log held 16. In a product whose whole claim is that
every number traces to the log, that is the worst class of bug available: a quietly wrong number that
survives a restart, in derived files, with nothing to indicate it happened. The tab's fingerprint was
taken against the stale bind too, so it read `current` while it was a point short.

The case is not exotic: the premise is an agent operating the project on the user's behalf, and the
agent works through `bench` while the window is open.

## Options, priced

Measured against a 10,000-point log (`freshen` below means `stat`, compare, and re-read only if the
file changed):

| option | cost on a keystroke | catches |
|---|---|---|
| re-read the log before every write | +20.8 ms every time | everything |
| **`stat` + compare, re-read only on a difference** (chosen) | **+0.045 ms** (p90 0.099) | everything |
| `fs.watch` and invalidate on the event | +0 on the write path | most things, eventually, and not reliably on Windows network drives |

A full pull is 20.8 ms at 10k — affordable once, wasteful 10,000 times for an event that happens a
few times a session, and it would put a whole extra log read on the path ADR 0003 measured to fit in
15.7 ms. The `stat` is 45 microseconds: on a 26–30 ms keystroke it is inside the measurement noise.
`fs.watch` was rejected because the write path would then depend on an event arriving *before* the
write, which is a race with no backstop; the check has to be a question the writer asks itself.

## Decision

1. **Freshness belongs to `Workspace`, not to a handler.** It is the only thing that owns a bind, so
   it is the only thing that can know a bind is out of date. `isStale()` is the question and
   `freshen()` is the repair; both return what happened rather than logging it.
2. **Every mutation asks before it reads anything it will validate against**, not after it has built
   an event: `recordPoint`, `correctPoint`, `retractPoint`, `appendAll`, `recordDecision`,
   `recordAnalysis`, and `append` itself. The check sits above the state read, because a value read
   from a stale bind is a wrong answer, not a slow one.
3. **Every persist asks too.** `writeStateBrief` and the facade's `refreshView` (which saves the tab)
   check before writing, because they are step 3 of the scenario above: derived files that outlive the
   session. `pull` itself counts its reads, so a caller can report a repair without making one.
4. **The window reports a repair instead of hiding it.** `recordPoint` returns `reread: true` when the
   log had changed; the bar appends "the log had changed on disk, so it was reread before this point
   was added". Opening a tab says the same when it rereads.
5. **A repair forces a redraw, never a patch.** If the log moved, the drawing on screen was made from
   a state the file has passed, so patching one mark onto it and then saving the tab would mark a
   stale picture `current`. The window rebuilds the tab instead. The same rule covers the narrow race
   where the log changes between the paint and the tab-file catch-up: `catchUp` redraws rather than
   fingerprinting the new log against the old drawing.
6. **A second retraction is refused.** The window's undo caches the id it appended, so undoing after
   the CLI already withdrew that point would have appended a `point_retracted` event describing an act
   that changed nothing. `Workspace.retractPoint` now refuses with `point "…" is already retracted`.
   This is the same defect shape — a write built on a stale belief about a point's status — and the
   fix belongs in the seam so the CLI gets it too.

## Costs, stated

- **45 µs per mutating call** (`stat` + compare), and the same again for each persist. Measured on the
  real 10k project: `isStale` median 0.045 ms, p90 0.099 ms.
- **20.8 ms when a repair actually happens**, on that one keystroke, before the append. Rare by
  construction; visible only as a slightly heavier Enter.
- The window still cannot *show* another writer's work until it reads again — an idle window with no
  keystrokes holds the drawing it had. This ADR fixes what the window **writes**, not what it displays
  between actions. Making the view live needs a watcher and a repaint budget, which is a separate
  decision.
- A `stat` compares size and mtime. A writer that rewrites the log to the same size within the
  filesystem's mtime granularity would be missed; appends — the only thing this log supports — always
  grow it.

## Proof

The audit's reproduction was at the core layer, which is exactly the weakness that let the bug ship:
nothing exercised the seam *and* a second writer at once. The harness now does, in
[tests/shell.test.ts](../../tests/shell.test.ts), against the bundle the window actually loads:

- the window opens a tab (14 active), the **real CLI** appends a point, the window then types one:
  `reread` is `true`, `active` is 16, the saved tab says `n = 16`, `STATE.md` says
  `16 active points (17 recorded)`, `bench view show --json` calls the panel `current`, and
  `bench list --json` — a third reader — agrees on 16;
- the window appends a point, the CLI retracts it, the window's undo is refused by name, and the log
  holds exactly one retraction of that id.

Unit tests cover the two persist paths directly, and the ordinary write test asserts `reread === false`
so the stat check cannot silently become a re-read on every keystroke.

And because a bundle test is still not a window, `pnpm app:capture` now spawns the real `bench`
binary mid-run and then types a point into the focused window. The capture fails on its own
assertions if the bar does not say it reread, if the count is not 16, or if the saved tab disagrees;
the frame is [app-second-writer.png](../ui-review/app-second-writer.png), with `n = 14` and 14 marks
in the panel just before it — the window really was behind the file.

Measured after the change (`pnpm app:measure`, 10k points, 8 typed points): median **29.5 ms**,
record 15.5 · rebuild 1.2 · paint 10.5, tab file 30.7 ms after the paint, rescale case 128.4 ms.
Within the 100 ms budget, and unchanged within noise from ADR 0006's 25.8 ms.

## Revisit if

- The window is asked to show another writer's work while idle. That needs a watcher, a repaint
  decision, and a rule for what happens to an entry bar aimed at a chart that just changed.
- A second window opens the same project. Two `Workspace` instances already tolerate each other
  through this check; two *windows* would also need to agree on which one owns undo.
