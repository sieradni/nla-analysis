import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
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

  it('runs a whole session: init, add, correct, retract, list, check, state, chart', async () => {
    const init = await bench(['init', project, '--name', 'cli-smoke'])
    expect(init.code).toBe(0)
    expect(init.stdout).toContain('created project')

    const first = await bench(['--project', project, 'add', '--x', '1', '--y', '2.5', '--at', '2026-10-01T09:00:00Z', '--json'])
    expect(first.code).toBe(0)
    const created = JSON.parse(first.stdout) as { ok: boolean; data: { id: string; t_observed: string } }
    expect(created.ok).toBe(true)
    // Timestamps are normalised on write, so ordering by string and by instant agree.
    expect(created.data.t_observed).toBe('2026-10-01T09:00:00.000Z')

    expect((await bench(['--project', project, 'add', '--x', '2', '--y', '4.6'])).code).toBe(0)

    const corrected = await bench(['--project', project, 'correct', created.data.id, '--values', '{"y":2.9}', '--reason', 'typo'])
    expect(corrected.code).toBe(0)
    expect(corrected.stdout).toContain('original record preserved')

    const listed = await bench(['--project', project, 'list', '--json'])
    const points = JSON.parse(listed.stdout) as { data: { values: { y: number }; corrections: number }[] }
    expect(points.data).toHaveLength(2)
    expect(points.data.find((point) => point.corrections === 1)?.values.y).toBe(2.9)

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
        }
      }
      expect(payload.data.rows).toBe(3)
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

  it('says which column is missing rather than guessing at one', async () => {
    await withProject('import-map', async (dir) => {
      await writeFile(join(dir, 'odd.csv'), 'degC,volts\n21.4,3.301\n', 'utf8')
      const result = await bench(['--project', dir, 'import', 'odd.csv'])
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('no column for the required field "x"')
      expect(result.stderr).toContain('--map x=<column>')
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

  it('adds a recipe panel, and the artifact carries its verdict and identity', async () => {
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
})
