import type { PointValue, Shape, ShapeField } from './events.ts'
import { BenchError } from './errors.ts'

/** The field types a shape may declare. Kept here so a shape cannot be written with a type the
 * binder does not know how to fold. */
export const SHAPE_FIELD_TYPES = ['number', 'integer', 'string', 'instant', 'boolean'] as const

const FIELD_NAME = /^[a-z][a-z0-9_]{0,31}$/
// Version 0 is not a shape: the first declared version is 1, so the id carries it.
const SHAPE_ID = /^[a-z][a-z0-9_-]*\.v([1-9][0-9]*)$/

/**
 * Validate a shape before it is declared in a log, because a shape is irreversible: every point
 * written against it inherits its mistakes, and the binder has no way to reinterpret them later.
 *
 * The rules are deliberately narrow — names the CLI can spell as flags, types the binder folds — and
 * the refusal names the field that is wrong, the same way point validation does.
 */
export function validateShapeDefinition(value: unknown): Shape {
  const input = (value ?? {}) as { id?: unknown; fields?: unknown }
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  const match = SHAPE_ID.exec(id)
  if (!match) {
    throw new BenchError('invalid', `"${id || '(no id)'}" is not a shape id`, {
      hint: 'shape ids look like reading.v1 — a lowercase name and a version',
    })
  }
  if (!Array.isArray(input.fields) || input.fields.length === 0) {
    throw new BenchError('invalid', `shape ${id} needs at least one field`, {
      hint: 'a point with no fields has nothing to record',
    })
  }

  const fields: ShapeField[] = []
  const seen = new Set<string>()
  input.fields.forEach((raw, index) => {
    const field = (raw ?? {}) as { name?: unknown; type?: unknown; optional?: unknown; unit?: unknown }
    const name = typeof field.name === 'string' ? field.name.trim() : ''
    if (!FIELD_NAME.test(name)) {
      throw new BenchError('invalid', `field ${index + 1} has an unusable name "${name}"`, {
        hint: 'field names are lowercase letters, digits and underscores, starting with a letter',
      })
    }
    if (seen.has(name)) {
      throw new BenchError('invalid', `field "${name}" appears twice in shape ${id}`, {
        hint: 'two fields with one name would make every point ambiguous',
      })
    }
    seen.add(name)
    const type = field.type
    if (typeof type !== 'string' || !(SHAPE_FIELD_TYPES as readonly string[]).includes(type)) {
      throw new BenchError(
        'invalid',
        `field "${name}" has unknown type "${String(type)}"`,
        { hint: `use one of: ${SHAPE_FIELD_TYPES.join(', ')}` },
      )
    }
    fields.push({
      name,
      type: type as ShapeField['type'],
      ...(field.optional === true ? { optional: true } : {}),
      ...(typeof field.unit === 'string' && field.unit.trim() !== '' ? { unit: field.unit.trim() } : {}),
    })
  })

  return { id, version: Number(match[1]), fields }
}

/** The suggestion and validation helpers below are about points, not definitions. */

export interface ShapeValidation {
  errors: string[]
  warnings: string[]
}

/** Damerau-free Levenshtein distance; enough to catch the typos people actually make. */
export function editDistance(a: string, b: string): number {
  const rows = a.length + 1
  const cols = b.length + 1
  let previous = Array.from({ length: cols }, (_, i) => i)
  for (let i = 1; i < rows; i++) {
    const current = [i]
    for (let j = 1; j < cols; j++) {
      const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)
      current[j] = Math.min(current[j - 1]! + 1, previous[j]! + 1, substitution)
    }
    previous = current
  }
  return previous[cols - 1]!
}

function suggest(name: string, candidates: ShapeField[]): string | undefined {
  let best: { field: ShapeField; distance: number } | undefined
  for (const field of candidates) {
    const distance = editDistance(name.toLowerCase(), field.name.toLowerCase())
    if (distance <= 3 && (!best || distance < best.distance)) best = { field, distance }
  }
  return best?.field.name
}

function typeProblem(field: ShapeField, value: PointValue): string | undefined {
  if (value === null) return undefined
  switch (field.type) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? undefined
        : `field "${field.name}" expects a finite number, got ${JSON.stringify(value)}`
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
        ? undefined
        : `field "${field.name}" expects an integer, got ${JSON.stringify(value)}`
    case 'string':
    case 'instant':
      return typeof value === 'string'
        ? undefined
        : `field "${field.name}" expects a string, got ${JSON.stringify(value)}`
    case 'boolean':
      return typeof value === 'boolean'
        ? undefined
        : `field "${field.name}" expects a boolean, got ${JSON.stringify(value)}`
  }
}

/**
 * Validate a point against its shape. Unknown fields are warnings, not errors: the log accepts what
 * you give it, but `bench check` surfaces the typo instead of silently splitting the dataset.
 */
export function validateValues(
  shape: Shape,
  values: Record<string, PointValue>,
): ShapeValidation {
  const errors: string[] = []
  const warnings: string[] = []
  const byName = new Map(shape.fields.map((field) => [field.name, field]))

  for (const [name, value] of Object.entries(values)) {
    const field = byName.get(name)
    if (!field) {
      const hint = suggest(name, shape.fields)
      warnings.push(
        hint
          ? `unknown field "${name}" in shape ${shape.id}; did you mean "${hint}"?`
          : `unknown field "${name}" in shape ${shape.id}`,
      )
      continue
    }
    const problem = typeProblem(field, value)
    if (problem) errors.push(problem)
  }

  for (const field of shape.fields) {
    const present = Object.hasOwn(values, field.name)
    if (!present && !field.optional) {
      errors.push(`missing required field "${field.name}" for shape ${shape.id}`)
    }
  }

  return { errors, warnings }
}
