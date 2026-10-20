# UI review log

Every visual change is captured from the real window and recorded here. The agent never approves its
own visuals.

**Status 2026-10-20:** the batch of 25 rows below was **closed by direction**, not by approving frames
one at a time. One later frame — the point menu — is **awaiting review**; it was added after the batch
closed, so it is the only row still open. The user reviewed the window and its frames, stated what it gets wrong for a person, and
asked for the whole batch to be recorded as decided. Their words are quoted under "The direction that closed the
batch"; the work it created is in [05-user-surface.md](05-user-surface.md) and
[03-roadmap.md](03-roadmap.md) §6. This is a decision about the direction, **not** a claim that every
pixel was inspected. New visual work still produces a frame and a row, under the protocol at the end.

## What a frame is, and what you do with it

A frame is a PNG of the real Electron window, taken by `pnpm app:capture`. It is not a mockup. The
capture boots the app on `fixtures/projects/drift-sensor`, photographs it at 100%, 125% and 150%
scaling, then drives it with real events — typing a point, undoing, a refused entry, an import sheet, a
version diff, an external write, the packaged build — and photographs the results. The field-pair
frames come from a read-only QP Stats session.

To look: open [ui-review/index.html](ui-review/index.html) in a browser. It is the contact sheet, with
each frame and a caption saying what it demonstrates. Click a frame to see it full size. A single frame
can also be opened directly, for example [app-interaction.png](ui-review/app-interaction.png).

The step column names the change that produced the frame. It is history, not something a reviewer
needs to know; the plain description is in the next column.

To give a verdict: say **approved**, or say what should change. You do not need to edit this file or
answer in any particular format; the agent records the verdict. A frame that raises a question is a
useful verdict too — "what does this badge mean?" is a finding, and it goes into the user-surface
register rather than being explained away.

The in-app Preview tab serves only the HTML file it is handed, so the images load when the folder is
opened in a browser, not in that preview.

## How to read a row

Each row has a date, the step that produced the frame, what the frame shows, the verdict, and what
follows. Historical rows were written in the vocabulary of the code, which is exactly what made them
hard to check. The **glossary** below is the translation; snapshots that need it are in the frames
themselves.

| term | what it means in the window |
|---|---|
| **frame** | a screenshot of the real window after something happened |
| **panel** | one chart card; a tab can hold one or two |
| **strip** | the thin line above a chart, carrying its title and facts |
| **badge** | the small pill saying whether the panel is up to date |
| **current / stale / missing** | drawn from the latest data / drawn from older data / the data it needs is gone |
| **`n`** | how many points the panel drew |
| **verdict** | how much the data supports the curve: insufficient, tentative, supported, contradicted |
| **DOF** | degrees of freedom — spare observations left after fitting; too few makes a curve meaningless |
| **recipe** | a saved analysis (`fit`, `drift`); a panel either plots rows or runs one |
| **shape** | the declared fields a project's points carry |
| **version** | a dataset snapshot made by an import; a panel is drawn from one |
| **entry bar** | the row of number fields at the bottom |
| **rail** | the left column listing projects and tabs |
| **step** | the change that produced the frame; history, not something you need to know to review it |
| **Chart renderer v1** | a step name for the first version of the code that drew charts — not a control or a label in the window |

A row is supposed to let a person who has not read the code answer: *what is this a picture of, is
anything wrong, and do I need to do something?* When it does not, the row is defective, not the reader.

## The direction that closed the batch

The user's review on 2026-10-20, condensed to the lines that decided the rows:

> the frontend needs to be evaluated from a user perspective — they don't care about these details.

> everything should be recoverable if a mistake is made, but don't overrecord. Keep the important
> details, drop the others.

> Do NOT make or expect the user to use cli tools … they should just be able to press a button, or if
> it doesn't make sense to keep it in a bad state it should be done automatically.

> do not duplicate showing the same information … unless they can differ.

> The user doesn't have to know everything from the frontend or care about enforcing data integrity.
> That's the agent's job.

The full reasoning and the resulting decisions are [ADR 0015](adr/0015-user-surface.md) and
[05-user-surface.md](05-user-surface.md). Each row below is closed against one of those `U` items.

## Frames and verdicts

| date | step | what the frame shows, in plain terms | verdict | follows |
|---|---|---|---|---|
| 2026-10-18 | Design review (no UI yet) | No frame; the direction for the first window was agreed | **approved direction** | build the first slice |
| 2026-10-18 | Chart renderer v1 (`bench chart` → SVG) | The first chart artifact: a title, a subtitle, two visible clusters of points and no line, because nothing was fitted yet | **closed by direction 2026-10-20** | U9, U14: number formatting and one title |
| 2026-10-19 | Supported fit (`bench run fit`) | A fitted line with an uncertainty band that widens at both ends; the footer and caption carry n, the parameters, DOF, the verdict and the slope interval | **closed by direction 2026-10-20** | U12, U13, U14: the interval is `1.23 to 2.35`, and DOF is spelled out on hover |
| 2026-10-19 | Refusal (two points) | Two points and no curve; the footer says no curve was drawn and the caption says to add a third point | **closed by direction 2026-10-20** | U12: the refusal is explained in consequences, not just as an `insufficient` badge |
| 2026-10-19 | Import in the fixture | Imported rows join the existing clusters rather than forming a third; the comment preamble is reported, not silently skipped | **closed by direction 2026-10-20** | U10: the import summary becomes plain language |
| 2026-10-19 | Two regimes (`bench run drift`) | Two slopes before and after a split: one accent hue, solid then dashed, with the split named in a legend; the caption gives both slopes, intervals and p | **closed by direction 2026-10-20** | U12, U13, U14 |
| 2026-10-19 | Desktop window, first slice | The window opens on a project with two panels side by side; each strip names the dataset, recipe, verdict and n, and carries a badge | **closed by direction 2026-10-20** | U12, U17, U18: drop the `current` badge, deduplicate the facts |
| 2026-10-19 | Window interaction (hover, zoom, pan) | A ring on the hovered mark, a tooltip with the record id, and the zoom badge at `2.1×` after two wheel steps | **closed by direction 2026-10-20** | U1, U2: values only; id available through **Copy details** |
| 2026-10-19 | Point entry | Type `6.5`, Tab, `16.4`, Enter: the mark appears, the count and footer agree, the bar reports what it recorded and how long it took | **closed by direction 2026-10-20** | U4, U18: undo/redo, and the count shown once |
| 2026-10-19 | Undo (`Ctrl+Z` in an empty bar) | The point disappears and both panels return to up to date; the status says the record stays in the log | **closed by direction 2026-10-20** | U4, U6: undo is one action, redo exists, no event narration |
| 2026-10-19 | Entry refused | `seven` is still in the field after the refusal, both fields are marked, and nothing was written | **closed by direction 2026-10-20** | U14, U20: the message stays, the layout at 150% changes |
| 2026-10-19 | Packaged build, launched | The same two panels from `bench.exe`, with Python removed: the tab dialog offers a plot only and names the missing runtime | **closed by direction 2026-10-20** | unsigned by decision ([packaging.md](packaging.md)) |
| 2026-10-19 | New tab | One dialog creates a tab from a name, a dataset and a panel; the frame shows the tab it built | **closed by direction 2026-10-20** | U17, U18: the rail and the duplicated facts |
| 2026-10-19 | Creating a project with its own shape | A project created with `load.v1 (mass, extension)`; the entry bar offers exactly those fields; the empty first tab shows `n = 0` and a CLI command | **closed by direction 2026-10-20** | U20, U22: no command in the empty state |
| 2026-10-19 | Correcting a point by selecting it | A dashed ring on the selected mark, a correction row prefilled from the log, the mark moves after the edit, and the recipe panel goes out of date | **closed by direction 2026-10-20** | U2, U3: edit from the point menu, in plain words |
| 2026-10-19 | Live refresh while idle | A point appended by the CLI while text sat half-typed: the count and plot move without a keystroke, and the text and cursor stay put | **closed by direction 2026-10-20** | U21: a stale plot refreshes itself; a recipe panel offers **Refresh** |
| 2026-10-19 | A second writer | A point typed while the CLI also appended one: the bar says the log had changed and was reread, and the counts agree | **closed by direction 2026-10-20** | U3, U21: same facts, without the event vocabulary |
| 2026-10-19 | A tab drawn from more than one version | A tab with one panel pinned to v2 and one to v3 while the data is at v4; the strip lists both versions | **closed by direction 2026-10-20** | U18: a per-panel marker only where panels differ |
| 2026-10-19 | Canvas mark layer | The same 28 marks in the same places, now painted on a canvas between the grid/fits and the axes; zoom, pan and hover still work | **closed by direction 2026-10-20** | no wording change; the 10k budget stands |
| 2026-10-19 | A row's time is chosen, not invented | The import sheet will not plan until a time column is picked; a file whose clock is called `taken_at` is offered it and plans a version diff | **closed by direction 2026-10-20** | U8, U9: a stated guess, and a labelled estimate when there is no clock |
| 2026-10-19 | Dataset versions in both doors | The sheet states the row diff before the click; the window names both versions when panels disagree | **closed by direction 2026-10-20** | U10, U18 |
| 2026-10-19 | Import door in the window | A sheet on the chosen file: name, row/column counts, a sample of real cells, one row per field, and two refusals that keep the mapping | **closed by direction 2026-10-20** | U10, U20: plain counts, compact at 150% |
| 2026-10-19 | Custom-axis tab through the real window | A `load.v1` project's first tab on `mass`/`extension`; three points typed, one redraw and two patches; the saved file agrees | **closed by direction 2026-10-20** | U15, U27: plain keyboard help, shorter accessible name |
| 2026-10-19 | Field-pair plotting on a custom shape | QP Stats' `altitude over time` on a clock axis and `app against pps` on numeric axes; the dialog offers the shape's own six fields | **closed by direction 2026-10-20** | U12, U20: verdict hover and the 150% layout |
| 2026-10-20 | One column below 980 px of viewport | At 150% the grid drops to one 519 px panel per row instead of two ~170 px ones; 125% keeps two; the capture checks the computed column count | **closed by direction 2026-10-20** | implemented in `a3888b4`; no follow-up |

| 2026-10-20 | Plain words in the window (`app-interaction`, `app-corrected`, `app-mixed-versions`) | **Screen:** the window with a point hovered, after a correction, and on a tab drawn from two versions. **Check:** does the hover show only the values you measured, does the correction strip name the measurement rather than a long code, and is the quiet `current` label gone? **Wrong looks like:** a string of letters and digits on hover, a file or version named in a status, or a badge that asks nothing. **Your call:** keep this wording, or should a status be shorter still? | **awaiting your review** | none; every window string now comes from `app/renderer/copy.js`, and the capture refuses log vocabulary on hover, status, facts, badges and accessible names |

| 2026-10-20 | A first run: an empty project, its first panel, and the first import (`app-empty-tab-100/125/150`, `app-import`, `app-import-time`) | **Screen:** a brand-new project with one empty tab, then the import sheet with a real file mapped. **Check:** does the empty panel say what to do in words, and does the sheet tell you what the click will do without a version number or a `+1 −2` count? **Wrong looks like:** the empty panel prints a command to copy, the sheet prints `version 4 replaces version 3`, or the button just says `Import`. **Your call:** keep this wording, or should the empty panel say less? | **awaiting your review** | none; `copy.panelEmpty`, `copy.importSummary`, `copy.importPlan` and `copy.importButton` own these words |
| 2026-10-20 | The drawing says its own evidence, and the verdict explains itself (`app-new-tab`, `app-verdict`) | **Screen:** a tab built from the dialog, then the same panel with the verdict's explanation open. **Check:** can you tell what the curve is fitted to (`n`, degrees of freedom) without a dataset, shape or version name anywhere in the picture, and does the verdict word tell you what to do next when you hover or tab to it? **Wrong looks like:** `main · drift` above the plot, `DOF 10` in a footer, or a verdict chip that says nothing when you point at it. **Your call:** is `Tentative` the right word, and does the sentence say enough? | **awaiting your review** | none; the drawing is plain (`renderChartLayers(spec, { plain: true })`), `copy.panelEvidence` and `copy.verdictExplanation` own the words, and the capture refuses names in the drawing and checks the sentence on hover and on focus |
| 2026-10-20 | A point's own menu (`app-point-menu`) | **Screen:** a chart after right-clicking one of its marks, with a small menu open beside it. **Check:** can you tell what you can do with this one point — take its details, change it, or take it out — and is the thing you clicked still the obvious subject of those three choices? **Wrong looks like:** a menu that mentions a record number or a dataset, a **Remove** that asks you to type a reason, or a menu that disappears when you move the pointer onto it. **Your call:** keep these three words, or should **Remove** read differently now that undo is one button in the bar, labelled with the act it reverses? | **awaiting your review** | none; undo of a removal brings the same point back, and the one undo reads **Undo removal** while the status offers **Redo removal** after it. The capture photographs the menu, checks that it fits inside the window, reads the clipboard after **Copy details**, and photographs the frame after **Remove** (`app-point-menu-removed`), where the keyboard is back on the chart |

**Note on the 2026-10-20 review.** The user did not approve these frames individually; they reviewed
the window and its frames, found the problems the stills had not made legible (ids in tooltips, duplicated
facts, commands in empty states, unreadable numbers, `New…`/`Open…` spacing), and directed the next
pass. The findings live in [05-user-surface.md](05-user-surface.md), because they are work, not frame
verdicts. The batch is closed; the direction is not a pixel-level approval, and later visual changes
still need their own frames.

## The protocol for new rows

A new row answers four things, in this order, in plain language:

1. **Screen** — what this is a picture of, in one clause. *"The window after typing a point."*
2. **Check** — one question a non-author can answer by looking. *"Does the new mark appear where you
   typed it, and does the count go up by one?"*
3. **Wrong looks like** — the failure the check catches. *"The count changes but no mark appears."*
4. **Your call** — the decision, with the recommendation and the alternative. *"Keep this; or should
   the status be quieter?"*

No internal names, no pixel counts, no file names in the check. One check per row; a second finding
gets its own row. Terms that cannot be avoided are in the glossary above. If the frame cannot be
understood without the code, the frame is missing something — an annotation, a cursor, a before/after
pair — and that is the finding.

## Desktop window — the current surface in plain terms

- **Rail (left):** projects most-recent-first, the open one marked, tabs under them with a panel
  count. A missing project folder is hidden behind a count rather than shown as a broken entry.
- **Stage:** one card per panel. The strip carries the panel's title, method and point count; the
  drawing itself is the picture only — axes, grid, fits, marks and the recipe's caption — with the
  evidence line and the verdict chip as DOM under it. The verdict chip explains itself on hover and
  on keyboard focus.
- **Scaling:** 100% and 125% keep two panels side by side; below 980 px of viewport the grid uses one
  column, so 150% gets a readable 519 px panel instead of two ~170 px ones. A 150% user on a wide
  screen still gets two, because the rule is the viewport, not the scaling.
- **Entry bar:** one field per shape field, the button, undo/redo, and the import door. It is focused
  when a tab opens, because typing a number is what the window is for. `Tab` reaches the panel for
  keyboard pan and zoom.
- **Empty and refused states:** a corrupt view file, a missing project and an empty registry each have
  their own state; typing nonsense marks the field and keeps the text. The CLI commands currently in
  those states are scheduled for removal (U21/U22).

## How to reproduce a review

`pnpm review [project-dir]` writes `artifacts/review.html` inside the project: every chart artifact on
one page at 100%, 125% and 150% of natural size, with the file's own comment header. It defaults to
`fixtures/projects/drift-sensor`. The page and the SVGs it shows are regenerable and git-ignored; the
images are deliberately not committed.

`pnpm app:capture` builds the shell's core bundle, launches the real window, captures it at
100/125/150%, then drives it with real events: types a point, undoes it, types a refused value, opens
the import sheet and a version diff, forces an external write and refreshes, and runs the packaged
build. Its PNGs are git-ignored; `docs/ui-review/index.html` is the tracked contact sheet that shows
them. It also asserts what a person must see — values on hover, no log vocabulary in any surface, an
evidence line, a verdict that explains itself, one column at 150% — and exits non-zero when a check
fails, so a run is a gate rather than a pile of pictures. The harness re-focuses the live input and
retries typing when the entry bar re-renders mid-keystroke: that re-render was the real cause of the
intermittent focus failures, and the retry still fails unless the field holds the value it must.

## Standing questions for every review

- Is the fit's uncertainty visible, or does the curve look more certain than it is?
- Does the panel say "out of date" only when it is, and does it say what to do?
- Is the primary action reachable by keyboard alone?
- At 125% and 150%, does anything clip, blur or stack badly?
- Does the update flicker or shift the layout when a point lands?
- Does a person who has not read the log understand every word on screen?
