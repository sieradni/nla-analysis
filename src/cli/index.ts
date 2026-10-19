#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { freshnessNote } from '../core/analysis.ts'
import {
  BenchError,
  Workspace,
  type AnalysisOutcome,
  type ErrorKind,
  type PointCorrection,
  type PointRetraction,
  type RecordedPoint,
} from '../core/workspace.ts'
import { makeEvent } from '../core/events.ts'
import type { BenchEvent, PointValue } from '../core/events.ts'
import { renderChart } from '../core/chart.ts'
import { validateValues } from '../core/shapes.ts'
import { findProjectDir, initProject } from '../core/project.ts'
import {
  listProjects,
  rememberProject,
  resolveProjectName,
  type KnownProject,
} from '../core/registry.ts'
import {
  listViews,
  loadView,
  materializePanel,
  panelStatuses,
  plotDataset,
  renderView,
  requireFreeName,
  saveView,
  slugFor,
  validateView,
  validateQuery,
  viewPath,
  type PanelRequest,
  type ViewFile,
  type ViewPanel,
} from '../core/views.ts'
import { RecipeRunner } from '../core/runner.ts'
import { renderState } from '../core/state.ts'
import { coerce, parseDelimited, parseJsonl } from '../core/table.ts'

/**
 * Recipes belong to the application, not to the user's project: they are the analysis library that
 * ships with bench, pinned and shared. A project owns data, shapes, views and decisions; it will be
 * able to add its own recipes later, but it does not carry a copy of these.
 *
 * Resolved from this file's own location rather than from the working directory, so `bench` works
 * from anywhere -- inside a project, from a parent folder, or from a completely unrelated path.
 */
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const EXIT_OK = 0
const EXIT_INVALID = 1
const EXIT_MISSING = 2
const EXIT_INVARIANT = 3

const OPTIONS = {
  name: { type: 'string' },
  x: { type: 'string' },
  y: { type: 'string' },
  values: { type: 'string' },
  dataset: { type: 'string' },
  at: { type: 'string' },
  note: { type: 'string' },
  reason: { type: 'string' },
  tag: { type: 'string', multiple: true },
  param: { type: 'string', multiple: true },
  chart: { type: 'string' },
  recipe: { type: 'string' },
  title: { type: 'string' },
  query: { type: 'string' },
  columns: { type: 'string' },
  shape: { type: 'string' },
  file: { type: 'string' },
  scan: { type: 'string' },
  refresh: { type: 'boolean' },
  format: { type: 'string' },
  map: { type: 'string', multiple: true },
  time: { type: 'string' },
  force: { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  out: { type: 'string' },
  project: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const

function die(message: string, code = EXIT_INVALID, hint?: string): never {
  process.stderr.write(`bench: ${message}\n`)
  if (hint) process.stderr.write(`  hint: ${hint}\n`)
  process.exit(code)
}

function toNumber(raw: string, field: string): number {
  const value = Number(raw)
  if (!Number.isFinite(value)) die(`--${field} must be a number, got "${raw}"`)
  return value
}

function printHelp(): void {
  process.stdout.write(`bench — append-only data project

Usage
  bench init [dir] [--name <name>]      create a project folder
  bench projects [--scan <dir>]         projects on this machine, most recent first
  bench add --x 1 --y 2 [options]       record a point
  bench correct <id> --values '{"y":3}'  supersede a point (never overwrites)
  bench retract <id> [--reason text]    withdraw a point from analysis
  bench list [--dataset id] [--json]    list active points
  bench state [--json]                  regenerate and print STATE.md
  bench check [--json]                  validate the log and shapes
  bench chart [--out file.svg]          render the dataset to an SVG artifact
  bench import <file> [options]         bring rows in from csv, tsv, or jsonl
  bench recipes [--json]                list analysis recipes and their parameters
  bench runs [--json]                   recorded analyses, and whether they still hold
  bench rerun <recipe> [--param k=v]    repeat a run with its recorded parameters
  bench run <recipe> [--param k=v]      run an analysis, record it, and chart the result
  bench decide "<text>"                 record a decision the next session inherits

Views (a tab is a view file in the project)
  bench view list                       views in this project
  bench view show <name>                one view, with the state of every panel
  bench view new <name> [options]       create a one-panel view from the data or a recipe
  bench view add <name> [options]       append a panel to an existing view
  bench view save [name] --file <json>  store a view file (use - for stdin)
  bench view render <name> [--refresh]  draw the saved specs to artifacts/view-<name>.svg

Options for add
  --values '{"x":1,"y":2}'   explicit field values
  --at <iso time>            when the value was observed; stored as canonical UTC
  --note <text>              context attached to the point
  --reason <text>            why a point was corrected or retracted
  --tag <tag>                repeatable
  --dataset <id>             defaults to main
  --param <name=value>       recipe parameter, repeatable (numbers and booleans inferred)
  --chart <path>             where to write the rendered artifact

Options for view new / add
  --dataset <id>             which dataset the panel reads
  --recipe <name>            make the panel an analysis, not just a plot
  --param <name=value>       recipe parameter, repeatable
  --query '{"where":[…]}'    select rows: field/op/value clauses, all must hold
  --title <text>             panel heading
  --columns <1-4>            grid columns for the tab (view new only)

Options for init
  --shape <file>            declare the point shape from a JSON file instead of xy.v1

Options for import
  --map <field=column>       map a shape field to a column with a different name, repeatable
  --time <column>            read the observation time from a column
  --format csv|tsv|jsonl     override detection from the file extension
  --dry-run                  report what would be imported and change nothing
  --force                    import a file whose exact contents were imported before

Global
  --project <dir|name>  operate on another project: a path, or a registered name
  --json            machine-readable output
  -h, --help        this text

Exit codes
  0 ok   1 invalid input   2 not found   3 invariant would break
`)
}

const EXIT_FOR_KIND: Record<ErrorKind, number> = {
  invalid: EXIT_INVALID,
  missing: EXIT_MISSING,
  invariant: EXIT_INVARIANT,
}

/**
 * The CLI owns exit codes and the shape of a refusal; the core throws and never exits, because a GUI
 * embedding the same library has no exit code to set. See ADR 0003.
 */
function fail(error: unknown): never {
  if (error instanceof BenchError) {
    for (const problem of error.problems) process.stderr.write(`  error: ${problem}\n`)
    die(error.message, EXIT_FOR_KIND[error.kind], error.hint)
  }
  die(error instanceof Error ? error.message : String(error), EXIT_INVARIANT)
}

/**
 * `--project` takes a path or the name a project was registered under. A name is only consulted
 * when nothing exists at that path, so a folder literally called `drift` still wins over a
 * registered project named drift.
 */
async function locateProject(explicit?: string): Promise<string> {
  if (explicit === undefined) return process.cwd()
  const asPath = resolve(explicit)
  if (existsSync(asPath)) return asPath
  const byName = await resolveProjectName(explicit)
  return byName ?? asPath
}

/** Every command opens the project the same way, and every open records a recent. */
async function openWorkspace(explicit?: string): Promise<Workspace> {
  let workspace: Workspace
  try {
    workspace = await Workspace.open(await locateProject(explicit))
  } catch (error) {
    fail(error)
  }
  // Recency is application state, not project state. A read-only home must not fail `bench list`,
  // and the command already succeeded at the thing the user asked for.
  try {
    await rememberProject(workspace.dir, {
      name: workspace.config.name,
      created: workspace.config.created,
    })
  } catch (error) {
    // The registry is a convenience — losing it loses recency, not data — but a broken one is worth
    // saying out loud once, rather than silently losing every project from the list.
    process.stderr.write(`  warning: could not record this project: ${(error as Error).message}\n`)
  }
  return workspace
}

/** Shared by `add` and `correct`: both accept the same field-selection flags. */
function collectValues(options: { x?: unknown; y?: unknown; values?: unknown }): Record<string, PointValue> {
  const collected: Record<string, PointValue> = {}
  if (typeof options.values === 'string') {
    let parsed: unknown
    try {
      parsed = JSON.parse(options.values)
    } catch {
      die(`--values is not valid JSON`)
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      die(`--values must be a JSON object like '{"x":1,"y":2}'`)
    }
    Object.assign(collected, parsed as Record<string, PointValue>)
  }
  if (typeof options.x === 'string') collected.x = toNumber(options.x, 'x')
  if (typeof options.y === 'string') collected.y = toNumber(options.y, 'y')
  return collected
}

/** Coerce `--param k=v` text into the type the recipe declared. */
function parseParams(entries: string[] | undefined): Record<string, unknown> {
  const params: Record<string, unknown> = {}
  for (const entry of entries ?? []) {
    const separator = entry.indexOf('=')
    if (separator <= 0) die(`--param must look like name=value, got "${entry}"`)
    const name = entry.slice(0, separator).trim()
    const raw = entry.slice(separator + 1).trim()
    if (raw === 'true') params[name] = true
    else if (raw === 'false') params[name] = false
    else if (raw !== '' && Number.isFinite(Number(raw))) params[name] = Number(raw)
    else params[name] = raw
  }
  return params
}

async function withRunner<T>(root: string, use: (runner: RecipeRunner) => Promise<T>): Promise<T> {
  const runner = new RecipeRunner(root)
  try {
    await runner.start()
    return await use(runner)
  } catch (error) {
    // A refusal is not a runtime failure. Wrapping one would bury its kind — and a mistyped dataset
    // would surface as "the analysis runtime cannot modify the log", which is a true sentence about
    // the wrong thing.
    if (error instanceof BenchError) throw error
    // The interpreter is a separate process with no write access to the log, so a failure here can
    // never damage the data. Say so, because "analysis broke" reads as "data is at risk".
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${message} — the analysis runtime cannot modify the log, so nothing was lost`)
  } finally {
    await runner.dispose()
  }
}

/** Compact display for a coefficient; six significant figures is more than a reader can use. */
function shortNumber(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  return String(Number(value.toPrecision(6)))
}

const TIME_COLUMN_NAMES = ['t_observed', 'observed_at', 'timestamp', 'time', 'date', 't']

function guessFormat(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.jsonl') || lower.endsWith('.ndjson')) return 'jsonl'
  if (lower.endsWith('.tsv') || lower.endsWith('.tab')) return 'tsv'
  return 'csv'
}

interface PanelOptions {
  dataset?: string
  recipe?: string
  param?: string[]
  query?: string
  title?: string
}

/** The flags `view new` and `view add` share: everything that describes one panel. */
function panelRequestFrom(options: PanelOptions): PanelRequest {
  let query
  if (typeof options.query === 'string') {
    let parsed: unknown
    try {
      parsed = JSON.parse(options.query)
    } catch {
      die('--query is not valid JSON', EXIT_INVALID, `--query '{"where":[{"field":"y","op":">","value":0}]}'`)
    }
    try {
      query = validateQuery(parsed)
    } catch (error) {
      fail(error)
    }
  }

  return {
    ...(options.dataset === undefined ? {} : { dataset: options.dataset }),
    ...(options.recipe === undefined ? {} : { recipe: options.recipe }),
    ...(options.param === undefined ? {} : { params: parseParams(options.param) }),
    ...(query === undefined ? {} : { query }),
    ...(options.title === undefined ? {} : { title: options.title }),
  }
}

/** A panel that needs a recipe gets the Python runtime; a plot of the dataset never does. */
async function materializeOne(workspace: Workspace, request: PanelRequest): Promise<ViewPanel> {
  try {
    if (request.recipe === undefined) {
      return (await materializePanel(workspace, request)).panel
    }
    return (await withRunner(APP_ROOT, (runner) => materializePanel(workspace, request, runner))).panel
  } catch (error) {
    fail(error)
  }
}

function columnCount(raw: string | undefined): number {
  if (raw === undefined) return 2
  const columns = Number(raw)
  if (!Number.isInteger(columns) || columns < 1 || columns > 4) {
    die(`--columns must be a whole number from 1 to 4, got "${raw}"`, EXIT_INVALID)
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
    panel.dataset,
    source,
    panel.verdict ?? '',
    panel.n === undefined ? '' : `n = ${panel.n}`,
    status.state,
  ].filter((fact) => fact !== '')
  return `${facts.join(' · ')}${status.detail ? ` — ${status.detail}` : ''}`
}

function parse(argv: string[]) {
  try {
    return parseArgs({ args: argv, allowPositionals: true, options: OPTIONS, strict: true })
  } catch (error) {
    die((error as Error).message)
  }
}

async function main(): Promise<void> {
  // Flags may appear before or after the command: `bench --project x add ...` is valid.
  const { values, positionals } = parse(process.argv.slice(2))
  const [command, ...args] = positionals

  if (!command || command === 'help' || values.help) {
    printHelp()
    process.exit(EXIT_OK)
  }

  const asJson = values.json === true

  switch (command) {
    case 'init': {
      const target = resolve(args[0] ?? '.')
      // `--shape <file>` declares the fields at the one moment they can be chosen. Without it the
      // default xy.v1 is used, exactly as before. The window's create dialog writes the same event
      // through the same function; this flag is how an agent does the same thing without a dialog.
      let shape: unknown = undefined
      if (values.shape !== undefined) {
        let text: string
        try {
          text = await readFile(resolve(values.shape), 'utf8')
        } catch {
          die(`cannot read shape file ${values.shape}`, EXIT_MISSING)
        }
        try {
          shape = JSON.parse(text)
        } catch {
          die(`${values.shape} is not valid JSON`)
        }
      }
      try {
        const handle = await initProject(target, values.name, undefined, shape)
        try {
          await rememberProject(handle.dir, { name: handle.config.name, created: handle.config.created })
        } catch (error) {
          process.stderr.write(`  warning: created, but could not be registered: ${(error as Error).message}\n`)
        }
        if (asJson) {
          process.stdout.write(
            JSON.stringify({ ok: true, data: { dir: handle.dir, name: handle.config.name } }, null, 2) + '\n',
          )
        } else {
          process.stdout.write(`created project "${handle.config.name}" at ${handle.dir}\n`)
          process.stdout.write(
            `  shape ${shape ? 'declared from ' + values.shape : 'xy.v1 (x, y)'} · dataset main\n`,
          )
          process.stdout.write(`  next: bench add --x 1.2 --y 3.4\n`)
        }
      } catch (error) {
        // `fail` maps a BenchError to its own kind, so a bad shape file exits 1 (invalid input)
        // rather than 3, which would tell an agent the log was at risk when nothing was written.
        fail(error)
      }
      return
    }

    case 'projects': {
      let listed: Awaited<ReturnType<typeof listProjects>>
      try {
        listed = await listProjects(values.scan)
      } catch (error) {
        fail(error)
      }
      if (listed.problem !== undefined) process.stderr.write(`  warning: ${listed.problem}\n`)

      const here = await findProjectDir(process.cwd())
      const rows = listed.projects.map((project) => ({
        ...project,
        current: here !== null && project.dir === here,
      }))

      if (asJson) {
        process.stdout.write(
          JSON.stringify(
            {
              ok: true,
              data: { projects: rows, current: here },
              ...(listed.problem === undefined ? {} : { warnings: [listed.problem] }),
            },
            null,
            2,
          ) + '\n',
        )
        return
      }

      if (rows.length === 0) {
        process.stdout.write('no projects yet\n  next: bench init <dir>\n')
        return
      }

      const width = Math.max(...rows.map((project) => project.name.length))
      process.stdout.write(`${rows.length} project(s), most recent first\n`)
      for (const project of rows as (KnownProject & { current: boolean })[]) {
        const marker = project.current ? '*' : ' '
        const notes = [
          project.registered ? `last opened ${project.lastOpened.slice(0, 16).replace('T', ' ')}` : 'not registered',
          project.exists ? '' : 'missing',
        ].filter((note) => note !== '')
        process.stdout.write(`  ${marker} ${project.name.padEnd(width)}  ${notes.join(' · ')}\n`)
        process.stdout.write(`      ${project.dir}\n`)
      }
      return
    }

    case 'add': {
      const workspace = await openWorkspace(values.project)
      const pointValues = collectValues(values)

      // Normalise to canonical UTC with milliseconds, so that sorting timestamps as strings and
      // sorting them by instant give the same answer. Offsets and shortened forms are accepted on
      // input; only the canonical form is ever stored.
      let observed: string | undefined
      if (values.at !== undefined) {
        const observedMs = Date.parse(values.at)
        if (Number.isNaN(observedMs)) {
          die(`--at is not a parseable time: "${values.at}"`, EXIT_INVALID, 'use an ISO timestamp')
        }
        observed = new Date(observedMs).toISOString()
      }

      let recorded: RecordedPoint
      try {
        recorded = await workspace.recordPoint({
          ...(values.dataset === undefined ? {} : { dataset: values.dataset }),
          values: pointValues,
          ...(observed === undefined ? {} : { tObserved: observed }),
          ...(values.note === undefined ? {} : { note: values.note }),
          ...(values.tag === undefined ? {} : { tags: values.tag }),
        })
      } catch (error) {
        fail(error)
      }
      await workspace.writeStateBrief()

      const summary = Object.entries(pointValues)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(' ')
      if (asJson) {
        process.stdout.write(
          JSON.stringify(
            {
              ok: true,
              data: {
                id: recorded.event.id,
                dataset: recorded.dataset,
                values: pointValues,
                t_observed: recorded.tObserved,
              },
              warnings: recorded.warnings,
            },
            null,
            2,
          ) + '\n',
        )
      } else {
        for (const warning of recorded.warnings) process.stderr.write(`  warning: ${warning}\n`)
        const count = workspace.dataset(recorded.dataset).points.length
        process.stdout.write(
          `recorded ${recorded.event.id}  ${summary}  at ${recorded.tObserved}  (${count} active in ${recorded.dataset})\n`,
        )
      }
      return
    }

    case 'list': {
      const workspace = await openWorkspace(values.project)
      const datasetId = workspace.resolveDataset(values.dataset)
      const points = workspace.dataset(datasetId).points

      if (asJson) {
        process.stdout.write(
          JSON.stringify(
            {
              ok: true,
              data: points.map((point) => ({
                id: point.id,
                t_observed: point.tObserved,
                values: point.values,
                note: point.note,
                tags: point.tags,
                corrections: point.corrections.length,
              })),
            },
            null,
            2,
          ) + '\n',
        )
        return
      }

      process.stdout.write(`${datasetId}: ${points.length} active point(s)\n`)
      for (const point of points.slice(-40)) {
        const fields = Object.entries(point.values)
          .map(([key, value]) => `${key}=${String(value)}`)
          .join(' ')
        const note = point.note ? `  · ${point.note}` : ''
        process.stdout.write(`  ${point.tObserved}  ${fields}${note}\n`)
      }
      if (points.length > 40) process.stdout.write(`  … ${points.length - 40} earlier point(s)\n`)
      return
    }

    case 'state': {
      const workspace = await openWorkspace(values.project)
      await workspace.writeStateBrief()
      const state = workspace.state
      if (asJson) {
        process.stdout.write(
          JSON.stringify(
            {
              ok: true,
              data: {
                name: workspace.config.name,
                dir: workspace.dir,
                datasets: [...state.datasets.values()].map((dataset) => ({
                  id: dataset.id,
                  shape: dataset.shape,
                  active: dataset.points.filter((point) => point.status === 'active').length,
                  recorded: dataset.points.length,
                })),
                runs: state.runs,
                decisions: state.decisions,
                problems: state.problems,
              },
            },
            null,
            2,
          ) + '\n',
        )
        return
      }
      process.stdout.write(renderState(workspace.config, state))
      return
    }

    case 'check': {
      const workspace = await openWorkspace(values.project)
      const events = workspace.allEvents
      const state = workspace.state
      const errors: string[] = [...workspace.problems, ...state.problems]
      const warnings: string[] = []
      let retracted = 0

      for (const dataset of state.datasets.values()) {
        const shape = state.shapes.get(dataset.shape)
        if (!shape) {
          errors.push(`dataset "${dataset.id}" references unknown shape "${dataset.shape}"`)
          continue
        }
        // Only the active set is validated: retracting a bad record is the documented remedy for one,
        // and check reports on the dataset as it stands, not on every entry ever made.
        for (const point of dataset.points) {
          if (point.status === 'retracted') {
            retracted += 1
            continue
          }
          const validation = validateValues(shape, point.values)
          errors.push(...validation.errors.map((problem) => `${dataset.id}/${point.id}: ${problem}`))
          warnings.push(...validation.warnings.map((problem) => `${dataset.id}/${point.id}: ${problem}`))
        }
      }

      if (asJson) {
        process.stdout.write(
          JSON.stringify(
            { ok: errors.length === 0, errors, warnings, events: events.length, retracted },
            null,
            2,
          ) + '\n',
        )
      } else {
        for (const warning of warnings) process.stdout.write(`warning: ${warning}\n`)
        for (const error of errors) process.stdout.write(`error:   ${error}\n`)
        const active = [...state.datasets.values()].reduce(
          (sum, dataset) => sum + dataset.points.filter((point) => point.status === 'active').length,
          0,
        )
        const retractedNote = retracted > 0 ? ` · ${retracted} retracted (not validated)` : ''
        process.stdout.write(
          `${events.length} events · ${active} active points${retractedNote} · ${errors.length} error(s) · ${warnings.length} warning(s)\n`,
        )
      }
      process.exit(errors.length === 0 ? EXIT_OK : EXIT_INVARIANT)
    }

    case 'chart': {
      const workspace = await openWorkspace(values.project)
      const datasetId = workspace.resolveDataset(values.dataset)
      // The same unmodelled spec a panel without a recipe uses: one implementation of "plot what is
      // there, and say that nothing was modelled".
      let plotted: ReturnType<typeof plotDataset>
      try {
        plotted = plotDataset(workspace, datasetId)
      } catch (error) {
        fail(error)
      }

      if (plotted.plotted === 0) {
        die(`dataset "${datasetId}" has no points with numeric x and y`, EXIT_MISSING, 'bench add --x 1 --y 2')
      }

      const out = values.out ? resolve(values.out) : join(workspace.dir, 'artifacts', `${datasetId}.svg`)
      await mkdir(join(workspace.dir, 'artifacts'), { recursive: true })
      await writeFile(out, renderChart(plotted.spec))

      if (asJson) {
        process.stdout.write(
          JSON.stringify({ ok: true, data: { path: out, points: plotted.plotted } }, null, 2) + '\n',
        )
      } else {
        process.stdout.write(`wrote ${out}  (${plotted.plotted} points)\n`)
      }
      return
    }

    case 'import': {
      const file = args[0]
      if (!file) die('missing a file to import', EXIT_INVALID, 'bench import readings.csv')
      const workspace = await openWorkspace(values.project)

      // A relative path is looked for where the shell is, then inside the project. Both are what a
      // person means by `import readings.csv`, especially when --project points somewhere else.
      const candidates = isAbsolute(file) ? [file] : [resolve(file), resolve(workspace.dir, file)]
      const source = candidates.find((candidate) => existsSync(candidate))
      if (!source) {
        die(`cannot find ${file}`, EXIT_MISSING, `looked in ${candidates.map((c) => dirname(c)).join(' and ')}`)
      }

      let text: string
      try {
        text = await readFile(source, 'utf8')
      } catch {
        die(`cannot read ${source}`, EXIT_MISSING)
      }

      const datasetId = workspace.resolveDataset(values.dataset)
      const dataset = workspace.dataset(datasetId)
      const shape = workspace.shapeOf(datasetId)

      const format = (values.format ?? guessFormat(source)).toLowerCase()
      if (!['csv', 'tsv', 'jsonl'].includes(format)) {
        die(`unknown format "${format}"`, EXIT_INVALID, 'use csv, tsv, or jsonl')
      }
      const table = format === 'jsonl' ? parseJsonl(text) : parseDelimited(text, format === 'tsv' ? '\t' : undefined)
      if (table.rows.length === 0) {
        die('the file has no data rows', EXIT_INVALID, `columns found: ${table.columns.join(', ') || 'none'}`)
      }

      const requested = new Map<string, string>()
      for (const entry of values.map ?? []) {
        const separator = entry.indexOf('=')
        if (separator <= 0) die(`--map must look like field=column, got "${entry}"`)
        requested.set(entry.slice(0, separator).trim(), entry.slice(separator + 1).trim())
      }
      const lowered = new Map(table.columns.map((column) => [column.toLowerCase(), column]))
      const mapping = new Map<string, string>()
      for (const field of shape.fields) {
        const column = requested.get(field.name) ?? lowered.get(field.name.toLowerCase())
        if (column === undefined) {
          if (field.optional === true) continue
          die(
            `no column for the required field "${field.name}"`,
            EXIT_INVALID,
            `the file has ${table.columns.join(', ')}; use --map ${field.name}=<column>`,
          )
        }
        if (!table.columns.includes(column)) {
          die(`column "${column}" is not in the file`, EXIT_INVALID, `the file has ${table.columns.join(', ')}`)
        }
        mapping.set(field.name, column)
      }

      const timeColumn =
        values.time ?? TIME_COLUMN_NAMES.find((name) => lowered.has(name))

      const errors: string[] = []
      const warnings: string[] = []
      const prepared: { values: Record<string, PointValue>; t: string }[] = []

      table.rows.forEach((row, index) => {
        const where = `row ${index + 2}`
        const pointValues: Record<string, PointValue> = {}
        for (const field of shape.fields) {
          const column = mapping.get(field.name)
          if (column === undefined) continue
          // Absent cells are dropped rather than defaulted, so a gap is a gap and validation sees it.
          const value = coerce(row[column] ?? '', field.type)
          if (value !== null) pointValues[field.name] = value
        }

        let observed = new Date().toISOString()
        if (timeColumn !== undefined) {
          const raw = row[timeColumn] ?? ''
          const milliseconds = Date.parse(raw)
          if (raw === '' || Number.isNaN(milliseconds)) {
            errors.push(`${where}: "${raw}" is not a parseable time`)
            return
          }
          observed = new Date(milliseconds).toISOString()
        }

        const validation = validateValues(shape, pointValues)
        if (validation.errors.length > 0) {
          errors.push(`${where}: ${validation.errors.join('; ')}`)
          return
        }
        for (const warning of validation.warnings) warnings.push(`${where}: ${warning}`)
        prepared.push({ values: pointValues, t: observed })
      })

      if (errors.length > 0) {
        for (const problem of errors.slice(0, 5)) process.stderr.write(`  ${problem}\n`)
        if (errors.length > 5) process.stderr.write(`  … and ${errors.length - 5} more\n`)
        die(`${errors.length} row(s) would not import, so none were`, EXIT_INVALID, 'fix the file, or fix the mapping')
      }

      const hash = createHash('sha256').update(text).digest('hex')
      const existing = workspace.allEvents
      const reimport = existing.find(
        (event) => event.type === 'import_completed' && event.hash === hash && event.dataset === datasetId,
      )
      if (reimport && values.force !== true) {
        die(
          `these exact contents were already imported into "${datasetId}"`,
          EXIT_INVALID,
          'pass --force to import them a second time',
        )
      }

      const summary = {
        dataset: datasetId,
        shape: dataset.shape,
        format,
        rows: prepared.length,
        columns: table.columns,
        mapping: Object.fromEntries(mapping),
        timeColumn: timeColumn ?? null,
        sourceHash: hash,
        raggedRows: table.raggedRows,
        comments: table.comments ?? 0,
      }

      if (values['dry-run'] === true) {
        if (asJson) {
          process.stdout.write(
            JSON.stringify({ ok: true, data: { ...summary, dryRun: true, sample: prepared.slice(0, 3) } }, null, 2) + '\n',
          )
        } else {
          process.stdout.write(`would import ${prepared.length} row(s) into ${datasetId} (${dataset.shape})\n`)
          for (const [field, column] of mapping) process.stdout.write(`  ${field} <= ${column}\n`)
          if (timeColumn) process.stdout.write(`  t_observed <= ${timeColumn}\n`)
          process.stdout.write(`  nothing was written\n`)
        }
        return
      }

      // The original is copied before anything is recorded: an import is evidence, and the file that
      // produced it must outlive whatever is done to the working copy. It is never read again.
      //
      // The name is content-addressed rather than clock-stamped, so the same bytes always land at
      // the same path: a re-import updates one file instead of piling up near-duplicates, and a
      // project rebuilt from its own script reproduces the same tree. When it arrived is in the
      // event's `at`, which is where a time belongs.
      const rawName = `${hash.slice(0, 12)}-${basename(source)}`
      await mkdir(join(workspace.dir, 'data', 'raw'), { recursive: true })
      await copyFile(source, join(workspace.dir, 'data', 'raw', rawName))
      const rawRef = `data/raw/${rawName}`

      const appended: BenchEvent[] = prepared.map((point) =>
        makeEvent('point_recorded', workspace.session, {
          dataset: datasetId,
          shape: dataset.shape,
          values: point.values,
          t_observed: point.t,
          tags: ['import'],
        }),
      )
      appended.push(
        makeEvent('import_completed', workspace.session, {
          dataset: datasetId,
          file: rawRef,
          rows: prepared.length,
          hash,
          columns: table.columns,
          mapping: Object.fromEntries(mapping),
        }),
      )
      await workspace.appendAll(appended)
      await workspace.writeStateBrief()

      for (const warning of warnings.slice(0, 5)) process.stderr.write(`  warning: ${warning}\n`)
      if (asJson) {
        process.stdout.write(
          JSON.stringify({ ok: true, data: { ...summary, preserved: rawRef, warnings } }, null, 2) + '\n',
        )
      } else {
        process.stdout.write(`imported ${prepared.length} row(s) into ${datasetId} from ${basename(source)}\n`)
        process.stdout.write(`  preserved as ${rawRef}\n`)
        for (const [field, column] of mapping) process.stdout.write(`  ${field} <= ${column}\n`)
        if (timeColumn) process.stdout.write(`  t_observed <= ${timeColumn}\n`)
        if (table.raggedRows > 0) {
          process.stdout.write(`  ${table.raggedRows} row(s) had a different number of fields than the header\n`)
        }
        if ((table.comments ?? 0) > 0) {
          process.stdout.write(`  ${table.comments} comment line(s) skipped\n`)
        }
      }
      return
    }

    case 'runs': {
      const workspace = await openWorkspace(values.project)
      const freshness = await workspace.freshestRuns()
      const runs = workspace.runsNewestFirst()

      if (asJson) {
        process.stdout.write(
          JSON.stringify(
            {
              ok: true,
              data: runs.map((run) => ({
                id: run.id,
                at: run.at,
                recipe: run.recipe,
                params: run.params ?? {},
                dataset: run.dataset ?? null,
                verdict: run.verdict,
                narrative: run.narrative ?? null,
                artifact: run.artifact ?? null,
                freshness: freshness.get(run.id) ?? null,
              })),
            },
            null,
            2,
          ) + '\n',
        )
        return
      }

      if (runs.length === 0) {
        process.stdout.write('no analyses have been run in this project\n')
        process.stdout.write('  next: bench run fit --param degree=1\n')
        return
      }
      for (const run of runs) {
        const note = freshnessNote(freshness.get(run.id))
        process.stdout.write(
          `${run.at}  ${run.recipe}  ${run.verdict}  ${note}\n`,
        )
        process.stdout.write(`  ${run.dataset ?? 'unknown dataset'} · ${JSON.stringify(run.params ?? {})}\n`)
      }
      return
    }

    case 'rerun': {
      const recipeName = args[0]
      if (!recipeName) die('missing recipe name', EXIT_INVALID, 'bench runs --json, then bench rerun <recipe>')
      const workspace = await openWorkspace(values.project)
      // Re-run the most recent use of this recipe, with the parameters it was asked for. Carrying
      // the parameters forward by hand is how a re-run silently becomes a different analysis.
      const previous = workspace.runsNewestFirst().find((run) => run.recipe === recipeName)
      if (!previous) {
        die(`no previous \`${recipeName}\` run to repeat`, EXIT_MISSING, `bench run ${recipeName}`)
      }
      const params = { ...(previous.params ?? {}), ...parseParams(values.param) }

      let repeated: AnalysisOutcome
      try {
        repeated = await withRunner(APP_ROOT, (runner) =>
          workspace.recordAnalysis(runner, {
            recipe: recipeName,
            params,
            ...(values.dataset === undefined ? {} : { dataset: values.dataset }),
            ...(values.chart === undefined ? {} : { chartPath: values.chart }),
            repeatOf: previous,
          }),
        )
      } catch (error) {
        fail(error)
      }
      await workspace.writeStateBrief()

      if (asJson) {
        process.stdout.write(
          JSON.stringify(
            {
              ok: true,
              data: {
                id: repeated.event.id,
                repeated: previous.id,
                params: repeated.params,
                verdict: repeated.result.verdict,
                narrative: repeated.result.narrative,
                artifact: repeated.artifactRef,
                changed: repeated.verdictChanged === true,
              },
            },
            null,
            2,
          ) + '\n',
        )
        return
      }
      // Saying what changed is the whole point of repeating a run: the answer is allowed to differ.
      const change =
        previous.verdict === repeated.result.verdict
          ? `verdict unchanged (${repeated.result.verdict})`
          : `verdict changed ${previous.verdict} -> ${repeated.result.verdict}`
      process.stdout.write(`${repeated.result.verdict.toUpperCase()}  ${repeated.result.narrative}\n`)
      process.stdout.write(`  repeated ${previous.id} with ${JSON.stringify(repeated.params)}: ${change}\n`)
      process.stdout.write(`  wrote ${repeated.artifactRef}\n`)
      return
    }

    case 'recipes': {
      // Deliberately does not require a project: this describes the analysis library bench ships.
      return withRunner(APP_ROOT, async (runner) => {
        const catalog = await runner.catalog()
        const environment = await runner.environment()
        if (asJson) {
          process.stdout.write(
            JSON.stringify({ ok: true, data: { recipes: catalog, environment } }, null, 2) + '\n',
          )
          return
        }
        process.stdout.write(
          `runtime: python ${environment.python} · numpy ${environment.numpy} · scipy ${environment.scipy}\n`,
        )
        for (const recipe of catalog) {
          process.stdout.write(`\n${recipe.name} — ${recipe.summary}\n`)
          process.stdout.write(`  ${recipe.source} · sha256 ${recipe.hash.slice(0, 12)}\n`)
          for (const param of recipe.params) {
            const notes = [
              param.values ? param.values.join(' | ') : '',
              param.min !== undefined ? `min ${param.min}` : '',
              param.max !== undefined ? `max ${param.max}` : '',
            ]
              .filter((note) => note !== '')
              .join(', ')
            process.stdout.write(
              `  --param ${param.name}=${String(param.default)}${notes === '' ? '' : `   (${notes})`}\n`,
            )
          }
        }
      })
    }

    case 'run': {
      const recipeName = args[0]
      if (!recipeName) die('missing recipe name', EXIT_INVALID, 'run `bench recipes` to see what exists')
      const workspace = await openWorkspace(values.project)
      const params = parseParams(values.param)

      // Everything from here — the spec, the band note, the artifact, the recorded event — is the
      // same code `bench rerun` runs. See ADR 0003.
      let outcome: AnalysisOutcome
      try {
        outcome = await withRunner(APP_ROOT, (runner) =>
          workspace.recordAnalysis(runner, {
            recipe: recipeName,
            params,
            ...(values.dataset === undefined ? {} : { dataset: values.dataset }),
            ...(values.chart === undefined ? {} : { chartPath: values.chart }),
          }),
        )
      } catch (error) {
        fail(error)
      }
      await workspace.writeStateBrief()

      const result = outcome.result
      const coefficients = Array.isArray(result.data.coefficients)
        ? (result.data.coefficients as Record<string, unknown>[])
        : []

      if (asJson) {
        process.stdout.write(
          JSON.stringify(
            {
              ok: true,
              data: {
                id: outcome.event.id,
                verdict: result.verdict,
                narrative: result.narrative,
                artifact: outcome.artifactRef,
                diagnostics: result.diagnostics,
                coefficients,
              },
              warnings: result.warnings,
            },
            null,
            2,
          ) + '\n',
        )
        return
      }

      for (const warning of result.warnings) process.stderr.write(`  warning: ${warning}\n`)
      process.stdout.write(`${result.verdict.toUpperCase()}  ${result.narrative}\n`)
      for (const coefficient of coefficients) {
        process.stdout.write(
          `  ${String(coefficient.name).padEnd(10)} ${shortNumber(coefficient.estimate)}` +
            `  [${shortNumber(coefficient.low)}, ${shortNumber(coefficient.high)}]\n`,
        )
      }
      process.stdout.write(
        `wrote ${values.chart ? resolve(values.chart) : join(workspace.dir, outcome.artifactRef)}\n`,
      )
      return
    }

    case 'correct':
    case 'retract': {
      const id = args[0]
      if (!id) die('missing point id', EXIT_INVALID, 'run `bench list --json` to see ids')
      const workspace = await openWorkspace(values.project)

      if (command === 'retract') {
        let retracted: PointRetraction
        try {
          retracted = await workspace.retractPoint(id, values.reason)
        } catch (error) {
          fail(error)
        }
        await workspace.writeStateBrief()
        if (asJson) {
          process.stdout.write(
            JSON.stringify(
              { ok: true, data: { event: retracted.event.id, retracted: id, active: retracted.active } },
              null,
              2,
            ) + '\n',
          )
        } else {
          process.stdout.write(`retracted ${id}  (${retracted.active} active in ${retracted.dataset})\n`)
        }
        return
      }

      const patch = collectValues(values)
      let corrected: PointCorrection
      try {
        corrected = await workspace.correctPoint(id, patch, values.reason)
      } catch (error) {
        fail(error)
      }
      await workspace.writeStateBrief()

      const summary = Object.entries(patch)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(' ')
      if (asJson) {
        process.stdout.write(
          JSON.stringify(
            {
              ok: true,
              data: { event: corrected.event.id, point: id, values: patch, now: corrected.now },
            },
            null,
            2,
          ) + '\n',
        )
      } else {
        process.stdout.write(`corrected ${id}  ${summary}  (original record preserved)\n`)
      }
      return
    }

    case 'decide': {
      const text = args.join(' ').trim()
      if (!text) die('nothing to record', EXIT_INVALID, 'bench decide "we are using Python for analysis"')
      const workspace = await openWorkspace(values.project)
      const event = await workspace.recordDecision(
        text,
        values.tag === undefined ? undefined : values.tag,
      )
      await workspace.writeStateBrief()
      if (asJson) {
        process.stdout.write(JSON.stringify({ ok: true, data: { id: event.id, text } }, null, 2) + '\n')
      } else {
        process.stdout.write(`recorded decision ${event.id}\n`)
      }
      return
    }

    case 'view': {
      const [sub, viewName] = args
      if (!sub) {
        die('missing a view subcommand', EXIT_INVALID, 'bench view list | show | new | add | save | render')
      }

      if (sub === 'list') {
        const workspace = await openWorkspace(values.project)
        const { views, problems } = await listViews(workspace.dir)
        for (const problem of problems) process.stderr.write(`  warning: ${problem}\n`)
        if (asJson) {
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
          process.stdout.write('no views yet\n  next: bench view new drift --dataset main --recipe drift\n')
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
        if (!viewName) die(`missing a view name`, EXIT_INVALID, `bench view ${sub} <name>`)
        const workspace = await openWorkspace(values.project)

        let view: ViewFile
        try {
          view = await loadView(workspace.dir, viewName)
        } catch (error) {
          fail(error)
        }

        let statuses = await panelStatuses(workspace, view)

        if (sub === 'show') {
          if (asJson) {
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
        if (values.refresh === true && statuses.some((status) => status.state !== 'current')) {
          for (const status of statuses) {
            if (status.state === 'current') continue
            const panel = view.panels[status.index]!
            view.panels[status.index] = await materializeOne(workspace, {
              dataset: panel.dataset,
              ...(panel.recipe === undefined ? {} : { recipe: panel.recipe }),
              ...(panel.params === undefined ? {} : { params: panel.params }),
              ...(panel.query === undefined ? {} : { query: panel.query }),
              ...(panel.title === undefined ? {} : { title: panel.title }),
            })
          }
          try {
            await saveView(workspace.dir, view)
          } catch (error) {
            fail(error)
          }
          statuses = await panelStatuses(workspace, view)
        }

        const out = values.out
          ? resolve(values.out)
          : join(workspace.dir, 'artifacts', `view-${slugFor(view.name)}.svg`)
        await mkdir(dirname(out), { recursive: true })
        await writeFile(out, renderView(view))

        if (asJson) {
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
        if (!viewName) die('missing a view name', EXIT_INVALID, `bench view ${sub} <name> --dataset main`)
        const workspace = await openWorkspace(values.project)

        let view: ViewFile
        if (sub === 'new') {
          try {
            await requireFreeName(workspace.dir, viewName, values.force === true)
          } catch (error) {
            fail(error)
          }
          view = { v: 1, name: viewName, layout: { columns: columnCount(values.columns) }, panels: [] }
        } else {
          try {
            view = await loadView(workspace.dir, viewName)
          } catch (error) {
            fail(error)
          }
        }

        const panel = await materializeOne(workspace, panelRequestFrom(values))
        view.panels.push(panel)
        try {
          await saveView(workspace.dir, view)
        } catch (error) {
          fail(error)
        }

        const status = describePanel(panel, { state: 'current' })
        if (asJson) {
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
        const file = values.file
        if (file === undefined) {
          die('missing a file to save', EXIT_INVALID, `bench view save --file view.json (or - for stdin)`)
        }

        let text: string
        if (file === '-') {
          text = await readStream(process.stdin)
        } else {
          try {
            text = await readFile(resolve(file), 'utf8')
          } catch {
            die(`cannot read ${file}`, EXIT_MISSING)
          }
        }

        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        } catch {
          die(`${file} is not valid JSON`, EXIT_INVALID)
        }

        let view: ViewFile
        try {
          view = validateView(parsed)
        } catch (error) {
          fail(error)
        }
        if (viewName !== undefined && slugFor(viewName) !== slugFor(view.name)) {
          die(
            `the file is named "${view.name}", but the command asked for "${viewName}"`,
            EXIT_INVALID,
            'rename the view in the file, or the file on disk',
          )
        }

        const workspace = await openWorkspace(values.project)
        try {
          await saveView(workspace.dir, view)
        } catch (error) {
          fail(error)
        }
        if (asJson) {
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

      die(`unknown view subcommand "${sub}"`, EXIT_INVALID, 'bench view list | show | new | add | save | render')
    }

    default:
      die(`unknown command "${command}"`, EXIT_INVALID, 'run bench help')
  }
}

// Every refusal reaches the user through the same door, so the exit code always matches the kind.
main().catch(fail)
