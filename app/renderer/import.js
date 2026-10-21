/* The import sheet: read a file, show its columns, map them, and say what the write will do. */
import { state, ui, node, bridge, call, showFailure } from './state.js'
import { renderTabs } from './rail.js'
import { renderView, captureRestore } from './panels.js'
import { renderEntry } from './entry.js'
import { endEditFor } from './correction.js'
import { setStatus } from './status.js'
import { focusFirstField } from './fields.js'
import { noteImport, reconcileImport } from './history.js'
import {
  importButton,
  importPlan as importPlanText,
  importSummary,
  importTimeChange as timeChangeWord,
  importTimeEstimate as timeEstimateWord,
  importTimeSaid as timeSaidWords,
  status as copyStatus,
} from './copy.js'

/** The value the time choice uses for "the file has no clock"; a column name can never be this. */
var ESTIMATE = 'estimate'

/** Whether the full time choice is open. Closed by default: the guess is stated, not asked. */
var timeOpen = false

export function fileBase(path) {
  return String(path || '').split(/[\\/]/).pop() || path
}

/** A refusal from the core, in the words the CLI would use, inside the sheet that asked. */
export function showImportError(error) {
  ui.importError.hidden = false
  ui.importError.textContent = ''
  ui.importError.appendChild(node('p', null, (error && error.message) || String(error)))
  if (error && error.hint) ui.importError.appendChild(node('p', null, error.hint))
  ;((error && error.problems) || []).forEach(function (problem) {
    ui.importError.appendChild(node('p', null, problem))
  })
}

/**
 * What the core read, before any mapping is promised: the columns, a sample with the values as
 * they appear in the file, and one row per shape field with the type it will be validated as.
 */
export function renderImportPreview(preview) {
  var unmapped = preview.fields
    .filter(function (field) {
      return !field.optional && !preview.suggested[field.name]
    })
    .map(function (field) {
      return field.name
    })
  // What the file holds and what the write would do, before any mapping is promised.
  ui.importSummary.textContent = importSummary(preview, unmapped)

  ui.importPreview.textContent = ''
  var table = document.createElement('table')
  var head = document.createElement('thead')
  var headRow = document.createElement('tr')
  preview.columns.forEach(function (column) {
    headRow.appendChild(node('th', null, column))
  })
  head.appendChild(headRow)
  table.appendChild(head)
  var body = document.createElement('tbody')
  preview.sample.forEach(function (row) {
    var line = document.createElement('tr')
    preview.columns.forEach(function (column) {
      line.appendChild(node('td', null, row[column] === '' ? '—' : row[column]))
    })
    body.appendChild(line)
  })
  table.appendChild(body)
  ui.importPreview.appendChild(table)

  ui.importFields.textContent = ''
  preview.fields.forEach(function (field) {
    var label = node('label', 'import-field')
    label.appendChild(node('span', 'import-field-name', field.name))
    label.appendChild(node('span', 'import-field-type', field.type + (field.optional ? ' · optional' : '')))
    var select = document.createElement('select')
    select.dataset.field = field.name
    select.setAttribute('aria-label', field.name + ' · ' + field.type)
    var none = node('option', null, '— not imported')
    none.value = ''
    select.appendChild(none)
    preview.columns.forEach(function (column) {
      var option = node('option', null, column)
      option.value = column
      select.appendChild(option)
    })
    select.value = preview.suggested[field.name] || ''
    label.appendChild(select)
    ui.importFields.appendChild(label)
  })

  // The one column the window cannot guess *for* the reader, so it guesses and says so: the name
  // that looks like a clock, or — when the file has none — the row order, labelled as an estimate.
  // A shape that designates its time field has already answered; the line says that instead.
  ui.importTime.textContent = ''
  var noTime = node('option', null, '— choose the column')
  noTime.value = ''
  ui.importTime.appendChild(noTime)
  var estimate = node('option', null, timeEstimateWord)
  estimate.value = ESTIMATE
  estimate.hidden = preview.timeField !== undefined
  ui.importTime.appendChild(estimate)
  preview.columns.forEach(function (column) {
    var option = node('option', null, column)
    option.value = column
    ui.importTime.appendChild(option)
  })
  // A shape that designates its time has answered already: the field is the authority, and this
  // control would be a second answer beside it. Only a shape that designates nothing gets a guess.
  ui.importTime.value = preview.timeField ? '' : preview.suggestedTime || ESTIMATE
  timeOpen = false
  renderImportTime()
  renderImportExtras()

  // A plan for the *previous* file must not land on this one: the token retires it.
  state.importPlanToken = (state.importPlanToken || 0) + 1
  renderImportPlan(null)

  // Only a file whose exact bytes are already in the log gets the second door.
  ui.importForceField.hidden = !preview.duplicate
  ui.importForce.checked = false
}

/**
 * The one line about time, and the choice behind it. The line is always shown; the full list of
 * columns opens only when asked, because a file with an obvious clock should need no interaction.
 */
export function renderImportTime() {
  var preview = state.importPreview
  var value = ui.importTime.value
  ui.importTimeSaid.textContent = timeSaidWords({
    field: preview ? preview.timeField : undefined,
    column: value === '' || value === ESTIMATE ? '' : value,
    estimated: value === ESTIMATE,
  })
  ui.importTimeChange.textContent = timeChangeWord
  // A designated shape's time comes from its own field: there is nothing here to change.
  ui.importTimeChange.hidden = Boolean(preview && preview.timeField)
  ui.importTimeChange.setAttribute('aria-expanded', timeOpen ? 'true' : 'false')
  ui.importTimeField.hidden = !timeOpen || Boolean(preview && preview.timeField)
}

/** The mapping the sheet is showing, as the core wants it: field name to column. */
export function importMapping() {
  var mapping = {}
  ;(ui.importFields.querySelectorAll('select') || []).forEach(function (select) {
    if (select.value === '') return
    mapping[select.dataset.field] = select.value
  })
  return mapping
}

/** Source columns the current mapping and time choice do not use. */
export function importExtraColumns() {
  var preview = state.importPreview
  if (!preview) return []
  var used = {}
  var mapping = importMapping()
  Object.keys(mapping).forEach(function (field) {
    used[mapping[field]] = true
  })
  if (!preview.timeField && ui.importTime.value !== '' && ui.importTime.value !== ESTIMATE) {
    used[ui.importTime.value] = true
  }
  return preview.columns.filter(function (column) {
    return !used[column]
  })
}

/**
 * An extra column is shown, never assumed. The checkbox names every column it would drop, and a
 * mapping change resets it: the acknowledgement must match the columns on screen.
 */
export function renderImportExtras() {
  var extras = importExtraColumns()
  var key = extras.join('\u0000')
  if (key !== state.importExtraKey) {
    state.importExtraKey = key
    ui.importIgnoreExtra.checked = false
  }
  ui.importExtraField.hidden = extras.length === 0
  ui.importExtraNames.textContent =
    extras.length === 0
      ? ''
      : 'Ignore ' +
        extras.join(', ') +
        ' (no shape field' +
        (extras.length === 1 ? '; its values' : '; their values') +
        ' will not be imported)'
}

/**
 * Where the rows' times come from, as the core wants it: a column, the file's own order, or — when
 * the shape designates the field — nothing at all, because the mapping already answered it.
 */
function timeOption() {
  if (state.importPreview && state.importPreview.timeField) return {}
  var value = ui.importTime.value
  return value === ESTIMATE ? { estimate: true } : { time: value }
}

/** The explicit per-import opt-out the core requires for columns it cannot store. */
export function importIgnoreColumns() {
  return ui.importIgnoreExtra.checked ? importExtraColumns() : []
}

/** The planned version and diff, or the word a refusal deserves, in one line. */
export function renderImportPlan(planned, refusal) {
  ui.importApply.querySelector('span').textContent = importButton(planned)
  if (refusal) {
    ui.importPlan.hidden = false
    ui.importPlan.className = 'import-plan is-error'
    ui.importPlan.textContent = refusal
    return
  }
  if (!planned) {
    ui.importPlan.hidden = true
    ui.importPlan.className = 'import-plan'
    ui.importPlan.textContent = ''
    return
  }
  ui.importPlan.className = 'import-plan'
  ui.importPlan.hidden = false
  ui.importPlan.textContent = importPlanText(planned)
  ui.importApply.querySelector('span').textContent = importButton(planned)
}

/**
 * Ask the core what the current mapping would do, without writing anything. The token drops a
 * slower answer that arrives after a newer one, so the line never shows a stale plan.
 */
export async function syncImportPlan() {
  var preview = state.importPreview
  if (!preview || !state.importFile || state.importBusy) return
  var mapping = importMapping()
  if (Object.keys(mapping).length === 0) {
    renderImportPlan(null)
    return
  }
  // Said before the core is asked, because there is nothing to plan without it — and the point
  // is not to let the core invent instants quietly, so the row order is a choice made here.
  if (!preview.timeField && ui.importTime.value === '') {
    renderImportPlan(null, 'choose the column that holds the observation time, or say the file has none')
    return
  }
  var token = ++state.importPlanToken
  try {
    var planned = await call(
      bridge.importPlan(
        state.project.dir,
        state.importFile,
        mapping,
        Object.assign({ force: ui.importForce.checked, ignoreColumns: importIgnoreColumns() }, timeOption()),
      ),
    )
    if (token !== state.importPlanToken) return
    renderImportPlan(planned)
  } catch (error) {
    if (token !== state.importPlanToken) return
    var message = (error && error.message) || String(error)
    // Still mapping: a field with no column is not a refusal yet, it is the next click.
    if (/no column for the required field/.test(message)) renderImportPlan(null)
    else renderImportPlan(null, message)
  }
}

export async function openImportDialog() {
  if (!state.project || state.busy || state.importBusy) return
  var file
  try {
    file = await call(bridge.pickImportFile())
  } catch (error) {
    showFailure('Could not open the file picker', error)
    return
  }
  if (!file) return
  await loadImportFile(file)
}

export async function loadImportFile(file) {
  state.importFile = file
  state.importPreview = null
  ui.importPath.textContent = file
  ui.importPath.title = file
  ui.importSummary.textContent = 'Reading ' + fileBase(file) + '…'
  ui.importPreview.textContent = ''
  ui.importFields.textContent = ''
  ui.importExtraField.hidden = true
  ui.importIgnoreExtra.checked = false
  ui.importForceField.hidden = true
  // A refusal belongs to the file that produced it. Left in the sheet, the previous file's words
  // are still there for a screen reader and for the next guard that reads this dialog.
  ui.importError.hidden = true
  ui.importError.textContent = ''
  ui.importApply.disabled = true
  if (!ui.importDialog.open) ui.importDialog.showModal()

  try {
    var preview = await call(bridge.importPreview(state.project.dir, file))
    state.importPreview = preview
    renderImportPreview(preview)
    ui.importApply.disabled = false
    // A file whose columns already match the shape has a plan from the first paint.
    syncImportPlan()
    var first = ui.importFields.querySelector('select')
    if (first) first.focus()
  } catch (error) {
    ui.importSummary.textContent = ''
    showImportError(error)
  }
}

export async function submitImport(event) {
  event.preventDefault()
  var preview = state.importPreview
  if (!preview || !state.importFile || state.importBusy) return

  var mapping = importMapping()

  state.importBusy = true
  state.busy = true
  ui.importApply.disabled = true
  ui.importError.hidden = true
  try {
    var imported = await call(
      bridge.importFile(
        state.project.dir,
        state.importFile,
        mapping,
        Object.assign(timeOption(), {
          force: ui.importForce.checked,
          ignoreColumns: importIgnoreColumns(),
          viewName: state.view ? state.view.name : undefined,
        }),
      ),
    )
    ui.importDialog.close()
    // An import replaces the data under the tab without leaving it: the drawing is refreshed like any
    // other write, and only the acts it touched leave the history. Everything else the person did
    // here stays undoable, in order, so undoing the import gives the earlier acts their turn back.
    if (imported.view) {
      state.opened = imported.view
      state.view = imported.view.view
    }
    reconcileImport(imported)
    // An import that withdrew or rewrote the row being edited ends that edit, for the same reason it
    // ends the acts about that row: the strip has nothing left to save to.
    ;(imported.touched || []).forEach(endEditFor)
    noteImport(imported.dataset, imported.version, imported.parent)
    if (imported.view) {
      if (state.projectEntry && imported.view.entry) state.projectEntry.active = imported.view.entry.active
      renderTabs()
      renderView(captureRestore())
    } else {
      if (state.projectEntry) state.projectEntry.active = imported.active
      renderEntry()
    }
    state.datasets.forEach(function (dataset) {
      if (dataset.id === imported.dataset) dataset.active = imported.active
    })
    setStatus(
      'ok',
      copyStatus.imported({
        rows: imported.rows,
        first: imported.parent === null,
        added: imported.diff.added,
        removed: imported.diff.removed,
        changed: imported.diff.changed,
        removedRows: imported.removedRows.length,
        ignoredColumns: imported.ignoredColumns,
        warnings: imported.warnings,
        estimated: imported.estimated,
      }),
    )
    focusFirstField()
  } catch (error) {
    ui.importApply.disabled = false
    showImportError(error)
  } finally {
    state.importBusy = false
    state.busy = false
    // The bar was drawn while the write was in flight, and `busy` disabled its undo. Clearing the
    // flag is not enough: the button stays disabled until something redraws it, which after an
    // import is nothing at all — the act it offers would be there but unclickable.
    renderEntry()
  }
}

/** The import sheet's controls: open and pick, the mapping, and the plan it recomputes. */
export function wireImport() {
  ui.importOpen.addEventListener('click', openImportDialog)
  ui.importPick.addEventListener('click', openImportDialog)
  ui.importForm.addEventListener('submit', submitImport)
  // A refusal belongs to the mapping that produced it; choosing a column clears it rather than
  // leaving an error about a mapping the user has already changed. Either way the planned version
  // is recomputed, because it is a fact about the mapping and not about the click.
  ui.importFields.addEventListener('change', function () {
    ui.importError.hidden = true
    renderImportExtras()
    syncImportPlan()
  })
  ui.importTimeChange.addEventListener('click', function () {
    timeOpen = !timeOpen
    renderImportTime()
    if (timeOpen) ui.importTime.focus()
  })
  ui.importTime.addEventListener('change', function () {
    ui.importError.hidden = true
    renderImportTime()
    renderImportExtras()
    syncImportPlan()
  })
  ui.importIgnoreExtra.addEventListener('change', function () {
    ui.importError.hidden = true
    syncImportPlan()
  })
  ui.importForce.addEventListener('change', syncImportPlan)
  ui.importCancel.addEventListener('click', function () {
    ui.importDialog.close()
  })
}
