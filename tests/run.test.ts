import { existsSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { coerceChartSpec, interpreterCandidates, RecipeRunner } from '../src/core/runner.ts'
import type { RunInput } from '../src/core/runner.ts'

/** Synthetic series with optional tiny alternation so residuals are not exactly zero. */
function makeInput(count: number, shape: 'linear' | 'quadratic' | 'flat' | 'exact'): RunInput {
  const points = Array.from({ length: count }, (_, index) => {
    const x = index + 1
    const wobble = index % 2 === 0 ? 0.04 : -0.04
    const y =
      shape === 'linear' ? 2.4 * x + 0.3 + wobble
      : shape === 'quadratic' ? 0.5 * x * x - 1.2 * x + 3 + wobble
      : shape === 'flat' ? 7
      : 3 * x + 1
    return { id: `p${index}`, t: '2026-10-01T00:00:00.000Z', values: { x, y } }
  })
  return {
    dataset: 'synthetic',
    shape: 'xy.v1',
    fields: [
      { name: 'x', type: 'number' },
      { name: 'y', type: 'number', unit: 'C' },
    ],
    points,
  }
}

/**
 * The analysis environment is optional to *have* (a fresh clone has no venv until it runs
 * `pnpm setup:recipes`) but not optional to *work*: if the interpreter is present and misbehaves,
 * these tests fail rather than skip. A silently skipped suite looks exactly like a passing one.
 */
const localInterpreter = interpreterCandidates(process.cwd())[0]!
const venvPresent = existsSync(localInterpreter)

const runner = new RecipeRunner(process.cwd())
let environment: Record<string, string> | undefined
if (venvPresent) {
  try {
    await runner.start()
    environment = await runner.environment()
  } catch (error) {
    // Surfaced by the first assertion below, so a broken runtime is visible, not skipped.
    environment = { bootstrap_error: error instanceof Error ? error.message : String(error) }
  }
}

if (!venvPresent) {
  console.warn(
    `[run.test] skipping fit tests: no analysis environment at ${localInterpreter}. Run \`pnpm setup:recipes\`.`,
  )
}

afterAll(async () => {
  await runner.dispose()
})

describe('coerceChartSpec', () => {
  it('drops non-finite numbers instead of drawing them', () => {
    const spec = coerceChartSpec({
      x: { label: 'x' },
      y: { label: 'y' },
      points: [
        { x: 1, y: 2 },
        { x: Number.NaN, y: 3 },
        { x: 4, y: Number.POSITIVE_INFINITY },
        { x: 'nope', y: 5 },
      ],
      line: [{ x: 1, y: 2 }],
    })

    expect(spec.points).toEqual([{ x: 1, y: 2 }])
    expect(spec.line).toEqual([{ x: 1, y: 2 }])
  })

  it('orders band endpoints and discards incomplete rows', () => {
    const spec = coerceChartSpec({
      x: { label: 'x' },
      y: { label: 'y' },
      band: [
        { x: 1, y0: 5, y1: 2 },
        { x: 2, y0: 1 },
        { x: 3, y0: 4, y1: 6 },
      ],
    })

    expect(spec.band).toEqual([
      { x: 1, y0: 2, y1: 5 },
      { x: 3, y0: 4, y1: 6 },
    ])
  })

  it('survives an empty or malformed payload from a recipe', () => {
    for (const payload of [null, undefined, 'text', 42, []]) {
      const spec = coerceChartSpec(payload)
      expect(spec.x.label).toBe('x')
      expect(spec.y.label).toBe('y')
      expect(spec.points).toBeUndefined()
      expect(spec.line).toBeUndefined()
      expect(spec.band).toBeUndefined()
    }
  })

  it('keeps units when a recipe supplies them', () => {
    const spec = coerceChartSpec({ x: { label: 'time', unit: 's' }, y: { label: 'temp', unit: 'C' } })
    expect(spec.x).toEqual({ label: 'time', unit: 's' })
    expect(spec.y).toEqual({ label: 'temp', unit: 'C' })
  })
})

describe('interpreterCandidates', () => {
  it('prefers a project-local environment over whatever is on PATH', () => {
    const candidates = interpreterCandidates('/repo')
    expect(candidates[0]).toContain('.venv')
    expect(candidates.at(-1)).toBe('python3')
  })
})

describe.skipIf(!venvPresent)('fit recipe (requires the analysis environment)', () => {
  it('starts a working, pinned runtime rather than guessing', () => {
    expect(environment?.bootstrap_error ?? '').toBe('')
    expect(environment?.python).toBeTruthy()
    expect(environment?.numpy).not.toBe('missing')
    expect(environment?.scipy).not.toBe('missing')
  })

  it('refuses to draw a line through two points', async () => {
    const outcome = await runner.run('fit', { degree: 1 }, makeInput(2, 'linear'))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    expect(outcome.result.verdict).toBe('insufficient')
    expect(outcome.result.chart.line).toBeUndefined()
    expect(outcome.result.chart.band).toBeUndefined()
    expect(outcome.result.chart.footer).toContain('no curve drawn')
    expect(outcome.result.narrative).toContain('exact by construction')
    expect(outcome.result.chart.points).toHaveLength(2)
  })

  it('refuses a quadratic through three points for the same reason', async () => {
    const outcome = await runner.run('fit', { degree: 2 }, makeInput(3, 'quadratic'))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    expect(outcome.result.verdict).toBe('insufficient')
    expect(outcome.result.chart.line).toBeUndefined()
    expect(outcome.result.diagnostics.dof).toBe(0)
  })

  it('says how many more points an underdetermined request needs', async () => {
    const outcome = await runner.run('fit', { degree: 3 }, makeInput(2, 'linear'))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    expect(outcome.result.verdict).toBe('insufficient')
    expect(outcome.result.diagnostics.more_points_needed).toBe(2)
  })

  it('recovers the slope of a clean linear series, with a band', async () => {
    const outcome = await runner.run('fit', { degree: 1 }, makeInput(12, 'linear'))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    expect(outcome.result.verdict).toBe('supported')
    expect(outcome.result.chart.line).toHaveLength(120)
    expect(outcome.result.chart.band).toHaveLength(120)

    const coefficients = outcome.result.data.coefficients as { name: string; estimate: number }[]
    const slope = coefficients.find((coefficient) => coefficient.name === 'x')
    expect(slope?.estimate).toBeCloseTo(2.4, 2)
  })

  it('downgrades a term whose interval spans zero', async () => {
    const outcome = await runner.run('fit', { degree: 3 }, makeInput(10, 'linear'))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    expect(outcome.result.verdict).toBe('tentative')
    expect(outcome.result.narrative).toContain('spans zero')
  })

  it('says the null model wins when y does not vary', async () => {
    const outcome = await runner.run('fit', { degree: 1 }, makeInput(8, 'flat'))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    expect(outcome.result.verdict).toBe('contradicted')
    expect(outcome.result.diagnostics.f).toBe(0)
  })

  it('warns when the residuals suggest a derived rather than measured series', async () => {
    const outcome = await runner.run('fit', { degree: 1 }, makeInput(9, 'exact'))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    expect(outcome.result.narrative).toContain('numerical precision')
  })

  it('emits only values JSON can carry: no Infinity, no NaN', async () => {
    for (const [count, shape] of [
      [1, 'flat'],
      [2, 'linear'],
      [9, 'exact'],
      [8, 'flat'],
      [12, 'quadratic'],
    ] as const) {
      const outcome = await runner.run('fit', { degree: 1 }, makeInput(count, shape))
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) continue
      const serialised = JSON.stringify(outcome.result)
      expect(serialised).not.toContain('Infinity')
      expect(serialised).not.toContain('NaN')
    }
  })

  it('fails cleanly on an unknown recipe instead of throwing', async () => {
    const outcome = await runner.run('no-such-recipe', {}, makeInput(5, 'linear'))
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error.code).toBe('unknown_recipe')
    expect(outcome.error.hint).toContain('fit')
  })

  it('reports a recipe that raises as an error envelope, not a crash', async () => {
    const outcome = await runner.run('fit', { degree: 99 }, makeInput(5, 'linear'))
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error.code).toBe('recipe_failed')
    expect(outcome.error.message).toContain('degree')
  })
})
