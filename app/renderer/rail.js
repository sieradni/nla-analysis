/* The left rail: projects, saved tabs, and the folder the open project lives in. */
import { state, ui, node } from './state.js'
import { formatDay } from './copy.js'
import { actions } from './navigation.js'

export function renderProjects() {
  ui.projects.textContent = ''
  var missing = state.projects.filter(function (project) {
    return !project.exists
  })
  ui.toggleMissing.hidden = missing.length === 0
  ui.toggleMissing.textContent = state.showMissing
    ? 'Hide ' + missing.length + ' missing'
    : 'Show ' + missing.length + ' missing'

  var visible = state.projects.filter(function (project) {
    return state.showMissing || project.exists
  })

  if (visible.length === 0) {
    var none = node('li', 'item-sub', missing.length ? 'Every recorded project is missing' : 'No projects recorded yet')
    ui.projects.appendChild(none)
    return
  }
  visible.forEach(function (project) {
    var item = document.createElement('li')
    var button = node('button', 'item')
    button.type = 'button'
    button.setAttribute('aria-current', state.project && state.project.dir === project.dir ? 'true' : 'false')
    button.appendChild(node('span'))
    button.firstChild.appendChild(node('span', 'item-name', project.name))
    button.firstChild.appendChild(
      node(
        'span',
        'item-sub',
        project.exists ? 'opened ' + formatDay(project.lastOpened) : project.dir,
      ),
    )
    if (!project.exists) button.appendChild(node('span', 'item-flag', 'missing'))
    button.addEventListener('click', function () {
      actions.openProject(project.dir)
    })
    item.appendChild(button)
    ui.projects.appendChild(item)
  })
}

export function renderTabs() {
  ui.tabs.textContent = ''
  ui.tabCount.textContent = state.views.length ? String(state.views.length) : ''
  // An empty rail section reads as broken. One line saying what will appear there is enough, and
  // it keeps the empty window honest: the window has no tabs of its own to offer.
  if (!state.project) {
    ui.tabs.appendChild(node('li', 'item-sub', 'Tabs appear once a project is open'))
    return
  }
  if (state.views.length === 0) {
    ui.tabs.appendChild(node('li', 'item-sub', 'No saved tabs'))
    return
  }
  state.views.forEach(function (view) {
    var item = document.createElement('li')
    var button = node('button', 'item')
    button.type = 'button'
    button.setAttribute('aria-current', state.view && state.view.name === view.name ? 'true' : 'false')
    button.appendChild(node('span'))
    button.firstChild.appendChild(node('span', 'item-name', view.name))
    var facts = view.panels + ' panel' + (view.panels === 1 ? '' : 's')
    if (view.recipes.length) facts += ' · ' + view.recipes.join(', ')
    button.firstChild.appendChild(node('span', 'item-sub', facts))
    button.addEventListener('click', function () {
      actions.openView(view.name)
    })
    item.appendChild(button)
    ui.tabs.appendChild(item)
  })
}

export function renderFoot() {
  ui.railFoot.textContent = ''
  if (!state.project) {
    ui.railFoot.textContent = 'Projects are recorded when opened; the list is disposable.'
    return
  }
  var line = node('div', null, 'Project folder')
  var path = node('code', null, state.project.dir)
  path.style.display = 'block'
  path.style.overflow = 'hidden'
  path.style.textOverflow = 'ellipsis'
  path.style.whiteSpace = 'nowrap'
  ui.railFoot.appendChild(line)
  ui.railFoot.appendChild(path)
}
