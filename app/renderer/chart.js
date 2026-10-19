/*
 * Interaction for one rendered panel.
 *
 * The SVG is drawn by the core renderer and handed over as markup, so the window never re-implements
 * scales, ticks or the honesty lines. Interaction moves the SVG's own `viewBox`: zooming is a crop of
 * the same drawing, which keeps every coordinate, label and `data-point-id` exactly where the core
 * put it. Hover finds the nearest point in the crop and names it by id.
 */
;(function () {
  'use strict'

  var SVG_NS = 'http://www.w3.org/2000/svg'
  var MIN_ZOOM = 1
  var MAX_ZOOM = 8
  var HOVER_RADIUS_PX = 13

  function format(value) {
    if (typeof value !== 'number' || !isFinite(value)) return '—'
    var magnitude = Math.abs(value)
    if (magnitude === 0) return '0'
    if (magnitude >= 1e6 || magnitude < 1e-3) return value.toExponential(2).replace('e+', 'e')
    if (magnitude >= 100) return value.toFixed(0)
    if (magnitude >= 10) return value.toFixed(1).replace(/\.0$/, '')
    return value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
  }

  /**
   * Parse the core's markup into a live SVG.
   *
   * `DOMParser` + `importNode` is the obvious way and is what this did first; at 10k points it was
   * the single largest cost of typing a point — a whole second document parsed and then deep-copied
   * into this one. The HTML parser builds SVG content in place, in the foreign-content namespace,
   * and the markup is well-formed XML by construction (the core's own test asserts it), so the
   * faster path cannot accept something the slower one would reject.
   */
  function parse(host, text) {
    host.innerHTML = text
    var node = host.firstElementChild
    if (!node || node.nodeName.toLowerCase() !== 'svg') {
      host.textContent = ''
      throw new Error('the core returned something that is not an SVG')
    }
    return node
  }

  function mount(host, panel, svgText, options) {
    var svg = parse(host, svgText)
    // The host owns the size; the SVG keeps its own coordinate system.
    svg.removeAttribute('width')
    svg.removeAttribute('height')

    var viewBox = svg.viewBox.baseVal
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

    // Hit-testing works on what was actually drawn, not on the data. The core draws each point at a
    // projected pixel position inside the canvas, so a pointer maps back to *canvas* coordinates —
    // comparing those against `point.x` (the data value, maybe 7 or 18.62) finds nothing every time.
    // The drawn marks carry both the position and, through `data-point-id`, the record they came from.
    var values = {}
    ;(panel.chart.points || []).forEach(function (point) {
      if (point && typeof point.id === 'string') values[point.id] = point
    })

    var marks = []
    Array.prototype.forEach.call(svg.querySelectorAll('circle[data-point-id]'), function (circle) {
      var cx = Number(circle.getAttribute('cx'))
      var cy = Number(circle.getAttribute('cy'))
      if (isFinite(cx) && isFinite(cy)) {
        marks.push({ id: circle.getAttribute('data-point-id'), cx: cx, cy: cy })
      }
    })

    var dot = document.createElementNS(SVG_NS, 'circle')
    dot.setAttribute('class', 'hover-dot')
    dot.setAttribute('visibility', 'hidden')
    svg.appendChild(dot)

    function zoomFactor() {
      return base.w / box.w
    }

    function apply() {
      svg.setAttribute('viewBox', box.x + ' ' + box.y + ' ' + box.w + ' ' + box.h)
      if (options.zoomLabel) options.zoomLabel.textContent = zoomFactor().toFixed(1) + '×'
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
      var rect = svg.getBoundingClientRect()
      return {
        x: box.x + ((clientX - rect.left) / rect.width) * box.w,
        y: box.y + ((clientY - rect.top) / rect.height) * box.h,
        rect: rect,
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
    }

    function showHover(mark, clientX, clientY) {
      var rect = toBox(clientX, clientY).rect
      var perPixel = box.w / rect.width
      var point = values[mark.id]
      dot.setAttribute('cx', String(mark.cx))
      dot.setAttribute('cy', String(mark.cy))
      dot.setAttribute('r', String(6 * perPixel))
      dot.setAttribute('stroke-width', String(1.5 * perPixel))
      dot.setAttribute('visibility', 'visible')

      var tooltip = options.tooltip
      tooltip.textContent = ''
      var id = document.createElement('span')
      id.className = 't-id'
      id.textContent = mark.id
      tooltip.appendChild(id)
      if (point) {
        var numbers = document.createElement('div')
        numbers.className = 't-values'
        numbers.textContent = 'x ' + format(point.x) + '   y ' + format(point.y)
        tooltip.appendChild(numbers)
      }
      var hint = document.createElement('div')
      hint.className = 't-hint'
      hint.textContent = panel.chart.provenance && panel.chart.provenance.dataset
        ? panel.chart.provenance.dataset + ' · ' + (panel.chart.provenance.shape || '')
        : ''
      if (hint.textContent) tooltip.appendChild(hint)

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
      if (marks.length === 0) return hideHover()
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
      if (best) showHover(best, clientX, clientY)
      else hideHover()
    }

    host.addEventListener('pointerdown', function (event) {
      if (event.button !== 0) return
      host.setPointerCapture(event.pointerId)
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY }
      host.classList.add('dragging')
      hideHover()
    })

    host.addEventListener('pointermove', function (event) {
      if (drag && drag.id === event.pointerId) {
        var rect = svg.getBoundingClientRect()
        box.x -= (event.clientX - drag.x) * (box.w / rect.width)
        box.y -= (event.clientY - drag.y) * (box.h / rect.height)
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
      host.classList.remove('dragging')
      drag = null
    }
    host.addEventListener('pointerup', endDrag)
    host.addEventListener('pointercancel', endDrag)
    host.addEventListener('pointerleave', function () {
      if (!drag) hideHover()
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

    apply()

    /**
     * Register a mark that was appended to the drawing after this mount. The panel's hit-testing
     * works off the marks it knows about, so a point that arrived without a redraw has to be added
     * here too — otherwise it is on screen and unreachable by hover.
     */
    function addMark(id, cx, cy, point) {
      marks.push({ id: id, cx: cx, cy: cy })
      if (point) values[id] = point
    }

    return { reset: reset, zoom: zoomFactor, addMark: addMark }
  }

  window.BenchCharts = { mount: mount }
})()
