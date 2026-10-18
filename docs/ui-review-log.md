# UI review log

Every visual change waits here for the user's verdict. The agent never self-approves.

Format: date · step · what to look at · verdict · follow-up.

| date | step | what to look at | verdict | follow-up |
|---|---|---|---|---|
| 2026-10-18 | Design review (no UI yet) | — | approved direction: Tauri 2, Python analysis, repo-agent control, versioned shapes | build slice 1 before any pixels |
| 2026-10-18 | Chart renderer v1 (`bench chart` → SVG) | (1) Title, subtitle, and the evidence line read as one stack and no longer overlap. (2) Two visible bands of points — week 1 below, week 2 above — with no line drawn, because nothing has been fitted yet. | **pending** | awaiting user verdict; the two clusters are not yet labelled by time |

## Standing questions for every review

- Is the fit's uncertainty visible, or does the curve look more certain than it is?
- Does the verdict badge match what the chart implies?
- Is the primary action reachable by keyboard alone?
- At 125% and 150% scaling, does anything clip or blur?
- Does the update flicker or shift layout when a point lands?
