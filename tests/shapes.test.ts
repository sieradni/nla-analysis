import { describe, expect, it } from 'vitest'
import { editDistance, validateShapeDefinition, validateValues } from '../src/core/shapes.ts'
import type { Shape } from '../src/core/events.ts'

describe('validateShapeDefinition', () => {
  it('accepts a shape the binder can fold, and reads its version from the id', () => {
    const declared = validateShapeDefinition({
      id: 'reading.v1',
      fields: [
        { name: 'mass', type: 'number', unit: 'g' },
        { name: 'label', type: 'string', optional: true },
      ],
    })
    expect(declared).toEqual({
      id: 'reading.v1',
      version: 1,
      fields: [
        { name: 'mass', type: 'number', unit: 'g' },
        { name: 'label', type: 'string', optional: true },
      ],
    })
  })

  it('refuses two fields with one name', () => {
    expect(() =>
      validateShapeDefinition({
        id: 'load.v1',
        fields: [
          { name: 'x', type: 'number' },
          { name: 'x', type: 'number' },
        ],
      }),
    ).toThrow(/appears twice/)
  })

  it('refuses a type the binder cannot fold', () => {
    expect(() => validateShapeDefinition({ id: 'load.v1', fields: [{ name: 'x', type: 'float' }] })).toThrow(
      /unknown type "float"/,
    )
  })

  it('refuses an id that is not a versioned shape name', () => {
    for (const id of ['load', 'load.v0', 'Load.v1']) {
      expect(() => validateShapeDefinition({ id, fields: [{ name: 'x', type: 'number' }] })).toThrow(
        /not a shape id/,
      )
    }
  })

  it('refuses a shape with no fields rather than declaring an empty one', () => {
    expect(() => validateShapeDefinition({ id: 'load.v1', fields: [] })).toThrow(/at least one field/)
  })

  it('refuses a field name the CLI could not spell as a flag', () => {
    expect(() => validateShapeDefinition({ id: 'load.v1', fields: [{ name: 'Load (N)', type: 'number' }] })).toThrow(
      /unusable name/,
    )
  })

  it('accepts a designated observation-time field at declaration', () => {
    const declared = validateShapeDefinition({
      id: 'visit.v1',
      fields: [
        { name: 'date', type: 'instant' },
        { name: 'value', type: 'number' },
      ],
      time_field: 'date',
    })
    expect(declared.time_field).toBe('date')
  })

  it('refuses a time designation that names a non-instant field', () => {
    expect(() =>
      validateShapeDefinition({
        id: 'visit.v1',
        fields: [
          { name: 'date', type: 'instant' },
          { name: 'value', type: 'number' },
        ],
        time_field: 'value',
      }),
    ).toThrow(/because it is number/)
  })
})

const shape: Shape = {
  id: 'reading.v1',
  version: 1,
  fields: [
    { name: 'x', type: 'number' },
    { name: 'temperature', type: 'number', unit: 'C' },
    { name: 'label', type: 'string', optional: true },
  ],
}

describe('validateValues', () => {
  it('accepts a well-formed point', () => {
    expect(validateValues(shape, { x: 1, temperature: 21.5 })).toEqual({ errors: [], warnings: [] })
  })

  it('suggests the intended field for a typo instead of failing silently', () => {
    const result = validateValues(shape, { x: 1, temprature: 21.5 })
    expect(result.errors).toHaveLength(1)
    expect(result.warnings[0]).toContain('did you mean "temperature"')
  })

  it('reports a missing required field', () => {
    const result = validateValues(shape, { x: 1 })
    expect(result.errors[0]).toContain('missing required field "temperature"')
  })

  it('reports a type mismatch with the offending value', () => {
    const result = validateValues(shape, { x: 'one', temperature: 21.5 })
    expect(result.errors[0]).toContain('expects a finite number')
    expect(result.errors[0]).toContain('"one"')
  })

  it('allows optional fields to be absent', () => {
    expect(validateValues(shape, { x: 1, temperature: 2 }).errors).toEqual([])
  })
})

describe('editDistance', () => {
  it('measures substitution, insertion, and deletion', () => {
    expect(editDistance('abc', 'abc')).toBe(0)
    expect(editDistance('abc', 'abd')).toBe(1)
    expect(editDistance('abc', 'ab')).toBe(1)
    expect(editDistance('abc', 'abbc')).toBe(1)
  })
})
