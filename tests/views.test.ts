import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { interpreterCandidates, RecipeRunner } from '../src/core/runner.ts'
import { initProject } from '../src/core/project.ts'
import { BenchError } from '../src/core/errors.ts'
import { renderChart } from '../src/core/chart.ts'
import { Workspace } from '../src/core/workspace.ts'
import {
  listViews,
  loadView,
  renderView,
  saveView,
  slugFor,
  validateQuery,
  validateView,
  type ViewFile,
} from '../src/core/views.ts'
import { materializePanel, panelStatus, selectInput } from '../src/core/panels.ts'

let root: string
let workspace: Workspace

/** The analysis environment is optional to have, but a misbehaving one must fail, not skip. */
const localInterpreter = interpreterCandidates(process.cwd())[0]!
const venvPresent = existsSync(localInterpreter)
const runner = new RecipeRunner(process.cwd())

if (venvPresent) await runner.start()
else {
  console.warn(
    `[views.test] skipping recipe-panel tests: no analysis environment at ${localInterpreter}. Run \`pnpm setup:recipes\`.`,
  )
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'bench-views-'))
  await initProject(root, 'views-test')
  workspace = await Workspace.open(root)
  for (let index = 1; index <= 6; index++) {
    await workspace.recordPoint({
      values: { x: index, y: 2.4 * index + 0.3 + (index % 2 === 0 ? 0.04 : -0.04) },
      tObserved: `2026-10-0${index}T09:00:00.000Z`,
    })
  }
})

afterAll(async () => {
  await runner.dispose()
  await rm(root, { recursive: true, force: true })
})

describe('view names', () => {
  it('turns a title into a filename, and refuses a name with nothing to use', () => {
    expect(slugFor('Drift over time')).toBe('drift-over-time')
    expect(slugFor('  A/B  test! ')).toBe('a-b-test')
    expect(() => slugFor('///')).toThrow(BenchError)
  })
})

/** A refusal carries its reasons in `problems`, so a test can say what was wrong, not just that it failed. */
function problemsOf(attempt: () => unknown): string[] {
  try {
    attempt()
  } catch (error) {
    if (error instanceof BenchError) return error.problems
    return [(error as Error).message]
  }
  return []
}

describe('view validation', () => {
  const panel = () => ({
    dataset: 'main',
    version: 'latest',
    chart: { x: { label: 'x' }, y: { label: 'y' }, points: [{ x: 1, y: 2, id: 'p1' }] },
    n: 1,
    input_hash: 'abc',
  })

  it('accepts a panel that says what it draws', () => {
    const view = validateView({ v: 1, name: 'ok', panels: [panel()] })
    expect(view.layout.columns).toBe(2)
    expect(view.panels).toHaveLength(1)
  })

  it('refuses a typo instead of ignoring it', () => {
    expect(problemsOf(() => validateView({ v: 1, name: 'typo', panels: [panel()], pane1: [] }))).toContain(
      'view: unknown field "pane1"',
    )
    expect(
      problemsOf(() => validateView({ v: 1, name: 'typo', panels: [{ ...panel(), datset: 'main' }] })),
    ).toContain('panel 1: unknown field "datset"')
  })

  it('refuses a panel that cannot be drawn, and names the field', () => {
    const attempt = () =>
      validateView({ v: 1, name: 'bad', panels: [{ dataset: 'main', version: 'latest', chart: { x: {} } }] })
    expect(attempt).toThrow(BenchError)
    try {
      attempt()
    } catch (error) {
      expect((error as BenchError).problems.join('\n')).toContain('chart.y.label is required')
    }
  })

  it('accepts a pinned version, and refuses anything that is not one', () => {
    // A panel drawn from a version says so; `latest` stays legal for a hand-written view.
    expect(() => validateView({ v: 1, name: 'v', panels: [{ ...panel(), version: 3 }] })).not.toThrow()
    expect(() => validateView({ v: 1, name: 'v', panels: [{ ...panel(), version: 'latest' }] })).not.toThrow()
    expect(
      problemsOf(() => validateView({ v: 1, name: 'v', panels: [{ ...panel(), version: 0 }] })),
    ).toContain('panel 1.version must be "latest" or a version number (1, 2, …)')
    expect(
      problemsOf(() => validateView({ v: 1, name: 'v', panels: [{ ...panel(), version: 'newest' }] })),
    ).toContain('panel 1.version must be "latest" or a version number (1, 2, …)')
  })

  it('refuses a panel whose claimed n disagrees with the marks it draws', () => {
    expect(problemsOf(() => validateView({ v: 1, name: 'lie', panels: [{ ...panel(), n: 14 }] }))).toContain(
      'panel 1: n is 14 but the chart draws 1 point(s)',
    )
  })

  it('validates a query on its own, so --query fails before any work happens', () => {
    expect(validateQuery({ where: [{ field: 'y', op: '>', value: 5 }] })).toEqual({
      where: [{ field: 'y', op: '>', value: 5 }],
    })
    expect(problemsOf(() => validateQuery({ where: [{ field: 'y', op: '~', value: 5 }] }))).toContain(
      'query.where[0].op must be one of > >= < <= == !=',
    )
    expect(problemsOf(() => validateQuery({ where: [{ field: 'y', op: '>', value: {} }] }))).toContain(
      'query.where[0].value must be a number or a string',
    )
  })
})

describe('query selection', () => {
  it('narrows the points a panel reads, and hashes exactly that set', () => {
    const all = selectInput(workspace.state, 'main')!
    const high = selectInput(workspace.state, 'main', { where: [{ field: 'y', op: '>', value: 9 }] })!
    expect(all.points.length).toBe(6)
    expect(high.points.length).toBeLessThan(all.points.length)
    expect(high.points.every((point) => (point.values.y as number) > 9)).toBe(true)
  })

  it('supports equality, and refuses to order a value against a string', () => {
    const equal = selectInput(workspace.state, 'main', { where: [{ field: 'x', op: '==', value: 3 }] })!
    expect(equal.points).toHaveLength(1)
    // A hand-written query that orders numbers against text is a mistake, not an empty answer.
    expect(() =>
      selectInput(workspace.state, 'main', { where: [{ field: 'x', op: '>', value: '3' }] }),
    ).toThrow(/query compares "x" \(number\) with > 3/)
  })
})

describe('materializing a panel', () => {
  it('plots the dataset with identity, provenance, and a fingerprint of what it read', async () => {
    const { panel } = await materializePanel(workspace, { dataset: 'main' })
    // The version is part of the provenance: a drawing names the rows it came from, not just the
    // dataset they were in.
    expect(panel.version).toBe(1)
    expect(panel.chart.provenance).toEqual({ dataset: 'main', shape: 'xy.v1', version: 1 })
    expect(panel.chart.points).toHaveLength(6)
    expect(panel.chart.points?.every((point) => typeof point.id === 'string')).toBe(true)
    expect(panel.input_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(panel.n).toBe(6)
    expect(panel.recipe).toBeUndefined()
    expect(panel.chart.footer).toContain('no fit — unmodelled')
  })

  it('plots a custom shape on named axes, including an instant horizontal axis', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bench-axes-'))
    try {
      await initProject(dir, 'axes-test', undefined, {
        id: 'flight.v1',
        fields: [
          { name: 'date', type: 'instant' },
          { name: 'altitude', type: 'number' },
          { name: 'app', type: 'number' },
        ],
      })
      const custom = await Workspace.open(dir)
      await custom.recordPoint({
        values: { date: '2026-10-19T12:41:32.498Z', altitude: 992.4, app: 0.675 },
        tObserved: '2026-10-19T12:41:32.498Z',
      })

      const { panel } = await materializePanel(custom, {
        dataset: 'main',
        xField: 'date',
        yField: 'altitude',
      })
      expect(panel.x_field).toBe('date')
      expect(panel.y_field).toBe('altitude')
      expect(panel.chart.x).toEqual({ label: 'date', format: 'time' })
      expect(panel.chart.y).toEqual({ label: 'altitude' })
      // One row is still one honest mark, not an empty frame with a count in the footer.
      expect(panel.chart.points).toEqual([
        { id: panel.chart.points![0]!.id, x: Date.parse('2026-10-19T12:41:32.498Z'), y: 992.4 },
      ])
      const svg = renderChart(panel.chart)
      expect(svg.match(/<circle[^>]*data-point-id=/g)).toHaveLength(1)
      expect(svg).toContain('2026-10-19')

      const numeric = await materializePanel(custom, { dataset: 'main', xField: 'app', yField: 'altitude' })
      expect(numeric.panel.chart.x).toEqual({ label: 'app' })
      expect(numeric.panel.chart.points).toHaveLength(1)

      await expect(
        materializePanel(custom, { dataset: 'main', xField: 'app', yField: 'date' }),
      ).rejects.toThrow(/not numeric/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('saves an empty first tab before any point exists, and a recipe still refuses with its own hint', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bench-empty-tab-'))
    try {
      await initProject(dir, 'empty-tab', undefined, {
        id: 'flight.v1',
        fields: [
          { name: 'altitude', type: 'number' },
          { name: 'app', type: 'number' },
          { name: 'date', type: 'instant' },
        ],
      })
      const fresh = await Workspace.open(dir)
      const { panel } = await materializePanel(fresh, {
        dataset: 'main',
        xField: 'app',
        yField: 'altitude',
      })
      expect(panel.n).toBe(0)
      expect(panel.chart.empty).toContain('No observations in main yet')
      expect(panel.chart.empty).toContain('--values')
      expect(panel.chart.empty).toContain('altitude')
      expect(renderChart(panel.chart)).not.toContain('data-point-id')

      await expect(materializePanel(fresh, { dataset: 'main', recipe: 'fit' })).rejects.toThrow(
        /has no active points/,
      )
      try {
        await materializePanel(fresh, { dataset: 'main', recipe: 'fit' })
      } catch (error) {
        expect((error as BenchError).hint).toContain('--values')
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('draws only the rows a query selected', async () => {
    const { panel } = await materializePanel(workspace, {
      dataset: 'main',
      query: { where: [{ field: 'y', op: '>', value: 9 }] },
    })
    expect(panel.n).toBe(panel.chart.points?.length)
    expect(panel.n).toBe(3)
  })

  it('records the recipe, its parameters and its verdict when a recipe produced the panel', async () => {
    if (!venvPresent) return
    const { panel } = await materializePanel(workspace, { dataset: 'main', recipe: 'fit', params: { degree: 1 } }, runner)
    expect(panel.recipe).toBe('fit')
    expect(panel.params).toEqual({ degree: 1 })
    expect(panel.verdict).toBe('supported')
    expect(panel.chart.provenance).toEqual({ dataset: 'main', shape: 'xy.v1', version: 1 })
    expect(panel.chart.points).toHaveLength(6)
    expect(panel.chart.band?.length).toBeGreaterThan(1)
  })
})

describe('staleness', () => {
  it('is current, then stale when the data moves, and never silently', async () => {
    const { panel } = await materializePanel(workspace, { dataset: 'main' })
    const view: ViewFile = { v: 1, name: 'status', layout: { columns: 2 }, panels: [panel] }
    expect((await panelStatus(workspace, view.panels[0]!, 0)).state).toBe('current')

    await workspace.recordPoint({ values: { x: 7, y: 17 } })
    const stale = await panelStatus(workspace, view.panels[0]!, 0)
    expect(stale.state).toBe('stale')
    expect(stale.detail).toContain('the data changed since this panel was saved')

    // Re-materializing is what makes it current again — the point of `render --refresh`.
    const again = await materializePanel(workspace, { dataset: 'main' })
    expect((await panelStatus(workspace, again.panel, 0)).state).toBe('current')
  })

  it('goes stale when the recipe changes, even if no data moved', async () => {
    if (!venvPresent) return
    const { panel } = await materializePanel(
      workspace,
      { dataset: 'main', recipe: 'fit', params: { degree: 1 } },
      runner,
    )
    const status = await panelStatus(workspace, { ...panel, recipe_hash: 'not-the-same' }, 0)
    expect(status.state).toBe('stale')
    expect(status.detail).toContain('recipe has changed')
  })

  it('says a panel cannot be checked when it recorded no fingerprint', async () => {
    const { panel } = await materializePanel(workspace, { dataset: 'main' })
    const bare = { ...panel, input_hash: undefined }
    expect((await panelStatus(workspace, bare, 0)).state).toBe('unchecked')
  })
})

describe('view files', () => {
  it('saves, lists and loads a view by its title', async () => {
    const { panel } = await materializePanel(workspace, { dataset: 'main' })
    const view: ViewFile = { v: 1, name: 'Drift over time', layout: { columns: 1 }, panels: [panel] }

    const file = await saveView(root, view)
    expect(file.endsWith(join('views', 'drift-over-time.json'))).toBe(true)

    const loaded = await loadView(root, 'Drift over time')
    expect(loaded.name).toBe('Drift over time')
    expect(loaded.layout.columns).toBe(1)

    const { views } = await listViews(root)
    expect(views.map((summary) => summary.name)).toContain('Drift over time')
  })

  it('refuses a missing view by name, and a hand-edited file by field', async () => {
    await expect(loadView(root, 'not here')).rejects.toBeInstanceOf(BenchError)

    await writeFile(join(root, 'views', 'broken.json'), '{"v":1,"name":"broken","panels":[]}')
    await expect(loadView(root, 'broken')).rejects.toThrow(/not a valid view/)
    await rm(join(root, 'views', 'broken.json'))
  })
})

describe('rendering a view', () => {
  it('draws every panel from its stored spec, with no recipe and no log read', async () => {
    const first = (await materializePanel(workspace, { dataset: 'main' })).panel
    const second = (await materializePanel(workspace, { dataset: 'main', title: 'zoomed' })).panel
    const view: ViewFile = { v: 1, name: 'two up', layout: { columns: 2 }, panels: [first, second] }

    const svg = renderView(view)
    // 2 columns: 2 * 760 + 3 * 18 = 1574 wide.
    expect(svg).toContain('width="1574"')
    expect(svg).toContain('data-view="two-up"')
    expect(svg.match(/data-panel="[12]"/g)).toHaveLength(2)
    expect(svg.match(/data-point-id=/g)?.length).toBe((first.chart.points?.length ?? 0) * 2)
    expect(svg).toContain('zoomed')
  })

  it('stacks panels into rows when the grid is narrower than the panel count', async () => {
    const panel = (await materializePanel(workspace, { dataset: 'main' })).panel
    const view: ViewFile = { v: 1, name: 'single column', layout: { columns: 1 }, panels: [panel, panel, panel] }
    const svg = renderView(view)
    // 3 rows of 440 plus 4 gaps of 18, plus the outer padding.
    expect(svg).toContain('height="1392"')
    expect(svg.match(/data-panel=/g)).toHaveLength(3)
  })

  it('is stable: the same view renders the same bytes', async () => {
    const panel = (await materializePanel(workspace, { dataset: 'main' })).panel
    const view: ViewFile = { v: 1, name: 'stable', layout: { columns: 1 }, panels: [panel] }
    expect(renderView(view)).toBe(renderView(structuredClone(view)))
  })

  it('writes a view that can be read back and rendered after a reload', async () => {
    const panel = (await materializePanel(workspace, { dataset: 'main' })).panel
    const view: ViewFile = { v: 1, name: 'roundtrip', layout: { columns: 1 }, panels: [panel] }
    await saveView(root, view)
    const text = await readFile(join(root, 'views', 'roundtrip.json'), 'utf8')
    const reloaded = validateView(JSON.parse(text))
    expect(renderView(reloaded)).toContain('data-view="roundtrip"')
  })
})
