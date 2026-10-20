/**
 * The model's answer to "when did this happen".
 *
 * A shape may designate one of its fields as the observation time. Once it does, that field is the
 * truth: `bench add`, `bench correct`, and `import` all derive `t_observed` from it, and an explicit
 * `--at` or time column that contradicts it is refused rather than written beside it. A shape that
 * designates nothing keeps the old behaviour exactly, because every project written before this
 * existed has no designation and its events are not reinterpreted.
 */
import type { PointValue, Shape, ShapeField } from './events.ts'
import { BenchError } from './errors.ts'

/** The designated field, or undefined when the shape leaves the choice to the caller. */
export function timeFieldOf(shape: Shape): ShapeField | undefined {
  if (shape.time_field === undefined) return undefined
  return shape.fields.find((field) => field.name === shape.time_field)
}

/**
 * A declaration's time field must be a required `instant`. A number could be epoch seconds or
 * nanoseconds, and an optional field would let a point have no observation time at all — both make
 * the model ambiguous again, which is the thing this designation exists to remove.
 */
export function validateTimeField(
  shape: Pick<Shape, 'id' | 'fields'>,
  name: string,
): ShapeField {
  const field = shape.fields.find((candidate) => candidate.name === name)
  if (!field) {
    throw new BenchError('invalid', `shape ${shape.id} designates "${name}" as its observation time, but has no such field`, {
      hint: `fields: ${shape.fields.map((candidate) => candidate.name).join(', ')}`,
    })
  }
  if (field.type !== 'instant') {
    throw new BenchError(
      'invalid',
      `field "${field.name}" cannot carry the observation time because it is ${field.type}`,
      { hint: 'use an instant field, e.g. "date": {"type": "instant"}' },
    )
  }
  if (field.optional === true) {
    throw new BenchError(
      'invalid',
      `field "${field.name}" cannot be optional while it carries the observation time`,
      { hint: 'a point must always have an observation time' },
    )
  }
  return field
}

/** A canonical UTC instant, or a refusal naming what was not parseable. */
export function canonicalInstant(raw: string, source: string): string {
  const milliseconds = Date.parse(raw)
  if (Number.isNaN(milliseconds)) {
    throw new BenchError('invalid', `${source} is not a parseable time: "${raw}"`, {
      hint: 'use an ISO timestamp such as 2026-10-01T09:00:00Z',
    })
  }
  return new Date(milliseconds).toISOString()
}

export interface ObservationValue {
  /** Absent when the shape designates no time field. */
  field?: ShapeField
  /** Canonical UTC, when the designated field carries one. */
  tObserved?: string
  /** Why the designated field could not answer, for a row-level list of problems. */
  problem?: string
}

/**
 * Read the designated field from a point's values. This is deliberately non-throwing for the
 * import path, which collects every bad row before refusing; `resolveObservation` turns the same
 * answer into one refusal for the single-point doors.
 */
export function observationValue(shape: Shape, values: Record<string, PointValue>): ObservationValue {
  const field = timeFieldOf(shape)
  if (!field) return {}
  const raw = values[field.name]
  if (typeof raw !== 'string' || Number.isNaN(Date.parse(raw))) {
    return {
      field,
      problem: `field "${field.name}" is the observation time for shape ${shape.id}, but ${JSON.stringify(raw)} is not a parseable instant`,
    }
  }
  return { field, tObserved: new Date(Date.parse(raw)).toISOString() }
}

export interface ResolvedObservation {
  /** The row as it will be written: a designated instant field is canonicalised here. */
  values: Record<string, PointValue>
  tObserved: string
  /** Set when the shape designates a field, so a caller can report where the instant came from. */
  field?: ShapeField
}

/**
 * The one place a single point's observation time is decided.
 *
 * With no designation this is exactly the old rule: use `--at`, or now. With one, the field is
 * canonicalised and an explicit `--at` must agree with it; a contradiction is a refusal, not a
 * silent split between the field and `t_observed`.
 */
export function resolveObservation(
  shape: Shape,
  values: Record<string, PointValue>,
  suppliedAt?: string,
): ResolvedObservation {
  const found = observationValue(shape, values)
  if (found.problem !== undefined) {
    throw new BenchError('invalid', found.problem, {
      ...(shape.time_field === undefined
        ? {}
        : { hint: `give "${shape.time_field}" a parseable instant` }),
    })
  }
  if (found.tObserved === undefined) {
    return {
      values,
      tObserved: canonicalInstant(
        suppliedAt ?? new Date().toISOString(),
        suppliedAt === undefined ? 'the current time' : '--at',
      ),
    }
  }
  if (suppliedAt !== undefined) {
    const supplied = canonicalInstant(suppliedAt, '--at')
    if (supplied !== found.tObserved) {
      throw new BenchError(
        'invalid',
        `field "${found.field!.name}" says ${found.tObserved}, but --at says ${supplied}`,
        { hint: `drop --at, or make it ${found.tObserved}` },
      )
    }
  }
  return {
    values: { ...values, [found.field!.name]: found.tObserved },
    tObserved: found.tObserved,
    field: found.field,
  }
}

