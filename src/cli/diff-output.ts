import type { RowDiff } from '../core/versions.ts'
import type { PointValue } from '../core/events.ts'

/** Compact display for a value; six significant figures is more than a reader can use. */
export function shortNumber(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return String(Number(value.toPrecision(6)))
}

/** One row of a table, on one line: the fields it carries, in a stable order. */
function formatValues(values: Record<string, PointValue>): string {
  return Object.keys(values)
    .sort()
    .map((field) => `${field} ${typeof values[field] === 'number' ? shortNumber(values[field]) : JSON.stringify(values[field])}`)
    .join('  ')
}

/** The rows behind a diff, so a bare `+1 −1 ~1` is never the whole story. */
export function printDiffDetails(diff: RowDiff, limit: number): void {
  const show = (label: string, lines: string[]): void => {
    if (lines.length === 0) return
    process.stdout.write(`  ${label}:\n`)
    for (const line of lines.slice(0, limit)) process.stdout.write(`    ${line}\n`)
    if (lines.length > limit) process.stdout.write(`    … and ${lines.length - limit} more\n`)
  }
  show(`added ${diff.added}`, diff.addedRows.map((row) => `${row.t}  ${formatValues(row.values)}`))
  show(
    `changed ${diff.changed}`,
    diff.changedRows.map((row) => `${row.t}  ${formatValues(row.before)}  →  ${formatValues(row.after)}`),
  )
  show(`removed ${diff.removed}`, diff.removedRows.map((row) => `${row.t}  ${formatValues(row.values)}`))
}
