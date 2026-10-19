import { describe, expect, it } from 'vitest'
import { activePoints, bind } from '../src/core/binder.ts'
import { DEFAULT_SHAPE, DEFAULT_DATASET } from '../src/core/project.ts'
import { makeEvent } from '../src/core/events.ts'
import type { BenchEvent } from '../src/core/events.ts'

function seed(): BenchEvent[] {
  return [
    makeEvent('project_created', 'test', { name: 'drift' }),
    makeEvent('shape_defined', 'test', { shape: DEFAULT_SHAPE }),
    makeEvent('dataset_created', 'test', { dataset: DEFAULT_DATASET, shape: DEFAULT_SHAPE.id }),
  ]
}

function point(x: number, y: number, t: string) {
  return makeEvent('point_recorded', 'test', {
    dataset: DEFAULT_DATASET,
    shape: DEFAULT_SHAPE.id,
    values: { x, y },
    t_observed: t,
  })
}

describe('bind', () => {
  it('orders points by observed time, not insertion order', () => {
    const late = point(2, 2, '2026-01-02T00:00:00.000Z')
    const early = point(1, 1, '2026-01-01T00:00:00.000Z')
    const state = bind([...seed(), late, early])

    expect(activePoints(state, DEFAULT_DATASET).map((p) => p.values.x)).toEqual([1, 2])
  })

  it('orders by instant, not by spelling, when offsets differ', () => {
    // 2026-01-01T00:00:00+02:00 is 2025-12-31T22:00Z, i.e. EARLIER than 2025-12-31T23:00Z.
    // Compared as strings it looks later, which would silently reorder the series.
    const earlier = point(1, 1, '2026-01-01T00:00:00+02:00')
    const later = point(2, 2, '2025-12-31T23:00:00Z')
    const state = bind([...seed(), earlier, later])

    expect(activePoints(state, DEFAULT_DATASET).map((p) => p.values.x)).toEqual([1, 2])
  })

  it('orders points that name the same instant by a stable rule', () => {
    const spellings = ['2026-01-01T00:00:00Z', '2026-01-01T00:00:00.000Z', '2026-01-01T02:00:00+02:00']
    const points = spellings.map((t, index) => point(index + 1, index + 1, t))
    const state = bind([...seed(), ...points])

    expect(activePoints(state, DEFAULT_DATASET).map((p) => p.values.x).sort()).toEqual([1, 2, 3])
  })

  it('folds a correction into the original point and records the chain', () => {
    const original = point(1, 3, '2026-01-01T00:00:00.000Z')
    const correction = makeEvent('point_corrected', 'test', {
      dataset: DEFAULT_DATASET,
      supersedes: original.id,
      values: { y: 3.4 },
      reason: 'typo',
    })
    const state = bind([...seed(), original, correction])
    const [folded] = activePoints(state, DEFAULT_DATASET)

    expect(folded?.id).toBe(original.id)
    expect(folded?.values.y).toBe(3.4)
    expect(folded?.values.x).toBe(1)
    expect(folded?.corrections).toEqual([correction.id])
  })

  it('keeps retracted points in history but out of the active set', () => {
    const kept = point(1, 1, '2026-01-01T00:00:00.000Z')
    const dropped = point(2, 2, '2026-01-02T00:00:00.000Z')
    const retraction = makeEvent('point_retracted', 'test', {
      dataset: DEFAULT_DATASET,
      supersedes: dropped.id,
      reason: 'instrument fault',
    })
    const state = bind([...seed(), kept, dropped, retraction])

    expect(activePoints(state, DEFAULT_DATASET)).toHaveLength(1)
    expect(state.datasets.get(DEFAULT_DATASET)?.points).toHaveLength(2)
    expect(state.problems).toEqual([])
  })

  it('reports an unknown shape once per dataset, and also when the dataset is empty', () => {
    const bornBroken = [
      makeEvent('project_created', 'test', { name: 'broken' }),
      makeEvent('shape_defined', 'test', { shape: DEFAULT_SHAPE }),
      makeEvent('dataset_created', 'test', { dataset: DEFAULT_DATASET, shape: 'gone.v9' }),
      point(1, 1, '2026-01-01T00:00:00.000Z'),
      point(2, 2, '2026-01-02T00:00:00.000Z'),
      point(3, 3, '2026-01-03T00:00:00.000Z'),
    ]
    const withPoints = bind(bornBroken)
    expect(withPoints.problems).toEqual([`dataset "${DEFAULT_DATASET}" references unknown shape "gone.v9"`])

    // An empty dataset referencing a missing shape is still a problem worth reporting. Checking
    // inside the per-point loop meant this case was silently fine.
    const empty = bind(bornBroken.filter((event) => event.type !== 'point_recorded'))
    expect(empty.problems).toHaveLength(1)
  })

  it('reports a correction that targets a missing point', () => {
    const orphan = makeEvent('point_corrected', 'test', {
      dataset: DEFAULT_DATASET,
      supersedes: '01JZZZZZZZZZZZZZZZZZZZZZZZ',
      values: { y: 2 },
    })
    const state = bind([...seed(), orphan])

    expect(state.problems).toHaveLength(1)
    expect(state.problems[0]).toContain('unknown point')
  })
})
