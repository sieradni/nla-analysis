import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { EventLog } from '../src/core/log.ts'
import { makeEvent } from '../src/core/events.ts'

// Each test gets its own folder, and the folder is removed when the file finishes: a suite that
// leaves one scratch directory per case fills the temp folder with empty `bench-log-*` folders.
const scratch: string[] = []

async function tempLog(): Promise<{ log: EventLog; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'bench-log-'))
  scratch.push(dir)
  const file = join(dir, 'events.jsonl')
  return { log: new EventLog(file), file }
}

afterAll(async () => {
  while (scratch.length > 0) await rm(scratch.pop()!, { recursive: true, force: true })
})

describe('EventLog', () => {
  it('appends without rewriting previous bytes', async () => {
    const { log, file } = await tempLog()
    const first = makeEvent('project_created', 'test', { name: 'demo' })
    await log.append(first)

    const afterFirst = await readFile(file, 'utf8')
    await log.append(makeEvent('decision_recorded', 'test', { text: 'second' }))
    const afterSecond = await readFile(file, 'utf8')

    expect(afterSecond.startsWith(afterFirst)).toBe(true)
    expect(afterSecond.length).toBeGreaterThan(afterFirst.length)
  })

  it('round-trips events in order', async () => {
    const { log } = await tempLog()
    const names = ['a', 'b', 'c']
    for (const name of names) await log.append(makeEvent('project_created', 'test', { name }))

    const { events, problems } = await log.read()
    expect(problems).toEqual([])
    expect(events.map((event) => (event.type === 'project_created' ? event.name : ''))).toEqual(names)
  })

  it('ignores an incomplete final record instead of discarding the log', async () => {
    const { log, file } = await tempLog()
    const complete = makeEvent('decision_recorded', 'test', { text: 'kept' })
    await writeFile(file, `${JSON.stringify(complete)}\n{"v":1,"id":"01J`)

    const { events, problems } = await log.read()
    expect(events).toHaveLength(1)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('incomplete final record')
  })

  it('treats a missing file as an empty log', async () => {
    const { log } = await tempLog()
    expect(await log.read()).toEqual({ events: [], problems: [] })
  })
})
