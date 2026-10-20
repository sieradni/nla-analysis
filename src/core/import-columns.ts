/**
 * Which source columns an import reads, and which it deliberately leaves behind.
 *
 * This is the one place the mapping, the observation-time column, and the rule about undeclared
 * columns is decided. `planImport` calls it once and then works only with the resolved mapping, so
 * the CLI, the window, and the plan cannot disagree about what a row means.
 */
import type { Shape, ShapeField } from './events.ts'
import { BenchError } from './errors.ts'
import { timeFieldOf } from './observation.ts'

/** The names a time column is allowed to have without being told. */
export const TIME_COLUMN_NAMES = ['t_observed', 'observed_at', 'timestamp', 'time', 'date', 't']

/**
 * The column a header suggests for the observation time, in the file's own spelling.
 *
 * A row is identified by its instant, so "which column is the time" is the one decision an import
 * cannot invent: guessing it from a name is a convenience, and failing to find one is a refusal
 * (see `resolveImportColumns`), not a fallback to the moment of import.
 */
export function suggestTimeColumn(columns: readonly string[]): string | null {
  const byLower = new Map(columns.map((column) => [column.toLowerCase(), column]))
  for (const name of TIME_COLUMN_NAMES) {
    const column = byLower.get(name)
    if (column !== undefined) return column
  }
  return null
}

export interface ImportColumnRequest {
  /** Field name to column. Fields left out are matched by name, then refused if they have none. */
  mapping?: Record<string, string>
  /** Column holding the observation time. Absent means the mapped designated field or a recognised name. */
  time?: string
  /** Source columns the caller has explicitly decided not to import. */
  ignoreColumns?: string[]
}

export interface ImportColumns {
  /** Shape field to source column. Every required field has one; optional fields may be absent. */
  mapping: Map<string, string>
  /** The column rows are identified by. */
  timeColumn: string
  /** Columns the caller explicitly left out because the shape has no field for them. */
  ignoredColumns: string[]
  /** The field the shape designates as the observation time, when there is one. */
  timeField?: ShapeField
  /** The column mapped to that field, when there is one. */
  designatedColumn?: string
}

export function resolveImportColumns(
  shape: Shape,
  columns: readonly string[],
  request: ImportColumnRequest = {},
): ImportColumns {
  const lowered = new Map(columns.map((column) => [column.toLowerCase(), column]))
  const mapping = new Map<string, string>()
  for (const field of shape.fields) {
    const column = request.mapping?.[field.name] ?? lowered.get(field.name.toLowerCase())
    if (column === undefined) {
      if (field.optional === true) continue
      throw new BenchError('invalid', `no column for the required field "${field.name}"`, {
        // The window maps it in the dialog; the CLI is the second door, so it names that too.
        hint: `the file has ${columns.join(', ')}; map a column onto "${field.name}" — the CLI does it with --map ${field.name}=<column>`,
      })
    }
    if (!columns.includes(column)) {
      throw new BenchError('invalid', `column "${column}" is not in the file`, {
        hint: `the file has ${columns.join(', ')}`,
      })
    }
    mapping.set(field.name, column)
  }

  // A designated field is the authority on when a row happened. When the shape has one, the column
  // mapped to it *is* the time column; `--time` may only name the same column or a second one that
  // must agree with it row by row. A shape that designates nothing keeps the old rule exactly.
  const timeField = timeFieldOf(shape)
  const designatedColumn = timeField === undefined ? undefined : mapping.get(timeField.name)
  // A sheet with no time column chosen sends `''`, which means the same as not saying it.
  const timeColumn =
    timeField === undefined
      ? request.time || suggestTimeColumn(columns)
      : request.time && request.time !== designatedColumn
        ? request.time
        : designatedColumn!
  if (timeColumn === null) {
    // Not a warning and not "the moment of import": rows stamped with one invented instant cannot
    // be told apart, so a re-import would read as every row leaving and every row arriving. The
    // refusal names the file's columns because the fix is to pick one of them.
    throw new BenchError(
      'invalid',
      `no column holds the observation time, so every row would share one invented instant — the file has ${columns.join(', ')}`,
      { hint: 'name the column that holds it: --time <column> in the CLI, or the time picker in the window' },
    )
  }
  if (!columns.includes(timeColumn)) {
    throw new BenchError('invalid', `no column "${timeColumn}" for the observation time`, {
      hint: `the file has ${columns.join(', ')}`,
    })
  }

  // A column the shape cannot hold is data loss unless the caller names it. The check is before any
  // row is read, so a refusal cannot leave a copy or a partial version behind.
  const usedColumns = new Set([...mapping.values(), timeColumn])
  const extraColumns = columns.filter((column) => !usedColumns.has(column))
  const requestedIgnored = [...new Set(request.ignoreColumns ?? [])]
  for (const column of requestedIgnored) {
    if (!columns.includes(column)) {
      throw new BenchError('invalid', `cannot ignore column "${column}" because the file has no such column`, {
        hint: `the file has ${columns.join(', ')}`,
      })
    }
    if (usedColumns.has(column)) {
      const field = [...mapping.entries()].find(([, mapped]) => mapped === column)?.[0]
      throw new BenchError(
        'invalid',
        field
          ? `column "${column}" is used by field "${field}" and cannot be ignored`
          : `column "${column}" holds the observation time and cannot be ignored`,
      )
    }
  }
  const undeclared = extraColumns.filter((column) => !requestedIgnored.includes(column))
  if (undeclared.length > 0) {
    const noun = undeclared.length === 1 ? 'column has' : 'columns have'
    throw new BenchError('invalid', `${undeclared.length} ${noun} no shape field: ${undeclared.join(', ')}`, {
      hint: `map each column to a field, or name it explicitly: ${undeclared.map((column) => `--ignore-unmapped ${column}`).join(' ')}`,
    })
  }

  return {
    mapping,
    timeColumn,
    ignoredColumns: extraColumns,
    ...(timeField === undefined ? {} : { timeField }),
    ...(designatedColumn === undefined ? {} : { designatedColumn }),
  }
}
