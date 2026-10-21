/*
 * The act table, and the two directions each kind of act can be reversed in.
 *
 * `undoLastAction`, `redoLastAction`, the bar's undo button and the status's redo button all read
 * this table, so the five kinds are written down once and a sixth is one row. The words are
 * `copy.js`'s (`labels`, `actTitle`); the table pairs them with a kind and an effect and composes no
 * sentence of its own.
 *
 * It sits above the bar and the status because carrying out an act redraws them and says what
 * happened. `actOffer` is the one thing they need in the other direction: `app.js` hands it to them
 * through `navigation.js`, the seam every module uses to reach one it sits above.
 */
import { state, ui, bridge, call } from './state.js'
import { actTitle, idleActTitle, labels, refusal, status as copyStatus } from './copy.js'
import { entryHasText, focusFirstField } from './fields.js'
import { setStatus } from './status.js'
import { renderEntry } from './entry.js'
import { endEditFor } from './correction.js'
import { renderTabs } from './rail.js'
import { captureRestore, rebuildTab, renderView } from './panels.js'
import {
  nextRedo,
  nextUndo,
  permanentRefusal,
  redoFailed,
  redoFinished,
  takeRedo,
  takeUndo,
  undoFailed,
  undoFinished,
} from './history.js'
import { actions } from './navigation.js'

/*
 * The one description of every kind of act: what the bar and the status call it, what its tooltip
 * says, and the function that carries it out in each direction. `undoLastAction`, `redoLastAction`,
 * the bar's button and the status's redo all read this table, so a fifth kind is one row here and
 * nowhere else. The words are `copy.js`'s (`labels`, `actTitle`); this table only pairs them with a
 * kind and an effect — it is the only place in the renderer where the five kinds are written down.
 */
var ACTS = {
  point: {
    undo: { label: labels.undoPoint, title: actTitle('undo', labels.actPoint), run: undoPoint },
    redo: { label: labels.redoPoint, title: actTitle('redo', labels.actPointRedo), run: redoPoint },
  },
  removal: {
    undo: { label: labels.undoRemoval, title: actTitle('undo', labels.actRemoval), run: undoRemoval },
    redo: {
      label: labels.redoRemoval,
      title: actTitle('redo', labels.actRemovalRedo),
      run: redoRemoval,
    },
  },
  correction: {
    undo: {
      label: labels.undoCorrection,
      title: actTitle('undo', labels.actCorrection),
      run: undoCorrection,
    },
    redo: {
      label: labels.redoCorrection,
      title: actTitle('redo', labels.actCorrectionRedo),
      run: redoCorrection,
    },
  },
  import: {
    undo: { label: labels.undoImport, title: actTitle('undo', labels.actImport), run: undoImport },
    redo: { label: labels.redoImport, title: actTitle('redo', labels.actImportRedo), run: redoImport },
  },
  // A tab this window created. Its two directions close and restore a tab, which is the tab
  // lifecycle's own state, so the table names the direction and nothing else: growing a second copy
  // of "close a tab" here is how two ways to close one would start to disagree.
  tab: {
    undo: {
      label: labels.undoTab,
      title: actTitle('undo', labels.actTab),
      run: function (entry) { return actions.undoTabCreated(entry) },
    },
    redo: {
      label: labels.redoTab,
      title: actTitle('redo', labels.actTabRedo),
      run: function (entry) { return actions.redoTabCreated(entry) },
    },
  },
}

/**
 * What the bar says for the act at the top of a stack, or the idle words when the stack is empty.
 * One lookup, so the button and the status cannot name different acts for the same entry.
 */
function wordsFor(next, direction) {
  var act = next === null ? undefined : ACTS[next.kind]
  if (act !== undefined) return act[direction]
  return {
    label: direction === 'undo' ? labels.undo : labels.redo,
    title: idleActTitle(direction),
  }
}

async function undoPoint(entry) {
  state.busy = true
  renderEntry()
  try {
    var retracted = await call(
      bridge.retractPoint(state.project.dir, entry.id, 'undo from the window'),
    )
    // Redo of this undo is a restore, and it names this retraction so it can only reverse this act.
    undoFinished(entry, { retraction: retracted.retraction })
    // The point this undo withdrew may be the one the strip is editing: the strip goes with it.
    endEditFor(entry.id)
    state.timing = null
    // A tab that was deleted on disk has nothing to rebuild; the bar's own count is enough, and the
    // `finally` below puts the bar back.
    if (!state.view) {
      if (state.projectEntry) state.projectEntry.active = retracted.active
      setStatus('ok', copyStatus.removed({ active: retracted.active }))
      return
    }
    var refreshed = await call(bridge.refreshView(state.project.dir, state.view.name))
    state.opened = refreshed
    state.view = refreshed.view
    state.busy = false
    renderTabs()
    renderView(captureRestore())
    focusFirstField()
    var active = refreshed.entry ? refreshed.entry.active : 0
    setStatus('ok', copyStatus.removed({ active: active }))
  } catch (error) {
    // A record another writer already withdrew is not undoable by this button, ever: forget the
    // entry rather than leave a control that can only refuse. This is the same rule the removal
    // history follows.
    undoFailed(entry, error)
    setStatus(
      'error',
      refusal((error && error.message) || 'the core refused the retraction'),
      (error && error.problems) || [],
    )
  } finally {
    state.busy = false
    renderEntry()
  }
}

/**
 * Undo a removal. The core appends a restore that names the retraction it reverses, so the same
 * record comes back — same id, values, observation time and version — rather than a copy of it.
 */
async function undoRemoval(entry) {
  state.busy = true
  renderEntry()
  try {
    // Name the removal this undo remembers. The core reverses that act or refuses; it never picks
    // the newest removal of the same point, which may be somebody else's later act.
    var restored = await call(bridge.restorePoint(state.project.dir, entry.id, entry.retraction))
    undoFinished(entry)
    var active = await rebuildTab()
    setStatus('ok', copyStatus.restored({ active: active === null ? restored.active : active }))
  } catch (error) {
    // A removal that is no longer in force is not coming back: drop the entry, rebuild so the screen
    // agrees with the log, and say why. Any other refusal is temporary, so the act stays available.
    undoFailed(entry, error)
    if (permanentRefusal(error)) {
      try {
        await rebuildTab()
      } catch (rebuildFailure) {
        setStatus('error', refusal(rebuildFailure && rebuildFailure.message))
        return
      }
    }
    setStatus('error', refusal(error && error.message), (error && error.problems) || [])
  } finally {
    state.busy = false
    renderEntry()
  }
}

/** Redo a removal after undoing it: the point is withdrawn again, and remains undoable. */
async function redoRemoval(entry) {
  state.busy = true
  renderEntry()
  try {
    var removed = await call(bridge.retractPoint(state.project.dir, entry.id))
    // Redo withdrew the point again, with a new removal event: undoing that undo means reversing
    // this one, not the removal the entry remembered before it.
    redoFinished(entry, { retraction: removed.retraction })
    // A strip reopened on the restored point belongs to a row this redo has just taken away.
    endEditFor(entry.id)
    var active = await rebuildTab()
    setStatus('ok', copyStatus.removed({ active: active === null ? removed.active : active }))
  } catch (error) {
    redoFailed(entry, error)
    setStatus('error', refusal(error && error.message), (error && error.problems) || [])
  } finally {
    state.busy = false
    renderEntry()
  }
}

/**
 * Undo a correction: write the values the point held before it back into the log as another
 * correction. Nothing is rewritten and no event is withdrawn; the newest number is the earlier one,
 * and the correction that was undone stays in the record of what the point has held.
 */
async function undoCorrection(entry) {
  if (!state.view) return
  state.busy = true
  renderEntry()
  try {
    var corrected = await call(
      bridge.correctPoint(state.project.dir, entry.id, entry.before, state.view.name),
    )
    undoFinished(entry)
    state.correction = null
    state.selection = null
    state.timing = null
    state.busy = false
    state.opened = corrected.view
    state.view = corrected.view.view
    renderTabs()
    renderView(captureRestore())
    focusFirstField()
    setStatus(
      'ok',
      copyStatus.correctionUndone({
        active: corrected.active,
        stalePanels: corrected.view.kept.length,
      }),
    )
  } catch (error) {
    // A point another writer has withdrawn, or a shape that no longer accepts the old values, is not
    // undoable by this button: drop the act rather than leave a control that can only refuse.
    undoFailed(entry, error)
    setStatus(
      'error',
      refusal((error && error.message) || 'the core refused the correction'),
      (error && error.problems) || ((error && error.hint) ? [refusal(error.hint)] : []),
    )
  } finally {
    state.busy = false
    renderEntry()
  }
}

/** Redo a correction: write the values it had changed to back into the log as a correction again. */
async function redoCorrection(entry) {
  if (!state.view) return
  state.busy = true
  renderEntry()
  try {
    var corrected = await call(
      bridge.correctPoint(state.project.dir, entry.id, entry.after, state.view.name),
    )
    redoFinished(entry)
    state.correction = null
    state.selection = null
    state.timing = null
    state.busy = false
    state.opened = corrected.view
    state.view = corrected.view.view
    renderTabs()
    renderView(captureRestore())
    focusFirstField()
    setStatus(
      'ok',
      copyStatus.corrected({
        active: corrected.active,
        stalePanels: corrected.view.kept.length,
      }),
    )
  } catch (error) {
    redoFailed(entry, error)
    setStatus(
      'error',
      refusal((error && error.message) || 'the core refused the correction'),
      (error && error.problems) || [],
    )
  } finally {
    state.busy = false
    renderEntry()
  }
}

/**
 * Redo of undoing an added point: the same record comes back, because this is a restore naming the
 * retraction the undo wrote. The next undo therefore withdraws it again, exactly as it did before.
 */
async function redoPoint(entry) {
  if (!entry.retraction) return
  state.busy = true
  renderEntry()
  try {
    var restored = await call(bridge.restorePoint(state.project.dir, entry.id, entry.retraction))
    redoFinished(entry, { retraction: null })
    state.timing = null
    var active = await rebuildTab()
    setStatus('ok', copyStatus.restored({ active: active === null ? restored.active : active }))
  } catch (error) {
    redoFailed(entry, error)
    setStatus('error', refusal(error && error.message), (error && error.problems) || [])
  } finally {
    state.busy = false
    renderEntry()
  }
}

/**
 * Undo an import: the version it replaced becomes current again, as a *new* version. The rows come
 * back through retraction, restore and correction events, so nothing is deleted and every version
 * already in the log still reads as it did.
 */
async function undoImport(entry) {
  return applyImportVersion(entry, entry.restored, 'undo')
}

/** Redo an import: the version it wrote becomes current again, again as a new version. */
async function redoImport(entry) {
  return applyImportVersion(entry, entry.version, 'redo')
}

async function applyImportVersion(entry, version, direction) {
  state.busy = true
  renderEntry()
  try {
    var restored = await call(
      bridge.restoreVersion(
        state.project.dir,
        entry.dataset,
        version,
        state.view ? state.view.name : undefined,
      ),
    )
    if (direction === 'undo') undoFinished(entry)
    else redoFinished(entry)
    state.correction = null
    state.selection = null
    state.timing = null
    state.busy = false
    if (restored.view) {
      state.opened = restored.view
      state.view = restored.view.view
      if (state.projectEntry && restored.view.entry) state.projectEntry.active = restored.view.entry.active
      renderTabs()
      renderView(captureRestore())
    } else {
      if (state.projectEntry) state.projectEntry.active = restored.active
      renderEntry()
    }
    state.datasets.forEach(function (dataset) {
      if (dataset.id === restored.dataset) dataset.active = restored.active
    })
    focusFirstField()
    setStatus(
      'ok',
      direction === 'undo'
        ? copyStatus.importUndone({ active: restored.active })
        : copyStatus.importReapplied({ active: restored.active }),
    )
  } catch (error) {
    if (direction === 'undo') undoFailed(entry, error)
    else redoFailed(entry, error)
    setStatus(
      'error',
      refusal((error && error.message) || 'the core refused the restore'),
      (error && error.problems) || ((error && error.hint) ? [refusal(error.hint)] : []),
    )
  } finally {
    state.busy = false
    renderEntry()
  }
}

/** Ctrl+Z: take the next act from the history and carry it out. */
export function undoLastAction() {
  if (state.busy) return
  var entry = takeUndo()
  if (entry === null) return
  // The stack only ever holds acts this table describes; an unknown kind is not guessed at, because
  // guessing would retract a point the entry never named.
  if (ACTS[entry.kind] === undefined) return
  return ACTS[entry.kind].undo.run(entry)
}

/** Ctrl+Shift+Z / Ctrl+Y, and the status's own button after an undo. */
export function redoLastAction() {
  if (state.busy) return
  var entry = takeRedo()
  if (entry === null) return
  if (ACTS[entry.kind] === undefined) return
  return ACTS[entry.kind].redo.run(entry)
}

/**
 * What the next act in a direction is, for the two controls that show it: the bar's undo button and
 * the status's redo button. `idle` means there is nothing in that stack, so the button is disabled
 * rather than promising an act that would not happen.
 */
export function actOffer(direction) {
  var next = direction === 'undo' ? nextUndo() : nextRedo()
  var words = wordsFor(next, direction)
  return {
    label: words.label,
    title: words.title,
    run: direction === 'undo' ? undoLastAction : redoLastAction,
    idle: next === null,
  }
}

/**
 * The act table's own controls: the bar's undo button, and Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y wherever
 * the keyboard is.
 *
 * The bar and the drawing each have a listener because a text field keeps its own undo: a half-typed
 * number is work, and stealing its Ctrl+Z would throw the work away. So both steps aside for any
 * field that has something in it, and the bar's listener steps aside for the drawing's.
 */
export function wireActs() {
  ui.entryUndo.addEventListener('click', undoLastAction)
  ui.entry.addEventListener('keydown', shortcut)
  // The same shortcuts with the cursor on the drawing rather than in the bar.
  document.addEventListener('keydown', function (event) {
    var target = event.target
    if (ui.entry.contains(target)) return
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
      return
    }
    shortcut(event)
  })
}

function shortcut(event) {
  if (!event.ctrlKey && !event.metaKey) return
  var key = event.key.toLowerCase()
  if (key !== 'z' && key !== 'y') return
  if (entryHasText()) return
  event.preventDefault()
  if (key === 'y' || event.shiftKey) redoLastAction()
  else undoLastAction()
}
