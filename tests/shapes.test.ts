import { describe, expect, it } from 'vitest'
import { editDistance, validateValues } from '../src/core/shapes.ts'
import type { Shape } from '../src/core/events.ts'

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
