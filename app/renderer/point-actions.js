/*
 * What the bar and a point's menu write: add a point, remove one, copy one's details, and the tab
 * catching up after a write. Each is one call to the core and then the screen saying what happened.
 *
 * The acts that reverse these are `acts.js`'s; this file is the forward direction only. A removal
 * joins the tab's history as it happens (`history.js`), so the bar's undo reverses the newest act
 * whoever made it.
 */
import { state, ui, bridge, call } from './state.js'
import { copiedDetails, panelEvidence, panelFacts, refusal, status as copyStatus } from './copy.js'
import { entryInputs, fieldValueMap, focusFirstField, markProblems } from './fields.js'
import { setStatus } from './status.js'
import { renderEntry } from './entry.js'
import { closeCorrection, selectPoint, submitCorrection } from './correction.js'
import { renderTabs } from './rail.js'
import {
  captureRestore,
  rebuildTab,
  renderMeta,
  renderPanelLabels,
  renderStatuses,
  renderView,
} from './panels.js'
import { appendedId, noteAppend, noteRemoval } from './history.js'

/**
 * Type one point. The write is the core's; what is left here is where the new mark lands, what the
 * bar and the status say, and — after the paint, never before it — the tab file catching up.
 */
export async function submitEntry(event) {
  event.preventDefault()
  var entry = (state.opened && state.opened.entry) || state.projectEntry
  if (state.busy || !entry) return
  if (state.correction !== null) return submitCorrection()
  var values = fieldValueMap()
  var startedAt = performance.now()
  state.busy = true
  renderEntry()

  try {
    var recorded = await call(
      bridge.recordPoint(
        state.project.dir,
        { dataset: entry.dataset, values: values },
        state.view ? state.view.name : undefined,
      ),
    )
    var afterRecord = performance.now()
    noteAppend(recorded.id)

    var afterRebuild
    // With no tab open there is no drawing to patch: the point landed, and the bar's own count is
    // the only thing on screen that has to catch up.
    if (!state.view) {
      if (state.projectEntry) state.projectEntry.active = recorded.active
      afterRebuild = performance.now()
    } else if (recorded.redraw || recorded.reread) {
      // A point that moves the axes, a panel that cannot be patched, or a log another writer grew
      // while this window was idle: in every case the drawing on screen was made from a state the
      // log has moved past, and patching one mark onto it would mark it current while it lies.
      // The tab file is derived state and is not on the keystroke path (ADR 0006): the drawing is
      // rebuilt here, and `catchUp` writes the view once the frame is on screen.
      var refreshed = await call(
        bridge.refreshView(state.project.dir, state.view.name, { draw: true, persist: false }),
      )
      afterRebuild = performance.now()
      state.opened = refreshed
      state.view = refreshed.view
      state.deferredPersist = true
      renderTabs()
      renderView(captureRestore())
    } else {
      applyMarks(recorded.marks, recorded.active)
      afterRebuild = performance.now()
    }
    state.busy = false

    // Clear for the next point, but only after the write was accepted: a refusal must leave the
    // typo exactly where it was typed.
    entryInputs().forEach(function (input) {
      input.value = ''
    })
    focusFirstField()

    setStatus(
      'ok',
      copyStatus.saved({
        active: recorded.active,
        warnings: recorded.warnings,
        reread: recorded.reread,
      }),
    )

    // Enter → painted frame, not Enter → DOM updated: two frames put the measurement after the
    // paint that shows the new mark. The same figure is what the bar displays.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        var painted = performance.now()
        state.timing = Math.round(painted - startedAt)
        window.__benchTiming = {
          id: recorded.id,
          dataset: recorded.dataset,
          total: painted - startedAt,
          record: afterRecord - startedAt,
          rebuild: afterRebuild - afterRecord,
          paint: painted - afterRebuild,
          incremental: !recorded.redraw && !recorded.reread,
          marks: recorded.marks.length,
          untouched: recorded.untouched.length,
          commit: null,
        }
        renderEntry()
      })
    })

    // The tab's saved file catches up after the paint. It is derived state — the log is the truth
    // and it was already written — so a keystroke does not wait for two megabytes of JSON to hit
    // the disk. It also cannot be forgotten: `catchUp` marks the badge and the strip, and a
    // failure to save is shown rather than swallowed.
    catchUp()
  } catch (error) {
    var problems = (error && error.problems) || []
    var firstInvalid = markProblems(problems)
    setStatus(
      'error',
      refusal(error && error.message),
      problems.length > 0 ? problems : error && error.hint ? [error.hint] : [],
    )
    if (firstInvalid) firstInvalid.focus()
    state.timing = null
  } finally {
    state.busy = false
    renderEntry()
  }
}

/**
 * Put the marks the core just produced onto the drawing that is already on screen. The handle owns
 * the canvas and the hit-testing, so one call draws the mark and makes it reachable; nothing else
 * in the drawing is touched, so no other coordinate can drift.
 */
export function applyMarks(marks, active) {
  marks.forEach(function (mark) {
    var handle = state.handles[mark.index]
    if (handle && handle.addMark) {
      // mark.x/y are already on this panel's axes; the raw typed values need not contain x or y.
      handle.addMark(mark.id, mark.cx, mark.cy, { id: mark.id, x: mark.x, y: mark.y })
    }
    var panel = state.view && state.view.panels[mark.index]
    if (panel && typeof panel.n === 'number') panel.n += 1
    var figure = ui.grid.children[mark.index]
    var facts = figure && figure.querySelector('.panel-facts')
    if (facts && panel) facts.textContent = panelFacts(panel)
  })
  if (state.opened && state.opened.entry) state.opened.entry.active = active
  renderMeta()
  renderPanelLabels()
}

/**
 * The tab's own bookkeeping, after the paint: rebuild the stored spec, save the file, recompute
 * staleness. Anything that fails here is said out loud — a tab whose file quietly stopped matching
 * its drawing is worse than a tab that says it could not save.
 */
export async function catchUp() {
  var viewName = state.view ? state.view.name : null
  if (!viewName) return
  var startedAt = performance.now()
  try {
    if (state.deferredPersist) {
      state.deferredPersist = false
      var persisted = await call(bridge.persistView(state.project.dir, viewName))
      if (persisted.reread) {
        var again = await call(bridge.refreshView(state.project.dir, viewName, { draw: true }))
        state.opened = again
        state.view = again.view
        renderTabs()
        renderView(captureRestore())
        setStatus('error', copyStatus.rereadAfterWrite())
        return
      }
      if (persisted.saved === false) {
        setStatus(
          'error',
          copyStatus.couldNotSave('its rebuilt drawing was no longer waiting. Reopen the tab to rebuild it.'),
        )
        return
      }
      if (window.__benchTiming && window.__benchTiming.id === appendedId()) {
        window.__benchTiming.commit = performance.now() - startedAt
      }
      return
    }
    var settled = await call(bridge.refreshView(state.project.dir, viewName, { draw: false }))
    if (settled.reread) {
      // Another writer grew the log between the paint and this catch-up. Saving the tab now would
      // fingerprint the new log against a drawing made from the old one, so redraw instead: the
      // tab is the thing on screen, and it has to be the thing the file describes.
      settled = await call(bridge.refreshView(state.project.dir, viewName, { draw: true }))
      state.opened = settled
      state.view = settled.view
      renderTabs()
      renderView(captureRestore())
      setStatus('error', copyStatus.rereadAfterWrite())
      return
    }
    state.opened = settled
    state.view = settled.view
    settled.counts.forEach(function (count, index) {
      var panel = state.view.panels[index]
      if (panel) panel.n = count
      var figure = ui.grid.children[index]
      if (!figure || !panel) return
      var facts = figure.querySelector('.panel-facts')
      if (facts) facts.textContent = panelFacts(panel)
      // The evidence is the window's DOM, not the drawing: take the core's new numbers, update the
      // line the copy owner composes, and leave the SVG alone.
      var evidence = settled.evidence[index]
      if (panel && evidence) panel.chart.evidence = evidence
      var line = figure.querySelector('.panel-evidence .evidence-text')
      if (line && panel) line.textContent = panelEvidence(panel)
    })
    renderMeta()
    renderStatuses(settled.statuses)
    if (window.__benchTiming && window.__benchTiming.id === appendedId()) {
      window.__benchTiming.commit = performance.now() - startedAt
    }
  } catch (error) {
    setStatus('error', copyStatus.couldNotSave(refusal((error && error.message) || String(error))))
  }
}

/**
 * One of the point menu's three verbs. The menu itself is the drawing's (chart.js); what each choice
 * does to the project lives here, with every other write the window can make.
 */
export function pointAction(action, id, index) {
  if (!id) return
  if (action === 'copy') return copyPointDetails(id)
  if (action === 'correct') return selectPoint(id, index)
  if (action === 'remove') return removePoint(id)
}

/**
 * Put a point's details on the clipboard as one readable line. The line is composed by `copy.js`
 * and carries the record id last: it is the only log vocabulary a person ever copies on purpose,
 * and the reason they copy it is to name the point to an agent.
 */
async function copyPointDetails(id) {
  if (state.busy || !state.view) return
  state.busy = true
  renderEntry()
  try {
    var detail = await call(bridge.point(state.project.dir, id, state.view.name))
    var text = copiedDetails(detail)
    if (text === '') throw new Error('there is nothing to copy for that point')
    await call(bridge.copyText(text))
    setStatus('ok', copyStatus.copied())
  } catch (error) {
    setStatus('error', refusal(error && error.message), (error && error.problems) || [])
  } finally {
    state.busy = false
    renderEntry()
  }
}

/**
 * **Remove** from a point's menu: one action, no reason, no narration (U6). The log still records
 * that the record was withdrawn — the window simply does not ask the person to justify a typo. The
 * removal joins the tab's undo history, so the next Ctrl+Z brings this point back rather than some
 * earlier one.
 */
export async function removePoint(id) {
  // A write is in flight and the menu is already closed: saying so is the only honest answer. A
  // silent return would look like a click that did nothing.
  if (state.busy) {
    setStatus('ok', copyStatus.stillSaving())
    return
  }
  if (!state.view) return
  state.busy = true
  renderEntry()
  try {
    var removed = await call(bridge.retractPoint(state.project.dir, id))
    noteRemoval(id, removed.retraction)
    state.correction = null
    state.selection = null
    state.timing = null
    var active = await rebuildTab()
    // The bar's undo is the affordance; the status says what happened. Two buttons for one act is the
    // duplicate this replaced.
    setStatus('ok', copyStatus.removed({ active: active === null ? removed.active : active }))
  } catch (error) {
    setStatus('error', refusal(error && error.message), (error && error.problems) || [])
  } finally {
    state.busy = false
    renderEntry()
  }
}

/** The bar's own controls: the form's submit, Cancel, and Escape while a record is being edited. */
export function wireEntry() {
  ui.entry.addEventListener('submit', submitEntry)
  ui.entryCancel.addEventListener('click', closeCorrection)
  ui.entry.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape' || state.correction === null) return
    event.preventDefault()
    closeCorrection()
  })
}
