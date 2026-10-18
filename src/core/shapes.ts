import type { PointValue, Shape, ShapeField } from './events.ts'

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
