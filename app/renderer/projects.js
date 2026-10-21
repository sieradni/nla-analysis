/* The project sheet: create a project, pick a folder, and open a project from the rail. */
import { state, ui, node, bridge, call, showFailure } from './state.js'
import { setStatus } from './status.js'
import { focusFirstField } from './fields.js'
import { actions } from './navigation.js'

/** One row of the custom-shape editor: a name, a type the core declared, and a way to drop it. */
function shapeFieldRow(name, type) {
  var row = node('div', 'sheet-field')
  var fieldName = document.createElement('input')
  fieldName.type = 'text'
  fieldName.value = name || ''
  fieldName.dataset.role = 'field-name'
  fieldName.setAttribute('aria-label', 'field name')
  var fieldType = document.createElement('select')
  fieldType.dataset.role = 'field-type'
  fieldType.setAttribute('aria-label', 'field type')
  ;((state.shapeChoice && state.shapeChoice.types) || []).forEach(function (option) {
    var item = node('option', null, option)
    item.value = option
    fieldType.appendChild(item)
  })
  fieldType.value = type || 'number'
  var remove = node('button', 'ghost', 'Remove')
  remove.type = 'button'
  remove.addEventListener('click', function () {
    row.remove()
    syncProjectPreview()
  })
  row.appendChild(fieldName)
  row.appendChild(fieldType)
  row.appendChild(remove)
  ui.projectFields.appendChild(row)
}

/** The folder the project will be created in, said before the click that creates it. */
function syncProjectPreview() {
  var name = ui.projectName.value.trim()
  var folder = ui.projectFolder.value.trim().replace(/[\\/]+$/, '')
  if (folder === '') {
    ui.projectPreview.textContent = 'Choose the folder this project should live in.'
    return
  }
  var slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project'
  ui.projectPreview.textContent = folder + '/' + slug
}

export async function openProjectDialog() {
  ui.projectError.hidden = true
  ui.projectName.value = ''
  ui.projectFolder.value = ''
  ui.projectShape.value = 'default'
  ui.projectCustom.hidden = true
  ui.projectFields.textContent = ''
  syncProjectPreview()
  ui.projectDialog.showModal()
  ui.projectName.focus()
}

export async function submitProject(event) {
  event.preventDefault()
  var name = ui.projectName.value.trim()
  var folder = ui.projectFolder.value.trim()
  var shape
  if (ui.projectShape.value === 'custom') {
    var names = ui.projectFields.querySelectorAll('[data-role="field-name"]')
    var types = ui.projectFields.querySelectorAll('[data-role="field-type"]')
    var fields = Array.prototype.map.call(names, function (input, index) {
      return { name: input.value.trim(), type: types[index].value }
    })
    var id = ui.projectShapeName.value.trim()
    shape = { id: /\.v[0-9]+$/.test(id) ? id : id + '.v1', fields: fields }
  }

  ui.projectCreate.disabled = true
  ui.projectError.hidden = true
  try {
    var opened = await call(bridge.createProject(folder, name, shape))
    ui.projectDialog.close()
    await actions.afterOpen(opened)
    var entry = state.projectEntry
    setStatus(
      'ok',
      'Created project “' +
        opened.name +
        '” at ' +
        opened.dir +
        ' · shape ' +
        (entry ? entry.shape : 'none') +
        (entry && entry.fields.length ? ' (' + entry.fields.map(function (f) { return f.name }).join(', ') + ')' : '') +
        '. Type a point below, or create a tab.',
    )
    focusFirstField()
  } catch (error) {
    ui.projectError.hidden = false
    ui.projectError.textContent = ''
    ui.projectError.appendChild(node('div', null, (error && error.message) || 'the core refused the project'))
    var hint = error && error.hint
    if (hint) ui.projectError.appendChild(node('div', null, hint))
    ;((error && error.problems) || []).forEach(function (problem) {
      ui.projectError.appendChild(node('div', null, problem))
    })
  } finally {
    ui.projectCreate.disabled = false
  }
}

export async function openProject(dir) {
  try {
    await actions.afterOpen(await call(bridge.openProject(dir)))
  } catch (error) {
    showFailure('Could not open that project', error)
  }
}

export async function pickProject() {
  try {
    var opened = await call(bridge.pickProject())
    if (!opened) return
    await actions.afterOpen(opened)
  } catch (error) {
    showFailure('Could not open that project', error)
  }
}

/** The project sheet's own controls: the rail's open buttons, the create form, and the folder picker. */
export function wireProjects() {
  document.getElementById('open-project').addEventListener('click', pickProject)
  document.getElementById('open-project-main').addEventListener('click', pickProject)
  ui.newProject.addEventListener('click', openProjectDialog)
  ui.projectForm.addEventListener('submit', submitProject)
  ui.projectCancel.addEventListener('click', function () {
    ui.projectDialog.close()
  })
  ui.projectName.addEventListener('input', syncProjectPreview)
  ui.projectFolder.addEventListener('input', syncProjectPreview)
  ui.projectPick.addEventListener('click', async function () {
    try {
      var chosen = await call(bridge.pickFolder())
      if (!chosen) return
      ui.projectFolder.value = chosen
      syncProjectPreview()
      ui.projectName.focus()
    } catch (error) {
      ui.projectError.hidden = false
      ui.projectError.textContent = 'Could not open the folder picker: ' + ((error && error.message) || error)
    }
  })
  ui.projectShape.addEventListener('change', function () {
    var custom = ui.projectShape.value === 'custom'
    ui.projectCustom.hidden = !custom
    if (custom && ui.projectFields.children.length === 0) {
      shapeFieldRow('x', 'number')
      shapeFieldRow('y', 'number')
      ui.projectShapeName.focus()
    }
  })
  ui.projectAddField.addEventListener('click', function () {
    shapeFieldRow('', 'number')
  })
}
