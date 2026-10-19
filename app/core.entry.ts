/**
 * The core, bundled for the desktop shell's main process.
 *
 * This file is the only thing the shell knows how to reach, and everything it exposes is a call into
 * `src/core` — there is no second implementation of reading a log, listing views, or drawing a chart.
 * Bundling exists because Electron's Node does not strip TypeScript types; `pnpm app:build` runs
 * esbuild over this entry and writes `app/core.bundle.mjs`, which is generated and ignored.
 *
 * The facade is deliberately small: list projects, open one, list its tabs, open one tab, and return
 * chart SVGs the renderer can draw. Anything a window wants that is not here is a core capability
 * that does not exist yet, and it should be added to the core rather than reimplemented in the shell.
 */
import { APP_ROOT, assessRuns } from '../src/core/analysis.ts'
import { renderChart } from '../src/core/chart.ts'
import { listProjects, rememberProject } from '../src/core/registry.ts'
import type { KnownProject } from '../src/core/registry.ts'
import { Workspace } from '../src/core/workspace.ts'
import { listViews, loadView, panelStatuses } from '../src/core/views.ts'
import type { PanelStatus, ViewFile, ViewSummary } from '../src/core/views.ts'

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
  datasets: { id: string; shape: string; active: number }[]
}

/**
 * Open a project by directory (a subfolder is fine: the core walks up to the root), record a recent,
 * and describe what the window can show. This is the same `Workspace` the CLI uses.
 */
export async function openProject(dir: string): Promise<OpenedProject> {
  const workspace = await Workspace.open(dir)
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
}

export async function openView(dir: string, name: string): Promise<OpenedView> {
  const workspace = await Workspace.open(dir)
  const view = await loadView(dir, name)
  const statuses = await panelStatuses(workspace, view)
  const freshness = await assessRuns(APP_ROOT, workspace.state)
  return {
    view,
    statuses,
    svgs: view.panels.map((panel) => renderChart(panel.chart)),
    staleRuns: [...freshness.values()].filter((entry) => entry.status !== 'fresh').length,
  }
}
