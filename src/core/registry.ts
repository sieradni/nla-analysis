/**
 * Which projects exist on this machine, so a window has something to switch between.
 *
 * The registry is application state, not project state: a project remains a folder you can open
 * without it, and deleting this file loses recency, not data. It lives outside every project on
 * purpose — a project must never depend on a list that another project's command rewrites.
 *
 * Reads are tolerant. A registry that cannot be parsed is reported as a problem, not as "you have no
 * projects": an empty list would look like data loss, which is the one panic this file must not
 * cause. Writes are atomic, because a half-written list is exactly how a registry gets corrupted.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { BenchError } from './errors.ts'
import type { IsoTime } from './events.ts'
import { PROJECT_FILE } from './project.ts'

export interface RegistryEntry {
  /** The project's own name, from its project.json. Not required to be unique until you ask by name. */
  name: string
  /** Absolute path, so the registry means the same thing from any working directory. */
  dir: string
  created: IsoTime
  /** Last time a command touched it. What "recents" sorts by. */
  lastOpened: IsoTime
}

export interface KnownProject extends RegistryEntry {
  /** False when the folder has moved or been deleted since it was registered. */
  exists: boolean
  registered: boolean
}

export interface RegistryRead {
  entries: RegistryEntry[]
  /** Set when the file exists but could not be used. Never silently treated as "no projects". */
  problem?: string
}

const REGISTRY_VERSION = 1
const FILE = 'projects.json'

/** Directories that never contain a project, so discovery does not walk into them. */
const NOT_A_PROJECT = new Set([
  '.git',
  '.svn',
  'node_modules',
  'data',
  'artifacts',
  'views',
  'shapes',
  'recipes',
  '.venv',
  'dist',
  'target',
])

/**
 * Where the registry lives. `BENCH_HOME` exists so tests — and anyone with a locked-down home — can
 * point it somewhere else without touching the real one.
 */
export function benchHome(): string {
  const override = process.env.BENCH_HOME
  if (override !== undefined && override.trim() !== '') return resolve(override)
  return join(homedir(), '.bench')
}

export function registryPath(): string {
  return join(benchHome(), FILE)
}

/** Path comparison key. Windows paths differ only by case, so two spellings are one project. */
function key(dir: string): string {
  const resolved = resolve(dir)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isEntry(value: unknown): value is RegistryEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.name === 'string' &&
    entry.name !== '' &&
    typeof entry.dir === 'string' &&
    entry.dir !== '' &&
    typeof entry.created === 'string' &&
    typeof entry.lastOpened === 'string'
  )
}

export async function readRegistry(): Promise<RegistryRead> {
  let text: string
  try {
    text = await readFile(registryPath(), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [] }
    return { entries: [], problem: `cannot read ${registryPath()}: ${(error as Error).message}` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { entries: [], problem: `${registryPath()} is not valid JSON; projects are not listed` }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { entries: [], problem: `${registryPath()} is not a registry file` }
  }
  const projects = (parsed as Record<string, unknown>).projects
  if (!Array.isArray(projects)) {
    return { entries: [], problem: `${registryPath()} has no projects list` }
  }
  return { entries: projects.filter(isEntry) }
}

async function writeRegistry(entries: RegistryEntry[]): Promise<void> {
  const file = registryPath()
  await mkdir(dirname(file), { recursive: true })
  // Written beside the target and renamed over it: a crash mid-write leaves the old list intact
  // rather than a truncated one that reads as "no projects".
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, JSON.stringify({ v: REGISTRY_VERSION, projects: entries }, null, 2) + '\n')
  await rename(temporary, file)
}

/** Read a project's own name and creation time without opening its log. */
export async function readProjectIdentity(
  dir: string,
): Promise<{ name: string; created: IsoTime } | null> {
  try {
    const config = JSON.parse(await readFile(join(dir, PROJECT_FILE), 'utf8')) as Record<string, unknown>
    if (typeof config.name !== 'string' || config.name === '') return null
    return {
      name: config.name,
      created: typeof config.created === 'string' ? config.created : new Date().toISOString(),
    }
  } catch {
    return null
  }
}

/**
 * Record that a project exists and was just used. Upserts by directory, so renaming the folder's
 * basename does not create a second entry for the same data.
 */
export async function rememberProject(
  dir: string,
  options: { name?: string; created?: IsoTime; lastOpened?: IsoTime } = {},
): Promise<RegistryEntry> {
  const absolute = resolve(dir)
  const identity = options.name === undefined ? await readProjectIdentity(absolute) : null
  const name = options.name ?? identity?.name ?? absolute
  const created = options.created ?? identity?.created ?? new Date().toISOString()
  const lastOpened = options.lastOpened ?? new Date().toISOString()

  const { entries, problem } = await readRegistry()
  // Never write over a file we could not read: whatever is in there is the only copy of the list,
  // and "recency is disposable" is not a licence to destroy it silently.
  if (problem !== undefined) {
    throw new BenchError('invalid', problem, {
      hint: 'fix or delete the file; it is app state, not project data',
    })
  }
  const target = key(absolute)
  const existing = entries.find((entry) => key(entry.dir) === target)
  const merged: RegistryEntry = {
    name,
    dir: absolute,
    // The project's creation time outlives how often it is opened; only recency moves.
    created: options.created ?? existing?.created ?? created,
    lastOpened,
  }
  const next = existing
    ? entries.map((entry) => (key(entry.dir) === target ? merged : entry))
    : [...entries, merged]
  await writeRegistry(next)
  return merged
}

/**
 * Find a project by the name a person says. Two folders can share a name — a project copied beside
 * itself is common — and picking one would answer a question that was not asked, so that refuses.
 */
export async function resolveProjectName(name: string): Promise<string | null> {
  const { entries } = await readRegistry()
  const wanted = name.toLowerCase()
  const matches = entries.filter(
    (entry) => entry.name.toLowerCase() === wanted && existsSync(join(entry.dir, PROJECT_FILE)),
  )
  if (matches.length === 0) return null
  if (matches.length > 1) {
    throw new BenchError('invalid', `two projects are named "${name}"`, {
      problems: matches.map((entry) => entry.dir),
      hint: 'pass --project <dir> to say which one',
    })
  }
  return matches[0]!.dir
}

/**
 * Find project folders under `root`. Discovery is depth-limited and read-only: it reports what is
 * there, and registering is a separate, explicit act.
 */
export async function scanForProjects(root: string, maxDepth = 3): Promise<RegistryEntry[]> {
  const found: RegistryEntry[] = []

  const walk = async (dir: string, depth: number): Promise<void> => {
    const identity = await readProjectIdentity(dir)
    if (identity !== null) {
      found.push({ ...identity, dir, lastOpened: identity.created })
      return
    }
    if (depth >= maxDepth) return
    let names: string[]
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    } catch {
      return
    }
    for (const name of names.sort()) {
      if (NOT_A_PROJECT.has(name) || name.startsWith('.')) continue
      await walk(join(dir, name), depth + 1)
    }
  }

  await walk(resolve(root), 0)
  return found
}

/**
 * Everything switchable: registered projects, most recently opened first, plus — when `scan` is
 * given — project folders that exist but were never registered. Unregistered ones have no recency,
 * so they sort after the known ones and say so.
 */
export async function listProjects(scan?: string): Promise<{
  projects: KnownProject[]
  problem?: string
}> {
  const { entries, problem } = await readRegistry()
  const known = new Map(entries.map((entry) => [key(entry.dir), entry]))

  const projects: KnownProject[] = entries
    .map((entry) => ({
      ...entry,
      exists: existsSync(join(entry.dir, PROJECT_FILE)),
      registered: true,
    }))
    .sort((left, right) => (left.lastOpened < right.lastOpened ? 1 : left.lastOpened > right.lastOpened ? -1 : 0))

  if (scan !== undefined) {
    for (const found of await scanForProjects(scan)) {
      if (known.has(key(found.dir))) continue
      projects.push({ ...found, exists: true, registered: false })
    }
  }

  return problem === undefined ? { projects } : { projects, problem }
}
