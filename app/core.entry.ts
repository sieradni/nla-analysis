/**
 * The core, bundled for the desktop shell's main process.
 *
 * This file is the only thing the shell knows how to reach, and everything it exposes is a call into
 * `src/core` — there is no second implementation of reading a log, appending a point, or drawing a
 * chart. Bundling exists because Electron's Node does not strip TypeScript types; `pnpm app:build`
 * runs esbuild over this entry and writes `app/core.bundle.mjs`, which is generated and ignored.
 *
 * The facade is deliberately small: list projects, open one, list its tabs, open one tab, append a
 * point, undo it, refresh a tab. Anything a window wants that is not here is a core capability that
 * does not exist yet, and it should be added to the core rather than reimplemented in the shell.
 *
 * One `Workspace` is kept per open project. That is what makes the write path a keystroke rather
 * than a log re-read: `recordPoint` folds the new event into memory instead of re-reading the file
 * (ADR 0003). It also means the window sees its own writes immediately and other processes' writes
 * only when a tab is reopened — `openView` pulls before answering, `refreshView` does not, because
 * refresh runs on the hot path right after an append this process made.
 */
import { APP_ROOT, assessRuns } from '../src/core/analysis.ts'
import { incrementalMark, renderChart } from '../src/core/chart.ts'
import type { ChartPoint } from '../src/core/chart.ts'
import type { ShapeField } from '../src/core/events.ts'
import { listProjects, rememberProject } from '../src/core/registry.ts'
import type { KnownProject } from '../src/core/registry.ts'
import { Workspace } from '../src/core/workspace.ts'
import type { PointDraft } from '../src/core/workspace.ts'
import { listViews, loadView, materializePanel, panelStatuses, saveView, selectInput } from '../src/core/views.ts'
import type { PanelStatus, ViewFile, ViewSummary } from '../src/core/views.ts'

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
}

/**
 * Open a project by directory (a subfolder is fine: the core walks up to the root), record a recent,
 * and describe what the window can show. This is the same `Workspace` the CLI uses.
 */
export async function openProject(dir: string): Promise<OpenedProject> {
  session = await Workspace.open(dir)
  const workspace = session
  await rememberProject(workspace.dir, {
    name: workspace.config.name,
    created: workspace.config.created,
  })
  const { views, problems } = await listViews(workspace.dir)
  return {
    dir: workspace.dir,
    name: workspace.config.name,
    views,
    viewProblems: problems,
    datasets: [...workspace.state.datasets.values()].map((dataset) => ({
      id: dataset.id,
      shape: dataset.shape,
      active: workspace.dataset(dataset.id).points.length,
    })),
  }
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
}

/**
 * Which dataset the entry bar writes to: the first panel's. A tab that graphs two datasets needs a
 * choice this slice does not offer, and silently picking `main` would be a different answer.
 */
function entryTarget(workspace: Workspace, view: ViewFile): EntryTarget | null {
  const first = view.panels[0]
  if (!first) return null
  try {
    const dataset = workspace.dataset(first.dataset)
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

async function describe(workspace: Workspace, view: ViewFile): Promise<OpenedView> {
  const statuses = await panelStatuses(workspace, view)
  const freshness = await assessRuns(APP_ROOT, workspace.state)
  return {
    view,
    statuses,
    svgs: view.panels.map((panel) => renderChart(panel.chart)),
    staleRuns: [...freshness.values()].filter((entry) => entry.status !== 'fresh').length,
    entry: entryTarget(workspace, view),
  }
}

export async function openView(dir: string, name: string): Promise<OpenedView> {
  const workspace = await workspaceFor(dir)
  // A tab click is not on the keystroke path, so pay for a fresh read: a CLI append made while the
  // window was idle must not be invisible. `refreshView` deliberately does not do this.
  await workspace.pull()
  sessionView = null
  const view = await openViewFile(workspace.dir, name)
  return describe(workspace, view)
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
}

/**
 * Append one point through `Workspace.recordPoint`, then refresh `STATE.md` so the cold-start brief
 * does not fall behind the log. That brief write is the last thing before returning; the repaint the
 * window does next is on its own clock.
 */
export async function recordPoint(dir: string, draft: PointDraft, viewName?: string): Promise<AppendedPoint> {
  const workspace = await workspaceFor(dir)
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

  // No tab is open, or the point is not a plotted pair: nothing to patch, and nothing to draw either.
  if (viewName === undefined) return { ...base, marks: [], untouched: [], redraw: false }

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

  return { ...base, marks, untouched, redraw }
}

/** Read a coordinate back out of the mark the core just produced, rather than computing it twice. */
function placementOf(markup: string, attribute: 'cx' | 'cy'): number {
  const match = new RegExp(`${attribute}="([-0-9.]+)"`).exec(markup)
  return match ? Number(match[1]) : 0
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
  }
}
