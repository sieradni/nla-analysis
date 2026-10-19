import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assessRuns, buildRunInput, freshnessNote, hashInput, hashRecipeFile } from '../src/core/analysis.ts'
import { bind } from '../src/core/binder.ts'
import type { ProjectState } from '../src/core/binder.ts'
import type { BenchEvent } from '../src/core/events.ts'

/**
 * Freshness is the difference between an analysis result and a claim. These tests pin the three
 * states — current, stale, cannot-be-checked — against events written with explicit timestamps,
 * because a test that depends on how fast the machine runs passes for the wrong reason.
 */

let counter = 0

function event(type: string, at: string, payload: Record<string, unknown>): BenchEvent {
  counter += 1
  return {
    v: 1,
    id: `01TEST${String(counter).padStart(20, '0')}`,
    type,
    at,
    session: 'test',
    ...payload,
  } as unknown as BenchEvent
}

function point(at: string, x: number, y: number): BenchEvent {
  return event('point_recorded', at, {
    dataset: 'main',
    shape: 'xy.v1',
    values: { x, y },
    t_observed: at,
  })
}

const SHAPE = {
  id: 'xy.v1',
  version: 1,
  fields: [
    { name: 'x', type: 'number' },
    { name: 'y', type: 'number' },
  ],
}

function scaffold(): BenchEvent[] {
  return [
    event('project_created', '2026-01-01T00:00:00.000Z', { name: 'fresh' }),
    event('shape_defined', '2026-01-01T00:00:00.001Z', { shape: SHAPE }),
    event('dataset_created', '2026-01-01T00:00:00.002Z', { dataset: 'main', shape: 'xy.v1' }),
    point('2026-01-02T00:00:00.000Z', 1, 2.4),
    point('2026-01-02T01:00:00.000Z', 2, 4.9),
    point('2026-01-02T02:00:00.000Z', 3, 7.1),
    point('2026-01-02T03:00:00.000Z', 4, 9.6),
  ]
}

let root: string
let recipeHash: string
const RECIPE = 'fit'

/** Record a run the way the CLI does: hashing the input it actually consumed, and the recipe file. */
function recordedRun(state: ProjectState, at: string, overrides: Record<string, unknown> = {}): BenchEvent {
  const input = buildRunInput(state, 'main')!
  return event('analysis_run', at, {
    recipe: RECIPE,
    recipe_hash: recipeHash,
    params: { degree: 1 },
    dataset: 'main',
    input_hash: hashInput(input),
    verdict: 'supported',
    ...overrides,
  })
}

/**
 * A project and a run over it, built from one set of events.
 *
 * Calling `scaffold()` twice would mint fresh ids the second time, so the run would no longer be
 * over the same points — the mistake this helper exists to make impossible.
 */
function projectWithRun(at = '2026-01-03T00:00:00.000Z', overrides: Record<string, unknown> = {}) {
  const base = scaffold()
  const state = bind(base)
  const run = recordedRun(state, at, overrides)
  return { base, state, run }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'bench-analysis-'))
  await mkdir(join(root, 'recipes'), { recursive: true })
  await writeFile(join(root, 'recipes', 'fit.py'), 'def run(data, params):\n    return {}\n', 'utf8')
  recipeHash = (await hashRecipeFile(root, RECIPE))!
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('analysis freshness', () => {
  it('hashes the evidence, not the order events were written in', () => {
    const input = buildRunInput(bind(scaffold()), 'main')!
    // The property worth pinning: a replayed or reordered log still describes the same evidence.
    const reversed = { ...input, points: [...input.points].reverse() }
    expect(hashInput(reversed)).toBe(hashInput(input))

    const changed = {
      ...input,
      points: input.points.map((entry, index) => (index === 0 ? { ...entry, values: { x: 1, y: 99 } } : entry)),
    }
    expect(hashInput(changed)).not.toBe(hashInput(input))
  })

  it('calls a run current when nothing has changed since', async () => {
    const { base, run } = projectWithRun()

    const only = (await assessRuns(root, bind([...base, run]))).get(run.id)!
    expect(only.status).toBe('fresh')
    expect(freshnessNote(only)).toBe('still current')
  })

  it('counts the points added since a run', async () => {
    const { base, run } = projectWithRun()
    const judged = bind([...base, run, point('2026-01-04T00:00:00.000Z', 5, 12.1)])

    const verdict = (await assessRuns(root, judged)).get(run.id)!
    expect(verdict.status).toBe('stale')
    expect(verdict.addedSince).toBe(1)
    expect(verdict.reason).toBe('1 point(s) added since this run')
    expect(freshnessNote(verdict)).toBe('stale: 1 point(s) added since this run')
  })

  it('counts a point retracted since a run', async () => {
    const { base, state, run } = projectWithRun()
    const judged = bind([
      ...base,
      run,
      event('point_retracted', '2026-01-04T00:00:00.000Z', {
        supersedes: state.datasets.get('main')!.points[0]!.id,
        reason: 'bad reading',
      }),
    ])

    const verdict = (await assessRuns(root, judged)).get(run.id)!
    expect(verdict.status).toBe('stale')
    expect(verdict.retractedSince).toBe(1)
    expect(verdict.reason).toContain('retracted')
  })

  it('counts a correction that landed after the run, though the point is older', async () => {
    const { base, state, run } = projectWithRun()
    const judged = bind([
      ...base,
      run,
      event('point_corrected', '2026-01-04T00:00:00.000Z', {
        supersedes: state.datasets.get('main')!.points[1]!.id,
        values: { y: 5.4 },
      }),
    ])

    const verdict = (await assessRuns(root, judged)).get(run.id)!
    expect(verdict.status).toBe('stale')
    expect(verdict.correctedSince).toBe(1)
    // The point itself predates the run, so this must not be reported as an added point.
    expect(verdict.addedSince).toBe(0)
  })

  it('reports a recipe that changed after the run', async () => {
    const { base, run } = projectWithRun('2026-01-03T00:00:00.000Z', {
      recipe_hash: 'a-hash-from-an-older-recipe',
    })

    const verdict = (await assessRuns(root, bind([...base, run]))).get(run.id)!
    expect(verdict.status).toBe('stale')
    expect(verdict.reason).toBe('the recipe has changed since this run')
  })

  it('refuses to call a run current when the log does not say what it read', async () => {
    const { base, run } = projectWithRun()
    const judged = bind([
      ...base,
      event('dataset_created', '2026-01-02T00:00:00.000Z', { dataset: 'second', shape: 'xy.v1' }),
      { ...run, dataset: undefined } as unknown as BenchEvent,
    ])

    const verdict = (await assessRuns(root, judged)).get(run.id)!
    expect(verdict.status).toBe('unverifiable')
    expect(freshnessNote(verdict)).toContain('cannot be checked')
  })

  it('says so when the recipe file is gone, rather than assuming the result holds', async () => {
    const { base, run } = projectWithRun()

    const verdict = (await assessRuns(join(root, 'does-not-exist'), bind([...base, run]))).get(run.id)!
    expect(verdict.status).toBe('unverifiable')
    expect(verdict.reason).toContain('missing')
  })

  it('gives a recipe the same identity whether the checkout stored CRLF or LF', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bench-recipe-hash-'))
    try {
      await mkdir(join(dir, 'recipes'), { recursive: true })
      await writeFile(join(dir, 'recipes', 'fit.py'), 'x = 1\ny = 2\n', 'utf8')
      const lf = await hashRecipeFile(dir, 'fit')
      await writeFile(join(dir, 'recipes', 'fit.py'), 'x = 1\r\ny = 2\r\n', 'utf8')
      // Python runs both files identically, so a run must not read as stale because a checkout
      // happened to use Windows line endings.
      expect(await hashRecipeFile(dir, 'fit')).toBe(lf)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
