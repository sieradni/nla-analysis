import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { interpreterCandidates } from '../src/core/runner.ts'
import { Workspace } from '../src/core/workspace.ts'
import { saveView, viewPath } from '../src/core/views.ts'
import { materializePanel } from '../src/core/panels.ts'

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

/**
 * Every door that opens a project registers a recent. These tests open dozens of scratch copies and
 * create projects in temp folders, so the registry has to point at a throwaway home: without this,
 * a `pnpm test` rearranges the list a real user switches projects with and leaves entries whose
 * folders are deleted on cleanup.
 */
let benchHome: string

beforeAll(async () => {
  benchHome = await mkdtemp(join(tmpdir(), 'bench-shell-home-'))
  process.env.BENCH_HOME = benchHome
})

afterAll(async () => {
  delete process.env.BENCH_HOME
  await rm(benchHome, { recursive: true, force: true })
})

describe.skipIf(!built)('bundled core, as the desktop shell loads it', () => {
  const shell = () => import(pathToFileURL(bundlePath).href) as Promise<Record<string, Function>>

  it('opens a committed view and says every panel is current', async () => {
    const api = await shell()
    const opened = (await api.openView!(fixture, 'drift over time')) as {
      view: { name: string; panels: { chart: { points?: unknown } }[] }
      statuses: { state: string }[]
      drawings: unknown[]
    }

    expect(opened.view.name).toBe('drift over time')
    expect(opened.drawings).toHaveLength(opened.view.panels.length)
    // The bundled copy must find its own `recipes/`: when it looked two levels up from `app/`, every
    // recipe read as missing. Covered here because `src` cannot reproduce that mistake.
    expect(opened.statuses.map((status) => status.state)).toEqual(
      opened.view.panels.map(() => 'current'),
    )
  })

  it('hands the window a split drawing with identity and provenance intact', async () => {
    const api = await shell()
    const opened = (await api.openView!(fixture, 'drift over time')) as {
      view: { panels: { chart: { points?: unknown; provenance?: unknown; footer?: unknown; evidence?: unknown } }[] }
      drawings: {
        under: string
        over: string
        marks: Float32Array
        xs: Float64Array
        ys: Float64Array
        ids: string
      }[]
    }
    const drawing = opened.drawings[0]!
    const ids = drawing.ids.split('\n')
    expect(drawing.under.startsWith('<svg')).toBe(true)
    // The drawing is the window's, not the artifact's: no title, subtitle, footer or provenance in
    // its markup, and no second accessible name competing with the panel host's. What the tab is
    // drawn from travels beside it in the view, where a client pins it structurally.
    expect(drawing.under).not.toContain('data-dataset')
    expect(drawing.under).not.toContain('data-shape')
    expect(drawing.under).toContain('aria-hidden="true"')
    expect(opened.view.panels[0]!.chart.provenance).toEqual({ dataset: 'main', shape: 'xy.v1', version: 2 })
    // The window gets the facts, not the artifact's prose line: the footer is the CLI's.
    expect(opened.view.panels[0]!.chart.footer).toBeUndefined()
    expect(opened.view.panels[0]!.chart.evidence).toMatchObject({ points: 14, regimes: 2, parameters: 2 })
    expect(drawing.under).toContain('</svg>')
    expect(drawing.over).toContain('</svg>')
    // The marks are not DOM nodes any more: they arrive projected in the spec's own point order, and
    // the SVG halves deliberately do not carry a duplicate. Ids and values travel once, beside them.
    expect(drawing.under).not.toContain('data-point-id')
    expect(drawing.over).not.toContain('data-point-id')
    expect(drawing.marks).toHaveLength(ids.length * 2)
    expect(ids.every((id) => id !== '')).toBe(true)
    expect(Array.prototype.every.call(drawing.marks, Number.isFinite)).toBe(true)
    expect(Array.prototype.every.call(drawing.xs, Number.isFinite)).toBe(true)
    // The payload is trimmed; the file it was drawn from still carries the full materialized spec.
    expect(opened.view.panels[0]!.chart.points).toBeUndefined()
    const saved = JSON.parse(
      await readFile(join(fixture, 'views', 'drift-over-time.json'), 'utf8'),
    ) as { panels: { chart: { points?: unknown[] } }[] }
    expect(saved.panels[0]!.chart.points).toHaveLength(ids.length)
  })

  it('refuses a view that does not exist, with the hint the window shows', async () => {
    const api = await shell()
    await expect(api.openView!(fixture, 'not a tab')).rejects.toThrow(/no view named/)
  })

  it('hands the window a refusal it can classify, with the kind the core chose', async () => {
    const api = await shell()
    // The envelope the IPC handler sends. Built by the bundle, so this is the function the shell
    // calls rather than a copy of its field list — a hand-written list lost the kind, and every
    // failed undo was then offered again for ever.
    let missing: Window | null = null
    try {
      await api.openView!(fixture, 'not a tab')
    } catch (error) {
      missing = api.refusalOf!(error) as Window
    }
    expect(missing).toMatchObject({ ok: false, error: { kind: 'missing' } })
    expect(missing!.error.message).toMatch(/no view named/)
    expect(missing!.error.problems).toEqual([])
    expect(typeof missing!.error.hint).toBe('string')

    // A failure the core did not classify keeps a null kind: a locked file or a dropped call is
    // worth retrying, and calling it permanent would hide a control that still works.
    expect(api.refusalOf!(new Error('EBUSY: resource busy or locked'))).toEqual({
      ok: false,
      error: { kind: null, message: 'EBUSY: resource busy or locked', hint: null, problems: [] },
    })
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

  it('brings a removed point back as the same record, through the door the menu uses', async () => {
    const api = await shell()
    const dir = await scratchProject()
    const opened = (await api.openView!(dir, 'drift over time')) as Window
    const drawing = opened.drawings[1]
    const target = { id: drawing.ids.split('\n')[0], x: drawing.xs[0], y: drawing.ys[0] }
    const detail = (await api.point!(dir, target.id, 'drift over time')) as Window
    // The fixture's shape designates no observation-time field, so nothing is left out of a copied
    // detail line in favour of "observed".
    expect(detail.timeField).toBeUndefined()
    const before = await readFile(join(dir, 'data', 'events.jsonl'), 'utf8')

    // Remove, as the menu does it: no reason, one event.
    const removed = (await api.retractPoint!(dir, target.id)) as Window
    expect(removed.active).toBe(13)
    // The window's history remembers the *act*, not just the point: undo names that removal.
    const restored = (await api.restorePoint!(dir, target.id, removed.retraction)) as Window
    expect(restored.id).toBe(target.id)
    expect(restored.active).toBe(14)

    const appended = (await readFile(join(dir, 'data', 'events.jsonl'), 'utf8'))
      .slice(before.length)
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(appended.map((event: Window) => event.type)).toEqual(['point_retracted', 'point_restored'])
    expect(appended[0].reason).toBeUndefined()
    // The restore names the act it reverses, and is not a second record.
    expect(appended[1].restores).toBe(appended[0].id)
    expect(appended).toHaveLength(2)

    // The same record is what the strip reads back: values and observation time did not move.
    const again = (await api.point!(dir, target.id, 'drift over time')) as Window
    expect(again.values).toEqual(detail.values)
    expect(again.tObserved).toBe(detail.tObserved)

    const refreshed = (await api.refreshView!(dir, 'drift over time')) as Window
    expect(refreshed.entry.active).toBe(14)
    expect(refreshed.view.panels[1].n).toBe(14)
    expect(await readFile(join(dir, 'STATE.md'), 'utf8')).toContain('14 active points')

    // A second undo holding the *old* removal is refused rather than reversing the newer one: the
    // window's stale button cannot undo somebody else's act. The refusal says so in a way the
    // window can act on: `invalid` is why the act is dropped instead of offered again.
    const again2 = (await api.retractPoint!(dir, target.id)) as Window
    let stale: Window | null = null
    try {
      await api.restorePoint!(dir, target.id, removed.retraction)
    } catch (error) {
      stale = api.refusalOf!(error) as Window
    }
    expect(stale!.error.message).toMatch(/no longer the one in force/)
    expect(stale!.error.kind).toBe('invalid')
    // The removal that is in force still comes back, whether it is named or left to the core.
    expect(((await api.restorePoint!(dir, target.id, again2.retraction)) as Window).active).toBe(14)
    await expect(api.restorePoint!(dir, target.id)).rejects.toThrow(/is not retracted/)
  })

  it('corrects a selected point as an event, and says the recipe panel no longer holds', async () => {
    const api = await shell()
    const dir = await scratchProject()
    const opened = (await api.openView!(dir, 'drift over time')) as Window
    const drawing = opened.drawings[1]
    const drawn = { id: drawing.ids.split('\n')[0], x: drawing.xs[0], y: drawing.ys[0] }

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

  it('moves a designated observation time through the door the time control uses', async () => {
    const api = await shell()
    const parent = await mkdtemp(join(tmpdir(), 'bench-shell-time-'))
    scratch.push(parent)

    // A shape that designates its own instant field: the case the entry bar draws a date/time
    // control for, and the only case where a correction can move the observation time at all.
    const created = (await api.createProject!(parent, 'timed', {
      id: 'log.v1',
      fields: [
        { name: 'app', type: 'number' },
        { name: 'date', type: 'instant' },
      ],
      time_field: 'date',
    })) as Window
    const dir = created.dir
    await api.writeView!(dir, { name: 'over time', dataset: 'main', xField: 'date', yField: 'app' })

    // What the control sends: the instant it holds, canonical UTC. The core decides the observation
    // time from the designated field, so the field and `t_observed` cannot disagree (ADR 0014).
    const recorded = (await api.recordPoint!(dir, {
      values: { app: 1, date: '2026-10-19T16:30:00.000Z' },
    })) as Window
    expect(recorded.tObserved).toBe('2026-10-19T16:30:00.000Z')
    const opened = (await api.openView!(dir, 'over time')) as Window
    expect(opened.view.panels[0].chart.x.format).toBe('time')

    const before = await readFile(join(dir, 'data', 'events.jsonl'), 'utf8')
    const moved = (await api.correctPoint!(
      dir,
      recorded.id,
      { date: '2026-10-21T16:30:00.000Z' },
      'over time',
    )) as Window
    expect(moved.values).toEqual({ app: 1, date: '2026-10-21T16:30:00.000Z' })
    const appended = (await readFile(join(dir, 'data', 'events.jsonl'), 'utf8'))
      .slice(before.length)
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(appended.map((event: Window) => event.type)).toEqual(['point_corrected'])
    expect(appended[0].t_observed).toBe('2026-10-21T16:30:00.000Z')

    // The strip opens on the log's own instant, and a correction that leaves it alone does not move
    // it: the control shows whole minutes while the log holds seconds and milliseconds.
    const detail = (await api.point!(dir, recorded.id, 'over time')) as Window
    expect(detail.values.date).toBe('2026-10-21T16:30:00.000Z')
    expect(detail.timeField).toBe('date')
    const kept = (await api.correctPoint!(dir, recorded.id, { app: 9 }, 'over time')) as Window
    expect(kept.values).toEqual({ app: 9, date: '2026-10-21T16:30:00.000Z' })

    // A time the control could not have produced is refused, and nothing is written. The refusal
    // names the field first, which is what the control marks and focuses.
    const beforeRefusal = await readFile(join(dir, 'data', 'events.jsonl'), 'utf8')
    let refusal: Window | null = null
    try {
      await api.correctPoint!(dir, recorded.id, { date: '21/10/2026 5 am' }, 'over time')
    } catch (error) {
      refusal = error as Window
    }
    expect(refusal?.problems).toEqual([
      'field "date" carries the observation time, but "21/10/2026 5 am" is not a parseable instant',
    ])
    expect(await readFile(join(dir, 'data', 'events.jsonl'), 'utf8')).toBe(beforeRefusal)
  })

  it('undoes and redoes a correction by writing the earlier and later values', async () => {
    const api = await shell()
    const dir = await scratchProject()
    const opened = (await api.openView!(dir, 'drift over time')) as Window
    const drawing = opened.drawings[1]
    const drawn = { id: drawing.ids.split('\n')[0], x: drawing.xs[0], y: drawing.ys[0] }
    const detail = (await api.point!(dir, drawn.id, 'drift over time')) as Window
    const before = detail.values
    const beforeLog = await readFile(join(dir, 'data', 'events.jsonl'), 'utf8')

    // Save a correction, then the two acts the bar's history performs: undo writes the values the
    // strip read before the save, and redo writes the corrected ones back. Each is a new event.
    const corrected = (await api.correctPoint!(
      dir,
      drawn.id,
      { ...before, y: drawn.y + 5 },
      'drift over time',
    )) as Window
    const undone = (await api.correctPoint!(dir, drawn.id, before, 'drift over time')) as Window
    const redone = (await api.correctPoint!(
      dir,
      drawn.id,
      corrected.values,
      'drift over time',
    )) as Window

    expect(undone.values).toEqual(before)
    expect(redone.values).toEqual(corrected.values)

    const appended = (await readFile(join(dir, 'data', 'events.jsonl'), 'utf8'))
      .slice(beforeLog.length)
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    // Three corrections, not one rewritten event: the log can still say what the point has held.
    expect(appended.map((event: Window) => event.type)).toEqual([
      'point_corrected',
      'point_corrected',
      'point_corrected',
    ])
    expect(appended.map((event: Window) => event.supersedes)).toEqual([
      drawn.id,
      drawn.id,
      drawn.id,
    ])
    expect(appended[1].values).toEqual(before)
    expect(appended[2].values).toEqual(corrected.values)

    const again = (await api.point!(dir, drawn.id, 'drift over time')) as Window
    expect(again.values).toEqual(corrected.values)
    expect(again.corrections).toBe(3)

    const refreshed = (await api.refreshView!(dir, 'drift over time')) as Window
    expect(refreshed.entry.active).toBe(14)
    expect(refreshed.view.panels[1].n).toBe(14)
  })

  it('restores a version through the window door, and redraws the tab it replaced', async () => {
    const api = await shell()
    const dir = await scratchProject()
    const opened = (await api.openView!(dir, 'drift over time')) as Window
    expect(opened.view.panels[1].n).toBe(14)

    // An import into a dataset with rows: version 3 replaces version 2 with two rows.
    const file = join(dir, 'two-rows.csv')
    await writeFile(
      file,
      'timestamp,x,y\n2026-01-05T09:00:00Z,21.4,3.301\n2026-01-05T09:05:00Z,21.9,3.355\n',
      'utf8',
    )
    const imported = (await api.importFile!(dir, file, { x: 'x', y: 'y' }, {
      time: 'timestamp',
      viewName: 'drift over time',
    })) as Window
    expect(imported).toMatchObject({ version: 3, parent: 2, rows: 2, active: 2 })

    // Undo of the import: version 2 becomes current again, as version 4, and the tab is rebuilt
    // from those rows — a recipe panel is kept and reported stale, not left looking current.
    const restored = (await api.restoreVersion!(dir, 'main', 2, 'drift over time')) as Window
    expect(restored).toMatchObject({ version: 4, parent: 3, restoredFrom: 2, rows: 14, active: 14 })
    expect(restored.diff).toEqual({ added: 14, removed: 2, changed: 0 })
    expect(restored.view.view.panels[1].n).toBe(14)
    expect(restored.view.statuses.map((status: Window) => status.state)).toEqual(['stale', 'current'])

    const records = (await readFile(join(dir, 'data', 'events.jsonl'), 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((event: Window) => event.type === 'dataset_version_created' && event.version === 4)
    expect(records).toHaveLength(1)
    expect(records[0].parent).toBe(3)
    expect(records[0].source).toBe('restored from version 2')
    expect(records[0].diff).toEqual({ added: 14, removed: 2, changed: 0 })

    // Redo: the imported version comes back, as version 5.
    const redone = (await api.restoreVersion!(dir, 'main', 3, 'drift over time')) as Window
    expect(redone).toMatchObject({ version: 5, parent: 4, restoredFrom: 3, rows: 2, active: 2 })
    expect(redone.view.view.panels[1].n).toBe(2)
    expect(await readFile(join(dir, 'STATE.md'), 'utf8')).toContain('2 active points')
  })

  it('imports a messy file through the window door: preview, map, then one append', async () => {
    const api = await shell()
    const dir = await scratchProject()
    const opened = (await api.openView!(dir, 'drift over time')) as Window
    expect(opened.view.panels[1].n).toBe(14)
    const file = join(process.cwd(), 'fixtures', 'imports', 'lab-export.csv')

    const preview = (await api.importPreview!(dir, file)) as Window
    expect(preview.columns).toEqual(['timestamp', 'temp_c', 'volts', 'note', 'operator'])
    // The preamble lines are counted, never imported.
    expect(preview.comments).toBe(2)
    expect(preview.rows).toBe(5)
    // The fixture's shape is x, y; this export names neither, so nothing is suggested.
    expect(preview.suggested).toEqual({})
    expect(preview.duplicate).toBe(false)

    // A mapping that leaves a required field out is a refusal that names the field.
    await expect(api.importFile!(dir, file, { x: 'temp_c' })).rejects.toThrow(/no column for the required field "y"/)
    // The window door has the same default as the CLI: extra columns are refused, not dropped.
    await expect(api.importPlan!(dir, file, { x: 'temp_c', y: 'volts' })).rejects.toThrow(
      /2 columns have no shape field: note, operator/,
    )
    await expect(api.importFile!(dir, file, { x: 'temp_c', y: 'volts' })).rejects.toThrow(
      /no shape field/,
    )

    // What the sheet shows before the button is pressed is the same computation the write performs:
    // the version, the rows that leave, and the parent they stay in. Nothing is written here.
    const beforePlan = await readFile(join(dir, 'data', 'events.jsonl'), 'utf8')
    const ignored = { ignoreColumns: ['note', 'operator'] }
    const planned = (await api.importPlan!(dir, file, { x: 'temp_c', y: 'volts' }, ignored)) as Window
    expect(planned).toMatchObject({
      version: 3,
      parent: 2,
      rows: 5,
      ignoredColumns: ['note', 'operator'],
      diff: { added: 5, removed: 14, changed: 0 },
    })
    expect(planned.removedRows).toHaveLength(14)
    expect(await readFile(join(dir, 'data', 'events.jsonl'), 'utf8')).toBe(beforePlan)

    const logBefore = await readFile(join(dir, 'data', 'events.jsonl'), 'utf8')
    const imported = (await api.importFile!(dir, file, { x: 'temp_c', y: 'volts' }, {
      ...ignored,
      viewName: 'drift over time',
    })) as Window
    expect(imported.rows).toBe(5)
    expect(imported.ignoredColumns).toEqual(['note', 'operator'])
    expect(imported.preserved).toMatch(/^data\/raw\/[0-9a-f]{12}-lab-export\.csv$/)
    // The fixture is at version 2, and none of its rows are in this file: the export is now the
    // dataset, as version 3, and the fourteen rows it does not have are withdrawn rather than lost.
    expect(imported).toMatchObject({ version: 3, parent: 2, diff: { added: 5, removed: 14, changed: 0 } })
    expect(imported.active).toBe(5)
    expect(imported.removedRows).toHaveLength(14)
    // The open tab comes back redrawn, with the plot panel rebuilt and the fitted one honestly stale.
    expect(imported.view.view.panels[1].n).toBe(5)
    expect(imported.view.statuses.map((status: Window) => status.state)).toEqual(['stale', 'current'])

    // What the log holds: the version, then one point per new row, the withdrawals, and the record
    // that names the preserved original.
    const appended = (await readFile(join(dir, 'data', 'events.jsonl'), 'utf8'))
      .slice(logBefore.length)
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(appended[0]).toMatchObject({ type: 'dataset_version_created', version: 3, parent: 2, rows: 5 })
    expect(appended.filter((event: Window) => event.type === 'point_recorded')).toHaveLength(5)
    expect(appended.filter((event: Window) => event.type === 'point_retracted')).toHaveLength(14)
    expect(appended.at(-1)).toMatchObject({ type: 'import_completed', dataset: 'main', rows: 5, file: imported.preserved })
    const firstRow = appended.find((event: Window) => event.type === 'point_recorded')
    expect(firstRow.values).toEqual({ x: 21.4, y: 3.301 })
    expect(firstRow.t_observed).toBe('2026-01-05T09:00:00.000Z')
    expect(firstRow.version).toBe(3)
    // Every withdrawal names the version it happened in, so version 2 still reads as it did.
    expect(appended.filter((event: Window) => event.type === 'point_retracted').every((event: Window) => event.version === 3)).toBe(true)
    // Evidence, byte for byte.
    expect(await readFile(join(dir, imported.preserved), 'utf8')).toBe(await readFile(file, 'utf8'))

    // And the same bytes twice is refused until it is asked for explicitly.
    await expect(
      api.importFile!(dir, file, { x: 'temp_c', y: 'volts' }, ignored),
    ).rejects.toThrow(/already imported/)
  })

  it('refuses an untimed file through the window door, and reads a named time column when given one', async () => {
    const api = await shell()
    const dir = await scratchProject()

    // The sheet and the CLI share one planner, so the refusal is the core's, not the window's.
    await writeFile(join(dir, 'untimed.csv'), 'x,y\n1,2.55\n2,4.62\n', 'utf8')
    const before = await readFile(join(dir, 'data', 'events.jsonl'), 'utf8')
    await expect(api.importPlan!(dir, join(dir, 'untimed.csv'), { x: 'x', y: 'y' })).rejects.toThrow(
      /no column holds the observation time/,
    )
    await expect(api.importFile!(dir, join(dir, 'untimed.csv'), { x: 'x', y: 'y' })).rejects.toThrow(
      /no column holds the observation time/,
    )
    expect(await readFile(join(dir, 'data', 'events.jsonl'), 'utf8')).toBe(before)

    // A column named `taken_at` is not one of the names bench guesses, so the sheet has to say it.
    // Four rows the fixture already has, plus one new reading: the diff is about that one row.
    const file = join(dir, 'taken-at.csv')
    await writeFile(
      file,
      'taken_at,x,y\n' +
        '2026-10-01T09:00:00Z,1,2.55\n' +
        '2026-10-01T09:04:00Z,2,4.62\n' +
        '2026-10-02T09:00:00Z,3,6.71\n' +
        '2026-10-03T09:00:00Z,4,8.85\n' +
        '2026-10-16T09:00:00Z,7,18.62\n',
      'utf8',
    )
    const preview = (await api.importPreview!(dir, file)) as Window
    expect(preview.suggestedTime).toBeNull()
    const planned = (await api.importPlan!(dir, file, { x: 'x', y: 'y' }, { time: 'taken_at' })) as Window
    expect(planned).toMatchObject({ version: 3, parent: 2, diff: { added: 1, removed: 10, changed: 0 } })

    const imported = (await api.importFile!(dir, file, { x: 'x', y: 'y' }, { time: 'taken_at' })) as Window
    expect(imported).toMatchObject({ version: 3, parent: 2, diff: { added: 1, removed: 10, changed: 0 } })
    const appended = (await readFile(join(dir, 'data', 'events.jsonl'), 'utf8'))
      .slice(before.length)
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const recorded = appended.filter((event: Window) => event.type === 'point_recorded')
    expect(recorded).toHaveLength(1)
    // The instant is the file's, not the moment of the import: that is the whole point.
    expect(recorded[0].t_observed).toBe('2026-10-16T09:00:00.000Z')
    expect(recorded[0].version).toBe(3)
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
    expect(settled.drawings).toBeNull()
    expect(settled.counts[1]).toBe(15)
    expect(settled.evidence[1]).toMatchObject({ points: 15, noCurve: 'unmodelled' })
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
    // The tab dialog reads these candidates from the core, not from its own type list.
    expect(created.datasets[0].axes.x.map((field: Window) => field.name)).toEqual(['mass', 'extension'])
    expect(created.datasets[0].axes.y.map((field: Window) => field.name)).toEqual(['mass', 'extension'])

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
    expect(created.drawings).toHaveLength(1)

    const file = JSON.parse(await readFile(join(dir, 'views', 'slope-check.json'), 'utf8')) as Window
    expect(file.panels[0].n).toBe(14)

    // A tab the user built is not something to overwrite silently.
    await expect(api.writeView!(dir, { name: 'slope check', dataset: 'main' })).rejects.toThrow(
      /already exists/,
    )
    // And a dataset that is not there is a refusal, not an empty chart.
    await expect(api.writeView!(dir, { name: 'other', dataset: 'nope' })).rejects.toThrow(/no dataset/)
  })

  it('closes a tab, lists it for the next window, and moves the same one back', async () => {
    const api = await shell()
    const dir = await scratchProject()
    const opened = (await api.openView!(dir, 'drift over time')) as Window
    const file = join(dir, 'views', 'drift-over-time.json')
    const before = await readFile(file, 'utf8')
    const log = await readFile(join(dir, 'data', 'events.jsonl'), 'utf8')

    const closed = (await api.closeView!(dir, 'drift over time')) as Window
    // The archive, not a copy: a reopen moves this file home rather than rebuilding a drawing from
    // today's rows.
    expect(closed.name).toBe('drift over time')
    expect(closed.panels).toBe(opened.view.panels.length)
    expect(closed.file).toMatch(/^drift-over-time-\d{4}-\d{2}-\d{2}T[\d-]+Z\.json$/)
    await expect(readFile(file, 'utf8')).rejects.toThrow()
    const listed = (await api.openProject!(dir)) as Window
    expect(listed.views.map((view: Window) => view.name)).not.toContain('drift over time')

    // A window that starts now has nothing in memory and still finds the tab: the list is the
    // project's, read from the trash.
    const closedNow = (await api.closedViews!(dir)) as Window
    expect(closedNow.closed).toHaveLength(1)
    expect(closedNow.closed[0]).toMatchObject({ file: closed.file, name: 'drift over time' })
    expect(closedNow.problems).toEqual([])

    const restored = (await api.restoreClosedView!(dir, closed.file)) as Window
    expect(restored.view.name).toBe('drift over time')
    // The same drawing, drawn by the same path as any opened tab: same counts, same entry target.
    expect(restored.view.panels[0].n).toBe(opened.view.panels[0].n)
    expect(restored.entry.dataset).toBe(opened.entry.dataset)
    expect(restored.entry.active).toBe(14)
    expect(await readFile(file, 'utf8')).toBe(before)
    expect(((await api.openProject!(dir)) as Window).views.map((view: Window) => view.name)).toContain(
      'drift over time',
    )
    // The archive went home, so nothing is left to reopen twice: the list is empty again.
    expect(((await api.closedViews!(dir)) as Window).closed).toEqual([])
    // A close is a window act, not a dataset event: the log is byte-identical either way.
    expect(await readFile(join(dir, 'data', 'events.jsonl'), 'utf8')).toBe(log)
  })

  it('writes a field-pair tab for a custom shape through the same core the window calls', async () => {
    const api = await shell()
    const parent = await mkdtemp(join(tmpdir(), 'bench-shell-axes-'))
    scratch.push(parent)
    const created = (await api.createProject!(parent, 'axes window', {
      id: 'flight.v1',
      fields: [
        { name: 'date', type: 'instant' },
        { name: 'altitude', type: 'number' },
        { name: 'app', type: 'number' },
      ],
    })) as Window
    await api.recordPoint!(created.dir, {
      values: { date: '2026-10-19T12:41:32.498Z', altitude: 992.4, app: 0.675 },
      tObserved: '2026-10-19T12:41:32.498Z',
    })

    const opened = (await api.writeView!(created.dir, {
      name: 'altitude over time',
      dataset: 'main',
      xField: 'date',
      yField: 'altitude',
    })) as Window
    expect(opened.view.panels[0].x_field).toBe('date')
    expect(opened.view.panels[0].y_field).toBe('altitude')
    expect(opened.view.panels[0].chart.x).toEqual({ label: 'date', format: 'time' })
    const ids = opened.drawings[0].ids.split('\n')
    expect(ids).toHaveLength(1)
    expect(ids[0]).toBeTruthy()
    expect(opened.drawings[0].marks).toHaveLength(2)
    expect(opened.drawings[0].xs[0]).toBe(Date.parse('2026-10-19T12:41:32.498Z'))
    expect(opened.drawings[0].ys[0]).toBe(992.4)

    // An instant axis is projected through the same path: the incremental mark carries epoch millis
    // on x and the numeric value on y, not the raw ISO string or the wrong field pair.
    const later = (await api.recordPoint!(
      created.dir,
      {
        values: {
          date: '2026-10-19T13:41:32.498Z',
          altitude: 990,
          app: 0.7,
        },
      },
      'altitude over time',
    )) as Window
    expect(later.redraw).toBe(false)
    expect(later.marks).toHaveLength(1)
    expect(later.marks[0]).toMatchObject({
      x: Date.parse('2026-10-19T13:41:32.498Z'),
      y: 990,
    })

    const saved = JSON.parse(await readFile(join(created.dir, 'views', 'altitude-over-time.json'), 'utf8')) as Window
    expect(saved.panels[0].x_field).toBe('date')
    expect(saved.panels[0].chart.x.format).toBe('time')
  })

  it('projects a point onto a custom-axis tab and refreshes with the axes it already had', async () => {
    const api = await shell()
    const parent = await mkdtemp(join(tmpdir(), 'bench-shell-axes-write-'))
    scratch.push(parent)
    const created = (await api.createProject!(parent, 'custom axes', {
      id: 'load.v1',
      fields: [
        { name: 'mass', type: 'number' },
        { name: 'extension', type: 'number' },
      ],
    })) as Window
    await api.writeView!(created.dir, {
      name: 'mass vs extension',
      dataset: 'main',
      xField: 'mass',
      yField: 'extension',
    })

    // The first point has no scale to land against, so it must ask for a redraw rather than
    // patching a mark onto the empty frame. The redraw is the bug this test pins: before the fix it
    // returned no marks and no redraw, and the following refresh reverted to x/y.
    const first = (await api.recordPoint!(
      created.dir,
      { values: { mass: 2.5, extension: 12 } },
      'mass vs extension',
    )) as Window
    expect(first.redraw).toBe(true)
    expect(first.marks).toEqual([])

    const rebuilt = (await api.refreshView!(created.dir, 'mass vs extension', { draw: true })) as Window
    expect(rebuilt.kept).toEqual([])
    expect(rebuilt.view.panels[0].x_field).toBe('mass')
    expect(rebuilt.view.panels[0].y_field).toBe('extension')
    expect(rebuilt.view.panels[0].chart.x.label).toBe('mass')
    expect(rebuilt.view.panels[0].n).toBe(1)
    expect(rebuilt.drawings[0].marks).toHaveLength(2)
    expect(Array.from(rebuilt.drawings[0].xs)).toEqual([2.5])
    expect(Array.from(rebuilt.drawings[0].ys)).toEqual([12])

    // A point inside the drawn domain is one mark on this panel's axes, not one on x/y.
    const second = (await api.recordPoint!(
      created.dir,
      { values: { mass: 2.6, extension: 12.2 } },
      'mass vs extension',
    )) as Window
    expect(second.redraw).toBe(false)
    expect(second.untouched).toEqual([])
    expect(second.marks).toHaveLength(1)
    expect(second.marks[0]).toMatchObject({ index: 0, id: second.id, x: 2.6, y: 12.2 })
    expect(second.marks[0].cx).toBeGreaterThan(0)
    expect(second.marks[0].cy).toBeGreaterThan(0)

    // A point that moves the axes asks for a redraw, and the refresh still reads the panel's own
    // fields rather than falling back to x/y.
    const moved = (await api.recordPoint!(
      created.dir,
      { values: { mass: 1000, extension: 5000 } },
      'mass vs extension',
    )) as Window
    expect(moved.redraw).toBe(true)
    const afterMove = (await api.refreshView!(created.dir, 'mass vs extension', {
      draw: true,
    })) as Window
    expect(afterMove.kept).toEqual([])
    expect(afterMove.view.panels[0].x_field).toBe('mass')
    expect(afterMove.view.panels[0].y_field).toBe('extension')
    expect(afterMove.view.panels[0].n).toBe(3)
    expect(afterMove.drawings[0].marks).toHaveLength(6)

    const saved = JSON.parse(
      await readFile(join(created.dir, 'views', 'mass-vs-extension.json'), 'utf8'),
    ) as Window
    expect(saved.panels[0].x_field).toBe('mass')
    expect(saved.panels[0].n).toBe(3)
  })

  it('saves the rebuilt tab that was painted even after another tab is opened', async () => {
    const api = await shell()
    const dir = await scratchProject()
    await api.openView!(dir, 'drift over time')
    await api.writeView!(dir, { name: 'second tab', dataset: 'main' })
    await api.openView!(dir, 'drift over time')

    // A point outside the axes forces the deferred-save path: refresh with `persist:false` leaves
    // the rebuilt view staged, exactly as the window does before it paints.
    const recorded = (await api.recordPoint!(
      dir,
      { values: { x: 1000, y: 1000 } },
      'drift over time',
    )) as Window
    expect(recorded.redraw).toBe(true)
    const rebuilt = (await api.refreshView!(dir, 'drift over time', {
      draw: true,
      persist: false,
    })) as Window
    expect(rebuilt.view.panels[1].n).toBe(15)

    // Reopening the same tab before the save runs must show the drawing that was painted, not the
    // old file, and must leave the staged view for the save.
    const reopened = (await api.openView!(dir, 'drift over time')) as Window
    expect(reopened.view.panels[1].n).toBe(15)
    // A read that finds nothing stale must not discard the pending view: it is still what was
    // painted, and the save is still owed.
    const noop = (await api.refreshView!(dir, 'drift over time', { draw: true })) as Window
    expect(noop.refreshed).toEqual([])

    // The user opens the other tab before the paint's save runs. The save must write the staged
    // drawing for "drift over time", not reload that name from disk (which still says n = 14).
    await api.openView!(dir, 'second tab')
    const persisted = (await api.persistView!(dir, 'drift over time')) as Window
    expect(persisted).toMatchObject({ reread: false, saved: true })
    const saved = JSON.parse(
      await readFile(join(dir, 'views', 'drift-over-time.json'), 'utf8'),
    ) as Window
    expect(saved.panels[1].n).toBe(15)

    // There is no staged view for the tab now on screen. Refusing to write is the honest answer;
    // reloading by name here would have written a stale file over it.
    const missing = (await api.persistView!(dir, 'second tab')) as Window
    expect(missing.saved).toBe(false)
  })

  it('catches a staged tab up when another point is painted before its save', async () => {
    const api = await shell()
    const dir = await scratchProject()
    await api.openView!(dir, 'drift over time')

    // The first point moves the axes, so the window redraws and stages the rebuilt tab.
    const moved = (await api.recordPoint!(dir, { values: { x: 1000, y: 1000 } }, 'drift over time')) as Window
    expect(moved.redraw).toBe(true)
    const rebuilt = (await api.refreshView!(dir, 'drift over time', {
      draw: true,
      persist: false,
    })) as Window
    expect(rebuilt.view.panels[1].n).toBe(15)

    // A second point inside the new axes is painted as one mark, without another refresh or stage.
    // The staged view still says n = 15; saving it unchanged would lose the point that is on screen.
    const inside = (await api.recordPoint!(
      dir,
      { values: { x: 6.5, y: 16.4 } },
      'drift over time',
    )) as Window
    expect(inside.redraw).toBe(false)
    expect(inside.marks).toHaveLength(1)

    const persisted = (await api.persistView!(dir, 'drift over time')) as Window
    expect(persisted).toMatchObject({ reread: false, saved: true })
    const saved = JSON.parse(
      await readFile(join(dir, 'views', 'drift-over-time.json'), 'utf8'),
    ) as Window
    expect(saved.panels[1].n).toBe(16)
    expect(saved.panels[1].chart.points).toHaveLength(16)
  })

  it('writes a first tab before the project has any points, through the window\'s own call', async () => {
    const api = await shell()
    const parent = await mkdtemp(join(tmpdir(), 'bench-shell-first-'))
    scratch.push(parent)
    const created = (await api.createProject!(parent, 'first tab', {
      id: 'flight.v1',
      fields: [
        { name: 'altitude', type: 'number' },
        { name: 'app', type: 'number' },
        { name: 'date', type: 'instant' },
      ],
    })) as Window

    const opened = (await api.writeView!(created.dir, {
      name: 'first tab',
      dataset: 'main',
      xField: 'app',
      yField: 'altitude',
    })) as Window
    expect(opened.view.panels[0].n).toBe(0)
    // The sentence is the window's to compose; the descriptor says the panel is empty, and the
    // drawing itself stays a wordless frame.
    expect(opened.view.panels[0].chart.empty).toBeTruthy()
    expect(opened.drawings[0].over).not.toContain('No observations')
    expect(opened.drawings[0].over).not.toContain('bench add')
    expect(opened.drawings[0].marks).toHaveLength(0)
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
  const cli = join(process.cwd(), 'src', 'cli', 'index.ts')

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

  it('refuses a correction onto a withdrawn row, with the kind the bar ends the edit on', async () => {
    const api = await shell()
    const dir = await scratchProject()
    const opened = (await api.openView!(dir, 'drift over time')) as Window
    const drawn = opened.drawings[1]
    const id = drawn.ids.split('\n')[0]

    // The row is withdrawn after the tab drawing it was taken from — the same state the window is in
    // when an import, or an undo, takes away the point the strip is editing.
    await api.retractPoint!(dir, id, 'withdrawn under the strip')
    const before = await readFile(join(dir, 'data', 'events.jsonl'), 'utf8')

    let refusal: Window | null = null
    try {
      await api.correctPoint!(dir, id, { y: 1 }, 'drift over time')
    } catch (error) {
      refusal = api.refusalOf!(error) as Window
    }

    // The kind crosses the door the window branches on: `missing` is what ends the edit rather than
    // leaving a Save that can only be refused again.
    expect(refusal).toMatchObject({ ok: false, error: { kind: 'missing' } })
    expect(await readFile(join(dir, 'data', 'events.jsonl'), 'utf8')).toBe(before)
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
