/* The drawing surface: one panel per figure, its accessible name, and the statuses beside it. */
import { state, ui, node, bridge, call } from './state.js'
import { factsFor, chartAccessibleLabel } from './format.js'
import { actions } from './navigation.js'

/** Recompute every panel's accessible name from the state currently on screen. */
export function renderPanelLabels() {
  var panels = (state.view && state.view.panels) || []
  var statuses = (state.opened && state.opened.statuses) || []
  Array.prototype.forEach.call(ui.grid.children, function (figure, index) {
    var panel = panels[index]
    var host = figure.querySelector('.panel-chart')
    var title = figure.querySelector('.panel-title')
    var facts = figure.querySelector('.panel-facts')
    if (!panel || !host || !title || !facts) return
    var status = statuses[index] || { state: 'unchecked' }
    host.setAttribute(
      'aria-label',
      chartAccessibleLabel(panel, title.textContent, facts.textContent, status.state),
    )
  })
}

/** The dataset count, not a sum of panel counts: two panels reading `main` used to add up to
 * twice the points in it, and a stale panel then made the total a number that was never true. */
export function renderMeta() {
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
export function renderNotice() {
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
export function renderStatuses(statuses) {
  var badges = ui.grid.querySelectorAll('.panel-strip .badge')
  statuses.forEach(function (status, index) {
    var badge = badges[index]
    if (!badge) return
    badge.className = 'badge ' + status.state
    badge.textContent = status.state
    badge.title = status.detail || ''
  })
  renderNotice()
  renderPanelLabels()
}

export function renderView(restore) {
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
  // A repaint replaces every panel; the previous handles own canvases and resize observers, and a
  // live observer would keep the old host and its marks alive for the life of the window.
  ;(state.handles || []).forEach(function (handle) {
    if (handle && handle.destroy) handle.destroy()
  })
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
      chartAccessibleLabel(panel, title.textContent, factsFor(panel), status.state),
    )
    figure.appendChild(strip)
    figure.appendChild(host)
    ui.grid.appendChild(figure)

    var handle = window.BenchCharts.mount(host, panel, opened.drawings[index], {
      zoomLabel: zoom,
      tooltip: ui.tooltip,
      viewBox: restore && restore.viewBoxes ? restore.viewBoxes[index] : null,
      onSelect: function (id) {
        actions.selectPoint(id, index)
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
  actions.renderEntry()
  watchOpenTab()
}

/**
 * Tell the main process which tab is on screen. The watcher lives there because the main process
 * owns the filesystem (ADR 0003); the window only says what it is drawing.
 */
export function watchOpenTab() {
  if (!bridge.watch) return
  var name = state.view ? state.view.name : null
  var key = state.project && name !== null ? state.project.dir + '\u0000' + name : null
  if (key === state.watching) return
  state.watching = key
  call(bridge.watch(state.project ? state.project.dir : null, name)).catch(function (error) {
    // The tab still works without a watcher; it just will not follow the project, and says so.
    actions.setStatus('error', 'This tab will not follow the project on disk: ' + ((error && error.message) || error))
  })
}

/** Scroll and per-panel crop, captured before a repaint and put back after it. */
export function captureRestore() {
  // One crop per panel, so the layer that carries it — not both halves of the same drawing.
  var svgs = ui.grid.querySelectorAll('.panel-chart svg.layer-under')
  return {
    scrollTop: ui.grid.scrollTop,
    viewBoxes: Array.prototype.map.call(svgs, function (svg) {
      return svg.getAttribute('viewBox')
    }),
  }
}
