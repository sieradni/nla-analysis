# The user surface — findings, decisions, and the work they create

Status: **decided 2026-10-20** from the user's review of the desktop window. **Built 2026-10-20:**
U1 (hover), U3 (statuses and the correction strip), U10 (the import sheet's words), U12 (the state
words, the spelled-out degrees of freedom and the verdict that explains itself), U14 (a plain drawing
and an evidence line built from numbers) and U22 (the empty first panel), plus **U2, U5 and U6** — the
point menu, the restore event and removal as one action with undo. U4 now covers adding, removing,
correcting and importing in both directions; U13, U17, U18 and U21 are partly built — the number
formats, the rail labels, the deduplicated facts and the **Refresh** action — and the roadmap row for
each names what is left. **Recorded 2026-10-21:** a new need, **U29**, was added to this list by the
user — a date/time field can be filled with the current moment instead of only accepting a typed
timestamp. **Built 2026-10-21:** U29, with the clock it depends on — an `instant` field is a date/time
control with a **Now** button in both the entry bar and the correction strip, and every time the window
reads (hover, strip, status, clipboard, rail, time-axis ticks) is on the reader's own clock, where it
had been UTC. Everything a person reads is composed by one
module, `app/renderer/copy.js`; the rest of the list is still open and the roadmap row says so. The
work list is [03-roadmap.md](03-roadmap.md) §6, keyed by the same `U` numbers. The principle is
[ADR 0015](adr/0015-user-surface.md).

**Direction 2026-10-21:** the review loop is on hold. Work is done when it is green and as good as it
can be; the user reports defects from real use, and each report becomes a row here or in the roadmap.
No frame waits for approval, and the window is not opened to take one unless the machine is free —
`app:capture`, `app:measure` and `app:package:check` each take the foreground.

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

**Built 2026-10-20, and completed 2026-10-21.** The values were right, but the time line the decision
promises never appeared: `tooltipLines` had the sentence, and no caller could give it a time, because
the drawing's points were `{ id, x, y }`. The time now travels with the drawing — the core puts
`tObserved` and the estimate flag on every `ChartPoint`, packs them beside the ids for the window,
and hands them to a patched mark from the fold — so a hover over a fitted panel reads
`x 3 · y 8.09 °C` and then `Observed 19 Oct 2026, 06:00` on the reader's clock. When the log says the
time is an import's estimate, both the hover and **Copy details** say `(estimated)` in the same words
the strip and `bench list` use, and a measured point says nothing extra — the two read differently at
a glance. On a time axis the label rides on the value the axis already shows rather than repeating the
instant. The popup is clamped inside the window: its new second line made it taller than the room
above a mark at 150%, which is measured on every capture at 100/125/150%.

### U2. A point has a menu: Copy details, Correct, Remove

**Seen:** the only way to identify a point for a conversation was to read the ULID out of the
tooltip; the only action on a mark was selection-for-correction.

**Built 2026-10-20:** right-click, or Shift+F10 on a selected mark, opens the menu; the keyboard
lands on the first item; Escape closes it and returns focus to the chart; a repaint dismisses it.
**Copy details** writes one line — `x 3 · y 8.09 °C · observed 19 Oct 2026, 06:00 · record 01M58…` —
with the id last and nowhere on screen. Evidence: `app/renderer/chart.js`,
`copy.copiedDetails`, `tests/window-copy.test.mjs`, `pnpm app:capture`, `app-point-menu.png`.

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

**Built 2026-10-20 (part):** one bounded history per tab, in both directions, for adding, removing and
correcting a point. The bar's one button names the act it would reverse — **Undo added point**, **Undo
removal**, **Undo correction** — and after any undo the status offers the matching redo (**Redo added
point**, **Redo removal**, **Redo correction**). `Ctrl+Z`, `Ctrl+Shift+Z` and `Ctrl+Y` drive the same
history from any focus that is not a text field. Undoing a correction writes the values the log held
before the save as a new correction; redoing writes the corrected ones back, so no event is withdrawn
and the log keeps every number the point has held. Redo of undoing an added point is a restore naming
the retraction the undo wrote, so the same record returns. **An import is undone as a version**: the
version it replaced becomes current again as a *new* version, then redo restores the imported one, so
the number only moves forward and nothing is deleted. The window says `Restored the data from before
the import`, not a version number; the CLI (`bench dataset restore`) and the log name the version for
the agent, which is the split [ADR 0015](adr/0015-user-surface.md) draws. The stacks hold 50 acts and
drop the oldest; a new act clears the redo branch; each Save is its own act and is never merged with a
neighbouring one. **Closing a tab** has its own inverse, outside the tab's history: **Close tab** in the
tab's header takes the tab off the screen and its file to `views/.trash/`, and `Ctrl+Shift+T` — or the
status's **Undo tab close** — puts the same tab back with the same drawing, the same counts and the
same undo, because the window kept the file it closed rather than rebuilding one. A close is a window
act, not a log event: nothing is written, and a tab switch or a repaint cannot forget it. **The closed
tab outlives the window**: the list is read back from the project's trash when a project opens, so
closing a tab and quitting still leaves one `Ctrl+Shift+T` away, with the same words; what cannot come
back is the undo of acts made before that window opened, and the bar says so by being empty. On an
empty closed list the chord does nothing at all. **Creating a tab is the fifth kind** (2026-10-21): the
tab a person makes — from the tab sheet or by copying one — is the first act of its own history, so the
bar reads **Undo new tab**, and undo closes it through the project's own close path (the file waits in
the trash with its acts), while the status offers **Redo new tab** to move it home. The close that undo
performs does not also offer **Undo tab close**: one act has one way back. Because that act changes the
drawing and a drawing change clears the stacks, the surviving direction is re-installed after the
change (`keepTabUndo`/`keepTabRedo`) — the act names a tab, not a point, so it is still true of the
window afterwards.
Evidence: `tests/history.test.mjs` (both directions, the branch, the bound), `tests/window-copy.test.mjs`
(the labels), `tests/version-restore.test.ts` (rows, empty first version, optional-field exactness),
`tests/cli.test.ts` (`dataset restore`, both directions and the refusals), `tests/shell.test.ts` (a
correction and a version restored through the bundled core), `pnpm app:capture` (`app-undo`,
`app-correction-undo`, `app-import-undone`, real keystrokes, the log read back after each).

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

**Built 2026-10-20:** the event carries `restores` (the retraction, not the point) and the version it
happened in; the fold applies it only to the retraction in force, so a stale undo cannot re-open a
record that was removed again. [ADR 0016](adr/0016-point-restore.md); evidence in
`tests/binder.test.ts`, `tests/workspace.test.ts`, `tests/shell.test.ts`, `tests/cli.test.ts`, and
the capture's remove → undo → redo.

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

**Built 2026-10-20:** one click in the menu, no prompt; the status reads
`Removed · 14 points left in this tab` and the bar's single undo reads **Undo removal**, naming the
act rather than asking a person to press and find out. The capture asserts the recorded retraction
carries no reason.

### U7. Deleting a tab is recoverable

**Seen:** no delete exists; the note said a tab is a file and deleting it would destroy a question.

**Decision:** deleting a tab moves its file to `views/.trash/<slug>-<timestamp>.json` and offers
**Undo** for the same session. The trash is app state, not log state; views were deliberately kept out
of the log ([ADR 0004](adr/0004-views-and-projects.md)). No confirmation dialog for one tab; deleting
the last tab leaves the project's empty state, which can create one again. A later "recently deleted"
surface is not needed until a person asks for one.

**Done when:** delete → undo restores the exact file and the tab opens again; a deleted tab no longer
appears in the rail; the trash does not accumulate forever (a bounded, disposable folder).

**Built 2026-10-21 — and given a door in the window.** A tab's own row in the rail carries a small
**⋯** (announced as *Actions for this tab “drift over time”*), opening **Rename… / Duplicate… / Close
tab**. **Close tab** moves the file to the trash and offers **Undo tab close**, which is the same
reopen `Ctrl+Shift+T` performs; it works on a tab that is not on screen, where the header's button
cannot reach. **Rename…** and **Duplicate…** share one sheet, because they are one question (a name)
asked about one tab; the sheet says what the name will mean — *The tab keeps its panels, its axes and
the data it reads; only its name changes* versus *The copy starts as the same drawing and is a tab of
its own from then on* — and a refusal caused by the name is said in the sheet, under the field, not
behind it in the status bar. Renaming keeps the drawing and the tab's acts, and only moves its file;
copying opens the copy, and the copy is undoable as a creation. A tab the person creates is undoable
(see U4). The same three acts are in the CLI, for an agent operating a project: `bench view rm
<name>`, `bench view rename <name> <new name>`, `bench view duplicate <name> <new name>`; `rm` goes
through the close path rather than deleting anything, so its archive is the one the window reopens.
No event is written by any of them: a tab is a saved question, not data. Evidence: `src/core/views.ts`
(`renameView`, `duplicateView`, free-name and free-slug refusals), `tests/views.test.ts`,
`tests/cli.test.ts` (a real project: rename moves the file, duplicate draws on its own, rm leaves a
restorable archive), `tests/shell.test.ts` (the bundled core the window loads), `tests/history.test.mjs`
(the fifth kind), and `pnpm app:capture` (the menu, the sheet, rename, duplicate, a background close,
and undo/redo of a creation, at 100/125/150% — `app-tab-menu-*.png`, `app-tab-sheet-*.png`,
`app-tab-creation-undone.png`).

---

## 3. Time, imports, and confirmation

### U8. The time column is a stated guess, not a form field

**Seen:** the sheet refuses to plan until the person picks a time column; the picker stays visible
even when the header obviously is a clock. It reads like data-integrity homework.

**Decision:** on opening a file, the window finds the most likely time column and says so in one line
above the preview: `Time: taken_at — change`. It plans immediately. **Change** opens the full column
choice, including "no time column" (U9). The Import button states what will happen. Refusal only
happens when the file cannot be read or the rows do not validate, not because a person has not
answered a question the window can answer.

**Done when:** a file with an obvious clock can be imported with no picker interaction; the chosen
column is visible before the click; changing it replans; the plan names the assumption in the same
sentence.

**Built 2026-10-21.** One line above the preview and a **Change** button: `Time: from the “taken_at”
column` — the file's own spelling in quotes, so the sentence reads as a sentence and the name reads
as a name. The picker is shut until Change is pressed, and Change puts the keyboard in it. The guess
is found by header name first (`timestamp`, `time`, `date`, `t`, `observed_at`, `t_observed`) and then
by the values, so a clock under a name bench does not list is still found instead of being mistaken
for a file with no clock — only an ISO-shaped column counts, because a guess from a value has to be
one a person can look at and agree with. A column of readings is never read as a clock. A shape that
designates its time field says `Time: from the “date” field` and has no picker, because the
declaration already answered. Choosing nothing is the one refusal left, and it says both ways out.
Evidence: `app-import-time-choice.png`, `app-import-time.png`, the capture's `import-named-time-said`,
`tests/window-copy.test.mjs`.

### U9. A file with no clock is imported with a labelled estimate, not refused

**Seen:** a file with no time column cannot be imported at all; the core refuses with "no column holds
the observation time". A re-export of such a file then reads as all-new rows because matching falls
back to a synthetic instant per row.

**Decision:** offer `No clock — use the row order (estimated)`. The imported rows carry a statement
that the time is estimated, not measured; the sheet says so before the write, the status repeats it,
and a correction can set a real time later (U11). An agent doing this must ask first (§7, U23). This
relaxes the "never invented" wording in ADR 0012/0014: the instant is still never silently invented —
it is labelled as an estimate and is correctable. Matching a re-export of an untimed file by row order
is the honest default; if the row count or order changes, the diff says so rather than silently
claiming all rows are new.

**Done when:** an untimed file imports with an explicit `estimated` marker on its rows and in the
diff; the person can replace the estimate with a real observation time; a file that has a clock never
falls back to the estimate.

**Built 2026-10-21.** The sheet's line reads `Time: the row order — every row is marked estimated`, the
plan repeats it before the click, and the status says what to do about it. The marker is the log's,
not the sheet's: every row the write brings carries `t_estimated`, `bench list` prints the time with
`(estimated)` after it, its JSON carries `t_estimated`, `bench dataset diff` marks a row whose time is
an estimate in both the text and the JSON, and `STATE.md` counts the rows that have one— so the fact survives the sheet closing and reaches an agent that never opened the window. In the
window itself, a hover over that point and **Copy details** both say `(estimated)` after the time
(U1), so a guessed row never reads as a measured one at the moment someone inspects it. A re-read
of an untimed file is matched by the order rows were recorded in, not by instants that an estimate
invented: a value that moved is one changed row, the parent keeps its own instant, and a re-sorted
file honestly reports every disturbed position as changed. `--estimate-time` is the CLI's door and is
never implied; the window's estimate is a stated guess with a Change. A file that has a clock does not
fall back: the value scan finds it (U8), and a shape that designates its time field refuses the
estimate outright. Evidence: `app-import-estimated.png`, the capture's `import-estimate` /
`import-estimated-result` / `import-estimated-cli`, `tests/import.test.ts`, `tests/cli.test.ts`.

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

**Built 2026-10-21 (both halves).** A shape that designates a time field is edited in that field, as
before. A shape that designates nothing gets an `observed` date/time control in the strip, filled from
the row's own instant and followed by the word **estimated** while the log says the time is one;
typing a measured instant and pressing Enter writes a single correction with `t_observed` and no
marker, the tab is rebuilt, the strip closes and the status reads `Corrected · observed 20 Oct 2026,
09:00 · 6 points in this tab` — no estimate in the sentence, because the log no longer holds one. The
core path is `Workspace.correctPoint`'s own: it now accepts an instant for a row whose shape designates
none, refuses one that disagrees with a designated field, and still refuses a correction with nothing
in it — there is no second write path. Evidence: `app-point-estimated.png`, the capture's
`estimated-strip` / `estimated-replaced` / `estimated-strip-overflow`, `tests/workspace.test.ts`, and
the two CLI paths (`correct <id> --at`, `list` before and after).

### U29. A time field can be filled with the current moment

**Seen:** the entry bar gives every shape field the same plain text box. On a shape that designates an
`instant` field as its observation time, adding a point means typing `2026-10-21T09:14:00+02:00` by
hand — the one field in the window that asks a person to know a syntax — and a mistyped clock is a
refusal rather than a correction. A shape with no designated time is stamped with the moment on save
without being asked, so the same bar behaves in two different ways depending on a declaration the
person may not remember.

**Decision:** an `instant` field is a date/time control with a **Now** button. **Now** fills the
current local instant; the field shows it in the reader's local time and the row stores the same
instant in canonical UTC. Typing an ISO string stays a valid way in, because a transcribed observation
is often not now. A blank time is refused with its field marked, never filled silently in a shape that
asked for it; a shape with no designated time keeps being stamped at save, and that time is then shown
and correctable (U11). The control is the same one the correction row uses.

**Built 2026-10-21.** The control is the browser's own date and time input (one line, three segments,
no syntax), the same control in both rows, and the moment it holds is stored as canonical UTC. The
blank case is the core's refusal, reused: the field is marked and focused. **Recorded is Now then
Add** — two presses, not one — because a field prefilled with the paint time would record an
observation time nobody pressed; requirements §7 puts that rule above the shorter interaction. A
correction that edits another value keeps the instant exactly, seconds and milliseconds included.
Evidence: roadmap U29, `tests/window-copy.test.mjs`, and a headless Chromium run against the real
renderer modules (30 checks, both rows). Still open: frames at 100/125/150% (no window was opened;
review is advisory), and at a narrow window the field group wraps while the control itself stays on
one line (U20).

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

  Built 2026-10-20: the chip is under the drawing, `Tentative`, `Supported`, `Contradicted` or
  `Not enough data`; hover and keyboard focus both open the sentence, which names what would change
  the answer. The same sentence is in the panel's accessible name.

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
once per panel (the evidence line under the drawing is the authority); the strip does not repeat it.

**Done when:** no frame shows the same title twice, no panel title is `main <recipe>`, and every
number in a caption has a word saying what it is.

**Built 2026-10-20:** the drawing no longer composes any of its own chrome. The core's plain mode
(`renderChartLayers(spec, { plain: true })`) leaves out the title, the `main · drift` subtitle, the
footer and the provenance attributes, so the picture is axes, grid, fits, marks and the recipe's
caption. The strip owns the title, `copy.panelEvidence` owns the evidence line under the drawing and
`copy.verdictWord`/`verdictExplanation` own the verdict chip. Nothing is rewritten after mount, and
nothing is parsed back out of prose: the core writes the evidence as numbers (`chart.evidence`: point
count, regimes, parameters, degrees of freedom, band, or why no curve is drawn) and `copy.js` composes
the sentence from them. The recipes' `footer` stays for the SVG artifact and `bench chart`.

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
- **Counts:** the drawing's evidence line owns `n`; the stage shows the dataset's point count only
  when panels disagree with it (e.g. a filtered panel); the entry readout shows the active count only
  when there is no chart to carry it.
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

**The loop is on hold (direction 2026-10-21).** A frame and its row are evidence that a change was
looked at, not a request queued for approval. The user reports what is wrong from use; a report is
recorded here as a row, with a `U` id in the roadmap, like any other finding. U25 and U26 below still
govern how a row is written when one is produced.

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
sentences; a row with a bare frame filename or a pixel count is rejected when it is written.

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
| 1 | deleting a tab | move to `views/.trash/` and offer Undo; no log event, no confirmation dialog | U7 — done 2026-10-21 (rail menu, `bench view rm`, rename and duplicate, undo of creation) |
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
