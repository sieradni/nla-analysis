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
import { activeRowsOfVersion } from './binder.ts'
import { BenchError } from './errors.ts'
import { makeEvent } from './events.ts'
import type { BenchEvent, PointValue, Shape } from './events.ts'
import { validateValues } from './shapes.ts'
import { resolveImportColumns, suggestTimeColumn } from './import-columns.ts'
import { canonicalInstant } from './observation.ts'
import { coerce, parseDelimited, parseJsonl } from './table.ts'
import type { Table } from './table.ts'
import { diffRows, diffRowsByOrder, type RowDiff } from './versions.ts'
import type { Workspace } from './workspace.ts'

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
  /** The column that looks like the observation time, in the file's spelling, or null. */
  suggestedTime: string | null
  /**
   * The field the shape designates as its observation time, when it does. The sheet says so instead
   * of offering a choice: the declaration is the authority, and a picker beside it would ask a
   * question whose answer is already fixed.
   */
  timeField?: string
  /** These exact bytes were imported into this dataset before. */
  duplicate: boolean
  /** The version this import would create, and the versions already there. */
  version: number
  parent: number | null
  /** Rows in the parent version now, so a sheet can say what is being replaced before it is. */
  parentRows: number
}

export interface ImportRequest {
  /** Which dataset the rows land in. Absent means the workspace's usual rule (`main`). */
  dataset?: string
  /** Field name to column. Fields left out are matched by name, then refused if they have none. */
  mapping?: Record<string, string>
  /** Column holding the observation time. Absent means a recognised name, if the file has one. */
  time?: string
  /**
   * Source columns the caller has explicitly decided not to import. Every column with no shape
   * field must be named here, or the plan refuses: an extra column is data the shape cannot hold,
   * and dropping it without a decision is data loss. This is per invocation on purpose.
   */
  ignoreColumns?: string[]
  /** Use the file's row order instead of a time column; every row's instant is then an estimate. */
  estimate?: boolean
  /**
   * The instant an estimated row order is counted from: row 1 is this, each row one millisecond
   * later. Absent means now. Callers pass it when they need the same plan twice (a preview and the
   * write, or a test), never to make an estimate look measured.
   */
  estimateFrom?: string
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
  /** Source columns the caller named to leave out; empty when every column was used. */
  ignoredColumns: string[]
  /** The column a row's identity comes from; null when the file has none and the order is used. */
  timeColumn: string | null
  /** Every row's instant is an estimate from its position, and every row written says so. */
  estimated: boolean
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
  /**
   * The version this import writes. An import into a dataset that holds rows replaces them: it is a
   * new version with a diff, never an append onto whatever happened to be there (requirements §3.4).
   */
  version: number
  /** The version it replaces. Null for the first version of a dataset — there is nothing to diff. */
  parent: number | null
  /**
   * The parent has no record of its own (a dataset of hand-typed rows, or a project that predates
   * versions). The commit writes one down before the new version, so the chain has a first link that
   * anyone can read — and `bench dataset diff` can compare against it.
   */
  parentUnrecorded: boolean
  /** Row-level `+n −n ~n` against the parent, with the rows themselves so a report can name them. */
  diff: RowDiff
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
  const target = targetVersion(workspace, datasetId)
  return {
    ...previewOf(file, loaded),
    dataset: datasetId,
    shape: dataset.shape,
    fields: shape.fields,
    suggested,
    suggestedTime: suggestTimeColumn(loaded.table.columns, loaded.table.rows),
    ...(shape.time_field === undefined ? {} : { timeField: shape.time_field }),
    duplicate: workspace.allEvents.some(
      (event) => event.type === 'import_completed' && event.hash === hash && event.dataset === datasetId,
    ),
    version: target.version,
    parent: target.parent,
    parentRows: target.parent === null ? 0 : activeRowsOfVersion(workspace.state, datasetId, target.parent).length,
  }
}

/**
 * The version an import into this dataset would create, and what it would replace.
 *
 * A dataset that holds rows is at some version — recorded, or inferred as version 1 when the project
 * predates version records — and the import that follows it is one version newer. A dataset with
 * nothing in it gets version 1: there is nothing to replace and nothing to diff.
 */
function targetVersion(workspace: Workspace, datasetId: string): { version: number; parent: number | null } {
  const dataset = workspace.state.datasets.get(datasetId)
  const holdsRows = (dataset?.points.length ?? 0) > 0 || (dataset?.versions.length ?? 0) > 0
  if (!holdsRows) return { version: 1, parent: null }
  const parent = workspace.currentVersion(datasetId)
  return { version: parent + 1, parent }
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

  const { mapping, timeColumn, estimated, ignoredColumns, timeField, designatedColumn } =
    resolveImportColumns(shape, table.columns, request, table.rows)
  // An estimated row order is counted from one instant, so the rows are ordered and distinct on a
  // time axis while still being labelled as what they are. The anchor is the plan's, so a preview
  // and the write that follows it cannot hand out two different sets of instants.
  const anchor = estimated
    ? canonicalInstant(request.estimateFrom ?? new Date().toISOString(), 'the estimate')
    : null

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

    if (anchor !== null) {
      // Nothing in the file says when this happened. The estimate is the file's order, one
      // millisecond per row, and `validateValues` still sees the row's own values.
      const validation = validateValues(shape, values)
      if (validation.errors.length > 0) {
        errors.push(`${where}: ${validation.errors.join('; ')}`)
        return
      }
      for (const warning of validation.warnings) warnings.push(`${where}: ${warning}`)
      prepared.push({ values, t: new Date(Date.parse(anchor) + index).toISOString() })
      return
    }
    const raw = row[timeColumn!] ?? ''
    const milliseconds = Date.parse(raw)
    if (raw === '' || Number.isNaN(milliseconds)) {
      errors.push(`${where}: "${raw}" is not a parseable time`)
      return
    }
    const observed = new Date(milliseconds).toISOString()

    if (timeField !== undefined) {
      const fieldRaw = row[designatedColumn!] ?? ''
      const fieldMilliseconds = Date.parse(fieldRaw)
      if (fieldRaw === '' || Number.isNaN(fieldMilliseconds)) {
        errors.push(`${where}: field "${timeField.name}" carries the observation time, but "${fieldRaw}" is not a parseable time`)
        return
      }
      const fieldObserved = new Date(fieldMilliseconds).toISOString()
      if (fieldObserved !== observed) {
        // Two columns both claim to be the time and disagree. Choosing one silently would write a
        // point whose field and `t_observed` tell different stories, which is the split this model
        // exists to prevent.
        errors.push(
          `${where}: field "${timeField.name}" says ${fieldObserved}, but the time column "${timeColumn}" says ${observed}`,
        )
        return
      }
      // Canonicalise the field in the row too, so the version this import writes is consistent.
      values[timeField.name] = fieldObserved
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

  // What this import does to the rows that are already there. The diff is against the parent
  // version's rows, not against the current state's: a row a later version added is not the parent's
  // to remove, and a row the parent had is still the parent's even if it was corrected afterwards.
  const target = targetVersion(workspace, datasetId)
  const fields = Object.keys(Object.fromEntries(mapping))
  const parentPoints =
    target.parent === null ? [] : activeRowsOfVersion(workspace.state, datasetId, target.parent)
  const parentRows = parentPoints.map((point) => ({
    id: point.id,
    t: point.tObserved,
    values: point.values,
    ...(point.tEstimated === true ? { estimated: true as const } : {}),
  }))
  // A file with no clock is matched by the order its rows were recorded in, which is the order the
  // previous import wrote them. Reading that from the instants would mispair as soon as one row's
  // time had been corrected to a real instant and moved in the sorted list.
  const parentByOrder = [...parentPoints]
    .sort((left, right) =>
      left.recordedAt === right.recordedAt
        ? left.id.localeCompare(right.id)
        : left.recordedAt.localeCompare(right.recordedAt),
    )
    .map((point) => ({
      id: point.id,
      t: point.tObserved,
      values: point.values,
      ...(point.tEstimated === true ? { estimated: true as const } : {}),
    }))
  const incoming = prepared.map((row) => ({
    t: row.t,
    values: row.values,
    ...(estimated ? { estimated: true as const } : {}),
  }))
  // A file with no clock identifies its rows by position, not by an instant it does not have.
  const diff = estimated
    ? diffRowsByOrder(parentByOrder, incoming, fields)
    : diffRows(parentRows, incoming, fields)
  if (target.parent !== null && diff.added === 0 && diff.removed === 0 && diff.changed === 0 && request.force !== true) {
    throw new BenchError(
      'invalid',
      `version ${target.parent} already holds exactly these ${prepared.length} row(s)`,
      { hint: 'nothing would change; pass --force to record a version that replaces nothing' },
    )
  }

  return {
    file,
    dataset: datasetId,
    shape: dataset.shape,
    format,
    rows: prepared.length,
    columns: table.columns,
    mapping: Object.fromEntries(mapping),
    ignoredColumns,
    timeColumn,
    estimated,
    sourceHash: hash,
    raggedRows: table.raggedRows,
    comments: table.comments ?? 0,
    warnings,
    sample: prepared.slice(0, 3),
    preserved: `data/raw/${hash.slice(0, 12)}-${basename(file)}`,
    prepared,
    version: target.version,
    parent: target.parent,
    // `recorded` matters: the binder infers version 1 for a dataset that has rows and no version
    // event, and an inference is exactly what this flag exists to notice.
    parentUnrecorded:
      target.parent !== null &&
      !(workspace.state.datasets.get(datasetId)?.versions ?? []).some(
        (record) => record.version === target.parent && record.recorded,
      ),
    diff,
  }
}

/**
 * Write the plan: the original into `data/raw/` as evidence, then the version and everything it
 * changed in one append. The copy happens first, so a log that names a preserved file always has
 * that file.
 *
 * The order inside the append is the order a reader needs: the version record first, so every row
 * that follows names a version that exists, then the rows it brings, corrects and withdraws, then the
 * import record that names the file. Nothing is deleted: a withdrawn row is a `point_retracted`,
 * which is what keeps the parent version readable exactly as it was.
 */
export async function commitImport(
  workspace: Workspace,
  plan: ImportPlan,
): Promise<{ preserved: string; rows: number; version: number; parent: number | null; diff: RowDiff }> {
  await mkdir(join(workspace.dir, 'data', 'raw'), { recursive: true })
  await copyFile(plan.file, join(workspace.dir, plan.preserved))

  const source = basename(plan.file)
  const events: BenchEvent[] = []
  // The parent existed but was never written down. Record it first, with the row count the diff was
  // computed against, so the version chain has a readable first link instead of starting mid-story.
  if (plan.parent !== null && plan.parentUnrecorded) {
    // The parent's own rows: the file's rows, minus what it adds, plus what it withdraws. That is
    // what the diff was computed against, so the count and the diff cannot disagree.
    const parentRows = plan.rows - plan.diff.added + plan.diff.removed
    events.push(
      makeEvent('dataset_version_created', workspace.session, {
        dataset: plan.dataset,
        version: plan.parent,
        source: 'rows recorded before versions existed',
        hash: '',
        rows: parentRows,
      }),
    )
  }
  events.push(
    makeEvent('dataset_version_created', workspace.session, {
      dataset: plan.dataset,
      version: plan.version,
      source: plan.preserved,
      hash: plan.sourceHash,
      rows: plan.rows,
      ...(plan.parent === null ? {} : { parent: plan.parent }),
      ...(plan.parent === null
        ? {}
        : { diff: { added: plan.diff.added, removed: plan.diff.removed, changed: plan.diff.changed } }),
    }),
  )
  events.push(
    ...plan.diff.addedRows.map((row) =>
      makeEvent('point_recorded', workspace.session, {
        dataset: plan.dataset,
        shape: plan.shape,
        values: row.values,
        t_observed: row.t,
        ...(plan.estimated ? { t_estimated: true as const } : {}),
        version: plan.version,
        tags: ['import'],
      }),
    ),
  )
  const shape = workspace.state.shapes.get(plan.shape)
  const designatesTime = shape?.time_field !== undefined
  for (const row of plan.diff.changedRows) {
    events.push(
      makeEvent('point_corrected', workspace.session, {
        dataset: plan.dataset,
        supersedes: row.id,
        values: row.after,
        // A re-read that moves the designated field moves the instant with it. Without this the
        // correction would change `values.date` and leave the old `t_observed` behind. An estimated
        // re-read keeps the parent row's own instant — the row is identified by its place, not by a
        // new number — and says the time is still only an estimate.
        ...(designatesTime ? { t_observed: row.t } : {}),
        // A row whose time was already an estimate keeps saying so; a measured instant stays
        // measured, because re-reading an untimed file is not evidence against the time it had.
        ...(row.estimated === true ? { t_estimated: true as const } : {}),
        reason: `re-read from ${source} (version ${plan.version})`,
        version: plan.version,
      }),
    )
  }
  for (const row of plan.diff.removedRows) {
    events.push(
      makeEvent('point_retracted', workspace.session, {
        dataset: plan.dataset,
        supersedes: row.id,
        reason: `not in ${source}; replaced by version ${plan.version}`,
        version: plan.version,
      }),
    )
  }
  events.push(
    makeEvent('import_completed', workspace.session, {
      dataset: plan.dataset,
      file: plan.preserved,
      rows: plan.rows,
      hash: plan.sourceHash,
      columns: plan.columns,
      mapping: plan.mapping,
      ...(plan.ignoredColumns.length === 0 ? {} : { ignored_columns: plan.ignoredColumns }),
      ...(plan.estimated ? { time_estimated: true as const } : {}),
    }),
  )
  await workspace.appendAll(events)
  await workspace.writeStateBrief()
  return {
    preserved: plan.preserved,
    rows: plan.rows,
    version: plan.version,
    parent: plan.parent,
    diff: plan.diff,
  }
}
