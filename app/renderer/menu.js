/*
 * The window's one popover menu.
 *
 * A menu is a label, a list of items and one callback for the choice. Where it opens, which item has
 * the keyboard, how Escape and Tab return the keyboard, and when a pointer elsewhere dismisses it are
 * the same rules every time, so they live here once. A caller that also knew how to remove a record
 * or close a tab would be a second write path; this module only says which action was chosen.
 *
 * One menu at a time, because a menu is a property of the window rather than of the row or the
 * drawing that opened it: opening a second closes the first, and a repaint can ask whether the menu
 * on screen is its own (`menuOwnedBy`) before dismissing it.
 */
import { node } from './state.js'

var open = null

/** Whether the menu on screen is the one `owner` opened: a repaint dismisses its own and no other. */
export function menuOwnedBy(owner) {
  return open !== null && open.owner === owner
}

/** Whether the keyboard is inside the open menu, so a dismissal can put it somewhere sensible. */
export function menuHasFocus() {
  return open !== null && open.element.contains(document.activeElement)
}

/**
 * Close the menu, and put the keyboard back where it came from.
 *
 * A dismissal that is not a choice passes `false`, so a pointerdown elsewhere never pulls the cursor
 * out of the field it landed in. Escape, Tab and a chosen item always mean the keyboard belongs to
 * what opened the menu — or, when that element has been replaced, to whatever took its place.
 */
export function closeMenu(returnFocus) {
  if (!open) return
  var closed = open
  open = null
  closed.element.remove()
  document.removeEventListener('pointerdown', closed.outside, true)
  window.removeEventListener('resize', closed.dismiss)
  // A trigger that opened a menu says so, and says when it closed: the state is the control's, and
  // the thing that opens it is the only thing that knows it has one.
  if (closed.trigger) closed.trigger.setAttribute('aria-expanded', 'false')
  if (!returnFocus) return
  // The trigger is where the keyboard came from, so it is where it goes back unless the caller named
  // something else — a drawing whose panel may have been replaced by the time the menu closes.
  var back = closed.focusBack || closed.trigger
  if (typeof back === 'function') back()
  else if (back && back.isConnected) back.focus()
}

/**
 * Open a menu. `items` is `[[action, label], …]`.
 *
 * `at` is where its top-left should go (a pointer position); `under` is the element it belongs to,
 * so it opens below that element, flips above it when there is no room, and keeps its
 * `aria-expanded` current. Either way it is pulled back inside the window: a menu opened at an edge
 * would otherwise offer an item nobody can click.
 */
export function openMenu(options) {
  closeMenu(false)
  var element = node('div', 'menu')
  element.setAttribute('role', 'menu')
  element.setAttribute('aria-label', options.label)

  var buttons = options.items.map(function (item) {
    var button = node('button', 'menu-item', item[1])
    button.type = 'button'
    button.setAttribute('role', 'menuitem')
    button.dataset.action = item[0]
    button.addEventListener('click', function () {
      // Back to the drawing or the row before the act, so the repaint the act causes has something
      // to return the keyboard to rather than the document body.
      closeMenu(true)
      options.onChoose(item[0])
    })
    element.appendChild(button)
    return button
  })

  element.addEventListener('keydown', function (event) {
    var at = buttons.indexOf(document.activeElement)
    // Tab leaves the menu rather than walking out of it into nothing: after `remove()` the focused
    // button is gone, and a keyboard reader would land on the document body.
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault()
      closeMenu(true)
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') {
      return
    }
    event.preventDefault()
    var next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? buttons.length - 1
          : at === -1
            ? 0
            : (at + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
    buttons[next].focus()
  })

  document.body.appendChild(element)
  place(element, options)
  var outside = function (event) {
    if (!element.contains(event.target)) closeMenu(false)
  }
  var dismiss = function () {
    closeMenu(false)
  }
  document.addEventListener('pointerdown', outside, true)
  window.addEventListener('resize', dismiss)

  var trigger = options.under || null
  if (trigger && trigger.setAttribute) trigger.setAttribute('aria-expanded', 'true')
  buttons[0].focus()
  open = {
    element: element,
    owner: options.owner,
    trigger: trigger,
    focusBack: options.focusBack,
    outside: outside,
    dismiss: dismiss,
  }
}

/** Put the menu where the caller asked, then pull it back inside the window. */
function place(element, options) {
  var anchor = options.under ? options.under.getBoundingClientRect() : null
  var left = anchor ? anchor.left : options.at.x
  var top = anchor ? anchor.bottom + 4 : options.at.y
  element.style.left = Math.round(left) + 'px'
  element.style.top = Math.round(top) + 'px'
  var box = element.getBoundingClientRect()
  if (box.right > window.innerWidth - 8) {
    var right = anchor ? anchor.right - box.width : left - box.width
    element.style.left = Math.max(8, Math.round(right)) + 'px'
  }
  if (box.bottom > window.innerHeight - 8) {
    // Above the trigger rather than over it: a tab near the bottom of the rail must not have its own
    // menu cover the row it is about.
    var above = anchor ? anchor.top - box.height - 4 : top - box.height
    element.style.top = Math.max(8, Math.round(above)) + 'px'
  }
}
