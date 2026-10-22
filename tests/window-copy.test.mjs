/*
 * The window's words are a rule, not a review habit.
 *
 * ADR 0015 says the window shows values, units, what changed and what to do; record ids, event names,
 * dataset and shape ids, versions and commands are agent vocabulary. `app/renderer/copy.js` is the one
 * module that composes those strings, so this file can hold it to the rule directly — and scan the
 * other renderer modules for the two regressions that put a ULID or an event name back on screen.
 */
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as copy from '../app/renderer/copy.js'
import { resolveObservation } from '../src/core/observation.ts'

const renderer = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'renderer')

/**
 * The instant the window must read back: drawn from an independent formatter (Intl) on the machine's
 * own clock, so this file states the rule without assuming which timezone runs it. A window that
 * printed UTC would fail every one of these assertions wherever the reader is not at UTC.
 */
function onTheClock(iso) {
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso))
}

const OBSERVED = '2026-10-19T06:00:00.000Z'
const OBSERVED_TEXT = onTheClock(OBSERVED)
const POINT_ID = '01M58Y41VF83K6TQ8XWWK9VN0S'
const ULID = /\b01[0-9A-HJKMNP-TV-Z]{24}\b/
const EVENT_NAMES = [
  'project_created',
  'shape_defined',
  'shape_extended',
  'shape_time_designated',
  'dataset_created',
  'dataset_version_created',
  'point_recorded',
  'point_corrected',
  'point_retracted',
  'point_restored',
  'import_completed',
  'analysis_run',
  'decision_recorded',
]
const SHAPE_ID = /\b[a-z][a-z0-9_]*\.v\d+\b/
const ABBREVIATION = /\bDOF\b|\(s\)|\bversion \d|\+\d+ −\d+ ~\d+/

const panel = {
  dataset: 'main',
  recipe: 'drift',
  params: { split: 'auto' },
  verdict: 'tentative',
  n: 14,
  title: 'slope before and after the split',
  chart: {
    x: { label: 'x' },
    y: { label: 'y', unit: '°C' },
    caption: 'Slope 2.053 before the split, 2.421 after it.',
    evidence: { points: 14, regimes: 2, parameters: 2, dof: 10 },
    provenance: { dataset: 'main', shape: 'xy.v1', version: 2 },
  },
}

/** Every word a person could read in one of these strings, checked against the rule. */
function expectPlain(text, where) {
  expect(text, where).not.toMatch(ULID)
  expect(text, where).not.toMatch(SHAPE_ID)
  expect(text, where).not.toMatch(/\bmain\b/)
  expect(text, where).not.toMatch(/\bbench\b/)
  expect(text, where).not.toMatch(/\bv\d+\b/)
  expect(text, where).not.toMatch(ABBREVIATION)
  for (const name of EVENT_NAMES) expect(text, where).not.toContain(name)
}

describe('the hover readout', () => {
  it('names the measurement and nothing about the record', () => {
    const lines = copy.tooltipLines({ id: POINT_ID, x: 3, y: 8.09 }, panel)
    const text = lines.join(' ')
    expectPlain(text, 'tooltip')
    expect(text).toBe('x 3 · y 8.09 °C')
  })

  it('reads numbers once, the same way everywhere', () => {
    expect(copy.formatValue(1234.567)).toBe('1 230')
    expect(copy.formatValue(0.675)).toBe('0.675')
    expect(copy.formatValue(16.4)).toBe('16.4')
    expect(copy.formatValue(-1234567)).toBe('-1 230 000')
    expect(copy.formatValue(undefined)).toBe('—')
  })

  it('adds the observation time only when time is not an axis', () => {
    const timed = copy.tooltipLines({ x: 1, y: 2, tObserved: OBSERVED }, panel)
    expect(timed.join(' ')).toContain('Observed ' + OBSERVED_TEXT)
    const timeAxis = {
      ...panel,
      chart: { ...panel.chart, x: { label: 'date', format: 'time' } },
    }
    const onAxis = copy.tooltipLines({ x: 1, y: 2, tObserved: OBSERVED }, timeAxis)
    expect(onAxis.join(' ')).not.toContain('Observed')
  })

  it('tells a measured time from an estimate, in the words the strip and the list use', () => {
    const measured = copy.tooltipLines({ x: 1, y: 2, tObserved: OBSERVED }, panel)
    const guessed = copy.tooltipLines({ x: 1, y: 2, tObserved: OBSERVED, timeEstimated: true }, panel)
    expect(measured).toEqual(['x 1 · y 2 °C', 'Observed ' + OBSERVED_TEXT])
    expect(guessed).toEqual(['x 1 · y 2 °C', 'Observed ' + OBSERVED_TEXT + ' (estimated)'])
    expect(guessed.join(' ')).not.toBe(measured.join(' '))
    expectPlain(guessed.join(' '), 'estimated tooltip')

    // On a time axis the clock *is* the value, so the label rides on it rather than saying the same
    // thing twice in one tiny popup.
    const timeAxis = {
      ...panel,
      chart: { ...panel.chart, x: { label: 'date', format: 'time' } },
    }
    const at = Date.parse(OBSERVED)
    expect(
      copy.tooltipLines({ x: at, y: 2, tObserved: OBSERVED, timeEstimated: true }, timeAxis),
    ).toEqual(['date ' + OBSERVED_TEXT + ' (estimated) · y 2 °C'])
    expect(copy.tooltipLines({ x: at, y: 2, tObserved: OBSERVED }, timeAxis)).toEqual([
      'date ' + OBSERVED_TEXT + ' · y 2 °C',
    ])
    // Nothing to say about a point that carries no time at all.
    expect(copy.tooltipLines({ x: 1, y: 2 }, panel)).toEqual(['x 1 · y 2 °C'])
  })
})

describe('a panel', () => {
  it('names its method and count, not its dataset, shape or version', () => {
    const facts = copy.panelFacts(panel)
    expectPlain(facts, 'panel facts')
    // The verdict is its own chip with its own explanation, so the strip must not say it twice.
    expect(facts).toBe('Change over time · 14 points')
  })

  it('explains its verdict in a sentence a newcomer can act on', () => {
    for (const verdict of ['insufficient', 'tentative', 'supported', 'contradicted']) {
      const said = copy.verdictExplanation(verdict)
      expectPlain(said, `verdict ${verdict}`)
      expect(said.length).toBeGreaterThan(40)
      expect(said).toMatch(/[.!]$/)
    }
    expect(copy.verdictExplanation('tentative')).toMatch(/More observations|more observations/)
    expect(copy.verdictExplanation('insufficient')).toMatch(/Add another point|add another point/)
    // The word above it is a capitalised word, never an id or an event name.
    expect(copy.verdictWord('tentative')).toBe('Tentative')
    expect(copy.verdictWord(undefined)).toBe('')
  })

  it('puts the drawing\u2019s evidence in words, without repeating the verdict', () => {
    const evidence = (chart) => copy.panelEvidence({ ...panel, chart: { x: {}, y: {}, ...chart } })
    expectPlain(evidence(panel.chart), 'evidence line')
    expect(evidence(panel.chart)).toBe('n = 14 · 2 regimes of 2 parameters · 10 degrees of freedom')
    // The band is the core's addition to the recipe's numbers, and reads as a level and a kind.
    expect(evidence({ ...panel.chart, evidence: { ...panel.chart.evidence, band: { level: 0.95, kind: 'confidence' } } })).toBe(
      'n = 14 · 2 regimes of 2 parameters · 10 degrees of freedom · 95% confidence band',
    )
    // A plot panel has nothing fitted, and says so rather than pretending it has evidence.
    expect(evidence({ evidence: { points: 3, noCurve: 'unmodelled' } })).toBe('n = 3 · no fit — unmodelled')
    // A refusal states what it would take, in observations, never `insufficient`.
    expect(evidence({ evidence: { points: 3, parameters: 2, dof: 1, noCurve: 'insufficient' } })).toBe(
      'n = 3 · 2 parameters · 1 degree of freedom · no curve drawn',
    )
    expect(evidence({ evidence: { points: 5, noCurve: 'segments', needed: 6 } })).toBe(
      'n = 5 · segments need 6 points',
    )
    expect(evidence({ evidence: { points: 4, skipped: { points: 1, x: 'mass', y: 'extension' } } })).toContain(
      '1 point without mass/extension not plotted',
    )
    expect(copy.panelEvidence({ ...panel, chart: { x: {}, y: {} } })).toBe('')
    expect(copy.panelEvidence({ ...panel, chart: { x: {}, y: {}, evidence: { n: 3 } } })).toBe('')
  })

  it('is silent when up to date, and says what to do when it is not', () => {
    expect(copy.panelStatus('current')).toEqual({ label: '', title: '' })
    expect(copy.panelStatus('stale').label).toBe('Out of date')
    expect(copy.panelStatus('stale').title).toMatch(/Refresh/)
    expect(copy.panelStatus('missing').label).toBe('Data gone')
    expectPlain(copy.panelStatus('stale').label + copy.panelStatus('stale').title, 'stale')
    expectPlain(copy.panelStatus('unchecked').label + copy.panelStatus('unchecked').title, 'unchecked')
  })

  it('states the tab in counts and nothing else', () => {
    const facts = copy.tabFacts(2, 14)
    expectPlain(facts, 'tab facts')
    expect(facts).toBe('2 panels · 14 points')
    expect(copy.tabFacts(1, 1)).toBe('1 panel · 1 point')
  })

  it('turns a stale panel into one sentence with a button, not a command', () => {
    const text = copy.notice([{ state: 'stale', detail: 'the dataset is at version 4' }, { state: 'current' }])
    expectPlain(text, 'notice')
    expect(text).toBe('1 panel no longer matches this project. Refresh to redraw it.')
    expect(copy.notice([{ state: 'current' }])).toBe('')
  })

  it('keeps the accessible name to what a person needs', () => {
    const label = copy.accessibleLabel(panel, panel.title, copy.panelFacts(panel), 'Out of date')
    expectPlain(label, 'accessible name')
    expect(label).toContain('x x, y y (°C)')
    expect(label).toContain('Slope 2.053')
    expect(label).toContain('14 points')
  })
})

describe('a point\u2019s menu', () => {
  it('offers three verbs in a person\u2019s words', () => {
    expect(copy.pointMenu.copy).toBe('Copy details')
    expect(copy.pointMenu.correct).toBe('Correct\u2026')
    expect(copy.pointMenu.remove).toBe('Remove')
    // The menu's accessible name is a sentence about the point, not a key or an event.
    expect(copy.pointMenu.label).toBe('Actions for this point')
    Object.values(copy.pointMenu).forEach((label) => expectPlain(label, `menu ${label}`))
  })

  it('copies one line that identifies the point without being read as an id first', () => {
    const detail = {
      id: POINT_ID,
      fields: [
        { name: 'x', type: 'number' },
        { name: 'y', type: 'number', unit: '°C' },
      ],
      values: { x: 3, y: 8.09 },
      tObserved: OBSERVED,
      corrections: 0,
      recipePanels: [],
    }
    const text = copy.copiedDetails(detail)
    expect(text).toBe('x 3 · y 8.09 °C · observed ' + OBSERVED_TEXT + ' · record ' + POINT_ID)
    // The values and the time are the sentence; the id is appended, once, so another session can
    // find the record. Everything a person would read comes first.
    expect(text.match(ULID)).toHaveLength(1)
    expect(text.endsWith('record ' + POINT_ID)).toBe(true)
    expect(text).not.toContain('main')
    expect(text).not.toContain('point_')
    // A nil count is not a fact worth copying, and a missing value is not a zero.
    expect(copy.copiedDetails({ ...detail, fields: [{ name: 'y', type: 'number', unit: '°C' }], values: { y: null } })).toBe(
      'observed ' + OBSERVED_TEXT + ' · record ' + POINT_ID,
    )
    // A designated time field is said once, as "observed", not repeated as a value.
    const timed = copy.copiedDetails({
      ...detail,
      timeField: 'taken_at',
      fields: [{ name: 'taken_at', type: 'instant' }, ...detail.fields],
      values: { taken_at: OBSERVED, x: 3, y: 8.09 },
    })
    expect(timed).toBe('x 3 · y 8.09 °C · observed ' + OBSERVED_TEXT + ' · record ' + POINT_ID)
    expect(copy.copiedDetails(null)).toBe('')
    // A time the file only implied reads as one here too: a copied line that said "observed" would
    // be a claim the record cannot support.
    expect(copy.copiedDetails({ ...detail, timeEstimated: true })).toBe(
      'x 3 · y 8.09 °C · observed ' + OBSERVED_TEXT + ' (estimated) · record ' + POINT_ID,
    )
  })
})

describe('a time a person enters', () => {
  const shape = {
    id: 'log.v2',
    version: 2,
    fields: [
      { name: 'app', type: 'number' },
      { name: 'date', type: 'instant' },
    ],
    time_field: 'date',
  }
  const when = '2026-10-19T16:30:00.000Z'

  it('reads an instant on the reader\u2019s clock, and only there', () => {
    expect(copy.formatInstant(OBSERVED)).toBe(OBSERVED_TEXT)
    expect(copy.formatDay(OBSERVED)).toBe(OBSERVED_TEXT.split(',')[0])
    // A UTC formatter agrees with the local one only for a reader who is at UTC. Where the two
    // differ, the window must say the time the reader's own clock says.
    if (new Date(OBSERVED).getTimezoneOffset() !== 0) {
      expect(copy.formatInstant(OBSERVED)).not.toBe('19 Oct 2026, 06:00')
    }
    expect(copy.formatInstant('')).toBe('')
    expect(copy.formatInstant('not a time')).toBe('')
  })

  it('shows a date and a time in the control, not a timestamp to type', () => {
    // The control's value is the same moment on the wall clock, to the minute it edits: what a
    // date/time input needs, which is why the UTC string cannot be handed to it.
    const date = new Date(when)
    const pad = (part) => String(part).padStart(2, '0')
    expect(copy.instantInputValue(when)).toBe(
      `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}`,
    )
    expect(copy.instantInputValue(when)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    expect(copy.instantInputValue('')).toBe('')
    expect(copy.instantInputValue('not a time')).toBe('')
  })

  it('stores the moment pressed, as UTC, and reads it back as the same wall clock', () => {
    // `typed` is what the control holds: a local date and time, no offset, no syntax to remember.
    const typed = '2026-10-19T09:30'
    const canonical = copy.instantFromInput(typed)
    expect(canonical).toBe(new Date(typed).toISOString())
    expect(canonical.endsWith('Z')).toBe(true)
    // The digits are the reader's clock, so the stored instant is that clock read locally: the
    // difference from the same digits read as UTC is exactly the reader's offset. `getTimezoneOffset`
    // is minutes west of UTC, so a reader at UTC-7 pressed a moment seven hours later than those
    // digits read as UTC.
    const offsetMinutes = new Date(typed).getTimezoneOffset()
    expect(Date.parse(canonical) - Date.parse(typed + 'Z')).toBe(offsetMinutes * 60000)
    const decided = resolveObservation(shape, { app: 1, date: canonical })
    expect(decided.tObserved).toBe(canonical)
    expect(copy.formatInstant(decided.tObserved)).toBe(onTheClock(decided.tObserved))
    expect(copy.instantInputValue(decided.tObserved)).toBe(typed)
  })

  it('leaves the clock exactly as the log had it when the edit was another field', () => {
    // The control shows whole minutes; the log holds seconds and milliseconds. A correction that
    // changes a number must not move the time by the part the control cannot show.
    const stored = '2026-10-19T16:30:31.123Z'
    const shown = copy.instantInputValue(stored)
    expect(copy.instantFromInput(shown, stored)).toBe(stored)
    expect(copy.instantInputValue(stored)).toBe(shown)
    // A different minute is a different time, and is written as the person set it.
    const later = copy.instantInputValue(new Date(Date.parse(stored) + 60000).toISOString())
    const moved = copy.instantFromInput(later, stored)
    expect(moved).not.toBe(stored)
    expect(copy.instantInputValue(moved)).toBe(later)
    // A value the control could not have produced is passed through, so the core refuses it in its
    // own words rather than the window inventing one.
    expect(copy.instantFromInput('21/10/2026 5 am')).toBe('21/10/2026 5 am')
    expect(copy.instantFromInput('')).toBe('')
  })

  it('says the observation time once, as a time', () => {
    const fields = [
      { name: 'date', type: 'instant' },
      { name: 'y', type: 'number', unit: '\u00b0C' },
    ]
    const values = { date: when, y: 2 }
    // The designated field is the observation time, so the strip's values leave it to "observed".
    expect(copy.describeValues(values, panel, fields, 'date')).toBe('y 2 \u00b0C')
    const row = copy.status.correctionRow({
      values,
      panel,
      observed: when,
      corrections: 0,
      stalePanels: 0,
      fields,
      timeField: 'date',
    })
    expect(row).toBe('y 2 \u00b0C \u00b7 observed ' + onTheClock(when))
    // Never the ISO string the log holds, in the strip or in the editing sentence.
    expect(row).not.toMatch(/\d{4}-\d{2}-\d{2}T/)
    expect(copy.status.editing({ values, panel, fields, timeField: 'date' })).toBe(
      'Editing y 2 \u00b0C \u00b7 Escape cancels',
    )
    // An instant that is not the observation time is still read as a time.
    expect(
      copy.describeValues(
        { tape_at: when },
        panel,
        [{ name: 'tape_at', type: 'instant' }],
      ),
    ).toBe('tape_at ' + onTheClock(when))
  })

  it('says so when a correction moved the time', () => {
    expect(copy.status.corrected({ active: 14, stalePanels: 0, observed: when })).toBe(
      'Corrected \u00b7 observed ' + onTheClock(when) + ' \u00b7 14 points in this tab',
    )
    expect(copy.status.corrected({ active: 14, stalePanels: 0 })).toBe('Corrected \u00b7 14 points in this tab')
    expectPlain(copy.status.corrected({ active: 14, stalePanels: 0, observed: when }), 'corrected time')
    // A replace that moved the time to a measured instant says so without the marker; the same
    // sentence with the marker is what a re-read that kept the estimate would say.
    expect(copy.status.corrected({ active: 14, stalePanels: 0, observed: when, estimated: true })).toBe(
      'Corrected \u00b7 observed ' + onTheClock(when) + ' (estimated) \u00b7 14 points in this tab',
    )
    expect(copy.observedWord(when, false)).toBe('observed ' + onTheClock(when))
    expect(copy.observedWord(when, true)).toBe('observed ' + onTheClock(when) + ' (estimated)')
  })
})

describe('the entry bar', () => {
  const values = { x: 6.5, y: 16.4 }

  it('reports what happened without ids, event names or a dataset', () => {
    const said = [
      copy.status.saved({ active: 15, warnings: ['field `temprature` is not in the shape'], reread: true }),
      copy.status.corrected({ active: 15, stalePanels: 1 }),
      copy.status.correctionUndone({ active: 15, stalePanels: 1 }),
      copy.status.importUndone({ active: 14 }),
      copy.status.importReapplied({ active: 5 }),
      copy.status.removed({ active: 14 }),
      copy.status.restored({ active: 15 }),
      copy.status.copied(),
      copy.status.stillSaving(),
      copy.status.editing({ values, panel }),
      copy.status.correctionRow({ values, observed: '2026-10-19T06:00:00.000Z', corrections: 0, stalePanels: 0 }),
      copy.actTitle('undo', copy.labels.actRemoval),
      copy.actTitle('undo', copy.labels.actPoint),
      copy.actTitle('undo', copy.labels.actCorrection),
      copy.actTitle('undo', copy.labels.actImport),
      copy.actTitle('redo', copy.labels.actRemovalRedo),
      copy.actTitle('redo', copy.labels.actPointRedo),
      copy.actTitle('redo', copy.labels.actCorrectionRedo),
      copy.actTitle('redo', copy.labels.actImportRedo),
      copy.idleActTitle('undo'),
      copy.idleActTitle('redo'),
      copy.status.readoutTitle(),
      copy.status.idleHint(),
      copy.status.rereadTab(),
      copy.status.rereadAfterWrite(),
      copy.status.tabChanged({ name: 'drift over time', active: 14 }),
      copy.status.tabRemoved({ name: 'drift over time', remaining: 1 }),
      copy.status.tabSaved({ name: 'regimes', replaced: false, panel }),
      copy.status.closedTab({ name: 'drift over time' }),
      copy.status.reopenedTab({ name: 'drift over time' }),
      copy.status.reopenedTab({ name: 'drift over time', historyLost: true }),
      copy.status.renamedTab({ from: 'drift', name: 'drift over time' }),
      copy.status.duplicatedTab({ from: 'drift', name: 'drift copy' }),
      copy.actTitle('undo', copy.labels.actTab),
      copy.actTitle('redo', copy.labels.actTabRedo),
      copy.tabMenu.label,
      copy.tabMenu.rename,
      copy.tabMenu.duplicate,
      copy.tabMenu.close,
      copy.nameSheet.label,
      copy.nameSheet.cancel,
      copy.nameSheet.rename.title,
      copy.nameSheet.rename.note,
      copy.nameSheet.rename.confirm,
      copy.nameSheet.duplicate.title,
      copy.nameSheet.duplicate.note,
      copy.nameSheet.duplicate.confirm,
      copy.status.refreshed([{ state: 'current' }]),
      copy.status.refreshed([{ state: 'stale' }]),
      copy.empty.noTabs(),
      copy.empty.noProjects(),
      copy.empty.tabRemoved('regimes'),
    ]
    said.forEach((text, index) => expectPlain(text, `status ${index}: ${text}`))
    expect(copy.status.removed({ active: 14 })).toBe('Removed · 14 points left in this tab')
    // Undo is a button beside this word, not a sentence about one; the status says what happened.
    expect(copy.status.restored({ active: 15 })).toBe('Restored · 15 points in this tab')
    expect(copy.status.copied()).toContain('Copied')
    expect(copy.status.stillSaving()).toBe('Still saving — try again in a moment.')
    expect(copy.status.editing({ values, panel })).toContain('Editing x 6.5 · y 16.4')
  })

  it('says when a reopened tab has changes its undo history cannot reach', () => {
    // A tab that comes back from an archive this window did not close is whole, but the acts inside
    // it were this window's memory and did not survive the process (U7, U30). Without the sentence
    // the bar is simply empty, which reads as "nothing has been done here" rather than as history it
    // cannot reach. The sentence is the whole change: no control, no box, no second copy.
    expect(copy.status.reopenedTab({ name: 'drift over time', historyLost: true })).toBe(
      'Reopened \u201cdrift over time\u201d \u00b7 changes made before the restart cannot be undone here.',
    )
    // A reopen of a tab this window closed keeps the plain sentence, because its acts came back.
    expect(copy.status.reopenedTab({ name: 'drift over time' })).toBe('Reopened \u201cdrift over time\u201d.')
    // And a tab that was just created has nothing older to explain.
    expect(copy.status.tabSaved({ name: 'regimes', replaced: false, panel })).not.toContain('cannot be undone')
    expectPlain(
      copy.status.reopenedTab({ name: 'drift over time', historyLost: true }),
      'reopened tab whose earlier changes are out of reach',
    )
  })

  it('announces that sentence rather than a shorter name', async () => {
    // The row that shows it is a live region, so its text is what assistive tech reads: the one
    // sentence is the accessible name. An `aria-label` there would replace the sentence with a
    // shorter one and hide the fact it exists.
    const html = await readFile(join(renderer, 'index.html'), 'utf8')
    const row = html.match(/<div id="entry-status"[^>]*>/)
    expect(row).not.toBe(null)
    expect(row[0]).toContain('role="status"')
    expect(row[0]).toContain('aria-live="polite"')
    expect(row[0]).not.toMatch(/aria-label|aria-labelledby/)
  })

  it('gives the reopen the fact its history is gone, and says it from one owner', async () => {
    // The halves above are unit-tested; this is the seam between them. `closed-tabs.js` can report
    // the fact and `copy.js` can word it, and the window would still say nothing if the reopen did
    // not pass one to the other — so the call itself is held to it.
    const source = await readFile(join(renderer, 'tab-actions.js'), 'utf8')
    const call = source.match(/copyStatus\.reopenedTab\(\{[^}]*\}\)/)
    expect(call).not.toBe(null)
    expect(call[0]).toContain('historyLost')
    // And no other renderer module composes the sentence: `copy.js` is the one owner of the words.
    const others = (await readdir(renderer)).filter((file) => file.endsWith('.js') && file !== 'copy.js')
    for (const file of others) {
      expect(await readFile(join(renderer, file), 'utf8')).not.toContain('cannot be undone here')
    }
  })

  it('labels the controls with words, never an ellipsis', () => {
    Object.values(copy.labels).forEach((label) => {
      expect(label).not.toMatch(/…$/)
      expectPlain(label, `label ${label}`)
    })
  })

  it('says what renaming and copying a tab did, and what the copy becomes', () => {
    expect(copy.status.renamedTab({ from: 'drift', name: 'drift over time' })).toBe(
      'Renamed “drift” to “drift over time”. The drawing is unchanged.',
    )
    expect(copy.status.duplicatedTab({ from: 'drift', name: 'drift copy' })).toBe(
      'Copied “drift” as “drift copy”. The copy is a tab of its own.',
    )
    // The two acts a tab menu offers open a sheet, and the sheet says what each one will mean: the
    // difference between them is one word, and it is the whole difference.
    expect(copy.tabMenu.rename.endsWith('…')).toBe(true)
    expect(copy.tabMenu.duplicate.endsWith('…')).toBe(true)
    expect(copy.tabMenu.close.endsWith('…')).toBe(false)
    expect(copy.nameSheet.rename.note).not.toBe(copy.nameSheet.duplicate.note)
  })
})

describe('a refusal', () => {
  // The core writes for an agent and names the record, dataset or shape it checked. Those are how
  // the log is addressed, not what the person was doing, so they never reach the strip.
  const core = [
    `no point with id "${POINT_ID}"`,
    `point "${POINT_ID}" is already retracted`,
    `point "${POINT_ID}" is not retracted`,
    `dataset "main" has no active points`,
    'no dataset "main"',
    'missing required field "y" for shape xy.v1',
    'field "x" expects a finite number, got "seven"',
    'that removal is no longer the one in force',
    'no point with id "01M58Y41VF83K6TQ8XWWK9VN0S"',
    'shape "xy.v1" is not the latest version',
    'dataset "main" has no version 2',
    'nothing to retract; `bench list` shows active points',
    `point "${POINT_ID}" has been withdrawn`,
  ]

  it('says the consequence, never the handle the core used', () => {
    core.forEach((message) => {
      const text = copy.refusal(message)
      expectPlain(text, `refusal: ${message}`)
      expect(text.length, `refusal: ${message}`).toBeGreaterThan(8)
      // No stray punctuation where a name was taken out.
      expect(text, `refusal: ${message}`).not.toMatch(/\s{2}|\s[,.;:]|"\s*"/)
    })
  })

  it('keeps the two refusals a person can act on', () => {
    expect(copy.refusal(core[1])).toBe('That point has already been removed')
    expect(copy.refusal(core[2])).toBe('That point is still in the data')
    expect(copy.refusal(core[3])).toBe('That dataset has no points yet')
    expect(copy.refusal(core[4])).toBe('That dataset is not in the project')
    // A withdrawn row is not a retraction refused and not a number to fix: it is a record that is no
    // longer there, which is why the strip ends instead of asking for the Save again.
    expect(copy.refusal(core[12])).toBe('That point has been withdrawn')
    expect(copy.refusal('nothing to retract; `bench list` shows active points')).toBe('Nothing to retract')
    // A field name is the person's own word, so it stays; only the shape it was checked against goes.
    expect(copy.refusal(core[6])).toBe('Field "x" expects a finite number, got "seven"')
    expect(copy.refusal(core[5])).toBe('Missing required field "y"')
    expect(copy.refusal('')).toBe('That point was not saved.')
  })

  it('names the act each direction would repeat, in the words the table pairs with it', () => {
    // The labels and phrases are this file's; `acts.js`'s one table pairs them with a kind and an
    // effect. These are the pieces that table reads, so a fifth act cannot grow a second set of words.
    expect(copy.labels.undoPoint).toBe('Undo added point')
    expect(copy.labels.undoRemoval).toBe('Undo removal')
    expect(copy.labels.undoCorrection).toBe('Undo correction')
    expect(copy.labels.undoImport).toBe('Undo import')
    expect(copy.labels.redoPoint).toBe('Redo added point')
    expect(copy.labels.redoRemoval).toBe('Redo removal')
    expect(copy.labels.redoCorrection).toBe('Redo correction')
    expect(copy.labels.redoImport).toBe('Reapply import')
    expect(copy.labels.undo).toBe('Undo')
    expect(copy.labels.redo).toBe('Redo')

    expect(copy.actTitle('undo', copy.labels.actRemoval)).toBe(
      'Undo the last point removed here (Ctrl+Z in an empty field)',
    )
    expect(copy.actTitle('undo', copy.labels.actCorrection)).toContain('correction')
    expect(copy.actTitle('undo', copy.labels.actImport)).toContain('import')
    // The other direction names the same act in its own grammar, so the buttons read as a pair.
    expect(copy.actTitle('redo', copy.labels.actCorrectionRedo)).toBe(
      'Redo the correction made here (Ctrl+Shift+Z or Ctrl+Y in an empty field)',
    )
    expect(copy.actTitle('redo', copy.labels.actImportRedo)).toContain('import')
    expect(copy.idleActTitle('undo')).toBe('Nothing to undo yet (Ctrl+Z in an empty field)')
    expect(copy.idleActTitle('redo')).toBe('Nothing to redo yet')
    // A correction that is undone says so, and still names the panel that needs rerunning.
    expect(copy.status.correctionUndone({ active: 15, stalePanels: 1 })).toBe(
      'Correction undone · 15 points in this tab · 1 analysis panel is out of date until it is run again',
    )
    // An import's undo names the consequence, not a version number: the log keeps those.
    expect(copy.status.importUndone({ active: 14 })).toBe(
      'Restored the data from before the import · 14 points in this tab',
    )
    expect(copy.status.importReapplied({ active: 5 })).toBe('Reapplied the import · 5 points in this tab')
  })
})

describe('an empty panel and a recipe footer', () => {
  it('draws a sentence, never the shape\u2019s own command', () => {
    const text = copy.panelEmpty()
    expectPlain(text, 'empty panel')
    expect(text).toBe('No observations yet. Add the first point below.')
    const label = copy.accessibleLabel(
      { ...panel, n: 0, verdict: undefined, chart: { ...panel.chart, empty: 'No observations in main yet. Add one: add --values \'{"x":1.2}\'' } },
      'first tab',
      'Plot \u00b7 0 points',
      '',
    )
    expectPlain(label, 'empty accessible name')
    expect(label).toContain('No observations yet. Add the first point below.')
  })

  it('reads its degrees of freedom from the numbers, never an abbreviation', () => {
    const label = copy.accessibleLabel(
      { ...panel, chart: { ...panel.chart, evidence: { points: 14, parameters: 2, dof: 10 } } },
      panel.title,
      'Change over time \u00b7 14 points',
      '',
    )
    expectPlain(label, 'recipe accessible name')
    expect(label).toContain('10 degrees of freedom')
    expect(label).not.toMatch(/DOF/)
  })
})

describe('the import sheet', () => {
  const preview = { rows: 5, columns: ['taken_at', 'x', 'y'], comments: 2, raggedRows: 0, duplicate: false, parent: 2, parentRows: 5 }
  const planned = { rows: 5, parent: 2, version: 3, diff: { added: 1, removed: 2, changed: 1 }, removedRows: [{ t: '2026-01-05T09:03:00.000Z' }], ignoredColumns: ['note'], warnings: [] }

  it('says what the file holds without a version or a shape', () => {
    const text = copy.importSummary(preview, ['x', 'y'])
    expectPlain(text, 'import summary')
    expect(text).toBe('5 rows \u00b7 3 columns \u00b7 2 comment lines skipped \u00b7 replaces the 5 rows here now \u00b7 map a column onto x, y')
  })

  it('says what the click will do without version arithmetic', () => {
    const text = copy.importPlan(planned)
    expectPlain(text, 'import plan')
    expect(text).toBe('5 rows \u00b7 1 added, 2 removed, 1 changed \u00b7 1 row not in this file will be withdrawn, not deleted \u00b7 ignoring note')
    expect(copy.importButton(planned)).toBe('Import 5 rows')
    expect(copy.importButton(null)).toBe('Import')
    expectPlain(copy.importButton(planned), 'import button')
  })

  it('says a first import is the first import', () => {
    const text = copy.importPlan({ ...planned, parent: null, diff: { added: 5, removed: 0, changed: 0 }, removedRows: [], ignoredColumns: [] })
    expect(text).toBe('5 rows \u00b7 all new')
    expectPlain(text, 'first import plan')
  })

  it('states where the times come from, and says an estimate is one', () => {
    // The sheet's guess is a sentence, not a column id in a select nobody opened.
    expect(copy.importTimeSaid({ column: 'taken_at' })).toBe('Time: from the “taken_at” column')
    expect(copy.importTimeSaid({ field: 'date' })).toBe('Time: from the “date” field')
    expect(copy.importTimeSaid({ estimated: true })).toBe(
      'Time: the row order — every row is marked estimated',
    )
    expect(copy.importTimeSaid({})).toBe('Time: not chosen yet')
    expect(copy.importTimeChange).toBe('Change')
    // The choice that stands in for a clock says what it costs, before it is taken.
    expect(copy.importTimeEstimate).toContain('estimated')
    ;[copy.importTimeSaid({ column: 'taken_at' }), copy.importTimeSaid({ estimated: true })].forEach(
      (text) => expectPlain(text, 'import time line'),
    )

    const estimated = copy.importPlan({ ...planned, estimated: true, ignoredColumns: [], removedRows: [] })
    expect(estimated).toContain('times estimated from the row order')
    expectPlain(estimated, 'estimated import plan')
    expect(
      copy.status.imported({ rows: 2, first: true, added: 2, removed: 0, changed: 0, estimated: true }),
    ).toBe('Imported 2 rows · first version · times estimated from the row order (correct a point to replace one)')
    expect(
      copy.status.imported({ rows: 2, first: true, added: 2, removed: 0, changed: 0 }),
    ).toBe('Imported 2 rows · first version')
  })
})

describe('the renderer cannot put log vocabulary back', () => {
  it('keeps every composed string in copy.js', async () => {
    const files = (await readdir(renderer)).filter((name) => name.endsWith('.js') && name !== 'copy.js')
    expect(files.length).toBeGreaterThan(5)
    for (const name of files) {
      const source = await readFile(join(renderer, name), 'utf8')
      expect(source, name).not.toMatch(ULID)
      // A quoted event name is a string on its way to the screen; the same word in a comment is an
      // explanation of the log, which is allowed.
      for (const event of EVENT_NAMES) {
        expect(source, `${name} mentions ${event}`).not.toMatch(
          new RegExp(`['"]${event}['"]`),
        )
      }
      // The two shapes the first defect took: an id written into text, and a provenance line built
      // by hand.
      expect(source, `${name} writes an id into text`).not.toMatch(
        /textContent\s*=[^\n]*(\.id\b|provenance)/,
      )
      // The shortcut this pass removed: rewriting the core's words inside the drawing after mount.
      // The drawing is chrome-free in the window, and every word a person reads is DOM from copy.js.
      expect(source, `${name} edits the drawing`).not.toMatch(
        /(querySelector(?:All)?\(['"]svg|textContent\s*=[^\n]*footer)/,
      )
      // The drawing's facts arrive as numbers; no module re-reads the artifact's prose line.
      expect(source, `${name} reads a footer`).not.toMatch(/\.footer\b/)
      expect(source, `${name} splits a footer`).not.toMatch(/footer\.split|\.split\(['"] · ['"]\)/)
    }
  })

  it('holds copy.js itself to the same rule', async () => {
    const source = await readFile(join(renderer, 'copy.js'), 'utf8')
    expect(source).not.toMatch(ULID)
    for (const event of EVENT_NAMES) {
      expect(source).not.toMatch(new RegExp(`['"\`]${event}['"\`]`))
    }
    // Words never branch on which kind of act they describe: the one table in acts.js does that,
    // and copy.js should not grow a second list of kinds behind it.
    expect(source).not.toMatch(/\bnext\.kind\b|\bentry\.kind\b/)
    expect(source).not.toMatch(/kind === '(point|removal|correction|import)'/)
  })
})
