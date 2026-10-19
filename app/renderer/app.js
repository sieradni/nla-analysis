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
    entryReadout: document.getElementById('entry-readout'),
    entryStatus: document.getElementById('entry-status'),
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

  function showEmpty(title, message, command) {
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
    var meta = [
      provenance.dataset ? provenance.dataset + ' \u00b7 ' + (provenance.shape || '') : null,
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
    ui.grid.textContent = ''
    ui.grid.style.setProperty('--columns', String(view.layout.columns || 2))

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
      })
      state.handles[index] = handle
      reset.addEventListener('click', function () {
        handle.reset()
      })
    })

    ui.grid.scrollTop = scrollTop
    renderEntry()
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

  function buildEntryFields(entry) {
    var key =
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
    ui.entryStatus.hidden = !status
    ui.entryStatus.className = 'entry-status' + (status && status.kind === 'error' ? ' is-error' : '')
    ui.entryStatus.textContent = ''
    if (!status) return
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
    var entry = state.opened && state.opened.entry
    var visible = Boolean(state.view && entry && entry.fields.length > 0)
    ui.entry.hidden = !visible
    ui.entryReadout.textContent = ''
    if (!visible) {
      state.entryKey = null
      return
    }

    buildEntryFields(entry)
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
    if (state.busy || !state.opened || !state.opened.entry) return
    var entry = state.opened.entry
    var values = fieldValueMap()
    var startedAt = performance.now()
    state.busy = true
    renderEntry()

    try {
      var recorded = await call(
        bridge.recordPoint(
          state.project.dir,
          { dataset: entry.dataset, values: values },
          state.view.name,
        ),
      )
      var afterRecord = performance.now()
      state.lastPoint = { id: recorded.id, dataset: recorded.dataset, values: recorded.values }

      var afterRebuild
      if (recorded.redraw) {
        // A point that moves the axes, or a panel that cannot be patched: redraw the tab, which is
        // the whole grid, and pay for it. The bar reports this number honestly.
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
            incremental: !recorded.redraw,
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

  async function undoPoint() {
    if (state.busy || !state.lastPoint) return
    var target = state.lastPoint
    state.busy = true
    renderEntry()
    try {
      await call(
        bridge.retractPoint(state.project.dir, target.id, 'undo from the window'),
      )
      state.lastPoint = null
      var refreshed = await call(bridge.refreshView(state.project.dir, state.view.name))
      state.opened = refreshed
      state.view = refreshed.view
      state.timing = null
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
    state.view = null
    state.opened = null
    state.lastPoint = null
    state.entryKey = null
    state.timing = null
    state.status = null
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
    ui.entry.addEventListener('submit', submitEntry)
    ui.entryUndo.addEventListener('click', undoPoint)
    ui.entry.addEventListener('keydown', function (event) {
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
          'Create a project with the CLI, then open that folder here. Projects are folders; the window appends to them through the same log the CLI writes.',
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
