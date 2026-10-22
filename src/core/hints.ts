/**
 * One place a "what next" sentence or sample command comes from the shape a project actually
 * declared. `bench init`, the empty-panel refusal, the window's no-tabs state, and the analysis
 * refusal all read these functions instead of teaching `x`/`y` to a shape that has neither.
 *
 * A hint is a command *tail*: `add --values …`, not `bench add …`. The caller prefixes whichever
 * launcher it was started from and the project path, because a command that cannot run is worse
 * than no hint at all (the packaged build has no `bench` on PATH).
 */
import type { PointValue, Shape, ShapeField } from './events.ts'
import { plottableFields } from './axes.ts'

const SAMPLE: Record<ShapeField['type'], PointValue> = {
  number: 1.2,
  integer: 3,
  string: 'sample',
  instant: '2026-10-01T00:00:00Z',
  boolean: true,
}

/** One plausible value of a field's type. Never recorded by itself: only printed as an example. */
export function sampleValue(field: ShapeField): PointValue {
  return SAMPLE[field.type]
}

/** Sample values for every declared field, keyed by name. */
export function sampleValues(shape: Shape): Record<string, PointValue> {
  const values: Record<string, PointValue> = {}
  for (const field of shape.fields) values[field.name] = sampleValue(field)
  return values
}

/** `add --values '{…}' --at …`, derived from the shape the project declared. */
export function addHint(shape: Shape): string {
  // A designated field already carries the time; repeating it as --at teaches a second source of
  // truth that the model now refuses to let disagree.
  const at = shape.time_field === undefined ? ' --at 2026-10-01T00:00:00Z' : ''
  return `add --values '${JSON.stringify(sampleValues(shape))}'${at}`
}

export interface PlotHint {
  /** The `view new` command tail, when the shape can name a plottable pair. */
  command?: string
  /** Why it cannot, when it cannot: a sentence naming the missing kind of field. */
  problem?: string
}

/**
 * The first tab a project can build, from the shape's own fields.
 *
 * Each axis is filled from the fields that can read it — a number or instant across, a number up —
 * and a field named for the axis wins, because that is the pair a panel saved without axes already
 * reads (`axes.ts`) and the pair the window's pickers prefill. Otherwise the first field each axis
 * can read is used, skipping one already on the other axis: "altitude against altitude" is a valid
 * plot and a useless example. A shape with one plottable field gets that field against itself,
 * because it is the only pair there is; with no numeric field at all there is nothing to suggest.
 */
export function plotHint(shape: Shape, dataset = 'main', name = 'first tab'): PlotHint {
  const up = plottableFields(shape.fields, 'y')
  const y = up.find((field) => field.name === 'y') ?? up[0]
  if (!y) {
    return {
      problem: `shape ${shape.id} has no numeric vertical field, so a plain plot cannot be drawn; add one with bench shape extend --field <name> --type <type>`,
    }
  }
  const across = plottableFields(shape.fields, 'x')
  const x = across.find((field) => field.name === 'x') ?? across.find((field) => field.name !== y.name) ?? y
  return { command: `view new "${name}" --dataset ${dataset} --x-field ${x.name} --y-field ${y.name}` }
}

/** The sentence a chart with no rows carries, naming both the next act and how to run it. */
export function emptyChartNote(shape: Shape, dataset: string): string {
  return `No observations in ${dataset} yet. Add one: ${addHint(shape)}`
}
