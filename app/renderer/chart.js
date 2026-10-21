/*
 * Interaction for one rendered panel.
 *
 * The core returns the chart in two halves around its marks: the plate, grid and fits below, the
 * axes, labels and caption above. The window paints every observation on a canvas between them, so a
 * rescale costs one draw instead of ten thousand DOM nodes, while the artifact on disk keeps the same
 * SVG. Both halves share one `viewBox`, so zooming is still a crop of the same drawing.
 *
 * The scale is the core's. Marks arrive already projected into the chart's 760×440 units; this file
 * only maps those units onto the canvas. Hover finds the nearest mark in the crop and reads it out
 * through `copy.js`, so the tooltip cannot grow a second vocabulary.
 */
import { pointMenu, tooltipLines } from './copy.js'
import { closeMenu, menuHasFocus, menuOwnedBy, openMenu } from './menu.js'

  var SVG_NS = 'http://www.w3.org/2000/svg'
  var MIN_ZOOM = 1
  var MAX_ZOOM = 8
  var HOVER_RADIUS_PX = 13

  /**
   * Build one of the drawing's halves. The HTML parser builds SVG content in place, in the
   * foreign-content namespace, and the markup is well-formed XML by construction (the core's own
   * test asserts it), so this fast path cannot accept something a stricter parser would reject.
   */
  function insertSvg(host, text, where) {
    host.insertAdjacentHTML(where, text)
    var node = where === 'afterbegin' ? host.firstElementChild : host.lastElementChild
    if (!node || node.nodeName.toLowerCase() !== 'svg') {
      host.textContent = ''
      throw new Error('the core returned something that is not an SVG')
    }
    node.removeAttribute('width')
    node.removeAttribute('height')
    return node
  }

  /**
   * `drawing` is `{ under, over, marks, style }` from the core: two SVG halves and the projected
   * marks that belong between them.
   */
  export function mount(host, panel, drawing, options) {
    host.textContent = ''
    var under = insertSvg(host, drawing.under, 'afterbegin')
    under.classList.add('layer-under')
    // The host carries the accessible name and the drawing is a picture of it. Two SVGs, a canvas
    // and a host with a role would otherwise announce the same chart three times; the host's label
    // is the one that also names the figures and the panel's state.
    under.setAttribute('aria-hidden', 'true')

    var canvas = document.createElement('canvas')
    canvas.className = 'marks'
    canvas.setAttribute('aria-hidden', 'true')
    host.appendChild(canvas)
    var context = canvas.getContext('2d')

    var over = insertSvg(host, drawing.over, 'beforeend')
    over.classList.add('layer-over')
    over.setAttribute('aria-hidden', 'true')

    var viewBox = under.viewBox.baseVal
    var base = { x: viewBox.x, y: viewBox.y, w: viewBox.width, h: viewBox.height }
    var box = { x: base.x, y: base.y, w: base.w, h: base.h }
    var drag = null

    // A repaint replaces the drawing but keeps the crop the user was reading. The old box is applied
    // to the new drawing and then constrained, so a rescaled chart cannot leave the view outside it.
    if (options.viewBox) {
      var parts = String(options.viewBox).trim().split(/[\s,]+/).map(Number)
      if (parts.length === 4 && parts.every(isFinite) && parts[2] > 0 && parts[3] > 0) {
        box = { x: parts[0], y: parts[1], w: parts[2], h: parts[3] }
        constrain()
      }
    }

    // Positions, ids and data values arrive as parallel arrays in the spec's own point order. Tooltip
    // values are data values, not projected positions: `cx`/`cy` say where a mark is drawn, `xs`/`ys`
    // say what it measured.
    // A panel drawn by a recipe is kept, not rebuilt, when a write changes the data: its marks are
    // the ones the file was drawn with, and one of them may no longer be in the project. It still
    // draws them (with a stale badge that says so), but it does not offer to act on them.
    var actionable = options.pointsAreCurrent !== false

    var packed = drawing.marks || []
    var xs = drawing.xs || []
    var ys = drawing.ys || []
    var ids =
      typeof drawing.ids === 'string' && drawing.ids !== '' ? drawing.ids.split('\n') : []
    var values = {}
    var marks = []
    for (var slot = 0; slot * 2 + 1 < packed.length; slot += 1) {
      var id = ids[slot] || undefined
      marks.push({ id: id, cx: packed[slot * 2], cy: packed[slot * 2 + 1] })
      if (id) values[id] = { id: id, x: xs[slot], y: ys[slot] }
    }
    var style = drawing.style || { radius: 3.4, fill: '#1f6feb', stroke: '#ffffff', strokeWidth: 1.5 }

    function count() {
      host.dataset.marks = String(marks.length)
    }
    count()

    var dot = document.createElementNS(SVG_NS, 'circle')
    dot.setAttribute('class', 'hover-dot')
    dot.setAttribute('visibility', 'hidden')
    over.appendChild(dot)

    // Selection is a second, larger ring: hover answers "which record is this?", selection says
    // "this is the one being edited", and they can be different marks at the same time.
    var selection = document.createElementNS(SVG_NS, 'circle')
    selection.setAttribute('class', 'select-dot')
    selection.setAttribute('visibility', 'hidden')
    over.appendChild(selection)
    var selected = null

    function zoomFactor() {
      return base.w / box.w
    }

    /** The live drawing area, in CSS pixels, and the conversion the canvas and pointer share. */
    function view() {
      var rect = under.getBoundingClientRect()
      return { rect: rect, scale: rect.width > 0 ? rect.width / box.w : 0 }
    }

    /**
     * Paint every mark inside the crop. One path for all of them, filled and stroked once: ten
     * thousand individual `fill`/`stroke` calls would spend the budget on state changes.
     */
    function draw() {
      var at = view()
      var rect = at.rect
      if (!context || rect.width <= 0 || rect.height <= 0) return
      var dpr = window.devicePixelRatio || 1
      var width = Math.max(1, Math.round(rect.width * dpr))
      var height = Math.max(1, Math.round(rect.height * dpr))
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
      }
      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      context.clearRect(0, 0, rect.width, rect.height)
      if (at.scale <= 0 || marks.length === 0) return

      var radius = style.radius * at.scale
      var right = box.x + box.w
      var bottom = box.y + box.h
      context.beginPath()
      for (var index = 0; index < marks.length; index += 1) {
        var mark = marks[index]
        if (mark.cx < box.x || mark.cx > right || mark.cy < box.y || mark.cy > bottom) continue
        var px = (mark.cx - box.x) * at.scale
        var py = (mark.cy - box.y) * at.scale
        context.moveTo(px + radius, py)
        context.arc(px, py, radius, 0, Math.PI * 2)
      }
      context.fillStyle = style.fill
      context.fill()
      context.lineWidth = style.strokeWidth * at.scale
      context.strokeStyle = style.stroke
      context.stroke()
    }

    /** One more mark, drawn onto the canvas without repainting the ten thousand already there. */
    function drawMark(mark) {
      var at = view()
      if (!context || at.scale <= 0) return
      if (mark.cx < box.x || mark.cx > box.x + box.w || mark.cy < box.y || mark.cy > box.y + box.h) return
      var radius = style.radius * at.scale
      context.beginPath()
      context.arc((mark.cx - box.x) * at.scale, (mark.cy - box.y) * at.scale, radius, 0, Math.PI * 2)
      context.fillStyle = style.fill
      context.fill()
      context.lineWidth = style.strokeWidth * at.scale
      context.strokeStyle = style.stroke
      context.stroke()
    }

    function apply() {
      var value = box.x + ' ' + box.y + ' ' + box.w + ' ' + box.h
      under.setAttribute('viewBox', value)
      over.setAttribute('viewBox', value)
      if (options.zoomLabel) options.zoomLabel.textContent = zoomFactor().toFixed(1) + '×'
      draw()
    }

    function constrain() {
      box.w = Math.min(base.w, Math.max(base.w / MAX_ZOOM, box.w))
      box.h = box.w * (base.h / base.w)
      box.x = Math.min(base.x + base.w - box.w, Math.max(base.x, box.x))
      box.y = Math.min(base.y + base.h - box.h, Math.max(base.y, box.y))
    }

    function reset() {
      box = { x: base.x, y: base.y, w: base.w, h: base.h }
      hideHover()
      apply()
    }

    /** Client coordinates to the drawing's own units, at the current crop. */
    function toBox(clientX, clientY) {
      var rect = under.getBoundingClientRect()
      return {
        x: box.x + ((clientX - rect.left) / rect.width) * box.w,
        y: box.y + ((clientY - rect.top) / rect.height) * box.h,
        rect: rect,
      }
    }

    /** The inverse, for the capture harness: where a mark actually sits on screen. */
    function toClient(cx, cy) {
      var rect = under.getBoundingClientRect()
      return {
        x: rect.left + ((cx - box.x) / box.w) * rect.width,
        y: rect.top + ((cy - box.y) / box.h) * rect.height,
      }
    }

    function zoomAt(factor, point) {
      var next = Math.min(base.w, Math.max(base.w / MAX_ZOOM, box.w / factor))
      var scale = next / box.w
      box.x = point.x - (point.x - box.x) * scale
      box.y = point.y - (point.y - box.y) * scale
      box.w = next
      box.h = base.h * (next / base.w)
      constrain()
      apply()
    }

    function hideHover() {
      dot.setAttribute('visibility', 'hidden')
      options.tooltip.hidden = true
      host.classList.remove('over-mark')
    }

    /** What was drawn at these client coordinates, or null. Hover and click want the same answer. */
    function nearest(clientX, clientY) {
      if (marks.length === 0) return null
      var at = toBox(clientX, clientY)
      var tolerance = HOVER_RADIUS_PX * (box.w / at.rect.width)
      var best = null
      var bestDistance = tolerance * tolerance
      for (var index = 0; index < marks.length; index += 1) {
        var point = marks[index]
        var dx = point.cx - at.x
        var dy = point.cy - at.y
        var distance = dx * dx + dy * dy
        if (distance <= bestDistance) {
          bestDistance = distance
          best = point
        }
      }
      return best
    }

    /** Put the selection ring on one mark and tell the window which record it is. */
    function showSelection(mark) {
      // Only a mark with a record can be selected: there is nothing to correct otherwise. A kept
      // panel's marks are not offered at all — correcting one would edit a record the drawing cannot
      // vouch for, and removing one may already be gone.
      if (!actionable || !mark || !mark.id) return
      selected = mark
      var at = toBox(0, 0)
      var perPixel = box.w / at.rect.width
      hideHover()
      selection.setAttribute('cx', String(mark.cx))
      selection.setAttribute('cy', String(mark.cy))
      selection.setAttribute('r', String(9 * perPixel))
      selection.setAttribute('stroke-width', String(1.5 * perPixel))
      selection.setAttribute('visibility', 'visible')
      if (options.onSelect) options.onSelect(mark.id)
    }

    function clearSelection(notify) {
      selected = null
      selection.setAttribute('visibility', 'hidden')
      if (notify && options.onSelect) options.onSelect(null)
    }

    function showHover(mark, clientX, clientY) {
      if (!mark || !mark.id) return
      var rect = toBox(clientX, clientY).rect
      var perPixel = box.w / rect.width
      var point = values[mark.id]
      dot.setAttribute('cx', String(mark.cx))
      dot.setAttribute('cy', String(mark.cy))
      dot.setAttribute('r', String(6 * perPixel))
      dot.setAttribute('stroke-width', String(1.5 * perPixel))
      dot.setAttribute('visibility', 'visible')
      host.classList.add('over-mark')

      var tooltip = options.tooltip
      tooltip.textContent = ''
      // Values, their labels and their units: the readout answers "what did this point measure?"
      // and nothing about the record, the dataset or the shape that holds it.
      tooltipLines(point || {}, panel).forEach(function (line, index) {
        var row = document.createElement('div')
        row.className = index === 0 ? 't-values' : 't-hint'
        row.textContent = line
        tooltip.appendChild(row)
      })

      tooltip.hidden = false
      var width = tooltip.offsetWidth
      var height = tooltip.offsetHeight
      var left = clientX + 14
      var top = clientY - height - 12
      if (left + width > window.innerWidth - 8) left = clientX - width - 14
      if (top < 8) top = clientY + 16
      tooltip.style.left = Math.max(8, left) + 'px'
      tooltip.style.top = Math.max(8, top) + 'px'
    }

    function hover(clientX, clientY) {
      var best = nearest(clientX, clientY)
      if (best) showHover(best, clientX, clientY)
      else hideHover()
    }

    host.addEventListener('pointerdown', function (event) {
      if (event.button !== 0) return
      host.setPointerCapture(event.pointerId)
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: 0 }
      host.classList.add('dragging')
      hideHover()
    })

    host.addEventListener('pointermove', function (event) {
      if (drag && drag.id === event.pointerId) {
        var rect = under.getBoundingClientRect()
        box.x -= (event.clientX - drag.x) * (box.w / rect.width)
        box.y -= (event.clientY - drag.y) * (box.h / rect.height)
        drag.moved += Math.abs(event.clientX - drag.x) + Math.abs(event.clientY - drag.y)
        drag.x = event.clientX
        drag.y = event.clientY
        constrain()
        apply()
        return
      }
      hover(event.clientX, event.clientY)
    })

    function endDrag(event) {
      if (!drag || drag.id !== event.pointerId) return
      var wasClick = drag.moved < 4
      host.classList.remove('dragging')
      drag = null
      // A click is a press that did not pan. That is the one gesture that selects, so dragging the
      // chart never changes which record the correction strip is aimed at.
      if (!wasClick) return
      var mark = nearest(event.clientX, event.clientY)
      if (mark) showSelection(mark)
      else clearSelection(true)
    }
    host.addEventListener('pointerup', endDrag)
    host.addEventListener('pointercancel', endDrag)
    host.addEventListener('pointerleave', function () {
      if (!drag) hideHover()
    })

    /**
     * Open the menu for one mark, at wherever it is drawn. The popover — placement, keys, dismissal,
     * focus — is `menu.js`'s; this only says what the three items are and which mark they act on.
     * `owner` lets a repaint dismiss its own menu and no other.
     */
    function openPointMenu(mark, clientX, clientY) {
      openMenu({
        label: pointMenu.label,
        owner: host,
        at: { x: clientX, y: clientY },
        items: [
          ['copy', pointMenu.copy],
          ['correct', pointMenu.correct],
          ['remove', pointMenu.remove],
        ],
        onChoose: function (action) {
          // The panel says what to do about it; the drawing only knows which record was asked for.
          if (options.onPointAction) options.onPointAction(action, mark.id)
        },
        // Where the keyboard goes if this panel is replaced while the menu is open.
        focusBack: function () {
          if (host.isConnected) host.focus()
          else if (options.refocus) options.refocus()
        },
      })
    }

    // A point's own menu. Right-click is the gesture a person tries; the ring is deliberately not
    // moved, because asking for the menu is not the same act as selecting the point for correction.
    host.addEventListener('contextmenu', function (event) {
      if (!actionable) return
      var mark = nearest(event.clientX, event.clientY)
      if (!mark || !mark.id) return
      event.preventDefault()
      hideHover()
      openPointMenu(mark, event.clientX, event.clientY)
    })

    host.addEventListener(
      'wheel',
      function (event) {
        event.preventDefault()
        var at = toBox(event.clientX, event.clientY)
        // Exponential so a trackpad's small deltas and a mouse's large ones feel alike.
        zoomAt(Math.exp(-event.deltaY * 0.0015), at)
        hideHover()
      },
      { passive: false },
    )

    host.addEventListener('dblclick', function (event) {
      event.preventDefault()
      reset()
    })

    host.addEventListener('keydown', function (event) {
      // The keyboard's context-menu key, on the selected mark: a menu is only about a point the
      // person has already chosen. Shift+F10 is the Windows convention; the menu key is its twin.
      if ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') {
        if (!actionable || !selected) return
        var at = toClient(selected.cx, selected.cy)
        event.preventDefault()
        hideHover()
        openPointMenu(selected, at.x, at.y)
        return
      }
      if (event.key === 'Escape') {
        clearSelection(true)
        return
      }
      // The keyboard path to a record, for someone who cannot point at one: shift-arrow steps the
      // selection along x, wrapping at the ends. Panning keeps the unshifted arrows.
      if (event.shiftKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        var ordered = marks.slice().sort(function (left, right) {
          return left.cx - right.cx
        })
        if (ordered.length === 0) return
        var at = -1
        for (var index = 0; index < ordered.length; index += 1) {
          if (selected && ordered[index].id === selected.id) at = index
        }
        var step = event.key === 'ArrowRight' ? 1 : -1
        var next = at === -1 ? (step === 1 ? 0 : ordered.length - 1) : at + step
        if (next < 0) next = ordered.length - 1
        if (next >= ordered.length) next = 0
        showSelection(ordered[next])
        event.preventDefault()
        return
      }
      if (event.key === '0') {
        reset()
        event.preventDefault()
        return
      }
      if (event.key === '+' || event.key === '=') {
        zoomAt(1.3, { x: box.x + box.w / 2, y: box.y + box.h / 2 })
        event.preventDefault()
        return
      }
      if (event.key === '-' || event.key === '_') {
        zoomAt(1 / 1.3, { x: box.x + box.w / 2, y: box.y + box.h / 2 })
        event.preventDefault()
        return
      }
      var step = 0.1
      if (event.key === 'ArrowLeft') box.x -= box.w * step
      else if (event.key === 'ArrowRight') box.x += box.w * step
      else if (event.key === 'ArrowUp') box.y -= box.h * step
      else if (event.key === 'ArrowDown') box.y += box.h * step
      else return
      event.preventDefault()
      constrain()
      apply()
      hideHover()
    })

    // The chart's height follows its own viewBox ratio; the host can still change width with the
    // window, so the bitmap has to follow it rather than stretch. The observer is kept so a repaint
    // can disconnect it: it holds the host (and through this closure, every mark) alive otherwise.
    var observer = null
    if (typeof ResizeObserver === 'function') {
      observer = new ResizeObserver(function () {
        draw()
      })
      observer.observe(host)
    }

    apply()

    /**
     * Register a mark that arrived after this mount. The panel's hit-testing works off the marks it
     * knows about, so a point appended without a redraw is drawn and reachable here too.
     */
    function addMark(id, cx, cy, point) {
      var mark = { id: id, cx: cx, cy: cy }
      marks.push(mark)
      if (point) values[id] = point
      count()
      drawMark(mark)
    }

    var handle = {
      reset: reset,
      addMark: addMark,
      clearSelection: function () {
        clearSelection(false)
      },
      destroy: function () {
        if (observer) {
          observer.disconnect()
          observer = null
        }
        // A repaint replaces this drawing; a menu still pointing at one of its marks would act on a
        // record the person can no longer see. The host is about to leave the document, so the
        // keyboard goes to whatever replaces this panel rather than to the body.
        if (menuOwnedBy(host)) {
          // The menu was up when the panel was replaced: put the keyboard on the panel that replaces
          // it, rather than leaving it on a detached element and then on the document body.
          var menuHadFocus = menuHasFocus() || document.activeElement === host
          closeMenu(false)
          if (menuHadFocus && options.refocus) options.refocus()
          else if (menuHadFocus) host.focus()
        }
      },
      /**
       * Visible marks in client coordinates, left to right. The capture harness uses this where it
       * used to read `circle` elements: the canvas has no DOM nodes to query.
       */
      marks: function () {
        var right = box.x + box.w
        var bottom = box.y + box.h
        return marks
          .filter(function (mark) {
            return mark.cx >= box.x && mark.cx <= right && mark.cy >= box.y && mark.cy <= bottom
          })
          .sort(function (left, right) {
            return left.cx - right.cx
          })
          .map(function (mark) {
            var at = toClient(mark.cx, mark.cy)
            return { id: mark.id, x: at.x, y: at.y, cx: mark.cx, cy: mark.cy }
          })
      },
    }
    // The only inspection surface the renderer offers; the harness is a separate process and
    // cannot import this module.
    host.__benchChart = handle
    return handle
  }
