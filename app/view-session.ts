/**
 * The window's view session: one open tab, every rebuilt tab waiting to be saved, and the write path
 * that connects them.
 *
 * This module is the one place that owns a view from construction to save. The pure panel policy —
 * what a request means, how a point projects, which panels can rebuild — lives in
 * `src/core/panels.ts`; the shell's facade in `core.entry.ts` only adapts these calls to IPC.
 *
 * Two pieces of state, for two different lifetimes:
 *
 * - `cachedView` is the tab on screen. It keeps a text append from re-reading the file and its stamp
 *   lets the watcher tell the window's own save from another writer's (ADR 0010).
 * - `stagedViews` holds rebuilt tabs waiting for their post-paint save. A tab can leave the screen
 *   before that save runs, so the save must write the drawing that was painted, not whatever tab is
 *   open now.
 */
import { stat } from 'node:fs/promises'
import { APP_ROOT, assessRuns } from '../src/core/analysis.ts'
import { renderChartLayers } from '../src/core/chart.ts'
import type { ChartEvidence, ChartLayers } from '../src/core/chart.ts'
import { BenchError } from '../src/core/errors.ts'
import type { PointValue, ShapeField } from '../src/core/events.ts'
import { plotHint, type PlotHint } from '../src/core/hints.ts'
import { sameStamp } from '../src/core/log.ts'
import type { LogStamp } from '../src/core/log.ts'
import {
  materializePanel,
  panelStatuses,
  projectPoint,
  rebuildStalePanels,
  selectInput,
} from '../src/core/panels.ts'
import type { IncrementalMark } from '../src/core/panels.ts'
import { RecipeRunner } from '../src/core/runner.ts'
import {
  closeView as closeViewFile,
  duplicateView as duplicateViewFile,
  listClosedViews,
  listViews,
  loadView,
  renameView as renameViewFile,
  requireFreeName,
  restoreClosedView as restoreClosedViewFile,
  saveView,
  viewPath,
} from '../src/core/views.ts'
import type { ClosedView, PanelStatus, ViewFile, ViewSummary } from '../src/core/views.ts'
import type { PointDraft, Workspace } from '../src/core/workspace.ts'
import { workspaceFor } from './workspace-session.ts'

let cachedView: { dir: string; view: ViewFile; stamp: LogStamp | null } | null = null
const stagedViews = new Map<string, ViewFile>()

function viewKey(dir: string, name: string): string {
  return dir + '\u0000' + name
}

function isCachedView(dir: string, name: string): boolean {
  return cachedView !== null && cachedView.dir === dir && cachedView.view.name === name
}

async function stampOf(file: string): Promise<LogStamp | null> {
  try {
    const info = await stat(file)
    return { size: info.size, mtimeMs: info.mtimeMs }
  } catch {
    return null
  }
}

async function cacheView(dir: string, view: ViewFile): Promise<ViewFile> {
  cachedView = { dir, view, stamp: await stampOf(viewPath(dir, view.name)) }
  return view
}

function clearCachedView(): void {
  cachedView = null
}

async function readView(dir: string, name: string): Promise<ViewFile> {
  if (cachedView && cachedView.dir === dir && cachedView.view.name === name) return cachedView.view
  return cacheView(dir, await loadView(dir, name))
}

function stageView(dir: string, view: ViewFile): void {
  stagedViews.set(viewKey(dir, view.name), view)
}

function peekStagedView(dir: string, name: string): ViewFile | null {
  return stagedViews.get(viewKey(dir, name)) ?? null
}

function discardStagedView(dir: string, name: string): void {
  stagedViews.delete(viewKey(dir, name))
}

/** Whether the log or the open tab file has moved past what this session last read. */
async function tabMoved(workspace: Workspace, name: string): Promise<boolean> {
  if (await workspace.isStale()) return true
  if (!cachedView || cachedView.dir !== workspace.dir || cachedView.view.name !== name) return true
  try {
    return !sameStamp(await stampOf(viewPath(workspace.dir, name)), cachedView.stamp)
  } catch {
    // A name that cannot be a file cannot be the tab that was on screen; report it as moved and let
    // the reload say what happened rather than assume nothing did.
    return true
  }
}

export interface ViewDraft {
  name: string
  dataset: string
  /** Named axes for a plain plot. Omitted means the historical x/y pair. */
  xField?: string
  yField?: string
  /** Absent means a plain plot of the dataset; present means a panel built by that recipe. */
  recipe?: string
  /** Replace the file when the name is taken. A tab is never deleted: it is superseded on purpose. */
  replace?: boolean
}

export interface EntryTarget {
  dataset: string
  shape: string
  /** The version a typed point joins: the newest, which is what a repaint should say it reads. */
  version: number
  /** Active points in that dataset, so the stage can state a count instead of summing panels. */
  active: number
  /** The fields the entry bar offers. Empty means the shape definition is missing; do not guess. */
  fields: ShapeField[]
  /**
   * The first tab this shape can build, derived by the core's own hint owner. The window prints it
   * in the no-tabs state instead of hardcoding a recipe or `x`/`y` the shape may not have.
   */
  nextTab: PlotHint
}

export interface OpenedView {
  view: ViewFile
  statuses: PanelStatus[]
  /**
   * One drawing per panel, split around the marks: the core owns the geometry, the window owns the
   * canvas the marks land on. The window transforms these; it never recomputes a scale.
   */
  drawings: ChartLayers[]
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
export function targetForDataset(workspace: Workspace, datasetId: string): EntryTarget | null {
  try {
    const dataset = workspace.dataset(datasetId)
    const definition = dataset.definition
    return {
      dataset: dataset.id,
      shape: dataset.shape,
      version: workspace.currentVersion(datasetId),
      active: dataset.points.length,
      fields: definition?.fields ?? [],
      nextTab: definition ? plotHint(definition, dataset.id) : { problem: 'the shape declaration is missing' },
    }
  } catch {
    return null
  }
}

/**
 * The view as the window needs it: every panel's metadata and chart chrome, but not the materialized
 * points. Those travel in `drawings`, packed; a second copy of ten thousand point objects in the IPC
 * payload cost more than the redraw it was meant to describe. The persisted file keeps the full spec.
 */
function windowView(view: ViewFile): ViewFile {
  return {
    ...view,
    panels: view.panels.map((panel) => {
      const chart = { ...panel.chart }
      // The marks come from the canvas layers, and the artifact's prose line is the CLI's: the
      // window composes its own words from `evidence` and never sees the footer.
      delete chart.points
      delete chart.footer
      return { ...panel, chart }
    }),
  }
}

async function describe(workspace: Workspace, view: ViewFile, reread: boolean): Promise<OpenedView> {
  const statuses = await panelStatuses(workspace, view)
  const freshness = await assessRuns(APP_ROOT, workspace.state)
  return {
    view: windowView(view),
    statuses,
    // The window draws its own subtitle-free chart and renders the evidence line and the empty
    // sentence as DOM, from the renderer's copy owner. Nothing in the SVG needs rewriting after
    // mount, and no dataset or shape name reaches the drawing.
    drawings: view.panels.map((panel) => renderChartLayers(panel.chart, { plain: true })),
    staleRuns: [...freshness.values()].filter((entry) => entry.status !== 'fresh').length,
    entry: entryTarget(workspace, view),
    reread,
  }
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
        ...(draft.xField === undefined ? {} : { xField: draft.xField }),
        ...(draft.yField === undefined ? {} : { yField: draft.yField }),
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
  await cacheView(workspace.dir, view)
  return describe(workspace, view, reread)
}

/**
 * Close a tab: its file leaves the tab list and waits in the project's trash, and the window gets
 * back the archive that holds it, so the same bytes can be moved home later.
 *
 * Nothing about this reaches the log. A view is derived state; the points in it are the log's, and
 * they are not touched. The session forgets the tab too: a rebuilt drawing waiting for its
 * post-paint save must not write the file back after the person closed it.
 */
export async function closeView(dir: string, name: string): Promise<ClosedView> {
  const workspace = await workspaceFor(dir)
  const closed = await closeViewFile(workspace.dir, name)
  // The core read the file before moving it, so the tab's own name is the one to clear: a caller's
  // spelling of it may not be the name the archive holds.
  discardStagedView(workspace.dir, closed.name)
  if (isCachedView(workspace.dir, closed.name)) clearCachedView()
  return closed
}

/** The tabs waiting in the project's trash, newest first: what a fresh window fills its stack from. */
export async function closedViews(dir: string): Promise<{ closed: ClosedView[]; problems: string[] }> {
  const workspace = await workspaceFor(dir)
  return listClosedViews(workspace.dir)
}

/**
 * Put a closed tab back by moving its archive home, so the tab that comes back is the file that
 * left. It is described like any opened tab, so the window draws it by the same path and no second
 * renderer exists for "the tab that came back".
 */
export async function restoreClosedView(dir: string, file: string): Promise<OpenedView> {
  const workspace = await workspaceFor(dir)
  const reread = await workspace.freshen()
  const view = await restoreClosedViewFile(workspace.dir, file)
  await cacheView(workspace.dir, view)
  return describe(workspace, view, reread)
}

/**
 * Rename a tab: the same drawing under another name.
 *
 * The file is the tab, so the session forgets the old name on the way back — a cached copy keyed by
 * it would otherwise answer a later `openView` for a tab that no longer exists.
 */
export async function renameView(dir: string, from: string, to: string): Promise<OpenedView> {
  const workspace = await workspaceFor(dir)
  const view = await renameViewFile(workspace.dir, from, to)
  discardStagedView(workspace.dir, from)
  if (isCachedView(workspace.dir, from)) clearCachedView()
  await cacheView(workspace.dir, view)
  return describe(workspace, view, false)
}

/**
 * Copy a tab under another name. The panels are the tab, so the copy is described by the same path
 * any tab is, and it is the copy the window holds afterwards.
 */
export async function duplicateView(dir: string, from: string, to: string): Promise<OpenedView> {
  const workspace = await workspaceFor(dir)
  const view = await duplicateViewFile(workspace.dir, from, to)
  await cacheView(workspace.dir, view)
  return describe(workspace, view, false)
}

export async function openView(dir: string, name: string): Promise<OpenedView> {
  const workspace = await workspaceFor(dir)
  // A tab click is not on the keystroke path, so it pays for a fresh read when one is needed: an
  // append made by the CLI while the window was idle must not be invisible. `freshen` decides, and
  // costs one `stat` when nothing has changed.
  const reread = await workspace.freshen()
  // A rebuilt view for this tab may still be waiting for its post-paint save. If the log has not
  // moved since it was built, reopening the tab shows that drawing rather than the older file; a
  // save in flight must not lose the frame the user is looking at. If the log moved, the staged
  // fingerprint is no longer a description of the project, so it is dropped.
  const staged = peekStagedView(workspace.dir, name)
  if (!reread && staged) {
    clearCachedView()
    await cacheView(workspace.dir, staged)
    return describe(workspace, staged, false)
  }
  discardStagedView(workspace.dir, name)
  clearCachedView()
  const view = await readView(workspace.dir, name)
  return describe(workspace, view, reread)
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
export async function recordPoint(
  dir: string,
  draft: PointDraft,
  viewName?: string,
): Promise<AppendedPoint> {
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

  const view = await readView(workspace.dir, viewName)
  const projection = projectPoint(workspace, view, recorded.event.id, draft.values)
  return { ...base, ...projection, reread }
}

export interface PointDetail {
  id: string
  /** The fields to offer in the correction strip: the shape's, not the point's own keys. */
  fields: ShapeField[]
  values: Record<string, string | number | boolean | null>
  tObserved: string
  /**
   * The field the observation time came from, when the declaration designates one. A copied detail
   * line says the time once, as "observed", rather than repeating it as a value.
   */
  timeField?: string
  /** The time came from the file's row order, not from an observation. Said wherever it is shown. */
  timeEstimated?: true
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
  const view = await readView(workspace.dir, viewName)
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
    ...(found.point.tEstimated === true ? { timeEstimated: true as const } : {}),
    ...(shape.time_field === undefined ? {} : { timeField: shape.time_field }),
    corrections: found.point.corrections.length,
    recipePanels,
  }
}

export interface CorrectedPoint {
  id: string
  dataset: string
  /** The point as the log now describes it, which is not always what was typed. */
  values: Record<string, string | number | boolean | null>
  /** The instant the row now carries, when this correction moved it. */
  tObserved: string
  /** The log describes it as an observation rather than an estimate. */
  estimated: boolean
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
  /** A measured instant replacing an estimate, for a shape that designates no time field. */
  tObserved?: string,
): Promise<CorrectedPoint> {
  const workspace = await workspaceFor(dir)
  const corrected = await workspace.correctPoint(
    id,
    values,
    'corrected in the window',
    tObserved === undefined ? {} : { tObserved },
  )
  await workspace.writeStateBrief()
  const point = workspace.findPoint(id)?.point
  return {
    id,
    dataset: corrected.dataset,
    values: corrected.now,
    tObserved: point?.tObserved ?? corrected.tObserved ?? '',
    estimated: point?.tEstimated === true,
    active: workspace.dataset(corrected.dataset).points.length,
    view: await refreshView(dir, viewName, { draw: true }),
  }
}

export interface RestoredVersion {
  dataset: string
  /** The new version the restore wrote, and the one it replaced. */
  version: number
  parent: number
  /** The older version whose rows came back; null means the empty dataset before version 1. */
  restoredFrom: number | null
  rows: number
  diff: { added: number; removed: number; changed: number }
  active: number
  /** The tab, rebuilt and redrawn; null when the window had no tab to rebuild. */
  view: RefreshedView | null
}

/**
 * Make an older version current again, through the same core call the CLI uses. The tab is rebuilt
 * rather than patched: rows came back, left, or changed, so every panel's input fingerprint moved.
 */
export async function restoreVersion(
  dir: string,
  dataset: string,
  version: number | null,
  viewName?: string,
): Promise<RestoredVersion> {
  const workspace = await workspaceFor(dir)
  const restored = await workspace.restoreVersion(dataset, version)
  await workspace.writeStateBrief()
  return {
    dataset: restored.dataset,
    version: restored.version,
    parent: restored.parent,
    restoredFrom: restored.restoredFrom,
    rows: restored.rows,
    diff: restored.diff,
    active: restored.active,
    view: viewName === undefined ? null : await refreshView(dir, viewName, { draw: true }),
  }
}

export interface RefreshedView {
  view: ViewFile
  statuses: PanelStatus[]
  /** One drawing per panel, or null when the caller asked for the update without a redraw. */
  drawings: ChartLayers[] | null
  staleRuns: number
  entry: EntryTarget | null
  /** Panels whose stored spec was rebuilt from the current data. */
  refreshed: number[]
  /** Panels that could not be rebuilt here, with the reason. Never silently left looking current. */
  kept: { index: number; reason: string }[]
  /** Active points per panel after the rebuild, for a strip that must not keep saying the old n. */
  counts: number[]
  /** Each panel's evidence after the rebuild, for a drawing that was patched rather than redrawn. */
  evidence: (ChartEvidence | null)[]
  /** True when the log had changed on disk and was reread before this rebuild. */
  reread: boolean
}

export interface RefreshOptions {
  /**
   * `false` rebuilds and saves the tab without producing drawings. The window uses it to catch the
   * saved file up *after* it has already painted, so the file it writes is never the thing a
   * keystroke waits on.
   */
  draw?: boolean
  /**
   * `false` leaves the rebuilt view in the session cache and writes nothing, so a redraw is not
   * charged for the tab file. The window calls `persistView` after the paint; that call owns the
   * write and the re-read check, exactly as the incremental path's catch-up already does.
   */
  persist?: boolean
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
  const persist = options.persist !== false
  const workspace = await workspaceFor(dir)
  // This saves the tab, so it is a persist path like STATE.md: it must not fingerprint a bind the
  // file has moved past. After a write this process made, the stat matches and nothing is reread.
  const reread = await workspace.freshen()
  const view = await readView(workspace.dir, name)
  const { statuses, refreshed, kept } = await rebuildStalePanels(workspace, view)

  // Only a successful save supersedes a staged view. If this refresh had nothing to rebuild, the
  // view may still be a deferred one waiting for its own save; dropping it here would silently lose
  // the tab file's catch-up.
  if (refreshed.length > 0 && persist) {
    await saveView(workspace.dir, view)
    discardStagedView(workspace.dir, view.name)
  }
  // Remember the file the window is holding: a watcher event only has to compare stamps to know
  // whether there is anything to redraw (ADR 0010). With `persist: false` this is the only copy of
  // the rebuilt view, and `persistView` writes it after the paint.
  await cacheView(workspace.dir, view)
  if (!persist) stageView(workspace.dir, view)
  const freshness = draw ? await assessRuns(APP_ROOT, workspace.state) : null
  return {
    view: windowView(view),
    statuses,
    drawings: draw
      ? view.panels.map((panel) => renderChartLayers(panel.chart, { plain: true }))
      : null,
    staleRuns: freshness === null ? 0 : [...freshness.values()].filter((entry) => entry.status !== 'fresh').length,
    entry: entryTarget(workspace, view),
    refreshed,
    kept,
    counts: view.panels.map((panel) => (typeof panel.n === 'number' ? panel.n : 0)),
    evidence: view.panels.map((panel) => panel.chart.evidence ?? null),
    reread,
  }
}

export interface PersistedView {
  /** True when the log moved past the drawing before this save; the caller must redraw, not save. */
  reread: boolean
  /** False when no rebuilt view was waiting for this tab; nothing was written. */
  saved: boolean
}

/**
 * Write the tab a redraw just produced, after the paint.
 *
 * `refreshView({ persist: false })` leaves the rebuilt view in the session cache; this is the other
 * half of that bargain, and the same bargain the incremental path already strikes (ADR 0006): the
 * log is written before the point appears, and the view file — derived state — catches up once the
 * person has seen the frame. The staleness check happens here rather than being assumed, so a writer
 * that moved the log in between cannot have its state saved under the old drawing's fingerprint.
 */
export async function persistView(dir: string, name: string): Promise<PersistedView> {
  const workspace = await workspaceFor(dir)
  const reread = await workspace.freshen()
  if (reread) {
    discardStagedView(workspace.dir, name)
    return { reread: true, saved: false }
  }
  // Save the exact rebuilt view, not a fresh read of the file by name: another tab may have been
  // opened between the paint and this call, and reloading by name would write that stale file back.
  const view = peekStagedView(workspace.dir, name)
  if (!view) return { reread: false, saved: false }
  // A point can be painted incrementally after the redraw that staged this view but before the save:
  // the staged panel would then carry the old count. Rebuild only what moved, so the file catches up
  // to the frame on screen instead of erasing the newer point from it.
  await rebuildStalePanels(workspace, view)
  await saveView(workspace.dir, view)
  discardStagedView(workspace.dir, name)
  // Only the tab on screen owns the active cache; saving a background tab must not replace it.
  if (isCachedView(workspace.dir, name)) await cacheView(workspace.dir, view)
  return { reread: false, saved: true }
}

/** What a watched change means for the tab the window is drawing. */
export type TabReload =
  | { state: 'same' }
  | { state: 'redrawn'; views: ViewSummary[]; view: RefreshedView }
  | { state: 'gone'; views: ViewSummary[]; entry: EntryTarget | null; name: string }

/**
 * Answer a watcher event: did the files this tab was drawn from move, and if so what does the tab
 * look like now?
 *
 * This is a reload, not a patch (ADR 0007): data that changed is re-materialized and the whole tab
 * is drawn again. Asking first is what keeps the window's own saves from starting a read-and-render
 * loop — after a write, the log and tab stamps are exactly the ones this session recorded (ADR 0010).
 */
export async function reloadTab(dir: string, name: string): Promise<TabReload> {
  const workspace = await workspaceFor(dir)
  if (!(await tabMoved(workspace, name))) return { state: 'same' }

  const { views } = await listViews(workspace.dir)
  if (!views.some((summary) => summary.name === name)) {
    // The tab is gone but the project is not: the bar falls back to the first dataset, as it does
    // for a project with no tabs at all.
    const first = [...workspace.state.datasets.values()][0]
    return {
      state: 'gone',
      views,
      entry: first === undefined ? null : targetForDataset(workspace, first.id),
      name,
    }
  }

  // Another writer may have replaced the file, and the cached copy would hide that.
  clearCachedView()
  return {
    state: 'redrawn',
    views,
    view: await refreshView(workspace.dir, name, { draw: true }),
  }
}
