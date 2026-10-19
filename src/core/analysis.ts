/**
 * Whether a recorded analysis still describes the data it was run on.
 *
 * This exists because an analysis result outlives the moment it was computed, and a chart with a
 * verdict on it looks just as authoritative a month later. The log already records an `input_hash`
 * over the points the run consumed and a `recipe_hash` over the recipe file, so "is this still
 * true?" is answerable offline -- no Python, no recomputation, and no guessing from timestamps.
 *
 * Freshness is deliberately a three-state answer. A run recorded before the log noted which dataset
 * it read cannot be checked against anything, and calling that `fresh` would be a guess dressed up
 * as a guarantee.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { activePoints, type ProjectState, type RunRecord } from './binder.ts'
import type { ChartSpec } from './chart.ts'
import type { RunInput, RunResult } from './runner.ts'

/**
 * The application's own directory: the one holding `recipes/`. Derived from this module's location
 * rather than the working directory, so it is right no matter where the command was invoked from.
 *
 * Found by walking up, not by counting directories. Counting works only while this file sits at
 * `src/core/`; the desktop shell imports the *bundled* core from `app/`, where two levels up is the
 * parent of the repository and every recipe would look missing. That bug is cheap to prevent and
 * expensive to notice, because it reads as "the recipe was deleted" rather than "the path is wrong".
 */
function locateAppRoot(start: string): string {
  let current = start
  for (;;) {
    if (existsSync(join(current, 'recipes')) && existsSync(join(current, 'package.json'))) {
      return current
    }
    const parent = dirname(current)
    if (parent === current) return resolve(start, '..', '..')
    current = parent
  }
}

export const APP_ROOT = locateAppRoot(dirname(fileURLToPath(import.meta.url)))

export type Freshness = 'fresh' | 'stale' | 'unverifiable'

export interface RunFreshness {
  status: Freshness
  /** Why, in the words a person would use. Absent when `fresh`. */
  reason?: string
  /** What changed since the run, counted from the log rather than inferred from the hash mismatch. */
  addedSince?: number
  retractedSince?: number
  correctedSince?: number
  /** The version the run read, and the version the dataset is at now. Both absent without a pin. */
  ranOn?: number
  currentVersion?: number
}

export function buildRunInput(state: ProjectState, datasetId: string): RunInput | null {
  const dataset = state.datasets.get(datasetId)
  if (!dataset) return null
  const shape = state.shapes.get(dataset.shape)
  return {
    dataset: datasetId,
    shape: dataset.shape,
    fields: (shape?.fields ?? []).map((field) => ({
      name: field.name,
      type: field.type,
      ...(field.unit === undefined ? {} : { unit: field.unit }),
    })),
    points: activePoints(state, datasetId).map((point) => ({
      id: point.id,
      t: point.tObserved,
      values: point.values,
    })),
  }
}

/**
 * The identity of an analysis input: which points, with which values, at which observation times.
 *
 * Sorted here rather than trusting the caller, so a log that is replayed, reordered, or extended
 * with unrelated events hashes the same as long as the evidence is the same. Point ids are unique,
 * which makes the ordering total and the result independent of how the input was assembled.
 */
export function hashInput(input: RunInput): string {
  const canonical = JSON.stringify({
    dataset: input.dataset,
    shape: input.shape,
    points: [...input.points]
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      .map((point) => [point.id, point.t, point.values]),
  })
  return createHash('sha256').update(canonical).digest('hex')
}

export function recipePath(root: string, recipe: string): string {
  return join(root, 'recipes', `${recipe}.py`)
}

export interface SpecContext {
  /** Title line, usually the project name. */
  title: string
  dataset: string
  shape: string
  /** The dataset version the drawing was made from, so an artifact can say which one. */
  version?: number
  /** Shown in the subtitle, so an artifact says which analysis drew it. */
  recipe: string
}

/**
 * Turn a recipe result into the spec a renderer draws — one implementation, because this is the
 * honesty surface: the band note, the footer and the caption are where an artifact promises what it
 * actually shows. `bench run`, `bench rerun` and a view panel all pass through here.
 */
export function chartSpecFor(result: RunResult, context: SpecContext): ChartSpec {
  // Only mention a band when one was actually drawn. A caption promising a band that is not on the
  // canvas is the same class of lie as a curve without an interval.
  const level = Number(result.diagnostics.level)
  const bandKind = typeof result.diagnostics.band === 'string' ? result.diagnostics.band : 'confidence'
  const bandNote =
    result.chart.band !== undefined && Number.isFinite(level)
      ? `${Math.round(level * 100)}% ${bandKind} band`
      : ''
  const footer = [result.chart.footer ?? '', bandNote].filter((part) => part !== '').join(' · ')
  const caption = result.caption ?? result.narrative

  return {
    ...result.chart,
    title: context.title,
    subtitle: `${context.dataset} · ${context.recipe}`,
    // What the artifact was drawn from, structurally: a client pinning a view to a dataset should
    // read this rather than parse the subtitle.
    provenance: {
      dataset: context.dataset,
      shape: context.shape,
      ...(context.version === undefined ? {} : { version: context.version }),
    },
    ...(footer === '' ? {} : { footer }),
    // The artifact carries its own conclusion: the terminal scrollback is not durable. Recipes may
    // supply a shorter form for the canvas; the full argument stays in the log.
    ...(caption === '' ? {} : { caption }),
  }
}

/** Matches what the Python runner reports, so the two can never disagree about a recipe's identity. */
export async function hashRecipeFile(root: string, recipe: string): Promise<string | null> {
  try {
    // Line endings are not part of a recipe's identity: Python runs a CRLF file exactly as it runs
    // an LF one, and a Windows checkout can legitimately hold either. Hashing the raw bytes made
    // the same file read as changed on one machine and current on another, so normalise first.
    const source = await readFile(recipePath(root, recipe), 'utf8')
    return createHash('sha256')
      .update(source.replaceAll('\r\n', '\n'))
      .digest('hex')
  } catch {
    return null
  }
}

function isTime(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

/**
 * Count what changed in a dataset after a moment, from the log's own timestamps.
 *
 * An unparseable time counts as a change: over-reporting change is safe, while telling someone their
 * analysis is current when it might not be is the failure this whole module exists to prevent.
 */
function changesSince(state: ProjectState, datasetId: string, since: string): RunFreshness {
  const boundary = Date.parse(since)
  const after = (value: string | undefined): boolean => {
    if (!isTime(value)) return false
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) || Number.isNaN(boundary) || parsed > boundary
  }

  let addedSince = 0
  let retractedSince = 0
  let correctedSince = 0
  for (const point of state.datasets.get(datasetId)?.points ?? []) {
    // A point that arrived after the run was never part of it. One that was already there can still
    // have left (retracted) or changed (corrected) underneath the result, and each is a different
    // reason for the same answer: this no longer describes the data.
    if (after(point.recordedAt)) {
      if (point.status === 'active') addedSince += 1
      else retractedSince += 1
    } else if (after(point.retractedAt)) {
      retractedSince += 1
    } else if (after(point.correctedAt)) {
      correctedSince += 1
    }
  }
  return { status: 'stale', addedSince, retractedSince, correctedSince }
}

function describe(freshness: RunFreshness): string {
  const parts: string[] = []
  if (freshness.addedSince) parts.push(`${freshness.addedSince} point(s) added`)
  if (freshness.retractedSince) parts.push(`${freshness.retractedSince} retracted`)
  if (freshness.correctedSince) parts.push(`${freshness.correctedSince} corrected`)
  return parts.join(', ')
}

/**
 * Judge every recorded run against the current project. `root` is the application directory (the one
 * holding `recipes/`), not the project directory.
 */
export async function assessRuns(root: string, state: ProjectState): Promise<Map<string, RunFreshness>> {
  const verdicts = new Map<string, RunFreshness>()
  const recipeHashes = new Map<string, string | null>()
  for (const run of state.runs) {
    verdicts.set(run.id, await assessRun(root, state, run, recipeHashes))
  }
  return verdicts
}

async function assessRun(
  root: string,
  state: ProjectState,
  run: RunRecord,
  cache: Map<string, string | null>,
): Promise<RunFreshness> {
  const datasetId = run.dataset ?? (state.datasets.size === 1 ? [...state.datasets.keys()][0]! : null)
  if (!datasetId || !state.datasets.has(datasetId)) {
    return { status: 'unverifiable', reason: 'this run did not record which dataset it read' }
  }
  if (!isTime(run.inputHash) || !isTime(run.recipeHash)) {
    return { status: 'unverifiable', reason: 'this run recorded no fingerprint' }
  }
  // Every answer carries the pin, so `bench runs` can say which version a conclusion rests on even
  // when nothing is wrong with it. Which version it was is half of "what did this rest on".
  const current = state.datasets.get(datasetId)!.version
  const pin: Pick<RunFreshness, 'ranOn' | 'currentVersion'> =
    run.version === undefined ? {} : { ranOn: run.version, currentVersion: current }

  // The version pin first: it is the coarse, named answer. A run that read version 1 is out of date
  // the moment version 2 exists, whatever the rows say.
  if (run.version !== undefined && current > run.version) {
    return {
      status: 'stale',
      reason: `the dataset moved on to version ${current}; this ran on version ${run.version}`,
      ...pin,
    }
  }

  const counted = changesSince(state, datasetId, run.at)
  const described = describe(counted)
  if (described !== '') return { ...counted, reason: `${described} since this run`, ...pin }

  if (!cache.has(run.recipe)) cache.set(run.recipe, await hashRecipeFile(root, run.recipe))
  const currentRecipeHash = cache.get(run.recipe) ?? null
  if (currentRecipeHash === null) {
    return { status: 'unverifiable', reason: `recipes/${run.recipe}.py is missing`, ...pin }
  }
  if (currentRecipeHash !== run.recipeHash) {
    return { status: 'stale', reason: 'the recipe has changed since this run', ...pin }
  }

  const input = buildRunInput(state, datasetId)
  if (!input) return { status: 'unverifiable', reason: `dataset "${datasetId}" is gone`, ...pin }
  if (hashInput(input) !== run.inputHash) {
    // Nothing above found a dated change, so the difference is not one of the three counted kinds:
    // values must have changed without the timestamps moving. Say what is known, not what is guessed.
    return { status: 'stale', reason: 'the inputs no longer match what this run consumed', ...pin }
  }

  return { status: 'fresh', ...pin }
}

/**
 * Which version a run rested on, said even when nothing is wrong: "what did that conclusion rest
 * on" should not need a stale badge to become answerable.
 */
export function versionNote(freshness: RunFreshness | undefined): string {
  if (!freshness || freshness.ranOn === undefined) return ''
  if (freshness.currentVersion === undefined || freshness.currentVersion === freshness.ranOn) {
    return `version ${freshness.ranOn}`
  }
  return `version ${freshness.ranOn} (now ${freshness.currentVersion})`
}

/** One clause for STATE.md and `bench runs`, or an empty string for a fresh run. */
export function freshnessNote(freshness: RunFreshness | undefined): string {
  if (!freshness) return ''
  if (freshness.status === 'fresh') return 'still current'
  if (freshness.status === 'unverifiable') {
    return freshness.reason ? `cannot be checked: ${freshness.reason}` : 'cannot be checked'
  }
  return freshness.reason ? `stale: ${freshness.reason}` : 'stale'
}

/** A stable identity for "the same analysis": the recipe and the parameters it was asked for. */
export function runKey(recipe: string, params: Record<string, unknown>): string {
  return `${recipe} ${JSON.stringify(params, Object.keys(params).sort())}`
}
