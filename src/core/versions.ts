/**
 * The row-level diff between two versions of a dataset.
 *
 * "The instrument re-exported, here's the corrected file" is the workflow this exists for, and its
 * answer has to be a count a person can act on: `+5 −3 ~8`. Counting is the easy half; deciding which
 * rows are the same row is the real question, and it is answered by the observation time.
 *
 * A row is identified by the instant it refers to. An export of readings has one row per reading, and
 * the reading's time is what survives a re-export — not its values (those are what got corrected) and
 * not its position (a sorted export can be reordered freely). Within one instant, rows are matched by
 * their values, so:
 *
 *   - equal values on both sides      → unchanged: no event, the parent's row is kept as it is
 *   - same time, different values     → changed (~): a correction against the parent's row
 *   - only in the new file            → added (+)
 *   - only in the parent              → removed (−): a retraction, so the parent version keeps it
 *
 * Values that are absent on one side and present on the other count as different, deliberately: a
 * gap that filled in is a change to the evidence, and calling it "unchanged" is how a diff lies.
 */
import type { PointValue } from './events.ts'

export interface DiffRow {
  /** The observation time, canonicalised: the row's identity. */
  t: string
  values: Record<string, PointValue>
  /** This row's own time is an import's estimate, not a measurement. */
  estimated?: true
}

/** A row plus the point it came from, when it came from the parent's log. */
export interface ParentRow extends DiffRow {
  id: string
  /** The parent's time is an import's estimate; the row it pairs with does not become one. */
  estimated?: true
}

export interface RowDiff {
  added: number
  removed: number
  changed: number
  addedRows: DiffRow[]
  /**
   * `before` is the parent's row, `after` the incoming one; `id` is the point to supersede, and
   * `estimated` says the time it already carries is an estimate — a re-read must not turn a
   * measured instant into one, nor an estimate into something that reads as measured.
   */
  changedRows: {
    id: string
    t: string
    before: Record<string, PointValue>
    after: Record<string, PointValue>
    estimated?: true
  }[]
  /** Rows the parent has that the file does not; `id` is the point to withdraw. */
  removedRows: ParentRow[]
}

/** Stable text for a row's values: key order cannot change the answer. */
function valueKey(values: Record<string, PointValue>, fields: string[]): string {
  const ordered: Record<string, PointValue> = {}
  for (const field of [...fields].sort()) {
    const value = values[field]
    if (value !== undefined) ordered[field] = value
  }
  return JSON.stringify(ordered)
}

/**
 * Compare the parent version's rows with a file's rows. `fields` narrows both sides to the shape's
 * own fields, so a column the shape does not declare cannot make two identical rows look different.
 */
export function diffRows(parent: ParentRow[], child: DiffRow[], fields: string[]): RowDiff {
  const byTime = new Map<string, { parent: ParentRow[]; child: DiffRow[] }>()
  for (const row of parent) {
    const group = byTime.get(row.t) ?? { parent: [], child: [] }
    group.parent.push(row)
    byTime.set(row.t, group)
  }
  for (const row of child) {
    const group = byTime.get(row.t) ?? { parent: [], child: [] }
    group.child.push(row)
    byTime.set(row.t, group)
  }

  const result: RowDiff = { added: 0, removed: 0, changed: 0, addedRows: [], changedRows: [], removedRows: [] }

  // Ordered by time and then by value, so the same pair of versions always reports the same list:
  // a diff that reshuffles itself between runs is not evidence about anything.
  for (const t of [...byTime.keys()].sort()) {
    const { parent: parents, child: children } = byTime.get(t)!
    const unmatchedParents = [...parents]
    const unmatchedChildren = [...children]

    // One-to-one on identical values, whatever order the two sides arrived in.
    for (const incoming of [...children].sort((a, b) => valueKey(a.values, fields).localeCompare(valueKey(b.values, fields)))) {
      const key = valueKey(incoming.values, fields)
      const index = unmatchedParents.findIndex((row) => valueKey(row.values, fields) === key)
      if (index === -1) continue
      unmatchedParents.splice(index, 1)
      unmatchedChildren.splice(unmatchedChildren.indexOf(incoming), 1)
    }

    unmatchedParents.sort((a, b) => (valueKey(a.values, fields) < valueKey(b.values, fields) ? -1 : 1))
    unmatchedChildren.sort((a, b) => (valueKey(a.values, fields) < valueKey(b.values, fields) ? -1 : 1))

    // What is left over pairs up: same instant, different values, so the parent's row was corrected.
    while (unmatchedParents.length > 0 && unmatchedChildren.length > 0) {
      const before = unmatchedParents.shift()!
      const after = unmatchedChildren.shift()!
      result.changed += 1
      result.changedRows.push({
        id: before.id,
        t,
        before: before.values,
        after: after.values,
        ...(before.estimated === true ? { estimated: true as const } : {}),
      })
    }
    for (const row of unmatchedChildren) {
      result.added += 1
      // An added row keeps the incoming instant, so its own label travels with it: a diff that
      // printed an estimate as a measurement would undo the point of labelling it at all.
      result.addedRows.push({
        t,
        values: row.values,
        ...(row.estimated === true ? { estimated: true as const } : {}),
      })
    }
    for (const row of unmatchedParents) {
      result.removed += 1
      result.removedRows.push(row)
    }
  }

  return result
}

/**
 * Compare a parent version with a file that has no clock, pairing rows by their position.
 *
 * An untimed file has nothing to identify a row by: its instants are estimates from the row order,
 * so matching them by instant would report every row leaving and every row arriving — the reading
 * this exists to replace. Order is therefore the identity here, and the consequences are said out
 * loud rather than hidden: a row whose values moved is a change against the row in its place, a
 * file with more rows has that many added, one with fewer has that many removed. If the file was
 * re-sorted, the values no longer line up and every row it disturbed reads as changed — which is
 * the honest answer to "these are the same positions with different readings".
 *
 * `changedRows[].t` is the parent's instant, which is the one the row keeps: a caller re-reading an
 * untimed file writes no `t_observed`, so the plan's fresh anchor is an argument about the file's
 * order and never an instant the row is given.
 */
export function diffRowsByOrder(parent: ParentRow[], child: DiffRow[], fields: string[]): RowDiff {
  const result: RowDiff = { added: 0, removed: 0, changed: 0, addedRows: [], changedRows: [], removedRows: [] }
  const shared = Math.min(parent.length, child.length)
  for (let index = 0; index < shared; index += 1) {
    const before = parent[index]!
    const after = child[index]!
    if (valueKey(before.values, fields) === valueKey(after.values, fields)) continue
    result.changed += 1
    // The row keeps the parent's own instant — the order identifies it, not a fresh anchor — so the
    // diff names that instant, which is the one the correction will leave in the log.
    result.changedRows.push({
      id: before.id,
      t: before.t,
      before: before.values,
      after: after.values,
      ...(before.estimated === true ? { estimated: true as const } : {}),
    })
  }
  for (const row of child.slice(shared)) {
    result.added += 1
    result.addedRows.push({
      t: row.t,
      values: row.values,
      ...(row.estimated === true ? { estimated: true as const } : {}),
    })
  }
  for (const row of parent.slice(shared)) {
    result.removed += 1
    result.removedRows.push(row)
  }
  return result
}

/** The `+n −n ~n` a person reads, in the order the requirements state it. */
export function diffCounts(diff: { added: number; removed: number; changed: number }): string {
  return `+${diff.added} −${diff.removed} ~${diff.changed}`
}
