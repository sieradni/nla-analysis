import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

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
