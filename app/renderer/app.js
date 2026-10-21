/*
 * The window shell: which project is open, and what happens when it changes.
 *
 * Everything it displays comes from the core through `window.bench`. It formats nothing itself:
 * `copy.js` owns every word, `panels.js` draws it, `entry.js` owns typing, `history.js` owns what
 * undo would reverse, `rail.js` owns the left side, and `tab-actions.js` owns the open tab's own
 * lifecycle — which tab is showing, closing one, putting it back, renaming and copying it. This file
 * is the wiring, the project, and the boot.
 */
import { state, ui, bridge, call, showFailure, showEmpty, showView } from './state.js'
import {
  closeOpenTab,
  loadClosedTabs,
  openView,
  reopenClosedTab,
  showNoTabs,
} from './tab-actions.js'
import { renderProjects, renderTabs, renderFoot } from './rail.js'
import { renderView, watchOpenTab, captureRestore } from './panels.js'
import { applyStatic, builtInShape, empty as emptyCopy, refusal, status as copyStatus } from './copy.js'
import {
  renderEntry,
  setStatus,
  focusFirstField,
  selectPoint,
  pointAction,
  wireEntry,
} from './entry.js'
import { openTabDialog, wireTabs } from './tabs.js'
import { openProject, openProjectDialog, wireProjects } from './projects.js'
import { wireImport } from './import.js'
import { actions } from './navigation.js'

actions.openProject = openProject
actions.openView = openView
actions.afterOpen = afterOpen
actions.openTabDialog = openTabDialog
actions.openProjectDialog = openProjectDialog
actions.renderEntry = renderEntry
actions.selectPoint = selectPoint
actions.pointAction = pointAction
actions.setStatus = setStatus

/**
 * Rebuild the panels a write has invalidated, because the notice's only action is a button. The
 * core decides which panels it can redraw without Python; anything it keeps stays visibly out of
 * date rather than being claimed as current.
 */
actions.refreshTab = async function () {
  if (!state.view || state.busy) return
  var restore = captureRestore()
  try {
    var refreshed = await call(bridge.refreshView(state.project.dir, state.view.name, { draw: true }))
    state.opened = refreshed
    state.view = refreshed.view
    renderTabs()
    renderView(restore)
    setStatus('ok', copyStatus.refreshed(refreshed.statuses))
  } catch (error) {
    setStatus('error', copyStatus.refreshFailed((error && error.message) || String(error)))
  }
}

var settled = false

export async function afterOpen(opened) {
  state.project = { dir: opened.dir, name: opened.name }
  state.views = opened.views
  state.datasets = opened.datasets || []
  state.projectEntry = opened.entry || null
  // A removal belongs to the tab it happened in; another project's history would offer to undo an
  // act on a record that is not on screen.
  showView(null)
  // A closed tab belongs to the project it was closed in, so opening a project refills the list from
  // that project's own trash: the window inherits what an earlier one closed, and never offers
  // another project's tab in this one.
  await loadClosedTabs(opened.dir)
  state.entryKey = null
  state.timing = null
  state.status = null
  ui.notice.hidden = true
  // A new project means the old tab is no longer on screen; disarm before the first tab arms.
  watchOpenTab()

  try {
    var listed = await call(bridge.projects())
    state.projects = listed.projects
    state.problem = listed.problem || null
  } catch (error) {
    /* the registry is a convenience; the project is open either way */
  }
  renderProjects()
  renderTabs()
  renderFoot()

  if (opened.views.length > 0) {
    await openView(opened.views[0].name)
    return
  }

  // The core derived this from the declared shape: a custom project is not taught a recipe or
  // `x`/`y` it does not have, and a shape that cannot plot says what to add instead. The empty stage
  // names the project in the header itself.
  showNoTabs()
  // A project with no tabs can still take a point: the empty state hid the bar, so put it back and
  // leave the cursor where typing goes.
  renderEntry()
  focusFirstField()
}

/**
 * A watched change, pushed by the main process: the files behind the open tab moved, and this is
 * what the tab says now. A redraw is always a whole tab (ADR 0007) — never a patch of a stale
 * drawing. The bar is not part of the drawing, so its half-typed text and cursor stay put.
 */
export function applyChange(change) {
  if (!state.project || change.dir !== state.project.dir) return
  // A write is in flight: its own response is about to draw the state after that write, and the
  // main process asks again once the call settles. Repainting underneath it would race both.    if (state.busy) return

  if (change.state === 'error') {
    setStatus('error', copyStatus.couldNotReread(change.message))
    return
  }

  state.views = change.views
  if (change.state === 'gone') {
    // The tab this was about is not necessarily the tab on screen any more.
    if (state.view && state.view.name !== change.name) {
      renderTabs()
      return
    }
    var hadFocus = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.field : null
    // A correction belongs to the tab that was on screen; with no tab there is nowhere to save it.
    state.correction = null
    state.selection = null
    // The tab's history goes with the tab: there is no drawing for it to act on.
    showView(null)
    if (change.entry) state.projectEntry = change.entry
    watchOpenTab()
    renderTabs()
    showEmpty('This tab was removed', emptyCopy.tabRemoved(change.name), null, {
      label: 'Create a tab…',
      run: openTabDialog,
    })
    // The empty state hid the bar; the project can still take a point, and a field that was being
    // typed into gets its cursor back.
    renderEntry()
    if (hadFocus) {
      var input = ui.entryFields.querySelector('input[data-field="' + hadFocus + '"]')
      if (input) input.focus()
    }
    setStatus('ok', copyStatus.tabRemoved({ name: change.name, remaining: change.views.length }))
    return
  }

  // A tab created by another writer can change the rail without changing what is on screen.
  if (!state.view || state.view.name !== change.view.view.name) {
    renderTabs()
    return
  }
  // Another writer moved the project. A removal this window remembers may have been undone or
  // repeated by that writer, and the drawing cannot say which: the act the button would reverse is
  // no longer known, so `showView` forgets the history with the drawing, rather than leaving an
  // undo that can only refuse. The status already says the project changed on disk.
  showView(change.view)
  if (state.projectEntry && change.view.entry) state.projectEntry.active = change.view.entry.active
  renderTabs()
  renderView(captureRestore())
  // A refusal the user is reading is not replaced by good news about a redraw.
  if (!state.status || state.status.kind !== 'error') {
    setStatus(
      'ok',
      copyStatus.tabChanged({
        name: state.view.name,
        active: change.view.entry ? change.view.entry.active : undefined,
      }),
    )
  }
}

export function wire() {
  wireProjects()
  wireTabs()
  wireImport()
  wireEntry()
  ui.closeTab.addEventListener('click', closeOpenTab)
  // Ctrl+Shift+T reopens the last closed tab wherever the keyboard is, including inside a field: the
  // chord has no meaning to a text input, so unlike Ctrl+Z it is not deferred to the field it is in.
  // This listener sits on the document because that is the window's own key path — the entry bar's
  // handler steps aside for every key it does not own.
  document.addEventListener('keydown', function (event) {
    if (!(event.ctrlKey || event.metaKey) || !event.shiftKey) return
    if (event.key.toLowerCase() !== 't') return
    // A sheet is a question being answered: changing the stage under it would move the ground. The
    // chord waits until it is closed.
    if (document.querySelector('dialog[open]')) return
    event.preventDefault()
    reopenClosedTab()
  })
  ui.toggleMissing.addEventListener('click', function () {
    state.showMissing = !state.showMissing
    renderProjects()
  })
}

export async function boot() {
  applyStatic(ui)
  wire()
  if (!bridge) {
    showFailure('The window cannot reach the core', new Error('preload bridge missing'))
    return
  }
  if (bridge.onChanged) bridge.onChanged(applyChange)

  var startup = { projectDir: null }
  try {
    startup = await bridge.startup()
  } catch (error) {
    /* start without a hint */
  }
  // One cheap read, so the create dialog opens without waiting on the core. The shipped shape's
  // name and fields are the core's, so the option is labelled from here rather than hardcoded.
  try {
    state.shapeChoice = await call(bridge.shapeChoice())
    ui.projectShape.options[0].textContent = builtInShape(state.shapeChoice.fields)
  } catch (error) {
    /* the dialog still works; it just cannot name the shipped shape */
  }

  try {
    var listed = await call(bridge.projects())
    state.projects = listed.projects
    state.problem = listed.problem || null
    renderProjects()
    if (state.problem) {
      ui.notice.hidden = false
      ui.notice.textContent = copyStatus.projectListProblem(state.problem)
    }

    var target = startup.projectDir
    if (!target) {
      var first = state.projects.filter(function (project) {
        return project.exists
      })[0]
      target = first ? first.dir : null
    }

    if (target) await openProject(target)
    else {
      showEmpty('No projects yet', emptyCopy.noProjects(), null, {
        label: 'Create a project…',
        run: openProjectDialog,
      })
      renderFoot()
    }
  } catch (error) {
    showFailure('Could not read the project list', error)
  }

  if (!settled) {
    settled = true
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        bridge.ready()
      })
    })
  }
}

boot()
