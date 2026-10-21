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

  it('does not append onto a bind the log has moved past', async () => {
    const workspace = await Workspace.open(project)
    const before = workspace.dataset().points.length
    const readsBefore = workspace.logReads

    // An agent runs `bench add` in a terminal while this workspace holds its cached state. This is
    // the scenario that produced a quiet lie: the next append folded onto a bind without this row,
    // and every count after it was one short of the log it claimed to summarise.
    await run('node', [cli, '--project', project, 'add', '--x', '4', '--y', '8'], { cwd: process.cwd() })
    expect(workspace.dataset().points).toHaveLength(before)

    await workspace.recordPoint({ values: { x: 2, y: 3 } })
    // A repair happened, and it happened before the write — not after it, as a correction.
    expect(workspace.logReads).toBeGreaterThan(readsBefore)
    expect(workspace.dataset().points).toHaveLength(before + 2)

    // The file is the authority: a workspace opened now agrees, point for point, with no gap of one.
    const fresh = await Workspace.open(project)
    const ids = (points: { id: string }[]) => points.map((point) => point.id).sort()
    expect(ids(fresh.dataset().points)).toEqual(ids(workspace.dataset().points))
  })

  it('writes STATE.md from the log, not from a bind another writer has outgrown', async () => {
    const workspace = await Workspace.open(project)
    const readsBefore = workspace.logReads

    await run('node', [cli, '--project', project, 'add', '--x', '5', '--y', '10'], { cwd: process.cwd() })
    const stale = workspace.dataset().points.length

    await workspace.writeStateBrief()
    expect(workspace.logReads).toBeGreaterThan(readsBefore)

    // The brief is the cold-start view of the log. If it were written from the stale bind it would
    // say one point fewer than the file holds — the precise lie this check exists to prevent.
    const fresh = await Workspace.open(project)
    expect(stale).toBe(fresh.dataset().points.length - 1)
    const brief = await readFile(join(project, 'STATE.md'), 'utf8')
    expect(brief).toContain(`${fresh.dataset().points.length} active points`)
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

  it('refuses to correct a withdrawn point, and writes nothing', async () => {
    const workspace = await Workspace.open(project)
    const recorded = await workspace.recordPoint({
      values: { x: 6, y: 7 },
      tObserved: '2026-03-03T03:03:03Z',
    })
    await workspace.retractPoint(recorded.event.id)
    const before = await readFile(join(project, 'data', 'events.jsonl'), 'utf8')

    const failure = await workspace
      .correctPoint(recorded.event.id, { y: 8 })
      .then(() => null)
      .catch((error: unknown) => error)

    // The fold would have merged the values into a row nothing shows, and a later restore would
    // bring the record back with numbers nobody chose. `missing`, because the row is not in the data
    // and the same call can never succeed: the window ends the edit on that kind.
    expect((failure as BenchError).kind).toBe('missing')
    expect((failure as BenchError).message).toContain('has been withdrawn')
    expect(await readFile(join(project, 'data', 'events.jsonl'), 'utf8')).toBe(before)
  })

  it('restores a removed point as the same record, and refuses a second restore', async () => {
    const workspace = await Workspace.open(project)
    const recorded = await workspace.recordPoint({
      values: { x: 4.5, y: 9.25 },
      tObserved: '2026-02-02T02:02:02Z',
    })
    const count = workspace.dataset().points.length
    const retracted = await workspace.retractPoint(recorded.event.id)
    expect(workspace.dataset().points).toHaveLength(count - 1)

    const restored = await workspace.restorePoint(recorded.event.id)
    const back = workspace.findPoint(recorded.event.id)?.point
    expect(back?.status).toBe('active')
    // The same record: the id, the values, the observation time and the version it was recorded in.
    expect(back?.id).toBe(recorded.event.id)
    expect(back?.values).toEqual({ x: 4.5, y: 9.25 })
    expect(back?.tObserved).toBe('2026-02-02T02:02:02.000Z')
    expect(back?.version).toBe((recorded.event as { version?: number }).version ?? 1)
    expect(restored.retraction).toBe(retracted.event.id)
    expect(restored.active).toBe(count)

    // One event per undo, and it names the retraction it reversed.
    const appended = (await readFile(join(project, 'data', 'events.jsonl'), 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as { id: string; type: string; restores?: string })
    expect(appended.at(-1)?.type).toBe('point_restored')
    expect(appended.at(-1)?.restores).toBe(retracted.event.id)

    // Restoring an active point would record an act that changed nothing.
    await expect(workspace.restorePoint(recorded.event.id)).rejects.toThrow(/is not retracted/)

    // Redo: the same record can be withdrawn and brought back again, and the count agrees each time.
    const again = await workspace.retractPoint(recorded.event.id)
    expect(again.active).toBe(count - 1)
    const second = await workspace.restorePoint(recorded.event.id)
    expect(second.active).toBe(count)
  })

  it('reverses the removal it is told to, and refuses one that is no longer in force', async () => {
    const workspace = await Workspace.open(project)
    const recorded = await workspace.recordPoint({
      values: { x: 5.5, y: 1.5 },
      tObserved: '2026-02-03T03:03:03Z',
    })
    const first = await workspace.retractPoint(recorded.event.id)

    // A caller that remembers the act names it, and gets that act reversed.
    const restored = await workspace.restorePoint(recorded.event.id, first.event.id)
    expect(restored.retraction).toBe(first.event.id)

    // The point is removed again — by this window or another writer — so the older removal is no
    // longer the one in force. Naming it must refuse rather than reverse the newer act under the
    // older act's name.
    const second = await workspace.retractPoint(recorded.event.id)
    await expect(workspace.restorePoint(recorded.event.id, first.event.id)).rejects.toThrow(
      /no longer the one in force/,
    )
    // The removal in force still comes back, named or unnamed.
    expect((await workspace.restorePoint(recorded.event.id, second.event.id)).retraction).toBe(
      second.event.id,
    )
    await workspace.retractPoint(recorded.event.id)
    expect((await workspace.restorePoint(recorded.event.id)).active).toBe(
      workspace.dataset().points.length,
    )
    expect(workspace.findPoint(recorded.event.id)?.point.status).toBe('active')
  })

  it('refuses to restore a point the log does not have', async () => {
    const workspace = await Workspace.open(project)
    const failure = await workspace
      .restorePoint('01NOPE')
      .then(() => null)
      .catch((error: unknown) => error)

    expect((failure as BenchError).kind).toBe('missing')
    expect((failure as BenchError).message).toBe('no point with id "01NOPE"')
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
