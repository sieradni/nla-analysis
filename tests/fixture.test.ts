import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assessRuns } from '../src/core/analysis.ts'
import { activePoints, bind } from '../src/core/binder.ts'
import { EventLog } from '../src/core/log.ts'
import type { ProjectConfig } from '../src/core/project.ts'
import { validateValues } from '../src/core/shapes.ts'
import { renderState } from '../src/core/state.ts'

/**
 * The drift-sensor fixture is a real project built entirely through the CLI, and its STATE.md is
 * committed. These tests keep the committed copy honest: if the renderer, the binder, or the log
 * changes, the fixture must be regenerated rather than left quietly stale.
 */
const projectDir = join(process.cwd(), 'fixtures', 'projects', 'drift-sensor')
const eventsFile = join(projectDir, 'data', 'events.jsonl')

async function loadFixture() {
  const config = JSON.parse(await readFile(join(projectDir, 'project.json'), 'utf8')) as ProjectConfig
  const { events, problems } = await new EventLog(eventsFile).read()
  return { config, events, problems, state: bind(events) }
}

describe('drift-sensor fixture', () => {
  it('has no unreadable records in its log', async () => {
    const { problems, state } = await loadFixture()
    expect(problems).toEqual([])
    expect(state.problems).toEqual([])
  })

  it('keeps its committed STATE.md in sync with the log, freshness included', async () => {
    const { config, state } = await loadFixture()
    const committed = await readFile(join(projectDir, 'STATE.md'), 'utf8')
    // Rendered exactly as the CLI renders it, freshness included. Comparing an easier version here
    // would let the committed brief drift from what a session actually reads.
    const freshness = await assessRuns(process.cwd(), state)
    expect(committed).toBe(renderState(config, state, { freshness }))
  })

  it('validates cleanly: the only retracted record is excluded from validation', async () => {
    const { state } = await loadFixture()
    const dataset = state.datasets.get('main')
    expect(dataset).toBeDefined()

    const shape = state.shapes.get(dataset!.shape)
    expect(shape).toBeDefined()

    for (const point of activePoints(state, 'main')) {
      const validation = validateValues(shape!, point.values)
      expect(validation.errors, `point ${point.id}`).toEqual([])
      expect(validation.warnings, `point ${point.id}`).toEqual([])
    }

    const retracted = dataset!.points.filter((point) => point.status === 'retracted')
    expect(retracted).toHaveLength(1)
    expect(retracted[0]!.retractionReason).toContain('typo')
  })

  it('keeps every imported original byte-identical to the hash recorded with it', async () => {
    const { events, state } = await loadFixture()
    const imports = events.filter((event) => event.type === 'import_completed')
    expect(imports.length).toBeGreaterThan(0)

    for (const event of imports) {
      const bytes = await readFile(join(projectDir, event.file))
      // data/raw is evidence: if anyone edits it, the log's own hash stops matching and this fails.
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(event.hash)
      expect(existsSync(join(projectDir, event.file))).toBe(true)
    }

    // And the rows it recorded are in the active set, tagged as having come from a file.
    const imported = activePoints(state, 'main').filter((point) => point.tags.includes('import'))
    expect(imported).toHaveLength(imports[0]!.rows)
    expect(imported.map((point) => point.values.x)).toEqual([7, 8])
  })

  it('preserves the original bytes of a corrected point', async () => {
    const { state } = await loadFixture()
    const corrected = activePoints(state, 'main').filter((point) => point.corrections.length > 0)
    expect(corrected).toHaveLength(1)
    // The correction is folded in, but the point keeps its original identity and timestamp.
    expect(corrected[0]!.id.startsWith('01')).toBe(true)
    expect(corrected[0]!.tObserved).toBe('2026-10-14T09:00:00.000Z')
  })
})
