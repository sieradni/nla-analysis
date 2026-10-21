/*
 * The entry bar, drawn: which fields, which words on its two buttons, whether it is adding a point
 * or editing one, and the count beside them. This file is the bar's view and nothing else — the
 * fields are `fields.js`'s, the status row under it is `status.js`'s, a correction is
 * `correction.js`'s, and typing writes through `point-actions.js`.
 */
import { state, ui, node } from './state.js'
import { labels, status as copyStatus } from './copy.js'
import { buildEntryFields, renderObservedField } from './fields.js'
import { renderStatus } from './status.js'
import { actions } from './navigation.js'

export function renderEntry() {
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
  ui.entryAdd.querySelector('span').textContent =
    correction === null ? labels.addPoint : labels.saveCorrection
  ui.entryUndo.hidden = correction !== null
  if (correction !== null) {
    ui.entryCorrectLabel.textContent = ''
    ui.entryCorrectLabel.appendChild(node('span', null, 'Editing '))
    ui.entryCorrectLabel.appendChild(
      node(
        'span',
        'note',
        copyStatus.correctionRow({
          values: correction.values,
          // The panel the record was selected in, so the strip carries the same labels and units the
          // hover does. Absent after a repaint that replaced the drawing, and then it falls back to
          // the field's own name.
          panel: state.selection ? state.view.panels[state.selection.index] : undefined,
          observed: correction.tObserved,
          estimated: correction.timeEstimated === true,
          corrections: correction.corrections,
          stalePanels: correction.recipePanels.length,
          fields: correction.fields,
          timeField: correction.timeField,
        }),
      ),
    )
  }

  buildEntryFields(
    entry,
    correction === null ? null : correction.values,
    correction === null ? 'add' : 'correct:' + correction.id,
  )
  renderObservedField(correction)
  ui.entryAdd.disabled = state.busy
  // One undo, and it says which act it would reverse: the bar's last point and a removal from the
  // menu share one history, so a single button can serve both without a second one beside a status.
  // The words and the act are the table's (`acts.js`); this only puts them on the button.
  var undo = actions.actOffer('undo')
  ui.entryUndo.disabled = state.busy || undo.idle
  ui.entryUndo.textContent = undo.label
  ui.entryUndo.title = undo.title

  if (state.timing !== null) {
    ui.entryReadout.appendChild(node('b', null, state.timing + ' ms'))
    ui.entryReadout.appendChild(document.createTextNode(' · '))
  }
  ui.entryReadout.appendChild(document.createTextNode('n = ' + entry.active))
  ui.entryReadout.title = copyStatus.readoutTitle()
  renderStatus()
}
