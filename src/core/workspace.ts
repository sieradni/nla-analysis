/**
 * The one in-process path to a project. See ADR 0003.
 *
 * `bench`, a script, and (later) the app all drive a project through this class, so none of them can
 * diverge from the others: there is one implementation of appending a point, one of recording an
 * analysis, and one of deciding what an artifact says. The CLI is argument parsing around these
 * calls; it holds no project logic of its own.
 *
 * Two things this module deliberately does *not* do:
 *
 * - **Exit the process.** Refusals are thrown as `BenchError`; a GUI has no exit code to set, and a
 *   library that kills its host cannot be embedded.
 * - **Own a process.** The Python runner is passed in, because a command that exits wants a runner
 *   per command and a window that stays open wants one for the session.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { APP_ROOT, assessRuns, buildRunInput, chartSpecFor, hashInput, type RunFreshness } from './analysis.ts'
import { activePoints, activeRowsOfVersion, bind, type DatasetVersion, type Point, type ProjectState, type RunRecord } from './binder.ts'
import { renderChart, type ChartSpec } from './chart.ts'
import { BenchError } from './errors.ts'
import { addHint } from './hints.ts'
import { sameStamp, type LogStamp } from './log.ts'
import { makeEvent } from './events.ts'
import type { BenchEvent, PointValue, Shape, ShapeField } from './events.ts'
import {
  DEFAULT_DATASET,
  findProjectDir,
  openProject,
  writeStateBrief,
  type ProjectConfig,
  type ProjectHandle,
} from './project.ts'
import type { RecipeRunner, RunResult } from './runner.ts'
import {
  latestShapeOf,
  planShapeExtension,
  planTimeDesignation,
  validateValues,
  type ShapeFieldInput,
} from './shapes.ts'
import { resolveObservation } from './observation.ts'
import { diffRows } from './versions.ts'

// Re-exported so existing callers (the CLI, the tests) keep importing the refusal from the seam that
// raises it; the definition lives in errors.ts so modules that are not the write path can use it too.
export { BenchError, type ErrorKind } from './errors.ts'

export interface PointDraft {
  dataset?: string
  values: Record<string, PointValue>
  /** When the value was observed. Defaults to now; normalised to canonical UTC. */
  tObserved?: string
  note?: string
  tags?: string[]
}

export interface RecordedPoint {
  event: BenchEvent
  dataset: string
  shape: string
  tObserved: string
  warnings: string[]
}

export interface ShapeExtension {
  event: BenchEvent
  from: Shape
  shape: Shape
  field: ShapeField
  /** Datasets that moved to the new declaration; points already recorded did not move. */
  datasets: string[]
}

export interface ShapeTimeDesignation {
  event: BenchEvent
  from: Shape
  shape: Shape
  field: ShapeField
  /** Datasets that moved to the new declaration; points already recorded did not move. */
  datasets: string[]
}

export interface DatasetView {
  id: string
  shape: string
  definition?: Shape
  /** Active points only: a retracted point is history, not evidence. */
  points: Point[]
}

export interface PointCorrection {
  event: BenchEvent
  dataset: string
  values: Record<string, PointValue>
  now: Record<string, PointValue>
  /** Present when the correction moved the row's canonical time (a designated field, or `--at`). */
  tObserved?: string
  /** The row's time is still an estimate from an import's row order. */
  estimated: boolean
}

export interface PointRetraction {
  event: BenchEvent
  dataset: string
  active: number
}

export interface PointRestoration {
  event: BenchEvent
  dataset: string
  /** The retraction this reversed: the act an undo undid. */
  retraction: string
  active: number
}

export interface VersionRestore {
  event: BenchEvent
  dataset: string
  /** The new version this restore wrote. */
  version: number
  /** The version it replaced: the one that was current before the restore. */
  parent: number
  /** The older version whose rows were restored; null means the empty dataset before version 1. */
  restoredFrom: number | null
  rows: number
  diff: { added: number; removed: number; changed: number }
  active: number
}

export interface AnalysisRequest {
  recipe: string
  params: Record<string, unknown>
  dataset?: string
  /** A caller-supplied artifact path, used verbatim as it is today. */
  chartPath?: string
  /** The run this one repeats, when the parameters came from an earlier run. */
  repeatOf?: RunRecord
}

export interface AnalysisOutcome {
  event: BenchEvent
  result: RunResult
  dataset: string
  params: Record<string, unknown>
  artifactRef: string
  verdictChanged?: boolean
}

/** Two value maps hold the same row when every key is present on both sides with the same value. */
function sameValues(left: Record<string, PointValue>, right: Record<string, PointValue>): boolean {
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every((key) => Object.hasOwn(right, key) && left[key] === right[key])
}

export class Workspace {
  // Declared as fields rather than constructor parameter properties: Node's type-stripping mode
  // rejects the latter outright, and the tests' transpiler accepts it, so the CLI dies while the
  // suite stays green. That gap has bitten this project once already.
  private events: BenchEvent[]
  private current: ProjectState
  private logProblems: string[]
  /**
   * The file as this workspace last saw it. Every mutation checks this first: a window that stays
   * open while an agent appends through `bench` would otherwise fold its own event onto a bind that
   * never contained the agent's, and then persist counts — into STATE.md and into a tab's saved
   * view — that contradict the log. The check is one `stat`; the repair is a re-read.
   */
  private logStamp: LogStamp | null = null
  /** How many times the log has been read from disk. Callers use it to report a repair, not to make one. */
  private reads = 0

  /** The open project: its directory, config, log and session id. */
  readonly handle: ProjectHandle

  private constructor(
    handle: ProjectHandle,
    events: BenchEvent[],
    state: ProjectState,
    logProblems: string[],
    logStamp: LogStamp | null,
  ) {
    this.handle = handle
    this.events = events
    this.current = state
    this.logProblems = logProblems
    this.logStamp = logStamp
    this.reads = 1
  }

  /** Open the project containing `dir`, or at `dir` itself. */
  static async open(dir: string, session?: string): Promise<Workspace> {
    const found = await findProjectDir(dir)
    if (!found) {
      throw new BenchError('missing', 'not inside a bench project', {
        hint: 'run `bench init <dir>` first',
      })
    }
    const handle = session === undefined ? await openProject(found) : await openProject(found, session)
    // Stamped *before* the read on purpose: a write landing in between leaves us stamped older than
    // the file, so the next check rereads. The opposite order would let a concurrent append be
    // attributed to our own read, which is the one mistake that cannot be recovered from.
    const stamp = await handle.log.stamp()
    const { events, problems } = await handle.log.read()
    return new Workspace(handle, events, bind(events), problems, stamp)
  }

  // --- reading -------------------------------------------------------------------------------

  get dir(): string {
    return this.handle.dir
  }

  get config(): ProjectConfig {
    return this.handle.config
  }

  get session(): string {
    return this.handle.session
  }

  /** The state as of the last write. Cheap: no filesystem access. */
  get state(): ProjectState {
    return this.current
  }

  get allEvents(): readonly BenchEvent[] {
    return this.events
  }

  /** Problems found while reading the log, as opposed to while folding it. */
  get problems(): string[] {
    return this.logProblems
  }

  /** How many times this workspace has read the log. A change means a repair happened. */
  get logReads(): number {
    return this.reads
  }

  /**
   * Resolve a dataset id the way every command does: the one asked for, else `main`, else the only
   * one there is. Asking for a project with several datasets without saying which is a refusal, not
   * a coin toss.
   *
   * An id that was asked for is returned as asked, even if it does not exist: the caller's next step
   * refuses it properly. Substituting `main` for a mistyped id would answer a different question than
   * the one posed, and answer it silently.
   */
  resolveDataset(requested?: string): string {
    if (requested !== undefined) return requested
    if (this.current.datasets.has(DEFAULT_DATASET)) return DEFAULT_DATASET
    const ids = [...this.current.datasets.keys()]
    if (ids.length === 1) return ids[0]!
    if (ids.length === 0) {
      throw new BenchError('missing', 'project has no datasets', {
        hint: 'run `bench init` in a new folder',
      })
    }
    throw new BenchError('invalid', 'project has several datasets', { hint: 'pass --dataset <id>' })
  }

  dataset(which?: string): DatasetView {
    const id = this.resolveDataset(which)
    const dataset = this.current.datasets.get(id)
    if (!dataset) throw new BenchError('missing', `no dataset "${id}"`)
    const definition = this.current.shapes.get(dataset.shape)
    return {
      id,
      shape: dataset.shape,
      ...(definition === undefined ? {} : { definition }),
      points: activePoints(this.current, id),
    }
  }

  /** The dataset's shape, or a refusal — never a silent fallback to some other shape. */
  shapeOf(datasetId: string): Shape {
    const dataset = this.current.datasets.get(datasetId)
    if (!dataset) throw new BenchError('missing', `no dataset "${datasetId}"`)
    const shape = this.current.shapes.get(dataset.shape)
    if (!shape) {
      throw new BenchError('invariant', `dataset "${datasetId}" references unknown shape "${dataset.shape}"`)
    }
    return shape
  }

  /** The datasets a shape mutation moves; points do not move with them. */
  private datasetsUsing(shapeId: string): string[] {
    return [...this.current.datasets.values()]
      .filter((dataset) => dataset.shape === shapeId)
      .map((dataset) => dataset.id)
  }

  /**
   * Add one field to a shape as a new version. This is the only way a declared shape grows: the old
   * declaration and every point written against it stay untouched, and the extension is its own
   * event, so `bench check` can validate the history instead of trusting the newest definition.
   */
  async extendShape(fromId: string, input: ShapeFieldInput): Promise<ShapeExtension> {
    await this.freshen()
    const from = this.current.shapes.get(fromId)
    if (!from) throw new BenchError('missing', `no shape "${fromId}"`)

    // A base has one newest declaration, and an extension of an older one would fork the history
    // into two shapes that both claim to be next. `shapes.ts` owns which version that is.
    const latest = latestShapeOf(this.current.shapes.values(), from)
    if (latest.id !== from.id) {
      throw new BenchError('invalid', `shape "${from.id}" is not the latest version`, {
        hint: `extend "${latest.id}" instead`,
      })
    }

    const plan = planShapeExtension(from, input)
    if (this.current.shapes.has(plan.shape.id)) {
      throw new BenchError('invalid', `shape "${plan.shape.id}" already exists`)
    }
    const datasets = this.datasetsUsing(from.id)

    const event = makeEvent('shape_extended', this.handle.session, {
      from: from.id,
      shape: plan.shape,
      field: plan.field,
    })
    await this.append([event])
    return { event, from, shape: plan.shape, field: plan.field, datasets }
  }

  /**
   * Designate which field carries the observation time, as a new shape version. The field list is
   * unchanged and no point moves: from now on every recording door derives `t_observed` from the
   * field, and the declaration itself is the record of that decision.
   */
  async designateShapeTime(fromId: string, fieldName: string): Promise<ShapeTimeDesignation> {
    await this.freshen()
    const from = this.current.shapes.get(fromId)
    if (!from) throw new BenchError('missing', `no shape "${fromId}"`)
    const latest = latestShapeOf(this.current.shapes.values(), from)
    if (latest.id !== from.id) {
      throw new BenchError('invalid', `shape "${from.id}" is not the latest version`, {
        hint: `designate "${latest.id}" instead`,
      })
    }

    // `shapes.ts` owns the next declaration, including the canonical field name and the refusal to
    // move a designation that already exists. The event repeats that canonical name.
    const shape = planTimeDesignation(from, fieldName)
    if (this.current.shapes.has(shape.id)) {
      throw new BenchError('invalid', `shape "${shape.id}" already exists`)
    }
    const datasets = this.datasetsUsing(from.id)

    const event = makeEvent('shape_time_designated', this.handle.session, {
      from: from.id,
      shape,
      time_field: shape.time_field!,
    })
    await this.append([event])
    return {
      event,
      from,
      shape,
      field: shape.fields.find((field) => field.name === shape.time_field)!,
      datasets,
    }
  }

  /**
   * The version a new row lands in: the dataset's newest. Adding a point grows the current version
   * rather than making a new one, which is the difference between "one more reading" and "here is
   * the whole file again". An unknown dataset is a refusal, not version 1.
   */
  currentVersion(datasetId: string): number {
    const dataset = this.current.datasets.get(datasetId)
    if (!dataset) throw new BenchError('missing', `no dataset "${datasetId}"`)
    return dataset.version
  }

  /** Every version of a dataset, oldest first. The records themselves, as they were written. */
  versions(datasetId: string): DatasetVersion[] {
    const dataset = this.current.datasets.get(datasetId)
    if (!dataset) throw new BenchError('missing', `no dataset "${datasetId}"`)
    return dataset.versions.map((record) => ({ ...record }))
  }

  /**
   * The rows one version holds now: active, and rebuilt from the log when it is not the newest.
   * A version that was never created is refused: returning the newest rows for it would answer a
   * question about one version with another version's rows, which is the one thing this API exists
   * not to do.
   */
  rowsOfVersion(datasetId: string, version: number): Point[] {
    const dataset = this.current.datasets.get(datasetId)
    if (!dataset) throw new BenchError('missing', `no dataset "${datasetId}"`)
    if (!dataset.versions.some((record) => record.version === version)) {
      throw new BenchError('missing', `dataset "${datasetId}" has no version ${version}`, {
        hint: `versions: ${dataset.versions.map((record) => record.version).join(', ')}`,
      })
    }
    return activeRowsOfVersion(this.current, datasetId, version)
  }

  /**
   * Make an older version current again, as a *new* version. This is the inverse of an import.
   *
   * Nothing is deleted and no past version changes: the new version's rows are the old version's
   * rows, brought back by the same acts a person would perform by hand — a retraction for a row the
   * newer version added, a restore for a row it withdrew, a correction for a row it changed. Those
   * acts name the new version, so folding any earlier version still reads exactly as it did. The
   * `dataset_version_created` record is what makes the restore a version rather than a pile of edits;
   * it names the version it restored and carries the diff against the one it replaced.
   *
   * `version` is an older version of this dataset. `null` means the empty dataset before version 1,
   * which is the only thing there is to restore when the first import created version 1.
   */
  async restoreVersion(datasetId: string, version: number | null): Promise<VersionRestore> {
    await this.freshen()
    const dataset = this.current.datasets.get(datasetId)
    if (!dataset) throw new BenchError('missing', `no dataset "${datasetId}"`)
    const current = dataset.version
    const known = dataset.versions.map((record) => record.version)
    if (known.length === 0) {
      throw new BenchError('missing', `dataset "${datasetId}" has no versions`, {
        hint: 'nothing has been imported or recorded in a version',
      })
    }
    if (version === null) {
      // "No rows" is only an older state when there is exactly one version to go back beyond. On a
      // dataset that has moved on, naming no version would wipe rows nobody asked to lose.
      if (current !== 1) {
        throw new BenchError('invalid', 'only the first version can be restored to an empty dataset', {
          hint: `name an older version: ${known.join(', ')}`,
        })
      }
    } else {
      if (!known.includes(version)) {
        throw new BenchError('missing', `dataset "${datasetId}" has no version ${version}`, {
          hint: `versions: ${known.join(', ')}`,
        })
      }
      if (version >= current) {
        throw new BenchError('invalid', `version ${version} is not older than the current version ${current}`, {
          hint: 'name the version the data should go back to',
        })
      }
    }

    const targetRows = version === null ? [] : this.rowsOfVersion(datasetId, version)
    const currentRows = activePoints(this.current, datasetId)
    const shape = this.shapeOf(datasetId)
    const fields = shape.fields.map((field) => field.name)
    const next = current + 1
    const from = version === null ? 'the empty dataset before version 1' : `version ${version}`
    const diff = diffRows(
      currentRows.map((point) => ({ id: point.id, t: point.tObserved, values: point.values })),
      targetRows.map((point) => ({ t: point.tObserved, values: point.values })),
      fields,
    )

    const events: BenchEvent[] = [
      makeEvent('dataset_version_created', this.handle.session, {
        dataset: datasetId,
        version: next,
        source: `restored from ${from}`,
        hash: '',
        rows: targetRows.length,
        parent: current,
        diff: { added: diff.added, removed: diff.removed, changed: diff.changed },
      }),
    ]

    // Rows the version being replaced added: they leave, exactly as an import's new rows do.
    const wanted = new Set(targetRows.map((point) => point.id))
    for (const point of currentRows) {
      if (wanted.has(point.id)) continue
      events.push(
        makeEvent('point_retracted', this.handle.session, {
          dataset: datasetId,
          supersedes: point.id,
          reason: `not in ${from}; restored`,
          version: next,
        }),
      )
    }

    const byId = new Map(dataset.points.map((point) => [point.id, point]))
    for (const row of targetRows) {
      const now = byId.get(row.id)
      // Defensive: a version's rows are points the log recorded, so every one has a fold entry. A
      // missing one would be a log problem, and recording the row is the honest repair.
      if (!now) {
        events.push(
          makeEvent('point_recorded', this.handle.session, {
            dataset: datasetId,
            shape: row.shape,
            values: { ...row.values },
            t_observed: row.tObserved,
            version: next,
          }),
        )
        continue
      }

      // A correction merges values; it cannot unset a field. A field this row gained after the
      // restored version was current would survive the merge and the new version would not hold the
      // row it claims to. So that row is recorded afresh with exactly the older version's values.
      const gained = Object.keys(now.values).filter((key) => !Object.hasOwn(row.values, key))
      const unableToMoveTime = now.tObserved !== row.tObserved && shape.time_field === undefined
      if (gained.length > 0 || unableToMoveTime) {
        if (now.status === 'active') {
          events.push(
            makeEvent('point_retracted', this.handle.session, {
              dataset: datasetId,
              supersedes: now.id,
              reason: `replaced by ${from}; restored`,
              version: next,
            }),
          )
        }
        events.push(
          makeEvent('point_recorded', this.handle.session, {
            dataset: datasetId,
            shape: row.shape,
            values: { ...row.values },
            t_observed: row.tObserved,
            version: next,
          }),
        )
        continue
      }

      if (now.status === 'retracted') {
        if (now.retractedBy === undefined) {
          throw new BenchError('invariant', `point "${row.id}" is retracted but names no retraction`, {
            hint: 'the log was written by something other than bench; `bench check` reports the rest',
          })
        }
        events.push(
          makeEvent('point_restored', this.handle.session, {
            dataset: datasetId,
            restores: now.retractedBy,
            version: next,
          }),
        )
      }
      if (!sameValues(now.values, row.values) || now.tObserved !== row.tObserved) {
        events.push(
          makeEvent('point_corrected', this.handle.session, {
            dataset: datasetId,
            supersedes: row.id,
            values: { ...row.values },
            ...(shape.time_field === undefined ? {} : { t_observed: row.tObserved }),
            reason: `restored from ${from}`,
            version: next,
          }),
        )
      }
    }

    const event = events[0]!
    await this.append(events)
    return {
      event,
      dataset: datasetId,
      version: next,
      parent: current,
      restoredFrom: version,
      rows: targetRows.length,
      diff: { added: diff.added, removed: diff.removed, changed: diff.changed },
      active: activePoints(this.current, datasetId).length,
    }
  }

  findPoint(id: string): { dataset: string; point: Point } | undefined {
    for (const dataset of this.current.datasets.values()) {
      const point = dataset.points.find((candidate) => candidate.id === id)
      if (point) return { dataset: dataset.id, point }
    }
    return undefined
  }

  runsNewestFirst(): RunRecord[] {
    return [...this.current.runs].reverse()
  }

  /** Freshness per run id. Needs the recipe files, so it is asynchronous and lives off the hot path. */
  freshestRuns(): Promise<Map<string, RunFreshness>> {
    return assessRuns(APP_ROOT, this.current)
  }

  // --- freshness -----------------------------------------------------------------------------

  /**
   * Whether the log on disk is still the one this workspace bound.
   *
   * The check is a `stat` (45 µs measured) and the repair is a re-read (21 ms at 10k points). Paying
   * microseconds on every mutation to avoid a repair that costs milliseconds *and* produces a number
   * nobody can trace is not a close call. See ADR 0007.
   */
  async isStale(): Promise<boolean> {
    return !sameStamp(await this.handle.log.stamp(), this.logStamp)
  }

  /**
   * Re-read the log if someone else has written since this workspace read it. Returns true when a
   * repair happened, so a caller can say so rather than pretending it knew all along.
   */
  async freshen(): Promise<boolean> {
    if (!(await this.isStale())) return false
    await this.pull()
    return true
  }

  /**
   * Re-read the log from disk. Use when another process may have appended.
   *
   * The stamp is taken before the read, for the same reason `open` does it: an append that lands
   * while we are reading leaves us stamped older than the file, and the worst outcome is one extra
   * re-read — never a silently missed event.
   */
  async pull(): Promise<ProjectState> {
    const stamp = await this.handle.log.stamp()
    const { events, problems } = await this.handle.log.read()
    this.events = events
    this.logProblems = problems
    this.current = bind(events)
    this.logStamp = stamp
    this.reads += 1
    return this.current
  }

  // --- writing -------------------------------------------------------------------------------

  /**
   * Append to the log, fold it into the in-memory state, and leave the disk brief alone.
   *
   * Folding into memory rather than re-reading the file is what keeps a keystroke inside budget
   * (ADR 0003: 15.7 ms versus a full re-read on top). The freshness check at the top is the backstop
   * for the invariant: no write may be built on a bind that no longer matches the file. The mutating
   * methods below check earlier still, before they *read* the state they validate against.
   */
  private async append(events: BenchEvent[]): Promise<void> {
    if (events.length === 0) return
    await this.freshen()
    const before = this.logStamp
    const written = await this.handle.log.appendMany(events)
    this.events = [...this.events, ...events]
    this.current = bind(this.events)
    const after = await this.handle.log.stamp()
    // The file must have grown by exactly what we wrote. More than that means another writer put an
    // event in beside ours, and the bind we just built does not contain it — so forget the stamp and
    // let the next check reread, rather than believing a size that includes an event we never read.
    this.logStamp =
      before !== null && after !== null && after.size === before.size + written ? after : null
  }

  /** Write STATE.md from the current state. The CLI does this after every mutation. */
  async writeStateBrief(): Promise<void> {
    // It persists, so it checks first: a brief written from a bind the file has moved past is a lie
    // of exactly the kind this whole mechanism exists to prevent.
    await this.freshen()
    await writeStateBrief(this.handle, this.current)
  }

  async recordPoint(draft: PointDraft): Promise<RecordedPoint> {
    // Before anything is read out of the state — which shape validates this, which dataset it lands
    // in — because a value read from a stale bind is a wrong answer, not a slow one.
    await this.freshen()
    const datasetId = this.resolveDataset(draft.dataset)
    const shape = this.shapeOf(datasetId)
    if (Object.keys(draft.values).length === 0) {
      throw new BenchError('invalid', 'nothing to record', { hint: addHint(shape) })
    }

    const validation = validateValues(shape, draft.values)
    if (validation.errors.length > 0) {
      throw new BenchError('invalid', 'point rejected', {
        problems: validation.errors,
        hint: addHint(shape),
      })
    }

    // One owner decides what the observation time is: a designated field when the shape has one,
    // otherwise the explicit --at, otherwise now. The chosen value is written back into the values
    // so `values[date]` and `t_observed` cannot disagree in the log.
    const observation = resolveObservation(shape, draft.values, draft.tObserved)
    const tObserved = observation.tObserved

    const event = makeEvent('point_recorded', this.handle.session, {
      dataset: datasetId,
      shape: shape.id,
      values: observation.values,
      t_observed: tObserved,
      // The version this row joins: the newest one, which is the version a panel or a run pinned
      // unless it named an older one.
      version: this.currentVersion(datasetId),
      ...(draft.note === undefined ? {} : { note: draft.note }),
      ...(draft.tags === undefined ? {} : { tags: draft.tags }),
    })
    await this.append([event])
    return {
      event,
      dataset: datasetId,
      shape: shape.id,
      tObserved,
      warnings: validation.warnings,
    }
  }

  /** Bulk append, one write. Used by import, where a per-row fsync would be a lie about speed. */
  async appendAll(events: BenchEvent[]): Promise<ProjectState> {
    await this.freshen()
    await this.append(events)
    return this.current
  }

  /**
   * `options.tObserved` moves the canonical time of a row whose shape designates no time field —
   * the only way an imported estimate can be replaced by a real instant. A shape that does
   * designate one keeps its own rule: the field is the authority, and an instant that disagrees
   * with it is refused, exactly as `--at` is refused on `add`.
   */
  async correctPoint(
    id: string,
    patch: Record<string, PointValue>,
    reason?: string,
    options: { tObserved?: string } = {},
  ): Promise<PointCorrection> {
    await this.freshen()
    const found = this.findPoint(id)
    if (!found) throw new BenchError('missing', `no point with id "${id}"`)
    // A correction changes the row a dataset is read from. A withdrawn row is not one of those: the
    // fold would merge the values into a point nothing shows, and a later restore would come back
    // with numbers nobody chose. `missing`, not `invalid`, because the record is not in the data and
    // retrying the same call cannot succeed — the window ends the edit on that kind.
    if (found.point.status === 'retracted') {
      throw new BenchError('missing', `point "${id}" has been withdrawn`, {
        hint: 'undo the removal to edit it again',
      })
    }
    // A correction can move the observation time alone: replacing an imported estimate with a
    // measured instant changes no value, and it is the whole point of the estimate's being labelled.
    if (Object.keys(patch).length === 0 && options.tObserved === undefined) {
      throw new BenchError('invalid', 'nothing to correct', {
        hint: `pass --values '{"y":3.5}', or --at <instant> to replace an estimated time`,
      })
    }

    // Validate the merged result against the declaration this point was recorded with, not the
    // dataset's newest: an extension must not make an older row retroactively incomplete.
    const shape = this.current.shapes.get(
      found.point.shape ?? this.current.datasets.get(found.dataset)?.shape ?? '',
    )
    const merged = { ...found.point.values, ...patch }
    if (shape) {
      const validation = validateValues(shape, merged)
      if (validation.errors.length > 0) {
        throw new BenchError('invalid', 'correction rejected', { problems: validation.errors })
      }
    }

    // The canonical time is re-derived from the corrected row, not inherited from the point being
    // corrected: a correction to the time field must move both, or it has only half happened. The
    // field's text is canonicalised in the event too, so `values.date` and `t_observed` agree.
    const currentShape = this.current.shapes.get(
      this.current.datasets.get(found.dataset)?.shape ?? '',
    )
    const observation = currentShape
      ? resolveObservation(currentShape, merged, options.tObserved)
      : undefined
    const written = observation?.field
      ? { ...patch, [observation.field.name]: observation.values[observation.field.name]! }
      : patch
    // The instant moves when the shape designates a field (its own rule) or when the caller names
    // one for a row that has none. Otherwise it is left alone: an edit to a value must not restamp
    // the time the row already had, estimated or not.
    const movesTime = currentShape?.time_field !== undefined || options.tObserved !== undefined

    const event = makeEvent('point_corrected', this.handle.session, {
      dataset: found.dataset,
      supersedes: id,
      values: written,
      ...(movesTime ? { t_observed: observation!.tObserved } : {}),
      ...(reason === undefined ? {} : { reason }),
      // A correction made now belongs to the version that is current now: an older version keeps
      // reading as it did, which is the point of keeping the old one at all.
      version: this.currentVersion(found.dataset),
    })
    await this.append([event])
    return {
      event,
      dataset: found.dataset,
      values: written,
      now: observation?.values ?? merged,
      ...(movesTime ? { tObserved: observation!.tObserved } : {}),
      estimated: this.findPoint(id)?.point.tEstimated === true,
    }
  }

  async retractPoint(id: string, reason?: string): Promise<PointRetraction> {
    await this.freshen()
    const found = this.findPoint(id)
    if (!found) throw new BenchError('missing', `no point with id "${id}"`)
    // A second retraction would be a record of an act that changed nothing. This is reachable from
    // the window: undo a point, and then undo again — or undo one the CLI already withdrew while the
    // window was open. Refuse, and name the point, rather than appending a duplicate event.
    if (found.point.status === 'retracted') {
      throw new BenchError('invalid', `point "${id}" is already retracted`, {
        hint: 'nothing to retract; `bench list` shows active points',
      })
    }

    const event = makeEvent('point_retracted', this.handle.session, {
      dataset: found.dataset,
      supersedes: id,
      ...(reason === undefined ? {} : { reason }),
      version: this.currentVersion(found.dataset),
    })
    await this.append([event])
    return { event, dataset: found.dataset, active: activePoints(this.current, found.dataset).length }
  }

  /**
   * Undo a removal: the same record comes back, not a copy of its values.
   *
   * The event names the retraction it reverses, so the restore is checkable against the history
   * rather than trusted: it may only reverse the retraction that is currently in force. A point that
   * is already active is refused for the same reason a second retraction is — the event would record
   * an act that changed nothing.
   *
   * `retraction` says *which* removal to reverse. A caller that remembers the act it is undoing
   * passes it, so undo cannot quietly reverse a later removal that someone else recorded; the CLI
   * omits it and means "the one in force", which is the only removal a person naming a point can
   * mean.
   */
  async restorePoint(id: string, retraction?: string): Promise<PointRestoration> {
    await this.freshen()
    const found = this.findPoint(id)
    if (!found) throw new BenchError('missing', `no point with id "${id}"`)
    if (found.point.status !== 'retracted') {
      throw new BenchError('invalid', `point "${id}" is not retracted`, {
        hint: 'nothing to restore; it is already in the data',
      })
    }
    // The retraction in force is the last one the log records. The fold agrees with this choice and
    // refuses a restore that names any other, so the two cannot drift apart.
    const inForce = this.events.findLast(
      (event): event is Extract<BenchEvent, { type: 'point_retracted' }> =>
        event.type === 'point_retracted' && event.supersedes === id,
    )
    // A remembered act that is no longer the one in force: the point was brought back and removed
    // again, by this window or another writer. Reversing the newer removal under the older one's
    // name would undo an act nobody asked to undo, so refuse and let the caller say so.
    if (retraction !== undefined && (inForce === undefined || inForce.id !== retraction)) {
      throw new BenchError('invalid', 'that removal is no longer the one in force', {
        hint: 'the point was removed again after that, so there is nothing left to undo',
      })
    }
    if (inForce === undefined) {
      throw new BenchError('invariant', `point "${id}" is retracted but no retraction names it`, {
        hint: 'the log was written by something other than bench; `bench check` reports the rest',
      })
    }
    const event = makeEvent('point_restored', this.handle.session, {
      dataset: found.dataset,
      restores: inForce.id,
      // A restore belongs to the version that is current now, exactly as a retraction does: an older
      // version keeps reading as it did.
      version: this.currentVersion(found.dataset),
    })
    await this.append([event])
    return {
      event,
      dataset: found.dataset,
      retraction: inForce.id,
      active: activePoints(this.current, found.dataset).length,
    }
  }

  async recordDecision(text: string, tags?: string[]): Promise<BenchEvent> {
    await this.freshen()
    const event = makeEvent('decision_recorded', this.handle.session, {
      text,
      ...(tags === undefined ? {} : { tags }),
    })
    await this.append([event])
    return event
  }

  /**
   * Run a recipe, write its artifact, and record the run. Shared by `bench run` and `bench rerun`:
   * they differ in where the parameters come from and in what they print, not in any of this.
   */
  async recordAnalysis(runner: RecipeRunner, request: AnalysisRequest): Promise<AnalysisOutcome> {
    await this.freshen()
    const datasetId = this.resolveDataset(request.dataset ?? request.repeatOf?.dataset)
    const input = buildRunInput(this.current, datasetId)
    if (!input) throw new BenchError('missing', `no dataset "${datasetId}"`)
    if (input.points.length === 0) {
      throw new BenchError('missing', `dataset "${datasetId}" has no active points`, {
        hint: addHint(this.shapeOf(datasetId)),
      })
    }

    const outcome = await runner.run(request.recipe, request.params, input)
    if (!outcome.ok) {
      throw new BenchError('invariant', outcome.error.message, {
        hint: outcome.error.hint ?? `code: ${outcome.error.code}`,
      })
    }
    const result = outcome.result
    // One assembly for every caller — `run`, `rerun`, and a view panel. See ADR 0003.
    const spec: ChartSpec = chartSpecFor(result, {
      title: this.handle.config.name,
      dataset: datasetId,
      shape: this.current.datasets.get(datasetId)!.shape,
      recipe: request.recipe,
    })

    // The log stores a project-relative path: an absolute one would bake this machine's layout — and
    // its user name — into a file meant to outlive the machine. Forward slashes even on Windows,
    // because a backslash there is a trap for anything that later parses it elsewhere.
    const artifactRef = request.chartPath ?? request.repeatOf?.artifact ?? `artifacts/${request.recipe}-${datasetId}.svg`
    const target = request.chartPath ? resolve(request.chartPath) : join(this.handle.dir, artifactRef)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, renderChart(spec))

    const event = makeEvent('analysis_run', this.handle.session, {
      recipe: result.recipe,
      recipe_hash: result.recipeHash,
      params: request.params,
      dataset: datasetId,
      // Which version this conclusion rested on, in the log where it belongs. A reader a month from
      // now gets `main v2`, not just a hash that can only say "different".
      version: this.currentVersion(datasetId),
      input_hash: hashInput(input),
      verdict: result.verdict,
      narrative: result.narrative,
      artifact: artifactRef,
    })
    await this.append([event])

    return {
      event,
      result,
      dataset: datasetId,
      params: request.params,
      artifactRef,
      ...(request.repeatOf === undefined
        ? {}
        : { verdictChanged: request.repeatOf.verdict !== result.verdict }),
    }
  }
}
