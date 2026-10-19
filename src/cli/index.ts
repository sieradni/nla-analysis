#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { activePoints, bind, numericValue } from '../core/binder.ts'
import type { DatasetState, Point, ProjectState } from '../core/binder.ts'
import { makeEvent } from '../core/events.ts'
import type { PointValue } from '../core/events.ts'
import { renderChart } from '../core/chart.ts'
import type { ChartSpec } from '../core/chart.ts'
import { validateValues } from '../core/shapes.ts'
import {
  DEFAULT_DATASET,
  findProjectDir,
  initProject,
  openProject,
  refreshState,
} from '../core/project.ts'
import type { ProjectHandle } from '../core/project.ts'
import { RecipeRunner } from '../core/runner.ts'
import type { RecipeSchema, RunInput } from '../core/runner.ts'
import { renderState } from '../core/state.ts'

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
  bench add --x 1 --y 2 [options]       record a point
  bench correct <id> --values '{"y":3}'  supersede a point (never overwrites)
  bench retract <id> [--reason text]    withdraw a point from analysis
  bench list [--dataset id] [--json]    list active points
  bench state [--json]                  regenerate and print STATE.md
  bench check [--json]                  validate the log and shapes
  bench chart [--out file.svg]          render the dataset to an SVG artifact
  bench recipes [--json]                list analysis recipes and their parameters
  bench run <recipe> [--param k=v]      run an analysis, record it, and chart the result
  bench decide "<text>"                 record a decision the next session inherits

Options for add
  --values '{"x":1,"y":2}'   explicit field values
  --at <iso time>            when the value was observed; stored as canonical UTC
  --note <text>              context attached to the point
  --reason <text>            why a point was corrected or retracted
  --tag <tag>                repeatable
  --dataset <id>             defaults to main
  --param <name=value>       recipe parameter, repeatable (numbers and booleans inferred)
  --chart <path>             where to write the rendered artifact

Global
  --project <dir>   operate on a project other than the enclosing one
  --json            machine-readable output
  -h, --help        this text

Exit codes
  0 ok   1 invalid input   2 not found   3 invariant would break
`)
}

async function locate(explicit?: string): Promise<ProjectHandle> {
  const dir = explicit ? resolve(explicit) : await findProjectDir(process.cwd())
  if (!dir) die('not inside a bench project', EXIT_MISSING, 'run `bench init <dir>` first')
  return openProject(dir)
}

function loadState(handle: ProjectHandle): Promise<ProjectState> {
  return handle.log.read().then((read) => bind(read.events))
}

function pickDataset(state: ProjectState, requested?: string): string {
  if (requested) return requested
  if (state.datasets.has(DEFAULT_DATASET)) return DEFAULT_DATASET
  const only = [...state.datasets.keys()]
  if (only.length === 1) return only[0]!
  if (only.length === 0) die('project has no datasets', EXIT_MISSING, 'run `bench init` in a new folder')
  die('project has several datasets', EXIT_INVALID, 'pass --dataset <id>')
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

function findPoint(state: ProjectState, id: string): { dataset: DatasetState; point: Point } | undefined {
  for (const dataset of state.datasets.values()) {
    const point = dataset.points.find((candidate) => candidate.id === id)
    if (point) return { dataset, point }
  }
  return undefined
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

/** Content hash of the exact inputs an analysis was computed from. */
function hashInput(input: RunInput): string {
  const canonical = JSON.stringify({
    dataset: input.dataset,
    shape: input.shape,
    points: input.points.map((point) => [point.id, point.t, point.values]),
  })
  return createHash('sha256').update(canonical).digest('hex')
}

/** Build the analysis input from the active set only: retracted points are not evidence. */
function buildRunInput(state: ProjectState, datasetId: string): RunInput {
  const dataset = state.datasets.get(datasetId)
  if (!dataset) die(`no dataset "${datasetId}"`, EXIT_MISSING)
  const shape = state.shapes.get(dataset.shape)
  return {
    dataset: datasetId,
    shape: dataset.shape,
    fields: (shape?.fields ?? []).map((field) => ({
      name: field.name,
      type: field.type,
      ...(field.unit === undefined ? {} : { unit: field.unit }),
    })),
    points: activePoints(state, datasetId).map((point) => ({
      id: point.id,
      t: point.tObserved,
      values: point.values,
    })),
  }
}

async function withRunner<T>(root: string, use: (runner: RecipeRunner) => Promise<T>): Promise<T> {
  const runner = new RecipeRunner(root)
  try {
    await runner.start()
    return await use(runner)
  } catch (error) {
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
      try {
        const handle = await initProject(target, values.name)
        if (asJson) {
          process.stdout.write(
            JSON.stringify({ ok: true, data: { dir: handle.dir, name: handle.config.name } }, null, 2) + '\n',
          )
        } else {
          process.stdout.write(`created project "${handle.config.name}" at ${handle.dir}\n`)
          process.stdout.write(`  shape xy.v1 (x, y) · dataset main\n`)
          process.stdout.write(`  next: bench add --x 1.2 --y 3.4\n`)
        }
      } catch (error) {
        die((error as Error).message, EXIT_INVARIANT)
      }
      return
    }

    case 'add': {
      const handle = await locate(values.project)
      const state = await loadState(handle)
      const datasetId = pickDataset(state, values.dataset)
      const dataset = state.datasets.get(datasetId)
      if (!dataset) die(`no dataset "${datasetId}"`, EXIT_MISSING)
      const shape = state.shapes.get(dataset.shape)
      if (!shape) die(`dataset "${datasetId}" references unknown shape "${dataset.shape}"`, EXIT_INVARIANT)

      const pointValues = collectValues(values)
      if (Object.keys(pointValues).length === 0) {
        die('nothing to record', EXIT_INVALID, `pass --x and --y, or --values '{"x":1,"y":2}'`)
      }

      // Normalise to canonical UTC with milliseconds, so that sorting timestamps as strings and
      // sorting them by instant give the same answer. Offsets and shortened forms are accepted on
      // input; only the canonical form is ever stored.
      const observedInput = values.at ?? new Date().toISOString()
      const observedMs = Date.parse(observedInput)
      if (Number.isNaN(observedMs)) {
        die(`--at is not a parseable time: "${observedInput}"`, EXIT_INVALID, 'use an ISO timestamp')
      }
      const observed = new Date(observedMs).toISOString()

      const validation = validateValues(shape, pointValues)
      if (validation.errors.length > 0) {
        for (const problem of validation.errors) process.stderr.write(`  error: ${problem}\n`)
        die('point rejected', EXIT_INVALID)
      }

      const event = makeEvent('point_recorded', handle.session, {
        dataset: datasetId,
        shape: dataset.shape,
        values: pointValues,
        t_observed: observed,
        ...(values.note === undefined ? {} : { note: values.note }),
        ...(values.tag === undefined ? {} : { tags: values.tag }),
      })
      await handle.log.append(event)
      const after = await refreshState(handle)

      const summary = Object.entries(pointValues)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(' ')
      if (asJson) {
        process.stdout.write(
          JSON.stringify(
            {
              ok: true,
              data: { id: event.id, dataset: datasetId, values: pointValues, t_observed: observed },
              warnings: validation.warnings,
            },
            null,
            2,
          ) + '\n',
        )
      } else {
        for (const warning of validation.warnings) process.stderr.write(`  warning: ${warning}\n`)
        const count = activePoints(after, datasetId).length
        process.stdout.write(`recorded ${event.id}  ${summary}  at ${observed}  (${count} active in ${datasetId})\n`)
      }
      return
    }

    case 'list': {
      const handle = await locate(values.project)
      const state = await loadState(handle)
      const datasetId = pickDataset(state, values.dataset)
      const points = activePoints(state, datasetId)

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
      const handle = await locate(values.project)
      const state = await refreshState(handle)
      if (asJson) {
        process.stdout.write(
          JSON.stringify(
            {
              ok: true,
              data: {
                name: handle.config.name,
                dir: handle.dir,
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
      process.stdout.write(renderState(handle.config, state))
      return
    }

    case 'check': {
      const handle = await locate(values.project)
      const { events, problems } = await handle.log.read()
      const state = bind(events)
      const errors: string[] = [...problems, ...state.problems]
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
      const handle = await locate(values.project)
      const state = await loadState(handle)
      const datasetId = pickDataset(state, values.dataset)
      const points = activePoints(state, datasetId)
      const plotted = points
        .map((point) => ({ x: numericValue(point, 'x'), y: numericValue(point, 'y') }))
        .filter((pair): pair is { x: number; y: number } => pair.x !== undefined && pair.y !== undefined)

      if (plotted.length === 0) {
        die(`dataset "${datasetId}" has no points with numeric x and y`, EXIT_MISSING, 'bench add --x 1 --y 2')
      }

      const skipped = points.length - plotted.length
      const footerParts = [`n = ${plotted.length}`]
      if (skipped > 0) footerParts.push(`${skipped} point(s) without x/y not plotted`)
      footerParts.push('no fit — unmodelled')

      const spec: ChartSpec = {
        title: handle.config.name,
        subtitle: `${datasetId} · ${state.shapes.get(state.datasets.get(datasetId)!.shape)?.id ?? 'unknown shape'}`,
        x: { label: 'x' },
        y: { label: 'y' },
        points: plotted,
        footer: footerParts.join(' · '),
      }

      const out = values.out ? resolve(values.out) : join(handle.dir, 'artifacts', `${datasetId}.svg`)
      await mkdir(join(handle.dir, 'artifacts'), { recursive: true })
      await writeFile(out, renderChart(spec))

      if (asJson) {
        process.stdout.write(JSON.stringify({ ok: true, data: { path: out, points: plotted.length } }, null, 2) + '\n')
      } else {
        process.stdout.write(`wrote ${out}  (${plotted.length} points)\n`)
      }
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
      const handle = await locate(values.project)
      const state = await loadState(handle)
      const datasetId = pickDataset(state, values.dataset)
      const input = buildRunInput(state, datasetId)
      if (input.points.length === 0) {
        die(`dataset "${datasetId}" has no active points`, EXIT_MISSING, 'bench add --x 1 --y 2')
      }
      const params = parseParams(values.param)

      const outcome = await withRunner(APP_ROOT, (runner) => runner.run(recipeName, params, input))
      if (!outcome.ok) {
        die(outcome.error.message, EXIT_INVARIANT, outcome.error.hint ?? `code: ${outcome.error.code}`)
      }
      const result = outcome.result

      // Only mention a band when one was actually drawn. A caption promising a band that is not on
      // the canvas is the same class of lie as a curve without an interval.
      const level = Number(result.diagnostics.level)
      const bandKind = typeof result.diagnostics.band === 'string' ? result.diagnostics.band : 'confidence'
      const bandNote =
        result.chart.band !== undefined && Number.isFinite(level)
          ? `${Math.round(level * 100)}% ${bandKind} band`
          : ''
      const footer = [result.chart.footer ?? '', bandNote].filter((part) => part !== '').join(' · ')

      const spec: ChartSpec = {
        ...result.chart,
        title: handle.config.name,
        subtitle: `${datasetId} · ${recipeName}`,
        ...(footer === '' ? {} : { footer }),
        // The artifact carries its own conclusion: the terminal scrollback is not durable. Recipes
        // may supply a shorter form for the canvas; the full argument stays in the log.
        ...((result.caption ?? result.narrative) === ''
          ? {}
          : { caption: result.caption ?? result.narrative }),
      }

      // The log stores a project-relative path: an absolute one would bake this machine's layout -
      // and its user name - into a file meant to outlive the machine.
      const artifactName = `${recipeName}-${datasetId}.svg`
      const out = values.chart ? resolve(values.chart) : join(handle.dir, 'artifacts', artifactName)
      // Forward slashes even on Windows: the log is a portable record, and a backslash in it is a
      // trap for anything that later parses it on another platform.
      const artifactRef = values.chart ?? `artifacts/${artifactName}`
      await mkdir(dirname(out), { recursive: true })
      await writeFile(out, renderChart(spec))

      const event = makeEvent('analysis_run', handle.session, {
        recipe: result.recipe,
        recipe_hash: result.recipeHash,
        params,
        input_hash: hashInput(input),
        verdict: result.verdict,
        narrative: result.narrative,
        artifact: artifactRef,
      })
      await handle.log.append(event)
      await refreshState(handle)

      const coefficients = Array.isArray(result.data.coefficients)
        ? (result.data.coefficients as Record<string, unknown>[])
        : []

      if (asJson) {
        process.stdout.write(
          JSON.stringify(
            {
              ok: true,
              data: {
                id: event.id,
                verdict: result.verdict,
                narrative: result.narrative,
                artifact: artifactRef,
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
      process.stdout.write(`wrote ${out}\n`)
      return
    }

    case 'correct':
    case 'retract': {
      const id = args[0]
      if (!id) die('missing point id', EXIT_INVALID, 'run `bench list --json` to see ids')
      const handle = await locate(values.project)
      const state = await loadState(handle)
      const found = findPoint(state, id)
      if (!found) die(`no point with id "${id}"`, EXIT_MISSING)

      if (command === 'retract') {
        const event = makeEvent('point_retracted', handle.session, {
          dataset: found.dataset.id,
          supersedes: id,
          ...(values.reason === undefined ? {} : { reason: values.reason }),
        })
        await handle.log.append(event)
        const after = await refreshState(handle)
        const remaining = activePoints(after, found.dataset.id).length
        if (asJson) {
          process.stdout.write(
            JSON.stringify({ ok: true, data: { event: event.id, retracted: id, active: remaining } }, null, 2) + '\n',
          )
        } else {
          process.stdout.write(`retracted ${id}  (${remaining} active in ${found.dataset.id})\n`)
        }
        return
      }

      const patch = collectValues(values)
      if (Object.keys(patch).length === 0) {
        die('nothing to correct', EXIT_INVALID, `pass --values '{"y":3.5}'`)
      }

      // Validate the merged result, so a correction cannot leave a point malformed.
      const shape = state.shapes.get(found.dataset.shape)
      if (shape) {
        const validation = validateValues(shape, { ...found.point.values, ...patch })
        if (validation.errors.length > 0) {
          for (const problem of validation.errors) process.stderr.write(`  error: ${problem}\n`)
          die('correction rejected', EXIT_INVALID)
        }
      }

      const event = makeEvent('point_corrected', handle.session, {
        dataset: found.dataset.id,
        supersedes: id,
        values: patch,
        ...(values.reason === undefined ? {} : { reason: values.reason }),
      })
      await handle.log.append(event)
      await refreshState(handle)

      const summary = Object.entries(patch)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(' ')
      if (asJson) {
        process.stdout.write(
          JSON.stringify(
            { ok: true, data: { event: event.id, point: id, values: patch, now: { ...found.point.values, ...patch } } },
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
      const handle = await locate(values.project)
      const event = makeEvent('decision_recorded', handle.session, {
        text,
        ...(values.tag === undefined ? {} : { tags: values.tag }),
      })
      await handle.log.append(event)
      await refreshState(handle)
      if (asJson) {
        process.stdout.write(JSON.stringify({ ok: true, data: { id: event.id, text } }, null, 2) + '\n')
      } else {
        process.stdout.write(`recorded decision ${event.id}\n`)
      }
      return
    }

    default:
      die(`unknown command "${command}"`, EXIT_INVALID, 'run bench help')
  }
}

main().catch((error: unknown) => {
  die(error instanceof Error ? error.message : String(error), EXIT_INVARIANT)
})
