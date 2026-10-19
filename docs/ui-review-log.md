# UI review log

Every visual change waits here for the user's verdict. The agent never self-approves.

Format: date · step · what to look at · verdict · follow-up.

| date | step | what to look at | verdict | follow-up |
|---|---|---|---|---|
| 2026-10-18 | Design review (no UI yet) | — | approved direction: Tauri 2, Python analysis, repo-agent control, versioned shapes | build slice 1 before any pixels |
| 2026-10-18 | Chart renderer v1 (`bench chart` → SVG) | (1) Title, subtitle, and the evidence line read as one stack and no longer overlap. (2) Two visible bands of points — week 1 below, week 2 above — with no line drawn, because nothing has been fitted yet. | **pending** | awaiting user verdict; the two clusters are not yet labelled by time |
| 2026-10-19 | Supported fit (`bench run fit`, fixture) | (1) The band widens toward both ends, which is what a confidence band should do. (2) The footer and the two-line caption carry the whole argument: n, parameters, DOF, verdict, slope with its interval. | **pending** | the pooled slope hides the two weeks — a windowed or changepoint recipe is what answers the real question |
| 2026-10-19 | Refusal (`bench run fit`, two points) | (1) Two points, no curve, no band — and the footer says `no curve drawn`. (2) The caption names the fix: add a third point, or lower the degree. | **pending** | none; this is the behaviour the product exists for |

## Standing questions for every review

- Is the fit's uncertainty visible, or does the curve look more certain than it is?
- Does the verdict badge match what the chart implies?
- Is the primary action reachable by keyboard alone?
- At 125% and 150% scaling, does anything clip or blur?
- Does the update flicker or shift layout when a point lands?
