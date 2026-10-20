/*
 * Shared window state and the core seam.
 *
 * Every renderer module reads the same objects from here. Nothing in this file draws; it only holds
 * what the window knows and the one guarded call into `window.bench`.
 */
export const bridge = window.bench

export const state = {
  projects: [],
  project: null,
  views: [],
  view: null,
  opened: null,
  problem: null,
  // A registry keeps entries for folders that were moved or were temporary. Showing them by
  // default turns the rail into a graveyard; hiding them by default would hide a real project
  // someone moved. So: hide, and say how many are hidden.
  showMissing: false,
  // Entry state. `lastPoint` is this window's own append, which is the only thing Undo may
  // retract: a retraction of someone else's record is a different act, done on purpose.
  lastPoint: null,
  busy: false,
  entryKey: null,
  timing: null,
  status: null,
  // A selected record, which the entry bar edits instead of adding: `correction` is what the
  // core said about it, `selection` is where its ring is, so switching panels can clear it.
  correction: null,
  selection: null,
  // The datasets this project has, and the recipe catalog (fetched the first time a tab is built).
  datasets: [],
  recipes: null,
  // Where a point lands when the project has no tab open yet, which is every project right after
  // it is created.
  projectEntry: null,
  shapeChoice: null,
  // The `dir\0name` the main process is watching, so the same tab is not re-registered on every
  // repaint. `null` means nothing is being watched.
  watching: null,
  // The import sheet: the file on disk, the core's read of it, and whether a write is in flight.
  importFile: null,
  importPreview: null,
  importBusy: false,
  // The set of source columns with no shape field, so checking "ignore" is reset when a
  // mapping change gives the acknowledgement a different meaning.
  importExtraKey: null,
}

export function node(tag, className, text) {
  var element = document.createElement(tag)
  if (className) element.className = className
  if (text !== undefined) element.textContent = text
  return element
}

export const ui = {
  projects: document.getElementById('projects'),
  tabs: document.getElementById('tabs'),
  tabCount: document.getElementById('tab-count'),
  railFoot: document.getElementById('rail-foot'),
  crumb: document.getElementById('crumb'),
  title: document.getElementById('view-title'),
  meta: document.getElementById('view-meta'),
  grid: document.getElementById('panel-grid'),
  empty: document.getElementById('empty'),
  notice: document.getElementById('notice'),
  tooltip: document.getElementById('tooltip'),
  toggleMissing: document.getElementById('toggle-missing'),
  entry: document.getElementById('entry'),
  entryFields: document.getElementById('entry-fields'),
  entryAdd: document.getElementById('entry-add'),
  entryUndo: document.getElementById('entry-undo'),
  entryCorrect: document.getElementById('entry-correct'),
  entryCorrectLabel: document.getElementById('entry-correct-label'),
  entryCancel: document.getElementById('entry-cancel'),
  entryReadout: document.getElementById('entry-readout'),
  entryStatus: document.getElementById('entry-status'),
  newTab: document.getElementById('new-tab'),
  tabDialog: document.getElementById('tab-dialog'),
  tabForm: document.getElementById('tab-form'),
  tabName: document.getElementById('tab-name'),
  tabDataset: document.getElementById('tab-dataset'),
  tabPanel: document.getElementById('tab-panel'),
  tabAxes: document.getElementById('tab-axes'),
  tabXField: document.getElementById('tab-x-field'),
  tabYField: document.getElementById('tab-y-field'),
  tabAxesNote: document.getElementById('tab-axes-note'),

  tabReplace: document.getElementById('tab-replace'),
  tabReplaceField: document.getElementById('tab-replace-field'),
  tabNote: document.getElementById('tab-note'),
  tabError: document.getElementById('tab-error'),
  tabCreate: document.getElementById('tab-create'),
  tabCancel: document.getElementById('tab-cancel'),
  importOpen: document.getElementById('import-open'),
  importDialog: document.getElementById('import-dialog'),
  importForm: document.getElementById('import-form'),
  importPick: document.getElementById('import-pick'),
  importPath: document.getElementById('import-path'),
  importSummary: document.getElementById('import-summary'),
  importPreview: document.getElementById('import-preview'),
  importFields: document.getElementById('import-fields'),
  importTime: document.getElementById('import-time'),
  importExtraField: document.getElementById('import-extra-field'),
  importIgnoreExtra: document.getElementById('import-ignore-extra'),
  importExtraNames: document.getElementById('import-extra-names'),
  importPlan: document.getElementById('import-plan'),
  importForce: document.getElementById('import-force'),
  importForceField: document.getElementById('import-force-field'),
  importApply: document.getElementById('import-apply'),
  importCancel: document.getElementById('import-cancel'),
  importError: document.getElementById('import-error'),
  newProject: document.getElementById('new-project'),
  projectDialog: document.getElementById('project-dialog'),
  projectForm: document.getElementById('project-form'),
  projectName: document.getElementById('project-name'),
  projectFolder: document.getElementById('project-folder'),
  projectPick: document.getElementById('project-pick'),
  projectPreview: document.getElementById('project-preview'),
  projectShape: document.getElementById('project-shape'),
  projectCustom: document.getElementById('project-custom'),
  projectShapeName: document.getElementById('project-shape-name'),
  projectFields: document.getElementById('project-fields'),
  projectAddField: document.getElementById('project-add-field'),
  projectCreate: document.getElementById('project-create'),
  projectCancel: document.getElementById('project-cancel'),
  projectError: document.getElementById('project-error'),
}

/** Unwrap a guarded IPC result, keeping the refusal's hint and problems for display. */
export async function call(promise) {
  var result
  try {
    result = await promise
  } catch (error) {
    throw error
  }
  if (!result || result.ok !== true) {
    var refusal = new Error((result && result.error && result.error.message) || 'the core refused the call')
    refusal.hint = (result && result.error && result.error.hint) || null
    refusal.problems = (result && result.error && result.error.problems) || []
    throw refusal
  }
  return result.value
}

export function shortDate(iso) {
  if (typeof iso !== 'string') return ''
  var date = iso.slice(0, 10)
  var time = iso.slice(11, 16)
  return time ? date + ' ' + time : date
}

export function showFailure(title, error) {
  ui.empty.hidden = false
  ui.grid.hidden = true
  ui.entry.hidden = true
  ui.empty.textContent = ''
  ui.empty.appendChild(node('h2', null, title))
  ui.empty.appendChild(node('p', null, String((error && error.message) || error)))
  var hint = error && error.hint
  if (hint) ui.empty.appendChild(node('p', null, hint))
  var problems = (error && error.problems) || []
  for (var index = 0; index < problems.length; index += 1) {
    ui.empty.appendChild(node('p', null, problems[index]))
  }
}

export function showEmpty(title, message, command, action) {
  ui.empty.hidden = false
  ui.grid.hidden = true
  ui.entry.hidden = true
  ui.notice.hidden = true
  ui.empty.textContent = ''
  ui.empty.appendChild(node('h2', null, title))
  ui.empty.appendChild(node('p', null, message))
  if (command) {
    var line = node('p')
    line.appendChild(node('code', null, command))
    ui.empty.appendChild(line)
  }
  // An empty state that prints a CLI command is a door that opens the wrong way: offer the act
  // itself, and let the command stay as the second way to do it.
  if (action) {
    var row = node('p')
    var button = node('button', 'ghost', action.label)
    button.type = 'button'
    button.addEventListener('click', action.run)
    row.appendChild(button)
    ui.empty.appendChild(row)
  }
}
