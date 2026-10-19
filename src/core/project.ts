import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { access } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { EventLog, newSession } from './log.ts'
import { makeEvent } from './events.ts'
import type { IsoTime, Shape } from './events.ts'
import { APP_ROOT, assessRuns } from './analysis.ts'
import { bind } from './binder.ts'
import { validateShapeDefinition } from './shapes.ts'
import type { ProjectState } from './binder.ts'
import { renderState } from './state.ts'

export interface ProjectConfig {
  name: string
  created: IsoTime
  version: 1
}

export interface ProjectHandle {
  dir: string
  config: ProjectConfig
  log: EventLog
  session: string
}

export const PROJECT_FILE = 'project.json'
export const EVENTS_FILE = 'data/events.jsonl'
export const DEFAULT_DATASET = 'main'

export const DEFAULT_SHAPE: Shape = {
  id: 'xy.v1',
  version: 1,
  fields: [
    { name: 'x', type: 'number' },
    { name: 'y', type: 'number' },
  ],
}

/**
 * A path as it should be written in a command line. Forward slashes, because a `.cmd` launched by
 * absolute path runs from cmd, PowerShell and Git Bash alike, while a backslash path is not a
 * command a POSIX shell can find. Windows accepts them everywhere; only the spelling is unusual.
 */
function commandPath(path: string): string {
  return path.replaceAll('\\', '/')
}

/**
 * The invocation a later session needs to reach this CLI. The packaged app does not put its CLI on
 * PATH, and its folder can be anywhere on the machine, so the launcher is recorded by the absolute
 * path the running process came from. A checkout records its own `pnpm` script instead. Neither
 * branch names a path written into this source: both come from where the process actually is, so a
 * project created by `bench init` from the artifact points at that artifact, and one created in the
 * repository points at the repository.
 */

function launcherInvocation(): { command: string; note: string } {
  const packaged = [join(dirname(process.execPath), 'bench.cmd'), join(APP_ROOT, 'bench.cmd')].find(
    (candidate) => existsSync(candidate),
  )
  if (packaged) {
    return {
      command: `"${commandPath(packaged)}"`,
      note: [
        '`bench.cmd` sits beside `bench.exe` in the desktop app folder; `bench.exe` opens the window,',
        "and `bench.cmd` runs this CLI through the app's own runtime. It is not on PATH, so call it",
        'exactly like this. If the path is gone, the app folder moved — use the `bench.cmd` in its new',
        'location.',
      ].join('\n'),
    }
  }
  return {
    command: `pnpm -C "${commandPath(APP_ROOT)}" bench`,
    note: [
      `That is the CLI script of the bench checkout at \`${APP_ROOT}\`, and \`pnpm -C\` runs it from`,
      'any folder. If `bench` is on PATH, it is the same CLI.',
    ].join('\n'),
  }
}

function projectAgents(dir: string): string {
  const launcher = launcherInvocation()
  return `# AGENTS.md

This folder is a **bench data project**. The append-only event log is the truth.

## Non-negotiables

1. Never edit \`data/events.jsonl\` by hand. Mutate through the CLI below.
2. Never modify \`data/raw/\`. Imported files are evidence.
3. Never delete a dataset version. Replacing data creates a version with a diff.
4. Never mix observed and derived values. Fitted values stay out of datasets.
5. Never draw a curve without n, degrees of freedom, an interval band, and a verdict.
6. Never extend a shape silently. Register the field so the change is visible.

## Running bench

This project's CLI is the only way to read or mutate it, and it is not on PATH. It records the
launcher that created the project, so the next session does not have to find it:

    ${launcher.command} --project "${commandPath(dir)}" state

${launcher.note}

## After changing anything

Run the \`state\` command the same way and read the result. It is the brief the next session inherits.

## Before concluding anything

Run the \`check\` command the same way. A clean log is not the same as a supported claim.
`
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Walk up from `start` until a project root is found. */
export async function findProjectDir(start: string): Promise<string | null> {
  let current = resolve(start)
  for (;;) {
    if (await exists(join(current, PROJECT_FILE))) return current
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

export async function openProject(dir: string, session = newSession()): Promise<ProjectHandle> {
  const config = JSON.parse(await readFile(join(dir, PROJECT_FILE), 'utf8')) as ProjectConfig
  return {
    dir,
    config,
    log: new EventLog(join(dir, EVENTS_FILE)),
    session,
  }
}

/**
 * The one place STATE.md is written. Freshness is assessed here rather than passed in, so the brief
 * can never claim an analysis is current when the point that invalidated it was just appended.
 */
export async function writeStateBrief(handle: ProjectHandle, state: ProjectState): Promise<void> {
  const freshness = await assessRuns(APP_ROOT, state)
  await writeFile(join(handle.dir, 'STATE.md'), renderState(handle.config, state, { freshness }))
}

/** Read the log, fold it, and write the brief. Used when there is no workspace to keep in step. */
export async function refreshState(handle: ProjectHandle): Promise<ProjectState> {
  const { events } = await handle.log.read()
  const state = bind(events)
  await writeStateBrief(handle, state)
  return state
}

export async function initProject(
  dir: string,
  name?: string,
  session = newSession(),
  shape: unknown = DEFAULT_SHAPE,
): Promise<ProjectHandle> {
  const target = resolve(dir)
  if (await exists(join(target, PROJECT_FILE))) {
    throw new Error(`a project already exists at ${target}`)
  }
  // Validated before anything is written: a shape is declared once and every later point inherits
  // it, so a typo here would be a permanent one (non-negotiable 7 is about extension; this is the
  // same argument one step earlier).
  const declared = validateShapeDefinition(shape)

  for (const sub of ['data/raw', 'shapes', 'views', 'artifacts']) {
    await mkdir(join(target, sub), { recursive: true })
  }

  const config: ProjectConfig = {
    name: name ?? basename(target),
    created: new Date().toISOString(),
    version: 1,
  }
  await writeFile(join(target, PROJECT_FILE), JSON.stringify(config, null, 2) + '\n')
  await writeFile(join(target, 'AGENTS.md'), projectAgents(target))

  const handle: ProjectHandle = {
    dir: target,
    config,
    log: new EventLog(join(target, EVENTS_FILE)),
    session,
  }

  await handle.log.append(makeEvent('project_created', session, { name: config.name }))
  await handle.log.append(makeEvent('shape_defined', session, { shape: declared }))
  await handle.log.append(
    makeEvent('dataset_created', session, { dataset: DEFAULT_DATASET, shape: declared.id }),
  )

  await refreshState(handle)
  return handle
}
