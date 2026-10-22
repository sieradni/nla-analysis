/*
 * The tabs this window can put back, newest first.
 *
 * The list itself is the project's, not the window's: a close moves the tab's file to `views/.trash/`
 * and hands back the archive, and a window fills this from the core on launch. So a close outlives
 * the process that made it, and the bytes on disk are the only copy — reopening moves that file home
 * rather than writing a second one.
 *
 * What does not survive a relaunch is the history the tab held: those acts were this window's memory,
 * and the log cannot reconstruct them. A tab closed in this session keeps its acts (that is why this
 * module also holds a snapshot per archive); one closed before the window opened comes back with an
 * empty bar, which is the truth.
 *
 * This stack is deliberately outside `state.showView`, which owns the per-tab history and clears it
 * whenever the drawing changes. A tab switch, another writer's redraw and opening a tab are all
 * changes of drawing, and none of them closed anything; a close must survive every one of them. Only
 * a close adds here, only a reopen takes, and opening another project refills it — a closed tab
 * belongs to the project it was closed in.
 */

// The same bound as the project's trash, so every closed tab the project keeps is one the window can
// put back. The core prunes the files; this keeps the list and its snapshots to what is still there.
var LIMIT = 20

var closed = []

// Archive file -> the tab history it held when it closed. Keyed by file, because two closes of the
// same tab in one session are two different archives.
var histories = new Map()

function prune() {
  if (closed.length > LIMIT) closed = closed.slice(0, LIMIT)
  var live = new Set(
    closed.map(function (entry) {
      return entry.file
    }),
  )
  histories.forEach(function (_history, file) {
    if (!live.has(file)) histories.delete(file)
  })
}

/**
 * Take the project's own list, newest first: what a window has to know on launch before anything has
 * been closed in it. Any history still held for an archive in that list stays; the rest goes.
 */
export function setClosedTabs(entries) {
  closed = (entries || []).slice()
  prune()
}

/** A tab left the screen. `entry` is the archive the core returned; `history` is its stacks. */
export function noteClosed(entry, history) {
  closed.unshift(entry)
  if (history) histories.set(entry.file, history)
  prune()
}

/**
 * The newest closed tab and the acts it held (null after a relaunch), taken off the list.
 *
 * `historyLost` is the question the status row asks: it is true when this window cannot reach the
 * acts that made the tab, so the reopen says so rather than leave an empty bar looking like a tab
 * nothing has happened in (U30).
 */
export function takeClosed() {
  if (closed.length === 0) return null
  var entry = closed.shift()
  var history = histories.get(entry.file) || null
  histories.delete(entry.file)
  return { entry: entry, history: history, historyLost: history === null }
}

/**
 * One archive by file, taken off the list: a redo of creating a tab names the file its own undo left
 * behind, so it must restore that tab rather than whichever close was newest. Null when the list no
 * longer holds it — a pruned or already-reopened archive is still worth trying, and the core refuses
 * it with a sentence rather than this module guessing.
 */
export function takeClosedFile(file) {
  for (var index = 0; index < closed.length; index += 1) {
    if (closed[index].file !== file) continue
    var entry = closed.splice(index, 1)[0]
    var history = histories.get(entry.file) || null
    histories.delete(entry.file)
    return { entry: entry, history: history }
  }
  return null
}

/** Put a tab back after a reopen failed for a reason that may pass: it keeps its place, with its acts. */
export function putBackClosed(taken) {
  if (!taken) return
  closed.unshift(taken.entry)
  if (taken.history) histories.set(taken.entry.file, taken.history)
  prune()
}
