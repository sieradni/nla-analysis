/*
 * The window shell: which project is open, which tab is showing, and what happens when either moves.
 *
 * Everything it displays comes from the core through `window.bench`. It formats nothing itself:
 * `copy.js` owns every word, `panels.js` draws it, `entry.js` owns typing, and `rail.js` owns the
 * left side. This file is the wiring and the open-view lifecycle, not a second renderer.
 */
import { state, ui, bridge, call, showFailure, showEmpty } from './state.js'
import { renderProjects, renderTabs, renderFoot } from './rail.js'
import { renderView, watchOpenTab, captureRestore } from './panels.js'
import { applyStatic, builtInShape, empty as emptyCopy, status as copyStatus } from './copy.js'
import {
  renderEntry,
  setStatus,
  focusFirstField,
  selectPoint,
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

export async function openView(name) {
  try {
    state.opened = await call(bridge.view(state.project.dir, name))
    state.view = state.opened.view
    state.status = null
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
    state.view = null
    renderTabs()
    showFailure('Could not open “' + name + '”', error)
  }
}

export async function afterOpen(opened) {
  state.project = { dir: opened.dir, name: opened.name }
  state.views = opened.views
  state.datasets = opened.datasets || []
  state.projectEntry = opened.entry || null
  state.view = null
  state.opened = null
  state.lastPoint = null
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

  ui.title.textContent = opened.name
  ui.crumb.textContent = opened.name
  ui.meta.textContent = ''
  // The core derived this from the declared shape: a custom project is not taught a recipe or
  // `x`/`y` it does not have, and a shape that cannot plot says what to add instead.
  var next = opened.entry && opened.entry.nextTab
  showEmpty('No saved tabs', emptyCopy.noTabs(next && next.problem), null, {
    label: 'Create a tab…',
    run: openTabDialog,
  })
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
    state.view = null
    state.opened = null
    // A correction belongs to the tab that was on screen; with no tab there is nowhere to save it.
    state.correction = null
    state.selection = null
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
  state.opened = change.view
  state.view = change.view.view
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
