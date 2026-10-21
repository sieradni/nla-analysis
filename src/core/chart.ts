/**
 * Charts are a restricted declarative spec, rendered to SVG. The CLI writes these to files today;
 * the desktop app will render the identical spec, so the two can never drift apart.
 */

export interface Axis {
  label: string
  unit?: string
  /** `time` means values are epoch milliseconds and tick labels are instants, not numbers. */
  format?: 'time'
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
  /**
   * The point's own observation time, carried so a hover can say when the reading was taken rather
   * than only what it measured. The window cannot look it up: the drawing is the one thing a reader
   * is pointing at, and it already knows which record each mark is.
   */
  tObserved?: string
  /** That time is an import's estimate (`t_estimated` in the log), not a measurement. */
  timeEstimated?: true
}

/**
 * One point, already projected into the chart's own 760×440 units. The window paints these on a
 * canvas instead of building a DOM node per observation, so a rescale does not pay for ten thousand
 * elements. They come from the same `geometry` the SVG uses, so the two can never disagree about
 * where a mark belongs.
 */
export interface ChartMark {
  /** The log record this mark stands for, when the caller knew it. */
  id?: string
  cx: number
  cy: number
}

/**
 * What the artifact was drawn from, recorded structurally rather than only in the subtitle: a client
 * that wants to pin a view to a dataset needs to read it, not parse it out of prose.
 */
export interface ChartProvenance {
  dataset?: string
  shape?: string
  /** The dataset version this drawing was made from, when it was made from one in particular. */
  version?: number
}

/**
 * What the drawing stands on, as numbers rather than prose. The window composes its own evidence
 * sentence from these (ADR 0015); the footer stays the artifact's line, so `bench chart` and anything
 * that opens the file later reads the recipe's own words without a second renderer.
 */
export interface ChartEvidence {
  points: number
  /** Fitted parameters, per segment when `regimes` is set. */
  parameters?: number
  regimes?: number
  dof?: number
  /** Why the frame shows no curve: no model, too few observations, or too few in a segment. */
  noCurve?: 'unmodelled' | 'insufficient' | 'segments'
  /** Observations each segment needs, when `noCurve` is `segments`. */
  needed?: number
  band?: { level: number; kind: string }
  /** Rows the axes could not place, when a required field was missing. */
  skipped?: { points: number; x: string; y: string }
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
  /** The same evidence as numbers, for the window to put in its own words. */
  evidence?: ChartEvidence
  /**
   * A chart with nothing to draw says so in the plot area and draws no tick numbers: an empty
   * frame with a `0 … 1` axis would look like data, and a fresh project has to be able to save a
   * real tab that explains what to do next.
   */
  empty?: string
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
const POINT_RADIUS = 3.4

/** How a mark is painted. The core owns it so the SVG artifact and the window's canvas agree. */
export interface ChartMarkStyle {
  radius: number
  fill: string
  stroke: string
  strokeWidth: number
}

const MARK_STYLE: ChartMarkStyle = {
  radius: POINT_RADIUS,
  fill: ACCENT,
  stroke: PAPER,
  strokeWidth: 1.5,
}

// Single quotes inside these stacks, deliberately: they are interpolated into a double-quoted XML
// attribute, and `font-family="ui-monospace, "Cascadia Mono"…"` is not well-formed XML. A browser
// loading the file as HTML forgives that; anything parsing it as XML — a canvas loader, an image
// pipeline, the desktop window — refuses the whole document.
const NUMBERS = `ui-monospace, 'Cascadia Mono', 'Segoe UI Mono', Consolas, monospace`
const LABELS = `ui-sans-serif, 'Segoe UI', system-ui, sans-serif`

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

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

function domain(values: number[], time = false): [number, number] {
  if (values.length === 0) return [0, 1]
  let min = Infinity
  let max = -Infinity
  for (const value of values) {
    if (value < min) min = value
    if (value > max) max = value
  }
  if (min === max) {
    // Epoch milliseconds are enormous, so the numeric 10% pad would turn one observation into a
    // multi-year axis. A single instant gets half a day on each side instead: still a real domain,
    // and the mark is visible rather than a dot at the edge of a decade.
    const pad = time ? 12 * HOUR : Math.abs(min) > 0 ? Math.abs(min) * 0.1 : 1
    return [min - pad, max + pad]
  }
  const pad = (max - min) * 0.06
  return [min - pad, max + pad]
}

const TIME_STEPS = [
  1000,
  5000,
  15_000,
  30_000,
  60_000,
  5 * 60_000,
  15 * 60_000,
  30 * 60_000,
  HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  7 * DAY,
  30 * DAY,
  365 * DAY,
]

/** Ticks on a clock, aligned to whole seconds, minutes, hours or days rather than to raw numbers. */
function timeTicks(min: number, max: number, target = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return []
  if (min === max) return [min]
  const rough = (max - min) / Math.max(1, target - 1)
  const step = TIME_STEPS.find((candidate) => candidate >= rough) ?? TIME_STEPS.at(-1)!
  const first = Math.ceil(min / step) * step
  const out: number[] = []
  for (let value = first; value <= max + step * 1e-9; value += step) out.push(value)
  return out
}

function padTwo(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * A tick on a clock, in the reader's own timezone.
 *
 * The log stores UTC, but a tick is read beside a mark and beside the hover: the same instant must
 * not read as two different times on one screen, so the axis uses the same clock the readouts do.
 */
function formatTime(value: number, range: number): string {
  const date = new Date(value)
  const day = `${date.getFullYear()}-${padTwo(date.getMonth() + 1)}-${padTwo(date.getDate())}`
  if (range < 2 * DAY) return `${day} ${padTwo(date.getHours())}:${padTwo(date.getMinutes())}`
  if (range < 90 * DAY) return day
  return `${date.getFullYear()}-${padTwo(date.getMonth() + 1)}`
}

function axisTicks(axis: Axis, min: number, max: number): number[] {
  return axis.format === 'time' ? timeTicks(min, max) : ticks(min, max)
}

function formatTick(value: number, axis: Axis, range: number): string {
  return axis.format === 'time' ? formatTime(value, range) : formatNumber(value)
}

/** The canvas size a single chart occupies, exported so a view can lay panels out in a grid. */
export const CHART_WIDTH = WIDTH
export const CHART_HEIGHT = HEIGHT

/**
 * One chart's contents, split at the marks and without the `<svg>` wrapper. `under` already includes
 * the background plate, so a view can compose panels without duplicating any of the drawing.
 */
interface ChartFrame {
  accessibleName: string
  desc: string
  /** Everything drawn before the observations: plate, header, grid, fits, legend. */
  under: string[]
  /** Everything drawn after them: the empty-state sentence, axes, labels, caption. */
  over: string[]
  marks: ChartMark[]
}

/** Where one value sits on the canvas, and the axes it was placed against. */
interface Geometry {
  x0: number
  x1: number
  y0: number
  y1: number
  top: number
  bottomEdge: number
  plotW: number
  plotH: number
  sx: (value: number) => number
  sy: (value: number) => number
  /** Placement of the stacked header and the wrapped caption, so frame can draw without recomputing. */
  titleY: number
  subtitleY: number
  footerY: number
  captionLines: string[]
  xLabel: string
  yLabel: string
}

/**
 * The scales a spec implies, derived from everything it draws — points, line, band, series. This is
 * the one place the mapping from data to canvas is decided, so a mark appended later lands exactly
 * where a full redraw would put it.
 */
function geometry(spec: ChartSpec): Geometry {
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

  const [x0, x1] = domain(xs, spec.x.format === 'time')
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

  return {
    x0,
    x1,
    y0,
    y1,
    top,
    bottomEdge,
    plotW,
    plotH,
    sx: (value: number): number => LEFT + ((value - x0) / (x1 - x0)) * plotW,
    sy: (value: number): number => top + plotH - ((value - y0) / (y1 - y0)) * plotH,
    titleY,
    subtitleY,
    footerY,
    captionLines,
    xLabel: spec.x.unit ? `${spec.x.label} (${spec.x.unit})` : spec.x.label,
    yLabel: spec.y.unit ? `${spec.y.label} (${spec.y.unit})` : spec.y.label,
  }
}

/** One mark's markup, from the same code that draws a whole chart. */
function pointMark(mark: ChartMark): string {
  const identity = mark.id === undefined ? '' : ` data-point-id="${escapeXml(mark.id)}"`
  return `<circle cx="${mark.cx.toFixed(2)}" cy="${mark.cy.toFixed(2)}" r="${MARK_STYLE.radius}" fill="${MARK_STYLE.fill}" stroke="${MARK_STYLE.stroke}" stroke-width="${MARK_STYLE.strokeWidth}"${identity}/>`
}

/**
 * Where one more observation belongs on a chart that already has its scales — or `null` when the
 * point would move them.
 *
 * This exists so a typed point can appear without redrawing ten thousand of them: the window paints
 * this mark onto the canvas it already has. `null` is the important half of the contract: a point
 * outside the drawn domain would rescale the axes, and a rescale is a different picture, not an
 * extra mark, so the caller has to redraw instead of patching. The projection is the same one
 * `renderChart` uses, so the patched mark and a redrawn one land in the same place.
 */
export function incrementalMark(spec: ChartSpec, point: ChartPoint): ChartMark | null {
  // An empty chart has no scale to place a mark against; its first point is a redraw, which is
  // where real ticks appear. Patching one in would leave a mark on an unlabeled 0 … 1 frame.
  if (spec.empty) return null
  const { x0, x1, y0, y1, sx, sy } = geometry(spec)
  if (point.x < x0 || point.x > x1 || point.y < y0 || point.y > y1) return null
  return {
    ...(point.id === undefined ? {} : { id: point.id }),
    cx: Number(sx(point.x).toFixed(2)),
    cy: Number(sy(point.y).toFixed(2)),
  }
}

function frame(spec: ChartSpec, options: { silentEmpty?: boolean } = {}): ChartFrame {
  const {
    x0,
    x1,
    y0,
    y1,
    top,
    bottomEdge,
    plotW,
    plotH,
    sx,
    sy,
    titleY,
    subtitleY,
    footerY,
    captionLines,
    xLabel,
    yLabel,
  } = geometry(spec)

  const under: string[] = [`<rect width="${WIDTH}" height="${HEIGHT}" fill="${PAPER}"/>`]
  const over: string[] = []
  const accessibleName = spec.title ?? `${yLabel} against ${xLabel}`
  const desc = options.silentEmpty
    ? `${(spec.points ?? []).length} points plotted`
    : (spec.empty ?? spec.footer ?? `${(spec.points ?? []).length} points plotted`)

  if (spec.title) {
    under.push(
      `<text x="${LEFT}" y="${titleY}" font-family="${LABELS}" font-size="15" font-weight="600" fill="${INK}">${escapeXml(spec.title)}</text>`,
    )
  }
  if (spec.subtitle) {
    under.push(
      `<text x="${LEFT}" y="${subtitleY}" font-family="${LABELS}" font-size="11.5" fill="${MUTED}">${escapeXml(spec.subtitle)}</text>`,
    )
  }
  if (spec.footer) {
    under.push(
      `<text x="${LEFT}" y="${footerY}" font-family="${NUMBERS}" font-size="10.5" fill="${MUTED}" style="font-variant-numeric:tabular-nums">${escapeXml(spec.footer)}</text>`,
    )
  }

  for (const tick of spec.empty ? [] : ticks(y0, y1)) {
    const y = sy(tick)
    under.push(
      `<line x1="${LEFT}" y1="${y.toFixed(2)}" x2="${(LEFT + plotW).toFixed(2)}" y2="${y.toFixed(2)}" stroke="${GRID}" stroke-width="1"/>`,
      `<text x="${LEFT - 10}" y="${(y + 4).toFixed(2)}" text-anchor="end" font-family="${NUMBERS}" font-size="11" fill="${MUTED}" style="font-variant-numeric:tabular-nums">${formatNumber(tick)}</text>`,
    )
  }

  for (const tick of spec.empty ? [] : axisTicks(spec.x, x0, x1)) {
    const x = sx(tick)
    under.push(
      `<line x1="${x.toFixed(2)}" y1="${top}" x2="${x.toFixed(2)}" y2="${bottomEdge.toFixed(2)}" stroke="${GRID}" stroke-width="1"/>`,
      `<text x="${x.toFixed(2)}" y="${(bottomEdge + 20).toFixed(2)}" text-anchor="middle" font-family="${NUMBERS}" font-size="11" fill="${MUTED}" style="font-variant-numeric:tabular-nums">${formatTick(tick, spec.x, x1 - x0)}</text>`,
    )
  }

  if (spec.band && spec.band.length > 1) {
    const upper = spec.band.map((b) => `${sx(b.x).toFixed(2)},${sy(b.y1).toFixed(2)}`)
    const lower = [...spec.band].reverse().map((b) => `${sx(b.x).toFixed(2)},${sy(b.y0).toFixed(2)}`)
    under.push(
      `<path d="M${upper.join(' L')} L${lower.join(' L')} Z" fill="${ACCENT}" fill-opacity="0.14" stroke="none"/>`,
    )
  }

  if (spec.line && spec.line.length > 1) {
    const path = spec.line.map((p) => `${sx(p.x).toFixed(2)},${sy(p.y).toFixed(2)}`).join(' L')
    under.push(
      `<path d="M${path}" fill="none" stroke="${ACCENT}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`,
    )
  }

  for (const series of spec.lines ?? []) {
    if (series.points.length < 2) continue
    const path = series.points.map((p) => `${sx(p.x).toFixed(2)},${sy(p.y).toFixed(2)}`).join(' L')
    const style = series.muted
      ? `stroke="${ACCENT}" stroke-opacity="0.55" stroke-dasharray="6 4"`
      : `stroke="${ACCENT}"`
    under.push(
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
    under.push(
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
    under.push(
      `<line x1="${(swatchEnd - 18).toFixed(2)}" y1="${(y - 4).toFixed(2)}" x2="${swatchEnd.toFixed(2)}" y2="${(y - 4).toFixed(2)}" ${style} stroke-width="2" stroke-linecap="round"/>`,
      `<text class="legend" x="${rightEdge.toFixed(2)}" y="${y.toFixed(2)}" text-anchor="end" font-family="${NUMBERS}" font-size="10.5" fill="${MUTED}">${escapeXml(label)}</text>`,
    )
  })

  const marks: ChartMark[] = (spec.points ?? []).map((point) => ({
    ...(point.id === undefined ? {} : { id: point.id }),
    cx: Number(sx(point.x).toFixed(2)),
    cy: Number(sy(point.y).toFixed(2)),
  }))

  if (spec.empty && !options.silentEmpty) {
    const lines = wrapCaption(spec.empty, 88, 3)
    const first = top + plotH / 2 - ((lines.length - 1) * 15) / 2 + 4
    lines.forEach((line, index) => {
      over.push(
        `<text class="empty" x="${(LEFT + plotW / 2).toFixed(2)}" y="${(first + index * 15).toFixed(2)}" text-anchor="middle" font-family="${LABELS}" font-size="12" fill="${MUTED}">${escapeXml(line)}</text>`,
      )
    })
  }

  over.push(
    `<line x1="${LEFT}" y1="${bottomEdge.toFixed(2)}" x2="${(LEFT + plotW).toFixed(2)}" y2="${bottomEdge.toFixed(2)}" stroke="${MUTED}" stroke-width="1"/>`,
    `<line x1="${LEFT}" y1="${top}" x2="${LEFT}" y2="${bottomEdge.toFixed(2)}" stroke="${MUTED}" stroke-width="1"/>`,
    `<text x="${(LEFT + plotW / 2).toFixed(2)}" y="${(bottomEdge + 40).toFixed(2)}" text-anchor="middle" font-family="${LABELS}" font-size="11.5" fill="${INK}">${escapeXml(xLabel)}</text>`,
    `<text transform="translate(18 ${(top + plotH / 2).toFixed(2)}) rotate(-90)" text-anchor="middle" font-family="${LABELS}" font-size="11.5" fill="${INK}">${escapeXml(yLabel)}</text>`,
  )

  captionLines.forEach((line, index) => {
    over.push(
      `<text class="caption" x="${LEFT}" y="${(bottomEdge + 59 + index * 15).toFixed(2)}" font-family="${LABELS}" font-size="11" fill="${MUTED}">${escapeXml(line)}</text>`,
    )
  })

  return { accessibleName, desc, under, over, marks }
}

// Provenance rides on the root element as data attributes: invisible on the canvas, present for
// anything that reads the file later and needs to know what it is looking at.
function provenanceAttributes(spec: ChartSpec): string {
  return [
    spec.provenance?.dataset === undefined ? '' : ` data-dataset="${escapeXml(spec.provenance.dataset)}"`,
    spec.provenance?.shape === undefined ? '' : ` data-shape="${escapeXml(spec.provenance.shape)}"`,
    spec.provenance?.version === undefined ? '' : ` data-dataset-version="${spec.provenance.version}"`,
  ].join('')
}

function svgDocument(
  accessibleName: string,
  desc: string,
  parts: string[],
  spec: ChartSpec,
  plain = false,
): string {
  // In the window the drawing is one half of an image whose DOM host carries the accessible name:
  // a second `role="img"` inside it would be a nested image announced twice, with a worse label.
  const identity = plain
    ? ' aria-hidden="true"'
    : ` role="img" aria-label="${escapeXml(accessibleName)}"`
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}"${identity}${provenanceAttributes(spec)}>`,
    `<title>${escapeXml(accessibleName)}</title>`,
    `<desc>${escapeXml(desc)}</desc>`,
    ...parts,
    '</svg>',
  ].join('\n')
}

export function renderChart(spec: ChartSpec): string {
  const { accessibleName, desc, under, over, marks } = frame(spec)
  return svgDocument(accessibleName, desc, [...under, ...marks.map(pointMark), ...over], spec)
}

/**
 * The window's drawing, split around the marks.
 *
 * The SVG file is one document; the window paints the observations on a canvas between two halves
 * of it. That keeps the file and the window from having two renderers while letting ten thousand
 * marks cost one canvas draw rather than ten thousand DOM nodes. Layer order is the artifact's own:
 * `under` holds the plate, header, grid, fitted lines and legend; `over` holds the empty-state
 * sentence, axes, labels and caption.
 */
export interface ChartLayers {
  under: string
  over: string
  /**
   * Projected positions packed as `[cx0, cy0, cx1, cy1, …]`, in `spec.points` order. The window
   * needs the position, the id and the two values for each point; ten thousand objects would clone
   * across the process boundary more slowly than the paint this split exists to save, so the three
   * parallel arrays travel instead.
   */
  marks: Float32Array
  /** The same points' data values, for the tooltip; packed arrays rather than objects. */
  xs: Float64Array
  ys: Float64Array
  /** Record ids in point order, newline-joined; an empty entry where a point had none. */
  ids: string
  /**
   * The points' observation times in point order, newline-joined; an empty entry where a row had
   * none. ISO strings rather than epoch numbers because the window formats them through the one
   * formatter it already owns, which reads a string; ten thousand of them is one string to clone,
   * the same way the ids travel.
   */
  times: string
  /** One character per point: `1` where the log says the time is an estimate, `0` where it does not. */
  estimates: string
  style: ChartMarkStyle
}

export interface ChartLayerOptions {
  /**
   * Leave the chrome out of the window's drawing: the title, the provenance subtitle, the footer and
   * the empty-state sentence. Those are DOM the renderer composes from its one copy owner, so a
   * screen reader and a sighted reader get the same sentence and nothing is rewritten after mount.
   */
  plain?: boolean
}

export function renderChartLayers(spec: ChartSpec, options: ChartLayerOptions = {}): ChartLayers {
  // `plain` is the window's drawing: axes, grid, fits and marks only. The strip owns the title, the
  // renderer's copy owner owns the evidence, the verdict and the empty sentence, so none of those
  // words appear here — and neither does the provenance that names the dataset and shape.
  // The empty sentence goes too, but `empty` itself stays: it is what tells the frame not to draw a
  // `0 … 1` axis that would look like data.
  const drawn = options.plain
    ? { ...spec, title: undefined, subtitle: undefined, footer: undefined, provenance: undefined }
    : spec
  const { accessibleName, desc, under, over, marks } = frame(drawn, { silentEmpty: options.plain })
  const points = spec.points ?? []
  const packed = new Float32Array(marks.length * 2)
  const xs = new Float64Array(points.length)
  const ys = new Float64Array(points.length)
  const ids: string[] = []
  const times: string[] = []
  const estimates: string[] = []
  marks.forEach((mark, index) => {
    packed[index * 2] = mark.cx
    packed[index * 2 + 1] = mark.cy
  })
  points.forEach((point, index) => {
    xs[index] = point.x
    ys[index] = point.y
    ids.push(point.id ?? '')
    times.push(point.tObserved ?? '')
    estimates.push(point.timeEstimated === true ? '1' : '0')
  })
  return {
    under: svgDocument(accessibleName, desc, under, drawn, options.plain),
    over: svgDocument(accessibleName, desc, over, drawn, options.plain),
    marks: packed,
    xs,
    ys,
    ids: ids.join('\n'),
    times: times.join('\n'),
    estimates: estimates.join(''),
    style: MARK_STYLE,
  }
}

/**
 * A chart placed at an offset, for composing several into one canvas. A nested `<g>` keeps every
 * coordinate inside the panel local, so a panel never has to know where it sits.
 */
export function renderChartGroup(
  spec: ChartSpec,
  at: { x: number; y: number; panel?: number },
): string {
  const { accessibleName, desc, under, over, marks } = frame(spec)
  const identity = at.panel === undefined ? '' : ` data-panel="${at.panel}"`
  return [
    `<g transform="translate(${at.x} ${at.y})"${identity}${provenanceAttributes(spec)}>`,
    `<title>${escapeXml(accessibleName)}</title>`,
    `<desc>${escapeXml(desc)}</desc>`,
    ...under,
    ...marks.map(pointMark),
    ...over,
    '</g>',
  ].join('\n')
}
