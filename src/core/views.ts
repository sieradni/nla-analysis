/**
 * Views: the JSON that *is* a tab (requirements §4).
 *
 * A view is a file in the project, not a row in a database, so the agent that writes one and the
 * window that renders one look at the same artifact. Each panel names the dataset it reads, the
 * query that selected rows, the recipe and parameters when an analysis produced it, and the
 * materialized chart spec. The spec is materialized on purpose: re-rendering a saved view must not
 * need Python or the log, because a tab is drawn on every repaint, not on every question.
 *
 * A panel also carries the fingerprint of the points it consumed. That is what makes "this tab is
 * showing stale data" answerable offline — the same argument as a recorded run's `input_hash`, and
 * the same refusal to call something current without checking.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { APP_ROOT, buildRunInput, chartSpecFor, hashInput, hashRecipeFile } from './analysis.ts'
import type { ProjectState } from './binder.ts'
import { CHART_HEIGHT, CHART_WIDTH, renderChartGroup, type ChartSpec } from './chart.ts'
import { BenchError } from './errors.ts'
import type { RunInput, RecipeRunner, RunResult } from './runner.ts'
import type { Workspace } from './workspace.ts'

export type QueryOp = '>' | '>=' | '<' | '<=' | '==' | '!='

export interface QueryClause {
  field: string
  op: QueryOp
  value: number | string
}

/**
 * Deliberately tiny. A view may select rows; it may not compute with them, because anything computed
 * would be a derived value in a place the honesty rules do not reach. Transformations belong in a
 * recipe, where they are hashed and reported.
 */
export interface ViewQuery {
  where?: QueryClause[]
}

export interface ViewPanel {
  /** Optional heading; falls back to the chart's own title. */
  title?: string
  dataset: string
  /** Only `latest` exists today. Versions are a later feature, and this will not pretend otherwise. */
  version: 'latest'
  query?: ViewQuery
  recipe?: string
  params?: Record<string, unknown>
  /** The materialized spec: what renders without Python. */
  chart: ChartSpec
  /** Echoed from the run, so a tab can show its verdict without parsing the footer. */
  verdict?: string
  n?: number
  /** The `analysis_run` event this panel came from, when it came from one. */
  run?: string
  /** Fingerprint of the recipe file that produced this panel, so a recipe edit is not invisible. */
  recipe_hash?: string
  /** Fingerprint of the points this panel consumed. Absent means "cannot be checked". */
  input_hash?: string
}

export interface ViewFile {
  v: 1
  name: string
  layout: { columns: number }
  panels: ViewPanel[]
}

export interface ViewSummary {
  name: string
  file: string
  columns: number
  panels: number
  recipes: string[]
}

export type PanelState = 'current' | 'stale' | 'missing' | 'unchecked'

export interface PanelStatus {
  index: number
  state: PanelState
  /** Why, in the words a person would use. Absent when the panel is current. */
  detail?: string
}

const VIEW_SUFFIX = '.json'
const MAX_COLUMNS = 4
const GAP = 18

/** A view's filename. Names are titles; the file keeps to characters every filesystem accepts. */
export function slugFor(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (slug === '') {
    throw new BenchError('invalid', `"${name}" is not a usable view name`, {
      hint: 'use letters, digits and spaces, e.g. "drift over time"',
    })
  }
  return slug
}

export function viewPath(dir: string, name: string): string {
  return join(dir, 'views', `${slugFor(name)}${VIEW_SUFFIX}`)
}

// --- validation -----------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

function num(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function unknownKeys(value: Record<string, unknown>, allowed: string[], where: string): string[] {
  return Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .map((key) => `${where}: unknown field "${key}"`)
}

/** The renderer's minimum: axes and a point list with numbers in it. A bad spec must refuse, not throw mid-draw. */
function checkChart(value: unknown, where: string): string[] {
  if (!isRecord(value)) return [`${where}: chart must be an object`]
  const problems: string[] = []
  for (const axis of ['x', 'y'] as const) {
    const spec = value[axis]
    if (!isRecord(spec) || !str(spec.label)) problems.push(`${where}: chart.${axis}.label is required`)
  }
  for (const optional of ['title', 'subtitle', 'footer', 'caption']) {
    if (value[optional] !== undefined && typeof value[optional] !== 'string') {
      problems.push(`${where}: chart.${optional} must be a string`)
    }
  }
  if (value.provenance !== undefined) {
    if (!isRecord(value.provenance)) problems.push(`${where}: chart.provenance must be an object`)
    else {
      for (const field of ['dataset', 'shape']) {
        if (value.provenance[field] !== undefined && typeof value.provenance[field] !== 'string') {
          problems.push(`${where}: chart.provenance.${field} must be a string`)
        }
      }
    }
  }
  if (value.points !== undefined) {
    if (!Array.isArray(value.points)) problems.push(`${where}: chart.points must be an array`)
    else {
      value.points.forEach((point, index) => {
        if (!isRecord(point) || !num(point.x) || !num(point.y)) {
          problems.push(`${where}: chart.points[${index}] needs numeric x and y`)
        } else if (point.id !== undefined && typeof point.id !== 'string') {
          problems.push(`${where}: chart.points[${index}].id must be a string`)
        }
      })
    }
  }
  for (const optional of ['line', 'band'] as const) {
    if (value[optional] !== undefined && !Array.isArray(value[optional])) {
      problems.push(`${where}: chart.${optional} must be an array`)
    }
  }
  if (value.lines !== undefined) {
    if (!Array.isArray(value.lines)) problems.push(`${where}: chart.lines must be an array`)
    else {
      value.lines.forEach((series, index) => {
        if (!isRecord(series) || !Array.isArray(series.points)) {
          problems.push(`${where}: chart.lines[${index}] needs a points array`)
        }
      })
    }
  }
  return problems
}

/** `at` is the full path to the query object, so a problem reads the same from a panel or a flag. */
function checkQuery(value: unknown, at: string): string[] {
  if (!isRecord(value)) return [`${at} must be an object`]
  const problems = unknownKeys(value, ['where'], at)
  if (value.where === undefined) return problems
  if (!Array.isArray(value.where)) return [...problems, `${at}.where must be an array`]
  value.where.forEach((clause, index) => {
    const here = `${at}.where[${index}]`
    if (!isRecord(clause)) {
      problems.push(`${here} must be an object`)
      return
    }
    problems.push(...unknownKeys(clause, ['field', 'op', 'value'], here))
    if (!str(clause.field)) problems.push(`${here}.field is required`)
    if (!['>', '>=', '<', '<=', '==', '!='].includes(clause.op as string)) {
      problems.push(`${here}.op must be one of > >= < <= == !=`)
    }
    if (!num(clause.value) && typeof clause.value !== 'string') {
      problems.push(`${here}.value must be a number or a string`)
    }
  })
  return problems
}

/** Validate one query on its own, for `bench view new --query '{"where":[…]}'`. */
export function validateQuery(value: unknown): ViewQuery {
  const problems = checkQuery(value, 'query')
  if (problems.length > 0) throw new BenchError('invalid', 'query rejected', { problems })
  return value as ViewQuery
}

function checkPanel(value: unknown, index: number): string[] {
  const where = `panel ${index + 1}`
  if (!isRecord(value)) return [`${where} must be an object`]
  const problems = unknownKeys(
    value,
    [
      'title',
      'dataset',
      'version',
      'query',
      'recipe',
      'params',
      'chart',
      'verdict',
      'n',
      'run',
      'recipe_hash',
      'input_hash',
    ],
    where,
  )

  if (!str(value.dataset)) problems.push(`${where}.dataset is required`)
  if (value.version !== 'latest') {
    problems.push(`${where}.version must be "latest" (dataset versions do not exist yet)`)
  }
  if (value.title !== undefined && typeof value.title !== 'string') problems.push(`${where}.title must be a string`)
  if (value.recipe !== undefined && !str(value.recipe)) problems.push(`${where}.recipe must be a non-empty string`)
  if (value.params !== undefined && !isRecord(value.params)) problems.push(`${where}.params must be an object`)
  if (value.verdict !== undefined && typeof value.verdict !== 'string') {
    problems.push(`${where}.verdict must be a string`)
  }
  if (value.n !== undefined && !num(value.n)) problems.push(`${where}.n must be a number`)
  if (value.run !== undefined && !str(value.run)) problems.push(`${where}.run must be a string`)
  if (value.recipe_hash !== undefined && !str(value.recipe_hash)) {
    problems.push(`${where}.recipe_hash must be a string`)
  }
  if (value.input_hash !== undefined && !str(value.input_hash)) {
    problems.push(`${where}.input_hash must be a string`)
  }
  if (value.query !== undefined) problems.push(...checkQuery(value.query, `${where}.query`))
  problems.push(...checkChart(value.chart, where))

  // The claim and the marks must agree. A panel that says n = 14 while drawing 3 points is exactly
  // the kind of quiet mismatch this project refuses, and it is cheap to catch here.
  if (num(value.n) && isRecord(value.chart) && Array.isArray(value.chart.points)) {
    if (value.n !== value.chart.points.length) {
      problems.push(
        `${where}: n is ${value.n} but the chart draws ${value.chart.points.length} point(s)`,
      )
    }
  }
  return problems
}

/** Validate a parsed view file. Every unknown field is an error, so a typo cannot pass as intent. */
export function validateView(value: unknown): ViewFile {
  if (!isRecord(value)) throw new BenchError('invalid', 'a view must be a JSON object')
  const problems = unknownKeys(value, ['v', 'name', 'layout', 'panels'], 'view')
  if (value.v !== 1) problems.push('view: v must be 1')
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  if (name === '') problems.push('view: name is required')
  else {
    try {
      slugFor(name)
    } catch {
      problems.push(`view: "${name}" has no letters or digits to make a filename from`)
    }
  }

  let columns = 2
  if (value.layout !== undefined) {
    if (!isRecord(value.layout)) problems.push('view: layout must be an object')
    else {
      problems.push(...unknownKeys(value.layout, ['columns'], 'view.layout'))
      const requested = value.layout.columns
      if (!num(requested) || !Number.isInteger(requested) || requested < 1 || requested > MAX_COLUMNS) {
        problems.push(`view: layout.columns must be an integer from 1 to ${MAX_COLUMNS}`)
      } else {
        columns = requested
      }
    }
  }

  const panels = value.panels
  if (!Array.isArray(panels) || panels.length === 0) {
    problems.push('view: panels must be a non-empty array')
  } else {
    panels.forEach((panel, index) => problems.push(...checkPanel(panel, index)))
  }

  if (problems.length > 0) {
    throw new BenchError('invalid', 'view rejected', { problems })
  }

  return {
    v: 1,
    name,
    layout: { columns },
    panels: panels as ViewPanel[],
  }
}

// --- storage --------------------------------------------------------------------------------

export async function saveView(dir: string, view: ViewFile): Promise<string> {
  const file = viewPath(dir, view.name)
  await mkdir(join(dir, 'views'), { recursive: true })
  await writeFile(file, JSON.stringify(view, null, 2) + '\n')
  return file
}

export async function loadView(dir: string, name: string): Promise<ViewFile> {
  const file = viewPath(dir, name)
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    throw new BenchError('missing', `no view named "${name}"`, { hint: 'run `bench view list`' })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new BenchError('invalid', `views/${slugFor(name)}.json is not valid JSON`, { problems: [file] })
  }
  try {
    return validateView(parsed)
  } catch (error) {
    // A view edited by hand is the case this exists for: say which field, and which file.
    if (error instanceof BenchError) {
      throw new BenchError('invalid', `views/${slugFor(name)}.json is not a valid view`, {
        problems: error.problems,
        hint: 'fix the file, or write it with `bench view save`',
      })
    }
    throw error
  }
}

export async function listViews(dir: string): Promise<{ views: ViewSummary[]; problems: string[] }> {
  let names: string[]
  try {
    names = (await readdir(join(dir, 'views'), { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(VIEW_SUFFIX))
      .map((entry) => entry.name)
  } catch {
    return { views: [], problems: [] }
  }

  const views: ViewSummary[] = []
  const problems: string[] = []
  for (const file of names.sort()) {
    try {
      const view = validateView(JSON.parse(await readFile(join(dir, 'views', file), 'utf8')))
      views.push({
        name: view.name,
        file: `views/${file}`,
        columns: view.layout.columns,
        panels: view.panels.length,
        recipes: [...new Set(view.panels.flatMap((panel) => (panel.recipe ? [panel.recipe] : [])))],
      })
    } catch (error) {
      problems.push(`${file}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { views: views.sort((left, right) => left.name.localeCompare(right.name)), problems }
}

/**
 * Never delete a view: a tab the user built is history. Replacing one is an explicit act, and the
 * caller says so with `overwrite`.
 */
export async function requireFreeName(dir: string, name: string, overwrite: boolean): Promise<void> {
  const { views } = await listViews(dir)
  const existing = views.find((view) => view.name.toLowerCase() === name.trim().toLowerCase())
  if (existing && !overwrite) {
    throw new BenchError('invalid', `a view named "${name}" already exists`, {
      hint: `pass --force to replace ${existing.file}`,
    })
  }
}

// --- selection ------------------------------------------------------------------------------

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

// --- materialization ------------------------------------------------------------------------

export interface PanelRequest {
  dataset?: string
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
): PlottedDataset {
  const dataset = workspace.dataset(datasetId)
  const rows = input === undefined ? dataset.points : input.points
  const plotted = rows
    .map((point) => ({ id: point.id, x: numericIn(point.values, 'x'), y: numericIn(point.values, 'y') }))
    .filter((pair): pair is { id: string; x: number; y: number } => pair.x !== undefined && pair.y !== undefined)

  const skipped = rows.length - plotted.length
  const footerParts = [`n = ${plotted.length}`]
  if (skipped > 0) footerParts.push(`${skipped} point(s) without x/y not plotted`)
  footerParts.push('no fit — unmodelled')

  return {
    spec: {
      title: title ?? workspace.config.name,
      subtitle: `${datasetId} · ${dataset.definition?.id ?? 'unknown shape'}`,
      provenance: { dataset: datasetId, shape: dataset.shape },
      x: { label: 'x' },
      y: { label: 'y' },
      points: plotted,
      footer: footerParts.join(' · '),
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
  const input = selectInput(workspace.state, datasetId, request.query)
  if (!input) throw new BenchError('missing', `no dataset "${datasetId}"`)
  if (input.points.length === 0) {
    throw new BenchError(
      'missing',
      `dataset "${datasetId}" has no active points${request.query ? ' matching the query' : ''}`,
      { hint: 'bench add --x 1 --y 2' },
    )
  }

  const title = request.title ?? workspace.config.name

  if (request.recipe === undefined) {
    const { spec, plotted } = plotDataset(workspace, datasetId, input, title)
    return {
      panel: {
        dataset: datasetId,
        version: 'latest',
        ...(request.title === undefined ? {} : { title: request.title }),
        ...(request.query === undefined ? {} : { query: request.query }),
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
      version: 'latest',
      ...(request.title === undefined ? {} : { title: request.title }),
      ...(request.query === undefined ? {} : { query: request.query }),
      recipe: result.recipe,
      params,
      chart: chartSpecFor(result, { title, dataset: datasetId, shape: shape.id, recipe: result.recipe }),
      verdict: result.verdict,
      n: Number(result.diagnostics.n),
      recipe_hash: result.recipeHash,
      input_hash: hashInput(input),
    },
    result,
  }
}

// --- staleness ------------------------------------------------------------------------------

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

// --- rendering ------------------------------------------------------------------------------

/**
 * Compose a view into one SVG, without Python and without reading the log. Panels keep their own
 * coordinates inside a nested group, so the grid is the only thing this function decides.
 */
function numericIn(values: Record<string, unknown>, field: string): number | undefined {
  const value = values[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function renderView(view: ViewFile): string {
  const columns = Math.min(MAX_COLUMNS, Math.max(1, view.layout.columns))
  const rows = Math.ceil(view.panels.length / columns)
  const width = columns * CHART_WIDTH + (columns + 1) * GAP
  const height = rows * CHART_HEIGHT + (rows + 1) * GAP
  const label = `${view.name} — ${view.panels.length} panel(s)`

  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escapeXml(label)}" data-view="${escapeXml(slugFor(view.name))}">`,
    `<title>${escapeXml(label)}</title>`,
    `<rect width="${width}" height="${height}" fill="#ffffff"/>`,
  ]

  view.panels.forEach((panel, index) => {
    const column = index % columns
    const row = Math.floor(index / columns)
    parts.push(
      renderChartGroup(panel.chart, {
        x: GAP + column * (CHART_WIDTH + GAP),
        y: GAP + row * (CHART_HEIGHT + GAP),
        panel: index + 1,
      }),
    )
  })

  parts.push('</svg>')
  return parts.join('\n')
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
