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

const renderer = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'renderer')
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
    const timed = copy.tooltipLines({ x: 1, y: 2, tObserved: '2026-10-19T06:00:00.000Z' }, panel)
    expect(timed.join(' ')).toContain('Observed 19 Oct 2026, 06:00')
    const timeAxis = {
      ...panel,
      chart: { ...panel.chart, x: { label: 'date', format: 'time' } },
    }
    const onAxis = copy.tooltipLines({ x: 1, y: 2, tObserved: '2026-10-19T06:00:00.000Z' }, timeAxis)
    expect(onAxis.join(' ')).not.toContain('Observed')
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

describe('the entry bar', () => {
  const values = { x: 6.5, y: 16.4 }

  it('reports what happened without ids, event names or a dataset', () => {
    const said = [
      copy.status.saved({ active: 15, warnings: ['field `temprature` is not in the shape'], reread: true }),
      copy.status.corrected({ active: 15, stalePanels: 1 }),
      copy.status.removed({ active: 14 }),
      copy.status.editing({ values, panel }),
      copy.status.correctionRow({ values, observed: '2026-10-19T06:00:00.000Z', corrections: 0, stalePanels: 0 }),
      copy.status.undoTitle({ id: POINT_ID }),
      copy.status.undoTitle(null),
      copy.status.readoutTitle(),
      copy.status.idleHint(),
      copy.status.rereadTab(),
      copy.status.rereadAfterWrite(),
      copy.status.tabChanged({ name: 'drift over time', active: 14 }),
      copy.status.tabRemoved({ name: 'drift over time', remaining: 1 }),
      copy.status.tabSaved({ name: 'regimes', replaced: false, panel }),
      copy.status.refreshed([{ state: 'current' }]),
      copy.status.refreshed([{ state: 'stale' }]),
      copy.empty.noTabs(),
      copy.empty.noProjects(),
      copy.empty.tabRemoved('regimes'),
    ]
    said.forEach((text, index) => expectPlain(text, `status ${index}: ${text}`))
    expect(copy.status.removed({ active: 14 })).toBe('Removed · 14 points left in this tab')
    expect(copy.status.editing({ values, panel })).toContain('Editing x 6.5 · y 16.4')
  })

  it('labels the controls with words, never an ellipsis', () => {
    Object.values(copy.labels).forEach((label) => {
      expect(label).not.toMatch(/…$/)
      expectPlain(label, `label ${label}`)
    })
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
  })
})
