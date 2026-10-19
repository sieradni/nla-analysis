import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assessRuns } from '../src/core/analysis.ts'
import { activePoints, bind, foldVersion } from '../src/core/binder.ts'
import { EventLog } from '../src/core/log.ts'
import type { ProjectConfig } from '../src/core/project.ts'
import { validateValues } from '../src/core/shapes.ts'
import { renderState } from '../src/core/state.ts'
import { loadView, listViews, panelStatuses, renderView } from '../src/core/views.ts'
import { Workspace } from '../src/core/workspace.ts'

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

    // The import was a re-export, so it replaced the dataset as a new version: everything the file
    // held is in the active set, but only the rows it *added* are new events tagged `import`.
    const imported = activePoints(state, 'main').filter((point) => point.tags.includes('import'))
    expect(imported.map((point) => point.values.x)).toEqual([7, 8])
    const dataset = state.datasets.get('main')!
    expect(dataset.version).toBe(2)
    expect(dataset.points.filter((point) => point.status === 'active')).toHaveLength(imports[0]!.rows)
  })

  it('ships a version chain: the typed rows as version 1, the re-export as version 2', async () => {
    const { state } = await loadFixture()
    const dataset = state.datasets.get('main')!
    expect(dataset.versions.map((record) => record.version)).toEqual([1, 2])
    expect(dataset.versions[0]!.rows).toBe(12)
    expect(dataset.versions[1]).toMatchObject({ rows: 14, parent: 1, diff: { added: 2, removed: 0, changed: 0 } })

    // Version 1 still reads as it did: the twelve typed rows, before the export replaced them.
    const first = foldVersion(state.events, 'main', 1).filter((point) => point.status === 'active')
    expect(first).toHaveLength(12)
    expect(first.map((point) => point.values.x)).toEqual([1, 2, 3, 4, 5, 1, 2, 3, 4, 5, 9, 6])

    // Every analysis in the fixture names the version it read, and it is the current one.
    for (const run of state.runs) expect(run.version).toBe(2)
  })

  it('ships a view whose panels are still current against the committed log', async () => {
    const { views } = await listViews(projectDir)
    expect(views.length).toBeGreaterThan(0)

    const workspace = await Workspace.open(projectDir)
    const view = await loadView(projectDir, views[0]!.name)
    expect(view.panels.length).toBeGreaterThan(1)

    // A committed tab that draws stale data is worse than no example at all: it teaches the format
    // and the wrong answer at once. The fingerprint in each panel is what this checks.
    const statuses = await panelStatuses(workspace, view)
    expect(statuses.map((status) => status.state)).toEqual(view.panels.map(() => 'current'))

    // And it renders from the file alone: ids on the marks, provenance on the canvas.
    const svg = renderView(view)
    expect(svg).toContain('data-view=')
    expect(svg).toContain('data-dataset="main"')
    const ids = new Set(activePoints(workspace.state, 'main').map((point) => point.id))
    const marked = [...svg.matchAll(/data-point-id="([^"]+)"/g)].map((match) => match[1]!)
    expect(marked.length).toBeGreaterThan(0)
    for (const id of marked) expect(ids.has(id)).toBe(true)
  })

  it('records a launcher a clone can follow, with no machine path', async () => {
    const agents = await readFile(join(projectDir, 'AGENTS.md'), 'utf8')
    // The fixture is committed, so an absolute checkout path would be dead on every other clone.
    expect(agents).not.toMatch(/\b[A-Za-z]:[\\/]/)
    expect(agents).toContain('pnpm bench --project "fixtures/projects/drift-sensor" state')
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
