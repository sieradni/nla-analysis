import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assessRuns } from '../src/core/analysis.ts'
import { activePoints, foldVersion } from '../src/core/binder.ts'
import type { BenchEvent } from '../src/core/events.ts'
import { commitImport, planImport, previewImport } from '../src/core/import.ts'
import { initProject } from '../src/core/project.ts'
import { diffRows } from '../src/core/versions.ts'
import { materializePanel, panelStatus, saveView } from '../src/core/views.ts'
import { Workspace } from '../src/core/workspace.ts'

const row = (t: string, x: number, y: number) => ({ t, values: { x, y } })

describe('the row-level diff', () => {
  it('counts added, removed and changed rows against the observation time', () => {
    const parent = [
      { id: 'a', ...row('2026-01-05T09:00:00.000Z', 1, 2) },
      { id: 'b', ...row('2026-01-05T09:01:00.000Z', 3, 4) },
      { id: 'c', ...row('2026-01-05T09:02:00.000Z', 5, 6) },
    ]
    const child = [
      row('2026-01-05T09:00:00.000Z', 1, 2), // unchanged
      row('2026-01-05T09:01:00.000Z', 3, 9), // corrected
      row('2026-01-05T09:03:00.000Z', 7, 8), // new
    ]
    const diff = diffRows(parent, child, ['x', 'y'])
    expect({ added: diff.added, removed: diff.removed, changed: diff.changed }).toEqual({
      added: 1,
      removed: 1,
      changed: 1,
    })
    // The parent's row is named, because that is the point the correction supersedes.
    expect(diff.changedRows[0]).toEqual({
      id: 'b',
      t: '2026-01-05T09:01:00.000Z',
      before: { x: 3, y: 4 },
      after: { x: 3, y: 9 },
    })
    expect(diff.removedRows[0]).toMatchObject({ id: 'c', t: '2026-01-05T09:02:00.000Z' })
    expect(diff.addedRows[0]).toEqual({ t: '2026-01-05T09:03:00.000Z', values: { x: 7, y: 8 } })
  })

  it('does not care what order either side is in, and matches duplicate times one to one', () => {
    const parent = [
      { id: 'a', ...row('2026-01-05T09:00:00.000Z', 1, 2) },
      { id: 'b', ...row('2026-01-05T09:00:00.000Z', 1, 2) },
      { id: 'c', ...row('2026-01-05T09:00:00.000Z', 5, 6) },
    ]
    const child = [
      row('2026-01-05T09:00:00.000Z', 5, 6),
      row('2026-01-05T09:00:00.000Z', 1, 2),
      row('2026-01-05T09:00:00.000Z', 1, 2),
    ]
    const diff = diffRows(parent, child, ['x', 'y'])
    // Two identical rows on each side, both kept: reordering a file is not a change to the evidence.
    expect({ added: diff.added, removed: diff.removed, changed: diff.changed }).toEqual({
      added: 0,
      removed: 0,
      changed: 0,
    })

    const oneFewer = diffRows(parent, child.slice(0, 2), ['x', 'y'])
    expect({ added: oneFewer.added, removed: oneFewer.removed, changed: oneFewer.changed }).toEqual({
      added: 0,
      removed: 1,
      changed: 0,
    })
  })

  it('treats a filled-in gap as a change, and ignores fields the shape does not declare', () => {
    const diff = diffRows(
      [{ id: 'a', t: '2026-01-01T00:00:00.000Z', values: { x: 1, y: 2, operator: 'Ada' } }],
      [{ t: '2026-01-01T00:00:00.000Z', values: { x: 1, y: 2, note: 're-run' } }],
      ['x', 'y'],
    )
    // A column the shape has no field for is not evidence: it cannot make two rows differ.
    expect({ added: diff.added, removed: diff.removed, changed: diff.changed }).toEqual({
      added: 0,
      removed: 0,
      changed: 0,
    })

    const gap = diffRows(
      [{ id: 'a', t: '2026-01-01T00:00:00.000Z', values: { x: 1, y: 2 } }],
      [{ t: '2026-01-01T00:00:00.000Z', values: { x: 1 } }],
      ['x', 'y'],
    )
    // Absent is not equal to present: a row that lost a reading is a change, not the same row.
    expect(gap.changed).toBe(1)
    expect(gap.changedRows[0]!.after).toEqual({ x: 1 })
  })
})

describe('dataset versions', () => {
  const roots: string[] = []

  afterEach(async () => {
    while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true })
  })

  async function project(): Promise<{ dir: string; workspace: Workspace }> {
    const dir = await mkdtemp(join(tmpdir(), 'bench-versions-'))
    roots.push(dir)
    await initProject(dir, 'versions test')
    return { dir, workspace: await Workspace.open(dir) }
  }

  /** An import of `rows` into the dataset, as text, and the plan/commit pair that wrote it. */
  async function importRows(
    dir: string,
    workspace: Workspace,
    name: string,
    rows: string,
  ): Promise<{ version: number; parent: number | null }> {
    const file = join(dir, name)
    await writeFile(
      file,
      'timestamp,x,y\n' + rows,
      'utf8',
    )
    const plan = await planImport(workspace, file, { mapping: { x: 'x', y: 'y' } })
    const committed = await commitImport(workspace, plan)
    return { version: committed.version, parent: committed.parent }
  }

  it('makes version 1 of an empty dataset, and version 2 of a corrected re-export', async () => {
    const { dir, workspace } = await project()
    const first = await importRows(
      dir,
      workspace,
      'v1.csv',
      '2026-01-05T09:00:00Z,1,2\n2026-01-05T09:01:00Z,3,4\n2026-01-05T09:02:00Z,5,6\n',
    )
    expect(first).toEqual({ version: 1, parent: null })

    // The instrument re-exported: one value corrected, one row added, one row gone.
    const second = await importRows(
      dir,
      workspace,
      'v2.csv',
      '2026-01-05T09:00:00Z,1,2\n2026-01-05T09:01:00Z,3,9\n2026-01-05T09:03:00Z,7,8\n',
    )
    expect(second).toEqual({ version: 2, parent: 1 })

    const reopened = await Workspace.open(dir)
    const versions = reopened.versions('main')
    expect(versions.map((record) => record.version)).toEqual([1, 2])
    expect(versions[0]).toMatchObject({ rows: 3, recorded: true })
    expect(versions[1]).toMatchObject({
      rows: 3,
      parent: 1,
      diff: { added: 1, removed: 1, changed: 1 },
    })
    // The version names the preserved file it was read from, not just the fact that there was one.
    expect(versions[1]!.source).toMatch(/^data\/raw\/[0-9a-f]{12}-v2\.csv$/)
    // The latest version holds the file's rows: 2 unchanged, the corrected one, the new one.
    expect(reopened.rowsOfVersion('main', 2).map((point) => point.values.y)).toEqual([2, 9, 8])
    // And version 1 is exactly what it was: same rows, same values, same times.
    expect(reopened.rowsOfVersion('main', 1).map((point) => point.values.y)).toEqual([2, 4, 6])
    expect(reopened.currentVersion('main')).toBe(2)
  })

  it('keeps a past version readable, whatever a later version does to its rows', async () => {
    const { dir, workspace } = await project()
    await importRows(dir, workspace, 'v1.csv', '2026-01-05T09:00:00Z,1,2\n2026-01-05T09:01:00Z,3,4\n')
    const corrected = await importRows(dir, workspace, 'v2.csv', '2026-01-05T09:01:00Z,3,9\n')

    const reopened = await Workspace.open(dir)
    // One row withdrawn and one corrected by version 2. Neither is a deletion: version 1 still reads
    // as it did, which is what makes "what did last week's conclusion rest on" answerable.
    expect(corrected.version).toBe(2)
    expect(reopened.rowsOfVersion('main', 1).map((point) => point.values)).toEqual([
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ])
    expect(reopened.rowsOfVersion('main', 2).map((point) => point.values)).toEqual([{ x: 3, y: 9 }])

    // The fold and the live state agree about the newest version — the check that keeps the
    // on-demand fold honest without snapshotting every version on every read.
    expect(
      foldVersion(reopened.allEvents as BenchEvent[], 'main', 2).filter((point) => point.status === 'active'),
    ).toEqual(activePoints(reopened.state, 'main'))

    // A hand-written point that names a version nobody created is a structural problem, not a silent
    // fold into the newest one.
    const orphan = `${JSON.stringify({
      v: 1,
      id: '01ZZZZZZZZZZZZZZZZZZZZZZZZ',
      type: 'point_recorded',
      at: '2026-01-05T10:00:00.000Z',
      session: 'test',
      dataset: 'main',
      shape: 'xy.v1',
      values: { x: 11, y: 12 },
      t_observed: '2026-01-05T10:00:00.000Z',
      version: 9,
    })}\n`
    await writeFile(join(dir, 'data', 'events.jsonl'), (await readFile(join(dir, 'data', 'events.jsonl'), 'utf8')) + orphan, 'utf8')
    const broken = await Workspace.open(dir)
    expect(broken.state.problems.join('\n')).toContain('names version 9, which was never created')
  })

  it('refuses a re-import that would change nothing, unless it is forced', async () => {
    const { dir, workspace } = await project()
    await importRows(dir, workspace, 'v1.csv', '2026-01-05T09:00:00Z,1,2\n')
    // Different bytes, same row: the duplicate-hash refusal does not apply, and the answer is that
    // the version already holds exactly this row.
    const again = join(dir, 'same.csv')
    await writeFile(again, '# re-exported unchanged\ntimestamp,x,y\n2026-01-05T09:00:00Z,1,2\n', 'utf8')

    await expect(planImport(workspace, again, { mapping: { x: 'x', y: 'y' } })).rejects.toThrow(
      /already holds exactly these 1 row\(s\)/,
    )
    const forced = await planImport(workspace, again, { mapping: { x: 'x', y: 'y' }, force: true })
    expect(forced.version).toBe(2)
    expect({ added: forced.diff.added, removed: forced.diff.removed, changed: forced.diff.changed }).toEqual({
      added: 0,
      removed: 0,
      changed: 0,
    })
  })

  it('tells an importer what it would replace before a row is read out of the file', async () => {
    const { dir, workspace } = await project()
    await importRows(dir, workspace, 'v1.csv', '2026-01-05T09:00:00Z,1,2\n')
    const preview = await previewImport(workspace, join(dir, 'v1.csv'))
    expect(preview).toMatchObject({ version: 2, parent: 1, parentRows: 1 })
  })

  it('tags a typed point with the version it joins, and reads a project that predates versions as one version', async () => {
    const { workspace } = await project()
    await workspace.recordPoint({ values: { x: 1, y: 2 } })
    expect(workspace.rowsOfVersion('main', 1)).toHaveLength(1)
    const recorded = workspace.allEvents.filter((event) => event.type === 'point_recorded')
    expect(recorded.at(-1)).toMatchObject({ version: 1 })

    // No version event was ever written, and the dataset still has exactly one version. Saying that
    // out loud is what lets every reader ask for "version N" without a special case; inventing a
    // second version for rows a project already had would be a lie about history.
    const versions = workspace.versions('main')
    expect(versions).toHaveLength(1)
    expect(versions[0]).toMatchObject({ version: 1, recorded: false, source: 'unrecorded', rows: 1 })
  })

  it('says a run is stale because the dataset moved to a new version, not only because a hash moved', async () => {
    const { dir, workspace } = await project()
    await importRows(dir, workspace, 'v1.csv', '2026-01-05T09:00:00Z,1,2\n2026-01-05T09:01:00Z,3,4\n2026-01-05T09:02:00Z,5,6\n')
    // The run is written by hand: this suite does not need Python to check what the pin means.
    const appended = `${JSON.stringify({
      v: 1,
      id: '01AAAAAAAAAAAAAAAAAAAAAAAA',
      type: 'analysis_run',
      at: new Date().toISOString(),
      session: 'test',
      recipe: 'fit',
      recipe_hash: 'x',
      params: { degree: 1 },
      dataset: 'main',
      version: 1,
      input_hash: 'y',
      verdict: 'supported',
    })}\n`
    await writeFile(
      join(dir, 'data', 'events.jsonl'),
      (await readFile(join(dir, 'data', 'events.jsonl'), 'utf8')) + appended,
      'utf8',
    )
    const fresh = await Workspace.open(dir)
    expect((await assessRuns(process.cwd(), fresh.state)).get('01AAAAAAAAAAAAAAAAAAAAAAAA')).toMatchObject({
      status: 'stale',
      ranOn: 1,
      currentVersion: 1,
    })

    await importRows(dir, fresh, 'v2.csv', '2026-01-05T09:00:00Z,1,2\n')
    const after = await Workspace.open(dir)
    const judged = (await assessRuns(process.cwd(), after.state)).get('01AAAAAAAAAAAAAAAAAAAAAAAA')
    expect(judged?.status).toBe('stale')
    expect(judged?.reason).toMatch(/moved on to version 2; this ran on version 1/)
    expect(judged?.ranOn).toBe(1)
    expect(judged?.currentVersion).toBe(2)
  })

  it('marks a panel stale when the dataset moves past the version it was drawn from', async () => {
    const { dir, workspace } = await project()
    await importRows(dir, workspace, 'v1.csv', '2026-01-05T09:00:00Z,1,2\n2026-01-05T09:01:00Z,3,4\n')
    const panel = (await materializePanel(workspace, { dataset: 'main' })).panel
    expect(panel.version).toBe(1)
    await saveView(dir, { v: 1, name: 'v', layout: { columns: 1 }, panels: [panel] })

    const before = await Workspace.open(dir)
    expect(await panelStatus(before, panel, 0)).toEqual({ index: 0, state: 'current' })

    // A new version with exactly the same rows as the one the panel pinned — forced, because a
    // version that changes nothing is otherwise refused. The pin is what makes this stale, not a
    // fingerprint: "drawn from version 1" is a claim about specific rows.
    const file = join(dir, 'v2.csv')
    await writeFile(file, 'timestamp,x,y\n2026-01-05T09:00:00Z,1,2\n2026-01-05T09:01:00Z,3,4\n', 'utf8')
    await commitImport(before, await planImport(before, file, { mapping: { x: 'x', y: 'y' }, force: true }))
    const after = await Workspace.open(dir)
    const status = await panelStatus(after, panel, 0)
    expect(status.state).toBe('stale')
    expect(status.detail).toContain('the dataset is at version 2; this panel was drawn from version 1')

    // Re-materializing pins the new version, which is what a refresh is for.
    const refreshed = (await materializePanel(after, { dataset: 'main' })).panel
    expect(refreshed.version).toBe(2)
    expect(await panelStatus(after, refreshed, 0)).toEqual({ index: 0, state: 'current' })
  })
})
