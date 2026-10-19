import type { BenchEvent, IsoTime, PointValue, Shape, Verdict } from './events.ts'

export interface Point {
  id: string
  dataset: string
  values: Record<string, PointValue>
  /** The time the value refers to. */
  tObserved: IsoTime
  recordedAt: IsoTime
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
}

export interface DatasetState {
  id: string
  shape: string
  points: Point[]
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
  }

  const points = new Map<string, Point>()

  const ensureDataset = (id: string, shape: string): DatasetState => {
    const existing = state.datasets.get(id)
    if (existing) return existing
    const created: DatasetState = { id, shape, points: [] }
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

      case 'dataset_created':
        ensureDataset(event.dataset, event.shape)
        break

      case 'point_recorded': {
        const dataset = ensureDataset(event.dataset, event.shape)
        const point: Point = {
          id: event.id,
          dataset: event.dataset,
          values: { ...event.values },
          tObserved: event.t_observed,
          recordedAt: event.at,
          tags: [...(event.tags ?? [])],
          status: 'active',
          corrections: [],
          ...(event.note === undefined ? {} : { note: event.note }),
        }
        points.set(event.id, point)
        dataset.points.push(point)
        break
      }

      case 'point_corrected': {
        const target = points.get(event.supersedes)
        if (!target) {
          state.problems.push(`correction ${event.id} targets unknown point ${event.supersedes}`)
          break
        }
        target.values = { ...target.values, ...event.values }
        target.corrections.push(event.id)
        // The log is append-only, so events can be replayed out of order; keep the latest instant.
        if (target.correctedAt === undefined || event.at > target.correctedAt) target.correctedAt = event.at
        break
      }

      case 'point_retracted': {
        const target = points.get(event.supersedes)
        if (!target) {
          state.problems.push(`retraction ${event.id} targets unknown point ${event.supersedes}`)
          break
        }
        target.status = 'retracted'
        if (target.retractedAt === undefined || event.at > target.retractedAt) target.retractedAt = event.at
        if (event.reason !== undefined) target.retractionReason = event.reason
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

      case 'dataset_version_created':
      case 'import_completed':
        break
    }
  }

  for (const dataset of state.datasets.values()) {
    dataset.points.sort(byTime)
    for (const point of dataset.points) {
      if (!state.shapes.has(dataset.shape)) {
        state.problems.push(`dataset "${dataset.id}" references unknown shape "${dataset.shape}"`)
      }
    }
  }

  return state
}

export function getDataset(state: ProjectState, id: string): DatasetState | undefined {
  return state.datasets.get(id)
}

export function activePoints(state: ProjectState, datasetId: string): Point[] {
  return (state.datasets.get(datasetId)?.points ?? []).filter((p) => p.status === 'active')
}

export function numericValue(point: Point, field: string): number | undefined {
  const value = point.values[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
