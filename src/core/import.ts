/**
 * Importing a table. One parser, one mapping rule, one write path, shared by `bench import` and the
 * window's import dialog — so a file imports the same way whichever door it came through.
 *
 * Reading is separate from writing on purpose: the window shows the columns and a sample before
 * anyone chooses a mapping, and a refusal (a bad row, a column that is not there) must happen before
 * a single event is appended. `planImport` answers every question; `commitImport` is the only part
 * that touches the disk, and it appends the points and the import record together or not at all.
 */
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { BenchError } from './errors.ts'
import { makeEvent } from './events.ts'
import type { BenchEvent, PointValue, Shape } from './events.ts'
import { validateValues } from './shapes.ts'
import { coerce, parseDelimited, parseJsonl } from './table.ts'
import type { Table } from './table.ts'
import type { Workspace } from './workspace.ts'

/** The names a time column is allowed to have without being told. */
export const TIME_COLUMN_NAMES = ['t_observed', 'observed_at', 'timestamp', 'time', 'date', 't']

export type ImportFormat = 'csv' | 'tsv' | 'jsonl'

export function formatFor(file: string): ImportFormat {
  const lower = file.toLowerCase()
  if (lower.endsWith('.jsonl') || lower.endsWith('.ndjson')) return 'jsonl'
  if (lower.endsWith('.tsv') || lower.endsWith('.tab')) return 'tsv'
  return 'csv'
}

/** A table as read, before a shape is involved: what the dialog can show about any file. */
export interface TablePreview {
  file: string
  format: ImportFormat
  columns: string[]
  /** The first rows, as strings. Coercion waits for a declared field type. */
  sample: Record<string, string>[]
  rows: number
  /** Rows whose field count disagreed with the header. */
  raggedRows: number
  comments: number
}

/** A table plus the project it would land in: the last thing shown before a mapping is chosen. */
export interface ImportPreview extends TablePreview {
  dataset: string
  shape: string
  fields: Shape['fields']
  /** Field name to column, for the fields whose name matches a column. A suggestion, not a rule. */
  suggested: Record<string, string>
  /** These exact bytes were imported into this dataset before. */
  duplicate: boolean
}

export interface ImportRequest {
  /** Which dataset the rows land in. Absent means the workspace's usual rule (`main`). */
  dataset?: string
  /** Field name to column. Fields left out are matched by name, then refused if they have none. */
  mapping?: Record<string, string>
  /** Column holding the observation time. Absent means a recognised name, if the file has one. */
  time?: string
  force?: boolean
  /** Overrides the guess from the filename. */
  format?: ImportFormat
}

export interface ImportPlan {
  file: string
  dataset: string
  shape: string
  format: ImportFormat
  rows: number
  columns: string[]
  mapping: Record<string, string>
  timeColumn: string | null
  sourceHash: string
  raggedRows: number
  comments: number
  warnings: string[]
  /** The first rows after coercion and validation, for a preview that says what will be written. */
  sample: { values: Record<string, PointValue>; t: string }[]
  /** Where the original will be preserved, relative to the project. */
  preserved: string
  /** Every row that will become a point. Not exported by the window, but commit needs it. */
  prepared: { values: Record<string, PointValue>; t: string }[]
}

interface Loaded {
  text: string
  table: Table
  format: ImportFormat
}

async function load(file: string, format?: ImportFormat): Promise<Loaded> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    throw new BenchError('missing', `cannot read ${file}`)
  }
  const actual = format ?? formatFor(file)
  const table =
    actual === 'jsonl'
      ? parseJsonl(text)
      : parseDelimited(text, actual === 'tsv' ? '\t' : undefined)
  if (table.rows.length === 0) {
    throw new BenchError('invalid', 'the file has no data rows', {
      hint: `columns found: ${table.columns.join(', ') || 'none'}`,
    })
  }
  return { text, table, format: actual }
}

function previewOf(file: string, loaded: Loaded): TablePreview {
  return {
    file,
    format: loaded.format,
    columns: loaded.table.columns,
    sample: loaded.table.rows.slice(0, 5),
    rows: loaded.table.rows.length,
    raggedRows: loaded.table.raggedRows,
    comments: loaded.table.comments ?? 0,
  }
}

/** Read a table without a project: columns, a sample and what the parser skipped. */
export async function readTable(file: string, format?: ImportFormat): Promise<TablePreview> {
  return previewOf(file, await load(file, format))
}

function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * What the dialog shows before a mapping is chosen: the file's columns and a sample, the shape's
 * fields, and the columns whose names already match them. Nothing is written.
 */
export async function previewImport(workspace: Workspace, file: string): Promise<ImportPreview> {
  const datasetId = workspace.resolveDataset()
  const dataset = workspace.dataset(datasetId)
  const shape = workspace.shapeOf(datasetId)
  const loaded = await load(file)

  const lowered = new Map(loaded.table.columns.map((column) => [column.toLowerCase(), column]))
  const suggested: Record<string, string> = {}
  for (const field of shape.fields) {
    const column = lowered.get(field.name.toLowerCase())
    if (column !== undefined) suggested[field.name] = column
  }

  const hash = hashOf(loaded.text)
  return {
    ...previewOf(file, loaded),
    dataset: datasetId,
    shape: dataset.shape,
    fields: shape.fields,
    suggested,
    duplicate: workspace.allEvents.some(
      (event) => event.type === 'import_completed' && event.hash === hash && event.dataset === datasetId,
    ),
  }
}

/**
 * Parse, map and validate every row. Refuses as a whole when any row would not land, naming the
 * rows and the fields, so an import never leaves half a file in the log.
 */
export async function planImport(
  workspace: Workspace,
  file: string,
  request: ImportRequest = {},
): Promise<ImportPlan> {
  const datasetId = workspace.resolveDataset(request.dataset)
  const dataset = workspace.dataset(datasetId)
  const shape = workspace.shapeOf(datasetId)
  const loaded = await load(file, request.format)
  const { table, text, format } = loaded

  const lowered = new Map(table.columns.map((column) => [column.toLowerCase(), column]))
  const mapping = new Map<string, string>()
  for (const field of shape.fields) {
    const column = request.mapping?.[field.name] ?? lowered.get(field.name.toLowerCase())
    if (column === undefined) {
      if (field.optional === true) continue
      throw new BenchError('invalid', `no column for the required field "${field.name}"`, {
        // The window maps it in the dialog; the CLI is the second door, so it names that too.
        hint: `the file has ${table.columns.join(', ')}; map a column onto "${field.name}" — the CLI does it with --map ${field.name}=<column>`,
      })
    }
    if (!table.columns.includes(column)) {
      throw new BenchError('invalid', `column "${column}" is not in the file`, {
        hint: `the file has ${table.columns.join(', ')}`,
      })
    }
    mapping.set(field.name, column)
  }

  const timeColumn = request.time ?? TIME_COLUMN_NAMES.find((name) => lowered.has(name))
  if (timeColumn !== undefined && !table.columns.includes(timeColumn)) {
    throw new BenchError('invalid', `no column "${timeColumn}" for the observation time`, {
      hint: `the file has ${table.columns.join(', ')}`,
    })
  }

  const errors: string[] = []
  const warnings: string[] = []
  const prepared: { values: Record<string, PointValue>; t: string }[] = []

  table.rows.forEach((row, index) => {
    const where = `row ${index + 2}`
    const values: Record<string, PointValue> = {}
    for (const field of shape.fields) {
      const column = mapping.get(field.name)
      if (column === undefined) continue
      // Absent cells are dropped rather than defaulted, so a gap is a gap and validation sees it.
      const value = coerce(row[column] ?? '', field.type)
      if (value !== null) values[field.name] = value
    }

    let observed = new Date().toISOString()
    if (timeColumn !== undefined) {
      const raw = row[timeColumn] ?? ''
      const milliseconds = Date.parse(raw)
      if (raw === '' || Number.isNaN(milliseconds)) {
        errors.push(`${where}: "${raw}" is not a parseable time`)
        return
      }
      observed = new Date(milliseconds).toISOString()
    }

    const validation = validateValues(shape, values)
    if (validation.errors.length > 0) {
      errors.push(`${where}: ${validation.errors.join('; ')}`)
      return
    }
    for (const warning of validation.warnings) warnings.push(`${where}: ${warning}`)
    prepared.push({ values, t: observed })
  })

  if (errors.length > 0) {
    throw new BenchError('invalid', `${errors.length} row(s) would not import, so none were`, {
      problems: [...errors.slice(0, 5), ...(errors.length > 5 ? [`… and ${errors.length - 5} more`] : [])],
      hint: 'fix the file, or fix the mapping',
    })
  }

  const hash = hashOf(text)
  const reimport = workspace.allEvents.find(
    (event) => event.type === 'import_completed' && event.hash === hash && event.dataset === datasetId,
  )
  if (reimport && request.force !== true) {
    throw new BenchError('invalid', `these exact contents were already imported into "${datasetId}"`, {
      hint: 'import these exact contents again only on purpose',
    })
  }

  return {
    file,
    dataset: datasetId,
    shape: dataset.shape,
    format,
    rows: prepared.length,
    columns: table.columns,
    mapping: Object.fromEntries(mapping),
    timeColumn: timeColumn ?? null,
    sourceHash: hash,
    raggedRows: table.raggedRows,
    comments: table.comments ?? 0,
    warnings,
    sample: prepared.slice(0, 3),
    preserved: `data/raw/${hash.slice(0, 12)}-${basename(file)}`,
    prepared,
  }
}

/**
 * Write the plan: the original into `data/raw/` as evidence, the points and the import record in one
 * append. The copy happens first, so a log that names a preserved file always has that file.
 */
export async function commitImport(
  workspace: Workspace,
  plan: ImportPlan,
): Promise<{ preserved: string; rows: number }> {
  await mkdir(join(workspace.dir, 'data', 'raw'), { recursive: true })
  await copyFile(plan.file, join(workspace.dir, plan.preserved))

  const events: BenchEvent[] = plan.prepared.map((point) =>
    makeEvent('point_recorded', workspace.session, {
      dataset: plan.dataset,
      shape: plan.shape,
      values: point.values,
      t_observed: point.t,
      tags: ['import'],
    }),
  )
  events.push(
    makeEvent('import_completed', workspace.session, {
      dataset: plan.dataset,
      file: plan.preserved,
      rows: plan.rows,
      hash: plan.sourceHash,
      columns: plan.columns,
      mapping: plan.mapping,
    }),
  )
  await workspace.appendAll(events)
  await workspace.writeStateBrief()
  return { preserved: plan.preserved, rows: plan.rows }
}
