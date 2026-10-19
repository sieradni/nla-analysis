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
    const plan = await planImport(workspace, messy, { mapping: { x: 'temp_c', y: 'volts' } })
    expect(plan.rows).toBe(5)
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

  it('writes the points and the import record together, and preserves the original', async () => {
    const { dir, workspace } = await project()
    const plan = await planImport(workspace, messy, { mapping: { x: 'temp_c', y: 'volts' } })
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
    await commitImport(workspace, await planImport(workspace, messy, { mapping }))

    await expect(planImport(workspace, messy, { mapping })).rejects.toThrow(/already imported/)
    expect((await previewImport(workspace, messy)).duplicate).toBe(true)
    await expect(planImport(workspace, messy, { mapping, force: true })).resolves.toMatchObject({ rows: 5 })

    const json = await planImport(workspace, jsonl, { mapping })
    expect(json.format).toBe('jsonl')
    expect(json.rows).toBe(2)
    expect(json.sample[1]).toEqual({ values: { x: 23, y: 3.43 }, t: '2026-01-05T09:06:00.000Z' })
    expect(existsSync(join(workspace.dir, json.preserved))).toBe(false)
  })
})
