# UI review log

Every visual change waits here for the user's verdict. The agent never self-approves.

Format: date · step · what to look at · verdict · follow-up.

| date | step | what to look at | verdict | follow-up |
|---|---|---|---|---|
| 2026-10-18 | Design review (no UI yet) | — | approved direction: Tauri 2, Python analysis, repo-agent control, versioned shapes | build slice 1 before any pixels |
| 2026-10-18 | Chart renderer v1 (`bench chart` → SVG) | (1) Title, subtitle, and the evidence line read as one stack and no longer overlap. (2) Two visible bands of points — week 1 below, week 2 above — with no line drawn, because nothing has been fitted yet. | **pending** | awaiting user verdict; the two clusters are not yet labelled by time |
| 2026-10-19 | Supported fit (`bench run fit`, fixture) | (1) The band widens toward both ends, which is what a confidence band should do. (2) The footer and the two-line caption carry the whole argument: n, parameters, DOF, verdict, slope with its interval. | **pending** | the pooled slope hides the two weeks — a windowed or changepoint recipe is what answers the real question |
| 2026-10-19 | Refusal (`bench run fit`, two points) | (1) Two points, no curve, no band — and the footer says `no curve drawn`. (2) The caption names the fix: add a third point, or lower the degree. | **pending** | none; this is the behaviour the product exists for |
| 2026-10-19 | Import in the fixture (`bench import`) | (1) The imported rows join the two existing clusters rather than forming a third — two points at x = 7, 8 land on the recalibration line. (2) The file carries a comment preamble, and the import output reports the skipped lines instead of losing them. | **pending** | no new visual surface; this row exists because the fixture's charts were regenerated, so the committed evidence changed |
| 2026-10-19 | Two regimes (`bench run drift`, fixture) | (1) One accent hue doing two jobs: solid before the recalibration, dashed after, named in a legend on its own plate. (2) The caption states both slopes with intervals and the p-value, so the file is readable without the terminal. | **pending** | the verdict is `tentative`, not `supported` — the permutation penalty for a data-chosen split. Worth confirming that reads as honest rather than weak |
| 2026-10-19 | Desktop window, first slice (ADR 0005) | (1) Projects in the rail, tabs under them, and the chart filling the stage — the window opens on `drift-sensor` / “drift over time” with two panels side by side. (2) Each panel's strip carries the facts that survive zooming: dataset, recipe and params, verdict, `n`, and a `current` badge from the fingerprint check. | **pending** | no data entry in this slice; the empty state and error states were only seen by forcing them. Panels keep the chart's own aspect ratio, so a two-panel view leaves the lower stage empty |
| 2026-10-19 | Window interaction (hover, zoom, pan) | (1) The ring sits on the hovered mark and the tooltip names the record — `01M58Y41VF83K6TQ8XWWK9VN0S`, `x 3  y 8.09`, `main · xy.v1` — so a mark can be traced to the log. (2) The zoom badge reads `2.1×` after two wheel steps and the crop has moved: zoom is a crop of the same drawing, so labels and marks cannot drift from each other. | **pending** | the tooltip shows the raw ULID; shortened ids would be easier to read but harder to match in the log. Zoom crops the axis labels with the plot — pinning them needs a redraw, not a `viewBox` move |
| 2026-10-19 | Point entry (ADR 0006) | (1) Type `6.5`, `Tab`, `16.4`, Enter: the mark appears, the plot's own `n = 15` and the footer agree, and the bar reports what it recorded plus `13 ms` for the whole path. (2) The fitted panel turns `stale` with the exact command that fixes it, while the plot beside it is `current` — the window refreshed what it can and says what it cannot. | **pending** | captured on a scratch copy of the fixture, so the committed log was not written by a review run. The stale fitted panel is the intended behaviour, not a failure — say if it reads that way |
| 2026-10-19 | Undo (Ctrl+Z in an empty bar) | (1) The point disappears and **both** panels return to `current`: the retraction put the input fingerprint back to what the file was drawn from. (2) The status line names the record and says it stays in the log — nothing was deleted. | **pending** | keyboard-only path: only fires when the bar is empty, so it never steals away an edit-in-progress undo |
| 2026-10-19 | Entry refused | (1) `seven` is still in the `x` field after the refusal — a rejection that ate the number would be a worse bug than the rejection. (2) Both fields are marked and the two problems are named the way the shape names them, so the fix is obvious from the frame. Nothing was written: the count is still 14. | **pending** | the capture asserts the text survived (`typed.x === 'seven'`), so this frame cannot silently rot |

## Desktop window — what to look at

The frames are [app-100.png](ui-review/app-100.png), [app-125.png](ui-review/app-125.png),
[app-150.png](ui-review/app-150.png), [app-interaction.png](ui-review/app-interaction.png),
[app-entry.png](ui-review/app-entry.png), [app-undo.png](ui-review/app-undo.png) and
[app-refused.png](ui-review/app-refused.png), captured from the real window by `pnpm app:capture`. The
entry, undo and refusal frames are typed into with real keystrokes, on a scratch copy of the project
so the committed log stays untouched. `docs/ui-review/index.html` shows all seven on one page when
opened in a browser; the in-app Preview tab serves only the HTML file it is handed, so the images
there come from opening the folder instead.

- **Rail**: projects most-recent-first, the open one marked; tabs under it with panel counts. Projects
  whose folder is gone are hidden behind a count — say if that should be visible by default instead.
- **Stage**: one card per panel, each drawing the core's own SVG. The chart's heading, footer and
  caption are inside the drawing; the strip above repeats the facts that matter so zooming into the
  plot cannot hide them.
- **Scaling**: at 125% and 150% nothing clips or overlaps, and the panel grid keeps its two columns.
  The cost: at 150% each panel is ~169 CSS px wide, so the long title ellipsizes to `slope before …`
  (hover it for the full name) and the chart is 254×147 px. Dropping to one column below ~980 px is
  the obvious fix — say whether the charts should grow or the side-by-side comparison should hold,
  because that is a taste call, not a measurement.
- **Entry bar**: one field per shape field, the button, and undo. It is focused when a tab opens,
  because typing a number is the thing this window is for; `Tab` still reaches the panel for
  keyboard zoom and pan.
- **Refusals**: a corrupt view file, a missing project and an empty registry each have their own
  state — reachable with `BENCH_PROJECT=<dir> pnpm app`. Typing nonsense into a field is the fourth,
  and the frame below shows it: both fields marked, the text still there.

## How to reproduce a review

`pnpm review [project-dir]` writes `artifacts/review.html` inside the project: every chart artifact on
one page at 100%, 125%, and 150% of natural size, with the file's own comment header. It defaults to
`fixtures/projects/drift-sensor`. The page and the SVGs it shows are regenerable and git-ignored; the
images are deliberately not committed.

`pnpm app:capture` builds the shell's core bundle, launches the real Electron window, captures it at
100/125/150%, then drives hover, wheel zoom and a keyboard pan and captures that frame last. Its PNGs
are git-ignored too; `docs/ui-review/index.html` is the tracked contact sheet that shows them.

## Standing questions for every review

- Is the fit's uncertainty visible, or does the curve look more certain than it is?
- Does the verdict badge match what the chart implies?
- Is the primary action reachable by keyboard alone?
- At 125% and 150% scaling, does anything clip or blur?
- Does the update flicker or shift layout when a point lands?
