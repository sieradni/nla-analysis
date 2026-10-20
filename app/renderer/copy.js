/*
 * The window's words.
 *
 * Every string a person reads in the window is composed here: the hover readout, the entry bar's
 * statuses, a panel's facts and its state word, the empty states, and the labels on the shell's
 * controls. Nothing else in `app/renderer` writes a sentence a person reads.
 *
 * The rule this file enforces is ADR 0015: the window speaks to the person, the log speaks to the
 * agent. A record id, an event name, a dataset or shape id, a version and a command are agent
 * vocabulary; they never appear in a primary label, a tooltip, a status or an empty state. If a
 * string needs one of those to make sense, the string is wrong, not the reader.
 *
 * It is deliberately free of DOM access and of imports, so `tests/window-copy.test.ts` can call it
 * directly and assert the rule rather than trusting a review.
 */

var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `1 point` / `14 points`, never `1 point(s)`. */
export function plural(count, singular, many) {
  var number = typeof count === 'number' && isFinite(count) ? count : 0
  var word = number === 1 ? singular : many || singular + 's'
  return number + ' ' + word
}

/**
 * A measured value as a person reads it: at most three significant digits, thousands separated by
 * a space, trailing zeros trimmed. One format for the hover, the status and the caption, because
 * the same number must not read two ways on one screen.
 */
export function formatValue(value) {
  if (typeof value !== 'number' || !isFinite(value)) return '—'
  if (value === 0) return '0'
  var magnitude = Math.abs(value)
  if (magnitude >= 1e9 || magnitude < 1e-3) {
    return value.toExponential(2).replace('e+', 'e')
  }
  var rounded = Number(value.toPrecision(3))
  var text = String(rounded)
  if (/e/.test(text)) return text.replace('e+', 'e')
  var parts = text.split('.')
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  return parts.join('.')
}

/** `19 Oct 2026`: a calendar day, for a list where the time of day is noise. */
export function formatDay(iso) {
  var full = formatInstant(iso)
  return full === '' ? '' : full.split(',')[0]
}

/** `19 Oct 2026, 06:00`. A time a person can compare at a glance, not an ISO string. */
export function formatInstant(iso) {
  if (typeof iso !== 'string' || iso === '') return ''
  var date = new Date(iso)
  if (isNaN(date.getTime())) return ''
  var day = String(date.getUTCDate()).padStart(2, '0')
  var month = MONTHS[date.getUTCMonth()]
  var hours = String(date.getUTCHours()).padStart(2, '0')
  var minutes = String(date.getUTCMinutes()).padStart(2, '0')
  return day + ' ' + month + ' ' + date.getUTCFullYear() + ', ' + hours + ':' + minutes
}

/** A field's name and unit, as the axis spec spells them: `temperature (°C)`. */
function axisWord(panel, side) {
  var spec = (panel && panel.chart && panel.chart[side]) || {}
  var label = spec.label || side
  return spec.unit ? label + ' (' + spec.unit + ')' : label
}

function fieldSpec(panel, name) {
  var chart = (panel && panel.chart) || {}
  var side = chart.y && chart.y.label === name ? 'y' : chart.x && chart.x.label === name ? 'x' : null
  var spec = side === null ? {} : chart[side]
  return { label: spec.label || name, unit: spec.unit || '' }
}

/** `x 6.5 · y 16.4`: the values of one record, in the panel's own words. */
export function describeValues(values, panel) {
  if (!values) return ''
  return Object.keys(values)
    .filter(function (name) {
      return values[name] !== undefined && values[name] !== null && values[name] !== ''
    })
    .map(function (name) {
      var value = values[name]
      var spec = fieldSpec(panel, name)
      var shown =
        typeof value === 'number' ? formatValue(value) : typeof value === 'string' ? value : String(value)
      return spec.label + ' ' + shown + (spec.unit ? ' ' + spec.unit : '')
    })
    .join(' · ')
}

/**
 * The hover readout: what this point measured. Values with their labels and units, and the
 * observation time only when time is not already one of the axes. Never a record id, a dataset, a
 * shape, a recipe or a version.
 */
/** One drawn value: the axis's label and unit, and the number as a person reads it. */
function axisValue(spec, fallback, value) {
  var axis = spec || {}
  var shown =
    axis.format === 'time' && typeof value === 'number'
      ? formatInstant(new Date(value).toISOString())
      : formatValue(value)
  return (axis.label || fallback) + ' ' + shown + (axis.unit ? ' ' + axis.unit : '')
}

export function tooltipLines(point, panel) {
  var chart = (panel && panel.chart) || {}
  var values = []
  if (point && typeof point.x === 'number') values.push(axisValue(chart.x, 'x', point.x))
  if (point && typeof point.y === 'number') values.push(axisValue(chart.y, 'y', point.y))
  var lines = values.length > 0 ? [values.join(' · ')] : []
  var timeAxis = (chart.x && chart.x.format === 'time') || (chart.y && chart.y.format === 'time')
  if (!timeAxis && point && point.tObserved) lines.push('Observed ' + formatInstant(point.tObserved))
  return lines
}

/** A dataset choice in the tab sheet: its name only when there is more than one to tell apart. */
export function datasetOption(dataset, datasetCount) {
  var points = plural(dataset.active, 'point')
  return datasetCount > 1 ? dataset.id + ' · ' + points : points
}

/** The built-in shape's option in the create dialog: its fields, not its id. */
export function builtInShape(fields) {
  return (
    'The built-in shape · ' +
    fields
      .map(function (field) {
        return field.name
      })
      .join(', ')
  )
}

/** The method a recipe panel ran, in a person's words. */
export function recipeName(recipe) {
  if (recipe === 'fit') return 'Linear fit'
  if (recipe === 'drift') return 'Change over time'
  // A recipe added later must extend this map; a method id is not a sentence.
  return 'Analysis'
}

/** A panel's facts: the method and how many points it drew. The verdict is its own chip, with a
 * hover, so it is not repeated here. */
export function panelFacts(panel) {
  var parts = [panel.recipe ? recipeName(panel.recipe) : 'Plot']
  if (typeof panel.n === 'number') parts.push(plural(panel.n, 'point'))
  return parts.join(' · ')
}

/** The verdict word, capitalised for a label. */
export function verdictWord(verdict) {
  if (typeof verdict !== 'string' || verdict === '') return ''
  return verdict.charAt(0).toUpperCase() + verdict.slice(1)
}

/**
 * What the verdict means for the reader: whether the curve is trustworthy, and what would change
 * that. No statistics vocabulary and no abbreviation: this is the sentence a newcomer needs.
 */
export function verdictExplanation(verdict) {
  if (verdict === 'insufficient') {
    return 'Not enough observations to judge a relationship yet. Add another point or two.'
  }
  if (verdict === 'tentative') {
    return 'The data cannot rule out no trend yet. More observations would make this test meaningful.'
  }
  if (verdict === 'supported') {
    return 'The data supports a change over time rather than a flat line.'
  }
  if (verdict === 'contradicted') {
    return 'A flat line explains the data better than this curve does.'
  }
  return 'This panel has no verdict to explain.'
}

/**
 * The evidence line under a chart, composed from the numbers the drawing was made with: its count,
 * its fit parameters, its degrees of freedom and its band, with the verdict left to the chip beside
 * it. No sentence is parsed back into facts here — the core hands over the facts themselves.
 */
export function panelEvidence(panel) {
  var evidence = panel && panel.chart && panel.chart.evidence
  if (!evidence || typeof evidence.points !== 'number') return ''
  var parts = ['n = ' + evidence.points]
  if (evidence.skipped) {
    parts.push(
      plural(evidence.skipped.points, 'point') +
        ' without ' +
        evidence.skipped.x +
        '/' +
        evidence.skipped.y +
        ' not plotted',
    )
  }
  if (evidence.regimes) {
    parts.push(evidence.regimes + ' regimes of ' + plural(evidence.parameters, 'parameter'))
  } else if (typeof evidence.parameters === 'number') {
    parts.push(plural(evidence.parameters, 'parameter'))
  }
  if (typeof evidence.dof === 'number') {
    parts.push(plural(evidence.dof, 'degree of freedom', 'degrees of freedom'))
  }
  if (evidence.noCurve === 'unmodelled') parts.push('no fit — unmodelled')
  else if (evidence.noCurve === 'insufficient') parts.push('no curve drawn')
  else if (evidence.noCurve === 'segments') parts.push('segments need ' + plural(evidence.needed, 'point'))
  if (evidence.band) parts.push(Math.round(evidence.band.level * 100) + '% ' + evidence.band.kind + ' band')
  return parts.join(' · ')
}

/**
 * The tab's facts. A dataset named `main` in a single-dataset project is not information, and a
 * version list at tab level is agent vocabulary; the panel's own state word carries what differs.
 */
export function tabFacts(panelCount, active) {
  return plural(panelCount, 'panel') + ' · ' + plural(active, 'point')
}

/**
 * One panel's state, in words that ask for something or say nothing. `current` is silence: a badge
 * that requires no action is attention spent for nothing (ADR 0015).
 */
export function panelStatus(state) {
  if (state === 'stale') {
    return {
      label: 'Out of date',
      title: 'This panel was drawn before the data changed. Refresh to redraw it.',
    }
  }
  if (state === 'missing') {
    return { label: 'Data gone', title: 'The data this panel needs is no longer in the project.' }
  }
  if (state === 'unchecked') {
    return {
      label: 'Cannot tell',
      title: 'This panel has no stored fingerprint to compare, so the window cannot say whether it is up to date.',
    }
  }
  return { label: '', title: '' }
}

/** The notice above the panels, when any of them is no longer drawn from this project. */
export function notice(statuses) {
  var behind = (statuses || []).filter(function (status) {
    return status.state === 'stale' || status.state === 'missing'
  })
  if (behind.length === 0) return ''
  var gone = behind.some(function (status) {
    return status.state === 'missing'
  })
  return (
    plural(behind.length, 'panel') +
    (behind.length === 1 ? ' no longer matches' : ' no longer match') +
    ' this project.' +
    (gone ? ' Some of the data it needs is gone.' : '') +
    ' Refresh to redraw' +
    (behind.length === 1 ? ' it.' : ' them.')
  )
}

/** The one sentence an empty panel draws. No command, no dataset, no shape. */
export function panelEmpty() {
  return 'No observations yet. Add the first point below.'
}

/** The import sheet's header: what the file holds, in counts a person reads without a schema. */
export function importSummary(preview, unmapped) {
  var parts = [plural(preview.rows, 'row'), plural(preview.columns.length, 'column')]
  if (preview.comments > 0) parts.push(plural(preview.comments, 'comment line') + ' skipped')
  if (preview.raggedRows > 0) parts.push(plural(preview.raggedRows, 'row') + ' with a different field count')
  if (preview.duplicate) parts.push('these exact contents are already here')
  parts.push(
    preview.parent === null
      ? 'first import'
      : 'replaces the ' + plural(preview.parentRows, 'row') + ' here now',
  )
  if (unmapped && unmapped.length > 0) parts.push('map a column onto ' + unmapped.join(', '))
  return parts.join(' · ')
}

/**
 * What the import will do, before the click: rows and what changes about them. The version number
 * and the `+1 −2 ~1` arithmetic are agent vocabulary and stay out of the window (U10).
 */
export function importPlan(planned) {
  var parts = [plural(planned.rows, 'row')]
  if (planned.parent === null) parts.push('all new')
  else
    parts.push(
      countPart(planned.diff.added, 'added') +
        ', ' +
        countPart(planned.diff.removed, 'removed') +
        ', ' +
        countPart(planned.diff.changed, 'changed'),
    )
  if (planned.removedRows && planned.removedRows.length > 0) {
    parts.push(
      plural(planned.removedRows.length, 'row') +
        ' not in this file will be withdrawn, not deleted',
    )
  }
  if (planned.ignoredColumns && planned.ignoredColumns.length > 0) {
    parts.push('ignoring ' + planned.ignoredColumns.join(', '))
  }
  if (planned.warnings && planned.warnings.length > 0) parts.push(refusal(planned.warnings[0]))
  return parts.join(' · ')
}

/** The import button says what the click does, and nothing else. */
export function importButton(planned) {
  return planned ? 'Import ' + plural(planned.rows, 'row') : 'Import'
}

export var labels = {
  importTitle: 'Import a file',
  newProject: 'New project',
  openProject: 'Open project',
  newTab: 'New tab',
  undo: 'Undo last point',
  importFile: 'Import file',
  refresh: 'Refresh',
  saveCorrection: 'Save correction',
  addPoint: 'Add point',
  cancel: 'Cancel',
}

/** Put the shell's own labels on the controls, so the HTML file is not a second copy of them. */
export function applyStatic(ui) {
  if (ui.newProject) ui.newProject.textContent = labels.newProject
  if (ui.openProject) ui.openProject.textContent = labels.openProject
  if (ui.newTab) ui.newTab.textContent = labels.newTab
  if (ui.entryUndo) ui.entryUndo.textContent = labels.undo
  if (ui.importOpen) ui.importOpen.textContent = labels.importFile
  if (ui.entryCancel) ui.entryCancel.textContent = labels.cancel
}

/**
 * The statuses the entry bar says. They name the measurement, not the record: no id, no event name,
 * no dataset, and no narration of what the log wrote.
 */
export var status = {
  saved: function (change) {
    var text = 'Saved · ' + plural(change.active, 'point') + ' in this tab'
    if (change.warnings && change.warnings.length > 0) {
      text +=
        ' · ' +
        change.warnings
          .map(function (warning) {
            return refusal(warning)
          })
          .join('; ')
    }
    if (change.reread) text += ' · the project had changed on disk, so it was reread first'
    return text
  },
  corrected: function (change) {
    var text = 'Corrected · ' + plural(change.active, 'point') + ' in this tab'
    if (change.stalePanels > 0) {
      text +=
        ' · ' +
        plural(change.stalePanels, 'analysis panel') +
        (change.stalePanels === 1
          ? ' is out of date until it is run again'
          : ' are out of date until they are run again')
    }
    return text
  },
  removed: function (change) {
    return 'Removed · ' + plural(change.active, 'point') + ' left in this tab'
  },
  editing: function (change) {
    return 'Editing ' + describeValues(change.values, change.panel) + ' · Escape cancels'
  },
  correctionRow: function (change) {
    var text = describeValues(change.values, change.panel)
    if (change.observed) text += ' · observed ' + formatInstant(change.observed)
    if (change.corrections > 0) text += ' · ' + plural(change.corrections, 'correction') + ' already'
    if (change.stalePanels > 0) text += ' · an analysis panel will need to run again'
    return text
  },
  undoTitle: function (lastPoint) {
    return lastPoint
      ? 'Undo the last point added here (Ctrl+Z in an empty field)'
      : 'Nothing to undo: no point has been added from this window'
  },
  readoutTitle: function () {
    return 'Points in this tab. The millisecond figure is Enter to painted frame.'
  },
  idleHint: function () {
    // The one action in this bar that has no button of its own. Shift+Arrow steps between points,
    // not versions or panels, so it says "point".
    return 'Click a point to edit it · Shift+Arrow moves to the next or previous point.'
  },
  tabSaved: function (change) {
    return (
      (change.replaced ? 'Replaced' : 'Created') +
      ' the tab “' +
      change.name +
      '” · ' +
      panelFacts(change.panel) +
      '.'
    )
  },
  rereadTab: function () {
    return 'The project had changed on disk, so it was reread before this tab was drawn.'
  },
  rereadAfterWrite: function () {
    return 'The project changed on disk while this tab was open, so it was reread and redrawn.'
  },
  tabChanged: function (change) {
    return (
      'The project changed on disk: “' +
      change.name +
      '” was reread and redrawn' +
      (typeof change.active === 'number' ? ' · ' + plural(change.active, 'point') : '') +
      '.'
    )
  },
  tabRemoved: function (change) {
    return (
      '“' +
      change.name +
      '” was removed on disk. ' +
      (change.remaining === 0
        ? 'This project has no tabs left.'
        : plural(change.remaining, 'other tab') +
          (change.remaining === 1 ? ' remains.' : ' remain.'))
    )
  },
  couldNotSave: function (message) {
    return 'The point is recorded, but this tab could not be saved: ' + message
  },
  couldNotReread: function (message) {
    return 'The project changed on disk, but this tab could not be reread: ' + message
  },
  couldNotFollow: function (message) {
    return 'This tab will not follow the project on disk: ' + message
  },
  imported: function (change) {
    var counts =
      countPart(change.added, 'added') +
      ', ' +
      countPart(change.removed, 'removed') +
      ', ' +
      countPart(change.changed, 'changed')
    var text =
      'Imported ' +
      plural(change.rows, 'row') +
      ' · ' +
      (change.first ? 'first version' : counts)
    if (!change.first && change.removedRows > 0) {
      text +=
        ' · ' +
        plural(change.removedRows, 'row') +
        (change.removedRows === 1 ? ' not in the file was' : ' not in the file were') +
        ' withdrawn; the earlier version still holds ' +
        (change.removedRows === 1 ? 'it' : 'them')
    }
    if (change.ignoredColumns && change.ignoredColumns.length > 0) {
      text += ' · ignored ' + change.ignoredColumns.join(', ') + ' (no field for them)'
    }
    if (change.warnings && change.warnings.length > 0) text += ' · ' + refusal(change.warnings[0])
    return text
  },
  refreshed: function (statuses) {
    var behind = (statuses || []).filter(function (panel) {
      return panel.state === 'stale' || panel.state === 'missing'
    }).length
    if (behind === 0) return 'Refreshed · every panel is up to date'
    return (
      'Refreshed the panels it could. ' +
      plural(behind, 'panel') +
      (behind === 1 ? ' still needs' : ' still need') +
      ' its analysis run again.'
    )
  },
  refreshFailed: function (message) {
    return 'The panels could not be refreshed: ' + message
  },
  projectListProblem: function (problem) {
    return problem + ' — the list of projects is a convenience; the projects themselves are untouched.'
  },
}

/** `2 added` / `none added`: a diff count said in words, never `+2 −0 ~1`. */
function countPart(count, word) {
  return count === 0 ? 'none ' + word : count + ' ' + word
}

/**
 * A refusal, in words a person can act on. The core's message is written for an agent and can name
 * the shape it was checked against; the shape is agent vocabulary, so it leaves the screen.
 */
export function refusal(message) {
  var text = String(message || 'That point was not saved.')
    .replace(/\s+(?:for|in) shape\s+[A-Za-z0-9_.-]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (text === '') return 'That point was not saved.'
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** Empty states: what this screen is for and the one button that leaves it. */
export var empty = {
  noTabs: function (problem) {
    return (
      problem || 'A tab is a saved question: which dataset it reads and which of its fields it plots.'
    )
  },
  noProjects: function () {
    return 'A project is a folder with an append-only history. Create one here, or open a folder you already have.'
  },
  tabRemoved: function (name) {
    return (
      '“' + name + '” is no longer in this project’s views. Another writer replaced or deleted it; the project is still open.'
    )
  },
}

/**
 * A panel's accessible name. The canvas hides both SVG halves from the accessibility tree, so this
 * carries the drawing in words — but only the words a person needs: what it is, its axes, its count
 * and its state. Not the dataset, the shape, the full caption or a duplicate footer.
 */
export function accessibleLabel(panel, title, facts, stateLabel) {
  var chart = (panel && panel.chart) || {}
  var parts = [title + '.', 'x ' + axisWord(panel, 'x') + ', y ' + axisWord(panel, 'y') + '.']
  // The evidence line carries the degrees of freedom a recipe drawing needs; it is composed once,
  // here and in the DOM under the drawing, from the same numbers.
  var evidence = panelEvidence(panel)
  if (evidence) parts.push(evidence + '.')
  if (panel.verdict) parts.push(verdictWord(panel.verdict) + '. ' + verdictExplanation(panel.verdict))
  if (chart.caption) parts.push(chart.caption)
  if (chart.empty) parts.push(panelEmpty())
  if (stateLabel) parts.push(stateLabel + '.')
  parts.push(facts + '.', 'Drag to pan, wheel to zoom.')
  return parts.join(' ')
}
