#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { APP_ROOT, freshnessNote } from '../core/analysis.ts'
import {
  BenchError,
  Workspace,
  type AnalysisOutcome,
  type ErrorKind,
  type PointCorrection,
  type PointRestoration,
  type PointRetraction,
  type RecordedPoint,
  type VersionRestore,
} from '../core/workspace.ts'
import type { PointValue } from '../core/events.ts'
import { renderChart } from '../core/chart.ts'
import { addHint } from '../core/hints.ts'
import { validateValues } from '../core/shapes.ts'
import {
  DEFAULT_SHAPE,
  findProjectDir,
  initProject,
  launcherCommand,
  launcherProjectPath,
} from '../core/project.ts'
import {
  listProjects,
  rememberProject,
  resolveProjectName,
  type KnownProject,
} from '../core/registry.ts'
import { plotDataset } from '../core/panels.ts'
import { renderState } from '../core/state.ts'
import { diffCounts, diffRows } from '../core/versions.ts'
import { runShapeCommand } from './shape.ts'
import { runImportCommand } from './import.ts'
import { runViewCommand } from './view.ts'
import { printDiffDetails, shortNumber } from './diff-output.ts'
import { parseParams } from './params.ts'
import { withRunner } from './runner.ts'

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
  'x-field': { type: 'string' },
  'y-field': { type: 'string' },
  recipe: { type: 'string' },
  title: { type: 'string' },
  query: { type: 'string' },
  columns: { type: 'string' },
  shape: { type: 'string' },
  field: { type: 'string' },
  'time-field': { type: 'string' },
  type: { type: 'string' },
  unit: { type: 'string' },
  optional: { type: 'boolean' },
  file: { type: 'string' },
  scan: { type: 'string' },
  refresh: { type: 'boolean' },
  format: { type: 'string' },
  map: { type: 'string', multiple: true },
  time: { type: 'string' },
  'estimate-time': { type: 'boolean' },
  'ignore-unmapped': { type: 'string', multiple: true },
  force: { type: 'boolean' },
  empty: { type: 'boolean' },
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
  bench add --values '{...}' [options]   record a point
  bench shape extend <id> --field <name> --type <type>
                                        append a field as the shape's next version
  bench shape designate <id> --time-field <name>
                                        make one instant field the observation time
  bench  correct <id> [--values '{"y":3}'] [--at <iso>]
                                        supersede a point (never overwrites)
  bench retract <id> [--reason text]    withdraw a point from analysis
  bench restore <id>                    bring a withdrawn point back, as the same record
  bench list [--dataset id] [--json]    list active points
  bench state [--json]                  regenerate and print STATE.md
  bench check [--json]                  validate the log and shapes
  bench chart [--x-field a] [--y-field b] [--out file.svg]
                                        render the dataset to an SVG artifact
  bench dataset list                    datasets, with the version each is at
  bench dataset versions <id>           every version of a dataset, and what it replaced
  bench dataset diff <id> [v1] [v2]     row-level diff between two versions
  bench dataset restore <id> <version>  make an older version current again, as a new version
  bench dataset restore <id> --empty    restore the empty dataset before version 1
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
  bench view rm <name>                  close a view: its file waits in views/.trash/
  bench view rename <name> <new name>   the same view under another name
  bench view duplicate <name> <new name>  copy a view, panels and all

Options for add
  --values '{"x":1,"y":2}'   explicit field values
  --at <iso time>            when the value was observed; must match a shape's designated
                             time field, and is stored as canonical UTC
  --note <text>              context attached to the point
  --reason <text>            why a point was corrected or retracted
  --tag <tag>                repeatable
  --dataset <id>             defaults to main
  --param <name=value>       recipe parameter, repeatable (numbers and booleans inferred)
  --chart <path>             where to write the rendered artifact

Options for correct
  --values '{"y":3}'          field values to supersede; can be left out when only the
                             observation time changes
  --at <iso time>            a measured instant, replacing a time an import estimated; must
                             agree with a shape's designated time field when it has one

Options for view new / add
  --dataset <id>             which dataset the panel reads
  --recipe <name>            make the panel an analysis, not just a plot
  --param <name=value>       recipe parameter, repeatable
  --query '{"where":[…]}'    select rows: field/op/value clauses, all must hold
  --title <text>             panel heading
  --columns <1-4>            grid columns for the tab (view new only)

Options for chart / view plot panels
  --x-field <field>          horizontal field; a number or instant (default x)
  --y-field <field>          vertical field; a number (default y)

Options for shape extend
  --field <name>            the field to append, e.g. b2b
  --type <type>             required: number, integer, string, instant, or boolean
  --unit <unit>             optional physical unit, e.g. C or s
  --optional                the field may be absent on a point

Options for shape designate
  --time-field <name>       a required instant field; add, correct and import derive
                            t_observed from it and refuse a value that disagrees

Options for init
  --shape <file>            declare the point shape from a JSON file instead of xy.v1

Options for import
  --map <field=column>       map a shape field to a column with a different name, repeatable
  --time <column>            read the observation time from a column (a row is its instant; a
                             file whose clock the importer cannot find is refused, not stamped)
  --estimate-time            the file has no clock: use its row order, and mark every row's time
                             estimated so it reads as an estimate and can be corrected later
  --format csv|tsv|jsonl     override detection from the file extension
  --ignore-unmapped <column>  leave out an undeclared column, repeatable; required for every
                             column the shape has no field for
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
  const target = await locateProject(explicit)
  let workspace: Workspace
  try {
    workspace = await Workspace.open(target)
  } catch (error) {
    // A project records the folder it had when its launcher line was written, so a moved folder
    // arrives here under the old path. Name the path that was tried and the one step that repairs
    // the file; the refusal itself is unchanged, and a path that is not a project still fails.
    if (
      error instanceof BenchError &&
      error.message === 'not inside a bench project' &&
      explicit !== undefined
    ) {
      fail(
        new BenchError('missing', `not inside a bench project: ${target}`, {
          hint:
            `if this project moved, run ${launcherCommand()} with --project set to the folder's ` +
            'current path and run state; that rewrites the line in its AGENTS.md',
        }),
      )
    }
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
          const declared = handle.shape ?? DEFAULT_SHAPE
          const fields = declared.fields.map((field) => field.name).join(', ')
          process.stdout.write(`created project "${handle.config.name}" at ${handle.dir}\n`)
          process.stdout.write(
            `  shape ${shape ? 'declared from ' + values.shape + ' · ' : ''}${declared.id} (${fields}) · dataset main\n`,
          )
          // The next command names the launcher this process was started from: a packaged user has
          // no `bench` on PATH, and a hint that cannot run is worse than none. The values come from
          // the shape that was just declared, so a custom shape is not taught `--x`/`--y`.
          process.stdout.write(
            `  next: ${launcherCommand()} --project "${launcherProjectPath(handle.dir)}" ${addHint(declared)}\n`,
          )
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

    case 'shape': {
      await runShapeCommand(args, values, {
        json: asJson,
        open: openWorkspace,
        die,
        fail,
      })
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

      // The values that were written, not the ones passed: a designated time field is canonicalised,
      // and printing the raw input would describe a log entry that does not exist.
      const stored = recorded.event.type === 'point_recorded' ? recorded.event.values : pointValues
      const summary = Object.entries(stored)
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
                // The version the event names, not the dataset's current one guessed afterwards:
                // a reader of this JSON should be able to say which rows the point joined.
                version: recorded.event.type === 'point_recorded' ? (recorded.event.version ?? 1) : 1,
                values: stored,
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
                ...(point.tEstimated === true ? { t_estimated: true } : {}),
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
        // A time the file only implied is said so, where the time is said: `bench list` is how a
        // person or an agent reads a row back, and an estimate must not read as an observation.
        const estimated = point.tEstimated === true ? ' (estimated)' : ''
        process.stdout.write(`  ${point.tObserved}${estimated}  ${fields}${note}\n`)
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
        // and check reports on the dataset as it stands, not on every entry ever made. Each point is
        // read against the declaration it was recorded with, so a later extension cannot make an
        // older row fail for a field that did not exist when it was measured.
        for (const point of dataset.points) {
          if (point.status === 'retracted') {
            retracted += 1
            continue
          }
          const recordedShape = state.shapes.get(point.shape)
          if (!recordedShape) {
            errors.push(`${dataset.id}/${point.id}: references unknown shape "${point.shape}"`)
            continue
          }
          const validation = validateValues(recordedShape, point.values)
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

    case 'dataset': {
      const sub = args[0] ?? 'list'
      const workspace = await openWorkspace(values.project)
      const datasets = [...workspace.state.datasets.values()]

      const rowsNow = (datasetId: string, version: number): number =>
        workspace.rowsOfVersion(datasetId, version).length

      if (sub === 'list') {
        if (asJson) {
          process.stdout.write(
            JSON.stringify(
              {
                ok: true,
                data: datasets.map((dataset) => ({
                  id: dataset.id,
                  shape: dataset.shape,
                  version: dataset.version,
                  active: dataset.points.filter((point) => point.status === 'active').length,
                  recorded: dataset.points.length,
                  versions: dataset.versions.map((record) => record.version),
                })),
              },
              null,
              2,
            ) + '\n',
          )
          return
        }
        if (datasets.length === 0) {
          process.stdout.write('no datasets yet\n')
          return
        }
        for (const dataset of datasets) {
          const active = dataset.points.filter((point) => point.status === 'active').length
          const first = dataset.points[0]?.tObserved.slice(0, 10) ?? '—'
          const last = dataset.points.at(-1)?.tObserved.slice(0, 10) ?? '—'
          process.stdout.write(
            `${dataset.id}  v${dataset.version}  ${dataset.shape}  ${active} active / ${dataset.points.length} recorded  ${first} … ${last}\n`,
          )
        }
        return
      }

      if (sub === 'versions') {
        let datasetId: string
        try {
          datasetId = workspace.resolveDataset(args[1] ?? values.dataset)
        } catch (error) {
          fail(error)
        }
        const records = workspace.versions(datasetId)
        if (records.length === 0) {
          process.stdout.write(`dataset "${datasetId}" has no versions yet\n`)
          process.stdout.write('  the first `bench import` creates version 1\n')
          return
        }
        if (asJson) {
          process.stdout.write(
            JSON.stringify(
              {
                ok: true,
                data: {
                  dataset: datasetId,
                  current: workspace.currentVersion(datasetId),
                  versions: records.map((record) => ({ ...record, rowsNow: rowsNow(datasetId, record.version) })),
                },
              },
              null,
              2,
            ) + '\n',
          )
          return
        }
        process.stdout.write(
          `${datasetId} · ${records.length} version(s) · newest v${workspace.currentVersion(datasetId)}\n`,
        )
        for (const record of records) {
          const how = record.recorded ? record.source : 'inferred: rows recorded before versions were'
          const diff = record.diff ? `  ${diffCounts(record.diff)}` : '  first version'
          process.stdout.write(
            `  v${record.version}  ${rowsNow(datasetId, record.version)} row(s) now · ${record.rows} at creation${diff}  ${record.at.slice(0, 10)}  ${how}\n`,
          )
        }
        return
      }

      if (sub === 'diff') {
        let datasetId: string
        try {
          datasetId = workspace.resolveDataset(args[1] ?? values.dataset)
        } catch (error) {
          fail(error)
        }
        const records = workspace.versions(datasetId)
        if (records.length === 0) {
          die(`dataset "${datasetId}" has no versions to compare`, EXIT_MISSING, 'bench import creates version 1')
        }
        const newest = workspace.currentVersion(datasetId)
        const known = records.map((record) => record.version)
        const readVersion = (raw: string | undefined, fallback: number, what: string): number => {
          if (raw === undefined) return fallback
          const value = Number(raw)
          if (!Number.isInteger(value) || value < 1) die(`${what} must be a version number, got "${raw}"`)
          if (!known.includes(value)) {
            die(`dataset "${datasetId}" has no version ${value}`, EXIT_MISSING, `versions: ${known.join(', ')}`)
          }
          return value
        }
        const right = readVersion(args[3], newest, 'the second version')
        const left = readVersion(args[2], right - 1, 'the first version')
        if (left >= right) die(`version ${left} is not older than ${right}`, EXIT_INVALID, 'give the older version first')
        if (!known.includes(left) || !known.includes(right)) {
          die(`both versions must exist in "${datasetId}"`, EXIT_MISSING, `versions: ${known.join(', ')}`)
        }

        // Recomputed from the two versions' rows rather than read out of the log: the recorded
        // counts are what a writer claimed, and a diff command that only repeats them cannot catch a
        // writer that claimed wrong. Any disagreement is reported instead of hidden.
        const shape = workspace.shapeOf(datasetId)
        // A time an import estimated reads as one here too: this is the command a person runs to
        // see what a re-export did, and an estimate printed as a measurement is the defect.
        const parentRows = workspace.rowsOfVersion(datasetId, left).map((point) => ({
          id: point.id,
          t: point.tObserved,
          values: point.values,
          ...(point.tEstimated === true ? { estimated: true as const } : {}),
        }))
        const childRows = workspace.rowsOfVersion(datasetId, right).map((point) => ({
          t: point.tObserved,
          values: point.values,
          ...(point.tEstimated === true ? { estimated: true as const } : {}),
        }))
        const diff = diffRows(parentRows, childRows, shape.fields.map((field) => field.name))
        const record = records.find((candidate) => candidate.version === right)
        const claimed = record?.diff

        if (asJson) {
          process.stdout.write(
            JSON.stringify(
              {
                ok: true,
                data: {
                  dataset: datasetId,
                  from: left,
                  to: right,
                  counts: { added: diff.added, removed: diff.removed, changed: diff.changed },
                  recorded: claimed ?? null,
                  added: diff.addedRows.map((row) => ({
                    t: row.t,
                    values: row.values,
                    ...(row.estimated === true ? { t_estimated: true } : {}),
                  })),
                  changed: diff.changedRows.map((row) => ({
                    id: row.id,
                    t: row.t,
                    before: row.before,
                    after: row.after,
                    ...(row.estimated === true ? { t_estimated: true } : {}),
                  })),
                  removed: diff.removedRows.map((row) => ({
                    id: row.id,
                    t: row.t,
                    values: row.values,
                    ...(row.estimated === true ? { t_estimated: true } : {}),
                  })),
                },
              },
              null,
              2,
            ) + '\n',
          )
          return
        }

        process.stdout.write(
          `${datasetId}: version ${left} → ${right}  ${diffCounts(diff)}  (${childRows.length} row(s) in v${right})\n`,
        )
        if (claimed && (claimed.added !== diff.added || claimed.removed !== diff.removed || claimed.changed !== diff.changed)) {
          process.stdout.write(
            `  warning: version ${right} recorded ${diffCounts(claimed)} when it was written\n`,
          )
        }
        printDiffDetails(diff, 10)
        return
      }

      if (sub === 'restore') {
        let datasetId: string
        try {
          datasetId = workspace.resolveDataset(args[1] ?? values.dataset)
        } catch (error) {
          fail(error)
        }
        const empty = values.empty === true
        let version: number | null = null
        if (!empty) {
          const raw = args[2]
          if (raw === undefined) {
            die('missing version number', EXIT_INVALID, `bench dataset versions ${datasetId}`)
          }
          const parsed = Number(raw)
          if (!Number.isInteger(parsed) || parsed < 1) {
            die(`version must be a number, got "${raw}"`, EXIT_INVALID, 'versions start at 1')
          }
          version = parsed
        }
        let restored: VersionRestore
        try {
          restored = await workspace.restoreVersion(datasetId, version)
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
                  dataset: datasetId,
                  version: restored.version,
                  parent: restored.parent,
                  restoredFrom: restored.restoredFrom,
                  rows: restored.rows,
                  diff: restored.diff,
                  active: restored.active,
                },
              },
              null,
              2,
            ) + '\n',
          )
          return
        }
        process.stdout.write(
          `restored ${version === null ? 'the empty dataset' : `version ${version}`} as version ${restored.version}` +
            `  ${diffCounts(restored.diff)}  (${restored.rows} row(s); replaced version ${restored.parent})\n`,
        )
        return
      }

      die(`unknown dataset subcommand "${sub}"`, EXIT_INVALID, 'use list, versions, diff, or restore')
    }

    case 'chart': {
      const workspace = await openWorkspace(values.project)
      const datasetId = workspace.resolveDataset(values.dataset)
      // The same unmodelled spec a panel without a recipe uses: one implementation of "plot what is
      // there, and say that nothing was modelled".
      let plotted: ReturnType<typeof plotDataset>
      try {
        // The artifact names the version it drew, so a file on someone's desk answers "which rows".
        plotted = plotDataset(workspace, datasetId, undefined, undefined, workspace.currentVersion(datasetId), {
          ...(values['x-field'] === undefined ? {} : { x: values['x-field'] }),
          ...(values['y-field'] === undefined ? {} : { y: values['y-field'] }),
        })
      } catch (error) {
        fail(error)
      }

      // No rows is still a drawing: the spec carries the empty sentence, so an agent can ask for the
      // chart of a fresh project and get an artifact that says what to add rather than a bare refusal.
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
      await runImportCommand(args, values, {
        json: asJson,
        open: openWorkspace,
        die,
        fail,
      })
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
                version: run.version ?? null,
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
        const judged = freshness.get(run.id)
        const note = freshnessNote(judged)
        process.stdout.write(
          `${run.at}  ${run.recipe}  ${run.verdict}  ${note}\n`,
        )
        const pinned = run.version === undefined ? '' : ` v${run.version}`
        process.stdout.write(
          `  ${run.dataset ?? 'unknown dataset'}${pinned} · ${JSON.stringify(run.params ?? {})}\n`,
        )
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
      const params = { ...(previous.params ?? {}), ...parseParams(values.param, die) }

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
      const params = parseParams(values.param, die)

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
        // `--at` moves the canonical time of a row whose shape designates no field — the door an
        // estimated import needs. A designated shape keeps its own rule and refuses a clash.
        corrected = await workspace.correctPoint(
          id,
          patch,
          values.reason,
          values.at === undefined ? {} : { tObserved: values.at },
        )
      } catch (error) {
        fail(error)
      }
      await workspace.writeStateBrief()

      // As with `add`, report the event's values: a designated field is canonicalised, and the raw
      // argument would name text the log does not contain.
      const summary = Object.entries(corrected.values)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(' ')
      if (asJson) {
        process.stdout.write(
          JSON.stringify(
            {
              ok: true,
              data: {
                event: corrected.event.id,
                point: id,
                values: corrected.values,
                now: corrected.now,
                ...(corrected.tObserved === undefined ? {} : { t_observed: corrected.tObserved }),
                ...(corrected.estimated ? { t_estimated: true } : {}),
              },
            },
            null,
            2,
          ) + '\n',
        )
      } else {
        // A correction can be the time alone, so the values are one part of the line, not the line.
        const parts = [
          summary,
          corrected.tObserved === undefined ? '' : `at ${corrected.tObserved}`,
        ].filter((part) => part !== '')
        process.stdout.write(
          `corrected ${id}  ${parts.join('  ')}  (original record preserved)\n`,
        )
      }
      return
    }

    case 'restore': {
      const id = args[0]
      if (!id) die('missing point id', EXIT_INVALID, 'run `bench list --json` to see ids')
      const workspace = await openWorkspace(values.project)
      let restored: PointRestoration
      try {
        restored = await workspace.restorePoint(id)
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
                event: restored.event.id,
                restored: id,
                reverses: restored.retraction,
                active: restored.active,
              },
            },
            null,
            2,
          ) + '\n',
        )
      } else {
        process.stdout.write(`restored ${id}  (${restored.active} active in ${restored.dataset})\n`)
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
      await runViewCommand(args, values, {
        json: asJson,
        open: openWorkspace,
        die,
        fail,
      })
      return
    }

    default:
      die(`unknown command "${command}"`, EXIT_INVALID, 'run bench help')
  }
}

// Every refusal reaches the user through the same door, so the exit code always matches the kind.
main().catch(fail)
