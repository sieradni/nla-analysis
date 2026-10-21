import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { interpreterCandidates, RecipeRunner } from '../src/core/runner.ts'
import { initProject } from '../src/core/project.ts'
import { BenchError } from '../src/core/errors.ts'
import { renderChart } from '../src/core/chart.ts'
import { Workspace } from '../src/core/workspace.ts'
import {
  closeView,
  duplicateView,
  listClosedViews,
  listViews,
  loadView,
  renameView,
  renderView,
  restoreClosedView,
  saveView,
  slugFor,
  validateQuery,
  validateView,
  type ViewFile,
} from '../src/core/views.ts'
import { materializePanel, panelStatus, plotDataset, projectPoint, selectInput } from '../src/core/panels.ts'
import { commitImport, planImport } from '../src/core/import.ts'
import { buildRunInput } from '../src/core/analysis.ts'

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
    expect(panel.chart.evidence).toMatchObject({ points: 6, noCurve: 'unmodelled' })
  })

  it("carries the log's time on every mark, and says when the log calls it an estimate", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bench-panel-time-'))
    try {
      await initProject(dir, 'panel-time')
      const local = await Workspace.open(dir)
      await writeFile(join(dir, 'rows.csv'), 'x,y\n1,2\n', 'utf8')
      await commitImport(
        local,
        await planImport(local, join(dir, 'rows.csv'), {
          mapping: { x: 'x', y: 'y' },
          estimate: true,
          estimateFrom: '2026-05-01T00:00:00Z',
        }),
      )

      // The spec is what the window draws from, so the time and the marker have to be on the point
      // itself: a hover cannot ask the core again, and the tab file is derived state.
      const plotted = plotDataset(local, 'main')
      expect(plotted.spec.points).toEqual([
        {
          id: expect.any(String),
          tObserved: '2026-05-01T00:00:00.000Z',
          timeEstimated: true,
          x: 1,
          y: 2,
        },
      ])

      // A recipe panel draws from the run input, so the marker has to be there too: a hover on a
      // fitted panel is the same question about the same row.
      expect(buildRunInput(local.state, 'main')!.points[0]).toMatchObject({
        t: '2026-05-01T00:00:00.000Z',
        tEstimated: true,
      })

      // A mark patched onto a drawing that is already up reads the same fold, so it cannot disagree
      // with a mark that was drawn with its panel.
      const { panel } = await materializePanel(local, { dataset: 'main' })
      const projection = projectPoint(
        local,
        { v: 1, name: 'one panel', layout: { columns: 1 }, panels: [panel] },
        plotted.spec.points![0]!.id!,
        { x: 1, y: 2 },
      )
      expect(projection.marks).toHaveLength(1)
      expect(projection.marks[0]).toMatchObject({
        tObserved: '2026-05-01T00:00:00.000Z',
        timeEstimated: true,
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
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
      // One row is still one honest mark, not an empty frame with a count in the footer. It carries
      // the record's own time, because a hover has to be able to say when the reading was taken.
      expect(panel.chart.points).toEqual([
        {
          id: panel.chart.points![0]!.id,
          tObserved: '2026-10-19T12:41:32.498Z',
          x: Date.parse('2026-10-19T12:41:32.498Z'),
          y: 992.4,
        },
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

describe('closing a tab', () => {
  it('takes the file away, keeps it whole in the trash, and lists it for a later window', async () => {
    const { panel } = await materializePanel(workspace, { dataset: 'main', title: 'closing' })
    const view: ViewFile = { v: 1, name: 'closing', layout: { columns: 1 }, panels: [panel] }
    const file = await saveView(root, view)
    const before = await readFile(file, 'utf8')

    const closed = await closeView(root, 'closing')
    // The archive is the tab: its name, its panels, and the whole spec including the materialized
    // points the window never sees in a drawing.
    expect(closed.name).toBe('closing')
    expect(closed.panels).toBe(1)
    expect(closed.closedAt).not.toBe('')
    expect(existsSync(file)).toBe(false)
    expect((await listViews(root)).views.map((summary) => summary.name)).not.toContain('closing')
    await expect(loadView(root, 'closing')).rejects.toThrow(/no view named/)
    // The file itself waits in the trash, byte for byte: a window that forgets its stack — a
    // restart — must not be the thing that loses a tab's title, axes, recipe or layout.
    const archive = join(root, 'views', '.trash', closed.file)
    expect(await readFile(archive, 'utf8')).toBe(before)
    // And the trash is not a second list of tabs: it is invisible to the project itself.
    expect((await listViews(root)).problems).toEqual([])

    // A fresh reader — the next window — finds the closed tab without anything held in memory.
    const listed = await listClosedViews(root)
    expect(listed.problems).toEqual([])
    expect(listed.closed[0]).toMatchObject({ file: closed.file, name: 'closing', panels: 1 })

    // Putting it back moves the same bytes home: the tab that closed, not a copy drawn now.
    const restored = await restoreClosedView(root, closed.file)
    expect(restored.name).toBe('closing')
    expect(await readFile(file, 'utf8')).toBe(before)
    expect(existsSync(archive)).toBe(false)
    expect((await listClosedViews(root)).closed).toEqual([])
  })

  it('lists the newest closed tab first, so the next window reopens the last one closed', async () => {
    const { panel } = await materializePanel(workspace, { dataset: 'main' })
    for (const name of ['first closed', 'second closed']) {
      await saveView(root, { v: 1, name, layout: { columns: 1 }, panels: [panel] })
      await closeView(root, name)
      // The archive name carries a millisecond stamp; keep the order unambiguous on a fast machine.
      await new Promise((done) => setTimeout(done, 5))
    }
    const { closed } = await listClosedViews(root)
    expect(closed.map((entry) => entry.name)).toEqual(['second closed', 'first closed'])
  })

  it('keeps the last twenty closed tabs, and drops the oldest', async () => {
    const { panel } = await materializePanel(workspace, { dataset: 'main' })
    for (let index = 0; index < 22; index += 1) {
      const name = `trash ${index}`
      await saveView(root, { v: 1, name, layout: { columns: 1 }, panels: [panel] })
      await closeView(root, name)
    }
    const archived = (await readdir(join(root, 'views', '.trash'))).filter((name) => name.endsWith('.json'))
    // Bounded, and the survivors are the newest closes: the oldest two names are gone.
    expect(archived).toHaveLength(20)
    expect(archived.some((name) => name.startsWith('trash-0-'))).toBe(false)
    expect(archived.some((name) => name.startsWith('trash-1-'))).toBe(false)
    expect(archived.some((name) => name.startsWith('trash-21-'))).toBe(true)
    // The list is bounded the same way, so the window never offers an archive the project dropped.
    expect((await listClosedViews(root)).closed).toHaveLength(20)
  })

  it('refuses to put a tab back over a name that came back while it was away', async () => {
    const { panel } = await materializePanel(workspace, { dataset: 'main' })
    const view: ViewFile = { v: 1, name: 'taken', layout: { columns: 1 }, panels: [panel] }
    await saveView(root, view)
    const closed = await closeView(root, 'taken')

    // Another writer created a tab with that name while the closed one was away.
    await saveView(root, { ...view, panels: [{ ...panel, title: 'newer' }] })
    const failure = await restoreClosedView(root, closed.file)
      .then(() => null)
      .catch((error: unknown) => error)
    expect((failure as BenchError).kind).toBe('invalid')
    expect((failure as BenchError).message).toContain('is in the project again')
    // The tab that is there is untouched, and the archive is still waiting: a reopen is not a quiet
    // replacement, and a refusal must not spend the closed tab.
    expect((await loadView(root, 'taken')).panels[0]!.title).toBe('newer')
    expect((await listClosedViews(root)).closed.map((entry) => entry.name)).toContain('taken')
  })

  it('refuses an archive that would not load or does not belong to the trash, and writes nothing', async () => {
    const broken = join(root, 'views', '.trash', 'handmade-2026-10-21T00-00-00-000Z.json')
    await mkdir(join(root, 'views', '.trash'), { recursive: true })
    await writeFile(broken, JSON.stringify({ v: 1, name: 'handmade', panels: [] }))
    await expect(restoreClosedView(root, 'handmade-2026-10-21T00-00-00-000Z.json')).rejects.toBeInstanceOf(
      BenchError,
    )
    expect(existsSync(join(root, 'views', 'handmade.json'))).toBe(false)
    // A name is not a path: the window hands back what the list gave it, and nothing else is reachable.
    for (const escape of ['../taken.json', '../../data/events.jsonl', 'sub/handmade.json']) {
      await expect(restoreClosedView(root, escape)).rejects.toBeInstanceOf(BenchError)
    }
    // An archive that was pruned or reopened elsewhere is a plain refusal, not a crash.
    const missing = await restoreClosedView(root, 'gone-2026-10-21T00-00-00-000Z.json')
      .then(() => null)
      .catch((error: unknown) => error)
    expect((missing as BenchError).kind).toBe('missing')
  })
})

describe('renaming and copying a tab', () => {
  it('renames: the same panels under a new name, in a file of the new name', async () => {
    const { panel } = await materializePanel(workspace, { dataset: 'main', title: 'renamed' })
    const view: ViewFile = { v: 1, name: 'old name', layout: { columns: 1 }, panels: [panel] }
    await saveView(root, view)

    const renamed = await renameView(root, 'old name', 'new name')
    expect(renamed.name).toBe('new name')
    // The drawing is not rewritten: the panel, its query and its materialized points are the ones
    // the tab already had.
    expect(renamed.panels).toEqual([panel])
    expect(existsSync(join(root, 'views', 'old-name.json'))).toBe(false)
    expect(existsSync(join(root, 'views', 'new-name.json'))).toBe(true)
    await expect(loadView(root, 'old name')).rejects.toThrow(/no view named/)
    const listed = (await listViews(root)).views.map((summary) => summary.name)
    expect(listed).toContain('new name')
    expect(listed).not.toContain('old name')
  })

  it('refuses a rename onto another tab, or onto the file another name already uses', async () => {
    const { panel } = await materializePanel(workspace, { dataset: 'main' })
    await saveView(root, { v: 1, name: 'keeper', layout: { columns: 1 }, panels: [panel] })
    await saveView(root, { v: 1, name: 'mover', layout: { columns: 1 }, panels: [panel] })
    const before = await readFile(join(root, 'views', 'mover.json'), 'utf8')

    for (const target of ['keeper', 'KEEPER', ' keeper ']) {
      await expect(renameView(root, 'mover', target)).rejects.toBeInstanceOf(BenchError)
    }
    // And a name that is not the same name but becomes the same file: refusing by name alone would
    // let this quietly replace the tab that already owns that file.
    await saveView(root, { v: 1, name: 'punctu-ated', layout: { columns: 1 }, panels: [panel] })
    await expect(renameView(root, 'mover', 'punctu ated')).rejects.toThrow(/already uses that file name/)
    // Refused before anything is written: the tab that was there is untouched.
    expect(await readFile(join(root, 'views', 'mover.json'), 'utf8')).toBe(before)
    expect((await loadView(root, 'keeper')).name).toBe('keeper')
    // Renaming to the name it already has is not a refusal; it is the tab, unchanged.
    expect((await renameView(root, 'mover', 'mover')).name).toBe('mover')
  })

  it('copies a tab as a tab of its own, with no reference back to the one it came from', async () => {
    const { panel } = await materializePanel(workspace, { dataset: 'main' })
    await saveView(root, { v: 1, name: 'source', layout: { columns: 2 }, panels: [panel, panel] })

    const copy = await duplicateView(root, 'source', 'source copy')
    expect(copy.name).toBe('source copy')
    expect(copy.layout.columns).toBe(2)
    expect(copy.panels).toEqual([panel, panel])
    expect(existsSync(join(root, 'views', 'source.json'))).toBe(true)

    // The two are separate files from here: editing the copy's spec cannot rewrite the original's.
    copy.panels[0]!.title = 'only in the copy'
    await saveView(root, copy)
    expect((await loadView(root, 'source')).panels[0]!.title).toBeUndefined()
    expect((await loadView(root, 'source copy')).panels[0]!.title).toBe('only in the copy')
    // And a copy cannot quietly replace a tab that exists.
    await expect(duplicateView(root, 'source', 'source copy')).rejects.toBeInstanceOf(BenchError)
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
