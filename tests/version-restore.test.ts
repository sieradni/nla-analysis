/*
 * Restoring a version: the inverse of an import.
 *
 * An import replaces a dataset version with a new one. Its undo must be another version, not a
 * deletion: the older version's rows come back, the newer version stays readable, and the version
 * number only moves forward. These tests drive the same `Workspace` path the CLI and the window use,
 * then read the log back to check that every past version still says what it said.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { initProject } from '../src/core/project.ts'
import { commitImport, planImport } from '../src/core/import.ts'
import { Workspace } from '../src/core/workspace.ts'
import type { Point } from '../src/core/binder.ts'

let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'bench-restore-'))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

const rowOf = (point: Point) => ({ id: point.id, t: point.tObserved, values: point.values })

/** Import exactly these rows as the dataset's next version, the way both doors do it. */
async function importRows(
  workspace: Workspace,
  dir: string,
  name: string,
  header: string,
  rows: string,
  mapping: Record<string, string>,
) {
  const file = join(dir, name)
  await writeFile(file, header + '\n' + rows, 'utf8')
  const plan = await planImport(workspace, file, { mapping, time: 't_observed' })
  return commitImport(workspace, plan)
}

async function logEvents(dir: string): Promise<Record<string, unknown>[]> {
  return (await readFile(join(dir, 'data', 'events.jsonl'), 'utf8'))
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe('restoring a version', () => {
  it('brings an older version back as a new version, with the same rows', async () => {
    const dir = join(root, 'rows')
    await initProject(dir, 'restore rows')
    const workspace = await Workspace.open(dir)
    const header = 't_observed,x,y'

    const first = await importRows(
      workspace,
      dir,
      'v1.csv',
      header,
      '2026-01-01T00:00:00Z,1,2\n2026-01-02T00:00:00Z,2,3\n2026-01-03T00:00:00Z,3,4\n',
      { x: 'x', y: 'y' },
    )
    expect(first).toMatchObject({ version: 1, parent: null })
    const v1 = workspace.rowsOfVersion('main', 1).map(rowOf)

    // Version 2 keeps the first row, changes the second, drops the third, and adds a fourth.
    const second = await importRows(
      workspace,
      dir,
      'v2.csv',
      header,
      '2026-01-01T00:00:00Z,1,2\n2026-01-02T00:00:00Z,2,30\n2026-01-04T00:00:00Z,4,5\n',
      { x: 'x', y: 'y' },
    )
    expect(second).toMatchObject({ version: 2, parent: 1 })
    const v2 = workspace.rowsOfVersion('main', 2).map(rowOf)

    const restored = await workspace.restoreVersion('main', 1)
    expect(restored).toMatchObject({
      dataset: 'main',
      version: 3,
      parent: 2,
      restoredFrom: 1,
      rows: 3,
      active: 3,
    })
    expect(restored.diff).toEqual({ added: 1, removed: 1, changed: 1 })

    // The new version holds the older version's rows — ids, values and observation times, not a
    // lookalike recorded under fresh ids.
    expect(workspace.rowsOfVersion('main', 3).map(rowOf)).toEqual(v1)
    // And nothing earlier moved: version 1 and version 2 still read exactly as they did.
    expect(workspace.rowsOfVersion('main', 1).map(rowOf)).toEqual(v1)
    expect(workspace.rowsOfVersion('main', 2).map(rowOf)).toEqual(v2)

    const record = workspace.versions('main').find((candidate) => candidate.version === 3)
    expect(record).toMatchObject({
      version: 3,
      parent: 2,
      rows: 3,
      source: 'restored from version 1',
      diff: { added: 1, removed: 1, changed: 1 },
    })

    // The acts are the ordinary ones: the added row leaves, the dropped row comes back, the changed
    // row is corrected back to its older value. No new event type, no rewritten event.
    const mine = (await logEvents(dir)).filter((event) => event.version === 3)
    expect(mine.map((event) => event.type)).toEqual([
      'dataset_version_created',
      'point_retracted',
      'point_corrected',
      'point_restored',
    ])
    expect(mine[1]!.supersedes).toBe(v2.find((row) => row.t === '2026-01-04T00:00:00.000Z')!.id)
    expect(mine[3]!.restores).toBe(
      (await logEvents(dir)).find(
        (event) =>
          event.type === 'point_retracted' &&
          event.supersedes === v1.find((row) => row.t === '2026-01-03T00:00:00.000Z')!.id &&
          event.version === 2,
      )!.id,
    )

    // Redo is the same operation in the other direction: the imported version comes back as a new
    // version, and it is still the same rows it held.
    const redone = await workspace.restoreVersion('main', 2)
    expect(redone).toMatchObject({ version: 4, parent: 3, restoredFrom: 2, rows: 3, active: 3 })
    expect(workspace.rowsOfVersion('main', 4).map(rowOf)).toEqual(v2)
    expect(workspace.versions('main').map((candidate) => candidate.version)).toEqual([1, 2, 3, 4])
    expect(workspace.state.problems).toEqual([])
  })

  it('restores the empty dataset before the first import, and redoes the import', async () => {
    const dir = join(root, 'first')
    await initProject(dir, 'restore first')
    const workspace = await Workspace.open(dir)
    const header = 't_observed,x,y'
    const first = await importRows(
      workspace,
      dir,
      'first.csv',
      header,
      '2026-02-01T00:00:00Z,1,2\n2026-02-02T00:00:00Z,2,3\n',
      { x: 'x', y: 'y' },
    )
    expect(first).toMatchObject({ version: 1, parent: null })
    const rows = workspace.rowsOfVersion('main', 1).map(rowOf)

    const emptied = await workspace.restoreVersion('main', null)
    expect(emptied).toMatchObject({
      version: 2,
      parent: 1,
      restoredFrom: null,
      rows: 0,
      active: 0,
      diff: { added: 0, removed: 2, changed: 0 },
    })
    expect(workspace.rowsOfVersion('main', 2)).toEqual([])
    // The first version is not deleted; it is the only place those two rows live.
    expect(workspace.rowsOfVersion('main', 1).map(rowOf)).toEqual(rows)
    expect(workspace.versions('main')[1]).toMatchObject({
      version: 2,
      parent: 1,
      rows: 0,
      source: 'restored from the empty dataset before version 1',
    })

    const redone = await workspace.restoreVersion('main', 1)
    expect(redone).toMatchObject({ version: 3, parent: 2, restoredFrom: 1, rows: 2, active: 2 })
    expect(workspace.rowsOfVersion('main', 3).map(rowOf)).toEqual(rows)

    // "No rows" is only an older state when there is one version to go back beyond.
    await expect(workspace.restoreVersion('main', null)).rejects.toThrow(/only the first version/)
    await expect(workspace.restoreVersion('main', 9)).rejects.toThrow(/has no version 9/)
    await expect(workspace.restoreVersion('main', 3)).rejects.toThrow(/not older than the current version/)
    expect(workspace.state.problems).toEqual([])
  })

  it('restores a row whose newer form gained a field, which a correction alone cannot undo', async () => {
    const dir = join(root, 'optional')
    await initProject(dir, 'restore optional', undefined, {
      id: 'opt.v1',
      fields: [
        { name: 'x', type: 'number' },
        { name: 'y', type: 'number' },
        { name: 'tag', type: 'string', optional: true },
      ],
    })
    const workspace = await Workspace.open(dir)

    const first = await importRows(
      workspace,
      dir,
      'plain.csv',
      't_observed,x,y',
      '2026-03-01T00:00:00Z,1,2\n',
      { x: 'x', y: 'y' },
    )
    expect(first.version).toBe(1)
    const original = workspace.rowsOfVersion('main', 1)[0]!
    expect(Object.hasOwn(original.values, 'tag')).toBe(false)

    const second = await importRows(
      workspace,
      dir,
      'tagged.csv',
      't_observed,x,y,tag',
      '2026-03-01T00:00:00Z,1,2,a\n',
      { x: 'x', y: 'y', tag: 'tag' },
    )
    expect(second).toMatchObject({ version: 2, parent: 1 })
    expect(workspace.rowsOfVersion('main', 2)[0]!.values.tag).toBe('a')

    const restored = await workspace.restoreVersion('main', 1)
    expect(restored).toMatchObject({ version: 3, parent: 2, rows: 1, active: 1 })
    expect(restored.diff).toEqual({ added: 0, removed: 0, changed: 1 })

    const row = workspace.rowsOfVersion('main', 3)[0]!
    // The older row's values exactly: no leftover `tag`, which a merging correction would have kept.
    expect(row.values).toEqual({ x: 1, y: 2 })
    expect(Object.hasOwn(row.values, 'tag')).toBe(false)
    // A fresh record is what makes that exact; the old row is retracted, never rewritten.
    expect(row.id).not.toBe(original.id)
    expect(workspace.findPoint(original.id)?.point.status).toBe('retracted')
    // Version 1 still reads without the field, and version 2 with it.
    expect(workspace.rowsOfVersion('main', 1)[0]!.values).toEqual({ x: 1, y: 2 })
    expect(workspace.rowsOfVersion('main', 2)[0]!.values.tag).toBe('a')
    expect(workspace.state.problems).toEqual([])
  })
})
