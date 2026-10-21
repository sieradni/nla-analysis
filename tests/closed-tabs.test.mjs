/*
 * The list of tabs a window can put back, held to its own rules: newest first, taken one at a time,
 * bounded like the project's trash, refillable after a relaunch, and emptied when another project
 * opens.
 *
 * These are unit tests of `closed-tabs.js` alone. What a reopen does to the project — the archive
 * moving home, the drawing coming back, the history returning to the bar — is proven where it can be
 * read: `tests/views.test.ts`, `tests/shell.test.ts`, and `pnpm app:capture`'s real keystrokes and
 * real relaunch.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { noteClosed, putBackClosed, setClosedTabs, takeClosed } from '../app/renderer/closed-tabs.js'

/** The archive reference the core hands back from a close. */
const archive = (name, closedAt = '2026-10-21T03-00-00-000Z') => ({
  file: `${name.replaceAll(' ', '-')}-${closedAt}.json`,
  name,
  panels: 1,
  closedAt,
})

/** The tab history the close carried, in the shape `history.js` snapshots. */
const history = (id) => ({ undos: [{ kind: 'point', id }], redos: [], appended: id })

beforeEach(() => {
  setClosedTabs([])
})

describe('the closed-tab list', () => {
  it('is empty before anything is closed', () => {
    expect(takeClosed()).toBe(null)
  })

  it('takes the newest close first, with the archive it holds', () => {
    noteClosed(archive('one'), history('p1'))
    noteClosed(archive('two'), history('p2'))
    const newest = takeClosed()
    expect(newest.entry.name).toBe('two')
    expect(newest.entry.file).toMatch(/^two-/)
  })

  it('takes one at a time, newest first, with the acts that went with each', () => {
    noteClosed(archive('one'), history('p1'))
    noteClosed(archive('two'), history('p2'))

    const first = takeClosed()
    expect(first.entry.name).toBe('two')
    expect(first.history.undos[0].id).toBe('p2')
    expect(takeClosed().entry.name).toBe('one')
    expect(takeClosed()).toBe(null)
  })

  it('fills from the project’s own trash, newest first, after a relaunch', () => {
    // What a fresh window gets: archives on disk, and no acts — those were the earlier window's.
    setClosedTabs([archive('newest', '2026-10-21T03-00-02-000Z'), archive('older', '2026-10-21T03-00-01-000Z')])
    const taken = takeClosed()
    expect(taken.entry.name).toBe('newest')
    expect(taken.history).toBe(null)
    expect(takeClosed().entry.name).toBe('older')
  })

  it('keeps an archive that failed temporarily, with its acts, at the front', () => {
    setClosedTabs([archive('older')])
    noteClosed(archive('newest'), history('p9'))
    const taken = takeClosed()
    // The reopen was refused for a reason that may pass: the tab is still there to try again.
    putBackClosed(taken)
    const retried = takeClosed()
    expect(retried.entry.name).toBe('newest')
    expect(retried.history.undos[0].id).toBe('p9')
    expect(takeClosed().entry.name).toBe('older')
  })

  it('keeps the newest twenty, the same bound as the project’s trash', () => {
    // Closed oldest first, the way a session closes them: the list grows at the front.
    for (let index = 0; index < 25; index += 1) {
      noteClosed(archive('tab ' + index, `2026-10-21T03-00-00-${String(index).padStart(3, '0')}Z`), history('p' + index))
    }
    const names = []
    for (let taken = takeClosed(); taken !== null; taken = takeClosed()) names.push(taken.entry.name)
    expect(names).toHaveLength(20)
    expect(names[0]).toBe('tab 24')
    expect(names[4]).toBe('tab 20')
    expect(names[19]).toBe('tab 5')
  })

  it('forgets everything when another project opens', () => {
    // A closed tab belongs to the project it was closed in, and this window cannot put it back
    // anywhere else.
    noteClosed(archive('one'), history('p1'))
    setClosedTabs([])
    expect(takeClosed()).toBe(null)
  })
})
