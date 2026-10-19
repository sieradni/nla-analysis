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

## How to reproduce a review

`pnpm review [project-dir]` writes `artifacts/review.html` inside the project: every chart artifact on
one page at 100%, 125%, and 150% of natural size, with the file's own comment header. It defaults to
`fixtures/projects/drift-sensor`. The page and the SVGs it shows are regenerable and git-ignored; the
images are deliberately not committed.

## Standing questions for every review

- Is the fit's uncertainty visible, or does the curve look more certain than it is?
- Does the verdict badge match what the chart implies?
- Is the primary action reachable by keyboard alone?
- At 125% and 150% scaling, does anything clip or blur?
- Does the update flicker or shift layout when a point lands?
