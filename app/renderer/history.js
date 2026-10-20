/*
 * The tab's undo history.
 *
 * One drawing's worth of acts: the point this window last appended, the removals made from a point's
 * menu, and the branch a redo would follow. This file owns those stacks and nothing else — the core
 * calls, the repaint and the status line stay in `entry.js`, which asks what the next act is, takes
 * it, and reports back whether it happened.
 *
 * The history belongs to the drawing it happened in. `resetTabHistory` is the one seam every view
 * change goes through (`app.js`, `tabs.js`, `import.js`), so the point and both stacks are always
 * cleared together: the bar cannot offer an act against a point the current drawing never showed.
 */

var appended = null // { id, seq } — the last point this window added
var removals = [] // { id, retraction, seq } — oldest first
var redos = [] // removals that were undone, newest last
var seq = 0 // the clock an append and a removal share, so undo can pick the later act

export function resetTabHistory() {
  appended = null
  removals = []
  redos = []
  seq = 0
}

/** The id of the point this window last added, for the bar's own timing figure. */
export function appendedId() {
  return appended === null ? null : appended.id
}

/** A point was recorded. A new act ends the branch a redo would have followed. */
export function noteAppend(id) {
  seq += 1
  appended = { id: id, seq: seq }
  redos = []
}

/**
 * A point was removed from its menu. Removing the point this window appended leaves no append to
 * undo: the removal is the later act, and the one the bar should offer.
 */
export function noteRemoval(id, retraction) {
  seq += 1
  if (appended !== null && appended.id === id) appended = null
  removals.push({ id: id, retraction: retraction, seq: seq })
  redos = []
}

/** What Ctrl+Z would reverse: the later of the append and the last removal, or nothing. */
export function nextUndo() {
  var removal = removals[removals.length - 1]
  if (removal !== undefined && (appended === null || removal.seq > appended.seq)) {
    return { kind: 'removal', removal: removal }
  }
  return appended === null ? null : { kind: 'point', point: appended }
}

/** Take that act out of the stack. The caller reports back through the three calls below. */
export function takeUndo() {
  var entry = nextUndo()
  if (entry === null) return null
  if (entry.kind === 'removal') removals.pop()
  else appended = null
  return entry
}

/** The act happened. A removal becomes the thing a redo would reverse. */
export function undoFinished(entry) {
  if (entry.kind === 'removal') redos.push(entry.removal)
}

/**
 * The act did not happen. `keep` is false when it never can — the record moved under it — so the
 * button stops offering an act that can only refuse.
 */
export function undoFailed(entry, keep) {
  if (!keep) return
  if (entry.kind === 'removal') removals.push(entry.removal)
  else appended = entry.point
}

/** The next act redo would reverse, or null. */
export function takeRedo() {
  var removal = redos.pop()
  return removal === undefined ? null : { kind: 'removal', removal: removal }
}

/** Redo withdrew the point again, with a new removal event: that is what the next undo reverses. */
export function redoFinished(entry, retraction) {
  seq += 1
  removals.push({ id: entry.removal.id, retraction: retraction, seq: seq })
}

export function redoFailed(entry) {
  redos.push(entry.removal)
}
