import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { watchProject } from '../src/core/watch.ts'

/** Wait for the watcher to report, so the test is not a race with a fixed sleep. */
async function until(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('the watcher did not report in time')
    await new Promise((done) => setTimeout(done, 20))
  }
}

describe('watchProject', () => {
  const roots: string[] = []

  afterEach(async () => {
    while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true })
  })

  it('reports a burst of writes once, and stops when told to', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bench-watch-'))
    roots.push(dir)
    await mkdir(join(dir, 'data'))
    await mkdir(join(dir, 'views'))

    let changes = 0
    const stop = watchProject(dir, () => {
      changes += 1
    }, 250)

    // One act as far as a window is concerned: the log, a tab, then the log again.
    await writeFile(join(dir, 'data', 'events.jsonl'), '{}\n')
    await writeFile(join(dir, 'views', 'tab.json'), '{}\n')
    await writeFile(join(dir, 'data', 'events.jsonl'), '{}\n{}\n')

    await until(() => changes > 0)
    // Give a second event time to arrive: one burst must not become three redraws.
    await new Promise((done) => setTimeout(done, 500))
    expect(changes).toBe(1)

    stop()
    await writeFile(join(dir, 'data', 'events.jsonl'), '{}\n{}\n{}\n')
    await new Promise((done) => setTimeout(done, 500))
    expect(changes).toBe(1)
  }, 10_000)
})
