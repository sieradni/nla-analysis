/*
 * The bar's fields: what each shape field becomes in the DOM, what the person typed, and what the
 * core is handed. One owner of the controls, so a refusal's mark, a correction's prefill and the
 * coercion of a typed value cannot drift apart.
 *
 * An instant is the only value the window translates. `copy.js` owns both ends of that translation
 * (`instantInputValue`, `instantFromInput`) because it owns the words a moment is shown in; this
 * file only decides which fields get the control, and keeps the log's own instant beside it so a
 * correction that left the clock alone returns it byte for byte.
 */
import { state, ui, node } from './state.js'
import { instantFromInput, instantInputValue, labels } from './copy.js'

/**
 * Typed text to a point value. The window does not get a second opinion about what a number is: a
 * value it cannot parse is passed through as text, and the shape's own validation refuses it with
 * the message the CLI would give. That is why the same typo reads the same in both places.
 *
 * An instant is the one value that is not typed: the control shows the reader's clock and the log
 * stores canonical UTC, so this is where the two meet. `unchanged` is the instant the field was
 * filled from, which a correction that did not touch the clock hands back untouched.
 */
export function coerceValue(field, text, unchanged) {
  if (field.type === 'number' || field.type === 'integer') {
    var parsed = Number(text)
    return Number.isFinite(parsed) ? parsed : text
  }
  if (field.type === 'boolean') {
    if (text.toLowerCase() === 'true') return true
    if (text.toLowerCase() === 'false') return false
    return text
  }
  if (field.type === 'instant') return instantFromInput(text, unchanged)
  return text
}

export function entryInputs() {
  return Array.prototype.map.call(ui.entryFields.querySelectorAll('input'), function (input) {
    return input
  })
}

export function fieldValueMap() {
  var values = {}
  entryInputs().forEach(function (input) {
    var text = input.value.trim()
    if (text === '') return
    var field = { name: input.dataset.field, type: input.dataset.type }
    values[field.name] = coerceValue(field, text, input.dataset.canonical)
  })
  return values
}

export function buildEntryFields(entry, prefill, mode) {
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
    // A moment gets a date and a time, not a syntax to learn. Every other field is typed, and an
    // instant is still typeable *inside* the control — the browser's own segments, on the reader's
    // clock — so a transcribed observation and a pressed one arrive the same way.
    var instant = field.type === 'instant'
    var label = node('label', 'entry-field' + (instant ? ' entry-field-time' : ''))
    label.appendChild(node('span', null, field.name))
    var input = document.createElement('input')
    input.type = instant ? 'datetime-local' : 'text'
    input.autocomplete = 'off'
    input.spellcheck = false
    input.dataset.field = field.name
    input.dataset.type = field.type
    input.setAttribute('aria-label', field.name + ' · ' + field.type)
    if (field.type === 'number' || field.type === 'integer') input.setAttribute('inputmode', 'decimal')
    // A correction starts from the point's own values, so the common edit is one number changed.
    if (prefill && prefill[field.name] !== undefined && prefill[field.name] !== null) {
      if (instant) {
        // The log's instant as the reader's wall clock, and the original kept beside it: saving a
        // correction that left the clock alone must return the instant exactly as it was.
        input.value = instantInputValue(String(prefill[field.name]))
        input.dataset.canonical = String(prefill[field.name])
      } else {
        input.value = String(prefill[field.name])
      }
    }
    label.appendChild(input)
    if (instant) {
      // "This happened just now" is the common case, and it is one press rather than a typed clock.
      var now = node('button', 'ghost entry-now', labels.now)
      now.type = 'button'
      now.title = labels.nowTitle
      now.setAttribute('aria-label', labels.nowTitle)
      now.addEventListener('click', function () {
        input.value = instantInputValue(new Date().toISOString())
        // A fresh moment was chosen here, so there is no earlier value to preserve.
        delete input.dataset.canonical
        input.focus()
      })
      label.appendChild(now)
    }
    ui.entryFields.appendChild(label)
  })
}

export function focusFirstField() {
  var inputs = entryInputs()
  // A field never takes the cursor from an open menu: a read that finishes behind the menu must not
  // move the keyboard out of the choice the person is making. The role, not the menu's own class,
  // is what this rule needs to know.
  var active = document.activeElement
  if (active && active.closest && active.closest('[role="menu"]')) return
  if (!ui.entry.hidden && inputs.length > 0) inputs[0].focus()
}

/** Mark the fields a refusal named, and hand back the first one so focus can go there. */
export function markProblems(problems) {
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

/** Whether Ctrl+Z would edit text: a field with something in it owns its own undo. */
export function entryHasText() {
  return entryInputs().some(function (input) {
    return input.value !== ''
  })
}
