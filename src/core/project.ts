import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { access } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { EventLog, newSession } from './log.ts'
import { makeEvent } from './events.ts'
import type { IsoTime, Shape } from './events.ts'
import { APP_ROOT, assessRuns } from './analysis.ts'
import { bind } from './binder.ts'
import { validateShapeDefinition } from './shapes.ts'
import type { ProjectState } from './binder.ts'
import { renderState, shapeSummary } from './state.ts'

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
  /**
   * The shape `init` declared, for callers that need a next-step hint before folding the log. A
   * handle opened later leaves it undefined: the log is the authority, and `bind` has the answer.
   */
  shape?: Shape
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
function launcherInvocation(): { command: string; note: string; kind: 'packaged' | 'checkout' } {
  const packaged = [join(dirname(process.execPath), 'bench.cmd'), join(APP_ROOT, 'bench.cmd')].find(
    (candidate) => existsSync(candidate),
  )
  if (packaged) {
    return {
      kind: 'packaged',
      command: `"${commandPath(packaged)}"`,
      note: [
        'The desktop app does not put its CLI on PATH: `bench.cmd` sits beside `bench.exe`, which',
        "opens the window, and the line above calls it by absolute path. If that path is gone, the app",
        'folder moved — use the `bench.cmd` in its new location.',
      ].join('\n'),
    }
  }
  return {
    kind: 'checkout',
    command: `pnpm -C "${commandPath(APP_ROOT)}" bench`,
    note: [
      `That is the CLI script of the bench checkout at \`${APP_ROOT}\`; \`pnpm -C\` runs it from any`,
      'folder. If `bench` is on PATH it is the same CLI.',
    ].join('\n'),
  }
}

/** The launcher this process was started from, as a command line. For hints that must actually run. */
export function launcherCommand(): string {
  return launcherInvocation().command
}

/** A project folder as it should appear in a command line. */
export function launcherProjectPath(dir: string): string {
  return commandPath(dir)
}

function projectAgents(dir: string, state?: ProjectState): string {
  const launcher = launcherInvocation()
  // A project inside this checkout is addressed relative to it, so the file stays true on any clone:
  // the demo fixture must not record one machine's absolute path. Anything else needs the checkout's
  // absolute path, because there is no common root to write it against.
  const inside = commandPath(relative(APP_ROOT, dir))
  const local =
    launcher.kind === 'checkout' &&
    inside !== '' &&
    !inside.startsWith('../') &&
    !isAbsolute(inside)
  const command = local ? 'pnpm bench' : launcher.command
  const projectPath = local ? inside : commandPath(dir)
  const note = local
    ? [
        "That is this checkout's CLI script, and the path above is this project relative to it: run",
        'the line from the checkout root. If `bench` is on PATH it is the same CLI.',
      ].join('\n')
    : launcher.note
  const moved = local
    ? [
        'If this folder has moved since that line was written, run `pnpm bench` from the checkout root',
        "with `--project` pointing at the folder's current path and run `state`: that rewrites this line.",
      ].join('\n')
    : [
        'If this folder has moved since that line was written, run the same launcher with `--project`',
        "pointing at the folder's current path and run `state`: that rewrites this line.",
      ].join('\n')
  const shapes =
    state === undefined
      ? ''
      : `\n## Shapes\n\n${[...state.datasets.values()]
          .map((dataset) => `- \`${dataset.id}\` — ${shapeSummary(state.shapes.get(dataset.shape))}`)
          .join('\n')}\n`
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

The CLI is the only way to read or mutate this project. This file records the launcher that created
it, refreshed to whichever CLI last wrote the brief, so the next session does not have to find it:

    ${command} --project "${projectPath}" state

${note}

${moved}

## After changing anything

Run the \`state\` command the same way and read the result. It is the brief the next session inherits.

## Before concluding anything

Run the \`check\` command the same way. A clean log is not the same as a supported claim.
${shapes}`
}

/** Write a generated file only when it differs, so ordinary use does not churn its timestamp. */
async function writeIfChanged(path: string, content: string): Promise<void> {
  try {
    if ((await readFile(path, 'utf8')) === content) return
  } catch {
    // Missing is ordinary: a project created before the launcher was recorded had no line to heal.
  }
  await writeFile(path, content)
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
  // The launcher is a fact about this machine, not about creation day, so it is refreshed wherever
  // the brief is written: `state`, every mutation, and the window's own writes. A project made from
  // the older placeholder — or one opened after its folder moved — is healed by ordinary use, and
  // an unchanged file is not rewritten, so nothing churns.
  await writeIfChanged(join(handle.dir, 'AGENTS.md'), projectAgents(handle.dir, state))
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
    shape: declared,
  }

  await handle.log.append(makeEvent('project_created', session, { name: config.name }))
  await handle.log.append(makeEvent('shape_defined', session, { shape: declared }))
  await handle.log.append(
    makeEvent('dataset_created', session, { dataset: DEFAULT_DATASET, shape: declared.id }),
  )

  await refreshState(handle)
  return handle
}
