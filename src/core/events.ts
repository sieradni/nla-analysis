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
  /**
   * The field that carries the observation time. Absent means the old behaviour: `--at` or the
   * import's time column decides, and this declaration makes no promise about any field.
   */
  time_field?: string
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

export interface ShapeExtended extends EventBase {
  type: 'shape_extended'
  /** The shape declaration that was extended. It must be that base's latest version. */
  from: string
  /** The complete new declaration: old fields in their original order, plus one appended field. */
  shape: Shape
  /** The one appended field, repeated for readers that only need the delta. Checked against `shape`. */
  field: ShapeField
}

export interface ShapeTimeDesignated extends EventBase {
  type: 'shape_time_designated'
  /** The declaration whose observation-time field is being set. */
  from: string
  /** The complete new declaration: same fields, same order, plus the designation. */
  shape: Shape
  /** The designated field name, repeated so a reader does not have to cross-check the declaration. */
  time_field: string
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
  /** What produced this version: the preserved file it came from, or how it was made. */
  source: string
  /** Content hash of the source, so a version names exactly what it was read from. */
  hash: string
  /** Rows in the version when it was created. Hand-added rows grow the current version later. */
  rows: number
  /** The version this one replaced. Absent for the first version. */
  parent?: number
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
  /**
   * The time is an estimate, not something the row measured: the file had no clock, and the caller
   * chose the file's row order. The instant is still never invented silently — it is labelled here,
   * ordered by the row it came from, and replaceable by a correction that carries a real instant.
   * Absent means the row's time is an observation, which is what every event written before this
   * existed is.
   */
  t_estimated?: true
  /**
   * The dataset version this row belongs to. Absent means version 1: projects written before
   * versions existed have exactly one, and reading them back as anything else would invent history.
   */
  version?: number
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
  /**
   * The canonical observation time after the correction, when the shape designates a field, or when
   * the correction replaces an estimated time with a measured one. Absent means the instant did not
   * move — and for a shape with no designation, that it is not being restamped by every edit.
   */
  t_observed?: IsoTime
  /**
   * The row's time is still an estimate after this correction. Written when a re-read of an untimed
   * file keeps the row's estimated instant, so a correction that only moves values cannot quietly
   * turn an estimate into something that reads as measured. A correction carrying `t_observed` and
   * no marker is the replacement: the time is now an observation.
   */
  t_estimated?: true
  /** The version this change belongs to, so an older version still reads as it did. */
  version?: number
}

export interface PointRetracted extends EventBase {
  type: 'point_retracted'
  dataset: string
  supersedes: string
  reason?: string
  /** The version this withdrawal happened in; see `PointCorrected.version`. */
  version?: number
}

/**
 * The inverse of a retraction: the record comes back as the same record, not a lookalike.
 *
 * It names the retraction it reverses rather than the point, because a point can be withdrawn more
 * than once. That makes the restore checkable: it may only reverse the retraction that is actually
 * in force, so an old undo arriving late cannot silently re-open a point that was withdrawn again.
 * The values, observation time and version are the record's own and are deliberately not repeated:
 * a restore that carried its own copy could disagree with them.
 */
export interface PointRestored extends EventBase {
  type: 'point_restored'
  dataset: string
  /** Id of the `point_retracted` event this reverses. */
  restores: string
  /** The version this restoration happened in; see `PointCorrected.version`. */
  version?: number
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
  /** Source columns the importer explicitly left out because the shape had no field for them. */
  ignored_columns?: string[]
  /**
   * The file had no time column and the caller chose the row order, so every row this version
   * brought carries `t_estimated`. Said once here as well, because it is a fact about the version.
   */
  time_estimated?: true
}

export interface AnalysisRun extends EventBase {
  type: 'analysis_run'
  recipe: string
  recipe_hash: string
  params: Record<string, unknown>
  /** The dataset the run read. Optional because runs recorded before this field existed lack it;
   *  `assessRuns` reports those as unverifiable rather than assuming an answer. */
  dataset?: string
  /** The dataset version the run read, so "what did that conclusion rest on" is a version, not a
   *  Rorschach of a content hash. Absent for runs recorded before versions existed. */
  version?: number
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
  | ShapeExtended
  | ShapeTimeDesignated
  | DatasetCreated
  | DatasetVersionCreated
  | PointRecorded
  | PointCorrected
  | PointRetracted
  | PointRestored
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
