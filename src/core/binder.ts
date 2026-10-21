import type { BenchEvent, IsoTime, PointValue, Shape, Verdict } from './events.ts'
import { sameShapeField, validateShapeExtensionShape, validateTimeDesignation } from './shapes.ts'

export interface Point {
  id: string
  dataset: string
  /** The declaration current when this point was recorded. It never moves on extension. */
  shape: string
  values: Record<string, PointValue>
  /** The time the value refers to. */
  tObserved: IsoTime
  /**
   * That time is an estimate from the file's row order, not an observation (see
   * `PointRecorded.t_estimated`). A correction carrying a real instant clears it.
   */
  tEstimated?: true
  recordedAt: IsoTime
  /**
   * The dataset version this row belongs to. Every point has one: rows written before versions were
   * recorded read as version 1, which is what a project with one version always was.
   */
  version: number
  note?: string
  tags: string[]
  status: 'active' | 'retracted'
  /** Ids of correction events folded into this point, oldest first. */
  corrections: string[]
  /** When the most recent correction landed. Distinct from `recordedAt`: the values moved later. */
  correctedAt?: IsoTime
  /** When it was withdrawn. Kept so an analysis can tell what left the evidence set, and when. */
  retractedAt?: IsoTime
  retractionReason?: string
  /** When it was brought back by a restore. Absent means it has never been restored. */
  restoredAt?: IsoTime
  /**
   * The retraction currently in force — the one a restore has to reverse to take effect. Absent for
   * an active point, so a second restore cannot re-open a record that was withdrawn again.
   */
  retractedBy?: string
}

/**
 * One immutable version of a dataset. Records are never rewritten, so an old conclusion can always
 * be read against the rows it actually rested on. `version` 1 is inferred when a project predates
 * version records: those rows were one version, and calling that fact anything else would invent
 * history.
 */
export interface DatasetVersion {
  version: number
  at: IsoTime
  /** The preserved file it came from, or why it was made. */
  source: string
  hash: string
  /** Rows when the version was created. The current version grows as rows are added to it. */
  rows: number
  parent?: number
  diff?: { added: number; removed: number; changed: number }
  /** False only for the inferred version 1 of a project that predates version records. */
  recorded: boolean
}

export interface DatasetState {
  id: string
  shape: string
  points: Point[]
  /** Oldest first. Immutable, except that the current version grows with new rows. */
  versions: DatasetVersion[]
  /** The version a new row lands in: the newest one, or 1 when none has been recorded yet. */
  version: number
}

export interface Decision {
  id: string
  at: IsoTime
  text: string
  tags: string[]
}

export interface RunRecord {
  id: string
  at: IsoTime
  recipe: string
  verdict: Verdict
  narrative?: string
  /** Carried so a run can be re-checked against the data later, without re-running it. */
  recipeHash?: string
  inputHash?: string
  params?: Record<string, unknown>
  dataset?: string
  /** The version of that dataset the run read. Absent for runs recorded before versions existed. */
  version?: number
  artifact?: string
}

export interface ProjectState {
  name: string
  createdAt: IsoTime | null
  shapes: Map<string, Shape>
  datasets: Map<string, DatasetState>
  decisions: Decision[]
  runs: RunRecord[]
  /** Structural problems found while folding: unknown ids, duplicates, orphaned corrections. */
  problems: string[]
  /**
   * The events this state was folded from. Kept so a *past* version can be rebuilt on demand
   * (`foldVersion`) instead of snapshotting every version on every read — most projects read only
   * the current one, and a version is asked about rarely.
   */
  events: readonly BenchEvent[]
}

/**
 * Order by the instant a point refers to, never by its spelling. Two records can name the same
 * moment as `2026-01-01T00:00:00Z`, `...00.000Z`, or `2026-01-01T02:00:00+02:00`; comparing those
 * as strings puts them in an order that has nothing to do with time. Ties fall back to the stored
 * string and then to the id, so the result is always deterministic.
 */
const byTime = (a: Point, b: Point): number => {
  const left = Date.parse(a.tObserved)
  const right = Date.parse(b.tObserved)
  if (!Number.isNaN(left) && !Number.isNaN(right) && left !== right) return left - right
  if (a.tObserved !== b.tObserved) return a.tObserved.localeCompare(b.tObserved)
  return a.id.localeCompare(b.id)
}

/**
 * The mutable core of a point fold: the map being built, the version horizon, and where structural
 * problems go. `bind` runs it with no horizon over the whole log; `foldVersion` runs it with a cut
 * and one dataset. The three functions below are the only place a row is recorded, a correction is
 * applied, or a row is withdrawn — so changing how a correction lands changes it once.
 */
interface PointFold {
  points: Map<string, Point>
  /**
   * Retraction event id → the point it withdrew. A restore names the retraction, not the point, so
   * the fold has to resolve that reference the same way a reader would: through the log.
   */
  retractions: Map<string, string>
  /** Rows and changes above this version are not part of the fold. */
  upTo: number
  /** Unknown ids and unannounced versions, when the caller is building current state. */
  problems?: string[]
}

function applyRecorded(
  fold: PointFold,
  event: Extract<BenchEvent, { type: 'point_recorded' }>,
  dataset?: DatasetState,
): Point | undefined {
  const version = event.version ?? 1
  if (version > fold.upTo) return undefined
  // A row tagged with a version nobody announced is a structural problem worth naming: it is either
  // a hand-written event or a bug in a writer, and folding it quietly would hide both.
  if (
    dataset &&
    fold.problems &&
    dataset.versions.length > 0 &&
    !dataset.versions.some((record) => record.version === version)
  ) {
    fold.problems.push(`point ${event.id} names version ${version}, which was never created`)
  }
  const point: Point = {
    id: event.id,
    dataset: event.dataset,
    shape: event.shape,
    values: { ...event.values },
    tObserved: event.t_observed,
    recordedAt: event.at,
    version,
    tags: [...(event.tags ?? [])],
    status: 'active',
    corrections: [],
    ...(event.note === undefined ? {} : { note: event.note }),
    ...(event.t_estimated === true ? { tEstimated: true } : {}),
  }
  fold.points.set(event.id, point)
  return point
}

function applyCorrected(fold: PointFold, event: Extract<BenchEvent, { type: 'point_corrected' }>): void {
  if ((event.version ?? 1) > fold.upTo) return
  const target = fold.points.get(event.supersedes)
  if (!target) {
    fold.problems?.push(`correction ${event.id} targets unknown point ${event.supersedes}`)
    return
  }
  target.values = { ...target.values, ...event.values }
  // A designated time field can move the observation instant. The event carries the canonical value
  // so the fold never has to guess which declaration was current when the correction was written.
  if (event.t_observed !== undefined) target.tObserved = event.t_observed
  // An estimate survives a correction that only moves values — and ends with one that carries a
  // measured instant. A correction that says neither touches the time and says nothing about it.
  if (event.t_observed !== undefined || event.t_estimated === true) {
    if (event.t_estimated === true) target.tEstimated = true
    else delete target.tEstimated
  }
  target.corrections.push(event.id)
  // The log is append-only, so events can be replayed out of order; keep the latest instant.
  if (target.correctedAt === undefined || event.at > target.correctedAt) target.correctedAt = event.at
}

function applyRetracted(fold: PointFold, event: Extract<BenchEvent, { type: 'point_retracted' }>): void {
  if ((event.version ?? 1) > fold.upTo) return
  const target = fold.points.get(event.supersedes)
  if (!target) {
    fold.problems?.push(`retraction ${event.id} targets unknown point ${event.supersedes}`)
    return
  }
  fold.retractions.set(event.id, event.supersedes)
  // The log is append-only but replay need not be in timestamp order; the later act wins, and a tie
  // goes to the one folded later, which is the later line in the file.
  if (target.retractedAt === undefined || event.at >= target.retractedAt) {
    target.retractedAt = event.at
    target.retractedBy = event.id
    if (target.restoredAt === undefined || event.at >= target.restoredAt) target.status = 'retracted'
  }
  if (event.reason !== undefined) target.retractionReason = event.reason
}

/**
 * Bring a withdrawn record back as itself. The values, observation time and version are the ones it
 * already has: a restore that carried values would be a second record claiming to be the first.
 */
function applyRestored(fold: PointFold, event: Extract<BenchEvent, { type: 'point_restored' }>): void {
  if ((event.version ?? 1) > fold.upTo) return
  const pointId = fold.retractions.get(event.restores)
  if (pointId === undefined) {
    fold.problems?.push(`restore ${event.id} reverses unknown retraction ${event.restores}`)
    return
  }
  const target = fold.points.get(pointId)
  if (!target) {
    fold.problems?.push(`restore ${event.id} targets unknown point ${pointId}`)
    return
  }
  // A restore names one dataset, and the retraction it reverses names the record. Two writers that
  // disagree about which dataset the record lives in is a log problem, not a coin toss.
  if (target.dataset !== event.dataset) {
    fold.problems?.push(
      `restore ${event.id} says dataset "${event.dataset}", but point ${pointId} is in "${target.dataset}"`,
    )
    return
  }
  // A restore may only reverse the retraction standing in the way. Restoring an older one would be
  // a stale undo quietly re-opening a record that was withdrawn again since.
  if (target.retractedBy !== event.restores) {
    fold.problems?.push(
      `restore ${event.id} reverses retraction ${event.restores}, which is not in force for point ${pointId}`,
    )
    return
  }
  if (target.restoredAt === undefined || event.at >= target.restoredAt) {
    target.restoredAt = event.at
    delete target.retractedBy
    target.status = 'active'
  }
}

/**
 * Fold events into current state. The log is the truth; this projection is disposable and must be
 * reconstructible from the file alone.
 */
export function bind(events: BenchEvent[]): ProjectState {
  const state: ProjectState = {
    name: '',
    createdAt: null,
    shapes: new Map(),
    datasets: new Map(),
    decisions: [],
    runs: [],
    problems: [],
    events,
  }

  const points = new Map<string, Point>()
  const fold: PointFold = {
    points,
    retractions: new Map(),
    upTo: Number.POSITIVE_INFINITY,
    problems: state.problems,
  }

  const ensureDataset = (id: string, shape: string): DatasetState => {
    const existing = state.datasets.get(id)
    if (existing) return existing
    const created: DatasetState = { id, shape, points: [], versions: [], version: 1 }
    state.datasets.set(id, created)
    return created
  }

  for (const event of events) {
    if (points.has(event.id)) {
      state.problems.push(`duplicate event id ${event.id}`)
      continue
    }

    switch (event.type) {
      case 'project_created':
        state.name = event.name
        state.createdAt = event.at
        break

      case 'shape_defined':
        state.shapes.set(event.shape.id, event.shape)
        break

      case 'shape_time_designated': {
        const from = state.shapes.get(event.from)
        if (!from) {
          state.problems.push(`designation ${event.id} designates unknown shape "${event.from}"`)
          break
        }
        if (state.shapes.has(event.shape.id)) {
          state.problems.push(`designation ${event.id} redeclares shape "${event.shape.id}"`)
          break
        }
        try {
          validateTimeDesignation(from, event.shape, event.time_field)
          state.shapes.set(event.shape.id, event.shape)
          // Datasets move to the new declaration; points already recorded keep the shape event that
          // was current when they were written, so their values and times are never reinterpreted.
          for (const dataset of state.datasets.values()) {
            if (dataset.shape === event.from) dataset.shape = event.shape.id
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          state.problems.push(`designation ${event.id} is invalid: ${message}`)
        }
        break
      }

      case 'shape_extended': {
        const from = state.shapes.get(event.from)
        if (!from) {
          state.problems.push(`extension ${event.id} extends unknown shape "${event.from}"`)
          break
        }
        if (state.shapes.has(event.shape.id)) {
          state.problems.push(`extension ${event.id} redeclares shape "${event.shape.id}"`)
          break
        }
        try {
          const field = validateShapeExtensionShape(from, event.shape)
          if (!event.field || !sameShapeField(field, event.field)) {
            throw new Error(`the recorded field does not match the added field "${field.name}"`)
          }
          state.shapes.set(event.shape.id, event.shape)
          // Datasets move to the new declaration; points already recorded keep the shape event that
          // was current when they were written, so their values are never reinterpreted.
          for (const dataset of state.datasets.values()) {
            if (dataset.shape === event.from) dataset.shape = event.shape.id
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          state.problems.push(`extension ${event.id} is invalid: ${message}`)
        }
        break
      }

      case 'dataset_created':
        ensureDataset(event.dataset, event.shape)
        break

      case 'point_recorded': {
        const dataset = ensureDataset(event.dataset, event.shape)
        const point = applyRecorded(fold, event, dataset)
        if (point) dataset.points.push(point)
        break
      }

      case 'point_corrected':
        applyCorrected(fold, event)
        break

      case 'point_retracted':
        applyRetracted(fold, event)
        break

      case 'point_restored':
        applyRestored(fold, event)
        break

      case 'dataset_version_created': {
        const dataset = ensureDataset(event.dataset, state.datasets.get(event.dataset)?.shape ?? 'unknown')
        if (dataset.versions.some((record) => record.version === event.version)) {
          state.problems.push(`dataset "${event.dataset}" records version ${event.version} twice`)
          break
        }
        dataset.versions.push({
          version: event.version,
          at: event.at,
          source: event.source,
          hash: event.hash,
          rows: event.rows,
          ...(event.parent === undefined ? {} : { parent: event.parent }),
          ...(event.diff === undefined ? {} : { diff: { ...event.diff } }),
          recorded: true,
        })
        dataset.version = Math.max(dataset.version, event.version)
        break
      }

      case 'analysis_run':
        state.runs.push({
          id: event.id,
          at: event.at,
          recipe: event.recipe,
          verdict: event.verdict,
          recipeHash: event.recipe_hash,
          inputHash: event.input_hash,
          params: { ...(event.params ?? {}) },
          ...(event.dataset === undefined ? {} : { dataset: event.dataset }),
          ...(event.version === undefined ? {} : { version: event.version }),
          ...(event.narrative === undefined ? {} : { narrative: event.narrative }),
          ...(event.artifact === undefined ? {} : { artifact: event.artifact }),
        })
        break

      case 'decision_recorded':
        state.decisions.push({
          id: event.id,
          at: event.at,
          text: event.text,
          tags: [...(event.tags ?? [])],
        })
        break

      case 'import_completed':
        break
    }
  }

  for (const dataset of state.datasets.values()) {
    // A project that predates version records has one version, and it is the rows it already had.
    // Saying so explicitly is what lets every other reader ask for "version N" without a special case.
    if (dataset.versions.length === 0 && dataset.points.length > 0) {
      dataset.versions.push({
        version: 1,
        at: dataset.points.reduce((earliest, point) => (point.recordedAt < earliest ? point.recordedAt : earliest), dataset.points[0]!.recordedAt),
        source: 'unrecorded',
        hash: '',
        rows: dataset.points.length,
        recorded: false,
      })
    }
    dataset.versions.sort((left, right) => left.version - right.version)
    dataset.version = Math.max(dataset.version, ...dataset.versions.map((record) => record.version), 1)
    for (const point of dataset.points) {
      if (point.version > dataset.version) {
        state.problems.push(`point ${point.id} names version ${point.version}, past the newest (${dataset.version})`)
      }
    }
    dataset.points.sort(byTime)
    // Checked once per dataset, not once per point: inside the loop this reported the same broken
    // reference as many times as the dataset had points, and skipped an empty one entirely.
    if (!state.shapes.has(dataset.shape)) {
      state.problems.push(`dataset "${dataset.id}" references unknown shape "${dataset.shape}"`)
    }
  }

  return state
}

export function getDataset(state: ProjectState, id: string): DatasetState | undefined {
  return state.datasets.get(id)
}

/**
 * The rows of one version of a dataset, rebuilt from the log.
 *
 * A row belongs to the version it was recorded in, and a correction or retraction belongs to the
 * version it *happened* in — so version 1 keeps reading as it did after a later version replaces,
 * corrects or withdraws a row. That is the whole promise of an immutable version, and it is why this
 * fold takes a cut instead of a snapshot being written beside the log.
 */
export function foldVersion(
  events: readonly BenchEvent[],
  datasetId: string,
  upTo: number,
): Point[] {
  const points = new Map<string, Point>()
  // No `problems`: a past version is a question about rows, not an audit of the log. A correction
  // whose target is not in this horizon simply has nothing to apply to.
  const fold: PointFold = { points, retractions: new Map(), upTo }
  for (const event of events) {
    if (
      (event.type === 'point_recorded' ||
        event.type === 'point_corrected' ||
        event.type === 'point_retracted' ||
        event.type === 'point_restored') &&
      event.dataset !== datasetId
    ) {
      continue
    }
    switch (event.type) {
      case 'point_recorded':
        applyRecorded(fold, event)
        break
      case 'point_corrected':
        applyCorrected(fold, event)
        break
      case 'point_retracted':
        applyRetracted(fold, event)
        break
      case 'point_restored':
        applyRestored(fold, event)
        break
      default:
        break
    }
  }
  return [...points.values()].sort(byTime)
}

/** The active rows of one version: what an analysis or a panel pinned to it actually read. */
export function activeRowsOfVersion(
  state: ProjectState,
  datasetId: string,
  version: number,
): Point[] {
  const dataset = state.datasets.get(datasetId)
  if (!dataset) return []
  // The newest version is already folded: reading it from the live state keeps the common case off
  // the re-fold path, and `foldVersion` is checked against it by test. A version past the newest is
  // not the newest — it holds nothing, and saying otherwise would answer a question nobody asked
  // with the rows of another version.
  if (version === dataset.version) return activePoints(state, datasetId)
  if (version > dataset.version) return []
  return foldVersion(state.events, datasetId, version).filter((point) => point.status === 'active')
}

/** The version record for one version, or undefined when the dataset has no such version. */
export function versionRecord(
  state: ProjectState,
  datasetId: string,
  version: number,
): DatasetVersion | undefined {
  return state.datasets.get(datasetId)?.versions.find((record) => record.version === version)
}

export function activePoints(state: ProjectState, datasetId: string): Point[] {
  return (state.datasets.get(datasetId)?.points ?? []).filter((p) => p.status === 'active')
}

export function numericValue(point: Point, field: string): number | undefined {
  const value = point.values[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
