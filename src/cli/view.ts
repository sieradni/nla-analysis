/**
 * `bench view` — list, show, render, create, add, save.
 *
 * This module owns the view command's output and its one panel-materialization helper. The view file
 * format, storage, and rendering live in `core/views.ts`; a panel's selection and materialization
 * live in `core/panels.ts`.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { APP_ROOT } from '../core/analysis.ts'
import { plotHint } from '../core/hints.ts'
import { materializePanel, panelStatuses, type PanelRequest } from '../core/panels.ts'
import { launcherCommand, launcherProjectPath } from '../core/project.ts'
import {
  listViews,
  loadView,
  renderView,
  requireFreeName,
  saveView,
  slugFor,
  validateQuery,
  validateView,
  viewPath,
  type ViewFile,
  type ViewPanel,
} from '../core/views.ts'
import type { Workspace } from '../core/workspace.ts'
import { parseParams } from './params.ts'
import { withRunner } from './runner.ts'

export interface ViewCommandOptions {
  project?: string
  'x-field'?: string
  'y-field'?: string
  dataset?: string
  recipe?: string
  param?: string[]
  query?: string
  title?: string
  columns?: string
  file?: string
  force?: boolean
  refresh?: boolean
  out?: string
}

export interface ViewCommandIO {
  json: boolean
  open: (project?: string) => Promise<Workspace>
  die: (message: string, code?: number, hint?: string) => never
  fail: (error: unknown) => never
}

/** The flags `view new` and `view add` share: everything that describes one panel. */
function panelRequestFrom(options: ViewCommandOptions, io: ViewCommandIO): PanelRequest {
  let query
  if (typeof options.query === 'string') {
    let parsed: unknown
    try {
      parsed = JSON.parse(options.query)
    } catch {
      io.die(
        '--query is not valid JSON',
        1,
        `--query '{"where":[{"field":"y","op":">","value":0}]}'`,
      )
    }
    try {
      query = validateQuery(parsed)
    } catch (error) {
      io.fail(error)
    }
  }

  return {
    ...(options.dataset === undefined ? {} : { dataset: options.dataset }),
    ...(options['x-field'] === undefined ? {} : { xField: options['x-field'] }),
    ...(options['y-field'] === undefined ? {} : { yField: options['y-field'] }),
    ...(options.recipe === undefined ? {} : { recipe: options.recipe }),
    ...(options.param === undefined ? {} : { params: parseParams(options.param, io.die) }),
    ...(query === undefined ? {} : { query }),
    ...(options.title === undefined ? {} : { title: options.title }),
  }
}

/** A panel that needs a recipe gets the Python runtime; a plot of the dataset never does. */
async function materializeOne(
  workspace: Workspace,
  request: PanelRequest,
  io: ViewCommandIO,
): Promise<ViewPanel> {
  try {
    if (request.recipe === undefined) {
      return (await materializePanel(workspace, request)).panel
    }
    return (await withRunner(APP_ROOT, (runner) => materializePanel(workspace, request, runner))).panel
  } catch (error) {
    io.fail(error)
  }
}

function columnCount(raw: string | undefined, io: ViewCommandIO): number {
  if (raw === undefined) return 2
  const columns = Number(raw)
  if (!Number.isInteger(columns) || columns < 1 || columns > 4) {
    io.die(`--columns must be a whole number from 1 to 4, got "${raw}"`, 1)
  }
  return columns
}

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as string | Uint8Array))
  return Buffer.concat(chunks).toString('utf8')
}

/** One line per panel for a person: what it reads, what produced it, and whether it still holds. */
function describePanel(panel: ViewPanel, status: { state: string; detail?: string }): string {
  const source = panel.recipe
    ? `${panel.recipe} ${JSON.stringify(panel.params ?? {})}`
    : 'plot'
  const facts = [
    panel.version === 'latest' ? `${panel.dataset} @latest` : `${panel.dataset} v${panel.version}`,
    source,
    panel.verdict ?? '',
    panel.n === undefined ? '' : `n = ${panel.n}`,
    status.state,
  ].filter((fact) => fact !== '')
  return `${facts.join(' · ')}${status.detail ? ` — ${status.detail}` : ''}`
}

export async function runViewCommand(
  args: readonly string[],
  options: ViewCommandOptions,
  io: ViewCommandIO,
): Promise<void> {
  const [sub, viewName] = args
  if (!sub) {
    io.die('missing a view subcommand', 1, 'bench view list | show | new | add | save | render')
  }

  if (sub === 'list') {
    const workspace = await io.open(options.project)
    const { views, problems } = await listViews(workspace.dir)
    for (const problem of problems) process.stderr.write(`  warning: ${problem}\n`)
    if (io.json) {
      process.stdout.write(
        JSON.stringify(
          { ok: true, data: { views, dir: join(workspace.dir, 'views') }, ...(problems.length === 0 ? {} : { warnings: problems }) },
          null,
          2,
        ) + '\n',
      )
      return
    }
    if (views.length === 0) {
      const datasetId = workspace.resolveDataset(undefined)
      const hint = plotHint(workspace.shapeOf(datasetId), datasetId)
      process.stdout.write('no views yet\n')
      process.stdout.write(
        hint.command
          ? `  next: ${launcherCommand()} --project "${launcherProjectPath(workspace.dir)}" ${hint.command}\n`
          : `  ${hint.problem}\n`,
      )
      return
    }
    process.stdout.write(`${views.length} view(s) in ${join(workspace.dir, 'views')}\n`)
    for (const view of views) {
      const recipes = view.recipes.length === 0 ? '' : ` · ${view.recipes.join(', ')}`
      process.stdout.write(
        `  ${view.name}  ·  ${view.panels} panel(s) · ${view.columns} column(s)${recipes}\n`,
      )
      process.stdout.write(`      ${view.file}\n`)
    }
    return
  }

  if (sub === 'show' || sub === 'render') {
    if (!viewName) io.die(`missing a view name`, 1, `bench view ${sub} <name>`)
    const workspace = await io.open(options.project)

    let view: ViewFile
    try {
      view = await loadView(workspace.dir, viewName)
    } catch (error) {
      io.fail(error)
    }

    let statuses = await panelStatuses(workspace, view)

    if (sub === 'show') {
      if (io.json) {
        process.stdout.write(
          JSON.stringify(
            { ok: true, data: { file: viewPath(workspace.dir, view.name), view, status: statuses } },
            null,
            2,
          ) + '\n',
        )
        return
      }
      process.stdout.write(
        `${view.name} · ${view.panels.length} panel(s) · ${view.layout.columns} column(s) · views/${slugFor(view.name)}.json\n`,
      )
      view.panels.forEach((panel, index) => {
        const status = statuses[index]!
        const heading = panel.title ? `${panel.title} — ` : ''
        process.stdout.write(`  ${index + 1}. ${heading}${describePanel(panel, status)}\n`)
      })
      if (statuses.some((status) => status.state !== 'current' && status.state !== 'unchecked')) {
        process.stdout.write('  next: bench view render --refresh to re-read the data\n')
      }
      return
    }

    // Rendering is the one path that must never need Python: it draws what the file says.
    if (options.refresh === true && statuses.some((status) => status.state !== 'current')) {
      for (const status of statuses) {
        if (status.state === 'current') continue
        const panel = view.panels[status.index]!
        view.panels[status.index] = await materializeOne(workspace, {
          dataset: panel.dataset,
          ...(panel.recipe === undefined ? {} : { recipe: panel.recipe }),
          ...(panel.params === undefined ? {} : { params: panel.params }),
          ...(panel.query === undefined ? {} : { query: panel.query }),
          ...(panel.x_field === undefined ? {} : { xField: panel.x_field }),
          ...(panel.y_field === undefined ? {} : { yField: panel.y_field }),
          ...(panel.title === undefined ? {} : { title: panel.title }),
        }, io)
      }
      try {
        await saveView(workspace.dir, view)
      } catch (error) {
        io.fail(error)
      }
      statuses = await panelStatuses(workspace, view)
    }

    const out = options.out
      ? resolve(options.out)
      : join(workspace.dir, 'artifacts', `view-${slugFor(view.name)}.svg`)
    await mkdir(dirname(out), { recursive: true })
    await writeFile(out, renderView(view))

    if (io.json) {
      process.stdout.write(
        JSON.stringify(
          { ok: true, data: { path: out, panels: view.panels.length, status: statuses } },
          null,
          2,
        ) + '\n',
      )
    } else {
      process.stdout.write(`wrote ${out}  (${view.panels.length} panel(s))\n`)
      for (const status of statuses) {
        if (status.state === 'current') continue
        process.stdout.write(
          `  panel ${status.index + 1}: ${status.state}${status.detail ? ` — ${status.detail}` : ''}\n`,
        )
      }
    }
    return
  }

  if (sub === 'new' || sub === 'add') {
    if (!viewName) io.die('missing a view name', 1, `bench view ${sub} <name> --dataset main`)
    const workspace = await io.open(options.project)

    let view: ViewFile
    if (sub === 'new') {
      try {
        await requireFreeName(workspace.dir, viewName, options.force === true)
      } catch (error) {
        io.fail(error)
      }
      view = { v: 1, name: viewName, layout: { columns: columnCount(options.columns, io) }, panels: [] }
    } else {
      try {
        view = await loadView(workspace.dir, viewName)
      } catch (error) {
        io.fail(error)
      }
    }

    const panel = await materializeOne(workspace, panelRequestFrom(options, io), io)
    view.panels.push(panel)
    try {
      await saveView(workspace.dir, view)
    } catch (error) {
      io.fail(error)
    }

    const status = describePanel(panel, { state: 'current' })
    if (io.json) {
      process.stdout.write(
        JSON.stringify(
          {
            ok: true,
            data: { file: viewPath(workspace.dir, view.name), panels: view.panels.length, panel },
          },
          null,
          2,
        ) + '\n',
      )
    } else {
      process.stdout.write(
        `${sub === 'new' ? 'created' : 'added a panel to'} views/${slugFor(view.name)}.json  (${view.panels.length} panel(s))\n`,
      )
      process.stdout.write(`  ${status}\n`)
    }
    return
  }

  if (sub === 'save') {
    const file = options.file
    if (file === undefined) {
      io.die('missing a file to save', 1, `bench view save --file view.json (or - for stdin)`)
    }

    let text: string
    if (file === '-') {
      text = await readStream(process.stdin)
    } else {
      try {
        text = await readFile(resolve(file), 'utf8')
      } catch {
        io.die(`cannot read ${file}`, 2)
      }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      io.die(`${file} is not valid JSON`, 1)
    }

    let view: ViewFile
    try {
      view = validateView(parsed)
    } catch (error) {
      io.fail(error)
    }
    if (viewName !== undefined && slugFor(viewName) !== slugFor(view.name)) {
      io.die(
        `the file is named "${view.name}", but the command asked for "${viewName}"`,
        1,
        'rename the view in the file, or the file on disk',
      )
    }

    const workspace = await io.open(options.project)
    try {
      await saveView(workspace.dir, view)
    } catch (error) {
      io.fail(error)
    }
    if (io.json) {
      process.stdout.write(
        JSON.stringify(
          { ok: true, data: { file: viewPath(workspace.dir, view.name), panels: view.panels.length } },
          null,
          2,
        ) + '\n',
      )
    } else {
      process.stdout.write(
        `saved views/${slugFor(view.name)}.json  (${view.panels.length} panel(s))\n`,
      )
    }
    return
  }

  io.die(`unknown view subcommand "${sub}"`, 1, 'bench view list | show | new | add | save | render')
}
