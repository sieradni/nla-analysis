/**
 * The core, bundled for the desktop shell's main process.
 *
 * This file is the only thing the shell knows how to reach, and everything it exposes is a call into
 * `src/core` — there is no second implementation of reading a log, appending a point, or drawing a
 * chart. Bundling exists because Electron's Node does not strip TypeScript types; `pnpm app:build`
 * runs esbuild over this entry and writes `app/core.bundle.mjs`, which is generated and ignored.
 *
 * The facade is deliberately small: read what the window shows, and six writes — create a project,
 * write a tab, append a point, correct one, retract one, rebuild a tab (ADR 0008). Anything a window
 * wants that is not here is a core capability that does not exist yet, and it belongs in the core
 * rather than reimplemented in the shell.
 *
 * One `Workspace` is kept per open project. That is what makes the write path a keystroke rather
 * than a log re-read: `recordPoint` folds the new event into memory instead of re-reading the file
 * (ADR 0003). Another process's writes are picked up by the `stat` check `Workspace` runs before
 * every mutation and before every persist (ADR 0007), so a long-lived window cannot report a count
 * that contradicts the log. The facade only reports when a repair happened; it never makes one
 * itself, because then there would be two places that decide what "current" means.
 */
import { APP_ROOT, assessRuns } from '../src/core/analysis.ts'
import { incrementalMark, renderChart } from '../src/core/chart.ts'
import type { ChartPoint } from '../src/core/chart.ts'
import type { PointValue, ShapeField } from '../src/core/events.ts'
import { stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { DEFAULT_SHAPE, initProject } from '../src/core/project.ts'
import { SHAPE_FIELD_TYPES } from '../src/core/shapes.ts'
import { listProjects, rememberProject } from '../src/core/registry.ts'
import type { KnownProject } from '../src/core/registry.ts'
import { RecipeRunner } from '../src/core/runner.ts'
import { BenchError, Workspace } from '../src/core/workspace.ts'
import type { PointDraft } from '../src/core/workspace.ts'
import {
  listViews,
  loadView,
  materializePanel,
  panelStatuses,
  requireFreeName,
  saveView,
  selectInput,
} from '../src/core/views.ts'
import type { PanelStatus, ViewFile, ViewSummary } from '../src/core/views.ts'

export interface RecipeChoice {
  name: string
  summary: string
  params: { name: string; type: string; default?: unknown; values?: string[] }[]
}

export interface RecipeCatalog {
  recipes: RecipeChoice[]
  /** Set when the analysis runtime is missing or refusing: the tab dialog still offers a plot. */
  problem?: string
}

/**
 * What the tab dialog can build a panel from: the same catalog `bench recipes` prints, read through
 * the same runner. Starting the interpreter is why this is a separate call rather than something
 * the window does on boot — a window that could not start Python would still have to open.
 */
export async function recipes(): Promise<RecipeCatalog> {
  const runner = new RecipeRunner(APP_ROOT)
  try {
    await runner.start()
    const catalog = await runner.catalog()
    return {
      recipes: catalog.map((recipe) => ({
        name: recipe.name,
        summary: recipe.summary,
        params: recipe.params.map((param) => ({
          name: param.name,
          type: param.type,
          ...(param.default === undefined ? {} : { default: param.default }),
          ...(param.values === undefined ? {} : { values: param.values }),
        })),
      })),
    }
  } catch (error) {
    return { recipes: [], problem: error instanceof Error ? error.message : String(error) }
  } finally {
    await runner.dispose()
  }
}

export interface ViewDraft {
  name: string
  dataset: string
  /** Absent means a plain plot of the dataset; present means a panel built by that recipe. */
  recipe?: string
  /** Replace the file when the name is taken. A tab is never deleted: it is superseded on purpose. */
  replace?: boolean
}

/**
 * Create a tab, or replace one when the caller says so with `replace`.
 *
 * This is a tab-shaped write, not an analysis request: the panel is materialized exactly as
 * `bench view new` materializes it, no `analysis_run` event is recorded, and a recipe panel still
 * carries the recipe's verdict so the drawing states its own evidence (ADR 0008).
 */
export async function writeView(dir: string, draft: ViewDraft): Promise<OpenedView> {
  const name = draft.name.trim()
  if (name === '') {
    throw new BenchError('invalid', 'a tab needs a name', { hint: 'name the question this tab answers' })
  }
  const workspace = await workspaceFor(dir)
  const reread = await workspace.freshen()
  // Never delete a tab: replacing one is an explicit act, and the refusal says how to do it.
  await requireFreeName(workspace.dir, name, draft.replace === true)

  // A tab from the window holds one panel, so one column. Multi-panel tabs are still `bench view add`.
  const view: ViewFile = { v: 1, name, layout: { columns: 1 }, panels: [] }

  let runner: RecipeRunner | undefined
  try {
    if (draft.recipe !== undefined) {
      runner = new RecipeRunner(APP_ROOT)
      await runner.start()
    }
    const materialized = await materializePanel(
      workspace,
      {
        dataset: draft.dataset,
        ...(draft.recipe === undefined ? {} : { recipe: draft.recipe }),
        title: name,
      },
      runner,
    )
    view.panels.push(materialized.panel)
  } catch (error) {
    if (error instanceof BenchError) throw error
    const message = error instanceof Error ? error.message : String(error)
    // Nothing has been saved at this point, and the runner cannot write to the log, so say both.
    throw new BenchError('invariant', `${message} — the tab was not saved`, {
      hint: 'a plain plot needs no analysis runtime; a recipe panel does',
    })
  } finally {
    if (runner) await runner.dispose()
  }

  await saveView(workspace.dir, view)
  sessionView = { dir: workspace.dir, view }
  return describe(workspace, view, reread)
}

export interface ProjectList {
  projects: KnownProject[]
  /** Set when the registry file exists but could not be read. Shown, never swallowed. */
  problem?: string
}

export async function projects(): Promise<ProjectList> {
  return listProjects()
}

/** The open project, shared by the read and write calls below. */
let session: Workspace | null = null

/**
 * The open tab, kept here for the same reason the workspace is: appending a point must not re-read
 * and re-parse a view file, and the file the window repaints from is the file it saves afterwards.
 */
let sessionView: { dir: string; view: ViewFile } | null = null

function cacheView(dir: string, view: ViewFile): ViewFile {
  sessionView = { dir, view }
  return view
}

async function openViewFile(dir: string, name: string): Promise<ViewFile> {
  if (sessionView && sessionView.dir === dir && sessionView.view.name === name) return sessionView.view
  return cacheView(dir, await loadView(dir, name))
}

/**
 * The session's workspace for `dir`, opening it if this is the first call or a different project.
 * A subdirectory is fine: `Workspace.open` walks up to the project root, and the comparison is
 * against the root it found.
 */
async function workspaceFor(dir: string): Promise<Workspace> {
  if (session && session.dir === dir) return session
  session = await Workspace.open(dir)
  return session
}

export interface EntryTarget {
  dataset: string
  shape: string
  /** Active points in that dataset, so the stage can state a count instead of summing panels. */
  active: number
  /** The fields the entry bar offers. Empty means the shape definition is missing; do not guess. */
  fields: ShapeField[]
}

export interface OpenedProject {
  dir: string
  name: string
  views: ViewSummary[]
  viewProblems: string[]
  datasets: { id: string; shape: string; active: number }[]
  /**
   * Where a typed point would land before any tab exists. A project with no tabs still has a dataset
   * and a shape, and the entry bar is the door a new project needs most — without this, creating a
   * project would end in a window that cannot be given a single point.
   */
  entry: EntryTarget | null
}

/**
 * Open a project by directory (a subfolder is fine: the core walks up to the root), record a recent,
 * and describe what the window can show. This is the same `Workspace` the CLI uses.
 */
async function describeProject(workspace: Workspace): Promise<OpenedProject> {
  await rememberProject(workspace.dir, {
    name: workspace.config.name,
    created: workspace.config.created,
  })
  const { views, problems } = await listViews(workspace.dir)
  const datasets = [...workspace.state.datasets.values()].map((dataset) => ({
    id: dataset.id,
    shape: dataset.shape,
    active: workspace.dataset(dataset.id).points.length,
  }))
  return {
    dir: workspace.dir,
    name: workspace.config.name,
    views,
    viewProblems: problems,
    datasets,
    entry: datasets[0] ? targetForDataset(workspace, datasets[0].id) : null,
  }
}

export async function openProject(dir: string): Promise<OpenedProject> {
  session = await Workspace.open(dir)
  return describeProject(session)
}

/**
 * What the create dialog offers: the default shape, and the field types a custom one may use. The
 * window does not keep its own copy of the type list — a second one would drift from the binder's.
 */
export function shapeChoice(): { id: string; fields: ShapeField[]; types: string[] } {
  return { id: DEFAULT_SHAPE.id, fields: DEFAULT_SHAPE.fields, types: [...SHAPE_FIELD_TYPES] }
}

/**
 * Create a project, with its shape chosen now or never.
 *
 * A shape is declared by a `shape_defined` event at init and every later point inherits it, so this
 * is the one moment a person can pick the fields. The dialog's custom fields arrive here as data and
 * are validated by the core before anything is written; the folder is derived from the name so two
 * clicks of the same name cannot silently pick a different folder.
 */
export async function createProject(parentDir: string, name: string, shape?: unknown): Promise<OpenedProject> {
  const clean = name.trim()
  if (clean === '') {
    throw new BenchError('invalid', 'a project needs a name', { hint: 'name it after the data, e.g. load cells' })
  }
  const parent = resolve(parentDir)
  let info
  try {
    info = await stat(parent)
  } catch {
    throw new BenchError('missing', `no folder at ${parent}`, {
      hint: 'choose the folder the project should live in',
    })
  }
  if (!info.isDirectory()) {
    throw new BenchError('invalid', `${parent} is not a folder`, { hint: 'choose a folder, not a file' })
  }

  const folder = clean.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project'
  const target = join(parent, folder)
  try {
    await initProject(target, clean, undefined, shape)
  } catch (error) {
    if (error instanceof BenchError) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new BenchError('invalid', message, { hint: 'choose another name, or another folder' })
  }

  session = await Workspace.open(target)
  return describeProject(session)
}

export interface OpenedView {
  view: ViewFile
  statuses: PanelStatus[]
  /** One SVG per panel, drawn by the core renderer. The window transforms these; it does not redraw. */
  svgs: string[]
  /** Freshness of the project's recorded runs, so a tab can say whether its analysis still holds. */
  staleRuns: number
  /** Where a typed point would land, and which fields to ask for. */
  entry: EntryTarget | null
  /**
   * True when the log had changed on disk and was reread before this answer was built. The window
   * says so when it happens: a reader is entitled to know the ground moved underneath a tab.
   */
  reread: boolean
}

/**
 * Which dataset the entry bar writes to: the first panel's. A tab that graphs two datasets needs a
 * choice this slice does not offer, and silently picking `main` would be a different answer.
 */
function entryTarget(workspace: Workspace, view: ViewFile): EntryTarget | null {
  const first = view.panels[0]
  if (!first) return null
  return targetForDataset(workspace, first.dataset)
}

/** The same answer for a tab's panel and for a project with no tabs: one rule, one place. */
function targetForDataset(workspace: Workspace, datasetId: string): EntryTarget | null {
  try {
    const dataset = workspace.dataset(datasetId)
    return {
      dataset: dataset.id,
      shape: dataset.shape,
      active: dataset.points.length,
      fields: dataset.definition?.fields ?? [],
    }
  } catch {
    return null
  }
}

async function describe(workspace: Workspace, view: ViewFile, reread: boolean): Promise<OpenedView> {
  const statuses = await panelStatuses(workspace, view)
  const freshness = await assessRuns(APP_ROOT, workspace.state)
  return {
    view,
    statuses,
    svgs: view.panels.map((panel) => renderChart(panel.chart)),
    staleRuns: [...freshness.values()].filter((entry) => entry.status !== 'fresh').length,
    entry: entryTarget(workspace, view),
    reread,
  }
}

export async function openView(dir: string, name: string): Promise<OpenedView> {
  const workspace = await workspaceFor(dir)
  // A tab click is not on the keystroke path, so it pays for a fresh read when one is needed: an
  // append made by the CLI while the window was idle must not be invisible. `freshen` decides, and
  // costs one `stat` when nothing has changed.
  const reread = await workspace.freshen()
  sessionView = null
  const view = await openViewFile(workspace.dir, name)
  return describe(workspace, view, reread)
}

export interface IncrementalMark {
  index: number
  /** The record this mark stands for, so hover can name it without re-parsing the drawing. */
  id: string
  /** The core's own markup for one more mark, drawn against the scales the panel already has. */
  markup: string
  /** Where it landed, so the window can add it to hit-testing without re-parsing the drawing. */
  cx: number
  cy: number
}

export interface AppendedPoint {
  id: string
  dataset: string
  values: Record<string, string | number | boolean | null>
  tObserved: string
  /** Shape warnings, e.g. an unknown field. Recorded all the same, and shown, never swallowed. */
  warnings: string[]
  active: number
  /** Panels that can show the point as one extra mark, without redrawing ten thousand of them. */
  marks: IncrementalMark[]
  /** Panels the point does not belong to, because their query excludes it. Nothing changed there. */
  untouched: number[]
  /** True when the window has to repaint the whole tab instead of patching it. */
  redraw: boolean
  /** True when the log had been changed by another writer and was reread before this append. */
  reread: boolean
}

/**
 * Append one point through `Workspace.recordPoint`, then refresh `STATE.md` so the cold-start brief
 * does not fall behind the log. That brief write is the last thing before returning; the repaint the
 * window does next is on its own clock.
 */
export async function recordPoint(dir: string, draft: PointDraft, viewName?: string): Promise<AppendedPoint> {
  const workspace = await workspaceFor(dir)
  // Counted around the whole call: `Workspace` repairs itself before it reads anything it will
  // validate against, and this is how the window learns that a repair happened.
  const readsBefore = workspace.logReads
  const recorded = await workspace.recordPoint(draft)
  await workspace.writeStateBrief()
  const base = {
    id: recorded.event.id,
    dataset: recorded.dataset,
    values: draft.values,
    tObserved: recorded.tObserved,
    warnings: recorded.warnings,
    active: workspace.dataset(recorded.dataset).points.length,
  }

  const reread = workspace.logReads > readsBefore

  // No tab is open, or the point is not a plotted pair: nothing to patch, and nothing to draw either.
  if (viewName === undefined) return { ...base, marks: [], untouched: [], redraw: false, reread }

  const view = await openViewFile(workspace.dir, viewName)
  const point: ChartPoint = {
    id: recorded.event.id,
    x: typeof draft.values.x === 'number' ? draft.values.x : 0,
    y: typeof draft.values.y === 'number' ? draft.values.y : 0,
  }
  const marks: IncrementalMark[] = []
  const untouched: number[] = []
  let redraw = false

  for (const [index, panel] of view.panels.entries()) {
    // A fitted panel is not patched: its curve and interval would have to move with the point, and
    // that means running the recipe. It stays as it is and goes stale, which the badge says.
    if (panel.recipe !== undefined) continue
    let input
    try {
      input = selectInput(workspace.state, panel.dataset, panel.query)
    } catch {
      redraw = true
      continue
    }
    if (!input) {
      redraw = true
      continue
    }
    if (!input.points.some((candidate) => candidate.id === recorded.event.id)) {
      untouched.push(index)
      continue
    }
    if (typeof draft.values.x !== 'number' || typeof draft.values.y !== 'number') {
      // A pair without numbers is not plotted by `plotDataset` either, so the panel did not change.
      untouched.push(index)
      continue
    }
    const markup = incrementalMark(panel.chart, point)
    if (markup === null) {
      // The point would move the axes: that is a different picture, not an extra mark.
      redraw = true
      continue
    }
    marks.push({
      index,
      id: recorded.event.id,
      markup,
      cx: placementOf(markup, 'cx'),
      cy: placementOf(markup, 'cy'),
    })
  }

  return { ...base, marks, untouched, redraw, reread }
}

/** Read a coordinate back out of the mark the core just produced, rather than computing it twice. */
function placementOf(markup: string, attribute: 'cx' | 'cy'): number {
  const match = new RegExp(`${attribute}="([-0-9.]+)"`).exec(markup)
  return match ? Number(match[1]) : 0
}

export interface PointDetail {
  id: string
  /** The fields to offer in the correction strip: the shape's, not the point's own keys. */
  fields: ShapeField[]
  values: Record<string, string | number | boolean | null>
  tObserved: string
  /** Corrections already recorded against it, so a strip can say this is the third one. */
  corrections: number
  /** Panels of the open tab drawn by a recipe that include this point: a change makes them stale. */
  recipePanels: number[]
}

/**
 * What the strip needs to edit one existing record: its values, the fields its shape demands, and
 * what a change would invalidate. Read-only, and it freshens first — a strip prefilled from a bind
 * the log has moved past would offer numbers that are no longer the point's.
 */
export async function point(dir: string, id: string, viewName: string): Promise<PointDetail> {
  const workspace = await workspaceFor(dir)
  await workspace.freshen()
  const found = workspace.findPoint(id)
  if (!found) {
    throw new BenchError('missing', `no point with id "${id}"`, { hint: 'the log may have been rewritten' })
  }
  const shape = workspace.shapeOf(found.dataset)
  const recipePanels: number[] = []
  const view = await openViewFile(workspace.dir, viewName)
  view.panels.forEach((panel, index) => {
    if (panel.recipe === undefined) return
    try {
      const input = selectInput(workspace.state, panel.dataset, panel.query)
      if (input && input.points.some((candidate) => candidate.id === id)) recipePanels.push(index)
    } catch {
      /* a panel that cannot be selected has nothing to say about this point */
    }
  })
  return {
    id,
    fields: shape.fields,
    values: { ...found.point.values },
    tObserved: found.point.tObserved,
    corrections: found.point.corrections.length,
    recipePanels,
  }
}

export interface CorrectedPoint {
  id: string
  dataset: string
  /** The point as the log now describes it, which is not always what was typed. */
  values: Record<string, string | number | boolean | null>
  active: number
  /** The tab, rebuilt and redrawn. A recipe panel is kept and reported stale, never silently reused. */
  view: RefreshedView
}

/**
 * Correct one existing point, as an event that supersedes it — never an edit of the original record.
 *
 * The rebuild is not optional here. A correction changes a value, which changes every panel's input
 * fingerprint; returning without refreshing would leave the screen claiming an analysis still holds
 * on numbers it was not drawn from. Plot panels are rebuilt from the new state and a recipe panel is
 * kept with its `stale` badge, because running it would be an analysis request (ADR 0002).
 */
export async function correctPoint(
  dir: string,
  id: string,
  values: Record<string, PointValue>,
  viewName: string,
): Promise<CorrectedPoint> {
  const workspace = await workspaceFor(dir)
  const corrected = await workspace.correctPoint(id, values, 'corrected in the window')
  await workspace.writeStateBrief()
  return {
    id,
    dataset: corrected.dataset,
    values: corrected.now,
    active: workspace.dataset(corrected.dataset).points.length,
    view: await refreshView(dir, viewName, { draw: true }),
  }
}

export interface RetractedPoint {
  id: string
  dataset: string
  active: number
}

/** Undo. A retraction event in the log, not a deletion: the point and its retraction both remain. */
export async function retractPoint(dir: string, id: string, reason?: string): Promise<RetractedPoint> {
  const workspace = await workspaceFor(dir)
  const retracted = await workspace.retractPoint(id, reason)
  await workspace.writeStateBrief()
  return { id, dataset: retracted.dataset, active: retracted.active }
}

export interface RefreshedView {
  view: ViewFile
  statuses: PanelStatus[]
  /** One SVG per panel, or null when the caller asked for the update without a redraw. */
  svgs: string[] | null
  staleRuns: number
  entry: EntryTarget | null
  /** Panels whose stored spec was rebuilt from the current data. */
  refreshed: number[]
  /** Panels that could not be rebuilt here, with the reason. Never silently left looking current. */
  kept: { index: number; reason: string }[]
  /** Active points per panel after the rebuild, for a strip that must not keep saying the old n. */
  counts: number[]
  /** Each panel's evidence line after the rebuild, for a drawing that was patched rather than redrawn. */
  footers: (string | null)[]
  /** True when the log had changed on disk and was reread before this rebuild. */
  reread: boolean
}

export interface RefreshOptions {
  /**
   * `false` rebuilds and saves the tab without rendering SVGs. The window uses it to catch the
   * saved file up *after* it has already painted, so the file it writes is never the thing a
   * keystroke waits on.
   */
  draw?: boolean
}

/**
 * Rebuild the panels a write has invalidated, without Python and without re-reading the log.
 *
 * A plot panel is materialized from the current in-memory state — cheap, and the same function the
 * CLI uses. A recipe panel would need the analysis runtime, which is deliberately not in the entry
 * path: it stays as it was, keeps its `stale` badge, and `kept` says why. The window says so rather
 * than drawing an old fit as if it still described the new data.
 */
export async function refreshView(
  dir: string,
  name: string,
  options: RefreshOptions = {},
): Promise<RefreshedView> {
  const draw = options.draw !== false
  const workspace = await workspaceFor(dir)
  // This saves the tab, so it is a persist path like STATE.md: it must not fingerprint a bind the
  // file has moved past. After a write this process made, the stat matches and nothing is reread.
  const reread = await workspace.freshen()
  const view = await openViewFile(workspace.dir, name)
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
      const request = {
        dataset: panel.dataset,
        ...(panel.query === undefined ? {} : { query: panel.query }),
        ...(panel.title === undefined ? {} : { title: panel.title }),
      }
      view.panels[status.index] = (await materializePanel(workspace, request)).panel
      refreshed.push(status.index)
    } catch (error) {
      kept.push({
        index: status.index,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (refreshed.length > 0) await saveView(workspace.dir, view)
  statuses = await panelStatuses(workspace, view)
  const freshness = draw ? await assessRuns(APP_ROOT, workspace.state) : null
  return {
    view,
    statuses,
    svgs: draw ? view.panels.map((panel) => renderChart(panel.chart)) : null,
    staleRuns: freshness === null ? 0 : [...freshness.values()].filter((entry) => entry.status !== 'fresh').length,
    entry: entryTarget(workspace, view),
    refreshed,
    kept,
    counts: view.panels.map((panel) => (typeof panel.n === 'number' ? panel.n : 0)),
    footers: view.panels.map((panel) => panel.chart.footer ?? null),
    reread,
  }
}
