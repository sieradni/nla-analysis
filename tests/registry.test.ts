import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BenchError } from '../src/core/errors.ts'
import {
  listProjects,
  readRegistry,
  registryPath,
  rememberProject,
  resolveProjectName,
  scanForProjects,
} from '../src/core/registry.ts'

/**
 * The registry is app-level state, so every test here points BENCH_HOME at a scratch folder. That is
 * not fussiness: these tests must never touch the list a real user switches projects with.
 */
let home: string

async function makeProject(dir: string, name: string, created = '2026-10-01T00:00:00.000Z') {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'project.json'), JSON.stringify({ name, created, version: 1 }))
  return dir
}

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'bench-registry-'))
  process.env.BENCH_HOME = home
})

afterAll(async () => {
  delete process.env.BENCH_HOME
  await rm(home, { recursive: true, force: true })
})

describe('project registry', () => {
  it('lives outside every project, under BENCH_HOME', () => {
    expect(registryPath().startsWith(home)).toBe(true)
  })

  it('has no projects before anything is registered, and no problem either', async () => {
    const read = await readRegistry()
    expect(read.problem).toBeUndefined()
    expect(existsSync(registryPath())).toBe(false)
    expect(await listProjects()).toEqual({ projects: [] })
  })

  it('upserts by directory, so opening a project again moves it, never duplicates it', async () => {
    const dir = await makeProject(join(home, 'work', 'one'), 'one')
    await rememberProject(dir, { lastOpened: '2026-10-01T00:00:00.000Z' })
    await rememberProject(dir, { lastOpened: '2026-10-05T00:00:00.000Z' })

    const read = await readRegistry()
    expect(read.entries).toHaveLength(1)
    expect(read.entries[0]!.lastOpened).toBe('2026-10-05T00:00:00.000Z')
    // The project's own creation time is not overwritten by recency.
    expect(read.entries[0]!.created).toBe('2026-10-01T00:00:00.000Z')
  })

  it('lists most recently opened first, and admits when a folder has gone', async () => {
    const older = await makeProject(join(home, 'work', 'older'), 'older')
    const newer = await makeProject(join(home, 'work', 'newer'), 'newer')
    await rememberProject(older, { lastOpened: '2026-10-02T00:00:00.000Z' })
    await rememberProject(newer, { lastOpened: '2026-10-09T00:00:00.000Z' })

    const listed = await listProjects()
    const order = listed.projects.map((project) => project.name)
    expect(order.indexOf('newer')).toBeLessThan(order.indexOf('older'))

    await rm(newer, { recursive: true, force: true })
    const after = await listProjects()
    expect(after.projects.find((project) => project.name === 'newer')?.exists).toBe(false)
  })

  it('resolves a name to a directory, and refuses when two projects share it', async () => {
    const first = await makeProject(join(home, 'work', 'a', 'sensor'), 'sensor')
    await rememberProject(first)
    expect(await resolveProjectName('SENSOR')).toBe(first)

    const second = await makeProject(join(home, 'work', 'b', 'sensor'), 'sensor')
    await rememberProject(second)
    await expect(resolveProjectName('sensor')).rejects.toBeInstanceOf(BenchError)

    expect(await resolveProjectName('nothing-called-this')).toBeNull()
  })

  it('reports a corrupt registry instead of pretending there are no projects', async () => {
    const file = registryPath()
    await writeFile(file, '{ this is not json')
    const read = await readRegistry()
    expect(read.entries).toEqual([])
    expect(read.problem).toContain('not valid JSON')

    // Listing still works, and carries the warning rather than swallowing it.
    const listed = await listProjects()
    expect(listed.problem).toContain('not valid JSON')

    // Recording a recent must not overwrite the only copy of a list it could not read.
    const dir = await makeProject(join(home, 'work', 'unreadable'), 'unreadable')
    await expect(rememberProject(dir)).rejects.toBeInstanceOf(BenchError)
    expect(await readFile(file, 'utf8')).toBe('{ this is not json')

    await writeFile(file, JSON.stringify({ v: 1, projects: [] }))
  })

  it('finds project folders under a directory, without walking into data or dependencies', async () => {
    const root = join(home, 'scan')
    const found = await makeProject(join(root, 'alpha'), 'alpha')
    await makeProject(join(root, 'nested', 'beta'), 'beta')
    // A project.json under node_modules is a dependency's own fixture, not something to switch to.
    await makeProject(join(root, 'node_modules', 'pkg', 'gamma'), 'gamma')
    // A project's own data folder must never be searched for projects.
    await makeProject(join(found, 'data', 'raw', 'delta'), 'delta')

    const scanned = await scanForProjects(root)
    expect(scanned.map((project) => project.name).sort()).toEqual(['alpha', 'beta'])

    const listed = await listProjects(root)
    expect(listed.projects.filter((project) => !project.registered).map((project) => project.name)).toEqual([
      'alpha',
      'beta',
    ])
    expect(listed.projects.find((project) => project.name === 'alpha')?.registered).toBe(false)
  })
})
