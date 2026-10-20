import type { PointValue, Shape, ShapeField } from './events.ts'
import { BenchError } from './errors.ts'
import { timeFieldOf, validateTimeField } from './observation.ts'

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
  const input = (value ?? {}) as { id?: unknown; fields?: unknown; time_field?: unknown }
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

  let timeField: string | undefined
  if (input.time_field !== undefined) {
    if (typeof input.time_field !== 'string' || input.time_field.trim() === '') {
      throw new BenchError('invalid', `shape ${id} has an unusable time_field`, {
        hint: 'name one of its instant fields, e.g. "time_field": "date"',
      })
    }
    timeField = validateTimeField({ id, fields }, input.time_field.trim()).name
  }

  return { id, version: Number(match[1]), fields, ...(timeField === undefined ? {} : { time_field: timeField }) }
}

/** The base of a shape id, without its `.vN` suffix. */
export function shapeBase(id: string): string {
  return id.replace(/\.v[1-9][0-9]*$/, '')
}

/** The next version of a shape: `reading.v1` becomes `reading.v2`. */
export function nextShapeId(from: Shape): string {
  return `${shapeBase(from.id)}.v${from.version + 1}`
}

/** The newest declaration of a shape family. Mutations may only move a shape forward from it. */
export function latestShapeOf(shapes: Iterable<Shape>, from: Shape): Shape {
  const base = shapeBase(from.id)
  let latest = from
  for (const shape of shapes) {
    if (shapeBase(shape.id) !== base) continue
    if (shape.version > latest.version) latest = shape
  }
  return latest
}

function fieldsKey(fields: ShapeField[]): string {
  return JSON.stringify(fields.map((field) => [field.name, field.type, field.unit ?? '', field.optional === true]))
}

/**
 * Validate a recorded designation: it may only set a field on a shape that did not already have
 * one, and it may not change any field while doing it. Changing an existing designation would
 * reinterpret points that are already in the log, so that needs a different, explicit migration.
 */
export function validateTimeDesignation(from: Shape, next: Shape, timeField: string): ShapeField {
  if (from.time_field !== undefined) {
    throw new BenchError(
      'invalid',
      `shape ${from.id} already designates "${from.time_field}" as its observation time`,
      { hint: 'a designation cannot be moved by this event; it would reinterpret points already written' },
    )
  }
  if (next.id !== nextShapeId(from) || next.version !== from.version + 1) {
    throw new BenchError(
      'invalid',
      `designation of ${from.id} must create ${nextShapeId(from)}, got ${next.id}`,
    )
  }
  if (fieldsKey(next.fields) !== fieldsKey(from.fields)) {
    throw new BenchError('invalid', `designation of ${from.id} must not change its fields`, {
      hint: 'designate the time field with the same field list, or extend the shape instead',
    })
  }
  if (next.time_field !== timeField) {
    throw new BenchError(
      'invalid',
      `designation says "${timeField}" but the new declaration says "${next.time_field ?? '(none)'}"`,
    )
  }
  return validateTimeField(next, timeField)
}

/** The complete next declaration for a time designation. The field list is unchanged. */
export function planTimeDesignation(from: Shape, fieldName: string): Shape {
  const shape = validateShapeDefinition({
    id: nextShapeId(from),
    fields: from.fields,
    time_field: fieldName.trim(),
  })
  validateTimeDesignation(from, shape, shape.time_field!)
  return shape
}

/** Two declarations name the same field when every stored property agrees. */
export function sameShapeField(left: ShapeField, right: ShapeField): boolean {
  return (
    left.name === right.name &&
    left.type === right.type &&
    (left.unit ?? '') === (right.unit ?? '') &&
    (left.optional === true) === (right.optional === true)
  )
}

export interface ShapeFieldInput {
  name?: unknown
  type?: unknown
  unit?: unknown
  optional?: unknown
}

export interface ShapeExtensionPlan {
  shape: Shape
  field: ShapeField
}

/**
 * Add one field to a shape and bump its version. The old fields are copied in their exact order, so
 * an extension can only append: renaming or retyping an existing field is not an extension, it is a
 * different shape. The type is required explicitly; a missing type is a refusal, never a default.
 */
export function planShapeExtension(from: Shape, input: ShapeFieldInput): ShapeExtensionPlan {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (name === '') {
    throw new BenchError('invalid', 'an extension needs a field name', { hint: 'use --field b2b' })
  }
  if (typeof input.type !== 'string' || input.type.trim() === '') {
    throw new BenchError('invalid', `field "${name}" needs an explicit type`, {
      hint: `use --type one of: ${SHAPE_FIELD_TYPES.join(', ')}`,
    })
  }

  const field = {
    name,
    type: input.type,
    ...(typeof input.unit === 'string' && input.unit.trim() !== '' ? { unit: input.unit.trim() } : {}),
    ...(input.optional === true ? { optional: true } : {}),
  }
  // Reusing the definition validator keeps duplicate names, bad types and bad identifiers in one
  // place; the candidate is the complete next declaration, not just the new field.
  const shape = validateShapeDefinition({
    id: nextShapeId(from),
    fields: [...from.fields, field],
    ...(from.time_field === undefined ? {} : { time_field: from.time_field }),
  })
  return { shape, field: shape.fields.at(-1)! }
}

/**
 * Validate a recorded extension. The new declaration must be exactly the old one plus one field:
 * same prefix in the same order, one new last field, and the next version id. Returning the added
 * field lets a reader compare the event's redundant `field` payload with the declaration.
 */
export function validateShapeExtensionShape(from: Shape, extended: Shape): ShapeField {
  if (extended.id !== nextShapeId(from) || extended.version !== from.version + 1) {
    throw new BenchError(
      'invalid',
      `extension of "${from.id}" must be "${nextShapeId(from)}", got "${extended.id}"`,
    )
  }
  const declared = validateShapeDefinition(extended)
  if ((declared.time_field ?? '') !== (from.time_field ?? '')) {
    throw new BenchError(
      'invalid',
      `extension of "${from.id}" changes the designated observation field`,
      { hint: 'an extension may append a field; a designation change is its own recorded event' },
    )
  }
  if (declared.fields.length !== from.fields.length + 1) {
    throw new BenchError(
      'invalid',
      `extension of "${from.id}" must add exactly one field, got ${declared.fields.length - from.fields.length}`,
    )
  }
  from.fields.forEach((field, index) => {
    if (!sameShapeField(field, declared.fields[index]!)) {
      throw new BenchError(
        'invalid',
        `extension of "${from.id}" changes existing field "${field.name}"`,
        { hint: 'an extension may only append a field; use a new shape for any other change' },
      )
    }
  })
  return declared.fields.at(-1)!
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
  const timeField = timeFieldOf(shape)

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
    if (problem) {
      errors.push(problem)
    } else if (field === timeField && typeof value === 'string' && Number.isNaN(Date.parse(value))) {
      // The designated field is not just any string: it has to answer "when", so an unparseable
      // instant is refused here as well as in `resolveObservation`, for every door that validates.
      errors.push(`field "${field.name}" carries the observation time, but "${value}" is not a parseable instant`)
    }
  }

  for (const field of shape.fields) {
    const present = Object.hasOwn(values, field.name)
    if (!present && !field.optional) {
      errors.push(`missing required field "${field.name}" for shape ${shape.id}`)
    }
  }

  return { errors, warnings }
}
