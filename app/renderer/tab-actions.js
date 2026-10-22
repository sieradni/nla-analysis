/*
 * The open tab's lifecycle, and every act on a tab.
 *
 * Opening a tab, closing it, putting a closed one back, renaming it, copying it — and the menu in
 * the rail that reaches those acts. This module owns them together because they share one thing the
 * drawing does not: the file a tab is. `app.js` keeps the project and the window; this keeps the tab.
 *
 * Closing does not delete. The core moves the tab's file to the project's trash and hands back the
 * archive, which is also what a reopen moves home, so the tab that comes back is the file that left.
 * The archive and the tab's own acts wait in `closed-tabs.js`, outside `state.showView` — a close
 * must survive a tab switch, and switching is what clears the tab's history.
 */
import { state, bridge, call, showView, showEmpty, showFailure } from './state.js'
import { empty as emptyCopy, labels as copyLabels, refusal, status as copyStatus, tabMenu } from './copy.js'
import { renderTabs } from './rail.js'
import { renderView, watchOpenTab } from './panels.js'
import { renderEntry } from './entry.js'
import { clearStatus, setStatus } from './status.js'
import { focusFirstField } from './fields.js'
import { noteClosed, putBackClosed, setClosedTabs, takeClosed, takeClosedFile } from './closed-tabs.js'
import {
  keepTabRedo,
  keepTabUndo,
  noteTabCreated,
  permanentRefusal,
  restoreTabHistory,
  snapshotTabHistory,
} from './history.js'
import { openMenu } from './menu.js'
import { actions } from './navigation.js'

/** Open a tab by name, and put the drawing, the rail and the cursor where that leaves them. */
export async function openView(name) {
  try {
    // Undo is the tab's, not the window's: another tab's history would offer to act on a point this
    // drawing never showed. `showView` clears it with the drawing, one call.
    showView(await call(bridge.view(state.project.dir, name)))
    clearStatus()
    state.timing = null
    // A new tab may ask for different fields; rebuild them rather than painting one shape's inputs
    // over another's. Rebuilding also clears anything half-typed, which is the right default when
    // the target changed underneath it.
    state.entryKey = null
    renderTabs()
    renderView()
    if (state.opened.reread) setStatus('ok', copyStatus.rereadTab())
    // The product is typing a number. Opening a tab puts the cursor where that happens; Tab still
    // reaches the panel for keyboard pan and zoom.
    focusFirstField()
  } catch (error) {
    showView(null)
    renderTabs()
    showFailure('Could not open “' + name + '”', error)
  }
}

/** The empty stage for a project with no tabs left: one sentence and the one way to make another. */
export function showNoTabs() {
  var next = state.projectEntry && state.projectEntry.nextTab
  showEmpty('No saved tabs', emptyCopy.noTabs(next && next.problem), null, {
    label: 'Create a tab…',
    run: actions.openTabDialog,
  })
}

/**
 * Close one tab by name, whether or not it is the one on screen.
 *
 * The tab's file leaves the rail and waits in the project's trash, with its acts when it was the
 * drawing that closed. A background tab changes only the rail; the tab on screen changes the drawing,
 * so the window moves to the tab beside it and says what happened. Nothing reaches the log: a view is
 * a saved question, and the points it draws are untouched.
 *
 * `reopen: false` is for a caller that has its own way back: undoing the creation of a tab is a
 * close, but the way back is the history's redo, and offering a second button for the same act would
 * put two controls on one restoration.
 */
export async function closeTab(name, options) {
  // The header's button closes the tab on screen; a menu row closes the tab it names. Neither can
  // name a tab when nothing is open, which is the empty stage's own state.
  if (!state.project || state.busy || !name) return null
  var open = state.view !== null && state.view.name === name
  var index = state.views.findIndex(function (view) {
    return view.name === name
  })
  state.busy = true
  renderEntry()
  try {
    var archived = await call(bridge.closeView(state.project.dir, name))
    // Taken before the drawing changes: `showView` clears the stacks as part of changing it, and a
    // background tab has no drawing here to take a history from.
    noteClosed(archived, open ? snapshotTabHistory() : null)
    var listed = await call(bridge.views(state.project.dir))
    state.views = listed.views
    // The bar outlives the tab: with none left it types into the project, and its count is the
    // data's, not the one from when the project was opened.
    if (listed.entry) state.projectEntry = listed.entry
    if (open) {
      state.correction = null
      state.selection = null
      state.entryKey = null
      state.timing = null
      // A redraw of the closed tab may still have been waiting to save its file. That drawing left
      // with the tab, so the next tab must not inherit the deferral and report a save it did not make.
      state.deferredPersist = false
      var next = index === -1 ? null : listed.views[Math.min(index, listed.views.length - 1)]
      if (next) {
        await openView(next.name)
        focusFirstField()
      } else {
        showView(null)
        renderTabs()
        showNoTabs()
        renderEntry()
        focusFirstField()
      }
      // The tab that was watched is gone, and the main process stopped watching it before it closed.
      // Arming again says which tab is on screen now — including none, which leaves nothing watching.
      watchOpenTab()
    } else {
      renderTabs()
    }
    var reopenedBy = options && options.reopen === false
      ? null
      : {
          label: copyLabels.undoTabClose,
          title: copyLabels.undoTabCloseTitle,
          run: reopenClosedTab,
        }
    setStatus('ok', copyStatus.closedTab({ name: archived.name }), [], reopenedBy)
    return archived
  } catch (error) {
    // The main process stopped watching the tab it was about to close. If this tab is still open, the
    // watcher has to be armed again — otherwise the first sign of another writer would be a surprise.
    if (open) {
      state.watching = null
      watchOpenTab()
    }
    setStatus('error', refusal((error && error.message) || 'the tab could not be closed'))
    return null
  } finally {
    state.busy = false
    renderEntry()
  }
}

/**
 * Put the last closed tab back.
 *
 * The archive the close left in the project's trash is moved home, and the core describes it like any
 * other tab, so a reopened tab is drawn by the same path as an opening one. Its history comes back
 * with it when this window was the one that closed it: those acts are what the person would undo
 * next, and they are put back here rather than re-derived from the log, because closing a tab is a
 * window act the log never heard about. A tab closed before this window opened has no acts to come
 * back — the bar says so, and the drawing is still the one that closed.
 *
 * An empty list does nothing at all: there is no act to refuse, and a sentence saying so would be
 * noise from a shortcut the person may have pressed by habit.
 */
export async function reopenClosedTab() {
  if (!state.project || state.busy) return
  var taken = takeClosed()
  if (taken === null) return
  await openArchive(taken)
}

/**
 * Move one archive home and draw it. `taken` is the archive and the acts it held, from whichever
 * stack asked for it — the closed-tab list, or a redo naming the file an undo left behind.
 */
async function openArchive(taken) {
  var name = taken.entry.name
  state.busy = true
  renderEntry()
  try {
    var opened = await call(bridge.restoreClosedView(state.project.dir, taken.entry.file))
    // The drawing changes, so the stacks are cleared — and the tab's own acts are put back after, in
    // the order `showView` reads them: the drawing first, then the history that belongs to it.
    showView(opened)
    restoreTabHistory(taken.history)
    var listed = await call(bridge.views(state.project.dir))
    state.views = listed.views
    if (listed.entry) state.projectEntry = listed.entry
    clearStatus()
    state.timing = null
    state.entryKey = null
    renderTabs()
    renderView()
    focusFirstField()
    // An archive this window did not close comes back without the acts that made it, and an empty
    // bar is indistinguishable from a tab nothing has been done in — so the reopen says which it is
    // (U30). A close in this window carried its stacks, and its sentence is unchanged.
    setStatus(
      'ok',
      copyStatus.reopenedTab({ name: name, historyLost: taken.historyLost === true }),
    )
    return opened
  } catch (error) {
    // A tab that can never come back leaves the list: a control that can only refuse is worse than
    // none. A temporary failure — a locked file — keeps it, with its acts, for the next press.
    if (!permanentRefusal(error)) putBackClosed(taken)
    setStatus('error', refusal((error && error.message) || 'the tab could not be reopened'))
    return null
  } finally {
    state.busy = false
    renderEntry()
  }
}

/**
 * Fill the closed-tab list from the project's own trash, so a fresh window can still put back what an
 * earlier one closed. A trash that cannot be read empties the list rather than refusing the project:
 * it is disposable state, and no tab on screen depends on it.
 */
export async function loadClosedTabs(dir) {
  try {
    var listed = await call(bridge.closedViews(dir))
    setClosedTabs(listed.closed)
  } catch (error) {
    setClosedTabs([])
  }
}

/**
 * Rename a tab.
 *
 * The file is the tab and its name is part of the file, so the core writes the tab under the new name
 * and takes the old file away. This is not a change of drawing: the same panels describe the same
 * data, so the tab's own acts stay where they are and only the rail, the header and the watcher learn
 * the new name. A rename of a background tab touches the rail alone.
 */
export async function renameTab(from, to, report) {
  if (!state.project || state.busy) return null
  var open = state.view !== null && state.view.name === from
  state.busy = true
  renderEntry()
  try {
    var opened = await call(bridge.renameView(state.project.dir, from, to))
    var listed = await call(bridge.views(state.project.dir))
    state.views = listed.views
    if (listed.entry) state.projectEntry = listed.entry
    if (open) {
      // The drawing and its history are the same drawing; only the name moved.
      state.opened = opened
      state.view = opened.view
      renderTabs()
      renderView()
      // The watched file is the new one, so the main process has to be told the old registration is
      // over. `watchOpenTab` compares names and re-arms on the difference.
      watchOpenTab()
    } else {
      renderTabs()
    }
    setStatus('ok', copyStatus.renamedTab({ from: from, name: opened.view.name }))
    return opened
  } catch (error) {
    // A sheet is where the name was typed, so a refusal it caused is said there; a call from anywhere
    // else says it in the status line like every other failure.
    if (report) report(error)
    else setStatus('error', refusal((error && error.message) || 'the tab could not be renamed'))
    return null
  } finally {
    state.busy = false
    renderEntry()
  }
}

/**
 * Copy a tab, and open the copy.
 *
 * A panel names no tab, so the copy is the same panels under a new name — a tab of its own from that
 * moment. It is a tab coming into being, which is the act the fifth kind of history remembers: the
 * copy opens here, so undo can close it and redo can put it back.
 */
export async function duplicateTab(from, to, report) {
  if (!state.project || state.busy) return null
  state.busy = true
  renderEntry()
  try {
    var opened = await call(bridge.duplicateView(state.project.dir, from, to))
    var listed = await call(bridge.views(state.project.dir))
    state.views = listed.views
    if (listed.entry) state.projectEntry = listed.entry
    state.correction = null
    state.selection = null
    showView(opened)
    // After `showView`, so the entry lands in the copy's own stack: it is the first act of that tab.
    noteTabCreated(opened.view.name)
    state.entryKey = null
    state.timing = null
    renderTabs()
    renderView()
    focusFirstField()
    setStatus('ok', copyStatus.duplicatedTab({ from: from, name: opened.view.name }))
    return opened
  } catch (error) {
    if (report) report(error)
    else setStatus('error', refusal((error && error.message) || 'the tab could not be copied'))
    return null
  } finally {
    state.busy = false
    renderEntry()
  }
}

/**
 * Undo creating a tab: close the one this window made, through the close path, so its file waits in
 * the project's trash and its acts wait with it. The redo is the archive that close left behind, and
 * it is installed after the drawing changed, because the change cleared the stacks.
 */
export async function undoTabCreated(entry) {
  var archived = await closeTab(entry.name, { reopen: false })
  if (archived === null) return
  keepTabRedo({ kind: 'tab', name: entry.name, file: archived.file })
  renderEntry()
}

/** Redo creating a tab: the archive comes home as the tab it was, with the acts it held. */
export async function redoTabCreated(entry) {
  if (!state.project || state.busy || !entry.file) return
  var taken = takeClosedFile(entry.file)
  var opened = await openArchive(taken || { entry: { file: entry.file, name: entry.name }, history: null })
  if (opened === null) return
  // The restored tab's acts are back; the tab's own creation is the oldest of them.
  keepTabUndo({ kind: 'tab', name: opened.view.name, file: null })
  renderEntry()
}

// --- the menu on a tab's row ---------------------------------------------------------------

/**
 * The menu for one tab, under the button that asked for it. The popover — placement, keys,
 * dismissal, `aria-expanded` on the trigger — is `menu.js`'s; this says which three acts there are
 * and which tab they are about. Rename and Duplicate ask for a name first, which is the tab sheet's
 * job; this module only knows which act was chosen.
 */
function openTabMenu(trigger, name) {
  if (!state.project) return
  openMenu({
    label: tabMenu.label,
    under: trigger,
    items: [
      ['rename', tabMenu.rename],
      ['duplicate', tabMenu.duplicate],
      ['close', tabMenu.close],
    ],
    onChoose: function (action) {
      if (action === 'close') closeTab(name)
      else actions.openNameSheet(action, name)
    },
  })
}

actions.tabMenu = openTabMenu
actions.closeTab = closeTab
actions.undoTabCreated = undoTabCreated
actions.redoTabCreated = redoTabCreated
