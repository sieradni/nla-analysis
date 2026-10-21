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
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { CHART_HEIGHT, CHART_WIDTH, renderChartGroup, type ChartSpec } from './chart.ts'
import { BenchError } from './errors.ts'

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
  /**
   * The dataset version this panel was drawn from. Materializing a panel pins the version that was
   * current at that moment, so a panel is a statement about specific rows — not about whatever the
   * dataset happens to hold when someone opens the tab. `latest` is accepted for a hand-written view
   * and means "draw from the newest version".
   */
  version: number | 'latest'
  query?: ViewQuery
  /** Named axes for a plain plot. Absent means the historical x/y pair. */
  x_field?: string
  y_field?: string
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
      'x_field',
      'y_field',
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
  if (value.version !== 'latest' && !(num(value.version) && Number.isInteger(value.version) && value.version >= 1)) {
    problems.push(`${where}.version must be "latest" or a version number (1, 2, …)`)
  }
  if (value.title !== undefined && typeof value.title !== 'string') problems.push(`${where}.title must be a string`)
  if (value.x_field !== undefined && !str(value.x_field)) problems.push(`${where}.x_field must be a field name`)
  if (value.y_field !== undefined && !str(value.y_field)) problems.push(`${where}.y_field must be a field name`)
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

/** How many closed tabs the project keeps before the oldest leaves. Derived state, and disposable. */
const TRASH_KEEP = 20

/** Where a closed tab waits: inside `views/`, so the project carries it and a restart does not lose it. */
function trashDir(dir: string): string {
  return join(dir, 'views', '.trash')
}

/**
 * When a closed tab was archived, read from its own name. Fixed-width, so comparing the strings is
 * comparing the instants; a file whose name does not carry one sorts first and leaves first.
 */
function archivedAt(file: string): string {
  const match = /-(\d{4}-\d{2}-\d{2}T[\d-]+Z)(?:-\d+)?\.json$/.exec(file)
  return match ? match[1]! : ''
}

/** Keep the last `TRASH_KEEP` closed tabs, oldest first out. A failure here never fails a close. */
async function trimTrash(dir: string): Promise<void> {
  let files: string[]
  try {
    files = (await readdir(trashDir(dir), { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(VIEW_SUFFIX))
      .map((entry) => entry.name)
  } catch {
    return
  }
  if (files.length <= TRASH_KEEP) return
  files.sort((left, right) => archivedAt(left).localeCompare(archivedAt(right)) || left.localeCompare(right))
  for (const file of files.slice(0, files.length - TRASH_KEEP)) {
    await rm(join(trashDir(dir), file))
  }
}

/**
 * A tab waiting in `views/.trash/`, as the window lists it. The file is the tab's whole spec: the
 * archive is the tab, so nothing about it needs a second copy to survive a relaunch.
 */
export interface ClosedView {
  /** The file inside `views/.trash/`. */
  file: string
  name: string
  panels: number
  /** When it was closed, read from its own name; empty if the name does not carry one. */
  closedAt: string
}

/** Newest first, which is the order a closed tab comes back in. */
function newestClosedFirst(left: string, right: string): number {
  return archivedAt(right).localeCompare(archivedAt(left)) || right.localeCompare(left)
}

/**
 * Read one archived tab. The file is written by `saveView`, but it is still the project's file: a
 * hand-edited or half-written archive is a refusal, not a drawing.
 */
async function readClosedView(dir: string, file: string): Promise<ViewFile> {
  let text: string
  try {
    text = await readFile(join(trashDir(dir), file), 'utf8')
  } catch {
    throw new BenchError('missing', 'that closed tab is no longer in the project', {
      hint: 'a later close pruned it, or another window reopened it',
    })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new BenchError('invalid', `views/.trash/${file} is not valid JSON`, { problems: [file] })
  }
  return validateView(parsed)
}

/**
 * Take a tab's file away, and say where it went.
 *
 * Closing a tab is a window act, not a dataset event: a view is derived state, so nothing about it
 * belongs in the log and no data is touched. The file itself moves to `views/.trash/` rather than
 * being deleted, because a tab carries choices nothing can derive again — its title, its axes, its
 * recipe and its layout — and a window that forgot its stack must not be the thing that loses them.
 * The archive is the tab: `listClosedViews` reads it back after a relaunch, and `restoreClosedView`
 * moves it home, so the same bytes are never written twice.
 */
export async function closeView(dir: string, name: string): Promise<ClosedView> {
  const view = await loadView(dir, name)
  await mkdir(trashDir(dir), { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  // Two closes in the same millisecond must not overwrite the earlier archive.
  let file = `${slugFor(view.name)}-${stamp}${VIEW_SUFFIX}`
  for (let bump = 1; existsSync(join(trashDir(dir), file)); bump += 1) {
    file = `${slugFor(view.name)}-${stamp}-${bump}${VIEW_SUFFIX}`
  }
  await rename(viewPath(dir, view.name), join(trashDir(dir), file))
  await trimTrash(dir)
  return { file, name: view.name, panels: view.panels.length, closedAt: archivedAt(file) }
}

/**
 * The tabs waiting in the trash, newest first — the list a window fills itself from on launch, so a
 * close outlives the process that made it. Bounded and disposable in the same way the trash is: the
 * newest `TRASH_KEEP` only, and an unreadable archive is a problem to report, never a tab to offer.
 */
export async function listClosedViews(
  dir: string,
): Promise<{ closed: ClosedView[]; problems: string[] }> {
  let files: string[]
  try {
    files = (await readdir(trashDir(dir), { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(VIEW_SUFFIX))
      .map((entry) => entry.name)
  } catch {
    return { closed: [], problems: [] }
  }
  const closed: ClosedView[] = []
  const problems: string[] = []
  for (const file of files.sort(newestClosedFirst)) {
    try {
      const view = await readClosedView(dir, file)
      closed.push({ file, name: view.name, panels: view.panels.length, closedAt: archivedAt(file) })
    } catch (error) {
      problems.push(`views/.trash/${file}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { closed: closed.slice(0, TRASH_KEEP), problems }
}

/**
 * Put a closed tab back by taking its archive home: the file that waited is the tab, moved rather
 * than copied, so the trash never grows a duplicate of what is live again. A name that came back
 * while the tab was away is a refusal, not a silent replacement.
 */
export async function restoreClosedView(dir: string, file: string): Promise<ViewFile> {
  if (basename(file) !== file || !file.endsWith(VIEW_SUFFIX) || file.includes('..')) {
    throw new BenchError('invalid', `"${file}" is not a closed tab`)
  }
  const view = await readClosedView(dir, file)
  const { views } = await listViews(dir)
  if (views.some((existing) => existing.name.toLowerCase() === view.name.trim().toLowerCase())) {
    throw new BenchError('invalid', `a tab named "${view.name}" is in the project again`, {
      hint: 'close that one first, or keep the newer tab',
    })
  }
  await mkdir(join(dir, 'views'), { recursive: true })
  await rename(join(trashDir(dir), file), viewPath(dir, view.name))
  return view
}

/**
 * Never overwrite a view in passing: a tab the user built is theirs until they close it or ask to
 * replace it. Replacing one is an explicit act, and the caller says so with `overwrite`.
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

// --- rendering ------------------------------------------------------------------------------

/**
 * Compose a view into one SVG, without Python and without reading the log. Panels keep their own
 * coordinates inside a nested group, so the grid is the only thing this function decides.
 */
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
