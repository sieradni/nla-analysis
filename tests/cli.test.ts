import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

beforeAll(async () => {
  project = await mkdtemp(join(tmpdir(), 'bench-cli-'))
})

afterAll(async () => {
  await rm(project, { recursive: true, force: true })
})

describe('bench CLI, as executed', () => {
  it('starts and prints usage', async () => {
    const result = await bench(['help'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('bench — append-only data project')
    expect(result.stdout).toContain('Exit codes')
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

  it('keeps the log append-only across a correction', async () => {
    const before = await readFile(join(project, 'data', 'events.jsonl'), 'utf8')
    await bench(['--project', project, 'add', '--x', '4', '--y', '9.1'])
    const after = await readFile(join(project, 'data', 'events.jsonl'), 'utf8')
    expect(after.startsWith(before)).toBe(true)
  })
})

// Skipped only when the analysis environment has not been created yet (see tests/run.test.ts for
// why a present-but-broken environment must fail rather than skip).
const analysisReady = existsSync(interpreterCandidates(process.cwd())[0]!)

describe.skipIf(!analysisReady)('analysis through the CLI', () => {
  it('refuses a fit and draws nothing it cannot justify', async () => {
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

  it('draws a curve with a band when the data supports one, and says so on the artifact', async () => {
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
    } finally {
      await rm(target, { recursive: true, force: true })
    }
  })
})
