/*
 * The status row under the bar: one sentence about what just happened, the problems behind it, and
 * the buttons that answer it. This is the only writer of `state.status`, so a refusal and the
 * button that undoes the act have one shape.
 *
 * The redo button is the act table's offer (`actions.actOffer`). It sits beside whatever the status
 * says rather than only beside the sentence an undo wrote: a selection or a copied detail replaces
 * the words and must not take the other direction away. The table is above this module — carrying
 * out an act redraws this row — so the offer crosses the seam in `navigation.js`.
 */
import { state, ui, node } from './state.js'
import { refusal, status as copyStatus } from './copy.js'
import { actions } from './navigation.js'

export function renderStatus() {
  var status = state.status
  // With nothing to report the reserved row is not empty: it says how to correct a record, which is
  // the one action in this bar that has no button of its own.
  ui.entryStatus.hidden = !status && !state.view
  ui.entryStatus.className = 'entry-status' + (status && status.kind === 'error' ? ' is-error' : '')
  ui.entryStatus.textContent = ''
  if (!status) {
    if (state.view && state.correction === null) {
      ui.entryStatus.appendChild(node('span', 'idle', copyStatus.idleHint()))
    }
  } else {
    ui.entryStatus.appendChild(node('span', null, status.text))
    if (status.problems && status.problems.length > 0) {
      var list = document.createElement('ul')
      status.problems.forEach(function (problem) {
        list.appendChild(node('li', null, problem))
      })
      ui.entryStatus.appendChild(list)
    }
  }
  // The act the status itself offers, when what just happened has an inverse the tab history does
  // not hold — closing a tab is the one. It is a button with words, like every other action here.
  if (status && status.action) {
    var offered = node('button', 'ghost status-action', status.action.label)
    offered.type = 'button'
    offered.title = status.action.title
    offered.disabled = state.busy
    offered.addEventListener('click', status.action.run)
    ui.entryStatus.appendChild(offered)
  }
  // Redo sits beside whatever the status says, not only beside the sentence an undo just wrote: a
  // selection or a copied detail replaces the words, and must not take the other direction away.
  // The button names the act it would repeat, so it never asks a person to press and find out.
  var redo = actions.actOffer('redo')
  if (!redo.idle) {
    var button = node('button', 'ghost status-action', redo.label)
    button.type = 'button'
    button.title = redo.title
    // A correction being edited is unsaved work: the other direction waits rather than throwing it
    // away under the person's hands.
    button.disabled = state.busy || state.correction !== null
    button.addEventListener('click', redo.run)
    ui.entryStatus.appendChild(button)
  }
}

export function setStatus(kind, text, problems, action) {
  // Problems are the core's sentences too, and they name the shape a field was checked against.
  // Run them through the same filter as the status line, at the one place every caller passes.
  state.status = {
    kind: kind,
    text: text,
    problems: (problems || []).map(function (problem) {
      return refusal(problem)
    }),
    // An act that is the inverse of something just done, or that the status is the only place to
    // offer: the same shape the redo button has, named the same way.
    action: action || null,
  }
  renderStatus()
}

/** Nothing to report: the row goes back to what it says with nothing to say. */
export function clearStatus() {
  state.status = null
  renderStatus()
}
