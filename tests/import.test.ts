import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { initProject } from '../src/core/project.ts'
import { Workspace } from '../src/core/workspace.ts'
import { commitImport, planImport, previewImport, readTable } from '../src/core/import.ts'

const messy = join(process.cwd(), 'fixtures', 'imports', 'lab-export.csv')
const badRow = join(process.cwd(), 'fixtures', 'imports', 'lab-export-bad-row.csv')
const jsonl = join(process.cwd(), 'fixtures', 'imports', 'lab-export.jsonl')
// The realistic export carries two columns the default x/y shape cannot hold. Tests that mean to
// import it must say so, exactly as a person at the CLI now has to.
const messyIgnore = ['note', 'operator']

describe('importing a table', () => {
  const roots: string[] = []

  afterEach(async () => {
    while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true })
  })

  async function project(): Promise<{ dir: string; workspace: Workspace }> {
    const dir = await mkdtemp(join(tmpdir(), 'bench-import-'))
    roots.push(dir)
    await initProject(dir, 'import test')
    return { dir, workspace: await Workspace.open(dir) }
  }

  it('reads a realistic export, keeping a quoted comma and skipping the preamble', async () => {
    const table = await readTable(messy)
    expect(table.format).toBe('csv')
    expect(table.columns).toEqual(['timestamp', 'temp_c', 'volts', 'note', 'operator'])
    expect(table.rows).toBe(5)
    expect(table.comments).toBe(2)
    expect(table.raggedRows).toBe(0)
    expect(table.sample[0]!.note).toBe('baseline, drift check')
    // An empty cell is empty, not zero: that distinction is the shape's to enforce, not the reader's.
    expect(table.sample[1]!.note).toBe('')
  })

  it('suggests matching columns, and refuses to guess the rest', async () => {
    const { dir, workspace } = await project()
    const preview = await previewImport(workspace, messy)
    expect(preview.dataset).toBe('main')
    expect(preview.shape).toBe('xy.v1')
    // Instrument names do not match the shape: nothing is guessed, the dialog asks for the mapping.
    expect(preview.suggested).toEqual({})
    expect(preview.duplicate).toBe(false)
    expect(preview.fields.map((field) => field.type)).toEqual(['number', 'number'])

    // A file whose columns are named like the fields is suggested without a click — and a file with
    // no clock suggests none, rather than a made-up one.
    await writeFile(join(dir, 'plain.csv'), 'x,y\n1,2\n3,4\n')
    const plain = await previewImport(workspace, join(dir, 'plain.csv'))
    expect(plain.suggested).toEqual({ x: 'x', y: 'y' })
    expect(plain.suggestedTime).toBeNull()

    // The messy file has no x/y columns, so the name match finds nothing: that is a refusal, not a guess.
    const failure = await planImport(workspace, messy).catch((error) => error)
    expect(failure.message).toMatch(/no column for the required field "x"/)
    expect(failure.hint).toContain('temp_c')
  })

  it('plans every row against the shape, using the file clock when it has one', async () => {
    const { workspace } = await project()
    const plan = await planImport(workspace, messy, {
      mapping: { x: 'temp_c', y: 'volts' },
      ignoreColumns: messyIgnore,
    })
    expect(plan.rows).toBe(5)
    expect(plan.ignoredColumns).toEqual(messyIgnore)
    expect(plan.timeColumn).toBe('timestamp')
    expect(plan.mapping).toEqual({ x: 'temp_c', y: 'volts' })
    expect(plan.sample[0]).toEqual({
      values: { x: 21.4, y: 3.301 },
      t: '2026-01-05T09:00:00.000Z',
    })
    expect(plan.warnings).toEqual([])
    expect(plan.preserved).toMatch(/^data\/raw\/[0-9a-f]{12}-lab-export\.csv$/)
  })

  it('refuses a file with no observation time instead of stamping the moment of import', async () => {
    const { dir, workspace } = await project()
    await writeFile(join(dir, 'plain.csv'), 'x,y\n1,2\n2,4\n')
    expect((await previewImport(workspace, join(dir, 'plain.csv'))).suggestedTime).toBeNull()

    const failure = await planImport(workspace, join(dir, 'plain.csv')).catch((error) => error)
    expect(failure.message).toMatch(/no column holds the observation time/)
    // The refusal names the columns it could have meant, so the fix is a choice, not a guess.
    expect(failure.message).toContain('x, y')
    expect(failure.hint).toContain('--time <column>')
    // Nothing was written: no copy, no import record, no version.
    expect(await readdir(join(dir, 'data', 'raw')).catch(() => [])).toEqual([])
    expect(workspace.allEvents.filter((event) => event.type === 'import_completed')).toHaveLength(0)
  })

  it("finds the time column in the file's own spelling, not only the lowercase one", async () => {
    const { dir, workspace } = await project()
    await writeFile(join(dir, 'upper.csv'), 'Timestamp,x,y\n2026-03-01T09:00:00Z,1,2\n')
    const plan = await planImport(workspace, join(dir, 'upper.csv'), { mapping: { x: 'x', y: 'y' } })
    expect(plan.timeColumn).toBe('Timestamp')
    expect(plan.sample[0]!.t).toBe('2026-03-01T09:00:00.000Z')
  })

  it('derives a designated observation time from its field and refuses a second time column that disagrees', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bench-import-time-'))
    roots.push(dir)
    await initProject(dir, 'time test', undefined, {
      id: 'visit.v2',
      fields: [
        { name: 'date', type: 'instant' },
        { name: 'value', type: 'number' },
      ],
      time_field: 'date',
    })
    const workspace = await Workspace.open(dir)

    await writeFile(
      join(dir, 'agree.csv'),
      'when,date,value\n2026-12-01T02:00:00+02:00,2026-12-01T00:00:00Z,9\n',
      'utf8',
    )
    const plan = await planImport(workspace, join(dir, 'agree.csv'), { time: 'when' })
    // The mapped field is canonicalised in the row, and the second column agrees with it.
    expect(plan.timeColumn).toBe('when')
    expect(plan.sample[0]).toEqual({
      values: { date: '2026-12-01T00:00:00.000Z', value: 9 },
      t: '2026-12-01T00:00:00.000Z',
    })

    await writeFile(
      join(dir, 'disagree.csv'),
      'when,date,value\n2026-12-02T00:00:00Z,2026-12-03T00:00:00Z,9\n',
      'utf8',
    )
    const failure = await planImport(workspace, join(dir, 'disagree.csv'), { time: 'when' }).catch(
      (error) => error,
    )
    expect(failure.message).toMatch(/1 row\(s\) would not import, so none were/)
    expect(failure.problems.join(' ')).toContain(
      'field "date" says 2026-12-03T00:00:00.000Z, but the time column "when" says 2026-12-02T00:00:00.000Z',
    )

    // With no second time column, the mapped designated field is the time source on its own.
    await writeFile(join(dir, 'plain.csv'), 'date,value\n2026-12-04T00:00:00Z,10\n', 'utf8')
    const direct = await planImport(workspace, join(dir, 'plain.csv'))
    expect(direct.timeColumn).toBe('date')
    await commitImport(workspace, direct)
    const reopened = await Workspace.open(dir)
    expect(reopened.dataset('main').points[0]).toMatchObject({
      values: { date: '2026-12-04T00:00:00.000Z', value: 10 },
      tObserved: '2026-12-04T00:00:00.000Z',
    })
  })

  it('writes the points and the import record together, and preserves the original', async () => {
    const { dir, workspace } = await project()
    const plan = await planImport(workspace, messy, {
      mapping: { x: 'temp_c', y: 'volts' },
      ignoreColumns: messyIgnore,
    })
    await commitImport(workspace, plan)

    // Evidence is the bytes that were handed over, not a normalised copy.
    expect(await readFile(join(dir, plan.preserved), 'utf8')).toBe(await readFile(messy, 'utf8'))

    const reopened = await Workspace.open(dir)
    const points = reopened.dataset('main').points
    expect(points).toHaveLength(5)
    expect(points[0]!.values).toEqual({ x: 21.4, y: 3.301 })
    expect(points[0]!.tags).toContain('import')
    const records = reopened.allEvents.filter((event) => event.type === 'import_completed')
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      dataset: 'main',
      file: plan.preserved,
      rows: 5,
      mapping: { x: 'temp_c', y: 'volts' },
      columns: ['timestamp', 'temp_c', 'volts', 'note', 'operator'],
    })
    expect(await readFile(join(dir, 'STATE.md'), 'utf8')).toContain('5 active points')
  })

  it('refuses one bad row before writing anything at all', async () => {
    const { dir, workspace } = await project()
    const before = await readFile(join(dir, 'data', 'events.jsonl'), 'utf8')

    const failure = await planImport(workspace, badRow, {
      mapping: { x: 'temp_c', y: 'volts' },
    }).catch((error) => error)
    expect(failure.message).toMatch(/1 row\(s\) would not import, so none were/)
    expect(failure.problems.join(' ')).toContain('row 3')
    expect(failure.problems.join(' ')).toMatch(/finite number/)

    // Planning never writes: the log is exactly what init wrote, and no evidence was copied.
    expect(await readFile(join(dir, 'data', 'events.jsonl'), 'utf8')).toBe(before)
    expect(await readdir(join(dir, 'data', 'raw'))).toEqual([])
  })

  it('refuses the same bytes twice unless asked, and reads JSON lines too', async () => {
    const { workspace } = await project()
    const mapping = { x: 'temp_c', y: 'volts' }
    await commitImport(workspace, await planImport(workspace, messy, { mapping, ignoreColumns: messyIgnore }))

    await expect(planImport(workspace, messy, { mapping, ignoreColumns: messyIgnore })).rejects.toThrow(/already imported/)
    expect((await previewImport(workspace, messy)).duplicate).toBe(true)
    await expect(
      planImport(workspace, messy, { mapping, ignoreColumns: messyIgnore, force: true }),
    ).resolves.toMatchObject({ rows: 5 })

    const json = await planImport(workspace, jsonl, { mapping, ignoreColumns: ['note'] })
    expect(json.format).toBe('jsonl')
    expect(json.rows).toBe(2)
    expect(json.ignoredColumns).toEqual(['note'])
    expect(json.sample[1]).toEqual({ values: { x: 23, y: 3.43 }, t: '2026-01-05T09:06:00.000Z' })
    expect(existsSync(join(workspace.dir, json.preserved))).toBe(false)
  })

  it('refuses an undeclared column unless every such column is named, and records the choice', async () => {
    const { dir, workspace } = await project()
    const file = join(dir, 'extra.csv')
    await writeFile(
      file,
      'timestamp,x,y,extra\n2026-01-05T09:00:00Z,1,2,9\n2026-01-05T09:01:00Z,3,4,10\n',
      'utf8',
    )
    const mapping = { x: 'x', y: 'y' }

    // The default is a refusal. Nothing is copied and no version is planned.
    const failure = await planImport(workspace, file, { mapping }).catch((error) => error)
    expect(failure.message).toMatch(/1 column has no shape field: extra/)
    expect(failure.hint).toContain('--ignore-unmapped extra')
    expect(await readdir(join(dir, 'data', 'raw'))).toEqual([])
    expect(workspace.allEvents.filter((event) => event.type === 'import_completed')).toHaveLength(0)

    // Naming a column that is used is not an opt-out; it is a contradiction.
    await expect(planImport(workspace, file, { mapping, ignoreColumns: ['x'] })).rejects.toThrow(
      /used by field "x" and cannot be ignored/,
    )
    await expect(planImport(workspace, file, { mapping, ignoreColumns: ['nope'] })).rejects.toThrow(
      /no such column/,
    )

    // The explicit opt-out passes, keeps the column out of the values, and records the choice on the
    // import event so a later reader can see what was deliberately left behind.
    const plan = await planImport(workspace, file, { mapping, ignoreColumns: ['extra'] })
    expect(plan.ignoredColumns).toEqual(['extra'])
    expect(plan.sample[0]!.values).toEqual({ x: 1, y: 2 })
    await commitImport(workspace, plan)

    const reopened = await Workspace.open(dir)
    const record = reopened.allEvents.find((event) => event.type === 'import_completed')
    expect(record).toMatchObject({ ignored_columns: ['extra'] })
    expect(reopened.dataset('main').points[0]!.values).toEqual({ x: 1, y: 2 })
  })
})
