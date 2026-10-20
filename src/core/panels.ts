/**
 * Panels: what a tab actually reads and draws.
 *
 * A view file is the saved question; a panel is the materialized answer. Keeping selection,
 * materialization, and staleness here means `bench chart`, `bench view`, and the window all call the
 * same path, and the view module is left with the file format, its validation, and its rendering.
 */
import { APP_ROOT, buildRunInput, chartSpecFor, hashInput, hashRecipeFile } from './analysis.ts'
import { axisValue, resolveAxes, type AxisRequest } from './axes.ts'
import type { ProjectState } from './binder.ts'
import { incrementalMark, type ChartSpec } from './chart.ts'
import type { Shape } from './events.ts'
import { BenchError } from './errors.ts'
import { addHint, emptyChartNote } from './hints.ts'
import type { RunInput, RecipeRunner, RunResult } from './runner.ts'
import type { Workspace } from './workspace.ts'
import type { PanelStatus, QueryClause, ViewFile, ViewPanel, ViewQuery } from './views.ts'

function matches(values: Record<string, unknown>, clause: QueryClause): boolean {
  const actual = values[clause.field]
  if (actual === undefined) return false
  if (clause.op === '==' || clause.op === '!=') {
    const equal = typeof actual === 'number' && typeof clause.value === 'number'
      ? actual === clause.value
      : String(actual) === String(clause.value)
    return clause.op === '==' ? equal : !equal
  }
  if (typeof actual !== 'number' || typeof clause.value !== 'number') {
    throw new BenchError(
      'invalid',
      `query compares "${clause.field}" (${typeof actual}) with ${clause.op} ${String(clause.value)}`,
      { hint: 'ordering comparisons need a numeric field and a numeric value' },
    )
  }
  switch (clause.op) {
    case '>':
      return actual > clause.value
    case '>=':
      return actual >= clause.value
    case '<':
      return actual < clause.value
    case '<=':
      return actual <= clause.value
  }
}

/**
 * The rows a panel reads: the dataset's active points, narrowed by the panel's query, in the same
 * shape a recipe is given. The hash covers exactly this set, so a filter that changes is a change.
 */
export function selectInput(
  state: ProjectState,
  datasetId: string,
  query?: ViewQuery,
): RunInput | null {
  const input = buildRunInput(state, datasetId)
  if (!input) return null
  const clauses = query?.where ?? []
  if (clauses.length === 0) return input
  return {
    ...input,
    points: input.points.filter((point) => clauses.every((clause) => matches(point.values, clause))),
  }
}

export interface PanelRequest {
  dataset?: string
  /** Named axes for a plain plot; omitted keeps the historical x/y pair. */
  xField?: string
  yField?: string
  recipe?: string
  params?: Record<string, unknown>
  query?: ViewQuery
  title?: string
}

export interface PlottedDataset {
  spec: ChartSpec
  plotted: number
  skipped: number
}

/**
 * The request that rebuilds a saved panel. A panel's named axes are part of the question it asked,
 * so rebuilding it without them would ask a different one: every consumer that materializes an
 * existing panel reads its identity from here rather than reconstructing a partial request.
 */
export function plotRequest(panel: ViewPanel): PanelRequest {
  return {
    dataset: panel.dataset,
    ...(panel.x_field === undefined ? {} : { xField: panel.x_field }),
    ...(panel.y_field === undefined ? {} : { yField: panel.y_field }),
    ...(panel.query === undefined ? {} : { query: panel.query }),
    ...(panel.title === undefined ? {} : { title: panel.title }),
  }
}

/**
 * Project one point onto the axes a saved panel reads. `undefined` means the point does not carry a
 * usable value on both axes, so it is not a mark on this panel — not a zero, and not a reason to
 * redraw a chart whose picture did not change.
 */
export function panelPoint(
  panel: ViewPanel,
  shape: Shape,
  values: Record<string, unknown>,
): { x: number; y: number } | undefined {
  const axes = resolveAxes(shape, { x: panel.x_field, y: panel.y_field })
  const x = axisValue(axes.x.field, values[axes.x.field.name])
  const y = axisValue(axes.y.field, values[axes.y.field.name])
  return x === undefined || y === undefined ? undefined : { x, y }
}

export interface IncrementalMark {
  index: number
  /** The record this mark stands for, so hover can name it without re-parsing the drawing. */
  id: string
  /** Where the core placed it, in the drawing's own units. */
  cx: number
  cy: number
  /** The two axis values behind that position, for the tooltip on a custom-axis panel. */
  x: number
  y: number
}

export interface PointProjection {
  /** Panels that can show the point as one extra mark, without redrawing ten thousand of them. */
  marks: IncrementalMark[]
  /** Panels the point does not belong to, because their query excludes it. Nothing changed there. */
  untouched: number[]
  /** True when the window has to repaint the whole tab instead of patching it. */
  redraw: boolean
}

/**
 * Project one appended point onto every panel of a view. This is the core's answer to "can the
 * window patch this frame?": an incremental mark for each panel the point lands on, an untouched
 * index for panels whose query excludes it, and a redraw request when a panel cannot be patched.
 */
export function projectPoint(
  workspace: Workspace,
  view: ViewFile,
  id: string,
  values: Record<string, unknown>,
): PointProjection {
  const marks: IncrementalMark[] = []
  const untouched: number[] = []
  let redraw = false

  for (const [index, panel] of view.panels.entries()) {
    // A fitted panel is not patched: its curve and interval would have to move with the point, and
    // that means running the recipe. It stays as it is and goes stale, which the badge says.
    if (panel.recipe !== undefined) continue
    let input
    let projected
    try {
      input = selectInput(workspace.state, panel.dataset, panel.query)
      // The point is projected against the panel's own axes, not the historical x/y pair. This is
      // the same resolver `plotDataset` used to draw the panel, so an appended mark and a redrawn
      // one cannot disagree about which values are on which axis.
      projected = panelPoint(panel, workspace.shapeOf(panel.dataset), values)
    } catch {
      redraw = true
      continue
    }
    if (!input) {
      redraw = true
      continue
    }
    if (!input.points.some((candidate) => candidate.id === id)) {
      untouched.push(index)
      continue
    }
    if (!projected) {
      // The point does not carry both axes, so `plotDataset` would skip it too: this panel did not
      // change, and inventing a zero would put a measurement on the chart that nobody made.
      untouched.push(index)
      continue
    }
    const placed = incrementalMark(panel.chart, { id, x: projected.x, y: projected.y })
    if (placed === null) {
      // The point would move the axes: that is a different picture, not an extra mark.
      redraw = true
      continue
    }
    marks.push({ index, id, cx: placed.cx, cy: placed.cy, x: projected.x, y: projected.y })
  }

  return { marks, untouched, redraw }
}

/**
 * A dataset drawn without a model: points only, and a footer that says so. This is the one place the
 * unmodelled spec is built, so `bench chart` and a panel without a recipe cannot disagree.
 */
export function plotDataset(
  workspace: Workspace,
  datasetId: string,
  /** The rows a query selected. Omitted means every active point. */
  input?: RunInput,
  /** Heading for the canvas; defaults to the project's name, as `bench chart` has always done. */
  title?: string,
  /** The version those rows came from. Names it on the artifact rather than only in the tab. */
  version?: number,
  /** Named axes. Omitted means x/y, exactly as every pre-existing panel and chart reads. */
  axes?: AxisRequest,
): PlottedDataset {
  const dataset = workspace.dataset(datasetId)
  if (!dataset.definition) {
    throw new BenchError('invariant', `dataset "${datasetId}" has no shape declaration`)
  }
  const pair = resolveAxes(dataset.definition, axes)
  const rows = input === undefined ? dataset.points : input.points
  const plotted = rows
    .map((point) => ({
      id: point.id,
      x: axisValue(pair.x.field, point.values[pair.x.field.name]),
      y: axisValue(pair.y.field, point.values[pair.y.field.name]),
    }))
    .filter((pair): pair is { id: string; x: number; y: number } => pair.x !== undefined && pair.y !== undefined)

  const skipped = rows.length - plotted.length
  const footerParts = [`n = ${plotted.length}`]
  if (skipped > 0) {
    footerParts.push(`${skipped} point(s) without ${pair.x.field.name}/${pair.y.field.name} not plotted`)
  }
  footerParts.push('no fit — unmodelled')

  // Nothing to draw is a state the chart has to own: a fresh project can now save its first tab
  // with no rows, and the empty frame says what to do rather than showing a fake 0 … 1 axis.
  const empty =
    plotted.length > 0
      ? undefined
      : rows.length === 0
        ? emptyChartNote(dataset.definition, datasetId)
        : `No active point carries both "${pair.x.field.name}" and "${pair.y.field.name}". Add one: ${addHint(dataset.definition)}`

  return {
    spec: {
      title: title ?? workspace.config.name,
      subtitle: `${datasetId} · ${dataset.definition.id}`,
      provenance: {
        dataset: datasetId,
        shape: dataset.shape,
        ...(version === undefined ? {} : { version }),
      },
      x: {
        label: pair.x.field.name,
        ...(pair.x.field.unit === undefined ? {} : { unit: pair.x.field.unit }),
        ...(pair.x.time ? { format: 'time' as const } : {}),
      },
      y: {
        label: pair.y.field.name,
        ...(pair.y.field.unit === undefined ? {} : { unit: pair.y.field.unit }),
      },
      points: plotted,
      footer: footerParts.join(' · '),
      ...(empty === undefined ? {} : { empty }),
    },
    plotted: plotted.length,
    skipped,
  }
}

export interface MaterializedPanel {
  panel: ViewPanel
  /** Set when the panel came from a recipe, so the caller can report what the run said. */
  result?: RunResult
}

/**
 * Build one panel from the project as it stands. A recipe panel runs the recipe; a plain panel plots
 * the dataset. Neither records a log event: a view is a saved question, and re-materializing one is
 * not an analysis anyone needs to read later. `bench run` remains the way to record a run.
 */
export async function materializePanel(
  workspace: Workspace,
  request: PanelRequest,
  runner?: RecipeRunner,
): Promise<MaterializedPanel> {
  const datasetId = workspace.resolveDataset(request.dataset)
  const shape = workspace.shapeOf(datasetId)
  if (request.recipe !== undefined && (request.xField !== undefined || request.yField !== undefined)) {
    throw new BenchError('invalid', 'a recipe panel chooses its axes through its parameters', {
      hint: 'drop --x-field/--y-field, or build a plain plot',
    })
  }
  const input = selectInput(workspace.state, datasetId, request.query)
  if (!input) throw new BenchError('missing', `no dataset "${datasetId}"`)
  // A plain plot with no rows is a real tab: it draws the axes and says what to add. A recipe with
  // no rows has nothing to model, so it still refuses — with the shape's own command, not `x`/`y`.
  if (input.points.length === 0 && request.recipe !== undefined) {
    throw new BenchError(
      'missing',
      `dataset "${datasetId}" has no active points${request.query ? ' matching the query' : ''}`,
      { hint: addHint(shape) },
    )
  }

  const title = request.title ?? workspace.config.name
  // Pinned here, once: every panel records the version it actually read.
  const version = workspace.currentVersion(datasetId)

  if (request.recipe === undefined) {
    const { spec, plotted } = plotDataset(workspace, datasetId, input, title, version, {
      ...(request.xField === undefined ? {} : { x: request.xField }),
      ...(request.yField === undefined ? {} : { y: request.yField }),
    })
    return {
      panel: {
        dataset: datasetId,
        version,
        ...(request.title === undefined ? {} : { title: request.title }),
        ...(request.query === undefined ? {} : { query: request.query }),
        ...(request.xField === undefined ? {} : { x_field: request.xField }),
        ...(request.yField === undefined ? {} : { y_field: request.yField }),
        chart: spec,
        n: plotted,
        input_hash: hashInput(input),
      },
    }
  }

  if (!runner) {
    throw new BenchError('invariant', `a panel for recipe "${request.recipe}" needs the analysis runtime`)
  }
  const params = request.params ?? {}
  const outcome = await runner.run(request.recipe, params, input)
  if (!outcome.ok) {
    throw new BenchError('invariant', outcome.error.message, {
      hint: outcome.error.hint ?? `code: ${outcome.error.code}`,
    })
  }
  const result = outcome.result
  return {
    panel: {
      dataset: datasetId,
      version,
      ...(request.title === undefined ? {} : { title: request.title }),
      ...(request.query === undefined ? {} : { query: request.query }),
      recipe: result.recipe,
      params,
      chart: chartSpecFor(result, {
        title,
        dataset: datasetId,
        shape: shape.id,
        version,
        recipe: result.recipe,
      }),
      verdict: result.verdict,
      n: Number(result.diagnostics.n),
      recipe_hash: result.recipeHash,
      input_hash: hashInput(input),
    },
    result,
  }
}

/**
 * Whether a panel still describes the project. Three answers, for the same reason a run has three:
 * a panel saved before fingerprints existed cannot be checked, and calling that current is a guess.
 */
export async function panelStatus(
  workspace: Workspace,
  panel: ViewPanel,
  index: number,
): Promise<PanelStatus> {
  const dataset = workspace.state.datasets.get(panel.dataset)
  if (!dataset) return { index, state: 'missing', detail: `dataset "${panel.dataset}" is gone` }

  // The version pin: a panel drawn from version 1 is stale the moment version 2 exists, even when a
  // row happens to read the same. This is the answer to "what did this rest on", and it is checked
  // before the fingerprint because it is the coarser, more certain fact.
  if (panel.version !== 'latest' && dataset.version > panel.version) {
    return {
      index,
      state: 'stale',
      detail: `the dataset is at version ${dataset.version}; this panel was drawn from version ${panel.version}`,
    }
  }

  // A recipe can change without the data moving, and a panel drawn by the old one would still look
  // authoritative. Same check recorded runs get, for the same reason.
  if (panel.recipe !== undefined && panel.recipe_hash !== undefined) {
    const current = await hashRecipeFile(APP_ROOT, panel.recipe)
    if (current === null) {
      return { index, state: 'missing', detail: `recipes/${panel.recipe}.py is gone` }
    }
    if (current !== panel.recipe_hash) {
      return { index, state: 'stale', detail: 'the recipe has changed since this panel was saved' }
    }
  }

  if (panel.input_hash === undefined || panel.input_hash === '') {
    return { index, state: 'unchecked', detail: 'this panel recorded no fingerprint' }
  }
  let input: RunInput | null
  try {
    input = selectInput(workspace.state, panel.dataset, panel.query)
  } catch (error) {
    return { index, state: 'stale', detail: error instanceof Error ? error.message : String(error) }
  }
  if (!input) return { index, state: 'missing', detail: `dataset "${panel.dataset}" is gone` }
  if (hashInput(input) === panel.input_hash) return { index, state: 'current' }
  return { index, state: 'stale', detail: 'the data changed since this panel was saved' }
}

export async function panelStatuses(workspace: Workspace, view: ViewFile): Promise<PanelStatus[]> {
  const statuses: PanelStatus[] = []
  for (const [index, panel] of view.panels.entries()) {
    statuses.push(await panelStatus(workspace, panel, index))
  }
  return statuses
}

export interface PanelRebuild {
  statuses: PanelStatus[]
  refreshed: number[]
  kept: { index: number; reason: string }[]
}

/**
 * Materialize the plain panels a write invalidated, in place, without Python and without re-reading
 * the log. A recipe panel needs the analysis runtime, which is deliberately not on this path: it
 * stays as it was, keeps its `stale` badge, and `kept` says why.
 */
export async function rebuildStalePanels(
  workspace: Workspace,
  view: ViewFile,
): Promise<PanelRebuild> {
  let statuses = await panelStatuses(workspace, view)
  const refreshed: number[] = []
  const kept: { index: number; reason: string }[] = []

  for (const status of statuses) {
    if (status.state === 'current' || status.state === 'unchecked') continue
    const panel = view.panels[status.index]!
    if (panel.recipe !== undefined) {
      kept.push({ index: status.index, reason: 'it was drawn by a recipe, which needs the analysis runtime' })
      continue
    }
    try {
      view.panels[status.index] = (await materializePanel(workspace, plotRequest(panel))).panel
      refreshed.push(status.index)
    } catch (error) {
      kept.push({
        index: status.index,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // A panel that `materializePanel` just rebuilt is current by construction: that call pinned the
  // current version and took its fingerprint from the same state this answer describes. Re-hashing it
  // here would pay twice for the same ten thousand points on the keystroke path. Every other panel's
  // verdict is unchanged by this write, so the first pass already answered it.
  statuses = statuses.map((status): PanelStatus =>
    refreshed.includes(status.index) ? { index: status.index, state: 'current' } : status,
  )
  return { statuses, refreshed, kept }
}
