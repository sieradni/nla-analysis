import { describe, expect, it } from 'vitest'
import type { Shape } from '../src/core/events.ts'
import {
  canonicalInstant,
  observationValue,
  resolveObservation,
  validateTimeField,
} from '../src/core/observation.ts'
import { validateTimeDesignation, validateValues } from '../src/core/shapes.ts'

const designated: Shape = {
  id: 'visit.v2',
  version: 2,
  time_field: 'date',
  fields: [
    { name: 'date', type: 'instant' },
    { name: 'value', type: 'number' },
  ],
}

const undesignated: Shape = {
  id: 'visit.v1',
  version: 1,
  fields: designated.fields,
}

describe('validateTimeField', () => {
  it('names a field that exists', () => {
    expect(validateTimeField(designated, 'date').name).toBe('date')
  })

  it('refuses a field the shape does not have', () => {
    expect(() => validateTimeField(designated, 'missing')).toThrow(/has no such field/)
  })

  it('refuses a field that cannot answer "when"', () => {
    expect(() => validateTimeField(designated, 'value')).toThrow(/because it is number/)
  })

  it('refuses an optional time field, because a point must have an instant', () => {
    const optional: Shape = {
      ...designated,
      fields: [{ name: 'date', type: 'instant', optional: true }, designated.fields[1]!],
    }
    expect(() => validateTimeField(optional, 'date')).toThrow(/cannot be optional/)
  })
})

describe('canonicalInstant', () => {
  it('accepts an offset and writes UTC with milliseconds', () => {
    expect(canonicalInstant('2026-10-01T12:34:56+02:00', 'date')).toBe('2026-10-01T10:34:56.000Z')
  })

  it('refuses text that is not a time, naming its source', () => {
    expect(() => canonicalInstant('yesterday', 'field "date"')).toThrow(/field "date" is not a parseable time/)
  })
})

describe('resolveObservation', () => {
  it('keeps the old rule when a shape designates nothing', () => {
    const resolved = resolveObservation(undesignated, { date: '2026-09-01T00:00:00Z', value: 1 }, '2026-09-02T00:00:00Z')
    expect(resolved.tObserved).toBe('2026-09-02T00:00:00.000Z')
    // No designation means no field is rewritten: the point is exactly what the caller supplied.
    expect(resolved.values.date).toBe('2026-09-01T00:00:00Z')
    expect(resolved.field).toBeUndefined()
  })

  it('derives the instant from the designated field and canonicalises it in the values', () => {
    const resolved = resolveObservation(designated, {
      date: '2026-10-01T12:34:56+02:00',
      value: 5,
    })
    expect(resolved.tObserved).toBe('2026-10-01T10:34:56.000Z')
    expect(resolved.values.date).toBe('2026-10-01T10:34:56.000Z')
    expect(resolved.field?.name).toBe('date')
  })

  it('accepts --at when it names the same instant', () => {
    expect(
      resolveObservation(designated, { date: '2026-10-01T00:00:00Z', value: 5 }, '2026-10-01T02:00:00+02:00')
        .tObserved,
    ).toBe('2026-10-01T00:00:00.000Z')
  })

  it('refuses --at that contradicts the field, naming both instants', () => {
    expect(() =>
      resolveObservation(designated, { date: '2026-10-01T00:00:00Z', value: 5 }, '2026-10-02T00:00:00Z'),
    ).toThrow(/field "date" says 2026-10-01T00:00:00.000Z, but --at says 2026-10-02T00:00:00.000Z/)
  })

  it('refuses a missing or unparseable designated value', () => {
    expect(() => resolveObservation(designated, { value: 5 })).toThrow(/is not a parseable instant/)
    expect(() => resolveObservation(designated, { date: 'yesterday', value: 5 })).toThrow(
      /is not a parseable instant/,
    )
  })
})

describe('observationValue', () => {
  it('reports a row-level problem without throwing', () => {
    const value = observationValue(designated, { date: 'nope', value: 5 })
    expect(value.problem).toContain('is not a parseable instant')
    expect(value.tObserved).toBeUndefined()
  })

  it('says nothing when there is no designation', () => {
    expect(observationValue(undesignated, { date: 'nope', value: 5 })).toEqual({})
  })
})

describe('validateValues with a designation', () => {
  it('refuses an unparseable instant in the designated field', () => {
    const validation = validateValues(designated, { date: 'yesterday', value: 5 })
    expect(validation.errors).toContain(
      'field "date" carries the observation time, but "yesterday" is not a parseable instant',
    )
  })

  it('leaves an ordinary instant field alone when it is not designated', () => {
    expect(validateValues(undesignated, { date: 'yesterday', value: 5 }).errors).toEqual([])
  })
})

describe('validateTimeDesignation', () => {
  const next: Shape = { ...designated, id: 'visit.v2', version: 2 }

  it('accepts a designation that only adds the time field', () => {
    expect(validateTimeDesignation(undesignated, next, 'date').name).toBe('date')
  })

  it('refuses to change a designation that already exists', () => {
    expect(() => validateTimeDesignation(designated, { ...designated, id: 'visit.v3', version: 3 }, 'date')).toThrow(
      /already designates/,
    )
  })

  it('refuses a designation event that changes the field list', () => {
    const changed: Shape = {
      ...next,
      fields: [...next.fields, { name: 'extra', type: 'number' }],
    }
    expect(() => validateTimeDesignation(undesignated, changed, 'date')).toThrow(/must not change its fields/)
  })

  it('refuses an event whose repeated field disagrees with the declaration', () => {
    expect(() => validateTimeDesignation(undesignated, next, 'value')).toThrow(/designation says "value"/)
  })
})
