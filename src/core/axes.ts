import type { Shape, ShapeField } from './events.ts'
import { BenchError } from './errors.ts'

/**
 * Axis resolution is one decision, made once: which declared field each axis reads, and whether the
 * horizontal axis is a clock. `bench chart`, a saved panel, and the window's tab dialog all pass the
 * same field names here, so none of them can invent a different rule about what is plottable.
 */
export interface AxisField {
  field: ShapeField
  /** True when values are ISO instants and the chart should label the axis as time. */
  time: boolean
}

export interface AxisPair {
  x: AxisField
  y: AxisField
}

export interface AxisRequest {
  x?: string
  y?: string
}

const NUMERIC = new Set(['number', 'integer'])
const PLOTTABLE_X = new Set(['number', 'integer', 'instant'])

function field(shape: Shape, name: string): ShapeField | undefined {
  return shape.fields.find((candidate) => candidate.name === name)
}

/** The fields a side can read. Exported so the window's pickers and the resolver agree by
 * construction, rather than a renderer keeping its own copy of which types are plottable. */
export function plottableFields(fields: readonly ShapeField[], side: 'x' | 'y'): ShapeField[] {
  const allowed = side === 'x' ? PLOTTABLE_X : NUMERIC
  return fields.filter((candidate) => allowed.has(candidate.type))
}

function plottable(shape: Shape, side: 'x' | 'y'): string {
  const names = plottableFields(shape.fields, side).map((candidate) => candidate.name)
  return names.length > 0 ? names.join(', ') : 'none'
}

function hint(shape: Shape): string {
  return `name the axes: --x-field <field> --y-field <field> · x can be ${plottable(shape, 'x')}; y can be ${plottable(shape, 'y')}`
}

/**
 * Resolve a pair of fields against the shape. `x`/`y` remain the defaults, so a panel or chart saved
 * before named axes existed reads exactly as it did. A custom shape must name its fields; guessing
 * two numeric fields would be a different question than the user asked.
 */
export function resolveAxes(shape: Shape, request: AxisRequest = {}): AxisPair {
  const xName = request.x ?? 'x'
  const yName = request.y ?? 'y'
  const x = field(shape, xName)
  const y = field(shape, yName)

  if (!x) {
    throw new BenchError('missing', `shape ${shape.id} has no field "${xName}"`, { hint: hint(shape) })
  }
  if (!y) {
    throw new BenchError('missing', `shape ${shape.id} has no field "${yName}"`, { hint: hint(shape) })
  }
  if (!PLOTTABLE_X.has(x.type)) {
    throw new BenchError('invalid', `field "${x.name}" cannot be a horizontal axis`, {
      hint: `use a number or instant field; plottable: ${plottable(shape, 'x')}`,
    })
  }
  if (!NUMERIC.has(y.type)) {
    throw new BenchError('invalid', `field "${y.name}" is ${y.type}, not numeric`, {
      hint: `use a number or integer field; plottable: ${plottable(shape, 'y')}`,
    })
  }

  return {
    x: { field: x, time: x.type === 'instant' },
    y: { field: y, time: false },
  }
}

/**
 * One point's value on an axis, or `undefined` when the point does not carry a usable value. A
 * missing value is skipped and counted; inventing a zero or a gap-filling point would draw a
 * measurement nobody made.
 */
export function axisValue(field: ShapeField, value: unknown): number | undefined {
  if (field.type === 'instant') {
    if (typeof value !== 'string') return undefined
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  if (field.type === 'number' || field.type === 'integer') {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  }
  return undefined
}
