/*
 * The tab's undo history, held to its own rules: every act it records can be taken back, put back,
 * and taken back again; a new act ends the branch a redo would have followed; and the stacks cannot
 * grow without limit.
 *
 * These are unit tests of `history.js` alone. What each act *does* to the project — a retraction, a
 * restore, a correction written back — is exercised through the core and the window elsewhere
 * (`tests/shell.test.ts`, `pnpm app:capture`), because that is where the log can be read back.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  appendedId,
  nextRedo,
  nextUndo,
  noteAppend,
  noteCorrection,
  noteImport,
  noteRemoval,
  permanentRefusal,
  reconcileImport,
  redoFailed,
  redoFinished,
  resetTabHistory,
  restoreTabHistory,
  snapshotTabHistory,
  takeRedo,
  takeUndo,
  undoFailed,
  undoFinished,
} from '../app/renderer/history.js'

beforeEach(() => {
  resetTabHistory()
})

/** The write's own report, as `ImportedTable` hands it to the window after a commit. */
const written = (touched, version, dataset = 'main') => ({ dataset, touched, version })

describe('the tab history', () => {
  it('takes back an added point and puts the same record back', () => {
    noteAppend('p1')
    expect(appendedId()).toBe('p1')
    const undo = takeUndo()
    expect(undo).toMatchObject({ kind: 'point', id: 'p1' })

    // Undo withdrew the point, and remembers which retraction a redo must reverse.
    undoFinished(undo, { retraction: 'r1' })
    expect(appendedId()).toBe(null)
    expect(nextRedo()).toMatchObject({ kind: 'point', id: 'p1', retraction: 'r1' })
    const redo = takeRedo()
    expect(redo).toMatchObject({ kind: 'point', id: 'p1', retraction: 'r1' })

    // Redo restores it; the next undo withdraws it again, as the same kind of act.
    redoFinished(redo, { retraction: null })
    expect(appendedId()).toBe('p1')
    expect(nextUndo()).toMatchObject({ kind: 'point', id: 'p1' })
  })

  it('names the removal an undo reverses, and the newer one a redo writes', () => {
    noteAppend('p1')
    noteRemoval('p2', 'r1')
    // The removal is the later act, so it is what the one button offers.
    expect(nextUndo()).toMatchObject({ kind: 'removal', id: 'p2', retraction: 'r1' })

    const undo = takeUndo()
    undoFinished(undo)
    const redo = takeRedo()
    expect(redo).toMatchObject({ kind: 'removal', id: 'p2', retraction: 'r1' })

    // Redo removes it again with a new event: that is the act the next undo must name.
    redoFinished(redo, { retraction: 'r2' })
    expect(nextUndo()).toMatchObject({ kind: 'removal', id: 'p2', retraction: 'r2' })
  })

  it('keeps both sides of a correction, as values rather than references', () => {
    const before = { x: 3, y: 8.09 }
    const after = { x: 3, y: 24.5 }
    noteCorrection('p1', before, after)
    before.y = 0
    after.y = 0

    const undo = takeUndo()
    expect(undo).toMatchObject({ kind: 'correction', id: 'p1' })
    expect(undo.before).toEqual({ x: 3, y: 8.09 })
    expect(undo.after).toEqual({ x: 3, y: 24.5 })

    undoFinished(undo)
    expect(takeRedo()).toMatchObject({ kind: 'correction', before: undo.before, after: undo.after })
  })

  it('takes an import back to the version it replaced, and redoes it', () => {
    noteImport('main', 3, 2)
    expect(nextUndo()).toMatchObject({ kind: 'import', dataset: 'main', version: 3, restored: 2 })

    const undo = takeUndo()
    undoFinished(undo)
    expect(nextRedo()).toMatchObject({ kind: 'import', version: 3, restored: 2 })

    const redo = takeRedo()
    redoFinished(redo)
    expect(nextUndo()).toMatchObject({ kind: 'import', version: 3, restored: 2 })
  })

  it('keeps the empty dataset as the thing an import with no parent goes back to', () => {
    noteImport('main', 1, null)
    expect(nextUndo()).toMatchObject({ kind: 'import', version: 1, restored: null })
    // The empty state is a version the core can still restore, so the only failure left is a
    // temporary one — the act stays available and the next press may work.
    undoFailed(takeUndo(), refused(null, 'the log is locked by another program'))
    expect(nextUndo()).toMatchObject({ kind: 'import', restored: null })
  })

  it('keeps two corrections of the same point as two steps backwards', () => {
    noteCorrection('p1', { x: 1, y: 2 }, { x: 1, y: 3 })
    noteCorrection('p1', { x: 1, y: 3 }, { x: 1, y: 4 })
    expect(nextUndo().after).toEqual({ x: 1, y: 4 })
    takeUndo()
    expect(nextUndo().after).toEqual({ x: 1, y: 3 })
    takeUndo()
    expect(nextUndo()).toBe(null)
  })

  it('offers the newest act whichever kind it is', () => {
    noteAppend('p1')
    noteRemoval('p2', 'r1')
    noteCorrection('p3', { x: 1 }, { x: 2 })
    expect(nextUndo().kind).toBe('correction')

    takeUndo()
    expect(nextUndo().kind).toBe('removal')
    takeUndo()
    expect(nextUndo().kind).toBe('point')
  })

  it('ends the redo branch when a new act happens', () => {
    noteAppend('p1')
    const undo = takeUndo()
    undoFinished(undo)
    expect(nextRedo()).not.toBe(null)

    noteAppend('p2')
    expect(nextRedo()).toBe(null)
    expect(takeRedo()).toBe(null)
  })

  /** The shape `state.call` throws: the core's words, and the kind that says whether to retry. */
  const refused = (kind, message) => Object.assign(new Error(message), { kind: kind, hint: null, problems: [] })

  it('drops an act the core refused for good, and keeps one that failed for another reason', () => {
    // A record another writer already withdrew: pressing the same button again repeats the refusal.
    noteAppend('p1')
    undoFailed(takeUndo(), refused('invalid', 'point "p1" is already retracted'))
    expect(nextUndo()).toBe(null)

    noteAppend('p2')
    undoFailed(takeUndo(), refused('missing', 'no point with id "p2"'))
    expect(nextUndo()).toBe(null)

    // A failure the core did not classify — a locked file, a dropped call — is worth another press.
    noteAppend('p3')
    undoFailed(takeUndo(), refused(null, 'EBUSY: resource busy or locked'))
    expect(nextUndo()).toMatchObject({ kind: 'point', id: 'p3' })
    expect(permanentRefusal(refused(null, 'EBUSY'))).toBe(false)
  })

  it('puts a temporarily failed redo back, and drops one that can never happen', () => {
    noteAppend('p1')
    const undo = takeUndo()
    undoFinished(undo, { retraction: 'r1' })
    redoFailed(takeRedo(), refused(null, 'the file is being written'))
    expect(takeRedo()).toMatchObject({ kind: 'point', id: 'p1', retraction: 'r1' })

    redoFailed(takeRedo(), refused('invalid', 'point "p1" is not retracted'))
    expect(takeRedo()).toBe(null)
    expect(nextUndo()).toBe(null)
  })

  it('drops a removal or a correction the core says has moved, in either direction', () => {
    // The two acts whose failure is a later writer's act, not a temporary problem.
    noteRemoval('p1', 'r1')
    undoFailed(takeUndo(), refused('invalid', 'that removal is no longer the one in force'))
    expect(nextUndo()).toBe(null)

    noteImport('main', 3, 2)
    const importUndo = takeUndo()
    undoFailed(importUndo, refused('invalid', 'version 2 is not older than the current version 4'))
    expect(nextUndo()).toBe(null)

    noteCorrection('p2', { x: 1 }, { x: 2 })
    undoFailed(takeUndo(), refused('invalid', 'correction rejected'))
    expect(nextUndo()).toBe(null)
  })

  it('is bounded, dropping the oldest act when the stack is full', () => {
    for (let index = 1; index <= 60; index += 1) noteAppend('p' + index)
    const taken = []
    for (let entry = takeUndo(); entry !== null; entry = takeUndo()) taken.push(entry.id)
    expect(taken).toHaveLength(50)
    expect(taken[0]).toBe('p60')
    expect(taken[49]).toBe('p11')
  })

  it('keeps the acts an import left alone, in order, and gives them their turn back', () => {
    noteAppend('p1')
    noteCorrection('p2', { x: 1 }, { x: 2 })
    noteRemoval('p3', 'r1')
    reconcileImport(written(['a-record-in-the-file'], 2))
    noteImport('main', 2, 1)

    // The import is the newest act; undoing it leaves the earlier acts in the stack, newest first,
    // because the version it replaced still holds their records exactly as the acts left them.
    expect(nextUndo()).toMatchObject({ kind: 'import', version: 2, restored: 1 })
    undoFinished(takeUndo())
    expect(nextUndo()).toMatchObject({ kind: 'removal', id: 'p3', retraction: 'r1' })
    takeUndo()
    expect(nextUndo()).toMatchObject({ kind: 'correction', id: 'p2', after: { x: 2 } })
    takeUndo()
    expect(nextUndo()).toMatchObject({ kind: 'point', id: 'p1' })
  })

  it('ends only the acts whose record the version withdrew or rewrote', () => {
    noteAppend('kept')
    noteAppend('withdrawn')
    noteCorrection('rewritten', { x: 1 }, { x: 2 })
    noteRemoval('removed-later', 'r1')

    // The write itself names the two records it touched: one it withdrew, one it corrected.
    reconcileImport(written(['withdrawn', 'rewritten'], 3))

    expect(nextUndo()).toMatchObject({ kind: 'removal', id: 'removed-later' })
    takeUndo()
    expect(nextUndo()).toMatchObject({ kind: 'point', id: 'kept' })
    takeUndo()
    expect(nextUndo()).toBe(null)
  })

  it('keeps an earlier import, and leaves ending the redo branch to the import itself', () => {
    noteImport('main', 3, 2)
    reconcileImport(written(['p9'], 4))
    // Its version is still in the log and still older than the new one: undoing it is meaningful.
    expect(nextUndo()).toMatchObject({ kind: 'import', version: 3, restored: 2 })

    noteAppend('p1')
    undoFinished(takeUndo(), { retraction: 'r1' })
    expect(nextRedo()).toMatchObject({ kind: 'point', id: 'p1' })
    reconcileImport(written(['withdrawn'], 5))
    expect(nextRedo()).toMatchObject({ kind: 'point', id: 'p1' })
    noteImport('main', 4, 3)
    expect(nextRedo()).toBe(null)
  })

  it('keeps an import act for a dataset the write did not move', () => {
    // Two datasets in one tab, each with its own version chain: this write moved `main` to version 2,
    // so `other` at version 5 still has the version 4 its act would restore.
    noteImport('other', 5, 4)
    reconcileImport(written([], 2))
    expect(nextUndo()).toMatchObject({ kind: 'import', dataset: 'other', version: 5, restored: 4 })
  })

  it('ends every act it cannot place when the write did not say what it touched', () => {
    // A report missing the record list is a write the window cannot reason about. Keeping the acts
    // would be a guess, and a guessed act is offered once and refused once; so they all go, which
    // is what the tab did before reconciliation existed.
    noteAppend('p1')
    noteCorrection('p2', { x: 1 }, { x: 2 })
    noteImport('main', 2, 1)
    reconcileImport({})
    expect(nextUndo()).toBe(null)
    expect(appendedId()).toBe(null)

    // The same goes for a report with no version to compare against: no import act can be shown to
    // name a state this dataset has moved past.
    noteImport('main', 2, 1)
    reconcileImport({ dataset: 'main', touched: [] })
    expect(nextUndo()).toBe(null)
  })

  it('drops an import that can no longer go back to an empty dataset', () => {
    // Undoing the first import means restoring "no rows". Once a second import has written version
    // 2, that is no longer an older state: the core refuses it, so the act must not survive.
    noteImport('main', 1, null)
    reconcileImport(written([], 2))
    expect(nextUndo()).toBe(null)

    // An import that replaced a real version is still reachable, because that version still exists.
    noteImport('main', 3, 2)
    reconcileImport(written([], 4))
    expect(nextUndo()).toMatchObject({ kind: 'import', version: 3, restored: 2 })
  })

  it('names the timing figure only while the point it names is still there', () => {
    noteAppend('kept')
    reconcileImport(written(['another-record'], 2))
    expect(appendedId()).toBe('kept')
    reconcileImport(written(['kept'], 2))
    expect(appendedId()).toBe(null)
  })

  it('hands a closed tab its own acts back after the drawing changed', () => {
    noteAppend('p1')
    noteCorrection('p2', { x: 1 }, { x: 2 })
    // One act already undone, so the snapshot has to carry a redo as well as undos.
    undoFinished(takeUndo())
    const kept = snapshotTabHistory()

    // A tab switch, or the tab leaving the screen, clears the drawing's history...
    resetTabHistory()
    expect(nextUndo()).toBe(null)
    expect(nextRedo()).toBe(null)

    // ...and reopening the tab puts back exactly what it had, in both directions.
    restoreTabHistory(kept)
    expect(nextUndo()).toMatchObject({ kind: 'point', id: 'p1' })
    expect(nextRedo()).toMatchObject({ kind: 'correction', id: 'p2' })
    expect(appendedId()).toBe(null)
  })

  it('leaves an empty bar for a tab closed before this window opened', () => {
    // The acts were the earlier window's memory; the log cannot reconstruct them, so a reopen after
    // a relaunch has nothing to restore and must not invent an act.
    noteAppend('p1')
    resetTabHistory()
    restoreTabHistory(null)
    expect(nextUndo()).toBe(null)
    expect(nextRedo()).toBe(null)
  })

  it('snapshots the stacks by value, so the tab that is open cannot rewrite the closed one', () => {
    noteAppend('p1')
    const kept = snapshotTabHistory()
    noteAppend('p2')
    takeUndo()
    expect(kept.undos).toHaveLength(1)
    restoreTabHistory(kept)
    expect(nextUndo()).toMatchObject({ kind: 'point', id: 'p1' })
  })

  it('forgets everything on a view change', () => {
    noteAppend('p1')
    const undo = takeUndo()
    undoFinished(undo, { retraction: 'r1' })
    resetTabHistory()
    expect(nextUndo()).toBe(null)
    expect(takeRedo()).toBe(null)
    expect(appendedId()).toBe(null)
  })
})
