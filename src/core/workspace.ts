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
import { APP_ROOT, assessRuns, buildRunInput, hashInput, type RunFreshness } from './analysis.ts'
import { activePoints, bind, type Point, type ProjectState, type RunRecord } from './binder.ts'
import { renderChart, type ChartSpec } from './chart.ts'
import { makeEvent } from './events.ts'
import type { BenchEvent, PointValue, Shape } from './events.ts'
import {
  DEFAULT_DATASET,
  findProjectDir,
  openProject,
  writeStateBrief,
  type ProjectConfig,
  type ProjectHandle,
} from './project.ts'
import type { RecipeRunner, RunResult } from './runner.ts'
import { validateValues } from './shapes.ts'

export type ErrorKind = 'invalid' | 'missing' | 'invariant'

/** A refusal a caller can present. The kind maps onto the CLI's exit codes and nothing else. */
export class BenchError extends Error {
  readonly kind: ErrorKind
  readonly hint?: string
  /** Per-field or per-row detail, printed under the message when there is any. */
  readonly problems: string[]

  constructor(kind: ErrorKind, message: string, options: { hint?: string; problems?: string[] } = {}) {
    super(message)
    this.name = 'BenchError'
    this.kind = kind
    if (options.hint !== undefined) this.hint = options.hint
    this.problems = options.problems ?? []
  }
}

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
}

export interface PointRetraction {
  event: BenchEvent
  dataset: string
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

/** Canonical UTC with milliseconds, so ordering by string and by instant agree. */
function canonicalTime(input: string): string {
  const parsed = Date.parse(input)
  if (Number.isNaN(parsed)) {
    throw new BenchError('invalid', `not a parseable time: "${input}"`, { hint: 'use an ISO timestamp' })
  }
  return new Date(parsed).toISOString()
}

export class Workspace {
  // Declared as fields rather than constructor parameter properties: Node's type-stripping mode
  // rejects the latter outright, and the tests' transpiler accepts it, so the CLI dies while the
  // suite stays green. That gap has bitten this project once already.
  private events: BenchEvent[]
  private current: ProjectState
  private logProblems: string[]

  /** The open project: its directory, config, log and session id. */
  readonly handle: ProjectHandle

  private constructor(
    handle: ProjectHandle,
    events: BenchEvent[],
    state: ProjectState,
    logProblems: string[],
  ) {
    this.handle = handle
    this.events = events
    this.current = state
    this.logProblems = logProblems
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
    const { events, problems } = await handle.log.read()
    return new Workspace(handle, events, bind(events), problems)
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

  // --- writing -------------------------------------------------------------------------------

  /**
   * Append to the log, fold it into the in-memory state, and leave the disk brief alone.
   *
   * Folding into memory rather than re-reading the file is what keeps a keystroke inside budget
   * (ADR 0003: 15.7 ms versus a full re-read on top). `pull` exists for when something else may have
   * written to the log.
   */
  private async append(events: BenchEvent[]): Promise<void> {
    if (events.length === 0) return
    await this.handle.log.appendMany(events)
    this.events = [...this.events, ...events]
    this.current = bind(this.events)
  }

  /** Re-read the log from disk. Use when another process may have appended. */
  async pull(): Promise<ProjectState> {
    const { events, problems } = await this.handle.log.read()
    this.events = events
    this.logProblems = problems
    this.current = bind(events)
    return this.current
  }

  /** Write STATE.md from the current state. The CLI does this after every mutation. */
  async writeStateBrief(): Promise<void> {
    await writeStateBrief(this.handle, this.current)
  }

  async recordPoint(draft: PointDraft): Promise<RecordedPoint> {
    const datasetId = this.resolveDataset(draft.dataset)
    const shape = this.shapeOf(datasetId)
    if (Object.keys(draft.values).length === 0) {
      throw new BenchError('invalid', 'nothing to record', {
        hint: `pass --x and --y, or --values '{"x":1,"y":2}'`,
      })
    }

    const tObserved = canonicalTime(draft.tObserved ?? new Date().toISOString())
    const validation = validateValues(shape, draft.values)
    if (validation.errors.length > 0) {
      throw new BenchError('invalid', 'point rejected', { problems: validation.errors })
    }

    const event = makeEvent('point_recorded', this.handle.session, {
      dataset: datasetId,
      shape: shape.id,
      values: draft.values,
      t_observed: tObserved,
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
    await this.append(events)
    return this.current
  }

  async correctPoint(id: string, patch: Record<string, PointValue>, reason?: string): Promise<PointCorrection> {
    const found = this.findPoint(id)
    if (!found) throw new BenchError('missing', `no point with id "${id}"`)
    if (Object.keys(patch).length === 0) {
      throw new BenchError('invalid', 'nothing to correct', { hint: `pass --values '{"y":3.5}'` })
    }

    // Validate the merged result, so a correction cannot leave a point that its own shape rejects.
    const shape = this.current.shapes.get(
      this.current.datasets.get(found.dataset)?.shape ?? '',
    )
    if (shape) {
      const validation = validateValues(shape, { ...found.point.values, ...patch })
      if (validation.errors.length > 0) {
        throw new BenchError('invalid', 'correction rejected', { problems: validation.errors })
      }
    }

    const event = makeEvent('point_corrected', this.handle.session, {
      dataset: found.dataset,
      supersedes: id,
      values: patch,
      ...(reason === undefined ? {} : { reason }),
    })
    await this.append([event])
    return {
      event,
      dataset: found.dataset,
      values: patch,
      now: { ...found.point.values, ...patch },
    }
  }

  async retractPoint(id: string, reason?: string): Promise<PointRetraction> {
    const found = this.findPoint(id)
    if (!found) throw new BenchError('missing', `no point with id "${id}"`)

    const event = makeEvent('point_retracted', this.handle.session, {
      dataset: found.dataset,
      supersedes: id,
      ...(reason === undefined ? {} : { reason }),
    })
    await this.append([event])
    return { event, dataset: found.dataset, active: activePoints(this.current, found.dataset).length }
  }

  async recordDecision(text: string, tags?: string[]): Promise<BenchEvent> {
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
    const datasetId = this.resolveDataset(request.dataset ?? request.repeatOf?.dataset)
    const input = buildRunInput(this.current, datasetId)
    if (!input) throw new BenchError('missing', `no dataset "${datasetId}"`)
    if (input.points.length === 0) {
      throw new BenchError('missing', `dataset "${datasetId}" has no active points`, {
        hint: 'bench add --x 1 --y 2',
      })
    }

    const outcome = await runner.run(request.recipe, request.params, input)
    if (!outcome.ok) {
      throw new BenchError('invariant', outcome.error.message, {
        hint: outcome.error.hint ?? `code: ${outcome.error.code}`,
      })
    }
    const result = outcome.result

    // Only mention a band when one was actually drawn. A caption promising a band that is not on the
    // canvas is the same class of lie as a curve without an interval.
    const level = Number(result.diagnostics.level)
    const bandKind = typeof result.diagnostics.band === 'string' ? result.diagnostics.band : 'confidence'
    const bandNote =
      result.chart.band !== undefined && Number.isFinite(level)
        ? `${Math.round(level * 100)}% ${bandKind} band`
        : ''
    const footer = [result.chart.footer ?? '', bandNote].filter((part) => part !== '').join(' · ')

    const spec: ChartSpec = {
      ...result.chart,
      title: this.handle.config.name,
      subtitle: `${datasetId} · ${request.recipe}`,
      // What the artifact was drawn from, structurally: a client pinning a view to a dataset should
      // read this rather than parse the subtitle.
      provenance: { dataset: datasetId, shape: this.current.datasets.get(datasetId)!.shape },
      ...(footer === '' ? {} : { footer }),
      // The artifact carries its own conclusion: the terminal scrollback is not durable. Recipes may
      // supply a shorter form for the canvas; the full argument stays in the log.
      ...((result.caption ?? result.narrative) === ''
        ? {}
        : { caption: result.caption ?? result.narrative }),
    }

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
