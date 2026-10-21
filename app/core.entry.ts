/**
 * The core, bundled for the desktop shell's main process.
 *
 * This file is the only thing the shell knows how to reach, and everything it exposes is a call into
 * `src/core` — there is no second implementation of reading a log, appending a point, or drawing a
 * chart. Bundling exists because Electron's Node does not strip TypeScript types; `pnpm app:build`
 * runs esbuild over this entry and writes `app/core.bundle.mjs`, which is generated and ignored.
 *
 * The facade is deliberately small: read what the window shows, and the writes it can make — create
 * a project, write a tab, append a point, correct one, remove one, bring a removed one back, restore
 * a version, rebuild a tab (ADR 0008, ADR 0016). Anything a window
 * wants that is not here is a core capability that does not exist yet, and it belongs in the core
 * rather than reimplemented in the shell.
 *
 * One `Workspace` is kept per open project. That is what makes the write path a keystroke rather
 * than a log re-read: `recordPoint` folds the new event into memory instead of re-reading the file
 * (ADR 0003). Another process's writes are picked up by the `stat` check `Workspace` runs before
 * every mutation and before every persist (ADR 0007), so a long-lived window cannot report a count
 * that contradicts the log. The facade only reports when a repair happened; it never makes one
 * itself, because then there would be two places that decide what "current" means.
 *
 * `workspace-session.ts` owns the open project; `view-session.ts` owns a view from construction to
 * saved state, including the cache and the deferred save. This file adapts those calls to IPC and
 * owns the project/import surfaces that are not view lifecycle.
 */
import { APP_ROOT } from '../src/core/analysis.ts'
import { plottableFields } from '../src/core/axes.ts'
import type { PointValue, ShapeField } from '../src/core/events.ts'
import { stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { DEFAULT_SHAPE, initProject } from '../src/core/project.ts'
import { SHAPE_FIELD_TYPES } from '../src/core/shapes.ts'
import { listProjects, rememberProject } from '../src/core/registry.ts'
import type { KnownProject } from '../src/core/registry.ts'
import { RecipeRunner } from '../src/core/runner.ts'
import { commitImport, planImport, previewImport as planPreview } from '../src/core/import.ts'
import type { ImportPreview } from '../src/core/import.ts'
import { ERROR_KINDS, type ErrorKind } from '../src/core/errors.ts'
import { BenchError, Workspace } from '../src/core/workspace.ts'
import { listViews } from '../src/core/views.ts'
import type { ViewSummary } from '../src/core/views.ts'
import {
  refreshView,
  targetForDataset,
  type EntryTarget,
  type RefreshedView,
} from './view-session.ts'
import { useWorkspace, workspaceFor } from './workspace-session.ts'

/**
 * The shape a refusal takes on its way to the window.
 *
 * Electron's structured clone keeps an `Error`'s message and drops the rest, so a refusal crosses as
 * data: the words to show, the hint and problems to show under them, and the `kind` — the only field
 * that says whether an act can still be taken. It is built here, in the bundle, rather than in the
 * shell's IPC handler: a handler that lists the fields by hand loses any field added later without
 * failing, and a window then treats a refusal that can never succeed as one worth retrying forever.
 */
export interface Refusal {
  ok: false
  error: {
    kind: ErrorKind | null
    message: string
    hint: string | null
    problems: string[]
  }
}

export function refusalOf(error: unknown): Refusal {
  const refusal = (error ?? {}) as { kind?: unknown; hint?: unknown; problems?: unknown }
  return {
    ok: false,
    error: {
      // A kind the core did not classify stays null: an unreadable file or a dropped call is a
      // failure to retry, and calling it permanent would hide a control that still works. The list
      // of kinds is the core's, so a new one is classified without touching this function.
      kind:
        typeof refusal.kind === 'string' && (ERROR_KINDS as readonly string[]).includes(refusal.kind)
          ? (refusal.kind as ErrorKind)
          : null,
      message: error instanceof Error ? error.message : String(error),
      hint: typeof refusal.hint === 'string' ? refusal.hint : null,
      problems: Array.isArray(refusal.problems) ? refusal.problems.map(String) : [],
    },
  }
}

export {
  correctPoint,
  openView,
  persistView,
  point,
  recordPoint,
  refreshView,
  reloadTab,
  restoreVersion,
  writeView,
} from './view-session.ts'
export type {
  AppendedPoint,
  CorrectedPoint,
  EntryTarget,
  OpenedView,
  PersistedView,
  PointDetail,
  RefreshedView,
  RefreshOptions,
  RestoredVersion,
  TabReload,
  ViewDraft,
} from './view-session.ts'
export type { IncrementalMark } from '../src/core/panels.ts'

// The shell arms this, not the window: the main process is the one with the filesystem (ADR 0010).
export { watchProject } from '../src/core/watch.ts'

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

export interface ProjectList {
  projects: KnownProject[]
  /** Set when the registry file exists but could not be read. Shown, never swallowed. */
  problem?: string
}

export async function projects(): Promise<ProjectList> {
  return listProjects()
}

export interface OpenedProject {
  dir: string
  name: string
  views: ViewSummary[]
  viewProblems: string[]
  datasets: {
    id: string
    shape: string
    version: number
    active: number
    /** Which fields the tab dialog may offer on each side; resolved by the core's one axis rule. */
    axes: { x: ShapeField[]; y: ShapeField[] }
  }[]
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
  const datasets = [...workspace.state.datasets.values()].map((dataset) => {
    const fields = workspace.state.shapes.get(dataset.shape)?.fields ?? []
    return {
      id: dataset.id,
      shape: dataset.shape,
      version: dataset.version,
      active: workspace.dataset(dataset.id).points.length,
      axes: { x: plottableFields(fields, 'x'), y: plottableFields(fields, 'y') },
    }
  })
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
  const workspace = await Workspace.open(dir)
  useWorkspace(workspace)
  return describeProject(workspace)
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

  const workspace = await Workspace.open(target)
  useWorkspace(workspace)
  return describeProject(workspace)
}

export interface RetractedPoint {
  id: string
  dataset: string
  /** The retraction event this call wrote — the act an undo has to name to reverse *this* removal. */
  retraction: string
  active: number
}

/** Remove. A retraction event in the log, not a deletion: the point and its retraction both remain. */
export async function retractPoint(dir: string, id: string, reason?: string): Promise<RetractedPoint> {
  const workspace = await workspaceFor(dir)
  const retracted = await workspace.retractPoint(id, reason)
  await workspace.writeStateBrief()
  return { id, dataset: retracted.dataset, retraction: retracted.event.id, active: retracted.active }
}

export interface RestoredPoint {
  id: string
  dataset: string
  /** The retraction this reversed, which is what the undo undid. */
  retraction: string
  active: number
}

/**
 * Undo of a removal. The same record returns: same id, values, observation time and version.
 *
 * `retraction` is the removal being undone, as returned by `retractPoint`. A window that remembers
 * the act it is undoing passes it; omitting it means the removal in force.
 */
export async function restorePoint(dir: string, id: string, retraction?: string): Promise<RestoredPoint> {
  const workspace = await workspaceFor(dir)
  const restored = await workspace.restorePoint(id, retraction)
  await workspace.writeStateBrief()
  return {
    id,
    dataset: restored.dataset,
    retraction: restored.retraction,
    active: restored.active,
  }
}

export async function importPreview(dir: string, file: string): Promise<ImportPreview> {
  return planPreview(await workspaceFor(dir), file)
}

export interface ImportedTable {
  dataset: string
  rows: number
  /** The version this import wrote, and the one it replaced. */
  version: number
  parent: number | null
  diff: { added: number; removed: number; changed: number }
  /** The rows the parent had that the file does not: withdrawn, never deleted. */
  removedRows: { t: string; values: Record<string, PointValue> }[]
  /**
   * The records this version withdrew or rewrote, by id. A tab's history holds its acts by record,
   * and these are the only ones whose undo the import can have made meaningless: everything else in
   * the dataset is untouched by this write, so an act against it still means what it meant.
   */
  touched: string[]
  /** The original, preserved under data/raw/ before any point was written. */
  preserved: string
  /** Source columns the caller explicitly left out because the shape has no field for them. */
  ignoredColumns: string[]
  warnings: string[]
  active: number
  /** The open tab, rebuilt and redrawn; null when the project has no tab on screen. */
  view: RefreshedView | null
}

/**
 * What an import would do, worked out from the mapping alone and written nowhere.
 *
 * The sheet shows this before the button is pressed, because "replace version 1, +5 −14" is a
 * decision and "import 5 rows" is not. It is the same `planImport` the commit runs, so the preview
 * cannot promise one thing and the write do another.
 */
export interface PlannedImport {
  dataset: string
  rows: number
  version: number
  parent: number | null
  diff: { added: number; removed: number; changed: number }
  removedRows: { t: string; values: Record<string, PointValue> }[]
  ignoredColumns: string[]
  warnings: string[]
}

export async function importPlan(
  dir: string,
  file: string,
  mapping: Record<string, string>,
  options: { time?: string; force?: boolean; ignoreColumns?: string[] } = {},
): Promise<PlannedImport> {
  const plan = await planImport(await workspaceFor(dir), file, {
    mapping,
    ...(options.time === undefined ? {} : { time: options.time }),
    ...(options.ignoreColumns === undefined ? {} : { ignoreColumns: options.ignoreColumns }),
    ...(options.force === true ? { force: true } : {}),
  })
  return {
    dataset: plan.dataset,
    rows: plan.rows,
    version: plan.version,
    parent: plan.parent,
    diff: { added: plan.diff.added, removed: plan.diff.removed, changed: plan.diff.changed },
    removedRows: plan.diff.removedRows.map((row) => ({ t: row.t, values: row.values })),
    ignoredColumns: plan.ignoredColumns,
    warnings: plan.warnings,
  }
}

/**
 * Import a table through the same plan-and-commit path as `bench import`. The mapping is the
 * dialog's one decision; everything else — the format, which cell is a number, which row is bad — is
 * the core's, so the window and the CLI refuse in the same words.
 */
export async function importFile(
  dir: string,
  file: string,
  mapping: Record<string, string>,
  options: { force?: boolean; time?: string; viewName?: string; ignoreColumns?: string[] } = {},
): Promise<ImportedTable> {
  const workspace = await workspaceFor(dir)
  const plan = await planImport(workspace, file, {
    mapping,
    ...(options.force === true ? { force: true } : {}),
    ...(options.time === undefined ? {} : { time: options.time }),
    ...(options.ignoreColumns === undefined ? {} : { ignoreColumns: options.ignoreColumns }),
  })
  const committed = await commitImport(workspace, plan)
  return {
    dataset: plan.dataset,
    rows: plan.rows,
    version: committed.version,
    parent: committed.parent,
    diff: { added: committed.diff.added, removed: committed.diff.removed, changed: committed.diff.changed },
    removedRows: committed.diff.removedRows.map((row) => ({ t: row.t, values: row.values })),
    touched: [
      ...committed.diff.removedRows.map((row) => row.id),
      ...committed.diff.changedRows.map((row) => row.id),
    ],
    preserved: plan.preserved,
    ignoredColumns: plan.ignoredColumns,
    warnings: plan.warnings,
    active: workspace.dataset(plan.dataset).points.length,
    view: options.viewName === undefined ? null : await refreshView(dir, options.viewName, { draw: true }),
  }
}
