/* Pure text formatting for the window: a panel's facts, a chart's accessible name, a point's values. */
export function factsFor(panel) {
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

/**
 * The accessible name of a panel. The canvas pass hides both SVG halves from the accessibility
 * tree, so this label has to carry everything the drawing says in text: the axes, the footer's
 * n/DOF/verdict, the caption's interval and p, and the empty-state instruction. Otherwise a
 * screen reader gets a title and no way to know what the chart measured or concluded.
 */
export function chartAccessibleLabel(panel, title, facts, status) {
  var chart = panel.chart || {}
  var axis = function (side, fallback) {
    var spec = chart[side] || {}
    var label = spec.label || fallback
    return spec.unit ? label + ' (' + spec.unit + ')' : label
  }
  var parts = [
    title + '.',
    'x ' + axis('x', 'x') + ', y ' + axis('y', 'y') + '.',
  ]
  // A plain plot's footer is only its n, and the facts line already carries the live count. Keeping
  // it out avoids a stale footer in the accessible name after an incremental point; a recipe's
  // footer carries DOF and must stay.
  if (panel.recipe && chart.footer) parts.push(chart.footer)
  if (chart.caption) parts.push(chart.caption)
  if (chart.empty) parts.push(chart.empty)
  parts.push(facts + '.', status + '.', 'Drag to pan, wheel to zoom.')
  return parts.join(' ')
}

export function describeValues(values) {
  return Object.keys(values)
    .map(function (name) {
      return name + ' ' + String(values[name])
    })
    .join('  ')
}
