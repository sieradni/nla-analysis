/**
 * Charts are a restricted declarative spec, rendered to SVG. The CLI writes these to files today;
 * the desktop app will render the identical spec, so the two can never drift apart.
 */

export interface Axis {
  label: string
  unit?: string
}

/**
 * One fitted line, with an optional label. `muted` marks a secondary regime: same hue, lighter and
 * dashed, because the palette has exactly one emphasis colour and a second one would be a lie about
 * which part of the picture matters.
 */
export interface ChartSeries {
  points: ChartPoint[]
  label?: string
  muted?: boolean
}

/**
 * A plotted observation. `id` is the identity of the log event this came from, when the caller knows
 * it: without it a mark cannot be traced back to a record, so hover, selection and a saved view that
 * highlights a point are all guesses. Recipes echo the ids they were given rather than the renderer
 * trying to match points by value.
 */
export interface ChartPoint {
  x: number
  y: number
  id?: string
  label?: string
}

/**
 * What the artifact was drawn from, recorded structurally rather than only in the subtitle: a client
 * that wants to pin a view to a dataset needs to read it, not parse it out of prose.
 */
export interface ChartProvenance {
  dataset?: string
  shape?: string
}

export interface ChartSpec {
  title?: string
  subtitle?: string
  x: Axis
  y: Axis
  points?: ChartPoint[]
  provenance?: ChartProvenance
  line?: { x: number; y: number }[]
  /** Several fitted lines at once, e.g. one per time regime. */
  lines?: ChartSeries[]
  /** Half-width interval around the line, sampled at the same x as `line`. */
  band?: { x: number; y0: number; y1: number }[]
  /** Evidence line, e.g. "n = 14 · 2 parameters · DOF 12 · tentative". Always shown when present. */
  footer?: string
  /**
   * The conclusion, in words, wrapped under the axes. An artifact outlives the terminal session that
   * produced it, so it has to explain itself to whoever opens the file later.
   */
  caption?: string
}

const INK = '#1b1d1f'
const MUTED = '#71767c'
const GRID = '#e8eaed'
const ACCENT = '#1f6feb'
const PAPER = '#ffffff'

const WIDTH = 760
const HEIGHT = 440
const LEFT = 72
const RIGHT = 26
const BOTTOM = 62

const NUMBERS = `ui-monospace, "Cascadia Mono", "Segoe UI Mono", Consolas, monospace`
const LABELS = `ui-sans-serif, "Segoe UI", system-ui, sans-serif`

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function formatNumber(value: number): string {
  if (value === 0) return '0'
  const magnitude = Math.abs(value)
  if (magnitude >= 1e6 || magnitude < 1e-3) {
    return value.toExponential(2).replace('e+', 'e').replace('e-0', 'e-')
  }
  if (magnitude >= 100) return value.toFixed(0)
  if (magnitude >= 10) return value.toFixed(1).replace(/\.0$/, '')
  return value.toFixed(2).replace(/\.?0+$/, '')
}

/** Wrap prose to the canvas. Long captions are clipped at three lines with an ellipsis; the full
 *  text always lives in the log. */
export function wrapCaption(text: string, maxChars = 112, maxLines = 3): string[] {
  const words = text.split(/\s+/).filter((word) => word !== '')
  if (words.length === 0) return []

  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const candidate = current === '' ? word : `${current} ${word}`
    if (candidate.length <= maxChars) {
      current = candidate
      continue
    }
    lines.push(current)
    current = word
  }
  if (current !== '') lines.push(current)

  if (lines.length <= maxLines) return lines
  const kept = lines.slice(0, maxLines)
  kept[maxLines - 1] = `${kept[maxLines - 1]!}…`
  return kept
}

function niceStep(range: number): number {
  const exponent = Math.floor(Math.log10(range))
  const fraction = range / 10 ** exponent
  const nice = fraction < 1.5 ? 1 : fraction < 3 ? 2 : fraction < 7 ? 5 : 10
  return nice * 10 ** exponent
}

export function ticks(min: number, max: number, target = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return []
  if (min === max) return [min]
  const step = niceStep((max - min) / Math.max(1, target - 1))
  const first = Math.ceil(min / step) * step
  const out: number[] = []
  for (let value = first; value <= max + step * 1e-9; value += step) {
    out.push(Number(value.toFixed(10)))
  }
  return out
}

function domain(values: number[]): [number, number] {
  if (values.length === 0) return [0, 1]
  let min = Infinity
  let max = -Infinity
  for (const value of values) {
    if (value < min) min = value
    if (value > max) max = value
  }
  if (min === max) {
    const pad = Math.abs(min) > 0 ? Math.abs(min) * 0.1 : 1
    return [min - pad, max + pad]
  }
  const pad = (max - min) * 0.06
  return [min - pad, max + pad]
}

export function renderChart(spec: ChartSpec): string {
  const xs: number[] = []
  const ys: number[] = []
  for (const p of spec.points ?? []) {
    xs.push(p.x)
    ys.push(p.y)
  }
  for (const p of spec.line ?? []) {
    xs.push(p.x)
    ys.push(p.y)
  }
  for (const b of spec.band ?? []) {
    xs.push(b.x)
    ys.push(b.y0, b.y1)
  }
  for (const series of spec.lines ?? []) {
    for (const p of series.points) {
      xs.push(p.x)
      ys.push(p.y)
    }
  }

  const [x0, x1] = domain(xs)
  const [y0, y1] = domain(ys)

  // Headers are stacked from a cursor so title, subtitle, and the evidence line can never overlap.
  let cursor = 25
  const titleY = cursor
  if (spec.title) cursor += 19
  const subtitleY = cursor
  if (spec.subtitle) cursor += 17
  const footerY = cursor
  if (spec.footer) cursor += 15
  const top = cursor + 9

  const captionLines = spec.caption ? wrapCaption(spec.caption) : []
  const bottom = BOTTOM + captionLines.length * 15

  const plotW = WIDTH - LEFT - RIGHT
  const plotH = HEIGHT - top - bottom
  const bottomEdge = top + plotH

  const sx = (value: number): number => LEFT + ((value - x0) / (x1 - x0)) * plotW
  const sy = (value: number): number => top + plotH - ((value - y0) / (y1 - y0)) * plotH

  const parts: string[] = []
  const xLabel = spec.x.unit ? `${spec.x.label} (${spec.x.unit})` : spec.x.label
  const yLabel = spec.y.unit ? `${spec.y.label} (${spec.y.unit})` : spec.y.label
  const accessibleName = spec.title ?? `${yLabel} against ${xLabel}`

  // Provenance rides on the root element as data attributes: invisible on the canvas, present for
  // anything that reads the file later and needs to know what it is looking at.
  const provenance = [
    spec.provenance?.dataset === undefined ? '' : ` data-dataset="${escapeXml(spec.provenance.dataset)}"`,
    spec.provenance?.shape === undefined ? '' : ` data-shape="${escapeXml(spec.provenance.shape)}"`,
  ].join('')

  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}" role="img" aria-label="${escapeXml(accessibleName)}"${provenance}>`,
    `<title>${escapeXml(accessibleName)}</title>`,
    `<desc>${escapeXml(spec.footer ?? `${(spec.points ?? []).length} points plotted`)}</desc>`,
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="${PAPER}"/>`,
  )

  if (spec.title) {
    parts.push(
      `<text x="${LEFT}" y="${titleY}" font-family="${LABELS}" font-size="15" font-weight="600" fill="${INK}">${escapeXml(spec.title)}</text>`,
    )
  }
  if (spec.subtitle) {
    parts.push(
      `<text x="${LEFT}" y="${subtitleY}" font-family="${LABELS}" font-size="11.5" fill="${MUTED}">${escapeXml(spec.subtitle)}</text>`,
    )
  }
  if (spec.footer) {
    parts.push(
      `<text x="${LEFT}" y="${footerY}" font-family="${NUMBERS}" font-size="10.5" fill="${MUTED}" style="font-variant-numeric:tabular-nums">${escapeXml(spec.footer)}</text>`,
    )
  }

  for (const tick of ticks(y0, y1)) {
    const y = sy(tick)
    parts.push(
      `<line x1="${LEFT}" y1="${y.toFixed(2)}" x2="${(LEFT + plotW).toFixed(2)}" y2="${y.toFixed(2)}" stroke="${GRID}" stroke-width="1"/>`,
      `<text x="${LEFT - 10}" y="${(y + 4).toFixed(2)}" text-anchor="end" font-family="${NUMBERS}" font-size="11" fill="${MUTED}" style="font-variant-numeric:tabular-nums">${formatNumber(tick)}</text>`,
    )
  }

  for (const tick of ticks(x0, x1)) {
    const x = sx(tick)
    parts.push(
      `<line x1="${x.toFixed(2)}" y1="${top}" x2="${x.toFixed(2)}" y2="${bottomEdge.toFixed(2)}" stroke="${GRID}" stroke-width="1"/>`,
      `<text x="${x.toFixed(2)}" y="${(bottomEdge + 20).toFixed(2)}" text-anchor="middle" font-family="${NUMBERS}" font-size="11" fill="${MUTED}" style="font-variant-numeric:tabular-nums">${formatNumber(tick)}</text>`,
    )
  }

  if (spec.band && spec.band.length > 1) {
    const upper = spec.band.map((b) => `${sx(b.x).toFixed(2)},${sy(b.y1).toFixed(2)}`)
    const lower = [...spec.band].reverse().map((b) => `${sx(b.x).toFixed(2)},${sy(b.y0).toFixed(2)}`)
    parts.push(
      `<path d="M${upper.join(' L')} L${lower.join(' L')} Z" fill="${ACCENT}" fill-opacity="0.14" stroke="none"/>`,
    )
  }

  if (spec.line && spec.line.length > 1) {
    const path = spec.line.map((p) => `${sx(p.x).toFixed(2)},${sy(p.y).toFixed(2)}`).join(' L')
    parts.push(
      `<path d="M${path}" fill="none" stroke="${ACCENT}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`,
    )
  }

  for (const series of spec.lines ?? []) {
    if (series.points.length < 2) continue
    const path = series.points.map((p) => `${sx(p.x).toFixed(2)},${sy(p.y).toFixed(2)}`).join(' L')
    const style = series.muted
      ? `stroke="${ACCENT}" stroke-opacity="0.55" stroke-dasharray="6 4"`
      : `stroke="${ACCENT}"`
    parts.push(
      `<path d="M${path}" fill="none" ${style} stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`,
    )
  }

  // Legend, right-aligned inside the plot. Only for series that were actually drawn and named:
  // an entry for something invisible would be a key to nothing.
  const named = (spec.lines ?? []).filter(
    (series) => series.points.length > 1 && typeof series.label === 'string' && series.label !== '',
  ).slice(0, 3)

  if (named.length > 0) {
    // The legend sits over the data, so it needs a plate behind it; a label crossing a line is
    // unreadable and looks like a rendering fault.
    const labels = named.map((series) => series.label as string)
    const widest = Math.max(...labels.map((label) => label.length)) * 5.6 + 30
    const plateRight = LEFT + plotW - 8
    parts.push(
      `<rect x="${(plateRight - widest).toFixed(2)}" y="${(top + 3).toFixed(2)}" width="${widest.toFixed(2)}" height="${(named.length * 15 + 6).toFixed(2)}" rx="3" fill="${PAPER}" fill-opacity="0.96" stroke="${GRID}" stroke-width="1"/>`,
    )
  }

  named.forEach((series, index) => {
    const label = series.label as string
    const y = top + 15 + index * 15
    const rightEdge = LEFT + plotW - 8
    const swatchEnd = rightEdge - label.length * 5.6 - 8
    const style = series.muted
      ? `stroke="${ACCENT}" stroke-opacity="0.55" stroke-dasharray="6 4"`
      : `stroke="${ACCENT}"`
    parts.push(
      `<line x1="${(swatchEnd - 18).toFixed(2)}" y1="${(y - 4).toFixed(2)}" x2="${swatchEnd.toFixed(2)}" y2="${(y - 4).toFixed(2)}" ${style} stroke-width="2" stroke-linecap="round"/>`,
      `<text class="legend" x="${rightEdge.toFixed(2)}" y="${y.toFixed(2)}" text-anchor="end" font-family="${NUMBERS}" font-size="10.5" fill="${MUTED}">${escapeXml(label)}</text>`,
    )
  })

  for (const point of spec.points ?? []) {
    const identity = point.id === undefined ? '' : ` data-point-id="${escapeXml(point.id)}"`
    parts.push(
      `<circle cx="${sx(point.x).toFixed(2)}" cy="${sy(point.y).toFixed(2)}" r="3.4" fill="${ACCENT}" stroke="${PAPER}" stroke-width="1.5"${identity}/>`,
    )
  }

  parts.push(
    `<line x1="${LEFT}" y1="${bottomEdge.toFixed(2)}" x2="${(LEFT + plotW).toFixed(2)}" y2="${bottomEdge.toFixed(2)}" stroke="${MUTED}" stroke-width="1"/>`,
    `<line x1="${LEFT}" y1="${top}" x2="${LEFT}" y2="${bottomEdge.toFixed(2)}" stroke="${MUTED}" stroke-width="1"/>`,
    `<text x="${(LEFT + plotW / 2).toFixed(2)}" y="${(bottomEdge + 40).toFixed(2)}" text-anchor="middle" font-family="${LABELS}" font-size="11.5" fill="${INK}">${escapeXml(xLabel)}</text>`,
    `<text transform="translate(18 ${(top + plotH / 2).toFixed(2)}) rotate(-90)" text-anchor="middle" font-family="${LABELS}" font-size="11.5" fill="${INK}">${escapeXml(yLabel)}</text>`,
  )

  captionLines.forEach((line, index) => {
    parts.push(
      `<text class="caption" x="${LEFT}" y="${(bottomEdge + 59 + index * 15).toFixed(2)}" font-family="${LABELS}" font-size="11" fill="${MUTED}">${escapeXml(line)}</text>`,
    )
  })

  parts.push('</svg>')

  return parts.join('\n')
}
