# ADR 0016 — Undo of a removal is a restore event that names the retraction

Status: accepted, 2026-10-20.

## Context

A removal is a `point_retracted` event: the record stays in the log and leaves the evidence set. The
window's undo had no inverse for it, so the only way back was to record the values again under a new
id. That is a second record claiming to be the first — it loses the observation time, breaks the
history the person just undid, and leaves two records for one measurement.

The user surface decided the behaviour ([ADR 0015](0015-user-surface.md), U5): undo of a removal
brings back *the same record*. The log is append-only, so "bring back" has to be an event.

Three shapes were possible:

1. **Undo by deleting the retraction line.** Fast to implement, and it makes the log lie about what
   happened: the removal was a real act, and an append-only file cannot take it back.
2. **A `point_restored` event that carries the values, time and version again.** Self-contained, but
   two copies of the same facts can disagree, and the copy is what a reader would believe.
3. **A `point_restored` event that names the retraction it reverses.** One fact, checkable against
   the log: the restore applies only while that retraction is the one in force.

## Decision

`point_restored` carries `dataset`, `restores` (the id of the `point_retracted` event) and `version`
(the version current when the restore happened, as a retraction carries). The record's id, values,
observation time and version are its own and are not repeated.

- **The restore names the act, not the point.** A point can be withdrawn more than once; naming a
  retraction makes a stale undo detectable instead of silently re-opening a record that was removed
  again since. `restores` is a different relation from `supersedes`, which has always named the
  record, so it gets its own key rather than overloading the old word.
- **Only the retraction in force can be reversed.** The fold keeps the current retraction on the
  point (`retractedBy`) and refuses a restore that names any other, as a structural problem. The
  same rule is what makes a second retraction a refusal in `Workspace`.
- **Order is by instant, and a tie goes to the later line.** A retraction and a restore are both
  events with `at`; the fold settles the point's status from the later act, so replaying the file
  gives the same answer as reading it forwards.
- **A restore belongs to the version it happened in.** Like a correction and a retraction, it carries
  the version that was current; an older version keeps reading as it did, and `foldVersion` applies
  it only when that version is at or below the horizon.
- **One event per undo.** `Workspace.restorePoint` refuses a point that is already active, so an
  undo cannot record an act that changed nothing — the same rule a second retraction follows.
- **The CLI and the window share it.** `bench restore <id>` and the window's **Undo** are the same
  `Workspace` call; there is no second path to the log.
- **A caller that remembers the act names it.** `restorePoint(id, retraction)` reverses that removal
  or refuses with `that removal is no longer the one in force`; it never falls back to the newest
  removal of the same point. `bench restore <id>` omits the id and means the removal in force, which
  is the only one a person naming a point can mean. The window keeps the id its own `retractPoint`
  returned, so undo reverses what it remembers — and a view change (another tab, another project, a
  watched redraw) or an external write drops the memory rather than offering a button that could
  only refuse or act on a drawing that never showed the point.

## Consequences

- A removal and its undo are two events in the log, both true. `bench check` validates the chain and
  reports a restore that names a missing or superseded retraction.
- An analysis recorded before a restore is reported stale: the evidence set it read cannot be shown
  to match the data any more.
- The window keeps a small per-tab removal history so **Undo** and **Redo** act on the latest
  removal. That is the seam roadmap U4 grows into the tab's whole undo/redo history; nothing here
  needs to change when it does.
- A copied detail line is the one place a record id appears on purpose. It is written to the
  clipboard, never to a visual surface.
