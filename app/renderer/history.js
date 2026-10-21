/*
 * The tab's undo history.
 *
 * One drawing's worth of acts, in both directions. An entry names the act and what reversing it
 * means; the core calls, the repaint and the status line stay in `entry.js`, which asks what the
 * next act is, takes it, and reports back whether it happened.
 *
 * Five kinds:
 *   point      — a point this window recorded. Undo withdraws it; redo brings the same record back.
 *   removal    — a point taken out from its menu. `retraction` names the act an undo must reverse,
 *                so a later removal by another writer cannot be undone under this one's name.
 *   correction — values changed from `before` to `after`. Each direction is one recorded correction,
 *                so the log keeps every number a point has held.
 *   import     — a dataset version replaced the one before it. Undo restores the older version's
 *                rows as a new version; redo restores the imported one. Nothing is deleted either
 *                way, and the two version numbers never move backwards.
 *   tab        — a tab this window created, by the tab sheet or by copying one. Undo closes it
 *                through the project's own close path, so its file waits in the trash with its acts;
 *                redo moves that archive home again. `file` names the archive a redo would take.
 *
 * The history belongs to the drawing it happened in. `state.showView` is the one place the open tab
 * changes, and the only caller of `resetTabHistory` (tests reset it directly), so the stacks are
 * cleared with the drawing: the bar cannot offer an act against a point the current drawing never
 * showed.
 *
 * A tab act is the one exception, and it is kept in one place: undoing it closes the drawing that
 * holds it, so the change that would clear the stacks is the act itself. The direction that must
 * outlive that change is put back by `keepTabUndo`/`keepTabRedo` — the act names a tab, not a point,
 * so it is still true of the window after the stage moved.
 *
 * The stacks are bounded, and adjacent acts are deliberately not merged: one Save is one act, and a
 * second correction of the same point is a second step backwards. A person who fixes two numbers
 * expects two undos, and the log — not this module — is the history that lasts beyond the session.
 */

var LIMIT = 50

var undos = [] // acts that can still be undone, oldest first
var redos = [] // acts that can be redone, next at the end
var appended = null // the id of the last point this window added, for the timing figure

export function resetTabHistory() {
  undos = []
  redos = []
  appended = null
}

/**
 * The stacks as they are, for a tab that is leaving the screen but may come back. Closing a tab is a
 * window act, and the acts made in it are part of what the tab was: the caller takes this before
 * `showView` clears the drawing, and gives it back when the tab is reopened.
 *
 * The entries are copied by the array, not by the act: an entry is never edited in place — a redo or
 * an undo pushes a new one — so the snapshot cannot be rewritten under the tab that owns it.
 */
export function snapshotTabHistory() {
  return { undos: undos.slice(), redos: redos.slice(), appended: appended }
}

/**
 * A reopened tab's own acts, both directions, and the timing figure they named. A tab from before
 * this window opened has no snapshot — the acts were the earlier window's memory — and the cleared
 * stacks `showView` left are the honest answer for it.
 */
export function restoreTabHistory(snapshot) {
  if (!snapshot) return
  undos = snapshot.undos.slice()
  redos = snapshot.redos.slice()
  appended = snapshot.appended
}

/** The id of the point this window last added, for the bar's own timing figure. */
export function appendedId() {
  return appended
}

/** Keep the oldest acts from growing the window's memory without limit. */
function push(stack, entry) {
  stack.push(entry)
  while (stack.length > LIMIT) stack.shift()
}

/** A point was recorded. A new act ends the branch a redo would have followed. */
export function noteAppend(id) {
  push(undos, { kind: 'point', id: id })
  appended = id
  redos = []
}

/**
 * A point was removed from its menu. Removing the point this window appended leaves no append to
 * undo: the removal is the later act, and the one the bar should offer.
 */
export function noteRemoval(id, retraction) {
  if (appended === id) appended = null
  push(undos, { kind: 'removal', id: id, retraction: retraction })
  redos = []
}

/**
 * An import replaced the data under the tab. It ends only the acts whose target it touched: a record
 * it withdrew has nothing left to undo, and one it rewrote holds numbers the act would write back
 * over. Every other act keeps its place in order — undoing one is reached only after the acts
 * recorded later, which restore the values it expects, so "type a point, import, undo the import,
 * undo the point" works.
 *
 * The argument is the write's own report — `ImportedTable`'s `touched`, `dataset` and `version` — not
 * three loose facts. Those are the core's answer about a write that has already happened; a caller
 * cannot supply two of them and quietly mean "touched nothing", which is how a guessed-valid act
 * gets offered and then refused.
 *
 * A report it cannot read is a write it cannot reason about, and the safe direction is the old one:
 * end every act that names a record, and every import act, rather than keep one on a guess. The
 * core's refusal classification stays the backstop for anything this cannot reason about either way.
 * The newest act still clears the redo branch; that is `noteImport`'s job, not this one's.
 */
export function reconcileImport(report) {
  report = report || {}
  var gone = Array.isArray(report.touched) ? new Set(report.touched) : null
  var version = typeof report.version === 'number' ? report.version : null
  var dataset = typeof report.dataset === 'string' ? report.dataset : null

  undos = undos.filter(function (entry) {
    // A tab act names a tab, not a record: an import cannot withdraw the fact that this window made
    // one, and the tab it made is still the tab holding these acts.
    if (entry.kind === 'tab') return true
    if (entry.kind !== 'import') return gone === null ? false : !gone.has(entry.id)
    // An import act's undo restores the version it replaced, which is only still an older state of
    // this dataset if the act belongs to this dataset and named a version it has moved past since.
    // "The empty dataset" stops being restorable the moment the dataset holds more than one
    // version, which a write the window could not read is assumed to have done.
    if (dataset === null || version === null) return false
    // Another dataset's version this write did not move: its act still names an older state of its
    // own chain, so the tab keeps it.
    if (entry.dataset !== dataset) return true
    return entry.restored !== null && entry.restored < version
  })
  // The timing figure names the last point this window added; a withdrawn one cannot be named.
  if (appended !== null && (gone === null || gone.has(appended))) appended = null
}

/**
 * An import replaced a dataset version. `version` is the one it wrote, and `restored` is the one it
 * replaced — null when the dataset was empty, so undo means "the empty dataset". Both are version
 * numbers to come back to, not files to read again: the imported version already holds its rows.
 */
export function noteImport(dataset, version, restored) {
  push(undos, {
    kind: 'import',
    dataset: dataset,
    version: version,
    restored: restored === undefined ? null : restored,
  })
  redos = []
}

/**
 * A tab came into being in this window. It is the first act of the drawing it opens, so the caller
 * notes it after `showView`: the stack it lands in is the new tab's own.
 */
export function noteTabCreated(name) {
  push(undos, { kind: 'tab', name: name, file: null })
  redos = []
}

/**
 * A tab act whose undo changed the drawing: the redo that names the archive it left behind is put
 * back after `showView` cleared the stacks. A new act ends the redo branch, and this is one.
 */
export function keepTabRedo(entry) {
  redos = [entry]
}

/**
 * A tab act whose redo changed the drawing, at the head of the restored tab's own acts: the tab was
 * created before anything done in it, so it is the last thing an undo reaches, not the first.
 */
export function keepTabUndo(entry) {
  undos = [entry].concat(undos)
}

/** Values were corrected. `before` and `after` are whole value maps, so either can be written back. */
export function noteCorrection(id, before, after) {
  push(undos, {
    kind: 'correction',
    id: id,
    before: { ...before },
    after: { ...after },
  })
  redos = []
}

/** What Ctrl+Z would reverse: the newest act that is still on the stack, or nothing. */
export function nextUndo() {
  return undos.length === 0 ? null : undos[undos.length - 1]
}

/** Take that act out of the stack. The caller reports back through the two calls below. */
export function takeUndo() {
  return undos.length === 0 ? null : undos.pop()
}

/**
 * The act happened. `patch` carries what the core now knows and a redo must name — a retraction id,
 * or a correction's written values. Undo of an append always disarms the timing figure: the point it
 * named is gone from the project, even if a redo will bring it back later.
 */
export function undoFinished(entry, patch) {
  push(redos, patch === undefined ? entry : { ...entry, ...patch })
  appended = null
}

/**
 * Whether a refusal says the act can never be reversed: the record it named has moved under it, so
 * pressing the same button again would repeat the same refusal.
 *
 * The core's `kind` is the evidence, not the sentence — matching prose would break the moment a
 * sentence changed. A failure the core did not classify (an unreadable file, a dropped call, a
 * thrown error) has no kind, and is worth retrying: the next press may well work.
 */
export function permanentRefusal(error) {
  var kind = error && error.kind
  return kind === 'invalid' || kind === 'missing' || kind === 'invariant'
}

/**
 * The act did not happen. It stays on the stack when the failure was temporary, so the button can
 * try again; a refusal that can never succeed is dropped, because a control that can only refuse is
 * worse than no control.
 */
export function undoFailed(entry, error) {
  if (!permanentRefusal(error)) undos.push(entry)
}

/** What Ctrl+Shift+Z would repeat, without taking it: the status offers it beside whatever it says. */
export function nextRedo() {
  return redos.length === 0 ? null : redos[redos.length - 1]
}

/** The next act redo would reverse, or null. */
export function takeRedo() {
  return redos.length === 0 ? null : redos.pop()
}

/**
 * Redo happened. A removal's redo is a *new* retraction, so `patch` replaces the one the entry
 * remembered; an append's redo is a restore, which the next undo reverses by withdrawing it again.
 */
export function redoFinished(entry, patch) {
  var next = { ...entry, ...(patch || {}) }
  // A redo of a point's undo restored the window's own record, so the bar's timing figure can name
  // it again. This is a fact about the stack's entries, not a description of the acts: which kinds
  // exist, what they are called and what they run lives in `entry.js`'s one table.
  if (next.kind === 'point') appended = next.id
  push(undos, next)
}

/** A redo that can never happen (the point is gone) is dropped rather than left to refuse again. */
export function redoFailed(entry, error) {
  if (!permanentRefusal(error)) redos.push(entry)
}
