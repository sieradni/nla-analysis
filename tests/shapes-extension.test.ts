import { describe, expect, it } from 'vitest'
import { bind } from '../src/core/binder.ts'
import { makeEvent } from '../src/core/events.ts'
import type { BenchEvent, Shape } from '../src/core/events.ts'
import { DEFAULT_DATASET, DEFAULT_SHAPE } from '../src/core/project.ts'
import { planShapeExtension } from '../src/core/shapes.ts'

function seed(): BenchEvent[] {
  return [
    makeEvent('project_created', 'test', { name: 'extension' }),
    makeEvent('shape_defined', 'test', { shape: DEFAULT_SHAPE }),
    makeEvent('dataset_created', 'test', { dataset: DEFAULT_DATASET, shape: DEFAULT_SHAPE.id }),
  ]
}

describe('shape extension', () => {
  it('appends one field as a new version and leaves the old declaration alone', () => {
    const plan = planShapeExtension(DEFAULT_SHAPE, { name: 'b2b', type: 'integer' })

    expect(plan.shape.id).toBe('xy.v2')
    expect(plan.shape.version).toBe(2)
    expect(plan.shape.fields.map((field) => field.name)).toEqual(['x', 'y', 'b2b'])
    expect(plan.field).toEqual({ name: 'b2b', type: 'integer' })
    // The source is not mutated: history is the previous declaration, not a view of this one.
    expect(DEFAULT_SHAPE.fields.map((field) => field.name)).toEqual(['x', 'y'])
  })

  it('refuses a duplicate name, a missing type, and an unknown type', () => {
    expect(() => planShapeExtension(DEFAULT_SHAPE, { name: 'x', type: 'number' })).toThrow(/appears twice/)
    expect(() => planShapeExtension(DEFAULT_SHAPE, { name: 'b2b' })).toThrow(/explicit type/)
    expect(() => planShapeExtension(DEFAULT_SHAPE, { name: 'b2b', type: 'count' })).toThrow(/unknown type/)
  })

  it('moves the dataset forward without changing values already recorded', () => {
    const point = makeEvent('point_recorded', 'test', {
      dataset: DEFAULT_DATASET,
      shape: DEFAULT_SHAPE.id,
      values: { x: 1, y: 2 },
      t_observed: '2026-01-01T00:00:00.000Z',
    })
    const plan = planShapeExtension(DEFAULT_SHAPE, { name: 'b2b', type: 'integer' })
    const extended = makeEvent('shape_extended', 'test', {
      from: DEFAULT_SHAPE.id,
      shape: plan.shape,
      field: plan.field,
    })
    const state = bind([...seed(), point, extended])

    expect(state.problems).toEqual([])
    expect(state.shapes.get('xy.v2')).toEqual(plan.shape)
    expect(state.datasets.get(DEFAULT_DATASET)?.shape).toBe('xy.v2')
    expect(state.datasets.get(DEFAULT_DATASET)?.points[0]?.shape).toBe('xy.v1')
    expect(state.datasets.get(DEFAULT_DATASET)?.points[0]?.values).toEqual({ x: 1, y: 2 })
  })

  it('reports a hand-written extension that rewrites an existing field', () => {
    const plan = planShapeExtension(DEFAULT_SHAPE, { name: 'b2b', type: 'integer' })
    const changed: Shape = {
      ...plan.shape,
      fields: [
        { name: 'x', type: 'integer' },
        { name: 'y', type: 'number' },
        { name: 'b2b', type: 'integer' },
      ],
    }
    const state = bind([
      ...seed(),
      makeEvent('shape_extended', 'test', {
        from: DEFAULT_SHAPE.id,
        shape: changed,
        field: { name: 'b2b', type: 'integer' },
      }),
    ])

    expect(state.problems.some((problem) => problem.includes('changes existing field "x"'))).toBe(true)
    // A refused extension is not a declaration: the dataset keeps the shape it had.
    expect(state.datasets.get(DEFAULT_DATASET)?.shape).toBe(DEFAULT_SHAPE.id)
    expect(state.shapes.has('xy.v2')).toBe(false)
  })

  it('reports an extension whose event field disagrees with the declaration', () => {
    const plan = planShapeExtension(DEFAULT_SHAPE, { name: 'b2b', type: 'integer' })
    const state = bind([
      ...seed(),
      makeEvent('shape_extended', 'test', {
        from: DEFAULT_SHAPE.id,
        shape: plan.shape,
        field: { name: 'b2b', type: 'number' },
      }),
    ])

    expect(state.problems.some((problem) => problem.includes('recorded field does not match'))).toBe(true)
    expect(state.datasets.get(DEFAULT_DATASET)?.shape).toBe(DEFAULT_SHAPE.id)
  })
})
