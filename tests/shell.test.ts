import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { interpreterCandidates } from '../src/core/runner.ts'
import { Workspace } from '../src/core/workspace.ts'
import { materializePanel, saveView, viewPath } from '../src/core/views.ts'

/**
 * The desktop shell does not import `src/core`; it imports the bundle that `pnpm app:build` produces,
 * because Electron's Node cannot strip TypeScript types. That makes the bundle an interface, and an
 * interface that is only tested by launching an app is an interface that breaks silently.
 *
 * `pnpm verify` builds it first, so these assertions run on every green check. When the file is
 * absent (someone ran `vitest` directly), the suite skips rather than failing for the wrong reason.
 */
const bundlePath = join(process.cwd(), 'app', 'core.bundle.mjs')
const built = existsSync(bundlePath)
// A recipe panel needs the Python environment; a plot panel does not, and neither does anything else
// here. Skipped only when the environment has not been created (tests/run.test.ts says why).
const analysisReady = existsSync(interpreterCandidates(process.cwd())[0]!)
const fixture = join(process.cwd(), 'fixtures', 'projects', 'drift-sensor')

describe.skipIf(!built)('bundled core, as the desktop shell loads it', () => {
  const shell = () => import(pathToFileURL(bundlePath).href) as Promise<Record<string, Function>>

  it('opens a committed view and says every panel is current', async () => {
    const api = await shell()
    const opened = (await api.openView!(fixture, 'drift over time')) as {
      view: { name: string; panels: unknown[] }
      statuses: { state: string }[]
      svgs: string[]
    }

    expect(opened.view.name).toBe('drift over time')
    expect(opened.svgs).toHaveLength(opened.view.panels.length)
    // The bundled copy must find its own `recipes/`: when it looked two levels up from `app/`, every
    // recipe read as missing. Covered here because `src` cannot reproduce that mistake.
    expect(opened.statuses.map((status) => status.state)).toEqual(
      opened.view.panels.map(() => 'current'),
    )
  })

  it('hands the window drawable SVG with identity and provenance intact', async () => {
    const api = await shell()
    const opened = (await api.openView!(fixture, 'drift over time')) as { svgs: string[] }
    const svg = opened.svgs[0]!
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('data-dataset="main"')
    expect(svg).toMatch(/data-point-id="[^"]+"/)
    expect(svg).toContain('</svg>')
  })

  it('refuses a view that does not exist, with the hint the window shows', async () => {
    const api = await shell()
    await expect(api.openView!(fixture, 'not a tab')).rejects.toThrow(/no view named/)
  })

  it('lists projects without opening one', async () => {
    const api = await shell()
    const listed = (await api.projects!()) as { projects: unknown[] }
    expect(Array.isArray(listed.projects)).toBe(true)
  })
})

type Window = Record<string, any>

/**
 * The write path the entry bar drives. These run against a *copy* of the committed fixture: the
 * window appends to whatever project it has open, and a test that appended to the fixture would
 * rewrite the log every suite reads.
 */
describe.skipIf(!built)('the bundled core, writing as the window writes', () => {
  const scratch: string[] = []

  async function scratchProject(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'bench-shell-write-'))
    scratch.push(root)
    const dir = join(root, 'drift-sensor')
    await cp(fixture, dir, { recursive: true })
    return dir
  }

  const shell = () => import(pathToFileURL(bundlePath).href) as Promise<Window>

  afterEach(async () => {
    while (scratch.length > 0) await rm(scratch.pop()!, { recursive: true, force: true })
  })

  it('appends through the session, rebuilds the plot panel, and leaves the fitted panel stale', async () => {
    const api = await shell()
    const dir = await scratchProject()
    const opened = (await api.openView!(dir, 'drift over time')) as Window
    expect(opened.entry).toMatchObject({ dataset: 'main', shape: 'xy.v1', active: 14 })
    expect(opened.reread).toBe(false)
    expect(opened.entry.fields.map((field: { name: string }) => field.name)).toEqual(['x', 'y'])

    const recorded = (await api.recordPoint!(dir, { values: { x: 6.5, y: 16.4 } }, 'drift over time')) as Window
    expect(recorded.active).toBe(15)
    expect(recorded.warnings).toEqual([])
    // (6.5, 16.4) is inside the axes the tab already has, so the window can draw it as one more
    // mark instead of re-rendering ten thousand of them: that is what keeps a keystroke cheap.
    expect(recorded.redraw).toBe(false)
    // Nothing else wrote to the log, so no re-read was paid for on the keystroke path: the stat
    // check must be a no-op in the common case, or the entry budget pays for a rare event.
    expect(recorded.reread).toBe(false)
    expect(recorded.marks).toHaveLength(1)
    expect(recorded.marks[0].index).toBe(1)
    expect(recorded.marks[0].id).toBe(recorded.id)
    expect(recorded.marks[0].markup).toContain(`data-point-id="${recorded.id}"`)
    expect(recorded.marks[0].cx).toBeGreaterThan(0)
    expect(recorded.marks[0].cy).toBeGreaterThan(0)

    const refreshed = (await api.refreshView!(dir, 'drift over time')) as Window
    // Panel 1 is the plain plot: rewritten from the current data, no Python anywhere. Panel 0 was
    // drawn by a recipe, so it is kept — and said to be kept — rather than silently left claiming
    // to describe data it no longer read.
    expect(refreshed.refreshed).toEqual([1])
    expect(refreshed.reread).toBe(false)
    expect(refreshed.kept).toHaveLength(1)
    expect(refreshed.kept[0].index).toBe(0)
    expect(refreshed.statuses.map((status: Window) => status.state)).toEqual(['stale', 'current'])
    expect(refreshed.view.panels[1].n).toBe(15)
    expect(refreshed.entry.active).toBe(15)

    // The window saves the tab it just repainted, so the file and the drawing cannot disagree.
    const saved = JSON.parse(await readFile(join(dir, 'views', 'drift-over-time.json'), 'utf8')) as Window
    expect(saved.panels[1].n).toBe(15)
    // And the cold-start brief is not left behind by a write that only the window made.
    expect(await readFile(join(dir, 'STATE.md'), 'utf8')).toContain('15 active points (16 recorded)')
  })

  it('undoes with a retraction event, which puts every panel back to current', async () => {
    const api = await shell()
    const dir = await scratchProject()
    await api.openView!(dir, 'drift over time')
    const before = await readFile(join(dir, 'data', 'events.jsonl'), 'utf8')

    const recorded = (await api.recordPoint!(dir, { values: { x: 6.5, y: 16.4 } })) as Window
    const undo = (await api.retractPoint!(dir, recorded.id, 'undo from the window')) as Window
    expect(undo.active).toBe(14)

    const refreshed = (await api.refreshView!(dir, 'drift over time')) as Window
    expect(refreshed.statuses.map((status: Window) => status.state)).toEqual(['current', 'current'])
    expect(refreshed.view.panels[1].n).toBe(14)

    const log = await readFile(join(dir, 'data', 'events.jsonl'), 'utf8')
    const appended = log.slice(before.length).trim().split('\n').map((line) => JSON.parse(line))
    // Two events, both still there: the point, and the retraction that supersedes it. Undo is a
    // recorded act, not a deletion, so the log still explains what happened.
    expect(appended.map((event) => event.type)).toEqual(['point_recorded', 'point_retracted'])
    expect(appended[1].supersedes).toBe(recorded.id)
    expect(appended[1].reason).toBe('undo from the window')
  })

  it('corrects a selected point as an event, and says the recipe panel no longer holds', async () => {
    const api = await shell()
    const dir = await scratchProject()
    const opened = (await api.openView!(dir, 'drift over time')) as Window
    const drawn = opened.view.panels[1].chart.points[0] as { id: string; x: number; y: number }

    // What the strip is filled from: the log's own number, not the tooltip's rounded one.
    const detail = (await api.point!(dir, drawn.id, 'drift over time')) as Window
    expect(detail.values).toEqual({ x: drawn.x, y: drawn.y })
    expect(detail.fields.map((field: { name: string }) => field.name)).toEqual(['x', 'y'])
    expect(detail.corrections).toBe(0)
    // Panel 0 was drawn by a recipe from this point, so changing it invalidates that drawing.
    expect(detail.recipePanels).toEqual([0])

    const before = await readFile(join(dir, 'data', 'events.jsonl'), 'utf8')
    const corrected = (await api.correctPoint!(
      dir,
      drawn.id,
      { x: drawn.x, y: drawn.y + 5 },
      'drift over time',
    )) as Window

    expect(corrected.values).toEqual({ x: drawn.x, y: drawn.y + 5 })
    expect(corrected.active).toBe(14)
    // A correction is not a deletion and not an in-place edit: one new event that supersedes the old.
    const appended = (await readFile(join(dir, 'data', 'events.jsonl'), 'utf8'))
      .slice(before.length)
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(appended.map((event: Window) => event.type)).toEqual(['point_corrected'])
    expect(appended[0].supersedes).toBe(drawn.id)
    expect(appended[0].values).toEqual({ x: drawn.x, y: drawn.y + 5 })

    // The plot panel is rebuilt from the corrected state; the fitted panel cannot be, so it is kept
    // and reported stale rather than being left looking like it still describes this project.
    expect(corrected.view.kept.map((entry: Window) => entry.index)).toEqual([0])
    expect(corrected.view.statuses.map((status: Window) => status.state)).toEqual(['stale', 'current'])

    expect(await readFile(join(dir, 'STATE.md'), 'utf8')).toContain('14 active points')
  })

  it('reloads a tab another writer moved, and reports a tab that is gone', async () => {
    const api = await shell()
    const dir = await scratchProject()
    await api.openView!(dir, 'drift over time')

    // A watcher event with nothing behind it: no read, no render.
    expect(await api.reloadTab!(dir, 'drift over time')).toEqual({ state: 'same' })

    // The window's own write must not make the watcher redraw it. The log stamp the append recorded
    // is the one on disk, so the files have not moved past what the session already has.
    await api.recordPoint!(dir, { values: { x: 7.2, y: 8.4 } }, 'drift over time')
    expect(await api.reloadTab!(dir, 'drift over time')).toEqual({ state: 'same' })

    // An agent's append is the case the window used to miss while idle.
    const agent = await Workspace.open(dir)
    await agent.recordPoint({ values: { x: 8.5, y: 12.5 } })
    const changed = (await api.reloadTab!(dir, 'drift over time')) as Window
    expect(changed.state).toBe('redrawn')
    expect(changed.view.reread).toBe(true)
    // The plot panel is rebuilt; the fitted one cannot be without the runtime, so it says so.
    expect(changed.view.view.panels.map((panel: Window) => panel.n)).toEqual([14, 16])
    expect(changed.view.statuses.map((status: Window) => status.state)).toEqual(['stale', 'current'])
    expect(changed.views.map((view: Window) => view.name)).toContain('drift over time')
    expect(await api.reloadTab!(dir, 'drift over time')).toEqual({ state: 'same' })

    // A replacement is a different file with the same name: the window has to draw the file, not the
    // copy it cached when the tab was opened.
    const writer = await Workspace.open(dir)
    const panel = (await materializePanel(writer, { dataset: 'main' })).panel
    await saveView(dir, { v: 1, name: 'drift over time', layout: { columns: 1 }, panels: [panel] })
    const replaced = (await api.reloadTab!(dir, 'drift over time')) as Window
    expect(replaced.state).toBe('redrawn')
    expect(replaced.view.view.panels).toHaveLength(1)
    expect(replaced.view.view.panels[0].recipe).toBeUndefined()

    // Deleting the file leaves a project with no tabs, which still has an entry target.
    await rm(viewPath(dir, 'drift over time'))
    const gone = (await api.reloadTab!(dir, 'drift over time')) as Window
    expect(gone.state).toBe('gone')
    expect(gone.views).toEqual([])
    expect(gone.entry).toMatchObject({ dataset: 'main', active: 16 })
  })

  it('asks for a redraw when the point would move the axes', async () => {
    const api = await shell()
    const dir = await scratchProject()
    await api.openView!(dir, 'drift over time')

    // Ten thousand times the data's range: the domain would change, so every mark has to be placed
    // again. A patched mark drawn against the old scales would simply be in the wrong place.
    const recorded = (await api.recordPoint!(dir, { values: { x: 90000, y: 200000 } }, 'drift over time')) as Window
    expect(recorded.redraw).toBe(true)
    expect(recorded.marks).toEqual([])
  })

  it('updates the saved tab without drawing it, which is how the file catches up after a paint', async () => {
    const api = await shell()
    const dir = await scratchProject()
    await api.openView!(dir, 'drift over time')
    await api.recordPoint!(dir, { values: { x: 6.5, y: 16.4 } }, 'drift over time')

    const settled = (await api.refreshView!(dir, 'drift over time', { draw: false })) as Window
    expect(settled.svgs).toBeNull()
    expect(settled.counts[1]).toBe(15)
    expect(settled.footers[1]).toContain('n = 15')
    expect(settled.statuses.map((status: Window) => status.state)).toEqual(['stale', 'current'])
    // The saved file is what the window will open next time, so the count there has to be the new one.
    const saved = JSON.parse(await readFile(join(dir, 'views', 'drift-over-time.json'), 'utf8')) as Window
    expect(saved.panels[1].n).toBe(15)
  })

  it('creates a project with the shape the dialog chose, and refuses a shape it cannot fold', async () => {
    const api = await shell()
    const parent = await mkdtemp(join(tmpdir(), 'bench-shell-new-'))
    scratch.push(parent)

    const created = (await api.createProject!(parent, 'load cells', {
      id: 'load.v1',
      fields: [
        { name: 'mass', type: 'number' },
        { name: 'extension', type: 'number' },
      ],
    })) as Window
    expect(created.dir).toBe(join(parent, 'load-cells'))
    expect(created.name).toBe('load cells')
    expect(created.views).toEqual([])
    // A project with no tabs still has somewhere to type: that is what makes the door usable.
    expect(created.entry).toMatchObject({ dataset: 'main', shape: 'load.v1', active: 0 })
    expect(created.entry.fields.map((field: Window) => field.name)).toEqual(['mass', 'extension'])

    // The shape is declared in the log, not in a side file that could drift from it.
    const events = (await readFile(join(created.dir, 'data', 'events.jsonl'), 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line))
    const declared = events.find((event: Window) => event.type === 'shape_defined')
    expect(declared.shape.id).toBe('load.v1')
    expect(declared.shape.fields.map((field: Window) => field.name)).toEqual(['mass', 'extension'])

    // And the point that follows is validated against it.
    const recorded = (await api.recordPoint!(created.dir, { values: { mass: 2.5, extension: 12 } })) as Window
    expect(recorded.active).toBe(1)
    await expect(api.recordPoint!(created.dir, { values: { x: 1, y: 2 } })).rejects.toThrow(/point rejected/)

    await expect(
      api.createProject!(parent, 'broken', { id: 'load.v1', fields: [{ name: 'x', type: 'float' }] }),
    ).rejects.toThrow(/unknown type/)
    // A refusal must not leave a half-made project behind.
    await expect(readFile(join(parent, 'broken', 'project.json'), 'utf8')).rejects.toThrow()
  })

  it('writes a tab from a chosen dataset, and refuses to overwrite one by accident', async () => {
    const api = await shell()
    const dir = await scratchProject()
    await api.openView!(dir, 'drift over time')

    const created = (await api.writeView!(dir, { name: 'slope check', dataset: 'main' })) as Window
    expect(created.view.name).toBe('slope check')
    expect(created.view.panels).toHaveLength(1)
    // A plain panel plots the dataset and records no run: a tab is a saved question, not an analysis.
    expect(created.view.panels[0].recipe).toBeUndefined()
    expect(created.view.panels[0].n).toBe(14)
    expect(created.statuses.map((status: Window) => status.state)).toEqual(['current'])
    expect(created.svgs).toHaveLength(1)

    const file = JSON.parse(await readFile(join(dir, 'views', 'slope-check.json'), 'utf8')) as Window
    expect(file.panels[0].n).toBe(14)

    // A tab the user built is not something to overwrite silently.
    await expect(api.writeView!(dir, { name: 'slope check', dataset: 'main' })).rejects.toThrow(
      /already exists/,
    )
    // And a dataset that is not there is a refusal, not an empty chart.
    await expect(api.writeView!(dir, { name: 'other', dataset: 'nope' })).rejects.toThrow(/no dataset/)
  })

  // Three interpreter starts (catalog, build, rebuild), each ~1.5–4 s on a cold cache: the 5 s
  // default measured the machine, not the behaviour.
  it.skipIf(!analysisReady)('builds a recipe panel, and replaces a tab only when told', { timeout: 30_000 }, async () => {
    const api = await shell()
    const dir = await scratchProject()
    const catalog = (await api.recipes!()) as Window
    expect(catalog.recipes.map((recipe: Window) => recipe.name)).toContain('drift')
    expect(catalog.problem).toBeUndefined()

    const withRecipe = (await api.writeView!(dir, {
      name: 'regimes',
      dataset: 'main',
      recipe: 'drift',
      columns: 1,
    })) as Window
    expect(withRecipe.view.panels[0].recipe).toBe('drift')
    // The verdict travels with the panel, so the drawing states its own evidence (non-negotiable 6).
    expect(withRecipe.view.panels[0].verdict).toBe('tentative')
    expect(withRecipe.statuses[0].state).toBe('current')

    // Replacing is an explicit act, and the new panel is what the file now holds.
    const replaced = (await api.writeView!(dir, {
      name: 'regimes',
      dataset: 'main',
      columns: 1,
      replace: true,
    })) as Window
    expect(replaced.view.panels[0].recipe).toBeUndefined()
    const file = JSON.parse(await readFile(join(dir, 'views', 'regimes.json'), 'utf8')) as Window
    expect(file.panels[0].recipe).toBeUndefined()
  })

  it('refuses a typo by naming the field, which is what the bar marks', async () => {
    const api = await shell()
    const dir = await scratchProject()
    await api.openView!(dir, 'drift over time')
    const before = await readFile(join(dir, 'data', 'events.jsonl'), 'utf8')

    await expect(api.recordPoint!(dir, { values: { x: 'seven', y: 4 } })).rejects.toThrow(
      /point rejected/,
    )
    await expect(api.recordPoint!(dir, { values: { x: 'seven', y: 4 } })).rejects.toMatchObject({
      problems: ['field "x" expects a finite number, got "seven"'],
    })
    // Nothing was written: a refusal is not a partial append.
    expect(await readFile(join(dir, 'data', 'events.jsonl'), 'utf8')).toBe(before)
  })
})

/**
 * The scenario the audit could only reproduce at the core layer: a window stays open while a real
 * agent runs `bench` in a terminal, and the window's next write has to be built on what the file now
 * says. The harness drives the *bundle* (the same module the IPC handlers call) and spawns the real
 * binary, so the two writers are genuinely separate processes — no shared in-memory state can hide a
 * missed re-read.
 */
describe.skipIf(!built)('the bundled core, with the CLI writing beside it', () => {
  const scratch: string[] = []
  let benchHome: string
  const cli = join(process.cwd(), 'src', 'cli', 'index.ts')

  beforeAll(async () => {
    // Every CLI command records a recent. Point the registry at a throwaway home so this harness
    // cannot leave scratch projects in the operator's list, and so the bundle's own writes land there
    // too.
    benchHome = await mkdtemp(join(tmpdir(), 'bench-shell-cli-home-'))
    process.env.BENCH_HOME = benchHome
  })

  async function scratchProject(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'bench-shell-cli-'))
    scratch.push(root)
    const dir = join(root, 'drift-sensor')
    await cp(fixture, dir, { recursive: true })
    return dir
  }

  async function bench(dir: string, args: string[]): Promise<string> {
    const { stdout } = await promisify(execFile)('node', [cli, '--project', dir, ...args], {
      cwd: process.cwd(),
      env: { ...process.env, BENCH_HOME: benchHome },
    })
    return stdout
  }

  const shell = () => import(pathToFileURL(bundlePath).href) as Promise<Window>

  afterEach(async () => {
    while (scratch.length > 0) await rm(scratch.pop()!, { recursive: true, force: true })
  })

  it('rereads a log the CLI grew, and persists only counts the log supports', async () => {
    const api = await shell()
    const dir = await scratchProject()
    const opened = (await api.openView!(dir, 'drift over time')) as Window
    expect(opened.entry.active).toBe(14)

    // The window sits idle in the background; an agent — the way this product is meant to be
    // operated — appends a point through the real binary.
    const cliLine = await bench(dir, ['add', '--x', '7.1', '--y', '18.2'])
    expect(cliLine).toContain('active in main')

    // The window has not looked yet. That is the point: it is the *next write* that must repair.
    const recorded = (await api.recordPoint!(dir, { values: { x: 6.5, y: 16.4 } }, 'drift over time')) as Window
    expect(recorded.reread).toBe(true)
    // 14 in the fixture + the CLI's row + this one. Before the check it would have said 15, and said
    // it in STATE.md and in the tab it then saved.
    expect(recorded.active).toBe(16)

    const refreshed = (await api.refreshView!(dir, 'drift over time')) as Window
    expect(refreshed.view.panels[1].n).toBe(16)

    // Ground truth from a third reader: the CLI's own view of the same file.
    const listed = JSON.parse(await bench(dir, ['list', '--json'])) as { data: unknown[] }
    expect(listed.data).toHaveLength(16)

    const saved = JSON.parse(await readFile(join(dir, 'views', 'drift-over-time.json'), 'utf8')) as Window
    expect(saved.panels[1].n).toBe(16)
    expect(await readFile(join(dir, 'STATE.md'), 'utf8')).toContain('16 active points (17 recorded)')
    // The tab's fingerprint was taken against the full log, so reopening it is not a stale tab.
    const shown = JSON.parse(await bench(dir, ['view', 'show', 'drift over time', '--json'])) as Window
    expect(shown.data.status[1].state).toBe('current')
  })

  it('does not undo a point the CLI retracted while the window still held it', async () => {
    const api = await shell()
    const dir = await scratchProject()
    await api.openView!(dir, 'drift over time')

    const recorded = (await api.recordPoint!(dir, { values: { x: 6.5, y: 16.4 } }, 'drift over time')) as Window
    // The same point is withdrawn from the terminal, not from this window.
    await bench(dir, ['retract', recorded.id, '--reason', 'withdrawn by the agent'])

    // Undo from the window must refuse rather than append a second retraction, and must name the
    // point: the window's cached bind still shows it active, so this answer can only come from a
    // reread that happened before the write was built.
    await expect(api.retractPoint!(dir, recorded.id, 'undo from the window')).rejects.toThrow(
      new RegExp(`point "${recorded.id}" is already retracted`),
    )

    const log = await readFile(join(dir, 'data', 'events.jsonl'), 'utf8')
    const retractions = log
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line))
      // The fixture already carries one retraction of its own, so count only this point's.
      .filter((event: Window) => event.type === 'point_retracted' && event.supersedes === recorded.id)
    expect(retractions).toHaveLength(1)
    expect(retractions[0].reason).toBe('withdrawn by the agent')
  })
})
