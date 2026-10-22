import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { coerceChartSpec, interpreterCandidates, RecipeRunner } from '../src/core/runner.ts'
import type { RunInput } from '../src/core/runner.ts'

/**
 * A series whose relationship genuinely changes halfway through: slope 2.1 then 2.6. The point of
 * the changepoint recipe is to find that, and of the no-change series to not invent it.
 */
function makeDriftInput(count: number, kind: 'change' | 'stable'): RunInput {
  const points = Array.from({ length: count }, (_, index) => {
    const x = 1 + (index % 5)
    const day = String(1 + (index % 14)).padStart(2, '0')
    const wobble = index % 2 === 0 ? 0.04 : -0.04
    const slope = kind === 'change' && index >= count / 2 ? 2.6 : 2.1
    const y = slope * x + 0.3 + wobble
    return { id: `p${index}`, t: `2026-10-${day}T09:00:00.000Z`, values: { x, y } }
  })
  return {
    dataset: 'synthetic',
    shape: 'xy.v1',
    fields: [
      { name: 'x', type: 'number' },
      { name: 'y', type: 'number' },
    ],
    points,
  }
}

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

  it('keeps the identity a recipe puts on a point', () => {
    const spec = coerceChartSpec({
      points: [
        { x: 1, y: 2, id: '01ABC', label: 'first' },
        { x: 3, y: 4 },
      ],
    })
    expect(spec.points?.[0]?.id).toBe('01ABC')
    expect(spec.points?.[0]?.label).toBe('first')
    // A point with no identity is still a point; it simply cannot be traced to a record.
    expect(spec.points?.[1]).toEqual({ x: 3, y: 4 })
  })

  it('drops an identity that is not a usable id rather than stringifying it', () => {
    const spec = coerceChartSpec({
      points: [
        { x: 1, y: 2, id: 42 },
        { x: 3, y: 4, id: '' },
        { x: 5, y: 6, id: { nested: true } },
      ],
    })
    expect(spec.points?.map((point) => 'id' in point)).toEqual([false, false, false])
    expect(spec.points).toHaveLength(3)
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

  it('echoes the identity of every point it plotted', async () => {
    const input = makeInput(6, 'linear')
    const outcome = await runner.run('fit', { degree: 1 }, input)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    // The id is what makes a mark on the artifact traceable to a record in the log. Losing it would
    // leave hover and selection with nothing to resolve against.
    expect(outcome.result.chart.points?.map((point) => point.id)).toEqual(
      input.points.map((point) => point.id),
    )
  })

  it('refuses to draw a line through two points', async () => {
    const outcome = await runner.run('fit', { degree: 1 }, makeInput(2, 'linear'))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    expect(outcome.result.verdict).toBe('insufficient')
    expect(outcome.result.chart.line).toBeUndefined()
    expect(outcome.result.chart.band).toBeUndefined()
    expect(outcome.result.chart.footer).toContain('no curve drawn')
    // The window's half of the same fact: numbers, not the footer's prose.
    expect(outcome.result.chart.evidence).toMatchObject({ points: 2, dof: 0, noCurve: 'insufficient' })
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
    expect(outcome.result.chart.evidence).toMatchObject({ points: 12, parameters: 2, dof: 10 })

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

  it('finds a known changepoint and recovers both slopes', async () => {
    const outcome = await runner.run('drift', { split: 'auto', permutations: 199 }, makeDriftInput(12, 'change'))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    expect(outcome.result.verdict).toBe('supported')
    expect(outcome.result.chart.lines).toHaveLength(2)
    expect(outcome.result.chart.evidence).toMatchObject({ points: 12, regimes: 2, parameters: 2, dof: 8 })
    expect(outcome.result.diagnostics.test).toBe('permutation')

    const segments = outcome.result.data.segments as { label: string; slope: number }[]
    expect(segments.some((segment) => segment.label.startsWith('before'))).toBe(true)
    const slopes = segments.map((segment) => segment.slope).sort((a, b) => a - b)
    expect(slopes[0]).toBeCloseTo(2.1, 1)
    expect(slopes[1]).toBeCloseTo(2.6, 1)
  })

  it('does not invent a changepoint in a stable series', async () => {
    const outcome = await runner.run('drift', { split: 'auto', permutations: 199 }, makeDriftInput(12, 'stable'))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    expect(outcome.result.verdict).toBe('contradicted')
    expect(outcome.result.chart.lines).toHaveLength(1)
    expect(outcome.result.narrative).toContain('One slope describes the whole series')
  })

  it('uses the textbook test when the caller supplies the split, not a permutation', async () => {
    const outcome = await runner.run(
      'drift',
      { split: '2026-10-07T00:00:00Z' },
      makeDriftInput(12, 'change'),
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    expect(outcome.result.verdict).toBe('supported')
    expect(outcome.result.diagnostics.test).toBe('chow')
    expect(outcome.result.diagnostics.permutations).toBe(0)
  })

  it('is deterministic, so a recorded verdict can be reproduced', async () => {
    const first = await runner.run('drift', { split: 'auto', permutations: 199 }, makeDriftInput(10, 'change'))
    const second = await runner.run('drift', { split: 'auto', permutations: 199 }, makeDriftInput(10, 'change'))
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(first.result.diagnostics.p).toBe(second.result.diagnostics.p)
    expect(first.result.diagnostics.split_index).toBe(second.result.diagnostics.split_index)
    expect(first.result.diagnostics.permutation_seed).toBe(second.result.diagnostics.permutation_seed)
  })

  it('refuses when there are too few points to form two identifiable regimes', async () => {
    const outcome = await runner.run('drift', { split: 'auto' }, makeDriftInput(4, 'change'))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    expect(outcome.result.verdict).toBe('insufficient')
    expect(outcome.result.chart.lines).toBeUndefined()
    expect(outcome.result.chart.evidence).toMatchObject({ points: 4, noCurve: 'segments', needed: 6 })
    expect(outcome.result.diagnostics.more_points_needed).toBeGreaterThan(0)
  })

  it('reads a split time it cannot honour as a refusal, not a crash', async () => {
    const outcome = await runner.run(
      'drift',
      { split: '2030-01-01T00:00:00Z' },
      makeDriftInput(10, 'change'),
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    expect(outcome.result.verdict).toBe('insufficient')
    expect(outcome.result.chart.lines).toBeUndefined()
    expect(outcome.result.narrative).toContain('unidentifiable')
  })

  it('says a changepoint is not a cause', async () => {
    const outcome = await runner.run('drift', { split: 'auto', permutations: 99 }, makeDriftInput(12, 'change'))
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.result.narrative).toContain('not why')
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

describe.skipIf(!venvPresent)('a runtime that stops answering', () => {
  // The suite's budget (`vitest.config.ts`) sits above the runtime's own request deadline on
  // purpose: a stuck recipe must fail with the sentence that names what it was waiting for, not with
  // the harness's timeout. `timeoutMs` is shortened here so the boundary is proven in a moment
  // rather than after thirty seconds.
  it('gives up and says what it was waiting for', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bench-hang-'))
    try {
      const script = join(dir, 'never-answers.py')
      await writeFile(script, 'import time\n\ntime.sleep(30)\n', 'utf8')
      const stuck = new RecipeRunner(process.cwd(), script, 250)
      try {
        await stuck.start()
        await expect(stuck.environment()).rejects.toThrow(
          'analysis runtime did not answer within 250 ms',
        )
      } finally {
        await stuck.dispose()
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
