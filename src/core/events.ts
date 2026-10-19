import { ulid } from './ids.ts'

export type IsoTime = string

export type FieldType = 'number' | 'integer' | 'string' | 'boolean' | 'instant'
export type PointValue = number | string | boolean | null

export interface ShapeField {
  name: string
  type: FieldType
  /** Physical unit, e.g. "C", "s", "kg". Absent means dimensionless or unknown. */
  unit?: string
  optional?: boolean
}

/**
 * A shape is the declared set of fields a point carries. Shapes are versioned: extending one is a
 * recorded event plus a migration, never a silent reinterpretation of existing rows.
 */
export interface Shape {
  id: string
  version: number
  fields: ShapeField[]
}

export type Verdict = 'insufficient' | 'tentative' | 'supported' | 'contradicted'

export interface EventBase {
  v: 1
  id: string
  at: IsoTime
  session: string
}

export interface ProjectCreated extends EventBase {
  type: 'project_created'
  name: string
}

export interface ShapeDefined extends EventBase {
  type: 'shape_defined'
  shape: Shape
}

export interface DatasetCreated extends EventBase {
  type: 'dataset_created'
  dataset: string
  shape: string
}

export interface DatasetVersionCreated extends EventBase {
  type: 'dataset_version_created'
  dataset: string
  version: number
  source: string
  hash: string
  rows: number
  /** Row-level diff against the parent version, when there is one. */
  diff?: { added: number; removed: number; changed: number }
}

export interface PointRecorded extends EventBase {
  type: 'point_recorded'
  dataset: string
  shape: string
  values: Record<string, PointValue>
  /** The time the value refers to. Distinct from `at`, when the point was recorded. */
  t_observed: IsoTime
  note?: string
  tags?: string[]
}

export interface PointCorrected extends EventBase {
  type: 'point_corrected'
  dataset: string
  /** Id of the point being superseded. */
  supersedes: string
  values: Record<string, PointValue>
  reason?: string
}

export interface PointRetracted extends EventBase {
  type: 'point_retracted'
  dataset: string
  supersedes: string
  reason?: string
}

export interface ImportCompleted extends EventBase {
  type: 'import_completed'
  dataset: string
  /** Path of the preserved original, relative to the project. */
  file: string
  rows: number
  /** Content hash of the source, so the same export cannot be imported twice by accident. */
  hash?: string
  columns?: string[]
  mapping?: Record<string, string>
}

export interface AnalysisRun extends EventBase {
  type: 'analysis_run'
  recipe: string
  recipe_hash: string
  params: Record<string, unknown>
  /** The dataset the run read. Optional because runs recorded before this field existed lack it;
   *  `assessRuns` reports those as unverifiable rather than assuming an answer. */
  dataset?: string
  input_hash: string
  verdict: Verdict
  narrative?: string
  artifact?: string
}

export interface DecisionRecorded extends EventBase {
  type: 'decision_recorded'
  text: string
  tags?: string[]
}

export type BenchEvent =
  | ProjectCreated
  | ShapeDefined
  | DatasetCreated
  | DatasetVersionCreated
  | PointRecorded
  | PointCorrected
  | PointRetracted
  | ImportCompleted
  | AnalysisRun
  | DecisionRecorded

export type EventType = BenchEvent['type']

type Payload<T extends EventType> = Omit<
  Extract<BenchEvent, { type: T }>,
  'v' | 'id' | 'type' | 'at' | 'session'
>

/** Build a complete event with a fresh id and timestamp. */
export function makeEvent<T extends EventType>(
  type: T,
  session: string,
  payload: Payload<T>,
): Extract<BenchEvent, { type: T }> {
  return {
    v: 1,
    id: ulid(),
    type,
    at: new Date().toISOString(),
    session,
    ...payload,
  } as Extract<BenchEvent, { type: T }>
}
