import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { initProject } from '../src/core/project.ts'
import { BenchError, Workspace } from '../src/core/workspace.ts'

/**
 * The seam exists so a UI, a script and the CLI cannot diverge (ADR 0003). These tests use it the way
 * a UI would — in process, holding state between calls, never shelling out — and check that what it
 * believes matches what the file says. The last test drives the CLI and the library with the same
 * input, because "one path" is only true if both roads arrive at the same place.
 */
const run = promisify(execFile)
const cli = join(process.cwd(), 'src', 'cli', 'index.ts')

let root: string
let project: string
let other: string
let benchHome: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'bench-workspace-'))
  project = join(root, 'in-process')
  other = join(root, 'through-cli')
  await initProject(project, 'in-process')
  await initProject(other, 'through-cli')
  // The last test drives the real CLI, and every CLI command records a recent. Spawned children
  // inherit this, so a test run cannot leave scratch projects in the operator's project list — which
  // is exactly what it did before this line existed.
  benchHome = await mkdtemp(join(tmpdir(), 'bench-home-'))
  process.env.BENCH_HOME = benchHome
})

afterAll(async () => {
  delete process.env.BENCH_HOME
  await rm(root, { recursive: true, force: true })
  await rm(benchHome, { recursive: true, force: true })
})

describe('Workspace', () => {
  it('keeps its own state in step with the log it is appending to', async () => {
    const workspace = await Workspace.open(project)
    expect(workspace.dataset().points).toHaveLength(0)

    const recorded = await workspace.recordPoint({ values: { x: 1, y: 2.5 }, tObserved: '2026-01-01T00:00:00Z' })
    // No re-read between the append and the answer: the state the caller sees is the state it wrote.
    expect(workspace.dataset().points).toHaveLength(1)
    expect(workspace.findPoint(recorded.event.id)?.point.values).toEqual({ x: 1, y: 2.5 })
    // Canonical UTC, so ordering by string and by instant cannot disagree.
    expect(recorded.tObserved).toBe('2026-01-01T00:00:00.000Z')

    // And the file agrees with the fold: the cheap path and the disk are not two different truths.
    const reloaded = await workspace.pull()
    expect(reloaded.datasets.get('main')?.points).toHaveLength(1)
  })

  it('sees a write another process made, once asked to pull', async () => {
    const workspace = await Workspace.open(project)
    const before = workspace.dataset().points.length

    await run('node', [cli, '--project', project, 'add', '--x', '9', '--y', '18'], { cwd: process.cwd() })
    // Deliberately still the old count: an in-process cache must not pretend to be live.
    expect(workspace.dataset().points).toHaveLength(before)

    const pulled = await workspace.pull()
    expect(pulled.datasets.get('main')!.points).toHaveLength(before + 1)
  })

  it('refuses a point its own shape rejects, and writes nothing', async () => {
    const workspace = await Workspace.open(project)
    const before = await readFile(join(project, 'data', 'events.jsonl'), 'utf8')

    const failure = await workspace
      .recordPoint({ values: { x: 'not a number', y: 1 } })
      .then(() => null)
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(BenchError)
    expect((failure as BenchError).kind).toBe('invalid')
    expect((failure as BenchError).problems.join(' ')).toContain('"x"')
    // The log is byte-identical: a rejected point is not a partial one.
    expect(await readFile(join(project, 'data', 'events.jsonl'), 'utf8')).toBe(before)
  })

  it('refuses a dataset that does not exist instead of quietly using another', async () => {
    const workspace = await Workspace.open(project)

    const failure = await workspace
      .recordPoint({ dataset: 'ghost', values: { x: 1, y: 2 } })
      .then(() => null)
      .catch((error: unknown) => error)

    // Substituting the dataset that does exist would answer a different question, silently.
    expect((failure as BenchError).kind).toBe('missing')
    expect((failure as BenchError).message).toBe('no dataset "ghost"')
  })

  it('throws refusals rather than exiting: a caller with no exit code can still recover', async () => {
    const workspace = await Workspace.open(project)
    let caught: unknown
    try {
      await workspace.retractPoint('01NOPE')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(BenchError)
    // Still alive and usable afterwards, which is the whole reason the core does not call exit().
    expect(workspace.dataset().points.length).toBeGreaterThan(0)
  })

  it('folds a correction without rewriting the original record', async () => {
    const workspace = await Workspace.open(project)
    const target = workspace.dataset().points[0]!
    const before = await readFile(join(project, 'data', 'events.jsonl'), 'utf8')

    const corrected = await workspace.correctPoint(target.id, { y: 99 }, 'transcription error')
    expect(corrected.now).toEqual({ x: 1, y: 99 })

    const after = await readFile(join(project, 'data', 'events.jsonl'), 'utf8')
    expect(after.startsWith(before)).toBe(true)
    expect(after.trimEnd().split('\n').at(-1)).toContain('point_corrected')
  })

  it('arrives at the same result as the CLI for the same input', async () => {
    const args = ['add', '--x', '3', '--y', '7.25', '--at', '2026-03-03T03:03:03Z', '--note', 'same input']

    // The library and the binary, each recording the same point into its own project.
    const workspace = await Workspace.open(project)
    const mineBefore = workspace.dataset().points.length
    const mine = await workspace.recordPoint({
      values: { x: 3, y: 7.25 },
      tObserved: '2026-03-03T03:03:03Z',
      note: 'same input',
    })

    const throughCliProject = await Workspace.open(other)
    const theirsBefore = throughCliProject.dataset().points.length
    await run('node', [cli, '--project', other, ...args], { cwd: process.cwd() })
    const throughCli = await Workspace.open(other)
    const theirs = throughCli.dataset().points.at(-1)!

    // Each added exactly one point, and the point is the same in everything a user could observe —
    // except the generated id and the instant it was recorded.
    expect(workspace.dataset().points).toHaveLength(mineBefore + 1)
    expect(throughCli.dataset().points).toHaveLength(theirsBefore + 1)
    expect(mine.dataset).toBe(theirs.dataset)
    expect(workspace.shapeOf(mine.dataset).id).toBe(throughCli.shapeOf(theirs.dataset).id)
    expect(mine.tObserved).toBe(theirs.tObserved)
    expect(mine.event.type).toBe('point_recorded')
    expect((mine.event as { values: unknown }).values).toEqual(theirs.values)
    expect((mine.event as { note?: string }).note).toBe(theirs.note)
  })
})
