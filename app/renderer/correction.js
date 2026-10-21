/*
 * The correction strip: which record the bar is editing, the ring that says so, saving the edit, and
 * every path that ends one.
 *
 * The strip is the tab's second memory of a record — the history remembers what was done to it, this
 * remembers that it is being edited — so every act that withdraws the record calls `endEditFor` and
 * the strip lets go. One record at a time: selecting in one panel clears the ring in the others, so
 * the strip can never be aimed at a mark the person is not looking at.
 */
import { state, bridge, call } from './state.js'
import { refusal, status as copyStatus } from './copy.js'
import { fieldValueMap, focusFirstField, markProblems, observedFieldValue } from './fields.js'
import { clearStatus, setStatus } from './status.js'
import { renderEntry } from './entry.js'
import { renderTabs } from './rail.js'
import { renderView, captureRestore } from './panels.js'
import { noteCorrection } from './history.js'

/**
 * Select a record for editing, or clear the selection.
 *
 * Selecting in one panel clears the ring in the others, so the strip can never be aimed at a mark
 * the user is not looking at. The values come from the core, not the tooltip: a tooltip rounds for
 * reading, and a correction must start from the number the log holds.
 */
export async function selectPoint(id, index) {
  if (id === null) {
    closeCorrection()
    return
  }
  if (state.selection && state.selection.id !== id) {
    var previous = state.handles[state.selection.index]
    if (previous && previous.clearSelection) previous.clearSelection()
  }
  state.selection = { id: id, index: index }
  if (state.busy || !state.view) return
  state.busy = true
  try {
    var detail = await call(bridge.point(state.project.dir, id, state.view.name))
    // The selection can move or be cleared while this read is in flight: Escape, another mark, or a
    // repaint that replaced the drawing. A late answer must not reopen a strip the person closed, and
    // must not pull the cursor into a field they are not editing.
    if (!state.selection || state.selection.id !== id) {
      state.busy = false
      return
    }
    state.correction = detail
    state.timing = null
    state.busy = false
    setStatus(
      'ok',
      copyStatus.editing({
        values: detail.values,
        panel: state.view.panels[index],
        fields: detail.fields,
        timeField: detail.timeField,
      }),
    )
    renderEntry()
    focusFirstField()
  } catch (error) {
    state.correction = null
    state.selection = null
    state.busy = false
    renderEntry()
    setStatus('error', refusal((error && error.message) || 'the core could not read that point'))
  }
}

/**
 * The record the strip is editing has left the drawing: the ring and the strip let go of it.
 *
 * The strip is the tab's other memory of a record — the history remembers what was done to it, the
 * strip remembers that it is being edited — so every path that withdraws a record ends the edit:
 * undoing the add, redoing a removal, an import that withdrew or rewrote the row, and a Save the
 * core refused because the row had already gone. The status is the caller's; whichever act removed
 * the record has its own sentence to write, and this one would only overwrite it.
 */
export function endEditFor(id) {
  if (state.correction === null || state.correction.id !== id) return
  if (state.selection) {
    var handle = state.handles[state.selection.index]
    if (handle && handle.clearSelection) handle.clearSelection()
  }
  state.correction = null
  state.selection = null
}

/**
 * The canonical instant a correction left in a designated field, or undefined when the core's
 * answer does not carry one. The window says the time only when it has the time.
 */
function correctedTime(corrected, timeField) {
  var values = (corrected && corrected.values) || {}
  var value = values[timeField]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Put the bar back to adding, and take the ring off. */
export function closeCorrection() {
  if (state.selection) {
    var handle = state.handles[state.selection.index]
    if (handle && handle.clearSelection) handle.clearSelection()
  }
  state.selection = null
  state.correction = null
  clearStatus()
  renderEntry()
}

/**
 * Save an edit to an existing record. The log gets a `point_corrected` event that supersedes the
 * original; nothing is overwritten and nothing is deleted. The core rebuilds the tab before this
 * returns, so a panel drawn by a recipe is reported stale instead of continuing to look current.
 */
export async function submitCorrection() {
  var correction = state.correction
  var before = correction.values
  var values = fieldValueMap()
  // A shape that designates its time says it in a field, and the core re-derives the instant from
  // that field. A shape that designates nothing gets the observed control instead: that is the one
  // way an imported estimate becomes a measured time.
  var tObserved = observedFieldValue()
  var moved =
    correction.timeField !== undefined
      ? String(correction.values[correction.timeField]) !== String(values[correction.timeField])
      : tObserved !== undefined && tObserved !== correction.tObserved
  var ended = false
  state.busy = true
  renderEntry()
  try {
    var corrected = await call(
      bridge.correctPoint(
        state.project.dir,
        correction.id,
        values,
        state.view.name,
        tObserved === undefined || tObserved === correction.tObserved ? undefined : tObserved,
      ),
    )
    // The bar's undo reverses *this* correction: the values the log held before the save, and the
    // values it holds now, so both directions are one recorded correction apiece.
    noteCorrection(correction.id, before, corrected.values)
    state.correction = null
    state.selection = null
    state.busy = false
    state.opened = corrected.view
    state.view = corrected.view.view
    renderTabs()
    renderView(captureRestore())
    var stale = corrected.view.kept
    // The new instant, said only when it is one: a status that reads `observed undefined` is worse
    // than a status that says only what happened. `estimated` is the log's answer, so a replaced
    // estimate is not called one afterwards.
    var movedTo = moved
      ? correction.timeField === undefined
        ? corrected.tObserved
        : correctedTime(corrected, correction.timeField)
      : undefined
    setStatus(
      stale.length > 0 ? 'error' : 'ok',
      copyStatus.corrected({
        active: corrected.active,
        stalePanels: stale.length,
        observed: movedTo,
        estimated: corrected.estimated,
      }),
    )
    focusFirstField()
  } catch (error) {
    var firstInvalid = markProblems((error && error.problems) || [])
    // The core refuses a correction on a withdrawn row, and says so as `missing`: that is the record
    // the strip is aimed at being gone, not a value to retype, so the strip ends here. A validation
    // problem keeps it open — there is a number to fix, and the fields still hold it.
    if (error && error.kind === 'missing') {
      endEditFor(correction.id)
      ended = true
    }
    setStatus(
      'error',
      refusal((error && error.message) || 'the core refused the correction'),
      (error && error.problems) || ((error && error.hint) ? [refusal(error.hint)] : []),
    )
    if (firstInvalid) firstInvalid.focus()
  } finally {
    state.busy = false
    renderEntry()
    // The strip's inputs are gone with it, so the caret was standing in one that no longer exists.
    // Adding a point is now what the bar does, and its first field is where the keyboard belongs.
    if (ended) focusFirstField()
  }
}
