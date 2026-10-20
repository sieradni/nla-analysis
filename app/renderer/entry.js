/* The entry bar: type a point, correct a point, retract the last one, and catch the tab file up. */
import { state, ui, node, bridge, call, shortDate } from './state.js'
import { factsFor, describeValues } from './format.js'
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
      ui.entryStatus.appendChild(
        node('span', 'idle', 'Click a point to correct it, or Shift+Arrow in a chart to step through them.'),
      )
    }
    return
  }
  ui.entryStatus.appendChild(node('span', null, status.text))
  if (status.problems && status.problems.length > 0) {
    var list = document.createElement('ul')
    status.problems.forEach(function (problem) {
      list.appendChild(node('li', null, problem))
    })
    ui.entryStatus.appendChild(list)
  }
}

export function setStatus(kind, text, problems) {
  state.status = { kind: kind, text: text, problems: problems || [] }
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
  ui.entryAdd.querySelector('span').textContent = correction === null ? 'Add point' : 'Save correction'
  ui.entryUndo.hidden = correction !== null
  if (correction !== null) {
    ui.entryCorrectLabel.textContent = ''
    ui.entryCorrectLabel.appendChild(node('span', null, 'Correcting '))
    ui.entryCorrectLabel.appendChild(node('span', 'id', correction.id))
    ui.entryCorrectLabel.appendChild(
      node(
        'span',
        'note',
        ' · recorded ' +
          shortDate(correction.tObserved) +
          ' · ' +
          (correction.corrections === 0
            ? 'no corrections yet'
            : correction.corrections + ' corrections already') +
          (correction.recipePanels.length > 0
            ? ' · panel ' +
              (correction.recipePanels[0] + 1) +
              ' was drawn by a recipe and will go stale'
            : ''),
      ),
    )
  }

  buildEntryFields(
    entry,
    correction === null ? null : correction.values,
    correction === null ? 'add' : 'correct:' + correction.id,
  )
  ui.entryAdd.disabled = state.busy
  ui.entryUndo.disabled = state.busy || !state.lastPoint
  ui.entryUndo.title = state.lastPoint
    ? 'Retract ' + state.lastPoint.id + ' with a logged event (Ctrl+Z in an empty bar)'
    : 'Nothing to undo: no point has been added from this window'

  if (state.timing !== null) {
    ui.entryReadout.appendChild(node('b', null, state.timing + ' ms'))
    ui.entryReadout.appendChild(document.createTextNode(' · '))
  }
  ui.entryReadout.appendChild(document.createTextNode('n = ' + entry.active))
  ui.entryReadout.title =
    'n is the active points in ' + entry.dataset + '. The ms figure is Enter → painted frame, budget 100 ms (ADR 0003).'
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
    state.lastPoint = { id: recorded.id, dataset: recorded.dataset, values: recorded.values }

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

    var note =
      'Recorded ' +
      recorded.id +
      ' · ' +
      describeValues(recorded.values) +
      ' · ' +
      recorded.active +
      ' active in ' +
      recorded.dataset
    if (recorded.warnings.length > 0) note += ' · warning: ' + recorded.warnings.join('; ')
    if (recorded.reread) {
      note += ' · the log had changed on disk, so it was reread before this point was added'
    }
    setStatus('ok', note)

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
      (error && error.message) || 'the core refused the point',
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
    if (facts && panel) facts.textContent = factsFor(panel)
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
        setStatus(
          'error',
          'The log changed on disk while this tab was open — it was reread and the tab redrawn. ' +
            'Anything the other writer added is in that drawing, not in the one before it.',
        )
        return
      }
      if (persisted.saved === false) {
        setStatus(
          'error',
          'The point is recorded, but this tab could not be saved: its rebuilt drawing was no longer waiting. ' +
            'Reopen the tab to rebuild it.',
        )
        return
      }
      if (window.__benchTiming && window.__benchTiming.id === (state.lastPoint && state.lastPoint.id)) {
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
      setStatus(
        'error',
        'The log changed on disk while this tab was open — it was reread and the tab redrawn. ' +
          'Anything the other writer added is in that drawing, not in the one before it.',
      )
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
      if (facts) facts.textContent = factsFor(panel)
      var footer = figure.querySelector('svg text.footer')
      var text = settled.footers[index]
      if (footer && typeof text === 'string') footer.textContent = text
      if (panel && typeof text === 'string') panel.chart.footer = text
    })
    renderMeta()
    renderStatuses(settled.statuses)
    if (window.__benchTiming && window.__benchTiming.id === (state.lastPoint && state.lastPoint.id)) {
      window.__benchTiming.commit = performance.now() - startedAt
    }
  } catch (error) {
    setStatus(
      'error',
      'The point is recorded, but this tab could not be saved: ' + ((error && error.message) || error),
    )
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
    state.correction = detail
    state.timing = null
    state.status = {
      kind: 'ok',
      text:
        'Editing ' +
        detail.id +
        ' · ' +
        describeValues(detail.values) +
        ' · Escape cancels',
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
    setStatus('error', (error && error.message) || 'the core could not read that point')
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
    var note =
      'Corrected ' +
      corrected.id +
      ' · ' +
      describeValues(corrected.values) +
      ' · ' +
      corrected.active +
      ' active in ' +
      corrected.dataset +
      '. A point_corrected event supersedes the original; the log keeps both.'
    if (stale.length > 0) {
      note +=
        ' Panel ' +
        (stale[0].index + 1) +
        ' was drawn by a recipe, so it is stale until it is rerun — ' +
        'the window will not claim it still holds.'
    }
    setStatus(stale.length > 0 ? 'error' : 'ok', note)
    focusFirstField()
  } catch (error) {
    var firstInvalid = markProblems((error && error.problems) || [])
    setStatus(
      'error',
      (error && error.message) || 'the core refused the correction',
      (error && error.problems) || ((error && error.hint) ? [error.hint] : []),
    )
    if (firstInvalid) firstInvalid.focus()
  } finally {
    state.busy = false
    renderEntry()
  }
}

export async function undoPoint() {
  if (state.busy || !state.lastPoint) return
  var target = state.lastPoint
  state.busy = true
  renderEntry()
  try {
    var retracted = await call(
      bridge.retractPoint(state.project.dir, target.id, 'undo from the window'),
    )
    state.lastPoint = null
    state.timing = null
    // A tab that was deleted on disk has nothing to rebuild; the bar's own count is enough.
    if (!state.view) {
      if (state.projectEntry) state.projectEntry.active = retracted.active
      state.busy = false
      renderEntry()
      setStatus(
        'ok',
        'Retracted ' +
          target.id +
          ' with a point_retracted event. It stays in the log; the dataset is back to ' +
          retracted.active +
          ' active.',
      )
      return
    }
    var refreshed = await call(bridge.refreshView(state.project.dir, state.view.name))
    state.opened = refreshed
    state.view = refreshed.view
    state.busy = false
    renderTabs()
    renderView(captureRestore())
    focusFirstField()
    var active = refreshed.entry ? refreshed.entry.active : null
    setStatus(
      'ok',
      'Retracted ' +
        target.id +
        ' with a point_retracted event. It stays in the log' +
        (active === null ? '.' : '; the dataset is back to ' + active + ' active.'),
    )
  } catch (error) {
    setStatus('error', (error && error.message) || 'the core refused the retraction', (error && error.problems) || [])
  } finally {
    state.busy = false
    renderEntry()
  }
}

/** The bar's controls: add, correct, undo, and the two shortcuts that act on a point. */
export function wireEntry() {
  ui.entry.addEventListener('submit', submitEntry)
  ui.entryUndo.addEventListener('click', undoPoint)
  ui.entryCancel.addEventListener('click', closeCorrection)
  ui.entry.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && state.correction !== null) {
      event.preventDefault()
      closeCorrection()
      return
    }
    if (event.key !== 'z' && event.key !== 'Z') return
    if (!event.ctrlKey && !event.metaKey) return
    // Ctrl+Z means undo-the-point only when there is no half-typed text to undo instead. Stealing
    // it while someone is editing a field would be a trap.
    var busy = entryInputs().some(function (input) {
      return input.value !== ''
    })
    if (busy) return
    event.preventDefault()
    undoPoint()
  })
}
