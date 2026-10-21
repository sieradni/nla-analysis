/*
 * The tab sheet: choose a dataset, a recipe or a plot and the axes a plot reads, and the smaller sheet
 * that asks a tab's new name for Rename and Duplicate.
 *
 * The acts themselves (rename, copy, close) are `tab-actions.js`'s: a sheet asks a question, it does
 * not move a tab. This module owns the words on the sheet and the field they are typed into.
 */
import { state, ui, node, bridge, call, showView } from './state.js'
import { datasetOption, nameSheet, refusal, status as copyStatus } from './copy.js'
import { renderTabs } from './rail.js'
import { renderView } from './panels.js'
import { setStatus, focusFirstField } from './entry.js'
import { noteTabCreated } from './history.js'
import { actions } from './navigation.js'
import { duplicateTab, renameTab } from './tab-actions.js'

/** Put the project's datasets in the select, and the catalog in the panel select once it arrives. */
export function fillTabDialog() {
  ui.tabDataset.textContent = ''
  state.datasets.forEach(function (dataset) {
    var option = node('option', null, datasetOption(dataset, state.datasets.length))
    option.value = dataset.id
    ui.tabDataset.appendChild(option)
  })

  ui.tabPanel.textContent = ''
  var plot = node('option', null, 'Plot the dataset')
  plot.value = 'plot'
  ui.tabPanel.appendChild(plot)
  var recipes = (state.recipes && state.recipes.recipes) || []
  recipes.forEach(function (recipe) {
    var option = node('option', null, recipe.name + ' — ' + recipe.summary)
    option.value = recipe.name
    ui.tabPanel.appendChild(option)
  })
  fillTabAxes()

  var problem = state.recipes && state.recipes.problem
  ui.tabNote.textContent = problem
    ? 'No recipe is offered because the analysis runtime is not available: ' + problem
    : 'A recipe panel is built by the analysis runtime; a plot panel needs nothing but the log.'
}

/** The selected dataset, whose shape decides which fields a plot can name. */
export function tabDataset() {
  for (var index = 0; index < state.datasets.length; index += 1) {
    if (state.datasets[index].id === ui.tabDataset.value) return state.datasets[index]
  }
  return null
}

export function fillAxisSelect(select, fields, preferred) {
  select.textContent = ''
  fields.forEach(function (field) {
    var option = node('option', null, field.name + ' · ' + field.type)
    option.value = field.name
    select.appendChild(option)
  })
  if (fields.length === 0) {
    var none = node('option', null, 'no plottable field')
    none.value = ''
    select.appendChild(none)
    return
  }
  var preferredOption = fields.some(function (field) { return field.name === preferred })
  select.value = preferredOption ? preferred : fields[0].name
}

/**
 * Fill the axis pickers from the selected shape. A recipe panel has no axis choice; a plot with
 * no numeric vertical field is refused here, with a sentence, instead of saving a blank panel.
 */
export function fillTabAxes() {
  var dataset = tabDataset()
  var plot = ui.tabPanel.value === 'plot'
  ui.tabAxes.hidden = !plot
  ui.tabAxesNote.hidden = true
  if (!plot || !dataset) {
    ui.tabCreate.disabled = false
    return
  }
  // The core resolved these against the same rule `bench chart` uses; the renderer only draws them.
  var xFields = dataset.axes.x
  var yFields = dataset.axes.y
  fillAxisSelect(ui.tabXField, xFields, 'x')
  fillAxisSelect(ui.tabYField, yFields, 'y')
  var missing = xFields.length === 0 || yFields.length === 0
  if (missing) {
    ui.tabAxesNote.hidden = false
    ui.tabAxesNote.textContent =
      'This shape has no ' +
      (yFields.length === 0 ? 'numeric vertical field' : 'horizontal field') +
      ' to plot. Add one, or build a recipe panel.'
  }
  ui.tabCreate.disabled = missing
}

/**
 * The one dialog that writes a view file. It offers datasets and recipes and never a free-form
 * panel: what it can build is exactly what `bench view new` can build.
 */
export async function openTabDialog() {
  if (!state.project) return
  ui.tabError.hidden = true
  ui.tabPanel.value = 'plot'
  ui.tabReplace.checked = false
  ui.tabReplaceField.hidden = true
  ui.tabName.value = state.datasets[0] ? state.datasets[0].id : ''
  syncTabReplace()
  fillTabDialog()
  ui.tabDialog.showModal()
  ui.tabName.focus()
  ui.tabName.select()

  if (state.recipes === null) {
    try {
      state.recipes = await call(bridge.recipes())
    } catch (error) {
      state.recipes = { recipes: [], problem: (error && error.message) || String(error) }
    }
    if (ui.tabDialog.open) fillTabDialog()
  }
}

/** Show the replace checkbox only when the typed name is already taken. */
export function syncTabReplace() {
  var name = ui.tabName.value.trim().toLowerCase()
  var taken = name !== '' && state.views.some(function (view) {
    return view.name.toLowerCase() === name
  })
  ui.tabReplaceField.hidden = !taken
  if (!taken) ui.tabReplace.checked = false
}

export async function createTab(event) {
  event.preventDefault()
  if (!state.project) return
  var recipe = ui.tabPanel.value === 'plot' ? undefined : ui.tabPanel.value
  var xField = recipe === undefined ? ui.tabXField.value : ''
  var yField = recipe === undefined ? ui.tabYField.value : ''
  var draft = {
    name: ui.tabName.value.trim(),
    dataset: ui.tabDataset.value,
    ...(recipe === undefined ? {} : { recipe: recipe }),
    ...(recipe === undefined && xField && xField !== 'x' ? { xField: xField } : {}),
    ...(recipe === undefined && yField && yField !== 'y' ? { yField: yField } : {}),
    ...(ui.tabReplace.checked ? { replace: true } : {}),
  }
  ui.tabCreate.disabled = true
  ui.tabError.hidden = true
  try {
    var opened = await call(bridge.writeView(state.project.dir, draft))
    var listed = await call(bridge.views(state.project.dir))
    state.views = listed.views
    state.correction = null
    state.selection = null
    // The new tab is a different drawing: the history of the one it replaced goes with it — and the
    // first act of the new one is its own creation, so undo closes it and redo brings it back.
    showView(opened)
    noteTabCreated(opened.view.name)
    state.entryKey = null
    state.timing = null
    ui.tabDialog.close()
    renderTabs()
    renderView()
    focusFirstField()
    setStatus(
      'ok',
      copyStatus.tabSaved({
        name: opened.view.name,
        replaced: draft.replace === true,
        panel: opened.view.panels[0] || { n: 0 },
      }),
    )
  } catch (error) {
    ui.tabError.hidden = false
    ui.tabError.textContent = ''
    ui.tabError.appendChild(node('div', null, (error && error.message) || 'the core refused the tab'))
    var hint = error && error.hint
    if (hint) ui.tabError.appendChild(node('div', null, hint))
    ;((error && error.problems) || []).forEach(function (problem) {
      ui.tabError.appendChild(node('div', null, problem))
    })
  } finally {
    ui.tabCreate.disabled = false
    ui.tabName.focus()
  }
}

/*
 * The name sheet, shared by Rename and Duplicate. What is being named is held here: the menu that
 * asked is gone by the time the person presses the button, and the sheet is the only thing left that
 * knows which tab the question is about.
 */
var naming = null

export function openNameSheet(mode, name) {
  if (!state.project || !name) return
  var copy = mode === 'duplicate' ? nameSheet.duplicate : nameSheet.rename
  naming = { mode: mode === 'duplicate' ? 'duplicate' : 'rename', name: name }
  ui.renameTitle.textContent = copy.title
  ui.renameNote.textContent = copy.note
  ui.renameConfirm.querySelector('span').textContent = copy.confirm
  ui.renameError.hidden = true
  ui.renameError.textContent = ''
  // A copy's name suggests itself and is the reason the field is selected: the person is one word
  // away from accepting it, and one keystroke away from replacing it.
  ui.renameInput.value = naming.mode === 'duplicate' ? name + ' copy' : name
  ui.renameDialog.showModal()
  ui.renameInput.focus()
  ui.renameInput.select()
}

/** The sheet's one button: ask the act for the name, and say a refusal where the name was typed. */
async function submitName(event) {
  event.preventDefault()
  if (!naming) return
  var next = ui.renameInput.value.trim()
  if (next === '') {
    ui.renameError.hidden = false
    ui.renameError.textContent = 'A tab needs a name.'
    ui.renameInput.focus()
    return
  }
  var act = naming.mode === 'duplicate' ? duplicateTab : renameTab
  var about = naming
  ui.renameConfirm.disabled = true
  try {
    var opened = await act(about.name, next, function (error) {
      ui.renameError.hidden = false
      ui.renameError.textContent = refusal((error && error.message) || 'the tab could not be renamed')
      var hint = error && error.hint
      if (hint) ui.renameError.textContent += ' ' + refusal(hint)
    })
    if (opened === null) {
      ui.renameInput.focus()
      ui.renameInput.select()
      return
    }
    naming = null
    ui.renameDialog.close()
    focusFirstField()
  } finally {
    ui.renameConfirm.disabled = false
  }
}

/** The tab sheets' controls: new tab, the name sheet, and the axis pickers that follow the dataset. */
export function wireTabs() {
  ui.newTab.addEventListener('click', openTabDialog)
  ui.tabForm.addEventListener('submit', createTab)
  ui.tabCancel.addEventListener('click', function () {
    ui.tabDialog.close()
  })
  ui.tabDataset.addEventListener('change', fillTabAxes)
  ui.tabPanel.addEventListener('change', fillTabAxes)
  ui.tabName.addEventListener('input', syncTabReplace)
  ui.renameForm.addEventListener('submit', submitName)
  ui.renameCancel.addEventListener('click', function () {
    naming = null
    ui.renameDialog.close()
  })
}

actions.openNameSheet = openNameSheet
