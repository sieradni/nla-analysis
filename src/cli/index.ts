#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
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
import { renderState } from '../core/state.ts'

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
  bench decide "<text>"                 record a decision the next session inherits

Options for add
  --values '{"x":1,"y":2}'   explicit field values
  --at <iso time>            when the value was observed; stored as canonical UTC
  --note <text>              context attached to the point
  --reason <text>            why a point was corrected or retracted
  --tag <tag>                repeatable
  --dataset <id>             defaults to main

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
