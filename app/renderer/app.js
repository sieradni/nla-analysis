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

  function showEmpty(title, message, command, action) {
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

  /** The dataset count, not a sum of panel counts: two panels reading `main` used to add up to
   * twice the points in it, and a stale panel then made the total a number that was never true. */
  function renderMeta() {
    var view = state.view
    var entry = state.opened && state.opened.entry
    var total = view.panels.reduce(function (sum, panel) {
      return sum + (typeof panel.n === 'number' ? panel.n : 0)
    }, 0)
    var provenance = (view.panels[0] && view.panels[0].chart.provenance) || {}
    var active = entry ? entry.active : total
    // Which version the drawing came from is part of what the tab is claiming, so it sits beside
    // the dataset name rather than in a tooltip: `main \u00b7 v2` or `main \u00b7 v1 (now v2)`.
    // A tab may hold panels pinned to different versions — a refresh only repins the panels it
    // redraws — so the label names every version present, not whichever panel happens to be first.
    var dataset = provenance.dataset
    var pinned = []
    view.panels.forEach(function (panel) {
      if (panel.dataset !== dataset) return
      if (typeof panel.version !== 'number') return
      if (pinned.indexOf(panel.version) === -1) pinned.push(panel.version)
    })
    var now = entry && typeof entry.version === 'number' ? entry.version : undefined
    var versionLabel = null
    if (dataset && pinned.length > 0) {
      pinned.sort(function (left, right) {
        return left - right
      })
      var label =
        pinned.length === 1
          ? 'v' + pinned[0]
          : pinned
              .map(function (version) {
                return 'v' + version
              })
              .join(', ')
      // `now` is a fact about the dataset; it is worth saying only when no panel is drawn from it.
      var behind = typeof now === 'number' && pinned.indexOf(now) === -1
      versionLabel = label + (behind ? ' (now v' + now + ')' : '')
    }
    var meta = [
      provenance.dataset
        ? provenance.dataset + ' \u00b7 ' + (versionLabel ? versionLabel + ' \u00b7 ' : '') + (provenance.shape || '')
        : null,
      view.panels.length + ' panel' + (view.panels.length === 1 ? '' : 's'),
      active + ' point' + (active === 1 ? '' : 's'),
    ].filter(Boolean)
    ui.meta.textContent = meta.join('   \u00b7   ')
  }

  /** Staleness, said once, in the words a person would use. Shown from the statuses, never guessed. */
  function renderNotice() {
    var statuses = (state.opened && state.opened.statuses) || []
    var stale = statuses.filter(function (status) {
      return status.state === 'stale' || status.state === 'missing'
    })
    if (stale.length === 0) {
      ui.notice.hidden = true
      return
    }
    ui.notice.hidden = false
    ui.notice.textContent = ''
    ui.notice.appendChild(
      node(
        'span',
        null,
        stale.length +
          ' panel' +
          (stale.length === 1 ? '' : 's') +
          ' no longer ' +
          (stale.length === 1 ? 'describes' : 'describe') +          ' this project. ' +
          (stale[0].detail || '').replace(/\.?$/, '. ') +
          'Re-render with ',
        ),
      )
    ui.notice.appendChild(
      node('code', null, 'bench --project "' + state.project.dir + '" view render "' + state.view.name + '" --refresh'),
    )
  }

  /** Badges and the notice, from statuses alone: no drawing is touched, so this cannot cause a repaint. */
  function renderStatuses(statuses) {
    var badges = ui.grid.querySelectorAll('.panel-strip .badge')
    statuses.forEach(function (status, index) {
      var badge = badges[index]
      if (!badge) return
      badge.className = 'badge ' + status.state
      badge.textContent = status.state
      badge.title = status.detail || ''
    })
    renderNotice()
  }

  function renderView(restore) {
    var view = state.view
    var opened = state.opened
    ui.crumb.textContent = state.project.name
    ui.title.textContent = view.name
    ui.empty.hidden = true
    ui.grid.hidden = false
    // The charts are rebuilt in one synchronous pass, so a repaint is one paint and cannot flicker.
    // Scroll and the per-panel crop are carried across it: typing a number must not throw away the
    // zoom the user was reading.
    var scrollTop = restore ? restore.scrollTop : 0
    // A repaint replaces every panel, including one the keyboard was in; remember which so focus can
    // go back to it rather than to the document body.
    var focusedPanel = Array.prototype.indexOf.call(
      ui.grid.querySelectorAll('.panel-chart'),
      document.activeElement,
    )
    ui.grid.textContent = ''
    ui.grid.style.setProperty('--columns', String(view.layout.columns || 2))
    // A repaint replaces every panel handle, so a ring drawn on the previous drawing is gone with
    // it: forget the pointer rather than calling into a handle that no longer exists.
    state.selection = null

    renderMeta()
    renderNotice()
    state.handles = []

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
        viewBox: restore && restore.viewBoxes ? restore.viewBoxes[index] : null,
        onSelect: function (id) {
          selectPoint(id, index)
        },
      })
      state.handles[index] = handle
      reset.addEventListener('click', function () {
        handle.reset()
      })
    })

    var hosts = ui.grid.querySelectorAll('.panel-chart')
    if (focusedPanel >= 0 && hosts[focusedPanel]) hosts[focusedPanel].focus()
    ui.grid.scrollTop = scrollTop
    renderEntry()
    watchOpenTab()
  }

  /**
   * Tell the main process which tab is on screen. The watcher lives there because the main process
   * owns the filesystem (ADR 0003); the window only says what it is drawing.
   */
  function watchOpenTab() {
    if (!bridge.watch) return
    var name = state.view ? state.view.name : null
    var key = state.project && name !== null ? state.project.dir + '\u0000' + name : null
    if (key === state.watching) return
    state.watching = key
    call(bridge.watch(state.project ? state.project.dir : null, name)).catch(function (error) {
      // The tab still works without a watcher; it just will not follow the project, and says so.
      setStatus('error', 'This tab will not follow the project on disk: ' + ((error && error.message) || error))
    })
  }

  // --- entry ----------------------------------------------------------------------------------

  /**
   * Typed text to a point value. The window does not get a second opinion about what a number is: a
   * value it cannot parse is passed through as text, and the shape's own validation refuses it with
   * the message the CLI would give. That is why the same typo reads the same in both places.
   */
  function coerceValue(field, text) {
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

  function entryInputs() {
    return Array.prototype.map.call(ui.entryFields.querySelectorAll('input'), function (input) {
      return input
    })
  }

  function fieldValueMap() {
    var values = {}
    entryInputs().forEach(function (input) {
      var text = input.value.trim()
      if (text === '') return
      var field = { name: input.dataset.field, type: input.dataset.type }
      values[field.name] = coerceValue(field, text)
    })
    return values
  }

  function buildEntryFields(entry, prefill, mode) {
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

  function focusFirstField() {
    var inputs = entryInputs()
    if (!ui.entry.hidden && inputs.length > 0) inputs[0].focus()
  }

  /** Mark the fields a refusal named, and hand back the first one so focus can go there. */
  function markProblems(problems) {
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

  function renderStatus() {
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

  function setStatus(kind, text, problems) {
    state.status = { kind: kind, text: text, problems: problems || [] }
    renderStatus()
  }

  function renderEntry() {
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

  /** Scroll and per-panel crop, captured before a repaint and put back after it. */
  function captureRestore() {
    var svgs = ui.grid.querySelectorAll('.panel-chart svg')
    return {
      scrollTop: ui.grid.scrollTop,
      viewBoxes: Array.prototype.map.call(svgs, function (svg) {
        return svg.getAttribute('viewBox')
      }),
    }
  }

  function describeValues(values) {
    return Object.keys(values)
      .map(function (name) {
        return name + ' ' + String(values[name])
      })
      .join('  ')
  }

  async function submitEntry(event) {
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
        var refreshed = await call(bridge.refreshView(state.project.dir, state.view.name, { draw: true }))
        afterRebuild = performance.now()
        state.opened = refreshed
        state.view = refreshed.view
        renderTabs()
        renderView(captureRestore())
      } else {
        applyMarks(recorded.marks, recorded.values, recorded.active)
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
   * Put the marks the core just produced into the drawing that is already on screen.
   *
   * Inserted directly after the last existing mark, which is where a redraw would have put it: the
   * axis rules are drawn after the points, so appending at the end of the document would put a mark
   * on top of them. Nothing else in the SVG is touched, so no other coordinate can drift.
   */
  function applyMarks(marks, values, active) {
    marks.forEach(function (mark) {
      var figure = ui.grid.children[mark.index]
      if (!figure) return
      var svg = figure.querySelector('.panel-chart svg')
      if (!svg) return
      var circles = svg.querySelectorAll('circle[data-point-id]')
      var last = circles[circles.length - 1]
      if (last) last.insertAdjacentHTML('afterend', mark.markup)
      else svg.insertAdjacentHTML('beforeend', mark.markup)
      var handle = state.handles[mark.index]
      if (handle && handle.addMark) {
        handle.addMark(mark.id, mark.cx, mark.cy, { id: mark.id, x: values.x, y: values.y })
      }
    })
    if (state.opened && state.opened.entry) state.opened.entry.active = active
    renderMeta()
  }

  /**
   * The tab's own bookkeeping, after the paint: rebuild the stored spec, save the file, recompute
   * staleness. Anything that fails here is said out loud — a tab whose file quietly stopped matching
   * its drawing is worse than a tab that says it could not save.
   */
  async function catchUp() {
    var viewName = state.view ? state.view.name : null
    if (!viewName) return
    var startedAt = performance.now()
    try {
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
  async function selectPoint(id, index) {
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
  function closeCorrection() {
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
  async function submitCorrection() {
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

  async function undoPoint() {
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

  async function openView(name) {
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
      if (state.opened.reread) {
        setStatus(
          'ok',
          'The log had changed on disk since this window read it, so it was reread before this tab was drawn.',
        )
      }
      // The product is typing a number. Opening a tab puts the cursor where that happens; Tab still
      // reaches the panel for keyboard pan and zoom.
      focusFirstField()
    } catch (error) {
      state.view = null
      renderTabs()
      showFailure('Could not open “' + name + '”', error)
    }
  }

  async function afterOpen(opened) {
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
    showEmpty(
      'No saved tabs',
      'A tab is a saved question: which dataset it reads, and which recipe draws it.',
      'bench --project "' + opened.dir + '" view new "first tab" --dataset main --recipe fit',
      { label: 'Create a tab…', run: openTabDialog },
    )
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
  function applyChange(change) {
    if (!state.project || change.dir !== state.project.dir) return
    // A write is in flight: its own response is about to draw the state after that write, and the
    // main process asks again once the call settles. Repainting underneath it would race both.
    if (state.busy) return

    if (change.state === 'error') {
      setStatus('error', 'The project changed on disk, but this tab could not be reread: ' + change.message)
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
      showEmpty(
        'This tab was removed',
        '“' +
          change.name +
          '” is no longer in views/. Another writer replaced or deleted it; the project is still open.',
        'bench --project "' + state.project.dir + '" view list',
        { label: 'Create a tab…', run: openTabDialog },
      )
      // The empty state hid the bar; the project can still take a point, and a field that was being
      // typed into gets its cursor back.
      renderEntry()
      if (hadFocus) {
        var input = ui.entryFields.querySelector('input[data-field="' + hadFocus + '"]')
        if (input) input.focus()
      }
      setStatus(
        'ok',
        '“' +
          change.name +
          '” was removed on disk. ' +
          (change.views.length === 0 ? 'This project has no tabs left.' : change.views.length + ' other tab(s) remain.'),
      )
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
        'The project changed on disk: “' +
          state.view.name +
          '” was reread and redrawn' +
          (change.view.entry ? ' · ' + change.view.entry.active + ' active in ' + change.view.entry.dataset : '') +
          '.',
      )
    }
  }

  // --- tabs ------------------------------------------------------------------------------------

  /** Put the project's datasets in the select, and the catalog in the panel select once it arrives. */
  function fillTabDialog() {
    ui.tabDataset.textContent = ''
    state.datasets.forEach(function (dataset) {
      var option = node('option', null, dataset.id + ' · ' + dataset.shape + ' · ' + dataset.active + ' points')
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

    var problem = state.recipes && state.recipes.problem
    ui.tabNote.textContent = problem
      ? 'No recipe is offered because the analysis runtime is not available: ' + problem
      : 'A recipe panel is built by the analysis runtime; a plot panel needs nothing but the log.'
  }

  /**
   * The one dialog that writes a view file. It offers datasets and recipes and never a free-form
   * panel: what it can build is exactly what `bench view new` can build.
   */
  async function openTabDialog() {
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
  function syncTabReplace() {
    var name = ui.tabName.value.trim().toLowerCase()
    var taken = name !== '' && state.views.some(function (view) {
      return view.name.toLowerCase() === name
    })
    ui.tabReplaceField.hidden = !taken
    if (!taken) ui.tabReplace.checked = false
  }

  // --- import ---------------------------------------------------------------------------------

  function fileBase(path) {
    return String(path || '').split(/[\\/]/).pop() || path
  }

  /** A refusal from the core, in the words the CLI would use, inside the sheet that asked. */
  function showImportError(error) {
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
  function renderImportPreview(preview) {
    var notes = [
      preview.rows + ' row(s)',
      preview.columns.length + ' column(s)',
      'into ' + preview.dataset + ' (' + preview.shape + ')',
    ]
    if (preview.comments > 0) notes.push(preview.comments + ' comment line(s) skipped')
    if (preview.raggedRows > 0) notes.push(preview.raggedRows + ' row(s) with a different field count')
    if (preview.duplicate) notes.push('these exact contents are already in this dataset')
    // The version this becomes, said before the mapping is chosen: an import into a dataset that
    // already holds rows replaces them, and that is not something to discover afterwards.
    notes.push(
      preview.parent === null
        ? 'creates version 1'
        : 'replaces version ' + preview.parent + ' (' + preview.parentRows + ' row(s)) as version ' + preview.version,
    )
    var unmapped = preview.fields
      .filter(function (field) {
        return !field.optional && !preview.suggested[field.name]
      })
      .map(function (field) {
        return field.name
      })
    if (unmapped.length > 0) notes.push('map a column onto ' + unmapped.join(', '))
    ui.importSummary.textContent = notes.join(' · ')

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

    // The one column that cannot be guessed for the reader: a row is its instant, so the sheet
    // offers every column and preselects the name that looks like a time, or nothing.
    ui.importTime.textContent = ''
    var noTime = node('option', null, '— choose the column')
    noTime.value = ''
    ui.importTime.appendChild(noTime)
    preview.columns.forEach(function (column) {
      var option = node('option', null, column)
      option.value = column
      ui.importTime.appendChild(option)
    })
    ui.importTime.value = preview.suggestedTime || ''

    // A plan for the *previous* file must not land on this one: the token retires it.
    state.importPlanToken = (state.importPlanToken || 0) + 1
    renderImportPlan(null)

    // Only a file whose exact bytes are already in the log gets the second door.
    ui.importForceField.hidden = !preview.duplicate
    ui.importForce.checked = false
  }

  /** The mapping the sheet is showing, as the core wants it: field name to column. */
  function importMapping() {
    var mapping = {}
    ;(ui.importFields.querySelectorAll('select') || []).forEach(function (select) {
      if (select.value === '') return
      mapping[select.dataset.field] = select.value
    })
    return mapping
  }

  /** The planned version and diff, or the word a refusal deserves, in one line. */
  function renderImportPlan(planned, refusal) {
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
    var counts =
      '+' + planned.diff.added + ' \u2212' + planned.diff.removed + ' ~' + planned.diff.changed
    var parts = [
      planned.parent === null
        ? 'version 1 · ' + planned.rows + ' row(s)'
        : 'version ' + planned.version + ' replaces version ' + planned.parent + ' · ' + counts,
    ]
    if (planned.removedRows.length > 0) {
      var leaving = planned.removedRows.slice(0, 3).map(function (row) {
        return shortTime(row.t)
      })
      parts.push(
        planned.removedRows.length +
          ' row(s) not in this file are withdrawn (' +
          leaving.join(', ') +
          (planned.removedRows.length > leaving.length ? ', \u2026' : '') +
          '), not deleted',
      )
    }
    if (planned.warnings.length > 0) parts.push(planned.warnings[0])
    ui.importPlan.textContent = parts.join(' \u00b7 ')
  }

  /** `2026-01-05T09:04:00.000Z` → `2026-01-05 09:04`, because a row is named by its instant. */
  function shortTime(value) {
    if (typeof value !== 'string' || value.length < 16) return String(value)
    return value.slice(0, 10) + ' ' + value.slice(11, 16)
  }

  /**
   * Ask the core what the current mapping would do, without writing anything. The token drops a
   * slower answer that arrives after a newer one, so the line never shows a stale plan.
   */
  async function syncImportPlan() {
    var preview = state.importPreview
    if (!preview || !state.importFile || state.importBusy) return
    var mapping = importMapping()
    if (Object.keys(mapping).length === 0) {
      renderImportPlan(null)
      return
    }
    // Said before the core is asked, because there is nothing to plan without it — and the point
    // is not to let the core invent instants quietly.
    if (ui.importTime.value === '') {
      renderImportPlan(null, 'choose the column that holds the observation time')
      return
    }
    var token = ++state.importPlanToken
    try {
      var planned = await call(
        bridge.importPlan(state.project.dir, state.importFile, mapping, {
          force: ui.importForce.checked,
          time: ui.importTime.value,
        }),
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

  async function openImportDialog() {
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

  async function loadImportFile(file) {
    state.importFile = file
    state.importPreview = null
    ui.importPath.textContent = file
    ui.importPath.title = file
    ui.importSummary.textContent = 'Reading ' + fileBase(file) + '…'
    ui.importPreview.textContent = ''
    ui.importFields.textContent = ''
    ui.importForceField.hidden = true
    ui.importError.hidden = true
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

  async function submitImport(event) {
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
        bridge.importFile(state.project.dir, state.importFile, mapping, {
          force: ui.importForce.checked,
          time: ui.importTime.value,
          viewName: state.view ? state.view.name : undefined,
        }),
      )
      ui.importDialog.close()
      if (imported.view) {
        state.opened = imported.view
        state.view = imported.view.view
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
      var counts =
        '+' + imported.diff.added + ' \u2212' + imported.diff.removed + ' ~' + imported.diff.changed
      var note =
        'Imported ' +
        imported.rows +
        ' row(s) into ' +
        imported.dataset +
        ' as version ' +
        imported.version +
        ' (' +
        (imported.parent === null ? 'first version' : counts + ', replacing version ' + imported.parent) +
        ') from ' +
        fileBase(state.importFile) +
        '. The original is preserved at ' +
        imported.preserved +
        '.'
      if (imported.parent !== null && imported.removedRows.length > 0) {
        note +=
          ' ' +
          imported.removedRows.length +
          ' row(s) not in the file were withdrawn from version ' +
          imported.version +
          '; version ' +
          imported.parent +
          ' still holds them.'
      }
      if (imported.warnings.length > 0) note += ' warning: ' + imported.warnings[0]
      setStatus('ok', note)
      focusFirstField()
    } catch (error) {
      ui.importApply.disabled = false
      showImportError(error)
    } finally {
      state.importBusy = false
      state.busy = false
    }
  }

  // --- projects -------------------------------------------------------------------------------

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

  async function openProjectDialog() {
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

  async function submitProject(event) {
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
      await afterOpen(opened)
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

  async function createTab(event) {
    event.preventDefault()
    if (!state.project) return
    var recipe = ui.tabPanel.value === 'plot' ? undefined : ui.tabPanel.value
    var draft = {
      name: ui.tabName.value.trim(),
      dataset: ui.tabDataset.value,
      ...(recipe === undefined ? {} : { recipe: recipe }),
      ...(ui.tabReplace.checked ? { replace: true } : {}),
    }
    ui.tabCreate.disabled = true
    ui.tabError.hidden = true
    try {
      var opened = await call(bridge.writeView(state.project.dir, draft))
      var listed = await call(bridge.views(state.project.dir))
      state.views = listed.views
      state.opened = opened
      state.view = opened.view
      state.correction = null
      state.selection = null
      state.lastPoint = null
      state.entryKey = null
      state.timing = null
      ui.tabDialog.close()
      renderTabs()
      renderView()
      focusFirstField()
      var facts = opened.view.panels[0] ? factsFor(opened.view.panels[0]) : ''
      setStatus(
        'ok',
        (draft.replace ? 'Replaced' : 'Created') +
          ' tab “' +
          opened.view.name +
          '” · ' +
          facts +
          '. It is a view file, so the next session can draw it again.',
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
    ui.newTab.addEventListener('click', openTabDialog)
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
    ui.tabForm.addEventListener('submit', createTab)
    ui.tabCancel.addEventListener('click', function () {
      ui.tabDialog.close()
    })
    ui.tabName.addEventListener('input', syncTabReplace)
    ui.importOpen.addEventListener('click', openImportDialog)
    ui.importPick.addEventListener('click', openImportDialog)
    ui.importForm.addEventListener('submit', submitImport)
    // A refusal belongs to the mapping that produced it; choosing a column clears it rather than
    // leaving an error about a mapping the user has already changed. Either way the planned version
    // is recomputed, because it is a fact about the mapping and not about the click.
    ui.importFields.addEventListener('change', function () {
      ui.importError.hidden = true
      syncImportPlan()
    })
    ui.importTime.addEventListener('change', function () {
      ui.importError.hidden = true
      syncImportPlan()
    })
    ui.importForce.addEventListener('change', syncImportPlan)
    ui.importCancel.addEventListener('click', function () {
      ui.importDialog.close()
    })

    ui.toggleMissing.addEventListener('click', function () {
      state.showMissing = !state.showMissing
      renderProjects()
    })
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

  async function boot() {
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
      ui.projectShape.options[0].textContent =
        state.shapeChoice.id +
        ' · ' +
        state.shapeChoice.fields
          .map(function (field) {
            return field.name + ' (' + field.type + ')'
          })
          .join(', ')
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
          'A project is a folder with an append-only log. Create one here, or open a folder the CLI made.',
          'bench init C:\\data\\sensor',
          { label: 'Create a project…', run: openProjectDialog },
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
