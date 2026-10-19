# ADR 0006 — The window appends points, and the tab file catches up after the paint

Date: 2026-10-19
Status: accepted
Related: [0003](0003-in-process-core.md) (in-process seam, 100 ms entry budget),
[0004](0004-views-and-projects.md) (tabs are view files), [0005](0005-desktop-shell.md) (the window)

## Context

The product's premise is typing a number and watching the point land. The first window could only
read (ADR 0005), so the entry path existed everywhere except in the thing a person actually stares
at. Adding it raised three questions the read-only slice never had to answer:

1. **Where does the write go?** The CLI spawns a process and holds a project for one command. A
   window is long-lived, so it needs a workspace that stays open — and ADR 0003 already decided the
   answer is the in-process `Workspace`, not a CLI spawn and not Python in the hot path.
2. **What does "repaint the tab immediately" mean when a tab is a file?** A view file stores
   materialized specs, and a `plot` panel's spec is ten thousand points at 10k. Rebuilding and
   re-saving that on every keystroke is the obvious implementation and the wrong one.
3. **What is undo?** The log is append-only (non-negotiable 1) and a dataset version is never
   deleted (non-negotiable 3). "Undo" cannot be a deletion, because there is no such thing here.

## Measured first, then designed

Everything below was measured in the running window with real keystrokes before the design was
settled (`pnpm app:measure`, 10,000 points, one plot panel, eight typed points):

| implementation | median keystroke → paint | split |
|---|---|---|
| full SVG rebuild, `DOMParser` per panel | 179 ms | record 28 · rebuild 45 · paint 106 |
| full SVG rebuild, HTML parsing | 113 ms | record 19 · rebuild 47 · paint 53 |
| **one appended mark** (this ADR) | **25.8 ms** | record 13 · rebuild 1 · paint 12 |

ADR 0003's budget is 100 ms. The third row is the one that fits it at 10k points, and it is the one
that shipped. The second row is worth keeping in view: parsing alone was half the cost, and it was
fixed by letting the HTML parser build the SVG in place instead of parsing a second document and
deep-copying it.

## Decision

1. **The window writes through `Workspace`, in process.** `app/core.entry.ts` keeps one `Workspace`
   per open project and exposes exactly three write calls: record a point, retract a point, refresh
   a tab. There is no general "run this" channel, so the window cannot grow a write path the core
   has not agreed to. The preload exposes those three and nothing else.
2. **The point lands as one appended mark.** `chart.ts` exports `incrementalMark`, which draws one
   observation against the scales a chart *already has*, using the same code that draws a whole
   chart. When the new point is inside the drawn domain, the window inserts that markup after the
   last existing mark — where a redraw would have put it, before the axis rules — and updates the
   hit-test list so the new point is hoverable immediately. Rebuild cost: 0.8 ms.
3. **A point that would move the axes forces a redraw, and says so.** `incrementalMark` returns
   `null` when the value falls outside the padded domain, and the window repaints the tab instead.
   That is the honest boundary: a mark drawn against stale scales would be in the wrong place.
   Measured: 135 ms for that case, reported below rather than hidden.
4. **The tab file catches up after the paint.** The log append is awaited — it is the truth — but the
   materialized spec, the `input_hash` and the `writeFile` are not on the keystroke path. The window
   asks the core to settle the tab as soon as the frame is painted (29 ms later, measured), and
   updates the badge, the strip's `n` and the chart's own evidence line from the answer. A tab whose
   file could not be saved says so; it never quietly keeps drawing something the file disagrees with.
5. **A fitted panel cannot be refreshed in the window, and is not pretended otherwise.** Rebuilding a
   `drift` or `fit` panel means running the recipe, and Python is deliberately not in the entry path
   (non-negotiable 4). The panel keeps the drawing it was saved with, gets a `stale` badge from the
   fingerprint check, and the window prints the exact `bench view render --refresh` line that fixes
   it. After an append the fixture shows exactly this: the plot panel updates to `n = 15`, the fitted
   panel says `stale`.
6. **Undo is a retraction event, not a deletion.** The bar has one undo, for the last point *this
   window* appended, and it writes `point_retracted` with the reason `undo from the window`. The
   record stays in the log; the dataset's active set drops back. The visible proof that this is the
   right shape: after an append the fitted panel is `stale`, and after the undo both panels return to
   `current`, because the input fingerprint matches what the file was drawn from again.
7. **Invalid input keeps what was typed.** The window parses text only far enough to guess a type;
   anything it cannot parse is passed through to the core so the shape's own validation produces the
   message the CLI would (`field "x" expects a finite number, got "seven"`). The bar marks the named
   field, focuses it, and leaves the typo in place — a refusal must not also be a data loss.

## Costs, stated

- 135 ms when a typed point rescales the axes, because that is a full redraw. Canvas renderers exist
  for this and requirement §4 already anticipates one; this is the number that would trigger it.
- The window holds a `Workspace` and a view in memory, so an append made by the *CLI* while the
  window is open is not visible until a tab is reopened. Opening a tab pulls from disk; the hot path
  does not, because re-reading a 10k-point log per keystroke is the thing ADR 0003 measured away.
- Two megabytes of view JSON are written per point, after the paint. That is disk churn a snapshot
  format would avoid, and it is the price of "a tab is a file".

## Revisit if

- The rescale case becomes common (a window that is usually showing a point the user is about to
  leave behind). Then the answer is a canvas renderer with a fixed cost, not a cleverer patch.
- Someone needs a window that is *not* the only writer — a second window, an agent mid-session.
  That needs a cheap "did the log change?" check before painting, which does not exist yet.
