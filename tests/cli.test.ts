import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { interpreterCandidates } from '../src/core/runner.ts'

/**
 * These tests run the *actual* command a user runs: `node src/cli/index.ts`. That matters, because
 * the test runner transpiles TypeScript and Node does not. A construct the tests accept can still
 * fail in the binary, which is exactly what happened once already -- the CLI was dead while 38 tests
 * were green. Never let this file be replaced by an import of the CLI's internals.
 */
const run = promisify(execFile)
const cli = join(process.cwd(), 'src', 'cli', 'index.ts')

async function bench(args: string[], cwd?: string) {
  try {
    const { stdout, stderr } = await run('node', [cli, ...args], {
      cwd: cwd ?? process.cwd(),
      maxBuffer: 8 * 1024 * 1024,
    })
    return { code: 0, stdout, stderr }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

let project: string
let benchHome: string

beforeAll(async () => {
  project = await mkdtemp(join(tmpdir(), 'bench-cli-'))
  // Every spawned command registers the project it opens. Point that at a scratch home, or running
  // the test suite would rearrange the list a real user switches projects with.
  benchHome = await mkdtemp(join(tmpdir(), 'bench-home-'))
  process.env.BENCH_HOME = benchHome
})

afterAll(async () => {
  delete process.env.BENCH_HOME
  await rm(project, { recursive: true, force: true })
  await rm(benchHome, { recursive: true, force: true })
})

describe('bench CLI, as executed', () => {
  it('starts and prints usage', async () => {
    const result = await bench(['help'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('bench — append-only data project')
    expect(result.stdout).toContain('Exit codes')
  })

  it('declares a chosen shape at init, so an agent can build what the window builds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bench-shape-'))
    try {
      const shapeFile = join(root, 'load.json')
      await writeFile(
        shapeFile,
        JSON.stringify({
          id: 'load.v1',
          fields: [
            { name: 'mass', type: 'number' },
            { name: 'extension', type: 'number' },
          ],
        }),
        'utf8',
      )
      const target = join(root, 'load-cells')
      const init = await bench(['init', target, '--name', 'load cells', '--shape', shapeFile])
      expect(init.code).toBe(0)
      expect(init.stdout).toContain('shape declared from')

      const log = await readFile(join(target, 'data', 'events.jsonl'), 'utf8')
      expect(log).toContain('"load.v1"')
      const added = await bench(['--project', target, 'add', '--values', '{"mass":2.5,"extension":12}', '--json'])
      expect(added.code).toBe(0)
      // A field the declared shape does not have is the same refusal the window shows.
      const wrong = await bench(['--project', target, 'add', '--x', '1', '--y', '2'])
      expect(wrong.code).toBe(1)

      const broken = join(root, 'broken.json')
      await writeFile(broken, JSON.stringify({ id: 'load', fields: [{ name: 'x', type: 'number' }] }), 'utf8')
      const refused = await bench(['init', join(root, 'nope'), '--shape', broken])
      expect(refused.code).toBe(1)
      expect(refused.stderr).toContain('not a shape id')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('takes a custom shape from init through a real first tab, with hints derived from its fields', { timeout: CLI_TIMEOUT }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'bench-first-run-'))
    try {
      const shapeFile = join(root, 'flight.json')
      await writeFile(
        shapeFile,
        JSON.stringify({
          id: 'flight.v1',
          fields: [
            { name: 'altitude', type: 'number' },
            { name: 'app', type: 'number' },
            { name: 'date', type: 'instant' },
          ],
        }),
        'utf8',
      )
      const target = join(root, 'flight-log')
      const init = await bench(['init', target, '--name', 'flight log', '--shape', shapeFile])
      expect(init.code).toBe(0)
      // Every hint on the route names the shape's own fields, never `x`/`y`.
      const hint = init.stdout.split('\n').find((line) => line.trimStart().startsWith('next:'))!
      expect(hint).toContain('--values')
      expect(hint).toContain('altitude')
      expect(hint).toContain('app')
      expect(hint).toContain('date')
      expect(hint).not.toContain('--x ')
      expect(hint).not.toContain('--y ')

      // `bench chart` on an empty project is an artifact with a sentence, not a bare refusal.
      const emptyChart = await bench([
        '--project',
        target,
        'chart',
        '--x-field',
        'app',
        '--y-field',
        'altitude',
        '--out',
        join(root, 'no-rows.svg'),
      ])
      expect(emptyChart.code).toBe(0)
      expect(emptyChart.stdout).toContain('(0 points)')
      const noRowsSvg = await readFile(join(root, 'no-rows.svg'), 'utf8')
      expect(noRowsSvg).toContain('No observations')
      expect(noRowsSvg).not.toContain('data-point-id')

      const empty = await bench(['--project', target, 'view', 'list'])
      expect(empty.code).toBe(0)
      // The example puts a different field on each axis; the y is the shape's first numeric field.
      expect(empty.stdout).toContain('--x-field app')
      expect(empty.stdout).toContain('--y-field altitude')
      expect(empty.stdout).not.toContain('--recipe')

      // A tab with no rows is real: it saves, says what to add, and draws no mark.
      const first = await bench([
        '--project',
        target,
        'view',
        'new',
        'empty tab',
        '--dataset',
        'main',
        '--x-field',
        'altitude',
        '--y-field',
        'app',
      ])
      expect(first.code).toBe(0)
      const shown = await bench(['--project', target, 'view', 'show', 'empty tab', '--json'])
      const panel = JSON.parse(shown.stdout) as {
        data: { view: { panels: { n: number; chart: { empty?: string } }[] } }
      }
      expect(panel.data.view.panels[0]!.n).toBe(0)
      expect(panel.data.view.panels[0]!.chart.empty).toContain('No observations')
      const rendered = await bench([
        '--project',
        target,
        'view',
        'render',
        'empty tab',
        '--out',
        join(root, 'empty.svg'),
      ])
      expect(rendered.code).toBe(0)
      const emptySvg = await readFile(join(root, 'empty.svg'), 'utf8')
      expect(emptySvg).toContain('No observations')
      expect(emptySvg).not.toContain('data-point-id')

      // A bare `add` on the custom shape teaches the same command, not `--x`/`--y`.
      const bareAdd = await bench(['--project', target, 'add'])
      expect(bareAdd.code).toBe(1)
      expect(bareAdd.stderr).toContain('hint:')
      expect(bareAdd.stderr).toContain('--values')
      expect(bareAdd.stderr).not.toContain('--x ')

      // The init hint's own sample values are accepted by the shape it described.
      const values = /--values '([^']+)'/.exec(hint)![1]!
      const added = await bench(['--project', target, 'add', '--values', values, '--at', '2026-10-01T00:00:00Z'])
      expect(added.code).toBe(0)
      const withPoint = await bench(['--project', target, 'view', 'show', 'empty tab', '--json'])
      const pointed = JSON.parse(withPoint.stdout) as {
        data: { view: { panels: { n: number; chart: { points?: { id?: string }[] } }[] } }
      }
      // `view show` reads the saved panel, so the count there is still the saved zero until render.
      expect(pointed.data.view.panels[0]!.n).toBe(0)
      const rerendered = await bench([
        '--project',
        target,
        'view',
        'render',
        'empty tab',
        '--refresh',
        '--out',
        join(root, 'filled.svg'),
      ])
      expect(rerendered.code).toBe(0)
      expect(await readFile(join(root, 'filled.svg'), 'utf8')).toContain('data-point-id')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('suggests a first tab with x across and y up, and the tab it names draws them there', { timeout: CLI_TIMEOUT }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'bench-hint-axes-'))
    try {
      const target = join(root, 'demo')
      expect((await bench(['init', target, '--name', 'demo'])).code).toBe(0)
      // Values far enough apart that one axis cannot be mistaken for the other in the drawing.
      for (const [x, y] of [[10, 2.5], [20, 5.1], [30, 7.8]]) {
        const added = await bench(['--project', target, 'add', '--x', String(x), '--y', String(y)])
        expect(added.code).toBe(0)
      }

      const listed = await bench(['--project', target, 'view', 'list'])
      const suggested = listed.stdout.split('\n').find((line) => line.trimStart().startsWith('next:'))!
      // The built-in shape names its axes, so the example reads them the way the window's pickers do.
      // It used to print `--x-field y`, which drew the shape rotated.
      expect(suggested).toContain('view new "first tab" --dataset main --x-field x --y-field y')

      // Run the suggested tail exactly as printed, under the project the line names, then draw it.
      const tail = suggested.slice(suggested.indexOf('view new'))
      const args = tail.match(/"[^"]*"|\S+/g)!.map((token) => token.replace(/^"|"$/g, ''))
      expect((await bench(['--project', target, ...args])).code).toBe(0)
      expect((await bench(['--project', target, 'view', 'render', 'first tab'])).code).toBe(0)

      const svg = await readFile(join(target, 'artifacts', 'view-first-tab.svg'), 'utf8')
      const nodes = [...svg.matchAll(/<text([^>]*)>([^<]+)<\/text>/g)].map((match) => ({
        attrs: match[1]!,
        text: match[2]!,
      }))
      // Axis labels are anchored: centred ones run along the bottom, end-anchored ones up the side.
      const ticks = (anchor: string) =>
        nodes
          .filter(
            (node) =>
              node.attrs.includes(`text-anchor="${anchor}"`) &&
              node.text.trim() !== '' &&
              Number.isFinite(Number(node.text)),
          )
          .map((node) => Number(node.text))
      const across = ticks('middle')
      const up = ticks('end')
      expect(across.length).toBeGreaterThan(1)
      expect(Math.min(...across)).toBeGreaterThanOrEqual(10)
      expect(Math.max(...across)).toBeLessThanOrEqual(30)
      expect(up.length).toBeGreaterThan(1)
      expect(Math.max(...up)).toBeLessThan(10)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('extends a declared shape and records a point in the new field', { timeout: CLI_TIMEOUT }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'bench-extend-'))
    try {
      const shapeFile = join(root, 'flight.json')
      await writeFile(
        shapeFile,
        JSON.stringify({
          id: 'flight.v1',
          fields: [
            { name: 'date', type: 'instant' },
            { name: 'altitude', type: 'number' },
            { name: 'app', type: 'number' },
            { name: 'apm', type: 'number' },
            { name: 'pps', type: 'number' },
          ],
        }),
        'utf8',
      )
      const target = join(root, 'flight-log')
      expect((await bench(['init', target, '--name', 'flight log', '--shape', shapeFile])).code).toBe(0)
      // A row recorded before b2b existed must stay valid after the extension.
      const prior = await bench([
        '--project',
        target,
        'add',
        '--values',
        '{"date":"2026-10-19T12:40:32.498Z","altitude":991.2,"app":0.67,"apm":52.1,"pps":1.28}',
        '--at',
        '2026-10-19T12:40:32.498Z',
        '--json',
      ])
      expect(prior.code).toBe(0)
      const priorId = (JSON.parse(prior.stdout) as { data: { id: string } }).data.id

      const extended = await bench([
        '--project',
        target,
        'shape',
        'extend',
        'flight.v1',
        '--field',
        'b2b',
        '--type',
        'integer',
        '--json',
      ])
      expect(extended.code).toBe(0)
      const extension = JSON.parse(extended.stdout) as {
        data: { from: string; shape: { id: string; fields: { name: string }[] }; datasets: string[] }
      }
      expect(extension.data.from).toBe('flight.v1')
      expect(extension.data.shape.id).toBe('flight.v2')
      expect(extension.data.shape.fields.map((field) => field.name)).toEqual([
        'date',
        'altitude',
        'app',
        'apm',
        'pps',
        'b2b',
      ])
      expect(extension.data.datasets).toEqual(['main'])

      // A second extension of v1 would fork the history; a duplicate or an untyped field is refused
      // before anything is appended.
      const stale = await bench(['--project', target, 'shape', 'extend', 'flight.v1', '--field', 'extra', '--type', 'number'])
      expect(stale.code).toBe(1)
      expect(stale.stderr).toContain('not the latest version')
      const duplicate = await bench(['--project', target, 'shape', 'extend', 'flight.v2', '--field', 'b2b', '--type', 'integer'])
      expect(duplicate.code).toBe(1)
      expect(duplicate.stderr).toContain('appears twice')
      const untyped = await bench(['--project', target, 'shape', 'extend', 'flight.v2', '--field', 'extra'])
      expect(untyped.code).toBe(1)
      expect(untyped.stderr).toContain('explicit type')

      // Correcting an older row validates it against its own declaration, not the required b2b that
      // was added afterwards.
      const corrected = await bench([
        '--project',
        target,
        'correct',
        priorId,
        '--values',
        '{"altitude":991.3}',
        '--reason',
        'transcription',
      ])
      expect(corrected.code).toBe(0)

      const added = await bench([
        '--project',
        target,
        'add',
        '--values',
        '{"date":"2026-10-19T12:41:32.498Z","altitude":992.4,"app":0.675,"apm":52.24,"pps":1.29,"b2b":14}',
        '--at',
        '2026-10-19T12:41:32.498Z',
      ])
      expect(added.code).toBe(0)
      expect(added.stderr).not.toContain('unknown field')

      const checked = await bench(['--project', target, 'check'])
      expect(checked.code).toBe(0)
      expect(checked.stdout).toContain('2 active points')
      expect(checked.stdout).toContain('0 error(s)')

      const listed = await bench(['--project', target, 'list', '--json'])
      const points = JSON.parse(listed.stdout) as { data: { values: Record<string, unknown> }[] }
      expect(points.data.find((point) => point.values.altitude === 992.4)?.values).toMatchObject({
        altitude: 992.4,
        b2b: 14,
      })
      // The earlier row keeps its original fields; it was not backfilled with a value nobody measured.
      expect(points.data.find((point) => point.values.altitude === 991.3)?.values).not.toHaveProperty('b2b')

      // The same field pair through `bench chart` and a saved panel.
      const chartPath = join(root, 'axes.svg')
      const chart = await bench([
        '--project',
        target,
        'chart',
        '--x-field',
        'date',
        '--y-field',
        'altitude',
        '--out',
        chartPath,
      ])
      expect(chart.code).toBe(0)
      expect(chart.stdout).toContain('2 points')
      const chartSvg = await readFile(chartPath, 'utf8')
      expect(chartSvg).toContain('data-point-id')
      expect(chartSvg).toContain('2026-10-19')
      const noAxes = await bench(['--project', target, 'chart'])
      expect(noAxes.code).toBe(2)
      expect(noAxes.stderr).toContain('has no field "x"')
      expect(noAxes.stderr).toContain('--x-field')

      const tab = await bench([
        '--project',
        target,
        'view',
        'new',
        'altitude over time',
        '--dataset',
        'main',
        '--x-field',
        'date',
        '--y-field',
        'altitude',
      ])
      expect(tab.code).toBe(0)
      expect(tab.stdout).toContain('created views/altitude-over-time.json')
      const saved = JSON.parse(
        await readFile(join(target, 'views', 'altitude-over-time.json'), 'utf8'),
      ) as { panels: { x_field?: string; y_field?: string; chart: { x: { format?: string } } }[] }
      expect(saved.panels[0]?.x_field).toBe('date')
      expect(saved.panels[0]?.y_field).toBe('altitude')
      expect(saved.panels[0]?.chart.x.format).toBe('time')
      const rendered = await bench(['--project', target, 'view', 'render', 'altitude over time'])
      expect(rendered.code).toBe(0)
      expect(await readFile(join(target, 'artifacts', 'view-altitude-over-time.svg'), 'utf8')).toContain(
        'data-point-id',
      )

      const state = await bench(['--project', target, 'state'])
      expect(state.stdout).toContain('flight.v2')
      expect(state.stdout).toContain('b2b:integer')
      const agents = await readFile(join(target, 'AGENTS.md'), 'utf8')
      expect(agents).toContain('flight.v2')
      expect(agents).toContain('b2b:integer')

      // The import mapping reads the new declaration too: B2B is no longer an undeclared column.
      const csv = join(root, 'flight.csv')
      await writeFile(
        csv,
        'Date,Altitude,APP,APM,PPS,B2B\n2026-10-19T12:42:32.498Z,993.1,0.681,52.31,1.3,14\n',
        'utf8',
      )
      const dry = await bench([
        '--project',
        target,
        'import',
        csv,
        '--time',
        'Date',
        '--dry-run',
        '--json',
      ])
      expect(dry.stderr).toBe('')
      expect(dry.code).toBe(0)
      const plan = JSON.parse(dry.stdout) as {
        data: { mapping: Record<string, string>; ignoredColumns?: string[] }
      }
      expect(plan.data.mapping.b2b).toBe('B2B')
      expect(plan.data.ignoredColumns).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('designates a shape\'s observation field, derives the instant from it, and refuses a contradiction', { timeout: CLI_TIMEOUT }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'bench-observation-'))
    try {
      const shapeFile = join(root, 'visit.json')
      await writeFile(
        shapeFile,
        JSON.stringify({
          id: 'visit.v1',
          fields: [
            { name: 'date', type: 'instant' },
            { name: 'value', type: 'number' },
          ],
        }),
        'utf8',
      )
      const target = join(root, 'visits')
      expect((await bench(['init', target, '--name', 'visits', '--shape', shapeFile])).code).toBe(0)

      // An event written before there was a designation is not reinterpreted by it: this point's
      // text and its instant disagree, and the model leaves both exactly as recorded.
      const prior = await bench([
        '--project', target, 'add', '--values', '{"date":"2026-09-01T00:00:00Z","value":1}',
        '--at', '2026-09-02T00:00:00Z', '--json',
      ])
      expect(prior.code).toBe(0)
      const priorId = (JSON.parse(prior.stdout) as { data: { id: string } }).data.id

      const designated = await bench([
        '--project', target, 'shape', 'designate', 'visit.v1', '--time-field', ' date ', '--json',
      ])
      expect(designated.code).toBe(0)
      const declaration = JSON.parse(designated.stdout) as {
        data: { from: string; shape: { id: string; time_field?: string }; time_field: string }
      }
      expect(declaration.data.from).toBe('visit.v1')
      expect(declaration.data.shape.id).toBe('visit.v2')
      expect(declaration.data.shape.time_field).toBe('date')
      expect(declaration.data.time_field).toBe('date')

      // A matching add writes one instant twice: the field is canonicalised in `values`, and
      // `t_observed` is that same canonical text. An offset is accepted, not copied through.
      const matching = await bench([
        '--project', target, 'add', '--values', '{"date":"2026-10-01T12:34:56+02:00","value":5}', '--json',
      ])
      expect(matching.code).toBe(0)
      const recorded = JSON.parse(matching.stdout) as {
        data: { id: string; values: Record<string, unknown>; t_observed: string }
      }
      expect(recorded.data.values.date).toBe('2026-10-01T10:34:56.000Z')
      expect(recorded.data.t_observed).toBe('2026-10-01T10:34:56.000Z')

      const logBefore = await readFile(join(target, 'data', 'events.jsonl'), 'utf8')
      const contradiction = await bench([
        '--project', target, 'add', '--values', '{"date":"2026-10-02T00:00:00Z","value":6}',
        '--at', '2026-10-03T00:00:00Z',
      ])
      expect(contradiction.code).toBe(1)
      expect(contradiction.stderr).toContain('field "date" says 2026-10-02T00:00:00.000Z')
      expect(contradiction.stderr).toContain('--at says 2026-10-03T00:00:00.000Z')
      expect(await readFile(join(target, 'data', 'events.jsonl'), 'utf8')).toBe(logBefore)

      const unparseable = await bench([
        '--project', target, 'add', '--values', '{"date":"yesterday","value":7}',
      ])
      expect(unparseable.code).toBe(1)
      expect(unparseable.stderr).toContain('not a parseable instant')

      // A correction to the time field moves the instant with it, in the same event.
      const corrected = await bench([
        '--project', target, 'correct', recorded.data.id, '--values', '{"date":"2026-11-01T00:00:00Z"}', '--json',
      ])
      expect(corrected.code).toBe(0)
      const correction = JSON.parse(corrected.stdout) as {
        data: { t_observed?: string; now: Record<string, unknown> }
      }
      expect(correction.data.t_observed).toBe('2026-11-01T00:00:00.000Z')
      expect(correction.data.now.date).toBe('2026-11-01T00:00:00.000Z')

      // Both points are still in version 1, so the list shows the pre-designation point unchanged and
      // the corrected one carrying its new instant.
      const listed = await bench(['--project', target, 'list', '--json'])
      const points = (JSON.parse(listed.stdout) as {
        data: { id: string; values: Record<string, unknown>; t_observed: string }[]
      }).data
      expect(points.find((point) => point.id === priorId)?.t_observed).toBe('2026-09-02T00:00:00.000Z')
      expect(points.find((point) => point.id === recorded.data.id)?.t_observed).toBe('2026-11-01T00:00:00.000Z')

      // Import derives the time from the mapped field, not from a header guess, and refuses a second
      // time column that tells a different story.
      const disagreeing = join(root, 'disagreeing.csv')
      await writeFile(
        disagreeing,
        'when,date,value\n2026-12-01T00:00:00Z,2026-12-02T00:00:00Z,9\n',
        'utf8',
      )
      const refusedImport = await bench([
        '--project', target, 'import', disagreeing, '--time', 'when',
      ])
      expect(refusedImport.code).toBe(1)
      expect(refusedImport.stderr).toContain('field "date" says 2026-12-02T00:00:00.000Z')
      expect(refusedImport.stderr).toContain('time column "when" says 2026-12-01T00:00:00.000Z')

      const agreeing = join(root, 'agreeing.csv')
      await writeFile(
        agreeing,
        'when,date,value\n2026-12-03T00:00:00Z,2026-12-03T00:00:00Z,9\n',
        'utf8',
      )
      const imported = await bench([
        '--project', target, 'import', agreeing, '--time', 'when', '--json',
      ])
      expect(imported.code).toBe(0)
      expect(imported.stderr).toBe('')

      const afterImport = await bench(['--project', target, 'list', '--json'])
      const importedPoints = (JSON.parse(afterImport.stdout) as {
        data: { values: Record<string, unknown>; t_observed: string }[]
      }).data
      const importedPoint = importedPoints.find((point) => point.values.value === 9)!
      expect(importedPoint.values.date).toBe('2026-12-03T00:00:00.000Z')
      expect(importedPoint.t_observed).toBe('2026-12-03T00:00:00.000Z')

      const checked = await bench(['--project', target, 'check'])
      expect(checked.code).toBe(0)
      expect(checked.stdout).toContain('0 error(s)')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('runs a whole session: init, add, correct, retract, list, check, state, chart', { timeout: CLI_TIMEOUT }, async () => {
    const init = await bench(['init', project, '--name', 'cli-smoke'])
    expect(init.code).toBe(0)
    expect(init.stdout).toContain('created project')

    const first = await bench(['--project', project, 'add', '--x', '1', '--y', '2.5', '--at', '2026-10-01T09:00:00Z', '--json'])
    expect(first.code).toBe(0)
    const created = JSON.parse(first.stdout) as {
      ok: boolean
      data: { id: string; t_observed: string; version: number }
    }
    expect(created.ok).toBe(true)
    // Timestamps are normalised on write, so ordering by string and by instant agree.
    expect(created.data.t_observed).toBe('2026-10-01T09:00:00.000Z')
    // The point belongs to the dataset's one version, and the JSON says so rather than making a
    // caller read the log to find out.
    expect(created.data.version).toBe(1)

    expect((await bench(['--project', project, 'add', '--x', '2', '--y', '4.6'])).code).toBe(0)

    const corrected = await bench(['--project', project, 'correct', created.data.id, '--values', '{"y":2.9}', '--reason', 'typo'])
    expect(corrected.code).toBe(0)
    expect(corrected.stdout).toContain('original record preserved')

    const listed = await bench(['--project', project, 'list', '--json'])
    const points = JSON.parse(listed.stdout) as { data: { values: { y: number }; corrections: number }[] }
    expect(points.data).toHaveLength(2)
    expect(points.data.find((point) => point.corrections === 1)?.values.y).toBe(2.9)

    // Remove and bring back through the CLI, so the two doors record the same event and the same
    // record comes back: the window's undo is this call, not a second implementation of it.
    const retracted = await bench(['--project', project, 'retract', created.data.id, '--reason', 'typo'])
    expect(retracted.code).toBe(0)
    expect(retracted.stdout).toContain('1 active')

    const restored = await bench(['--project', project, 'restore', created.data.id, '--json'])
    expect(restored.code).toBe(0)
    const back = JSON.parse(restored.stdout) as {
      ok: boolean
      data: { restored: string; reverses: string; active: number }
    }
    expect(back.ok).toBe(true)
    expect(back.data.restored).toBe(created.data.id)
    expect(back.data.active).toBe(2)
    expect((await bench(['--project', project, 'list', '--json'])).stdout).toContain(created.data.id)

    // A second undo would record an act that changed nothing.
    const twice = await bench(['--project', project, 'restore', created.data.id])
    expect(twice.code).toBe(1)
    expect(twice.stderr).toContain('is not retracted')

    const checked = await bench(['--project', project, 'check'])
    expect(checked.code).toBe(0)
    expect(checked.stdout).toContain('0 error(s)')

    const state = await bench(['--project', project, 'state'])
    expect(state.code).toBe(0)
    expect(state.stdout).toContain('cli-smoke')

    const chart = await bench(['--project', project, 'chart'])
    expect(chart.code).toBe(0)
    expect(existsSync(join(project, 'artifacts', 'main.svg'))).toBe(true)
  })

  it('records the launcher that created the project, so the next session does not have to find it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bench-agents-'))
    try {
      const init = await bench(['init', dir, '--name', 'agents'])
      expect(init.code).toBe(0)
      // The hint is the first command a session is told to run; it has to be one that runs here,
      // where `bench` is not on PATH any more than it is for a packaged user.
      const hint = init.stdout.split('\n').find((line) => line.trimStart().startsWith('next:'))
      expect(hint).toContain('--project')
      expect(hint).not.toMatch(/next: bench\b/)
      const agents = await readFile(join(dir, 'AGENTS.md'), 'utf8')
      // A placeholder is the old failure: the file named a folder that could not be located.
      expect(agents).not.toContain('C:\\path\\to')
      const recorded = agents.match(/^ {4}(.+?) --project "(.+?)" state$/m)
      expect(recorded).not.toBeNull()
      const [, command, projectDir] = recorded!
      // Forward slashes, so the recorded line is runnable from a POSIX shell as well as cmd.
      expect(projectDir).toBe(dir.replaceAll('\\', '/'))
      // This run is the checkout's script, so the checkout is what it records — a real folder with the
      // package.json that defines that script, not a guess at where the app might be.
      expect(command).toBe(`pnpm -C "${process.cwd().replaceAll('\\', '/')}" bench`)
      expect(existsSync(join(process.cwd(), 'package.json'))).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('heals a launcher line written by an older build, and after the folder moves', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bench-heal-'))
    const moved = `${dir}-moved`
    try {
      expect((await bench(['init', dir, '--name', 'heal'])).code).toBe(0)
      // Exactly the placeholder the previous generator wrote.
      await writeFile(
        join(dir, 'AGENTS.md'),
        '# AGENTS.md\n\n## Running bench\n\n' +
          '    C:\\path\\to\\bench-win32-x64\\bench.cmd --project C:\\path\\to\\this\\project state\n',
      )
      const healedState = await bench(['--project', dir, 'state'])
      expect(healedState.code).toBe(0)
      const healed = await readFile(join(dir, 'AGENTS.md'), 'utf8')
      expect(healed).not.toContain('C:\\path\\to')
      const launcher = `pnpm -C "${process.cwd().replaceAll('\\', '/')}" bench`
      expect(healed).toContain(`${launcher} --project "${dir.replaceAll('\\', '/')}" state`)
      expect(healed).toContain('has moved')

      // The recorded path was resolved when it was written, so a rename has to be healed the same
      // way — and running `state` against the folder is exactly the recovery the file describes.
      await rename(dir, moved)
      // The stale line itself must still be refused, but now it says which path it tried and what to
      // do next, instead of leaving the session to guess that the folder moved.
      const stale = await bench(['--project', dir, 'state'])
      expect(stale.code).toBe(2)
      expect(stale.stderr).toContain('not inside a bench project')
      expect(stale.stderr).toContain(dir)
      expect(stale.stderr).toContain("folder's current path")
      expect(stale.stderr).toContain('AGENTS.md')
      expect((await bench(['--project', moved, 'state'])).code).toBe(0)
      const afterMove = await readFile(join(moved, 'AGENTS.md'), 'utf8')
      expect(afterMove).toContain(`${launcher} --project "${moved.replaceAll('\\', '/')}" state`)
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(moved, { recursive: true, force: true })
    }
  })

  it('finds the project from a nested working directory', async () => {
    const nested = join(project, 'data', 'raw')
    const result = await bench(['list'], nested)
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('2 active point(s)')
  })

  it('rejects a mistyped field with a warning, and still records it', async () => {
    const result = await bench([
      '--project', project, 'add',
      '--values', '{"x":3,"y":6.2,"temprature":21}',
      '--json',
    ])
    expect(result.code).toBe(0)

    const checked = await bench(['--project', project, 'check'])
    expect(checked.code).toBe(0)
    expect(checked.stdout).toContain('unknown field "temprature"')
  })

  it('exits non-zero with an actionable message on bad input', async () => {
    const missing = await bench(['--project', project, 'add', '--y', '1'])
    expect(missing.code).toBe(1)
    expect(missing.stderr).toContain('missing required field "x"')

    const notANumber = await bench(['--project', project, 'add', '--x', 'abc', '--y', '1'])
    expect(notANumber.code).toBe(1)
    expect(notANumber.stderr).toContain('must be a number')

    const unknownCommand = await bench(['--project', project, 'frobnicate'])
    expect(unknownCommand.code).toBe(1)
    expect(unknownCommand.stderr).toContain('unknown command')

    const unknownOption = await bench(['--project', project, 'list', '--nope'])
    expect(unknownOption.code).toBe(1)

    const noProject = await bench(['list'], tmpdir())
    expect(noProject.code).toBe(2)
    expect(noProject.stderr).toContain('not inside a bench project')
  })

  it('refuses a dataset that does not exist instead of answering about a different one', async () => {
    const ghost = await bench(['--project', project, 'list', '--dataset', 'ghost'])
    expect(ghost.code).toBe(2)
    expect(ghost.stderr).toContain('no dataset "ghost"')

    const add = await bench(['--project', project, 'add', '--x', '1', '--y', '2', '--dataset', 'ghost'])
    expect(add.code).toBe(2)
  })

  it('keeps the log append-only across a correction', async () => {
    const before = await readFile(join(project, 'data', 'events.jsonl'), 'utf8')
    await bench(['--project', project, 'add', '--x', '4', '--y', '9.1'])
    const after = await readFile(join(project, 'data', 'events.jsonl'), 'utf8')
    expect(after.startsWith(before)).toBe(true)
  })
})

describe('bench import, as executed', () => {
  const csv =
    'timestamp,temp_c,volts\n' +
    '2026-01-05T09:00:00Z,21.4,3.301\n' +
    '2026-01-05T09:01:00Z,21.9,3.355\n' +
    '2026-01-05T09:02:00Z,22.3,3.402\n'

  async function withProject(name: string, body: (dir: string) => Promise<void>) {
    const target = await mkdtemp(join(tmpdir(), `bench-${name}-`))
    try {
      await bench(['init', target, '--name', name])
      await body(target)
    } finally {
      await rm(target, { recursive: true, force: true })
    }
  }

  it('imports rows, maps columns, preserves the original, and records the import', async () => {
    await withProject('import', async (dir) => {
      await writeFile(join(dir, 'readings.csv'), csv, 'utf8')
      const result = await bench([
        '--project', dir, 'import', 'readings.csv',
        '--map', 'x=temp_c', '--map', 'y=volts', '--time', 'timestamp',
        '--json',
      ])
      expect(result.code).toBe(0)
      const payload = JSON.parse(result.stdout) as {
        data: {
          rows: number
          preserved: string
          timeColumn: string | null
          sourceHash: string
          version: number
          parent: number | null
          ignoredColumns?: string[]
        }
      }
      expect(payload.data.rows).toBe(3)
      // Nothing was ignored, so the success payload keeps its pre-existing shape.
      expect(payload.data.ignoredColumns).toBeUndefined()
      expect(payload.data.timeColumn).toBe('timestamp')
      // An empty dataset's first import is version 1: nothing was replaced, so nothing is diffed.
      expect(payload.data.version).toBe(1)
      expect(payload.data.parent).toBeNull()
      // The observation time came from the file, so it is the one that was imported.
      expect(payload.data.preserved).toMatch(/^data\/raw\/.+-readings\.csv$/)
      expect(existsSync(join(dir, payload.data.preserved))).toBe(true)
      // The original is byte-identical to what was handed over: evidence is not edited.
      expect(await readFile(join(dir, payload.data.preserved), 'utf8')).toBe(csv)

      const listed = await bench(['--project', dir, 'list', '--json'])
      const points = JSON.parse(listed.stdout) as {
        data: { values: { x: number }; t_observed: string; tags: string[] }[]
      }
      expect(points.data).toHaveLength(3)
      expect(points.data.map((point) => point.values.x)).toEqual([21.4, 21.9, 22.3])
      // The observation time came from the file, not from the moment of import.
      expect(points.data[0]!.t_observed).toBe('2026-01-05T09:00:00.000Z')
      expect(points.data[0]!.tags).toContain('import')

      expect((await bench(['--project', dir, 'check'])).stdout).toContain('0 error(s)')

      // `dataset list` and `dataset versions` answer where the data stands and where it came from.
      const datasets = await bench(['--project', dir, 'dataset', 'list', '--json'])
      const listedDatasets = (JSON.parse(datasets.stdout) as {
        data: { id: string; version: number; active: number; versions: number[] }[]
      }).data
      expect(listedDatasets).toHaveLength(1)
      expect(listedDatasets[0]).toMatchObject({ id: 'main', version: 1, active: 3, versions: [1] })

      const versions = await bench(['--project', dir, 'dataset', 'versions', 'main'])
      expect(versions.stdout).toContain('main · 1 version(s) · newest v1')
      expect(versions.stdout).toContain('v1  3 row(s) now · 3 at creation  first version')
      expect(versions.stdout).toContain(payload.data.preserved)
      // One version has nothing to compare against, and that is a refusal, not an empty diff.
      const noDiff = await bench(['--project', dir, 'dataset', 'diff', 'main', '1', '2'])
      expect(noDiff.code).toBe(2)
      expect(noDiff.stderr).toContain('has no version 2')
    })
  })

  it('refuses a file with a bad row and imports none of it', async () => {
    await withProject('import-bad', async (dir) => {
      await writeFile(
        join(dir, 'ragged.csv'),
        'timestamp,temp_c,volts\n2026-01-05T09:00:00Z,21.4,3.301\nnot-a-time,21.9,3.355\n',
        'utf8',
      )
      const before = await readFile(join(dir, 'data', 'events.jsonl'), 'utf8')
      const result = await bench([
        '--project', dir, 'import', 'ragged.csv', '--map', 'x=temp_c', '--map', 'y=volts', '--time', 'timestamp',
      ])
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('1 row(s) would not import')
      // Named by the line a person would see in their editor, not by array index.
      expect(result.stderr).toContain('row 3')

      // Nothing landed: a partial import is a worse outcome than a refusal.
      expect(await readFile(join(dir, 'data', 'events.jsonl'), 'utf8')).toBe(before)
      const listed = await bench(['--project', dir, 'list', '--json'])
      expect((JSON.parse(listed.stdout) as { data: unknown[] }).data).toHaveLength(0)
    })
  })

  it('refuses to import the same contents twice, unless forced', async () => {
    await withProject('import-dup', async (dir) => {
      await writeFile(join(dir, 'readings.csv'), csv, 'utf8')
      const args = ['--project', dir, 'import', 'readings.csv', '--map', 'x=temp_c', '--map', 'y=volts']
      expect((await bench(args)).code).toBe(0)

      const again = await bench(args)
      expect(again.code).toBe(1)
      expect(again.stderr).toContain('already imported')

      // Forced, it is still a replace: the same rows land in a new version, and no row is appended
      // a second time. Re-importing by hand must not be able to double a dataset by accident.
      const forced = await bench([...args, '--force'])
      expect(forced.code).toBe(0)
      expect(forced.stdout).toContain('as version 2')
      expect(forced.stdout).toContain('+0 −0 ~0')
      const listed = await bench(['--project', dir, 'list', '--json'])
      expect((JSON.parse(listed.stdout) as { data: unknown[] }).data).toHaveLength(3)
      // The parent is still there, and still has its rows.
      const versions = await bench(['--project', dir, 'dataset', 'versions', 'main', '--json'])
      const data = (JSON.parse(versions.stdout) as { data: { versions: { version: number; rowsNow: number }[] } }).data
      expect(data.versions.map((record) => record.version)).toEqual([1, 2])
      expect(data.versions[0]!.rowsNow).toBe(3)
    })
  })

  it('changes nothing on a dry run', async () => {
    await withProject('import-dry', async (dir) => {
      await writeFile(join(dir, 'readings.csv'), csv, 'utf8')
      const before = await readFile(join(dir, 'data', 'events.jsonl'), 'utf8')
      const result = await bench([
        '--project', dir, 'import', 'readings.csv', '--map', 'x=temp_c', '--map', 'y=volts', '--dry-run',
      ])
      expect(result.code).toBe(0)
      expect(result.stdout).toContain('nothing was written')
      expect(await readFile(join(dir, 'data', 'events.jsonl'), 'utf8')).toBe(before)
      // data/raw exists from init; a dry run must not put anything in it.
      expect(await readdir(join(dir, 'data', 'raw'))).toEqual([])
    })
  })

  it('refuses an undeclared column unless it is explicitly ignored, and reports the choice', async () => {
    await withProject('import-extra', async (dir) => {
      await writeFile(
        join(dir, 'extra.csv'),
        'timestamp,x,y,extra\n2026-01-05T09:00:00Z,1,2,9\n2026-01-05T09:01:00Z,3,4,10\n',
        'utf8',
      )
      const before = await readFile(join(dir, 'data', 'events.jsonl'), 'utf8')
      const args = ['--project', dir, 'import', 'extra.csv', '--map', 'x=x', '--map', 'y=y']

      const refused = await bench([...args, '--json'])
      expect(refused.code).toBe(1)
      expect(refused.stderr).toContain('1 column has no shape field: extra')
      expect(refused.stderr).toContain('--ignore-unmapped extra')
      // A refusal writes nothing, not even the preserved original.
      expect(await readFile(join(dir, 'data', 'events.jsonl'), 'utf8')).toBe(before)
      expect(await readdir(join(dir, 'data', 'raw'))).toEqual([])

      const ignored = await bench([...args, '--ignore-unmapped', 'extra', '--json'])
      expect(ignored.code).toBe(0)
      const payload = JSON.parse(ignored.stdout) as {
        data: { ignoredColumns: string[]; mapping: Record<string, string>; rows: number }
      }
      expect(payload.data).toMatchObject({ ignoredColumns: ['extra'], rows: 2, mapping: { x: 'x', y: 'y' } })

      const listed = await bench(['--project', dir, 'list', '--json'])
      const points = (JSON.parse(listed.stdout) as { data: { values: Record<string, number> }[] }).data
      expect(points.map((point) => point.values)).toEqual([
        { x: 1, y: 2 },
        { x: 3, y: 4 },
      ])
      const record = (await readFile(join(dir, 'data', 'events.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((event) => event.type === 'import_completed')
      expect(record).toMatchObject({ ignored_columns: ['extra'] })
    })
  })

  it('reads tsv and jsonl as well as csv, and diffs the second file against the first', async () => {
    await withProject('import-formats', async (dir) => {
      // Both files carry the observation time, which is what makes a row comparable across them.
      await writeFile(
        join(dir, 't.tsv'),
        't\ttemp_c\tvolts\n2026-01-01T00:00:00Z\t1\t2\n2026-01-01T00:01:00Z\t3\t4\n',
        'utf8',
      )
      expect((await bench(['--project', dir, 'import', 't.tsv', '--map', 'x=temp_c', '--map', 'y=volts'])).code).toBe(0)

      await writeFile(
        join(dir, 'j.jsonl'),
        '{"t": "2026-01-01T00:01:00Z", "temp_c": 3, "volts": 9}\n' +
          '{"t": "2026-01-01T00:02:00Z", "temp_c": 5, "volts": 6}\n',
        'utf8',
      )
      const jsonl = await bench(['--project', dir, 'import', 'j.jsonl', '--map', 'x=temp_c', '--map', 'y=volts', '--json'])
      expect(jsonl.code).toBe(0)
      const imported = (JSON.parse(jsonl.stdout) as { data: { rows: number; version: number; parent: number; diff: unknown } }).data
      expect(imported.rows).toBe(2)
      expect(imported.version).toBe(2)
      expect(imported.parent).toBe(1)
      // One row changed value, one arrived, one left: the file is the dataset now, not an addition.
      expect(imported.diff).toEqual({ added: 1, removed: 1, changed: 1 })

      const listed = await bench(['--project', dir, 'list', '--json'])
      expect((JSON.parse(listed.stdout) as { data: unknown[] }).data).toHaveLength(2)
      expect((await bench(['--project', dir, 'check'])).stdout).toContain('0 error(s)')
    })
  })

  it('re-imports a corrected export as a new version, leaving the parent readable', async () => {
    await withProject('import-version', async (dir) => {
      await writeFile(join(dir, 'readings.csv'), csv, 'utf8')
      const map = ['--map', 'x=temp_c', '--map', 'y=volts', '--time', 'timestamp']
      expect((await bench(['--project', dir, 'import', 'readings.csv', ...map])).code).toBe(0)

      // The instrument re-exported: one reading corrected, one row added, one row gone.
      await writeFile(
        join(dir, 'readings-v2.csv'),
        'timestamp,temp_c,volts\n' +
          '2026-01-05T09:00:00Z,21.4,3.301\n' +
          '2026-01-05T09:01:00Z,21.9,3.9\n' +
          '2026-01-05T09:03:00Z,22.9,3.44\n',
        'utf8',
      )
      const second = await bench(['--project', dir, 'import', 'readings-v2.csv', ...map])
      expect(second.code).toBe(0)
      expect(second.stdout).toContain('imported 3 row(s) into main as version 2')
      expect(second.stdout).toContain('replaces version 1 · +1 −1 ~1')
      expect(second.stdout).toContain('changed 1:')
      expect(second.stdout).toContain('y 3.355  →  x 21.9  y 3.9')
      expect(second.stdout).toContain('removed 1:')
      expect(second.stdout).toContain('version 1 is untouched: still 3 row(s)')

      // The dataset now holds the file's three rows, not five.
      const listed = await bench(['--project', dir, 'list', '--json'])
      const points = (JSON.parse(listed.stdout) as { data: { values: { x: number; y: number } }[] }).data
      expect(points).toHaveLength(3)
      expect(points.map((point) => point.values.y)).toEqual([3.301, 3.9, 3.44])

      const versions = await bench(['--project', dir, 'dataset', 'versions', 'main'])
      expect(versions.stdout).toContain('main · 2 version(s) · newest v2')
      expect(versions.stdout).toContain('v1  3 row(s) now · 3 at creation  first version')
      expect(versions.stdout).toContain('v2  3 row(s) now · 3 at creation  +1 −1 ~1')

      const diff = await bench(['--project', dir, 'dataset', 'diff', 'main', '1', '2'])
      expect(diff.code).toBe(0)
      expect(diff.stdout).toContain('main: version 1 → 2  +1 −1 ~1  (3 row(s) in v2)')
      // The parent's value is named as it was, which is only possible if version 1 kept it.
      expect(diff.stdout).toContain('y 3.355  →  x 21.9  y 3.9')
      expect(diff.stdout).toContain('added 1:')
      expect(diff.stdout).toContain('removed 1:')
      // The default comparison is the newest version against the one before it.
      const implicit = await bench(['--project', dir, 'dataset', 'diff', 'main'])
      expect(implicit.stdout).toContain('version 1 → 2')

      // A file whose rows are already there changes nothing, and saying so beats a silent no-op.
      const third = await bench(['--project', dir, 'import', 'readings-v2.csv', ...map, '--force'])
      expect(third.code).toBe(0)
      expect(third.stdout).toContain('as version 3')
      expect(third.stdout).toContain('+0 −0 ~0')
      expect((await bench(['--project', dir, 'check'])).stdout).toContain('0 error(s)')
    })
  })

  it('restores an older version as a new one, across both doors', async () => {
    await withProject('import-restore', async (dir) => {
      await writeFile(join(dir, 'readings.csv'), csv, 'utf8')
      const map = ['--map', 'x=temp_c', '--map', 'y=volts', '--time', 'timestamp']
      expect((await bench(['--project', dir, 'import', 'readings.csv', ...map])).code).toBe(0)
      // Replace it with a corrected export: one row changed, one added, one gone.
      await writeFile(
        join(dir, 'readings-v2.csv'),
        'timestamp,temp_c,volts\n' +
          '2026-01-05T09:00:00Z,21.4,3.301\n' +
          '2026-01-05T09:01:00Z,21.9,3.9\n' +
          '2026-01-05T09:03:00Z,22.9,3.44\n',
        'utf8',
      )
      expect((await bench(['--project', dir, 'import', 'readings-v2.csv', ...map])).code).toBe(0)

      const restored = await bench(['--project', dir, 'dataset', 'restore', 'main', '1'])
      expect(restored.code).toBe(0)
      expect(restored.stdout).toContain('restored version 1 as version 3')
      expect(restored.stdout).toContain('+1 −1 ~1')
      expect(restored.stdout).toContain('(3 row(s); replaced version 2)')

      // The chain is intact: version 2 still holds what the second file said, and version 3 is a
      // new version that happens to hold version 1's rows.
      const versions = await bench(['--project', dir, 'dataset', 'versions', 'main'])
      expect(versions.stdout).toContain('newest v3')
      expect(versions.stdout).toContain('v3  3 row(s) now · 3 at creation  +1 −1 ~1')
      expect(versions.stdout).toContain('restored from version 1')
      expect(versions.stdout).toContain('v1  3 row(s) now · 3 at creation  first version')

      const listed = await bench(['--project', dir, 'list', '--json'])
      const points = (JSON.parse(listed.stdout) as { data: { values: { y: number } }[] }).data
      expect(points.map((point) => point.values.y)).toEqual([3.301, 3.355, 3.402])

      // The CLI's own diff reads the restore against the version it replaced.
      const diff = await bench(['--project', dir, 'dataset', 'diff', 'main', '2', '3'])
      expect(diff.stdout).toContain('main: version 2 → 3  +1 −1 ~1  (3 row(s) in v3)')
      // Read left to right: the newer version's value first, then the older one it was restored to.
      expect(diff.stdout).toContain('x 21.9  y 3.9  →  x 21.9  y 3.355')
      expect((await bench(['--project', dir, 'check'])).stdout).toContain('0 error(s)')

      // Restoring the current version would write nothing; an unknown one cannot be answered.
      const current = await bench(['--project', dir, 'dataset', 'restore', 'main', '3'])
      expect(current.code).toBe(1)
      expect(current.stderr).toContain('not older than the current version 3')
      const unknown = await bench(['--project', dir, 'dataset', 'restore', 'main', '9'])
      expect(unknown.code).toBe(2)
      expect(unknown.stderr).toContain('has no version 9')
    })
  })

  it('restores the empty dataset when the first import is undone', async () => {
    await withProject('import-empty', async (dir) => {
      await writeFile(join(dir, 'readings.csv'), csv, 'utf8')
      const map = ['--map', 'x=temp_c', '--map', 'y=volts', '--time', 'timestamp']
      expect((await bench(['--project', dir, 'import', 'readings.csv', ...map])).code).toBe(0)

      const emptied = await bench(['--project', dir, 'dataset', 'restore', 'main', '--empty'])
      expect(emptied.code).toBe(0)
      expect(emptied.stdout).toContain('restored the empty dataset as version 2')
      expect(emptied.stdout).toContain('+0 −3 ~0')

      expect((await bench(['--project', dir, 'list'])).stdout).toContain('main: 0 active point(s)')
      const versions = await bench(['--project', dir, 'dataset', 'versions', 'main'])
      // The first version is not deleted: it is where those three rows still live.
      expect(versions.stdout).toContain('v1  3 row(s) now · 3 at creation  first version')
      expect(versions.stdout).toContain('v2  0 row(s) now · 0 at creation  +0 −3 ~0')
      expect(versions.stdout).toContain('restored from the empty dataset before version 1')
      expect((await bench(['--project', dir, 'check'])).stdout).toContain('0 error(s)')

      // Redo is the same door: version 1 becomes current again, as version 3.
      const again = await bench(['--project', dir, 'dataset', 'restore', 'main', '1'])
      expect(again.code).toBe(0)
      expect(again.stdout).toContain('restored version 1 as version 3')
      expect((await bench(['--project', dir, 'list'])).stdout).toContain('main: 3 active point(s)')
    })
  })

  it('says which column is missing rather than guessing at one', async () => {
    await withProject('import-map', async (dir) => {
      await writeFile(join(dir, 'odd.csv'), 'degC,volts\n21.4,3.301\n', 'utf8')
      const result = await bench(['--project', dir, 'import', 'odd.csv'])
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('no column for the required field "x"')
      expect(result.stderr).toContain('--map x=<column>')
    })
  })

  it('refuses a file with no observation time instead of inventing one', async () => {
    await withProject('import-untimed', async (dir) => {
      await writeFile(join(dir, 'readings.csv'), csv, 'utf8')
      const map = ['--map', 'x=temp_c', '--map', 'y=volts', '--time', 'timestamp']
      expect((await bench(['--project', dir, 'import', 'readings.csv', ...map])).code).toBe(0)

      // The same rows, re-exported without their clock. Stamping these with the moment of import
      // would retract every parent row and add every replacement in the same breath.
      await writeFile(
        join(dir, 'untimed.csv'),
        'temp_c,volts\n21.4,3.301\n21.9,3.355\n22.3,3.402\n',
        'utf8',
      )
      const before = await readFile(join(dir, 'data', 'events.jsonl'), 'utf8')
      const refused = await bench([
        '--project', dir, 'import', 'untimed.csv', '--map', 'x=temp_c', '--map', 'y=volts',
      ])
      expect(refused.code).toBe(1)
      expect(refused.stderr).toContain('no column holds the observation time')
      // It names the columns that could have been meant, so the refusal is actionable.
      expect(refused.stderr).toContain('temp_c, volts')
      // Nothing landed, and no version was created from the refusal.
      expect(await readFile(join(dir, 'data', 'events.jsonl'), 'utf8')).toBe(before)
      const versions = await bench(['--project', dir, 'dataset', 'versions', 'main'])
      expect(versions.stdout).toContain('1 version(s) · newest v1')
    })
  })

  it('imports an untimed file as a labelled estimate when told, and a measured time replaces it', async () => {
    await withProject('import-estimate', async (dir) => {
      await writeFile(
        join(dir, 'readings.csv'),
        'temp_c,volts\n21.4,3.301\n21.9,3.355\n',
        'utf8',
      )
      const map = ['--map', 'x=temp_c', '--map', 'y=volts']
      const before = await readFile(join(dir, 'data', 'events.jsonl'), 'utf8')

      // The plan says where the times come from before anything is written, and the refusal is gone
      // only because the row order was named out loud.
      const planned = await bench(['--project', dir, 'import', 'readings.csv', ...map, '--estimate-time', '--dry-run'])
      expect(planned.code).toBe(0)
      expect(planned.stdout).toContain("t_observed estimated from the file's row order")
      expect(planned.stdout).toContain('2 row(s)')
      expect(planned.stdout).toContain('2 row(s), their times are an estimate, correctable')
      expect(await readFile(join(dir, 'data', 'events.jsonl'), 'utf8')).toBe(before)

      const written = await bench(['--project', dir, 'import', 'readings.csv', ...map, '--estimate-time', '--json'])
      expect(written.code).toBe(0)
      expect(JSON.parse(written.stdout).data).toMatchObject({
        timeColumn: null,
        estimated: true,
        version: 1,
      })

      // Every row says so, in the text a person reads and in the JSON an agent reads.
      const listed = await bench(['--project', dir, 'list', '--json'])
      const rows = (JSON.parse(listed.stdout) as { data: { id: string; t_observed: string; t_estimated?: true }[] })
        .data
      expect(rows.map((point) => point.t_estimated)).toEqual([true, true])
      expect((await bench(['--project', dir, 'list'])).stdout).toContain('(estimated)')

      // Replacing the estimate is a correction that carries a time and no values.
      const replaced = await bench([
        '--project', dir, 'correct', rows[0]!.id, '--at', '2026-02-01T09:00:00Z', '--json',
      ])
      expect(replaced.code).toBe(0)
      expect(JSON.parse(replaced.stdout).data).toMatchObject({ t_observed: '2026-02-01T09:00:00.000Z' })
      expect(JSON.parse(replaced.stdout).data.t_estimated).toBeUndefined()

      const after = (JSON.parse((await bench(['--project', dir, 'list', '--json'])).stdout) as {
        data: { t_observed: string; t_estimated?: true }[]
      }).data
      expect(after[0]).toMatchObject({ t_observed: '2026-02-01T09:00:00.000Z' })
      expect(after[0]!.t_estimated).toBeUndefined()
      expect(after[1]!.t_estimated).toBe(true)
      // One row is measured now and one is not, and the text list says which is which.
      const text = (await bench(['--project', dir, 'list'])).stdout
      expect(text.split('\n').filter((line) => /estimated/.test(line))).toHaveLength(1)

      // The estimate is the log's, so it survives a fresh read by a reader that wrote nothing.
      await bench(['--project', dir, 'state'])
      expect(await readFile(join(dir, 'data', 'events.jsonl'), 'utf8')).toContain('t_estimated')
      expect(await readFile(join(dir, 'STATE.md'), 'utf8')).toContain(
        '1 of 2 active point(s) have an estimated time',
      )

      // A re-export that changes both rows: one was measured above and one is still an estimate, and
      // the diff has to say which is which — a version diff is where a person compares two times.
      await writeFile(
        join(dir, 'readings-v2.csv'),
        'temp_c,volts\n21.4,4.4\n21.9,5.5\n',
        'utf8',
      )
      const second = await bench([
        '--project', dir, 'import', 'readings-v2.csv', ...map, '--estimate-time', '--json',
      ])
      expect(second.code).toBe(0)
      const diffText = await bench(['--project', dir, 'dataset', 'diff', 'main', '1', '2'])
      expect(diffText.code).toBe(0)
      const marked = diffText.stdout.split('\n').filter((line) => /\(estimated\)/.test(line))
      expect(marked).toHaveLength(1)
      expect(marked[0]).toContain('x 21.9')
      expect(diffText.stdout).toContain('2026-02-01T09:00:00.000Z  x 21.4')
      const diffJson = JSON.parse(
        (await bench(['--project', dir, 'dataset', 'diff', 'main', '1', '2', '--json'])).stdout,
      ) as { data: { changed: { t: string; t_estimated?: true }[] } }
      expect(diffJson.data.changed).toHaveLength(2)
      expect(diffJson.data.changed.find((row) => row.t === '2026-02-01T09:00:00.000Z')!.t_estimated).toBeUndefined()
      expect(diffJson.data.changed.find((row) => row.t !== '2026-02-01T09:00:00.000Z')!.t_estimated).toBe(true)
    })
  })

  it('reads a time column that is not named like one when told, and diffs the next file against it', async () => {
    await withProject('import-named-time', async (dir) => {
      await writeFile(
        join(dir, 'run.csv'),
        'taken_at,temp_c,volts\n2026-02-01T09:00:00Z,1,2\n2026-02-01T09:01:00Z,2,4\n',
        'utf8',
      )
      const map = ['--map', 'x=temp_c', '--map', 'y=volts', '--time', 'taken_at']
      const first = await bench(['--project', dir, 'import', 'run.csv', ...map, '--json'])
      expect(first.code).toBe(0)
      const planned = JSON.parse(first.stdout) as { data: { timeColumn: string; version: number } }
      expect(planned.data).toMatchObject({ timeColumn: 'taken_at', version: 1 })

      // The instant is the file's, not the moment of import: that is what makes the next diff work.
      const listed = await bench(['--project', dir, 'list', '--json'])
      const points = (JSON.parse(listed.stdout) as { data: { t_observed: string }[] }).data
      expect(points[0]!.t_observed).toBe('2026-02-01T09:00:00.000Z')

      await writeFile(
        join(dir, 'run-v2.csv'),
        'taken_at,temp_c,volts\n' +
          '2026-02-01T09:00:00Z,1,2\n' +
          '2026-02-01T09:01:00Z,2,9\n' +
          '2026-02-01T09:02:00Z,3,6\n',
        'utf8',
      )
      const second = await bench(['--project', dir, 'import', 'run-v2.csv', ...map])
      expect(second.code).toBe(0)
      expect(second.stdout).toContain('as version 2')
      expect(second.stdout).toContain('replaces version 1 · +1 −0 ~1')

      const diff = await bench(['--project', dir, 'dataset', 'diff', 'main', '1', '2'])
      expect(diff.stdout).toContain('main: version 1 → 2  +1 −0 ~1')
      expect(diff.stdout).toContain('x 2  y 4  →  x 2  y 9')

      // A typed point joins the newest version, and `--json` names that version.
      const added = await bench([
        '--project', dir, 'add', '--x', '4', '--y', '8', '--at', '2026-02-01T09:03:00Z', '--json',
      ])
      expect(JSON.parse(added.stdout).data.version).toBe(2)
    })
  })
})

// Skipped only when the analysis environment has not been created yet (see tests/run.test.ts for
// why a present-but-broken environment must fail rather than skip).
const analysisReady = existsSync(interpreterCandidates(process.cwd())[0]!)

// These three spawn the Python interpreter, and a cold start on a loaded machine is ~2 s per run —
// three CLI calls plus the recipe sat right at the 5 s default. The budget is for the runtime, not
// for the assertions: they still fail the moment the output is wrong.
const ANALYSIS_TIMEOUT = 20_000

// The same budget for the tests that drive six or more real `bench` processes: each one pays Node's
// start-up, and on a loaded machine the whole test sat right at the 5 s default. Raising the budget
// does not weaken an assertion — every check still runs, and a wrong answer still fails.
const CLI_TIMEOUT = 20_000

describe.skipIf(!analysisReady)('analysis through the CLI', () => {
  it('refuses a fit and draws nothing it cannot justify', { timeout: ANALYSIS_TIMEOUT }, async () => {
    const target = await mkdtemp(join(tmpdir(), 'bench-refusal-'))
    try {
      await bench(['init', target, '--name', 'two-points'])
      await bench(['--project', target, 'add', '--x', '1', '--y', '2.55', '--at', '2026-10-01T09:00:00Z'])
      await bench(['--project', target, 'add', '--x', '2', '--y', '4.62', '--at', '2026-10-01T09:04:00Z'])

      const result = await bench(['--project', target, 'run', 'fit', '--param', 'degree=1', '--json'])
      expect(result.code).toBe(0)
      const payload = JSON.parse(result.stdout) as { data: { verdict: string; artifact: string } }
      expect(payload.data.verdict).toBe('insufficient')
      expect(payload.data.artifact).toBe('artifacts/fit-main.svg')

      const svg = await readFile(join(target, 'artifacts', 'fit-main.svg'), 'utf8')
      expect(svg).not.toContain('stroke-width="2"')
      expect(svg).not.toContain('fill-opacity="0.14"')
      expect(svg).toContain('no curve drawn')
      // The regression that prompted this test: the footer promised a band that was never drawn.
      expect(svg).not.toContain('confidence band')

      const log = await readFile(join(target, 'data', 'events.jsonl'), 'utf8')
      expect(log).toContain('"insufficient"')
      expect(log).toContain('analysis_run')
    } finally {
      await rm(target, { recursive: true, force: true })
    }
  })

  it('marks an analysis stale when the data moves, and a rerun makes it current again', { timeout: ANALYSIS_TIMEOUT }, async () => {
    const target = await mkdtemp(join(tmpdir(), 'bench-runs-'))
    try {
      await bench(['init', target, '--name', 'runs'])
      for (let index = 1; index <= 6; index++) {
        await bench(['--project', target, 'add', '--x', String(index), '--y', String(2.4 * index + 0.3)])
      }
      const first = await bench(['--project', target, 'run', 'fit', '--param', 'degree=1', '--json'])
      expect(first.code).toBe(0)
      const runId = (JSON.parse(first.stdout) as { data: { id: string } }).data.id

      const current = await bench(['--project', target, 'runs', '--json'])
      const before = JSON.parse(current.stdout) as { data: { id: string; params: unknown; freshness: { status: string } }[] }
      expect(before.data[0]!.freshness.status).toBe('fresh')
      // The parameters are recorded with the run, which is what makes a repeat a repeat.
      expect(before.data[0]!.params).toEqual({ degree: 1 })

      await bench(['--project', target, 'add', '--x', '7', '--y', '17.1'])

      const stale = JSON.parse((await bench(['--project', target, 'runs', '--json'])).stdout) as {
        data: { freshness: { status: string; addedSince?: number; reason?: string } }[]
      }
      expect(stale.data[0]!.freshness.status).toBe('stale')
      expect(stale.data[0]!.freshness.addedSince).toBe(1)
      expect(stale.data[0]!.freshness.reason).toContain('added since this run')

      // The cold-start brief must not present a stale result as if it were current.
      expect(await readFile(join(target, 'STATE.md'), 'utf8')).toContain('stale: 1 point(s) added since this run')

      const again = await bench(['--project', target, 'rerun', 'fit', '--json'])
      expect(again.code).toBe(0)
      const repeated = JSON.parse(again.stdout) as { data: { repeated: string; params: unknown } }
      expect(repeated.data.repeated).toBe(runId)
      expect(repeated.data.params).toEqual({ degree: 1 })

      const after = JSON.parse((await bench(['--project', target, 'runs', '--json'])).stdout) as {
        data: { freshness: { status: string } }[]
      }
      // Newest first: the repeat is current, and the run it replaced stays honestly marked stale.
      expect(after.data[0]!.freshness.status).toBe('fresh')
      expect(after.data[1]!.freshness.status).toBe('stale')
    } finally {
      await rm(target, { recursive: true, force: true })
    }
  })

  it('draws a curve with a band when the data supports one, and says so on the artifact', { timeout: ANALYSIS_TIMEOUT }, async () => {
    const target = await mkdtemp(join(tmpdir(), 'bench-supported-'))
    try {
      await bench(['init', target, '--name', 'many-points'])
      for (let index = 1; index <= 8; index++) {
        await bench([
          '--project', target, 'add',
          '--x', String(index),
          '--y', String(2.4 * index + 0.3 + (index % 2 === 0 ? 0.04 : -0.04)),
        ])
      }

      const result = await bench(['--project', target, 'run', 'fit', '--param', 'degree=1', '--json'])
      expect(result.code).toBe(0)
      const payload = JSON.parse(result.stdout) as {
        data: { verdict: string; narrative: string; coefficients: { name: string; estimate: number }[] }
      }
      expect(payload.data.verdict).toBe('supported')
      expect(payload.data.coefficients.find((c) => c.name === 'x')?.estimate).toBeCloseTo(2.4, 2)

      const svg = await readFile(join(target, 'artifacts', 'fit-main.svg'), 'utf8')
      expect(svg).toContain('stroke-width="2"')
      expect(svg).toContain('fill-opacity="0.14"')
      expect(svg).toContain('class="caption"')
      expect(svg).toContain('confidence band')

      // The artifact names what it was drawn from, and every mark names the record behind it, so a
      // reader can hold the picture against the log instead of taking it on trust.
      expect(svg).toContain('data-dataset="main"')
      expect(svg).toContain('data-shape="xy.v1"')
      const marked = [...svg.matchAll(/data-point-id="([^"]+)"/g)].map((match) => match[1]!)
      expect(marked).toHaveLength(8)
      const logged = (await bench(['--project', target, 'list', '--json']))
      const ids = (JSON.parse(logged.stdout) as { data: { id: string }[] }).data.map((point) => point.id)
      for (const id of marked) expect(ids).toContain(id)
    } finally {
      await rm(target, { recursive: true, force: true })
    }
  })
})

describe('projects and views, as executed', () => {
  let dir: string

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bench-tabs-'))
    const init = await bench(['init', dir, '--name', 'tabs demo'])
    expect(init.code).toBe(0)
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('registers the project, lists it, and opens it by name', async () => {
    const listed = await bench(['projects', '--json'])
    expect(listed.code).toBe(0)
    const payload = JSON.parse(listed.stdout) as {
      data: { projects: { name: string; dir: string; registered: boolean; exists: boolean }[] }
    }
    const entry = payload.data.projects.find((project) => project.name === 'tabs demo')
    expect(entry).toBeDefined()
    expect(entry!.registered).toBe(true)
    expect(entry!.exists).toBe(true)
    expect(entry!.dir.toLowerCase()).toContain(basename(dir).toLowerCase())

    // Switching projects by name is what a UI will do; here it has to work from the CLI too.
    const added = await bench(['--project', 'tabs demo', 'add', '--x', '1', '--y', '2'])
    expect(added.code).toBe(0)
    expect(added.stdout).toContain('recorded')
  })

  it('creates a tab, lists it, and draws it from the saved spec', async () => {
    for (let index = 2; index <= 6; index++) {
      await bench(['--project', dir, 'add', '--x', String(index), '--y', String(2.4 * index + 0.3)])
    }

    const created = await bench(['--project', dir, 'view', 'new', 'tab one', '--dataset', 'main'])
    expect(created.code).toBe(0)
    expect(created.stdout).toContain('views/tab-one.json')

    const listed = await bench(['--project', dir, 'view', 'list', '--json'])
    const views = (JSON.parse(listed.stdout) as { data: { views: { name: string; panels: number }[] } }).data.views
    expect(views).toContainEqual(expect.objectContaining({ name: 'tab one', panels: 1 }))

    const rendered = await bench(['--project', dir, 'view', 'render', 'tab one', '--json'])
    expect(rendered.code).toBe(0)
    const out = (JSON.parse(rendered.stdout) as { data: { path: string; panels: number } }).data
    expect(out.panels).toBe(1)

    const svg = await readFile(out.path, 'utf8')
    expect(svg).toContain('data-view="tab-one"')
    expect(svg).toContain('data-panel="1"')
    // Identity survives the round trip through the file, so a tab can highlight a record.
    expect([...svg.matchAll(/data-point-id="([^"]+)"/g)]).toHaveLength(6)
  })

  it('goes stale when the data moves, and only a refresh makes it current again', async () => {
    await bench(['--project', dir, 'add', '--x', '7', '--y', '17.1'])

    const stale = await bench(['--project', dir, 'view', 'show', 'tab one', '--json'])
    const before = JSON.parse(stale.stdout) as { data: { status: { state: string }[] } }
    expect(before.data.status[0]!.state).toBe('stale')

    const rendered = await bench(['--project', dir, 'view', 'render', 'tab one', '--refresh', '--json'])
    const after = JSON.parse(rendered.stdout) as { data: { status: { state: string }[] } }
    expect(after.data.status[0]!.state).toBe('current')
  })

  // Like the other recipe tests, this one needs the analysis environment; without it the CLI
  // rightly refuses to draw a panel it cannot compute, so the test has nothing to assert.
  it.skipIf(!analysisReady)('adds a recipe panel, and the artifact carries its verdict and identity', async () => {
    const added = await bench([
      '--project', dir, 'view', 'add', 'tab one',
      '--dataset', 'main', '--recipe', 'fit', '--param', 'degree=1', '--title', 'straight line',
    ])
    expect(added.code).toBe(0)

    const shown = await bench(['--project', dir, 'view', 'show', 'tab one', '--json'])
    const payload = JSON.parse(shown.stdout) as {
      data: { view: { panels: { recipe?: string; verdict?: string; chart: { band?: unknown[] } }[] } }
    }
    expect(payload.data.view.panels).toHaveLength(2)
    expect(payload.data.view.panels[1]!.recipe).toBe('fit')
    expect(payload.data.view.panels[1]!.verdict).toBeTruthy()
    expect(payload.data.view.panels[1]!.chart.band?.length).toBeGreaterThan(1)

    const rendered = await bench(['--project', dir, 'view', 'render', 'tab one', '--json'])
    const svg = await readFile((JSON.parse(rendered.stdout) as { data: { path: string } }).data.path, 'utf8')
    expect(svg.match(/data-panel="[12]"/g)).toHaveLength(2)
    expect(svg).toContain('straight line')
    expect(svg).toContain('confidence band')
  })

  it('accepts a hand-written view file, and refuses one with a typo', async () => {
    const saved = JSON.parse(await readFile(join(dir, 'views', 'tab-one.json'), 'utf8')) as Record<string, unknown>
    const renamed = { ...saved, name: 'hand tab', layout: { columns: 1 } }
    const good = join(dir, 'hand.json')
    await writeFile(good, JSON.stringify(renamed))

    const accepted = await bench(['--project', dir, 'view', 'save', '--file', good])
    expect(accepted.code).toBe(0)
    expect(await readFile(join(dir, 'views', 'hand-tab.json'), 'utf8')).toContain('"hand tab"')

    const typo = join(dir, 'typo.json')
    await writeFile(typo, JSON.stringify({ ...renamed, pane1: [] }))
    const refused = await bench(['--project', dir, 'view', 'save', '--file', typo])
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain('unknown field "pane1"')
  })

  it('refuses to replace a view without --force', async () => {
    const refused = await bench(['--project', dir, 'view', 'new', 'tab one', '--dataset', 'main'])
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain('--force')

    const replaced = await bench(['--project', dir, 'view', 'new', 'tab one', '--dataset', 'main', '--force'])
    expect(replaced.code).toBe(0)
  })

  it('refuses a view that does not exist by name, with a way forward', async () => {
    const missing = await bench(['--project', dir, 'view', 'show', 'no such tab'])
    expect(missing.code).toBe(2)
    expect(missing.stderr).toContain('bench view list')
  })

  it('renames a tab, keeping its panels and moving its file', async () => {
    const before = JSON.parse(
      (await bench(['--project', dir, 'view', 'show', 'tab one', '--json'])).stdout,
    ) as { data: { view: { panels: unknown[] } } }

    const renamed = await bench(['--project', dir, 'view', 'rename', 'tab one', 'drift tab'])
    expect(renamed.code).toBe(0)
    expect(renamed.stdout).toContain('renamed "tab one" to "drift tab"')
    expect(existsSync(join(dir, 'views', 'tab-one.json'))).toBe(false)
    expect(existsSync(join(dir, 'views', 'drift-tab.json'))).toBe(true)

    const after = JSON.parse(
      (await bench(['--project', dir, 'view', 'show', 'drift tab', '--json'])).stdout,
    ) as { data: { view: { name: string; panels: unknown[] } } }
    expect(after.data.view.name).toBe('drift tab')
    // A rename is the same drawing under another name, not a re-materialized panel.
    expect(after.data.view.panels).toEqual(before.data.view.panels)
    // The old name is gone as a tab, not hidden behind a second file.
    expect((await bench(['--project', dir, 'view', 'show', 'tab one'])).code).toBe(2)
  })

  it('copies a tab as a tab of its own, and refuses to copy over one that exists', async () => {
    const copied = await bench(['--project', dir, 'view', 'duplicate', 'drift tab', 'drift tab copy'])
    expect(copied.code).toBe(0)
    expect(copied.stdout).toContain('copied "drift tab" to "drift tab copy"')
    expect(copied.stdout).toContain('views/drift-tab-copy.json')

    const listed = JSON.parse(
      (await bench(['--project', dir, 'view', 'list', '--json'])).stdout,
    ) as { data: { views: { name: string; panels: number }[] } }
    expect(listed.data.views.map((view) => view.name)).toEqual(
      expect.arrayContaining(['drift tab', 'drift tab copy']),
    )
    // The copy draws on its own, from its own file.
    const rendered = await bench(['--project', dir, 'view', 'render', 'drift tab copy', '--json'])
    expect(rendered.code).toBe(0)
    expect((JSON.parse(rendered.stdout) as { data: { panels: number } }).data.panels).toBe(1)

    const twice = await bench(['--project', dir, 'view', 'duplicate', 'drift tab', 'drift tab copy'])
    expect(twice.code).toBe(1)
    expect(twice.stderr).toContain('already exists')

    // A name is required, and the refusal says what the command looks like.
    const nameless = await bench(['--project', dir, 'view', 'duplicate', 'drift tab'])
    expect(nameless.code).toBe(1)
    expect(nameless.stderr).toContain('bench view duplicate')
  })

  it('closes a tab from the CLI into the trash, not out of existence', async () => {
    const closed = await bench(['--project', dir, 'view', 'rm', 'drift tab copy'])
    expect(closed.code).toBe(0)
    expect(closed.stdout).toContain('closed "drift tab copy"')
    expect(closed.stdout).toContain('views/.trash/')
    expect(existsSync(join(dir, 'views', 'drift-tab-copy.json'))).toBe(false)

    // The archive is the tab: a later window reopens these bytes, so they carry the name and the
    // panel, not a tombstone.
    const archives = (await readdir(join(dir, 'views', '.trash'))).filter((name) =>
      name.startsWith('drift-tab-copy-'),
    )
    expect(archives).toHaveLength(1)
    const archive = JSON.parse(
      await readFile(join(dir, 'views', '.trash', archives[0]!), 'utf8'),
    ) as { name: string; panels: unknown[] }
    expect(archive.name).toBe('drift tab copy')
    expect(archive.panels).toHaveLength(1)

    expect((await bench(['--project', dir, 'view', 'show', 'drift tab copy'])).code).toBe(2)
    // The tab beside it is untouched: closing one is not clearing the project.
    expect((await bench(['--project', dir, 'view', 'show', 'drift tab'])).code).toBe(0)

    const missing = await bench(['--project', dir, 'view', 'rm', 'no such tab'])
    expect(missing.code).toBe(2)
    expect(missing.stderr).toContain('no view named')
  })
})
