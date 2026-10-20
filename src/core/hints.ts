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
 * The first tab a project can build, from the shape's own fields. The horizontal axis is the first
 * field plottable on an x axis, the vertical the first numeric one; that is exactly the rule the
 * window's pickers and `axes.ts` use, so the example cannot ask for a field the refusal would reject.
 */
export function plotHint(shape: Shape, dataset = 'main', name = 'first tab'): PlotHint {
  const y = plottableFields(shape.fields, 'y')[0]
  // A different field on each axis when the shape has one: "altitude against altitude" is a
  // technically valid plot and a useless example.
  const x = plottableFields(shape.fields, 'x').find((field) => field.name !== y?.name) ?? y
  if (!x || !y) {
    const missing = y ? 'a horizontal field' : 'a numeric vertical field'
    return {
      problem: `shape ${shape.id} has no ${missing}, so a plain plot cannot be drawn; add one with bench shape extend --field <name> --type <type>`,
    }
  }
  return { command: `view new "${name}" --dataset ${dataset} --x-field ${x.name} --y-field ${y.name}` }
}

/** The sentence a chart with no rows carries, naming both the next act and how to run it. */
export function emptyChartNote(shape: Shape, dataset: string): string {
  return `No observations in ${dataset} yet. Add one: ${addHint(shape)}`
}
