import { describe, expect, it } from 'vitest'
import { axisValue, resolveAxes } from '../src/core/axes.ts'
import { BenchError } from '../src/core/errors.ts'
import type { Shape } from '../src/core/events.ts'
import { DEFAULT_SHAPE } from '../src/core/project.ts'

const flight: Shape = {
  id: 'flight.v1',
  version: 1,
  fields: [
    { name: 'date', type: 'instant' },
    { name: 'altitude', type: 'number' },
    { name: 'app', type: 'number' },
    { name: 'note', type: 'string' },
  ],
}

describe('axis resolution', () => {
  it('keeps the historical x/y pair when no fields are named', () => {
    const axes = resolveAxes(DEFAULT_SHAPE)
    expect(axes.x.field.name).toBe('x')
    expect(axes.y.field.name).toBe('y')
    expect(axes.x.time).toBe(false)
  })

  it('resolves a field pair and marks an instant horizontal axis as time', () => {
    const axes = resolveAxes(flight, { x: 'date', y: 'altitude' })
    expect(axes.x.field.name).toBe('date')
    expect(axes.x.time).toBe(true)
    expect(axes.y.field.name).toBe('altitude')
  })

  it('refuses a missing field, a non-numeric y, and a non-plottable x', () => {
    expect(() => resolveAxes(flight, { x: 'date', y: 'missing' })).toThrow(/no field "missing"/)
    expect(() => resolveAxes(flight, { x: 'app', y: 'date' })).toThrow(/not numeric/)
    expect(() => resolveAxes(flight, { x: 'note', y: 'app' })).toThrow(/cannot be a horizontal axis/)
  })

  it('reads an instant as epoch milliseconds and skips unusable values', () => {
    const axes = resolveAxes(flight, { x: 'date', y: 'altitude' })
    expect(axisValue(axes.x.field, '2026-10-19T12:41:32.498Z')).toBe(
      Date.parse('2026-10-19T12:41:32.498Z'),
    )
    expect(axisValue(axes.x.field, 'not a time')).toBeUndefined()
    expect(axisValue(axes.y.field, 992.4)).toBe(992.4)
    expect(axisValue(axes.y.field, '992.4')).toBeUndefined()
  })

  it('gives a custom shape a way forward instead of silently choosing x/y', () => {
    expect(() => resolveAxes(flight)).toThrow(/no field "x"/)
    try {
      resolveAxes(flight)
    } catch (error) {
      expect(error).toBeInstanceOf(BenchError)
      expect((error as BenchError).hint).toContain('--x-field')
      expect((error as BenchError).hint).toContain('date')
    }
  })
})
