/*
 * The window's state machine: which project is open, which tab is showing, and what to draw.
 *
 * Everything it displays comes from the core through `window.bench`. It formats dates and numbers,
 * and it decides nothing about correctness: a panel's state comes from the fingerprint check, its
 * facts from the file. If this file needed to know how a view is validated, the seam would be wrong.
 */
;(function () {
  'use strict'

  var bridge = window.bench
  var state = {
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
  }
  var settled = false

  function node(tag, className, text) {
    var element = document.createElement(tag)
    if (className) element.className = className
    if (text !== undefined) element.textContent = text
    return element
  }

  var ui = {
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
  }

  /** Unwrap a guarded IPC result, keeping the refusal's hint and problems for display. */
  async function call(promise) {
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

  function shortDate(iso) {
    if (typeof iso !== 'string') return ''
    var date = iso.slice(0, 10)
    var time = iso.slice(11, 16)
    return time ? date + ' ' + time : date
  }

  function showFailure(title, error) {
    ui.empty.hidden = false
    ui.grid.hidden = true
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

  function showEmpty(title, message, command) {
    ui.empty.hidden = false
    ui.grid.hidden = true
    ui.notice.hidden = true
    ui.empty.textContent = ''
    ui.empty.appendChild(node('h2', null, title))
    ui.empty.appendChild(node('p', null, message))
    if (command) {
      var line = node('p')
      line.appendChild(node('code', null, command))
      ui.empty.appendChild(line)
    }
  }

  function renderProjects() {
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
          project.exists ? 'opened ' + shortDate(project.lastOpened) : project.dir,
        ),
      )
      if (!project.exists) button.appendChild(node('span', 'item-flag', 'missing'))
      button.addEventListener('click', function () {
        openProject(project.dir)
      })
      item.appendChild(button)
      ui.projects.appendChild(item)
    })
  }

  function renderTabs() {
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
        openView(view.name)
      })
      item.appendChild(button)
      ui.tabs.appendChild(item)
    })
  }

  function renderFoot() {
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

  function factsFor(panel) {
    var parts = [panel.dataset]
    if (panel.recipe) {
      // A recipe with no parameters is the common case, and `drift {}` reads like a rendering bug.
      // Parameters appear only when there are some, exactly as the view file spells them.
      var params = panel.params && Object.keys(panel.params).length ? ' ' + JSON.stringify(panel.params) : ''
      parts.push(panel.recipe + params)
    } else {
      parts.push('plot')
    }
    if (panel.verdict) parts.push(panel.verdict)
    if (typeof panel.n === 'number') parts.push('n = ' + panel.n)
    return parts.join(' · ')
  }

  function renderView() {
    var view = state.view
    var opened = state.opened
    ui.crumb.textContent = state.project.name
    ui.title.textContent = view.name
    ui.empty.hidden = true
    ui.grid.hidden = false
    ui.grid.textContent = ''
    ui.grid.style.setProperty('--columns', String(view.layout.columns || 2))

    var total = view.panels.reduce(function (sum, panel) {
      return sum + (typeof panel.n === 'number' ? panel.n : 0)
    }, 0)
    var provenance = (view.panels[0] && view.panels[0].chart.provenance) || {}
    var meta = [
      provenance.dataset ? provenance.dataset + ' · ' + (provenance.shape || '') : null,
      view.panels.length + ' panel' + (view.panels.length === 1 ? '' : 's'),
      total + ' point' + (total === 1 ? '' : 's'),
    ].filter(Boolean)
    ui.meta.textContent = meta.join('   ·   ')

    var stale = opened.statuses.filter(function (status) {
      return status.state === 'stale' || status.state === 'missing'
    })
    if (stale.length > 0) {
      ui.notice.hidden = false
      ui.notice.textContent = ''
      ui.notice.appendChild(
        node(
          'span',
          null,
          stale.length +
            ' panel' +
            (stale.length === 1 ? '' : 's') +
            ' no longer describe this project. ' +
            (stale[0].detail || '') +
            '  Re-render with ',
        ),
      )
      ui.notice.appendChild(
        node('code', null, 'bench --project "' + state.project.dir + '" view render "' + view.name + '" --refresh'),
      )
    } else {
      ui.notice.hidden = true
    }

    view.panels.forEach(function (panel, index) {
      var status = opened.statuses[index] || { state: 'unchecked', detail: '' }
      var figure = node('figure', 'panel')
      var strip = node('div', 'panel-strip')
      var title = node('span', 'panel-title', panel.title || panel.chart.title || 'panel ' + (index + 1))
      var facts = node('span', 'panel-facts', factsFor(panel))
      var tools = node('div', 'panel-tools')
      var badge = node('span', 'badge ' + status.state, status.state)
      badge.title = status.detail || ''
      var zoom = node('span', 'zoom', '1.0×')
      var reset = node('button', 'ghost', 'Reset')
      reset.type = 'button'
      reset.title = 'Reset zoom (keyboard: 0)'
      tools.appendChild(badge)
      tools.appendChild(zoom)
      tools.appendChild(reset)
      // At 150% a two-column panel is only ~169 CSS px wide, so a long title ellipsizes. The native
      // tooltip is the affordance for the rest of it without spending rows on wrapping, which would
      // leave the two charts starting at different heights.
      title.title = title.textContent
      strip.appendChild(title)
      strip.appendChild(facts)
      strip.appendChild(tools)

      var host = node('div', 'panel-chart')
      host.tabIndex = 0
      host.setAttribute('role', 'img')
      host.setAttribute(
        'aria-label',
        title.textContent + '. ' + factsFor(panel) + '. ' + status.state + '. Drag to pan, wheel to zoom.',
      )
      figure.appendChild(strip)
      figure.appendChild(host)
      ui.grid.appendChild(figure)

      var handle = window.BenchCharts.mount(host, panel, opened.svgs[index], {
        zoomLabel: zoom,
        tooltip: ui.tooltip,
      })
      reset.addEventListener('click', function () {
        handle.reset()
      })
    })
  }

  async function openView(name) {
    try {
      state.opened = await call(bridge.view(state.project.dir, name))
      state.view = state.opened.view
      renderTabs()
      renderView()
    } catch (error) {
      state.view = null
      renderTabs()
      showFailure('Could not open “' + name + '”', error)
    }
  }

  async function afterOpen(opened) {
    state.project = { dir: opened.dir, name: opened.name }
    state.views = opened.views
    state.view = null
    state.opened = null
    ui.notice.hidden = true

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
    showEmpty(
      'No saved tabs',
      'This project has no views yet. A tab is a view file, and the CLI writes one:',
      'bench --project "' + opened.dir + '" view new "first tab" --dataset main --recipe fit',
    )
  }

  async function openProject(dir) {
    try {
      await afterOpen(await call(bridge.openProject(dir)))
    } catch (error) {
      showFailure('Could not open that project', error)
    }
  }

  async function pickProject() {
    try {
      var opened = await call(bridge.pickProject())
      if (!opened) return
      await afterOpen(opened)
    } catch (error) {
      showFailure('Could not open that project', error)
    }
  }

  function wire() {
    document.getElementById('open-project').addEventListener('click', pickProject)
    document.getElementById('open-project-main').addEventListener('click', pickProject)
    ui.toggleMissing.addEventListener('click', function () {
      state.showMissing = !state.showMissing
      renderProjects()
    })
  }

  async function boot() {
    wire()
    if (!bridge) {
      showFailure('The window cannot reach the core', new Error('preload bridge missing'))
      return
    }

    var startup = { projectDir: null }
    try {
      startup = await bridge.startup()
    } catch (error) {
      /* start without a hint */
    }

    try {
      var listed = await call(bridge.projects())
      state.projects = listed.projects
      state.problem = listed.problem || null
      renderProjects()
      if (state.problem) {
        ui.notice.hidden = false
        ui.notice.textContent = state.problem + ' — the project list is app state and can be deleted.'
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
        showEmpty(
          'No projects yet',
          'Create a project with the CLI, then open that folder here. Projects are folders; the window only reads them.',
          'bench init C:\\data\\sensor',
        )
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
})()
