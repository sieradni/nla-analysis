# The user surface — findings, decisions, and the work they create

Status: **decided 2026-10-20** from the user's review of the desktop window. Nothing in this file is
implemented yet unless it says so; the work list is [03-roadmap.md](03-roadmap.md) §6, keyed by the
same `U` numbers. The principle is [ADR 0015](adr/0015-user-surface.md).

This file exists because the same review kept producing "open questions" that were not really open.
They came from describing the log to the person who uses the window. Once the question is "what does
a person need here?", the answer follows. The user's own words are the standard:

> The user only cares about the most important information in the ui, details are needed but they
> need to be easily understood. The user doesn't have to know everything from the frontend or care
> about enforcing data integrity. That's the agent's job.

> everything should be recoverable if a mistake is made, but don't overrecord. Keep the important
> details, drop the others.

> Do NOT make or expect the user to use cli tools … more importantly they should just be able to
> press a button, or if it doesn't make sense to keep it in a bad state it should be done
> automatically.

> do not duplicate showing the same information, like n=3 and 3 points at the top and bottom right
> should not both be shown unless they can differ.

## How to read this file

Each row is one thing the window does today, followed by what the user said about it, the decision
taken, and what "done" means. `U` numbers are the roadmap rows. They are stable identifiers, not a
reading order: this file groups them by surface, and [03-roadmap.md](03-roadmap.md) §6 groups them by
work order. No code is described here; a row says what the person should experience, not which file
changes.

A note on vocabulary, because it is the root of most of these findings:

| the log says | the person should read |
|---|---|
| a point with ULID `01M58…` | a measurement, with values and a time |
| dataset `main`, shape `xy.v1` | (nothing, when there is one dataset and one shape) |
| `current` / `stale` / `missing` | up to date / out of date, with what to do / gone |
| `tentative`, `supported`, `contradicted`, `insufficient` | how much the data supports the curve, in a sentence |
| DOF 10 | 10 degrees of freedom — enough spare observations to judge the fit |
| `version 5 replaces version 4 · +1 −0 ~0` | 1 row added, none removed, none changed |
| `point_retracted` | removed — undo puts it back |
| `bench view render --refresh` | a **Refresh** button |

---

## 1. A point, and what hovering one says

### U1. The tooltip is a value readout, not a record inspector

**Seen:** hovering a mark shows `01M58Y41VF83K6TQ8XWWK9VN0S`, `x 3  y 8.09`, `main · xy.v1`. The id is
26 characters of log vocabulary; the dataset and shape are the same on every point in the panel.

**Decision:** the tooltip shows the values with their axis labels and units, and the observation time
only when time is not already one of the axes. It does not show an id, a dataset, a shape, a recipe or
a version. Values use the shared number formatting (U13), not raw floats.

**Done when:** no tooltip in the window contains a ULID, `main`, `xy.v1`, or an event name; a hover
over a fitted panel reads like `x 3.0 · y 8.09 °C`, and a hover over a time-axis panel includes the
instant under the value.

### U2. A point has a menu: Copy details, Correct, Remove

**Seen:** the only way to identify a point for a conversation was to read the ULID out of the
tooltip; the only action on a mark was selection-for-correction.

**Decision:** right-clicking a mark (and Shift+F10 / the context-menu key when it has keyboard focus)
opens a small menu: **Copy details**, **Correct…**, **Remove**. *Copy details* puts a readable line on
the clipboard — values, units, observation time, and the record id last, for the agent — because the
reason to want the id is to paste it into a conversation. *Remove* is U6. The menu closes on Escape and
returns focus to the chart.

**Done when:** a copied detail line can be pasted into a chat and identifies the point without the
person having read an id first; the same menu is reachable by keyboard alone; there is no id anywhere
in the visual UI.

### U3. The correction strip names the measurement, not the record

**Seen:** selecting a mark produces `Correcting 01M58… · recorded 2026-10-19 19:35 · no corrections
yet`, and statuses say `Editing 01M58…`, `Recorded 01M58…`, `Corrected 01M58…`.

**Decision:** the strip says what is being edited in the person's terms — `Editing x 6.5, y 16.4 ·
observed 19 Oct 06:00`. Status lines say `Saved`, `Corrected`, `Removed`, with a short undo offer; the
record id and event name live in the copied details, not in the strip.

**Done when:** no primary UI text contains a ULID or an event name; a person can tell which point they
are editing from the values and the time.

---

## 2. Undo, redo, and removal

### U4. Undo and redo cover what a person can do

**Seen:** `Ctrl+Z` retracts the last point only when the entry bar is empty; there is no redo; undo
cannot bring back a removed point; correcting has no undo; deleting a tab has no undo.

**Decision:** one history for the tab, in order: add a point, remove a point, correct a point, create
or delete a tab, import a file. `Ctrl+Z` undoes, `Ctrl+Shift+Z` and `Ctrl+Y` redo, and both are visible
buttons with a tooltip naming the action (`Undo add point`). A new action clears the redo branch. The
history is per open tab and does not survive closing the window (a later decision if it should). Text
inputs keep their own undo while focused; the app-level undo applies otherwise, and the button is
always available.

An import is a dataset version, so its undo is a **restore version**: a new version holding the
parent's rows, never a deleted version (non-negotiable 7). Redo appends the imported rows again. The
button says `Restore version 3` / `Reapply import`; the version number moves forward in both
directions.

**Done when:** each of those actions can be undone and redone through the window; the button labels
say which action is next; a redo after undo leaves the same active rows and the same drawing (a tab
pinned to a new version number is expected after an import); undoing an import leaves no version
deleted and says which version it restored.

### U5. Undo restores the same point, not a lookalike

**Seen:** removing a point is a `point_retracted` event; there is no inverse, so the only way back
would be to record the values again under a new id.

**Decision:** add one event, `point_restored`, naming the retraction it reverses. It keeps the
original record's id, values, observation time and version. Like a retraction, the restore event
carries the version current at the time, so folding an older version still reads as it did. This is
the only new event the user surface needs. Re-recording the values under a new id would be
over-recording and would break the history the person just undid.

**Done when:** remove → undo → the original id, time and version are active again; redo → the same
record is removed again; `bench check` stays green; the log has one restore event per undo, not a
new point.

### U6. Removing a point is one action, with no ceremony

**Seen:** the only removal is the entry bar's undo, which retracts silently but cannot reach an older
point; a mark selection offers correction only; the log's retraction reason is surfaced in the UI's
intent, though it is never actually prompted for.

**Decision:** **Remove** in the point menu (U2) removes the point in one click. No reason prompt, no
event narration. The status line says `Removed · Undo` and the mark disappears from the drawing. The
event still records the retraction (the log keeps the measurement and the removal), but the window
does not ask the person to justify a typo. An agent or the CLI may add a reason; the window does not.

**Done when:** removing a selected point takes one action; the status offers undo; the docked entry
bar is not the only path; a reason is optional everywhere and never requested by the window.

### U7. Deleting a tab is recoverable

**Seen:** no delete exists; the note said a tab is a file and deleting it would destroy a question.

**Decision:** deleting a tab moves its file to `views/.trash/<slug>-<timestamp>.json` and offers
**Undo** for the same session. The trash is app state, not log state; views were deliberately kept out
of the log ([ADR 0004](adr/0004-views-and-projects.md)). No confirmation dialog for one tab; deleting
the last tab leaves the project's empty state, which can create one again. A later "recently deleted"
surface is not needed until a person asks for one.

**Done when:** delete → undo restores the exact file and the tab opens again; a deleted tab no longer
appears in the rail; the trash does not accumulate forever (a bounded, disposable folder).

---

## 3. Time, imports, and confirmation

### U8. The time column is a stated guess, not a form field

**Seen:** `app-import-untimed` refuses to plan until the person picks a time column; the picker stays
visible even when the header obviously is a clock. It reads like data-integrity homework.

**Decision:** on opening a file, the window finds the most likely time column and says so in one line
above the preview: `Time: taken_at — change`. It plans immediately. **Change** opens the full column
choice, including "no time column" (U9). The Import button states what will happen. Refusal only
happens when the file cannot be read or the rows do not validate, not because a person has not
answered a question the window can answer.

**Done when:** a file with an obvious clock can be imported with no picker interaction; the chosen
column is visible before the click; changing it replans; the plan names the assumption in the same
sentence.

### U9. A file with no clock is imported with a labelled estimate, not refused

**Seen:** a file with no time column cannot be imported at all; the core refuses with "no column holds
the observation time". A re-export of such a file then reads as all-new rows because matching falls
back to a synthetic instant per row.

**Decision:** offer `No time column — use the file order (estimated)`. The imported rows carry a
statement that the time is estimated, not measured; the sheet says so before the write, the status
repeats it, and a correction can set a real time later (U11). An agent doing this must ask first
(§7, U23). This relaxes the "never invented" wording in ADR 0012/0014: the instant is still never
silently invented — it is labelled as an estimate and is correctable. Matching a re-export of an
untimed file by row order is the honest default; if the row count or order changes, the diff says so
rather than silently claiming all rows are new.

**Done when:** an untimed file imports with an explicit `estimated` marker on its rows and in the
diff; the person can replace the estimate with a real observation time; a file that has a clock never
falls back to the estimate.

### U10. The import summary is a sentence, not a diff notation

**Seen:** the sheet says `into main (xy.v1)`, `version 5 replaces version 4 · +1 −0 ~0`, `5 row(s) ·
5 column(s) · 2 comment line(s) skipped`, `1 row(s) would not import, so none were`.

**Decision:** the summary reads `5 rows · 5 columns · 1 row added, none removed, none changed` and a
plain-time sentence; the dataset name is omitted when there is only one; the version number and the
`+1 −0 ~0` form move behind a **Details** disclosure. Warnings name the row and the field in the same
words as the entry bar. The button says what it will do (`Import 5 rows`) and the plan updates as the
mapping changes.

**Done when:** no import screen contains `v5`, `+1`, `~0`, or a shape id in its primary text; the
consequence of the click is legible without expanding anything.

### Time is a column, not a timezone

The picker answers "which column of this file is the observation clock?", not "what timezone are
we in?". A value written as `2026-10-20T12:00:00+02:00` is already unambiguous: the core stores
`2026-10-20T10:00:00.000Z` and shows it back in the reader's local time. There is no separate
timezone setting to get wrong, and an offset is accepted rather than rejected. What a person does
need to confirm is the *choice of column*, because picking `recorded_at` instead of `taken_at`
changes what "over time" means — that is what U8 states in one line.

### U11. Everything shown can be corrected, including the time

**Seen:** the entry bar edits the shape's fields; a time-axis tab's time field can be edited as text,
but there is no time picker and no way to correct an imported estimate from the UI.

**Decision:** selecting a point lets its values and its observation time be corrected. A time value
gets a small date/time input (the same one used by the import if a real timestamp is needed), not a
bare string. Correcting a time that moved a point across a dataset version's matching key is allowed
and produces a correction, not a new import. Nothing a person can see is read-only if it came from
their own data.

**Done when:** an estimated time can be replaced from the window; the corrected point moves in a
time-axis drawing; the status says what changed; no CLI is involved.

---

## 4. Explanation: badges, captions, numbers

### U12. Drop the `current` badge; explain the ones that matter

**Seen:** every panel carries `current`, `stale`, or `missing`. `current` asks nothing and consumes
attention; `stale` does not say what is out of date or what to do; `tentative` and `dof 10` are log
words on the chart.

**Decision:**
- **current:** no badge at all. Silence means up to date.
- **stale:** `Out of date` plus a hover: `Drawn from v2; the data is now v4. Refresh to redraw.` and a
  **Refresh** button. A recipe panel says why it will not rerun by itself.
- **missing:** `Data gone` plus what is missing and the one action that helps.
- **verdict:** keep the word, add a hover sentence in consequences: `Tentative — the data cannot rule
  out no trend yet. A fourth point would make this test meaningful.` `supported` says what it beat;
  `contradicted` says what won; `insufficient` says how many points are needed. `DOF` is spelled
  "degrees of freedom" in the hover, never as a bare abbreviation in a caption.

**Done when:** a person can hover any status word and learn (a) what it means, (b) whether they need
to do anything, (c) what that action is; no panel shows a badge that requires no action.

### U13. Numbers have one readable format

**Seen:** the slope reads as bracketed interval notation `[1.…, 2.…]` before a date; axis values mix
precision; DOF and counts are adjacent to other numbers without separators; units are missing or
abbreviated inconsistently.

**Decision:** one formatting module used by tooltips, axes, captions and statuses:
- values: at most 3 significant digits, trailing zeros removed, thousands separators (`1 234`, `0.675`);
- intervals: `1.23 to 2.35`, never `[1.23, 2.35]`;
- units after the number with a thin space, and only when the field declares one;
- dates: `19 Oct 2026, 06:00` in readouts; compact `19 Oct 06:00` on an axis; never ISO with `T` or `Z`
  unless the person asks for the exact value;
- counts: `1 point` / `14 points`, not `1 point(s)`.

**Done when:** the same value is formatted identically in the tooltip, the caption and the status; a
caption's slope reads `1.23 to 2.35 mm per hour (95% confidence)`; no user-facing string carries a
raw float or bracketed interval.

### U14. The chart says its own title once, and says what the numbers mean

**Seen:** `app-new-tab` shows `drift over time` in the tab, `main drift` in a panel title, `dof 10` in
the caption, and `n = 14` in both the panel footer and the strip. The words `main` and `drift` are a
dataset and a recipe, not a title.

**Decision:** the tab name is the title of the page; a panel title is shown only when it adds
information (it is not the tab name and not the recipe name). The recipe's name is a method label, not
a title: `Linear fit` or `Change over time`, in the panel's facts and in the hover, never concatenated
with the dataset. The caption leads with the conclusion in one sentence, then the numbers. `n` appears
once per panel (the chart's own footer is the authority); the strip does not repeat it.

**Done when:** no frame shows the same title twice, no panel title is `main <recipe>`, and every
number in a caption has a word saying what it is.

### U15. Keyboard hints say what happens

**Seen:** the idle hint reads `Click a point to correct it, or Shift+Arrow in a chart to step through
them.` The user could not tell whether that meant versions, panels or something else; there is no
shortcut list anywhere.

**Decision:** the hint becomes `Click a point to edit it`, with a **?** that opens a keyboard help
sheet. Shift+Arrow is described as `next / previous point in this chart` — it moves the selection
between marks, not between versions or panels. Every shortcut lists what it does in that sentence
form, and the help sheet is reachable by keyboard. Undo/redo, Escape, zoom, pan and reset are included.

**Done when:** no hint uses a metaphor or a term from the log; the help sheet answers "what does this
key do to my data?" for every binding; the point-stepping row says "point", not "chart".

### U16. Truncated text is still readable

**Seen:** long project paths, tab names and panel titles ellipsize; the project folder path in the rail
foot has no way to see the rest; there is no copy action.

**Decision:** any text that can be truncated shows its full value on hover in the app tooltip (not the
native `title`, which is slow and cannot wrap a path), and its context menu offers **Copy**. This
covers the rail's project names and folder path, tab names, panel titles, and long statuses. Copy
values are the full untruncated string.

**Done when:** every ellipsized string can be read in full on hover and copied; no truncated control
hides behind a tooltip that itself truncates.

---

## 5. What is shown once, and what is not shown

### U17. The rail's new/open controls stop looking broken

**Seen:** `New…`, `Open…` and `New tab…` end in ellipses that read as cut-off text; the header's
`space-between` scatters the three across the row, so `New` and `Open` sit far apart.

**Decision:** labels are `New project`, `Open project`, `New tab` (no ellipsis; the dialog is the
expected result of the label, not something to advertise). The title sits left, the project actions
sit together on the right as a group with a small gap, and the tab action sits with the Tabs heading.
No button is pushed apart by leftover space. If a group needs to wrap, it wraps as a group.

**Done when:** at 100/125/150% the three actions are adjacent to their headings, no label ends in
`…`, and the row is readable at 150%.

### U18. Each fact appears once

**Seen:** the tab name appears in the rail, in the stage header, and sometimes as the panel title; the
dataset `main` appears in the rail tab facts, the stage meta, the panel strip, and the sheet; `n = 14`
appears in the strip, the panel footer, and the stage meta as `14 points`; a mixed tab lists versions
at tab level.

**Decision:**
- **Dataset name:** shown only when the project has more than one dataset. `main` disappears from the
  UI in a single-dataset project. When panels read different datasets, each panel carries its own
  label; when a tab spans versions, each panel carries `v4` only if it differs from the tab's newest.
  No comma lists of versions at tab level.
- **Tab name:** rail item and stage header only; the panel title is omitted when equal.
- **Counts:** the chart's own footer owns `n`; the stage shows the dataset's point count only when
  panels disagree with it (e.g. a filtered panel); the entry readout shows the active count only when
  there is no chart to carry it.
- **Method:** recipe name and parameters once, in the panel's facts or hover, not in the title.

**Done when:** a screenshot of a single-dataset project contains `main` zero times; no number is
visible twice with the same meaning; where two counts can differ, the labels say which is which.

### U19. The rail resizes, collapses, and remembers; the entry bar can hide

**Seen:** the rail is a fixed 268 px with no drag handle; the entry bar is always present; there is no
way to give the charts more room or to hide the typing surface when reading.

**Decision:** a drag handle on the rail's edge (pointer and keyboard `ArrowLeft`/`ArrowRight` when
focused), a **Hide rail** control, and `Ctrl+B` to toggle. Width is clamped (min 180 px, max 420 px),
persisted in `$BENCH_HOME/ui.json`, restored on launch, and resets from the keyboard help. A hidden
rail leaves a thin restore strip with the project name, so the window cannot become unnavigable. The
entry bar gets a one-line collapse toggle; collapsed, it still shows the active count and undo.
Preferences are app state, disposable, never project data.

**Done when:** the rail can be dragged, keyboard-resized, hidden and restored; the width survives a
relaunch; collapsing the entry bar leaves the undo action reachable; no layout shift on resize at
100/125/150%.

### U20. 150% does not turn a pair of fields into a column

**Seen:** at 150% the field-pair dialog's two axis inputs and the entry fields stack vertically and
grow tall. The dialog becomes much taller than the content needs.

**Decision:** paired controls stay in one row while there is room for both labels and a usable input
(`minmax(0, 1fr)` each); they stack only below a small breakpoint, and when they stack the gap and
control height stay compact rather than expanding to the row's full height. The sheet is capped to the
viewport with its own scroll, and the entry fields keep the compact inline form. Every change is
measured at 100/125/150%, not just at 100%.

**Done when:** at 150% two axis pickers sit side by side and the sheet fits without clipping; the entry
bar's fields are one row; the same holds at 125%, and only a genuinely narrow window stacks them.

### U21. The window offers the action, not the command

**Seen:** a stale panel's notice says `Re-render with bench --project "…" view render "…" --refresh`;
the empty tab says `bench … add --values '{…}'`; the empty project says `bench init C:\data\sensor`.
The user's instruction is explicit: do not expect the user to use the CLI.

**Decision:** advanced flows may stay agent-led; they still need a visible entry point and a plain
explanation, not a command to copy. For the basic actions — add, edit, remove, import, create or delete
a tab, refresh — the window is the door.

- Stale **plot** panel: refresh automatically after a write (it is a redraw of stored data, no Python).
  Stale **recipe** panel: a **Refresh** button; if the runner is unavailable, the button explains why.
- Empty tab/project: **Add a point** (focuses the bar), **Create a tab…**, **Import…**. CLI text is
  allowed inside a collapsed **For agents** detail, never as the only path.
- Any state the window can fix automatically is fixed automatically: re-read the log after an external
  change, rebuild a plot after a correction, save the tab after the paint.
- Error messages end with the action that resolves them, not with a command.

**Done when:** no primary state requires a terminal; every empty state has at least one button; a
stale plot panel is up to date again on its own; a recipe panel's Refresh is the visible action.

### U22. The empty first tab teaches by doing

**Seen:** `app-empty-tab` shows `n = 0` and a `bench add --values '{…}'` sentence — a command a new
project's owner cannot use without a terminal.

**Decision:** the empty panel says one sentence about what this tab will show, and puts the cursor in
the first field with the button **Add the first point**; a secondary **Import…** is there for a file,
and **Create a tab…** is in the rail. The shape's `add` command moves to the For agents detail. If the
project has no tabs at all, the stage offers **Create a tab…** as the primary action.

**Done when:** a project created in the window can be taken from zero to a first mark without a CLI;
the empty panel has no command in its primary text; keyboard focus lands where typing goes.

### U27. Accessible names say the conclusion, not the log

**Seen:** the panel's accessible name now carries the title, axes, footer and full caption because the
canvas hides both SVG halves; on a recipe panel that is a long sentence with internal method names.

**Decision:** the accessible name is: tab/panel title, axes with units, `n`, verdict in the same words
as the visible hover, and the one interaction hint. It omits the duplicate footer, the full caption,
the dataset and the shape. The caption remains available in the panel's description if a screen
reader asks for more, not in the name.

**Done when:** every panel's accessible name is under ~25 words, contains no id or internal name, and
still answers "what is this and what does it conclude?".

### U28. Field display labels, without rewriting a point

**Seen:** `APP` becomes `app`, `PPS` becomes `pps`, and every surface shows the lowercase identifier.
Units exist on a field but are unused here. A label change would be a shape change; `shape extend`
rightly refuses it.

**Decision:** add an optional display `label` to a shape field, set by an explicit, recorded
declaration-only shape version. Fields, types and order do not change; points keep the shape id they
were recorded with; units are **not** changeable this way, because changing a unit reinterprets
measurements. The label is used wherever a person reads a field name (entry labels, tooltips, axes,
captions, import sheet); the identifier remains in the log and in the copied details.

**Done when:** a shape can be given display labels without a field change; every user-facing surface
uses the label; a unit change is still refused as a different shape.

---

## 6. The agent's side of the same contract

### U23. State the assumption before the write, and the change after it

**Seen:** an agent can import with a guessed time column, fill a missing value, or create a tab with
an inferred shape, and the person sees only the result. The user asked for the opposite: the agent
should explain simply what it did so both sides align.

**Decision:** before a mutation that rests on an assumption (which time column, which field, an
estimated instant, a dropped column, an inferred axis), the agent states it in one sentence and asks
when the answer would change the data. After a mutation, it says in one or two sentences what changed
in the project — rows, points, tabs, versions — using the same plain vocabulary as the window, not
event names. Routine, reversible actions the user already asked for do not need a second confirmation.
The point is alignment, not ceremony: ask when the answer would change the data, and always say what
was done, so both sides can correct the other while it is cheap.

**Done when:** the application's AGENTS.md and the project template's AGENTS.md both carry this rule;
the CLI's human output leads with the same summary; a review of a session shows the assumption stated
before the write and the change summarised after it.

### U24. The CLI's human output uses the same words as the window

**Seen:** `bench import` prints `version 5 replaces version 4 · +1 −0 ~0`; `bench retract` says
`retracted <id>`; `bench add` says `recorded <id> … active in main`.

**Decision:** the first line of a mutating command's output is the change in plain words (`1 row
added, none removed, none changed → version 5`), with the id and event on a second line for the agent.
`--json` is unchanged. This is a small change to printing, not to the log or exit codes.

**Done when:** a person reading the terminal understands what happened without knowing the schema;
`--json` output and exit codes are unchanged; tests assert the human line.

---

## 7. The review process itself

### U25. A review row is readable by the person being asked

**Seen:** the log's "what to look at" cells say `Chart renderer v1`, `the strip reads main · v2, v4`,
`DOF`, `the canvas paints 3,589 pixels`. The user could not tell what to check. Some rows asked
several questions at once, and none said what "wrong" would look like.

**Decision:** every new row answers four things, in this order:
1. **Screen:** what this is, in one clause (`the window after typing a point`).
2. **Check:** one thing to look at, phrased as a question a non-author can answer (`does the new mark
   appear where you typed it?`).
3. **Wrong looks like:** the failure the check is meant to catch (`the count changes but no mark
   appears`).
4. **Your call:** the decision, with the recommendation and the alternative (`keep, or should the
   status be quieter?`).

No internal names in that column. A row that needs a term explains it in the glossary at the top of
the log. Historical rows keep their text as evidence; their verdicts are closed by direction.

**Done when:** a person who has never read the code can answer a row from the image and its three
sentences; a new row with a bare frame filename or a pixel count is rejected in review.

### U26. The contact sheet says where to start

**Seen:** `docs/ui-review/index.html` lists every frame with a filename caption; the user had to ask
which one was `app-interaction` and what to do with it.

**Decision:** the sheet opens with a short "start here" block: the three scaling frames, then one
sentence each for hover/zoom, entry, undo, a refusal, import, and the packaged build; every caption
says what the frame demonstrates, not just its filename. The frame's file name stays in small type for
reference. The sheet explains that images are opened from the folder, not from the in-app preview,
because the preview serves only the HTML file.

**Done when:** the contact sheet's first screen answers "what am I looking at and what should I
notice?" without opening the review log; no caption is only a filename.

---

## 8. The questions from the previous pass, closed

These were listed as "decisions needed" in the roadmap. Each is now decided by the principle above;
the linked `U` item is where it is carried out.

| # | question | decision | carried by |
|---|---|---|---|
| 1 | deleting a tab | move to `views/.trash/` and offer Undo; no log event, no confirmation dialog | U7 |
| 2 | where UI preferences live | `$BENCH_HOME/ui.json`, disposable app state, never project data | U19 |
| 3 | tooltip identity | no id in the UI; values only; Copy details from the point menu | U1, U2 |
| 4 | retraction in the window | a point menu action, one click, no reason prompt; undo restores the same record | U5, U6 |
| 5 | keep the time picker visible? | no: a stated guess with Change; the full picker opens only on request | U8 |
| 6 | refuse an untimed re-export? | no: import with a labelled estimate, correctable; matching by row order is stated | U9 |
| 7 | one column below 980 px | keep it: 125% keeps two columns, 150% becomes legible; the breakpoint is on the viewport | done (`a3888b4`) |
| 8 | name both datasets in a mixed strip | no tab-level lists; a per-panel label only where panels differ | U18 |
| 9 | caption in the accessible name | keep the conclusion, drop the duplicate footer/caption and internal names | U27 |
| 10 | unsigned portable build | ship unsigned; document SmartScreen; signing is a later, separate decision | [packaging.md](packaging.md) |
| 11 | `v0.1.0` | after README and LICENSE; no tag before them | roadmap §4 |
| 12 | the receipt behind `--record` | `--record` is the only writer; a plain run compares and leaves the tree clean | done (`a3888b4`) |
| 13 | `label`/`unit` as a declaration-only version | `label` yes, as a recorded declaration-only version; a unit change is still refused | U28 |
| 14 | review frames without verdicts | the user closed the batch by direction on 2026-10-20; the log records their words and the new protocol | U25, U26 |

Nothing in this file is waiting on the user. A later session may disagree with a decision, but it must
do so by changing this file and the roadmap row, not by reopening a question as if it were undecided.

## 9. What was not changed

- The log stays append-only; corrections and retractions stay events, and a removal is never a
  deletion from `data/events.jsonl`.
- Fitted values still never enter a dataset; the honesty layer (n, DOF, band, verdict) stays on every
  curve.
- The window still never writes outside `Workspace`; all mutations keep going through the core.
- Dataset versions stay immutable; the import's version diff is still recorded even though its UI
  wording becomes plain.
- The 100 ms keystroke and 50 ms re-render budgets are unchanged by anything here. Automatic refresh
  is only allowed where it stays off the entry path or inside the budget.
