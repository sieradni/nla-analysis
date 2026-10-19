import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { access } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { EventLog, newSession } from './log.ts'
import { makeEvent } from './events.ts'
import type { IsoTime, Shape } from './events.ts'
import { APP_ROOT, assessRuns } from './analysis.ts'
import { bind } from './binder.ts'
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

const PROJECT_AGENTS = `# AGENTS.md

This folder is a **bench data project**. The append-only event log is the truth.

## Non-negotiables

1. Never edit \`data/events.jsonl\` by hand. Mutate through \`bench\`.
2. Never modify \`data/raw/\`. Imported files are evidence.
3. Never delete a dataset version. Replacing data creates a version with a diff.
4. Never mix observed and derived values. Fitted values stay out of datasets.
5. Never draw a curve without n, degrees of freedom, an interval band, and a verdict.
6. Never extend a shape silently. Register the field so the change is visible.

## After changing anything

Run \`bench state\` and read the result. It is the brief the next session inherits.

## Before concluding anything

Run \`bench check\`. A clean log is not the same as a supported claim.
`

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

/** Rebuild STATE.md from the log. Called after every mutation so it cannot go stale. */
export async function refreshState(handle: ProjectHandle): Promise<ProjectState> {
  const { events } = await handle.log.read()
  const state = bind(events)
  // Freshness is assessed on every write, so STATE.md can never claim an analysis is current when
  // the point that invalidated it was appended by this very command.
  const freshness = await assessRuns(APP_ROOT, state)
  await writeFile(join(handle.dir, 'STATE.md'), renderState(handle.config, state, { freshness }))
  return state
}

export async function initProject(
  dir: string,
  name?: string,
  session = newSession(),
): Promise<ProjectHandle> {
  const target = resolve(dir)
  if (await exists(join(target, PROJECT_FILE))) {
    throw new Error(`a project already exists at ${target}`)
  }

  for (const sub of ['data/raw', 'shapes', 'views', 'artifacts']) {
    await mkdir(join(target, sub), { recursive: true })
  }

  const config: ProjectConfig = {
    name: name ?? basename(target),
    created: new Date().toISOString(),
    version: 1,
  }
  await writeFile(join(target, PROJECT_FILE), JSON.stringify(config, null, 2) + '\n')
  await writeFile(join(target, 'AGENTS.md'), PROJECT_AGENTS)

  const handle: ProjectHandle = {
    dir: target,
    config,
    log: new EventLog(join(target, EVENTS_FILE)),
    session,
  }

  await handle.log.append(makeEvent('project_created', session, { name: config.name }))
  await handle.log.append(makeEvent('shape_defined', session, { shape: DEFAULT_SHAPE }))
  await handle.log.append(
    makeEvent('dataset_created', session, { dataset: DEFAULT_DATASET, shape: DEFAULT_SHAPE.id }),
  )

  await refreshState(handle)
  return handle
}
