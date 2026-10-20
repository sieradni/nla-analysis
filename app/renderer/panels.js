/* The drawing surface: one panel per figure, its accessible name, and the statuses beside it. */
import { state, ui, node, bridge, call } from './state.js'
import { mount } from './chart.js'
import {
  accessibleLabel,
  labels,
  notice as noticeText,
  panelEmpty,
  panelEvidence,
  panelFacts,
  panelStatus,
  status as copyStatus,
  tabFacts,
  verdictExplanation,
  verdictWord,
} from './copy.js'
import { actions } from './navigation.js'

/*
 * A word that needs a sentence: show it on hover and on keyboard focus in the window's own tooltip,
 * because a native title is slow, cannot wrap, and is invisible to a keyboard-only reader.
 */
function explain(element, text) {
  function show() {
    ui.tooltip.textContent = text
    ui.tooltip.hidden = false
    var box = element.getBoundingClientRect()
    var left = Math.min(box.left, window.innerWidth - ui.tooltip.offsetWidth - 8)
    var top = box.top - ui.tooltip.offsetHeight - 8
    ui.tooltip.style.left = Math.max(8, left) + 'px'
    ui.tooltip.style.top = (top < 8 ? box.bottom + 8 : top) + 'px'
  }
  function hide() {
    ui.tooltip.hidden = true
    ui.tooltip.textContent = ''
  }
  element.addEventListener('pointerenter', show)
  element.addEventListener('pointerleave', hide)
  element.addEventListener('focus', show)
  element.addEventListener('blur', hide)
}

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
      accessibleLabel(panel, title.textContent, facts.textContent, panelStatus(status.state).label),
    )
  })
}

/** The tab's facts, once: how many panels and how many points. The dataset's name is not
 * information in a project with one dataset, and a version list belongs to the agent. */
export function renderMeta() {
  var view = state.view
  var entry = state.opened && state.opened.entry
  var total = view.panels.reduce(function (sum, panel) {
    return sum + (typeof panel.n === 'number' ? panel.n : 0)
  }, 0)
  var active = entry ? entry.active : total
  ui.meta.textContent = tabFacts(view.panels.length, active)
}

/**
 * Staleness, said once, in the words a person would use — and with the one action that fixes it.
 * The command that used to sit here was a door that opened the wrong way (ADR 0015).
 */
export function renderNotice() {
  var statuses = (state.opened && state.opened.statuses) || []
  var text = noticeText(statuses)
  if (text === '') {
    ui.notice.hidden = true
    ui.notice.textContent = ''
    return
  }
  ui.notice.hidden = false
  ui.notice.textContent = ''
  ui.notice.appendChild(node('span', null, text))
  var refresh = node('button', 'ghost notice-refresh', labels.refresh)
  refresh.type = 'button'
  refresh.addEventListener('click', function () {
    if (actions.refreshTab) actions.refreshTab()
  })
  ui.notice.appendChild(refresh)
}

/** Badges and the notice, from statuses alone: no drawing is touched, so this cannot cause a repaint. */
export function renderStatuses(statuses) {
  var badges = ui.grid.querySelectorAll('.panel-strip .badge')
  statuses.forEach(function (status, index) {
    var badge = badges[index]
    if (!badge) return
    var said = panelStatus(status.state)
    badge.className = 'badge ' + status.state
    badge.textContent = said.label
    badge.title = said.title
    badge.hidden = said.label === ''
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
  // A recipe panel is kept as it was drawn, and `kept` says which ones: its marks may include a
  // point that is no longer in the project, so the drawing shows them but does not offer them.
  var kept = opened.kept || []

  view.panels.forEach(function (panel, index) {
    var status = (opened.statuses[index] || { state: 'unchecked' })
    var said = panelStatus(status.state)
    var figure = node('figure', 'panel')
    var strip = node('div', 'panel-strip')
    var title = node('span', 'panel-title', panel.title || panel.chart.title || 'Panel ' + (index + 1))
    var facts = node('span', 'panel-facts', panelFacts(panel))
    var tools = node('div', 'panel-tools')
    var badge = node('span', 'badge ' + status.state, said.label)
    badge.title = said.title
    badge.hidden = said.label === ''
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
    host.setAttribute('aria-label', accessibleLabel(panel, title.textContent, facts.textContent, said.label))
    figure.appendChild(strip)
    figure.appendChild(host)
    ui.grid.appendChild(figure)

    var handle = mount(host, panel, opened.drawings[index], {
      zoomLabel: zoom,
      tooltip: ui.tooltip,
      viewBox: restore && restore.viewBoxes ? restore.viewBoxes[index] : null,
      pointsAreCurrent: !kept.some(function (entry) {
        return entry.index === index
      }),
      // A menu dismissed by this panel being replaced asks for the panel that replaced it.
      refocus: function () {
        state.refocusPanel = index
      },
      onSelect: function (id) {
        actions.selectPoint(id, index)
      },
      // The menu names an action and a record; `entry.js` owns what each one does, because a write
      // belongs to the bar that owns writes, not to the drawing that asked for it.
      onPointAction: function (action, id) {
        if (actions.pointAction) actions.pointAction(action, id, index)
      },
    })
    state.handles[index] = handle
    // The drawing is chrome-free for the window: no subtitle, no footer, no empty state. These are
    // the words that describe the drawing, and they are DOM from the copy owner — never a rewrite
    // of what the core painted.
    if (panel.chart.empty) figure.appendChild(node('p', 'panel-empty', panelEmpty()))
    var evidence = panelEvidence(panel)
    if (evidence !== '' || panel.verdict) {
      var line = node('div', 'panel-evidence')
      if (evidence !== '') line.appendChild(node('span', 'evidence-text', evidence))
      if (panel.verdict) {
        var chip = node('span', 'verdict', verdictWord(panel.verdict))
        chip.tabIndex = 0
        explain(chip, verdictExplanation(panel.verdict))
        line.appendChild(chip)
      }
      figure.appendChild(line)
    }
    reset.addEventListener('click', function () {
      handle.reset()
    })
  })

  var hosts = ui.grid.querySelectorAll('.panel-chart')
  // The panel that had the keyboard, or — when a menu owned it and the repaint closed it — the panel
  // the menu was opened from.
  var target = state.refocusPanel !== null ? state.refocusPanel : focusedPanel
  state.refocusPanel = null
  if (target >= 0 && hosts[target]) hosts[target].focus()
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
    actions.setStatus('error', copyStatus.couldNotFollow((error && error.message) || String(error)))
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
