/* The entry bar: type a point, correct a point, carry out the tab's undo and redo, and catch the
 * tab file up. The history those acts come from lives in `history.js`. */
import { state, ui, node, bridge, call } from './state.js'
import {
  copiedDetails,
  labels,
  panelEvidence,
  panelFacts,
  refusal,
  status as copyStatus,
} from './copy.js'
import {
  appendedId,
  nextUndo,
  noteAppend,
  noteRemoval,
  redoFailed,
  redoFinished,
  takeRedo,
  takeUndo,
  undoFailed,
  undoFinished,
} from './history.js'
import { renderTabs } from './rail.js'
import { renderView, captureRestore, renderMeta, renderStatuses, renderPanelLabels } from './panels.js'

/**
 * Typed text to a point value. The window does not get a second opinion about what a number is: a
 * value it cannot parse is passed through as text, and the shape's own validation refuses it with
 * the message the CLI would give. That is why the same typo reads the same in both places.
 */
export function coerceValue(field, text) {
  if (field.type === 'number' || field.type === 'integer') {
    var parsed = Number(text)
    return Number.isFinite(parsed) ? parsed : text
  }
  if (field.type === 'boolean') {
    if (text.toLowerCase() === 'true') return true
    if (text.toLowerCase() === 'false') return false
    return text
  }
  return text
}

export function entryInputs() {
  return Array.prototype.map.call(ui.entryFields.querySelectorAll('input'), function (input) {
    return input
  })
}

export function fieldValueMap() {
  var values = {}
  entryInputs().forEach(function (input) {
    var text = input.value.trim()
    if (text === '') return
    var field = { name: input.dataset.field, type: input.dataset.type }
    values[field.name] = coerceValue(field, text)
  })
  return values
}

export function buildEntryFields(entry, prefill, mode) {
  var key =
    (mode || 'add') +
    '|' +
    entry.dataset +
    '|' +
    entry.shape +
    '|' +
    entry.fields
      .map(function (field) {
        return field.name + ':' + field.type
      })
      .join(',')
  if (key === state.entryKey) return
  state.entryKey = key
  ui.entryFields.textContent = ''
  entry.fields.forEach(function (field) {
    var label = node('label', 'entry-field')
    label.appendChild(node('span', null, field.name))
    var input = document.createElement('input')
    input.type = 'text'
    input.autocomplete = 'off'
    input.spellcheck = false
    input.dataset.field = field.name
    input.dataset.type = field.type
    input.setAttribute('aria-label', field.name + ' · ' + field.type)
    if (field.type === 'number' || field.type === 'integer') input.setAttribute('inputmode', 'decimal')
    // A correction starts from the point's own values, so the common edit is one number changed.
    if (prefill && prefill[field.name] !== undefined && prefill[field.name] !== null) {
      input.value = String(prefill[field.name])
    }
    label.appendChild(input)
    ui.entryFields.appendChild(label)
  })
}

export function focusFirstField() {
  var inputs = entryInputs()
  // A field never takes the cursor from an open menu: a read that finishes behind the menu must not
  // move the keyboard out of the choice the person is making. The role, not the menu's own class,
  // is what this rule needs to know.
  var active = document.activeElement
  if (active && active.closest && active.closest('[role="menu"]')) return
  if (!ui.entry.hidden && inputs.length > 0) inputs[0].focus()
}

/** Mark the fields a refusal named, and hand back the first one so focus can go there. */
export function markProblems(problems) {
  var labels = ui.entryFields.querySelectorAll('.entry-field')
  Array.prototype.forEach.call(labels, function (label) {
    label.classList.remove('invalid')
  })
  var first = null
  ;(problems || []).forEach(function (problem) {
    var match = /^(?:field|missing required field) "([^"]+)"/.exec(problem)
    if (!match) return
    var input = ui.entryFields.querySelector('input[data-field="' + match[1] + '"]')
    if (!input) return
    var label = input.parentNode
    label.classList.add('invalid')
    if (!first) first = input
  })
  return first
}

export function renderStatus() {
  var status = state.status
  // With nothing to report the reserved row is not empty: it says how to correct a record, which is
  // the one action in this bar that has no button of its own.
  ui.entryStatus.hidden = !status && !state.view
  ui.entryStatus.className = 'entry-status' + (status && status.kind === 'error' ? ' is-error' : '')
  ui.entryStatus.textContent = ''
  if (!status) {
    if (state.view && state.correction === null) {
      ui.entryStatus.appendChild(node('span', 'idle', copyStatus.idleHint()))
    }
    return
  }
  ui.entryStatus.appendChild(node('span', null, status.text))
  // A change that is one click from being undone says so with the click, not with a sentence about
  // what a command would do (U6). The button is how a person undoes a removal.
  if (status.action) {
    var action = status.action
    var button = node('button', 'ghost status-action', action.label)
    button.type = 'button'
    button.addEventListener('click', function () {
      action.run()
    })
    ui.entryStatus.appendChild(button)
  }
  if (status.problems && status.problems.length > 0) {
    var list = document.createElement('ul')
    status.problems.forEach(function (problem) {
      list.appendChild(node('li', null, problem))
    })
    ui.entryStatus.appendChild(list)
  }
}

export function setStatus(kind, text, problems, action) {
  // Problems are the core's sentences too, and they name the shape a field was checked against.
  // Run them through the same filter as the status line, at the one place every caller passes.
  state.status = {
    kind: kind,
    text: text,
    problems: (problems || []).map(function (problem) {
      return refusal(problem)
    }),
    action: action || null,
  }
  renderStatus()
}

export function renderEntry() {
  // A tab's first panel says where points land; a project with no tab yet says the same thing for
  // its first dataset. That is what makes a freshly created project usable rather than empty.
  var entry = (state.opened && state.opened.entry) || state.projectEntry
  var visible = Boolean(entry && entry.fields.length > 0)
  ui.entry.hidden = !visible
  ui.entryReadout.textContent = ''
  if (!visible) {
    state.entryKey = null
    return
  }

  var correction = state.correction
  ui.entry.classList.toggle('correcting', correction !== null)
  ui.entryCorrect.hidden = correction === null
  ui.entryAdd.querySelector('span').textContent =
    correction === null ? labels.addPoint : labels.saveCorrection
  ui.entryUndo.hidden = correction !== null
  if (correction !== null) {
    ui.entryCorrectLabel.textContent = ''
    ui.entryCorrectLabel.appendChild(node('span', null, 'Editing '))
    ui.entryCorrectLabel.appendChild(
      node(
        'span',
        'note',
        copyStatus.correctionRow({
          values: correction.values,
          observed: correction.tObserved,
          corrections: correction.corrections,
          stalePanels: correction.recipePanels.length,
        }),
      ),
    )
  }

  buildEntryFields(
    entry,
    correction === null ? null : correction.values,
    correction === null ? 'add' : 'correct:' + correction.id,
  )
  ui.entryAdd.disabled = state.busy
  // One undo, and it says which act it would reverse: the bar's last point and a removal from the
  // menu share one history, so a single button can serve both without a second one beside a status.
  var next = nextUndo()
  ui.entryUndo.disabled = state.busy || next === null
  ui.entryUndo.textContent = copyStatus.undoLabel(next)
  ui.entryUndo.title = copyStatus.undoTitle(next)

  if (state.timing !== null) {
    ui.entryReadout.appendChild(node('b', null, state.timing + ' ms'))
    ui.entryReadout.appendChild(document.createTextNode(' · '))
  }
  ui.entryReadout.appendChild(document.createTextNode('n = ' + entry.active))
  ui.entryReadout.title = copyStatus.readoutTitle()
  renderStatus()
}

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
    state.status = {
      kind: 'ok',
      text: copyStatus.editing({ values: detail.values, panel: state.view.panels[index] }),
      problems: [],
    }
    state.busy = false
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

/** Put the bar back to adding, and take the ring off. */
export function closeCorrection() {
  if (state.selection) {
    var handle = state.handles[state.selection.index]
    if (handle && handle.clearSelection) handle.clearSelection()
  }
  state.selection = null
  state.correction = null
  state.status = null
  renderEntry()
}

/**
 * Save an edit to an existing record. The log gets a `point_corrected` event that supersedes the
 * original; nothing is overwritten and nothing is deleted. The core rebuilds the tab before this
 * returns, so a panel drawn by a recipe is reported stale instead of continuing to look current.
 */
export async function submitCorrection() {
  var correction = state.correction
  var values = fieldValueMap()
  state.busy = true
  renderEntry()
  try {
    var corrected = await call(
      bridge.correctPoint(state.project.dir, correction.id, values, state.view.name),
    )
    state.correction = null
    state.selection = null
    state.busy = false
    state.opened = corrected.view
    state.view = corrected.view.view
    renderTabs()
    renderView(captureRestore())
    var stale = corrected.view.kept
    setStatus(
      stale.length > 0 ? 'error' : 'ok',
      copyStatus.corrected({ active: corrected.active, stalePanels: stale.length }),
    )
    focusFirstField()
  } catch (error) {
    var firstInvalid = markProblems((error && error.problems) || [])
    setStatus(
      'error',
      refusal((error && error.message) || 'the core refused the correction'),
      (error && error.problems) || ((error && error.hint) ? [refusal(error.hint)] : []),
    )
    if (firstInvalid) firstInvalid.focus()
  } finally {
    state.busy = false
    renderEntry()
  }
}

/** An act that can never be reversed: the record it named has moved under it. */
function permanent(error) {
  return Boolean(error && (error.kind === 'invalid' || error.kind === 'missing'))
}

async function undoPoint(entry) {
  state.busy = true
  renderEntry()
  try {
    var retracted = await call(
      bridge.retractPoint(state.project.dir, entry.point.id, 'undo from the window'),
    )
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
    undoFailed(entry, !permanent(error))
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
 * Rebuild the tab after a point left or came back. A removal can change the axes' domain and the
 * evidence line, so the drawing is rebuilt rather than patched; the crop and the scroll the person
 * was reading are carried across it, exactly as a correction does.
 */
async function rebuildAfterPointChange() {
  if (!state.view) return null
  // A repaint replaces the chart the keyboard was in, and `renderView` hands the focus back to the
  // same panel. Only a person who was typing gets the cursor moved to the bar: an action taken from
  // the drawing must leave them on the drawing, not drop them into a field they did not ask for.
  var focusInDrawing = Boolean(document.activeElement && ui.grid.contains(document.activeElement))
  var refreshed = await call(bridge.refreshView(state.project.dir, state.view.name, { draw: true }))
  state.opened = refreshed
  state.view = refreshed.view
  renderTabs()
  renderView(captureRestore())
  if (!focusInDrawing) focusFirstField()
  return refreshed.entry ? refreshed.entry.active : 0
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
    var active = await rebuildAfterPointChange()
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

/**
 * Undo a removal. The core appends a restore that names the retraction it reverses, so the same
 * record comes back — same id, values, observation time and version — rather than a copy of it.
 */
async function undoRemoval(entry) {
  var removal = entry.removal
  state.busy = true
  renderEntry()
  try {
    // Name the removal this undo remembers. The core reverses that act or refuses; it never picks
    // the newest removal of the same point, which may be somebody else's later act.
    var restored = await call(bridge.restorePoint(state.project.dir, removal.id, removal.retraction))
    undoFinished(entry)
    var active = await rebuildAfterPointChange()
    setStatus(
      'ok',
      copyStatus.restored({ active: active === null ? restored.active : active }),
      [],
      { label: labels.redoRemoval, run: redoLastAction },
    )
  } catch (error) {
    // A removal that is no longer in force is not coming back: drop the entry, rebuild so the screen
    // agrees with the log, and say why. Any other refusal is temporary, so the act stays available.
    undoFailed(entry, !permanent(error))
    if (permanent(error)) {
      try {
        await rebuildAfterPointChange()
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
    var removed = await call(bridge.retractPoint(state.project.dir, entry.removal.id))
    // Redo withdrew the point again, with a new removal event: undoing that undo means reversing
    // this one, not the removal the entry remembered before it.
    redoFinished(entry, removed.retraction)
    var active = await rebuildAfterPointChange()
    setStatus('ok', copyStatus.removed({ active: active === null ? removed.active : active }))
  } catch (error) {
    redoFailed(entry)
    setStatus('error', refusal(error && error.message), (error && error.problems) || [])
  } finally {
    state.busy = false
    renderEntry()
  }
}

/** Whether Ctrl+Z would edit text: a field with something in it owns its own undo. */
function entryHasText() {
  return entryInputs().some(function (input) {
    return input.value !== ''
  })
}

/** Ctrl+Z: take the next act from the history and carry it out. */
export function undoLastAction() {
  if (state.busy) return
  var entry = takeUndo()
  if (entry === null) return
  return entry.kind === 'removal' ? undoRemoval(entry) : undoPoint(entry)
}

/** Ctrl+Shift+Z / Ctrl+Y, and the status's own button after an undo. */
export function redoLastAction() {
  if (state.busy) return
  var entry = takeRedo()
  if (entry === null) return
  return redoRemoval(entry)
}

/** The bar's controls: add, correct, undo, and the two shortcuts that act on a point. */
export function wireEntry() {
  ui.entry.addEventListener('submit', submitEntry)
  ui.entryUndo.addEventListener('click', undoLastAction)
  ui.entryCancel.addEventListener('click', closeCorrection)
  ui.entry.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && state.correction !== null) {
      event.preventDefault()
      closeCorrection()
      return
    }
    if (!event.ctrlKey && !event.metaKey) return
    var key = event.key.toLowerCase()
    if (key !== 'z' && key !== 'y') return
    // Ctrl+Z means undo-the-point only when there is no half-typed text to undo instead. Stealing
    // it while someone is editing a field would be a trap.
    if (entryHasText()) return
    event.preventDefault()
    if (key === 'y' || event.shiftKey) redoLastAction()
    else undoLastAction()
  })
  // The same shortcuts with the cursor on the drawing rather than in the bar. Text fields keep their
  // own undo: the handler above owns them, and this one steps aside for any editable target.
  document.addEventListener('keydown', function (event) {
    if (!event.ctrlKey && !event.metaKey) return
    var key = event.key.toLowerCase()
    if (key !== 'z' && key !== 'y') return
    var target = event.target
    if (ui.entry.contains(target)) return
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
      return
    }
    if (entryHasText()) return
    event.preventDefault()
    if (key === 'y' || event.shiftKey) redoLastAction()
    else undoLastAction()
  })
}
