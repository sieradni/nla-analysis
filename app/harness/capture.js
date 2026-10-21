/*
 * The review capture: read-only frames, the entry path, the import sheet, and the accessibility tree.
 *
 * One linear scenario, because the frames are the argument: each step is a thing a person does, and
 * each assertion is what the window should have said afterwards.
 */
import { app, clipboard, ipcMain } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  window,
  here,
  captureDir,
  capturePhase,
  writableDir,
  startupDir,
  startedAt,
  setNextStartup,
  setNextPickedFile,
} from './context.js'
import {
  sleep,
  typeText,
  focusWindowForInput,
  submitEntry,
  fieldValue,
  pressKey,
  pressEnter,
  focusField,
  entryState,
  waitForTiming,
  currentTimingId,
  runCli,
  readCli,
  enterPoint,
} from './driver.js'

/**
 * A frame taken by the renderer, not the window compositor. `capturePage` can return the surface it
 * last composited, which for a dialog that has just opened is the page underneath it.
 */
/**
 * Write one frame, retrying a sharing violation.
 *
 * A just-captured PNG in a repository folder can be locked for a few hundred milliseconds by the
 * scanner or the sync client on this platform, and `open` answers UV_UNKNOWN rather than a kind
 * this file could act on. A three-minute review must not die on that: the retry is what makes the
 * harness's own output the only thing it reports on.
 */
async function saveFrame(file, data) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await writeFile(file, data)
      return
    } catch (error) {
      if (attempt >= 8) throw error
      await sleep(300)
    }
  }
}

export async function rendererScreenshot() {
  const session = window.webContents.debugger
  if (!session.isAttached()) session.attach('1.3')
  const shot = await session.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: true })
  return Buffer.from(shot.data, 'base64')
}

/**
 * The image nodes Chromium actually exposes, not the attributes we put on them. A label that is
 * present in the DOM but ignored by the accessibility tree would pass an attribute check and fail
 * the screen reader, so the capture reads the tree.
 */
/** Acknowledge the columns the shape cannot store, which the core requires before it will plan. */
async function acknowledgeExtraColumns() {
  const checked = await window.webContents.executeJavaScript(`(() => {
    const field = document.getElementById('import-extra-field')
    const box = document.getElementById('import-ignore-extra')
    if (!field || field.hidden || !box) return false
    box.checked = true
    box.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  if (checked) await sleep(300)
  return checked
}

async function accessibilityImages() {
  const session = window.webContents.debugger
  if (!session.isAttached()) session.attach('1.3')
  const { nodes } = await session.sendCommand('Accessibility.getFullAXTree')
  return nodes
    .filter((node) => !node.ignored && node.role && node.role.value === 'image')
    .map((node) => ({
      name: (node.name && node.name.value) || '',
      description: (node.description && node.description.value) || '',
    }))
}

/** Wait for the bar to report a status matching `pattern`, and hand back the whole bar reading. */
async function waitStatus(pattern, what) {
  for (let waited = 0; waited < 120; waited += 1) {
    const state = JSON.parse(await entryState())
    if (pattern.test(state.status || '')) return state
    await sleep(100)
  }
  throw new Error(what + ' never reported: ' + (await entryState()))
}

/** What the bar's own undo button says, without pressing it. */
async function barUndo() {
  return JSON.parse(
    await window.webContents.executeJavaScript(`(() => {
      const button = document.getElementById('entry-undo')
      return JSON.stringify({ label: button.textContent, disabled: button.disabled })
    })()`),
  )
}

/** How many events a project's log holds, counting the lines: a write is visible here or nowhere. */
async function logCount(project) {
  return (await readFile(join(project, 'data', 'events.jsonl'), 'utf8')).trimEnd().split('\n').length
}

/**
 * A fresh process on the same project, for the turn that must survive a relaunch.
 *
 * Everything that could remember the closed tab — the renderer's module state, the main process, the
 * window — is gone in the child: only the project's own files are left. So this is the relaunch a
 * person actually performs, not a reload dressed as one.
 */
export async function captureRelaunch() {
  // The project is opened by the renderer after its first paint: wait for the tab it draws, not for
  // a timer that hopes the read finished.
  let started = JSON.parse(await entryState())
  for (let waited = 0; waited < 100 && started.tabs !== 1; waited += 1) {
    await sleep(100)
    started = JSON.parse(await entryState())
  }
  console.log(
    '[bench] relaunch-start ' +
      JSON.stringify({ tabs: started.tabs, status: started.status, readout: started.readout }),
  )
  if (started.tabs !== 1) {
    throw new Error('the relaunched window does not show the one tab that was left open: ' + started.tabs)
  }
  if (!(await focusWindowForInput())) throw new Error('the relaunched window never took focus')

  const project = startupDir
  const eventsBefore = await logCount(project)
  await focusField(0)
  pressKey('T', ['control', 'shift'])
  const reopened = await waitStatus(/^Reopened /, 'reopening a tab closed before the relaunch')
  // The status is written after the drawing, so wait for the drawing itself: the frame below is the
  // argument, and a frame caught mid-repaint would argue the opposite of the claim.
  let title = ''
  for (let waited = 0; waited < 100; waited += 1) {
    title = await window.webContents.executeJavaScript("document.getElementById('view-title').textContent")
    const now = JSON.parse(await entryState())
    if (title === 'drift over time' && now.tabs === 2 && now.meta === '2 panels · 16 points') break
    await sleep(100)
  }
  await sleep(400)
  const undoAfterRelaunch = await barUndo()
  console.log(
    '[bench] relaunch-reopened ' +
      JSON.stringify({
        status: reopened.status,
        title,
        readout: reopened.readout,
        tabs: reopened.tabs,
        undo: undoAfterRelaunch,
        eventsWritten: (await logCount(project)) - eventsBefore,
      }),
  )
  if (title !== 'drift over time') {
    throw new Error('the relaunched window reopened something else: ' + title)
  }
  if (!/n = 16/.test(reopened.readout || '')) {
    throw new Error('the tab came back without its data: ' + reopened.readout)
  }
  if (reopened.tabs !== 2) throw new Error('the reopened tab is not in the rail: ' + reopened.tabs)
  // The acts were the earlier window's memory. An empty bar is the truth, not a gap to paper over.
  if (undoAfterRelaunch.disabled !== true || undoAfterRelaunch.label !== 'Undo') {
    throw new Error('the relaunched tab claims acts it cannot have: ' + JSON.stringify(undoAfterRelaunch))
  }
  if ((await logCount(project)) !== eventsBefore) throw new Error('reopening after a relaunch wrote an event')
  // The renderer's own paint, not the last surface the compositor happened to hold: a hidden review
  // window can hand back the frame from before the repaint.
  await saveFrame(join(captureDir, 'app-tab-reopened-relaunch.png'), await rendererScreenshot())

  // And with the list empty, the chord stays quiet: no sentence, no write, no repaint.
  const statusBefore = JSON.parse(await entryState()).status
  await focusField(0)
  pressKey('T', ['control', 'shift'])
  await sleep(600)
  const empty = JSON.parse(await entryState())
  console.log(
    '[bench] relaunch-empty ' +
      JSON.stringify({
        status: empty.status,
        unchanged: empty.status === statusBefore,
        eventsWritten: (await logCount(project)) - eventsBefore,
        tabs: empty.tabs,
      }),
  )
  if (empty.status !== statusBefore) throw new Error('an empty closed list said something: ' + empty.status)
  if ((await logCount(project)) !== eventsBefore) throw new Error('an empty closed list wrote an event')
  if (empty.tabs !== 2) throw new Error('an empty closed list changed the rail')
  app.exit(0)
}

/**
 * Click a mark by record id with real pointer events, in whichever panel draws it, and wait for the
 * strip it opens. Returns the id it clicked, or null: a mark that is not drawn is not selectable, and
 * saying so beats a silent miss.
 */
async function selectMarkById(id) {
  const clicked = await window.webContents.executeJavaScript(`(() => {
    for (const host of document.querySelectorAll('.panel-chart')) {
      const marks = (host.__benchChart && host.__benchChart.marks()) || []
      const mark = marks.find((candidate) => candidate.id === ${JSON.stringify(id)})
      if (!mark) continue
      const at = { clientX: mark.x, clientY: mark.y }
      for (const type of ['pointerdown', 'pointerup']) {
        host.dispatchEvent(
          new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, ...at }),
        )
      }
      return mark.id
    }
    return null
  })()`)
  for (let waited = 0; clicked && waited < 40; waited += 1) {
    if (JSON.parse(await entryState()).correcting) break
    await sleep(100)
  }
  return clicked
}

export async function capture() {
  // The second process of the relaunch proof: a window with nothing but the project on disk.
  if (capturePhase === 'relaunch') return captureRelaunch()
  // The renderer's own errors, so a script that throws says why instead of just "failed to execute".
  // Content-Security-Policy violations are counted rather than printed: the core's chart markup sets
  // `font-variant-numeric` as an inline style, which the shell's `style-src 'self'` blocks, so every
  // axis label reports one and a stack of them buries whatever else the renderer said.
  /**
 * The window speaks to the person (ADR 0015). Every surface this harness photographs is read back
 * and refused if a record id, an event name, a dataset or shape id, a version or a command reached
 * it. This is the end-to-end half of `tests/window-copy.test.mjs`: that test holds the copy module,
 * this one holds the window.
 */
const LOG_VOCABULARY = /\b01[0-9A-HJKMNP-TV-Z]{24}\b|point_(recorded|corrected|retracted|restored)|dataset_version_created|shape_(defined|extended|time_designated)|analysis_run|import_completed|decision_recorded|project_created|\bmain\b|\b[a-z][a-z0-9_]*\.v\d+\b|\bbench\s+(?:--|init|add|correct|retract|import|view|chart|state|check|run|dataset|shape|decide|projects|recipes)\b|\bv\d+\b|\bDOF\b|\(s\)|\bversion \d|\+\d+ −\d+ ~\d+/

async function assertPlainSurface(where) {
  const seen = JSON.parse(
    await window.webContents.executeJavaScript(`(() => JSON.stringify({
      tooltip: document.getElementById('tooltip').textContent,
      status: document.getElementById('entry-status').textContent,
      readout: document.getElementById('entry-readout').textContent,
      meta: document.getElementById('view-meta').textContent,
      notice: document.getElementById('notice').textContent,
      facts: Array.prototype.map.call(document.querySelectorAll('.panel-facts'), (n) => n.textContent).join(' | '),
      badges: Array.prototype.map.call(document.querySelectorAll('.panel-strip .badge'), (n) => n.textContent).join(' | '),
      labels: Array.prototype.map.call(document.querySelectorAll('.panel-chart'), (n) => n.getAttribute('aria-label') || '').join(' | '),
      charts: Array.prototype.map.call(document.querySelectorAll('.panel-chart svg text'), (n) => n.textContent).join(' | '),
      evidence: Array.prototype.map.call(document.querySelectorAll('.panel-evidence'), (n) => n.textContent).join(' | '),
      empty: Array.prototype.map.call(document.querySelectorAll('.panel-empty'), (n) => n.textContent).join(' | '),
      menu: (() => {
        const menu = document.querySelector('.menu')
        return menu ? menu.textContent : ''
      })(),
      // The tab's menu and the sheet it opens say what the acts mean, so they are held to the same
      // rule as every other surface a person reads.
      tabMenu: (() => {
        const menu = document.querySelector('.menu')
        return menu ? menu.textContent : ''
      })(),
      tabSheet: (() => {
        const dialog = document.getElementById('rename-dialog')
        if (!dialog || !dialog.open) return ''
        return ['rename-dialog-title', 'rename-note', 'rename-label', 'rename-confirm', 'rename-error']
          .map((id) => {
            const element = document.getElementById(id)
            return element ? element.textContent : ''
          })
          .join(' | ')
      })(),
      sheet: (() => {
        const dialog = document.getElementById('import-dialog')
        if (!dialog || !dialog.open) return ''
        // The sheet's own words, not the chosen file's path or the sample cells: a file legitimately
        // called lab-export-v2.csv is not log vocabulary.
        return [
          'import-summary',
          'import-time-said',
          'import-plan',
          'import-apply',
          'import-time',
          'import-error',
        ]
          .map((id) => {
            const element = document.getElementById(id)
            return element ? element.textContent : ''
          })
          .join(' | ')
      })(),
    }))()`),
  )
  // Every visible word, including the drawing's own text and the evidence line under it. The
  // drawing is plain now — axes, grid, fits, marks, caption — so an id, a dataset name or a shape
  // version in it is a leak, not a frame this guard has not reached yet.
  for (const [surface, value] of Object.entries(seen)) {
    if (LOG_VOCABULARY.test(value)) {
      throw new Error(`log vocabulary in the ${surface} at ${where}: "${value}"`)
    }
  }
}

/**
 * Type one value into one entry field, proving the focus landed first. Writing a tab re-renders the
 * bar, and a keystroke sent during that repaint lands wherever the browser restores focus — which
 * showed up three steps later as a point missing its first field. The check is the fix.
 */
async function typeIntoField(index, text, name) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let focused = false
    for (let waited = 0; waited < 20 && !focused; waited += 1) {
      focused = await focusField(index)
      if (!focused) await sleep(50)
    }
    if (!focused) throw new Error(`entry field ${index} (${name}) could not take focus`)
    typeText(text)
    if ((await fieldValue(name)) === text) return
    // The bar re-renders when a point lands, replacing the input mid-keystroke. Clear what arrived
    // and type again into the input that is on screen now.
    await window.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('input[data-field="${name}"]')
      if (!input) return
      input.value = ''
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
    await sleep(100)
  }
  throw new Error(`entry field ${name} did not receive "${text}": "${await fieldValue(name)}"`)
}

/**
 * The verdict chip explains itself on hover and on keyboard focus, in a sentence a newcomer reads
 * without a glossary. Both paths are exercised, because a hover-only explanation is invisible to a
 * keyboard reader and this window has to work without a pointer.
 */
async function assertVerdictExplained(where) {
  // A hidden window does not take DOM focus, so a keyboard check has to be run against the shown
  // window — the same one the typing checks use.
  await focusWindowForInput()
  const seen = JSON.parse(
    await window.webContents.executeJavaScript(`(() => {
      const chip = document.querySelector('.panel-evidence .verdict')
      const tooltip = document.getElementById('tooltip')
      const read = () => (tooltip.hidden ? '' : tooltip.textContent)
      const result = { label: chip ? chip.textContent : '', hover: '', focus: '', focusable: false }
      if (!chip) return JSON.stringify(result)
      chip.dispatchEvent(new PointerEvent('pointerenter'))
      result.hover = read()
      chip.dispatchEvent(new PointerEvent('pointerleave'))
      result.focusable = chip.tabIndex >= 0 && document.activeElement !== chip
      chip.focus()
      result.focus = read()
      result.left = document.activeElement !== chip
      chip.blur()
      return JSON.stringify(result)
    })()`),
  )
  if (seen.label === '') throw new Error(`no verdict chip on the drawing at ${where}`)
  if (seen.hover === '') throw new Error(`the verdict "${seen.label}" explains nothing on hover at ${where}`)
  if (!seen.focusable) throw new Error(`the verdict chip cannot be reached from the keyboard at ${where}`)
  if (seen.focus !== seen.hover) throw new Error(`the verdict reads differently on focus at ${where}: "${seen.focus}"`)
  if (seen.hover.length < 40 || !/[.!]/.test(seen.hover)) {
    throw new Error(`the verdict explanation is not a sentence at ${where}: "${seen.hover}"`)
  }
  if (LOG_VOCABULARY.test(seen.hover)) {
    throw new Error(`log vocabulary in the verdict explanation at ${where}: "${seen.hover}"`)
  }
}

let cspViolations = 0
  window.webContents.on('console-message', (_event, level, message) => {
    if (/Content Security Policy/.test(message)) {
      cspViolations += 1
      return
    }
    if (level >= 2) console.log(`[renderer] ${message}`)
  })
  await mkdir(captureDir, { recursive: true })
  const paintedMs = Date.now() - startedAt
  const factors = [
    ['100', 1],
    ['125', 1.25],
    ['150', 1.5],
  ]

  /**
   * One frame at one scaling, plus what the layout did there. The zoom is a real zoom of the real
   * window; the facts come from the renderer's own boxes, so a control that wrapped or left the
   * window is caught at the scaling it broke at rather than in a frame nobody measured.
   */
  async function frameAt(factor, file) {
    window.webContents.setZoomFactor(factor)
    await sleep(600)
    await saveFrame(join(captureDir, file), (await window.webContents.capturePage()).toPNG())
    frames += 1
    const facts = JSON.parse(
      await window.webContents.executeJavaScript(`(() => {
        const box = (element) => {
          if (!element) return null
          const rect = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          return {
            top: Math.round(rect.top),
            bottom: Math.round(rect.bottom),
            right: Math.round(rect.right),
            w: Math.round(rect.width),
            h: Math.round(rect.height),
            visible: style.display !== 'none' && !element.hidden && rect.width > 0 && rect.height > 0,
            clipped: element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1,
          }
        }
        const inside = (box) => !!box && box.visible && box.right <= window.innerWidth && box.bottom <= window.innerHeight && box.top >= 0
        // How many lines a label really took: a button that wrapped is a control that asks to be
        // read twice, and a box measurement alone would not say so.
        const lines = (element) => {
          if (!element || !element.firstChild) return 0
          const range = document.createRange()
          range.selectNodeContents(element)
          return range.getClientRects().length
        }
        const meta = box(document.getElementById('view-meta'))
        const close = box(document.getElementById('close-tab'))
        return JSON.stringify({
          viewport: { w: window.innerWidth, h: window.innerHeight },
          overflowX: document.documentElement.scrollWidth - window.innerWidth,
          action: box(document.querySelector('#entry-status .status-action')),
          actionInView: inside(box(document.querySelector('#entry-status .status-action'))),
          actionLines: lines(document.querySelector('#entry-status .status-action')),
          undoInView: inside(box(document.getElementById('entry-undo'))),
          close: close,
          closeInView: inside(close),
          // A close control that wrapped under the tab's facts is still inside the window, and still
          // wrong: the header is one row.
          closeBelowHeader: !!(close && meta && meta.h > 0 && close.top >= meta.bottom - 1),
        })
      })()`),
    )
    window.webContents.setZoomFactor(1)
    await sleep(200)
    return {
      viewport: facts.viewport,
      overflowX: facts.overflowX,
      action: facts.action && facts.action.visible,
      actionInView: facts.actionInView,
      actionLines: facts.actionLines,
      closeInView: facts.closeInView,
      closeBelowHeader: facts.closeBelowHeader,
      undoInView: facts.undoInView,
    }
  }

  for (const [label, factor] of factors) {
    window.webContents.setZoomFactor(factor)
    // Two frames after a zoom change, so the capture never catches the previous layout.
    await new Promise((done) => setTimeout(done, 600))
    const image = await window.webContents.capturePage()
    await saveFrame(join(captureDir, `app-${label}.png`), image.toPNG())
    // Layout facts per scaling, not once at the end: each frame has to be checked at its own size.
    const layout = await window.webContents.executeJavaScript(`(() => {
      const box = (selector) => {
        const node = document.querySelector(selector)
        if (!node) return null
        const rect = node.getBoundingClientRect()
        return { w: Math.round(rect.width), h: Math.round(rect.height), right: Math.round(rect.right), bottom: Math.round(rect.bottom) }
      }
      const grid = document.querySelector('.grid')
      const panel = document.querySelector('.panel')
      return JSON.stringify({
        scale: ${JSON.stringify(label)},
        viewport: { w: window.innerWidth, h: window.innerHeight },
        overflowX: document.documentElement.scrollWidth - window.innerWidth,
        overflowY: grid ? grid.scrollHeight - grid.clientHeight : null,
        panel: box('.panel'),
        // A project with no tabs draws no panels, and the empty state is the thing to check then.
        panelContent: panel ? panel.scrollHeight : null,
        chart: box('.panel-chart'),
        emptyDisplay: getComputedStyle(document.getElementById('empty')).display,
        emptyText: (document.getElementById('empty').textContent || '').trim().slice(0, 90),
        panels: document.querySelectorAll('.panel').length,
        // The grid drops to one column below 980 px of viewport; the number has to come from the
        // computed style, because the breakpoint lives in CSS and an inline custom property can win.
        columns: grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length : null,
        // What the tab asked for, so the assertion is about the breakpoint rather than a guess.
        asked: grid ? getComputedStyle(grid).getPropertyValue('--columns').trim() : null,
        marks: Array.prototype.reduce.call(document.querySelectorAll('.panel-chart'), (total, host) => total + Number(host.dataset.marks || 0), 0),
      })
    })()`)
    console.log(`[bench] layout ${label}% ${layout}`)
    const seenLayout = JSON.parse(layout)
    if (seenLayout.panels > 1) {
      const asked = Number(seenLayout.asked) || 2
      const expected = seenLayout.viewport.w <= 980 ? 1 : Math.min(asked, seenLayout.panels)
      if (seenLayout.columns !== expected) {
        throw new Error(
          `at ${label}% the grid drew ${seenLayout.columns} column(s) in a ${seenLayout.viewport.w} px viewport, expected ${expected}`,
        )
      }
    }
  }

  // Interaction proof: a still frame cannot show that hover, wheel zoom or panning work, and a claim
  // that they do is worth less than a frame that shows it. The events are dispatched into the real
  // renderer, so this exercises the code the user's mouse exercises.
  window.webContents.setZoomFactor(1)
  await new Promise((done) => setTimeout(done, 400))
  const interaction = await window.webContents.executeJavaScript(`(() => {
    const host = document.querySelector('.panel-chart')
    // Nothing to hover when the open project has no tabs; say so rather than throwing.
    if (!host || !host.__benchChart || host.__benchChart.marks().length === 0) {
      return JSON.stringify({ skipped: 'no chart panel on screen' })
    }
    const svg = host.querySelector('svg.layer-under')
    const label = host.closest('.panel').querySelector('.zoom')
    const at = (element) => {
      const box = element.getBoundingClientRect()
      return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) }
    }
    const first = host.__benchChart.marks()[0]

    // Wheel zoom, twice, anchored on the point the cursor is over.
    for (const step of [-240, -240]) {
      host.dispatchEvent(new WheelEvent('wheel', { deltaY: step, clientX: first.x, clientY: first.y, bubbles: true, cancelable: true }))
    }
    const zoomedLabel = label.textContent

    // Keyboard pan moves the crop; the drawing is the same document, moved.
    host.focus()
    const beforePan = svg.getAttribute('viewBox')
    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    const afterPan = svg.getAttribute('viewBox')

    // Hover last, so the frame shows both the tooltip and the zoom the user would see.
    const marks = host.__benchChart.marks()
    const target = marks[Math.floor(marks.length / 2)]
    host.dispatchEvent(new PointerEvent('pointermove', { clientX: target.x, clientY: target.y, bubbles: true, pointerId: 1 }))
    const tooltip = document.getElementById('tooltip')

    // The marks live on a canvas, so their existence has to be checked in pixels, not in the DOM.
    // Alignment is checked against the drawing the canvas sits on: the same box, to the pixel.
    const canvas = host.querySelector('canvas.marks')
    const canvasBox = canvas.getBoundingClientRect()
    const underBox = svg.getBoundingClientRect()
    const aligned =
      Math.abs(canvasBox.left - underBox.left) < 1 &&
      Math.abs(canvasBox.top - underBox.top) < 1 &&
      Math.abs(canvasBox.width - underBox.width) < 1 &&
      Math.abs(canvasBox.height - underBox.height) < 1
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
    let marksPainted = 0
    for (let index = 3; index < pixels.length; index += 4) if (pixels[index] > 0) marksPainted += 1

    return JSON.stringify({
      zoomLabel: zoomedLabel,
      panned: beforePan !== afterPan,
      viewBox: afterPan,
      tooltipVisible: !tooltip.hidden,
      tooltip: tooltip.textContent,
      hoveredMark: host.querySelector('svg.layer-over .hover-dot')?.getAttribute('visibility') ?? 'none',
      aligned: aligned,
      marksPainted: marksPainted,
    })
  })()`)
  console.log('[bench] interaction ' + interaction)
  const seenInteraction = JSON.parse(interaction)
  if (!seenInteraction.skipped) {
    if (!seenInteraction.aligned) throw new Error('the mark canvas does not cover the drawing')
    if (!(seenInteraction.marksPainted > 0)) throw new Error('the mark canvas painted no marks')
    if (seenInteraction.hoveredMark !== 'visible') throw new Error('hover did not draw its ring')
    await assertPlainSurface('hover')
  }
  await assertVerdictExplained('the first drawing')
  await new Promise((done) => setTimeout(done, 300))
  await saveFrame(join(captureDir, 'app-interaction.png'), (await window.webContents.capturePage()).toPNG())

  // The canvas hides both SVG halves from the accessibility tree, so the host label is what a
  // screen reader hears. Read the tree itself: an aria-label that Chromium ignores would still be
  // in the DOM and still be useless.
  const exposed = await accessibilityImages()
  console.log('[bench] accessibility ' + JSON.stringify(exposed))
  const recipeImage = exposed.find((image) => /slope before and after the split/.test(image.name))
  if (!recipeImage) throw new Error('the recipe panel is missing from the accessibility tree')
  if (!/x x, y y/.test(recipeImage.name)) {
    throw new Error(`the recipe panel's accessible name lost its axes: ${recipeImage.name}`)
  }
  if (!/Slope 2\.053/.test(recipeImage.name)) {
    throw new Error(`the recipe panel's accessible name lost its caption: ${recipeImage.name}`)
  }

  let frames = factors.length + 1

  // The write path, on a scratch copy so the committed fixture's log stays as it was. Switching to
  // it is a reload, because that is what opening a project does: the renderer boots against a new
  // root rather than half-rewriting its state.
  if (writableDir) {
    // Electron only delivers `sendInputEvent` to a focused window, and the entry frames are worth
    // nothing if they were driven by calling the handler directly. So the window is shown here, for
    // these two frames only: it is the same window a person types into.
    setNextStartup(writableDir)
    window.webContents.reload()
    await new Promise((done) => ipcMain.once('bench:ready', done))
    if (!(await focusWindowForInput())) throw new Error('the window never took focus')
    await sleep(400)

    const focused = await window.webContents.executeJavaScript(
      "document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.field : null",
    )
    console.log(`[bench] entry-focused ${focused}`)

    const timing = await enterPoint(6.5, 16.4)
    await new Promise((done) => setTimeout(done, 300))
    console.log('[bench] entry ' + JSON.stringify(timing))
    console.log('[bench] entry-state ' + (await entryState()))
    // The bar's one button, before it is pressed: the label and the tooltip are two fields of the
    // same table row, so this is where the pairing can be checked.
    const appendOffered = JSON.parse(
      await window.webContents.executeJavaScript(`(() => {
        const button = document.getElementById('entry-undo')
        return JSON.stringify({ label: button.textContent, title: button.title, disabled: button.disabled })
      })()`),
    )
    console.log('[bench] undo-offered ' + JSON.stringify(appendOffered))
    if (appendOffered.disabled || appendOffered.label !== 'Undo added point') {
      throw new Error('the bar does not offer the point it just recorded: ' + JSON.stringify(appendOffered))
    }
    if (appendOffered.title !== 'Undo the last point added here (Ctrl+Z in an empty field)') {
      throw new Error('the point tooltip does not name the act: ' + appendOffered.title)
    }
    // The evidence line under the drawing is DOM the window updates on the keystroke path: the new
    // point has to reach it without a redraw, and without touching the SVG.
    const evidenceAfter = await window.webContents.executeJavaScript(
      "Array.prototype.map.call(document.querySelectorAll('.panel-evidence .evidence-text'), (n) => n.textContent).join(' | ')",
    )
    console.log('[bench] entry-evidence ' + JSON.stringify(evidenceAfter))
    if (!/n = 15\b/.test(evidenceAfter)) {
      throw new Error('the evidence line did not pick up the point that was typed: ' + evidenceAfter)
    }
    await assertPlainSurface('after entry')
    await saveFrame(join(captureDir, 'app-entry.png'), (await window.webContents.capturePage()).toPNG())
    frames += 1

    // Undo by keyboard, with the bar empty: Ctrl+Z retracts the point this window appended, which
    // is the same act as the button and the act a person reaches for.
    await focusField(0)
    pressKey('Z', ['control'])
    for (let waited = 0; waited < 40; waited += 1) {
      const state = JSON.parse(await entryState())
      if (state.undoEnabled === false) break
      await new Promise((done) => setTimeout(done, 100))
    }
    await new Promise((done) => setTimeout(done, 300))
    console.log('[bench] undo-state ' + (await entryState()))
    await assertPlainSurface('after undo')
    await saveFrame(join(captureDir, 'app-undo.png'), (await window.webContents.capturePage()).toPNG())
    frames += 1

    const tailEvent = async () => {
      const lines = (await readFile(join(writableDir, 'data', 'events.jsonl'), 'utf8')).trimEnd().split('\n')
      return JSON.parse(lines[lines.length - 1])
    }

    // Redo of undoing an added point: the status offers it, the keyboard does it, and the same record
    // comes back — a restore naming the retraction the undo wrote, not a second point with new values.
    const undoOffered = JSON.parse(
      await window.webContents.executeJavaScript(`(() => {
        const action = document.querySelector('#entry-status .status-action')
        const undo = document.getElementById('entry-undo')
        return JSON.stringify({
          status: document.getElementById('entry-status').textContent,
          redo: action ? action.textContent : null,
          redoTitle: action ? action.title : null,
          undo: undo.textContent,
          undoTitle: undo.title,
        })
      })()`),
    )
    console.log('[bench] undo-added ' + JSON.stringify(undoOffered))
    if (undoOffered.redo !== 'Redo added point') {
      throw new Error('undo of an added point offers no redo: ' + JSON.stringify(undoOffered))
    }
    // The button and its tooltip come from the same table row, so the pair cannot drift apart.
    if (
      undoOffered.redoTitle !==
      'Redo the point added here (Ctrl+Shift+Z or Ctrl+Y in an empty field)'
    ) {
      throw new Error('the redo tooltip does not name the act it would repeat: ' + undoOffered.redoTitle)
    }
    pressKey('Z', ['control', 'shift'])
    for (let waited = 0; waited < 60; waited += 1) {
      const state = JSON.parse(await entryState())
      if (/^Restored/.test(state.status || '')) break
      await sleep(100)
    }
    const restoredAfterUndo = JSON.parse(await entryState())
    const restoreEvent = await tailEvent()
    console.log(
      '[bench] redo-added ' +
        JSON.stringify({
          status: restoredAfterUndo.status,
          readout: restoredAfterUndo.readout,
          event: restoreEvent.type,
        }),
    )
    if (!/^Restored/.test(restoredAfterUndo.status || '')) {
      throw new Error('redo of undoing an added point reported nothing: ' + restoredAfterUndo.status)
    }
    if (restoreEvent.type !== 'point_restored') {
      throw new Error('redo did not restore the record it had withdrawn: ' + restoreEvent.type)
    }
    // Undo it once more, so the steps below start from the count they were written against. This is
    // the cycle a person actually performs: add, take it back, put it back, take it back again.
    pressKey('Z', ['control'])
    for (let waited = 0; waited < 60; waited += 1) {
      const state = JSON.parse(await entryState())
      if (/^Removed/.test(state.status || '')) break
      await sleep(100)
    }
    await assertPlainSurface('after redoing an added point')

    // A refusal, typed the way a person types a typo. The assertion that matters is not on screen:
    // the text has to still be in the field afterwards. A rejection that also loses the number just
    // typed is a worse bug than the rejection.
    await focusField(0)
    typeText('seven')
    pressEnter()
    for (let waited = 0; waited < 50; waited += 1) {
      const refused = await window.webContents.executeJavaScript(
        "!document.getElementById('entry-status').hidden",
      )
      if (refused) break
      await sleep(100)
    }
    await sleep(300)
    const refused = JSON.parse(await entryState())
    console.log('[bench] refused-state ' + JSON.stringify(refused))
    if (refused.typed.x !== 'seven') {
      throw new Error('the refused entry did not keep what was typed')
    }
    // A refusal is a surface too: the core's message is written for an agent and can name the record
    // or shape it checked, so the frame this writes is read back like every other one.
    await assertPlainSurface('the refused entry')
    await saveFrame(join(captureDir, 'app-refused.png'), (await window.webContents.capturePage()).toPNG())
    frames += 1

    // A second writer, which is how this product is meant to be operated: an agent runs `bench` in a
    // terminal while the window is open. This spawns the real binary, not a second Workspace in this
    // process, so the window's cached bind is genuinely behind the file (ADR 0007).
    await window.webContents.executeJavaScript(
      "document.querySelectorAll('#entry-fields input').forEach((input) => { input.value = '' })",
    )
    await runCli(['add', '--x', '7.2', '--y', '8.4'])
    // A child process can take the focus on Windows; without it the entry frame would be synthetic.
    if (!(await focusWindowForInput())) throw new Error('the window never took focus back')
    const stale = JSON.parse(await entryState())
    console.log('[bench] second-writer-stale ' + JSON.stringify({ readout: stale.readout, marks: stale.marks }))

    const secondTiming = await enterPoint(6.4, 17.1)
    await sleep(800)
    const settledState = JSON.parse(await entryState())
    const savedView = JSON.parse(await readFile(join(writableDir, 'views', 'drift-over-time.json'), 'utf8'))
    console.log(
      '[bench] second-writer ' +
        JSON.stringify({
          timing: secondTiming,
          status: settledState.status,
          readout: settledState.readout,
          marks: settledState.marks,
          panelN: savedView.panels[1].n,
        }),
    )
    // The frame is only worth anything if it shows the repair: the count has to include the row this
    // window never saw arrive, the bar has to say it reread, and the saved tab must agree.
    if (!/changed on disk/.test(settledState.status || '')) {
      throw new Error('the window did not say it reread the project before writing')
    }
    if (!/n = 16/.test(settledState.readout)) {
      throw new Error(`the bar should read n = 16, it reads "${settledState.readout}"`)
    }
    if (savedView.panels[1].n !== 16) {
      throw new Error(`the saved tab says n = ${savedView.panels[1].n}, the log holds 16`)
    }
    await saveFrame(join(captureDir, 'app-second-writer.png'), (await window.webContents.capturePage()).toPNG())
    frames += 1

    // Correct a record by selecting it. The click is dispatched into the drawing's own pointer
    // handling, the new value is typed into the bar, and Enter saves — the same path a person uses.
    const selected = await window.webContents.executeJavaScript(`(() => {
      const panels = document.querySelectorAll('.panel')
      const host = panels[panels.length - 1] && panels[panels.length - 1].querySelector('.panel-chart')
      const mark = host && host.__benchChart && host.__benchChart.marks()[0]
      if (!mark) return null
      const at = { clientX: mark.x, clientY: mark.y }
      for (const type of ['pointerdown', 'pointerup']) {
        host.dispatchEvent(
          new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, ...at }),
        )
      }
      return mark.id
    })()`)
    if (!selected) throw new Error('no mark in the plot panel to select')
    for (let waited = 0; waited < 40; waited += 1) {
      const open = await window.webContents.executeJavaScript(
        "!document.getElementById('entry-correct').hidden",
      )
      if (open) break
      await sleep(100)
    }
    const strip = JSON.parse(await entryState())
    console.log(
      '[bench] correction-open ' +
        JSON.stringify({ id: selected, values: strip.typed, status: strip.status }),
    )
    if (!strip.correcting) throw new Error('clicking a mark did not open the correction strip')
    if (strip.typed.x === '' || strip.typed.y === '') {
      throw new Error('the correction strip was not prefilled from the log')
    }
    // The correction row adds a line to a strip that already holds fields, a button and a readout.
    // Overflow here would clip the measurement the row exists to name.
    const overflowX = await window.webContents.executeJavaScript(`(() => {
      const label = document.getElementById('entry-correct-label')
      return label.scrollWidth - Math.round(label.getBoundingClientRect().width)
    })()`)
    console.log('[bench] correction-overflow ' + overflowX + 'px')
    if (overflowX > 1) throw new Error(`the correction row overflows by ${overflowX}px`)

    await focusField(1)
    pressKey('a', ['control'])
    pressKey('Backspace')
    typeText('24.5')
    pressEnter()
    for (let waited = 0; waited < 50; waited += 1) {
      const state = JSON.parse(await entryState())
      if (/^Corrected /.test(state.status || '')) break
      await sleep(100)
    }
    await sleep(400)
    const correctedState = JSON.parse(await entryState())
    const lastEvent = JSON.parse((await readFile(join(writableDir, 'data', 'events.jsonl'), 'utf8')).trimEnd().split('\n').pop())
    console.log(
      '[bench] corrected ' +
        JSON.stringify({
          id: selected,
          status: correctedState.status,
          readout: correctedState.readout,
          badges: correctedState.badges,
          event: lastEvent.type,
          supersedes: lastEvent.supersedes,
        }),
    )
    if (lastEvent.type !== 'point_corrected' || lastEvent.supersedes !== selected) {
      throw new Error(`the correction was not recorded as an event (last was ${lastEvent.type})`)
    }
    if (!/^Corrected /.test(correctedState.status || '')) {
      throw new Error('the bar did not report the correction')
    }
    if (!/n = 16/.test(correctedState.readout)) {
      throw new Error(`correcting a point must not change the count: "${correctedState.readout}"`)
    }
    if (!/out of date/.test(correctedState.status || '')) {
      throw new Error('the correction did not say the recipe panel is now out of date')
    }
    await assertPlainSurface('after a correction')
    await saveFrame(join(captureDir, 'app-corrected.png'), (await window.webContents.capturePage()).toPNG())
    frames += 1

    // The correction is the newest act, and the bar's one button says so. Undo writes the values the
    // strip read before the save; redo writes the corrected ones back. Both are corrections in the
    // log, so a month from now it can still say every number this point has held.
    const afterCorrection = JSON.parse(
      await window.webContents.executeJavaScript(`(() => {
        const button = document.getElementById('entry-undo')
        return JSON.stringify({ label: button.textContent, title: button.title, disabled: button.disabled })
      })()`),
    )
    console.log('[bench] correction-undo ' + JSON.stringify(afterCorrection))
    if (afterCorrection.disabled || afterCorrection.label !== 'Undo correction') {
      throw new Error(
        'the bar does not offer the correction it just recorded: ' + JSON.stringify(afterCorrection),
      )
    }
    if (afterCorrection.title !== 'Undo the last correction made here (Ctrl+Z in an empty field)') {
      throw new Error('the correction tooltip does not name the act: ' + afterCorrection.title)
    }
    await focusField(0)
    pressKey('Z', ['control'])
    for (let waited = 0; waited < 60; waited += 1) {
      const state = JSON.parse(await entryState())
      if (/^Correction undone/.test(state.status || '')) break
      await sleep(100)
    }
    const undoneCorrection = JSON.parse(await entryState())
    const undoneEvent = await tailEvent()
    console.log(
      '[bench] correction-undone ' +
        JSON.stringify({
          status: undoneCorrection.status,
          event: undoneEvent.type,
          values: undoneEvent.values,
          was: strip.typed,
        }),
    )
    if (!/^Correction undone/.test(undoneCorrection.status || '')) {
      throw new Error('undoing a correction reported nothing: ' + undoneCorrection.status)
    }
    if (!/out of date/.test(undoneCorrection.status || '')) {
      throw new Error('undoing a correction did not say the analysis panel needs rerunning')
    }
    if (undoneEvent.type !== 'point_corrected' || undoneEvent.supersedes !== selected) {
      throw new Error('undoing a correction did not record the earlier values: ' + JSON.stringify(undoneEvent))
    }
    if (Number(undoneEvent.values.y) !== Number(strip.typed.y)) {
      throw new Error('the undone correction did not restore the value the strip read: ' + JSON.stringify(undoneEvent.values))
    }
    // The sentence grew a panel warning and a redo button; the row must still fit rather than clip
    // either of them.
    const statusFit = await window.webContents.executeJavaScript(`(() => {
      const row = document.getElementById('entry-status')
      return row.scrollWidth - Math.round(row.getBoundingClientRect().width)
    })()`)
    console.log('[bench] correction-status-overflow ' + statusFit + 'px')
    if (statusFit > 1) throw new Error(`the status row with its redo button overflows by ${statusFit}px`)
    const redoCorrection = JSON.parse(
      await window.webContents.executeJavaScript(
        "(() => { const button = document.querySelector('#entry-status .status-action'); return JSON.stringify({ label: button ? button.textContent : null, title: button ? button.title : null }) })()",
      ),
    )
    if (redoCorrection.label !== 'Redo correction') {
      throw new Error('an undone correction offers no redo: ' + redoCorrection.label)
    }
    if (redoCorrection.title !== 'Redo the correction made here (Ctrl+Shift+Z or Ctrl+Y in an empty field)') {
      throw new Error('the redo tooltip does not name the correction: ' + redoCorrection.title)
    }
    await saveFrame(join(captureDir, 'app-correction-undo.png'), (await window.webContents.capturePage()).toPNG())
    frames += 1
    await assertPlainSurface('after undoing a correction')

    pressKey('Z', ['control', 'shift'])
    for (let waited = 0; waited < 60; waited += 1) {
      const state = JSON.parse(await entryState())
      if (/^Corrected/.test(state.status || '')) break
      await sleep(100)
    }
    const redoneCorrection = JSON.parse(await entryState())
    const redoneEvent = await tailEvent()
    console.log(
      '[bench] correction-redone ' +
        JSON.stringify({ status: redoneCorrection.status, event: redoneEvent.type, values: redoneEvent.values }),
    )
    if (!/^Corrected/.test(redoneCorrection.status || '')) {
      throw new Error('redoing a correction reported nothing: ' + redoneCorrection.status)
    }
    if (redoneEvent.type !== 'point_corrected' || Number(redoneEvent.values.y) !== 24.5) {
      throw new Error('redo did not write the corrected value back: ' + JSON.stringify(redoneEvent))
    }

    // The notice's action is a button, not a command: refresh redraws what the core can redraw and
    // says plainly what it could not (a recipe panel needs its analysis run again).
    const noticeAction = await window.webContents.executeJavaScript(`(() => {
      const notice = document.getElementById('notice')
      const button = notice.querySelector('.notice-refresh')
      return JSON.stringify({ visible: !notice.hidden, button: Boolean(button), text: notice.textContent })
    })()`)
    console.log('[bench] notice ' + noticeAction)
    const seenNotice = JSON.parse(noticeAction)
    if (!seenNotice.visible) throw new Error('a stale panel produced no notice')
    if (!seenNotice.button) throw new Error('the notice offers no action')
    await window.webContents.executeJavaScript(
      "document.querySelector('#notice .notice-refresh').click()",
    )
    for (let waited = 0; waited < 60; waited += 1) {
      const state = JSON.parse(await entryState())
      if (/^Refreshed/.test(state.status || '')) break
      await sleep(100)
    }
    const refreshedStatus = JSON.parse(await entryState()).status || ''
    console.log('[bench] refreshed ' + refreshedStatus)
    if (!/^Refreshed/.test(refreshedStatus)) {
      throw new Error('the notice\u2019s Refresh button did not run: ' + refreshedStatus)
    }
    await assertPlainSurface('after refresh')

    // A point's menu. Right-click a mark the way a person does, copy the details, remove the point,
    // undo it, redo it, then open the same menu from the keyboard. Every claim is read back from the
    // log, because "the point came back" is a fact about the file, not about a frame.
    const logTail = async () => {
      const lines = (await readFile(join(writableDir, 'data', 'events.jsonl'), 'utf8')).trimEnd().split('\n')
      return JSON.parse(lines[lines.length - 1])
    }
    const totalMarks = async () =>
      window.webContents.executeJavaScript(
        "Array.prototype.reduce.call(document.querySelectorAll('.panel-chart'), (total, host) => total + Number(host.dataset.marks || 0), 0)",
      )
    const menuState = async () =>
      JSON.parse(
        await window.webContents.executeJavaScript(`(() => {
          const menu = document.querySelector('.menu')
          const box = menu ? menu.getBoundingClientRect() : null
          return JSON.stringify({
            open: Boolean(menu),
            role: menu ? menu.getAttribute('role') : null,
            items: menu ? Array.prototype.map.call(menu.querySelectorAll('.menu-item'), (button) => button.textContent) : [],
            focused: menu && document.activeElement ? document.activeElement.textContent : '',
            // A menu opened near an edge must still be clickable: no item may fall outside.
            inside: Boolean(
              box &&
                box.left >= 0 &&
                box.top >= 0 &&
                box.right <= window.innerWidth &&
                box.bottom <= window.innerHeight &&
                box.width > 0 &&
                box.height > 0,
            ),
          })
        })()`),
      )
    // Right-click the third mark in the plot panel, so the record is not the one the correction frame
    // edited and the counts are easy to follow.
    const menuTarget = JSON.parse(
      await window.webContents.executeJavaScript(`(() => {
        const panels = document.querySelectorAll('.panel')
        const host = panels[panels.length - 1].querySelector('.panel-chart')
        const mark = host.__benchChart.marks()[2]
        host.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: mark.x,
          clientY: mark.y,
          button: 2,
        }))
        return JSON.stringify({ id: mark.id, marks: Number(host.dataset.marks || 0) })
      })()`),
    )
    const opened = await menuState()
    console.log('[bench] menu ' + JSON.stringify({ target: menuTarget.id, ...opened }))
    if (!opened.open || opened.role !== 'menu') throw new Error('right-clicking a mark opened no menu')
    if (opened.items.join('|') !== 'Copy details|Correct…|Remove') {
      throw new Error('the point menu does not offer the three actions: ' + JSON.stringify(opened.items))
    }
    if (opened.focused !== 'Copy details') throw new Error('the menu did not put the keyboard on its first item')
    if (!opened.inside) throw new Error('the point menu was not fully inside the window')
    await assertPlainSurface('the point menu')
    await saveFrame(join(captureDir, 'app-point-menu.png'), (await window.webContents.capturePage()).toPNG())
    frames += 1

    // Copy details writes one line to the system clipboard, not to the screen.
    await window.webContents.executeJavaScript(
      "document.querySelector('.menu-item[data-action=\"copy\"]').click()",
    )
    for (let waited = 0; waited < 60; waited += 1) {
      const state = JSON.parse(await entryState())
      if (/^Copied/.test(state.status || '')) break
      await sleep(100)
    }
    const copiedState = JSON.parse(await entryState())
    // The clipboard is the system's, not the window's: read it from the process that wrote it. This
    // Electron's clipboard may answer synchronously or with a promise, so await both cases.
    const copiedText = await clipboard.readText()
    console.log('[bench] copied ' + JSON.stringify({ status: copiedState.status, clipboard: copiedText }))
    if (typeof copiedText !== 'string') {
      throw new Error('the clipboard did not return text: ' + String(copiedText))
    }
    if (!/^Copied/.test(copiedState.status || '')) throw new Error('Copy details reported nothing')
    if (!copiedText.endsWith('record ' + menuTarget.id)) {
      throw new Error('the copied line does not end with the record id: ' + copiedText)
    }
    if (!/observed \d{2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2}/.test(copiedText)) {
      throw new Error('the copied line does not say when the point was observed: ' + copiedText)
    }
    if ((await menuState()).open) throw new Error('the menu stayed open after choosing an item')
    await assertPlainSurface('after copying a point')

    // Correct… opens the same strip a click on the mark opens: the menu is a second door to the
    // editor, not a second editor.
    await window.webContents.executeJavaScript(`(() => {
      const panels = document.querySelectorAll('.panel')
      const host = panels[panels.length - 1].querySelector('.panel-chart')
      const mark = host.__benchChart.marks().find((candidate) => candidate.id === ${JSON.stringify(menuTarget.id)})
      host.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: mark.x,
        clientY: mark.y,
        button: 2,
      }))
      document.querySelector('.menu-item[data-action=\"correct\"]').click()
      return true
    })()`)
    for (let waited = 0; waited < 60; waited += 1) {
      const correcting = await window.webContents.executeJavaScript(
        "!document.getElementById('entry-correct').hidden",
      )
      if (correcting) break
      await sleep(100)
    }
    const correctingState = JSON.parse(await entryState())
    console.log('[bench] menu-correct ' + JSON.stringify({ correcting: correctingState.correcting, status: correctingState.status }))
    if (!correctingState.correcting) throw new Error('Correct… in the menu opened no correction strip')
    if (!/^Editing /.test(correctingState.status || '')) {
      throw new Error('the correction strip does not name the measurement: ' + correctingState.status)
    }
    await assertPlainSurface('the correction strip the menu opened')
    pressKey('Escape')
    for (let waited = 0; waited < 40; waited += 1) {
      const closed = await window.webContents.executeJavaScript(
        "document.getElementById('entry-correct').hidden",
      )
      if (closed) break
      await sleep(100)
    }
    if (!(await window.webContents.executeJavaScript("document.getElementById('entry-correct').hidden"))) {
      throw new Error('Escape did not close the correction strip the menu opened')
    }

    // Remove: one click, no reason prompt, the status offers the undo rather than describing it.
    const beforeRemove = await totalMarks()
    await window.webContents.executeJavaScript(`(() => {
      const panels = document.querySelectorAll('.panel')
      const host = panels[panels.length - 1].querySelector('.panel-chart')
      const mark = host.__benchChart.marks().find((candidate) => candidate.id === ${JSON.stringify(menuTarget.id)})
      host.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: mark.x,
        clientY: mark.y,
        button: 2,
      }))
      document.querySelector('.menu-item[data-action="remove"]').click()
      return true
    })()`)
    for (let waited = 0; waited < 60; waited += 1) {
      const state = JSON.parse(await entryState())
      if (/^Removed/.test(state.status || '')) break
      await sleep(100)
    }
    const removedState = JSON.parse(await entryState())
    const retraction = await logTail()
    const removedMarks = await totalMarks()
    // One undo, and it names the act: the bar's button, not a second button beside the status.
    const undoButton = await window.webContents.executeJavaScript(`(() => {
      const button = document.getElementById('entry-undo')
      const beside = document.querySelector('#entry-status .status-action')
      return JSON.stringify({
        label: button && !button.disabled ? button.textContent : null,
        title: button ? button.title : null,
        beside: beside ? beside.textContent : null,
        focus: document.activeElement ? String(document.activeElement.className || '') : '',
        menu: Boolean(document.querySelector('.menu')),
      })
    })()`)
    const undoState = JSON.parse(undoButton)
    console.log(
      '[bench] removed ' +
        JSON.stringify({
          status: removedState.status,
          undo: undoState.label,
          undoTitle: undoState.title,
          beside: undoState.beside,
          focus: undoState.focus,
          marks: { before: beforeRemove, after: removedMarks },
          event: retraction.type,
          reason: retraction.reason,
        }),
    )
    if (!/^Removed/.test(removedState.status || '')) throw new Error('Removing a point reported nothing')
    if (undoState.label !== 'Undo removal') {
      throw new Error('the one undo does not name the removal it would reverse: ' + undoState.label)
    }
    if (undoState.title !== 'Undo the last point removed here (Ctrl+Z in an empty field)') {
      throw new Error('the removal tooltip does not name the act: ' + undoState.title)
    }
    // The act came from the drawing, and the repaint that followed it must leave the keyboard there
    // rather than putting it in the entry bar or on the document body.
    if (!/panel-chart/.test(undoState.focus)) {
      throw new Error('choosing Remove from the menu did not return focus to a chart: ' + undoState.focus)
    }
    if (undoState.menu) throw new Error('the menu stayed open after Remove')
    await saveFrame(join(captureDir, 'app-point-menu-removed.png'), (await window.webContents.capturePage()).toPNG())
    frames += 1
    if (removedMarks !== beforeRemove - 1) {
      throw new Error(`the removed mark is still drawn (${beforeRemove} → ${removedMarks})`)
    }
    if (retraction.type !== 'point_retracted' || retraction.supersedes !== menuTarget.id) {
      throw new Error('the removal was not recorded against that point: ' + JSON.stringify(retraction))
    }
    // The window asks for no justification (U6); only an agent or the CLI may add one.
    if (retraction.reason !== undefined) throw new Error('the window recorded a reason for the removal')

    // Undo, with the bar's own button: the same record comes back, and the log says it was restored.
    await window.webContents.executeJavaScript("document.getElementById('entry-undo').click()")
    for (let waited = 0; waited < 60; waited += 1) {
      const state = JSON.parse(await entryState())
      if (/^Restored/.test(state.status || '')) break
      await sleep(100)
    }
    const restoredState = JSON.parse(await entryState())
    const restoration = await logTail()
    const restoredMarks = await totalMarks()
    console.log(
      '[bench] restored ' +
        JSON.stringify({
          status: restoredState.status,
          marks: restoredMarks,
          event: restoration.type,
          restores: restoration.restores === retraction.id,
        }),
    )
    if (!/^Restored/.test(restoredState.status || '')) throw new Error('Undo reported nothing')
    if (restoredMarks !== beforeRemove) throw new Error(`the mark did not come back (${restoredMarks})`)
    // Redo is the other direction of the same history, and it is the only button beside the status:
    // two undo buttons for one act was the thing this replaced.
    const redoButton = JSON.parse(await window.webContents.executeJavaScript(`(() => {
      const button = document.querySelector('#entry-status .status-action')
      return JSON.stringify({ label: button ? button.textContent : null, title: button ? button.title : null })
    })()`))
    if (redoButton.label !== 'Redo removal') {
      throw new Error('undo of a removal offers no Redo button: ' + redoButton.label)
    }
    if (redoButton.title !== 'Redo the point removed here (Ctrl+Shift+Z or Ctrl+Y in an empty field)') {
      throw new Error('the redo tooltip does not name the removal: ' + redoButton.title)
    }
    if (restoration.type !== 'point_restored' || restoration.restores !== retraction.id) {
      throw new Error('undo did not record a restore of that retraction: ' + JSON.stringify(restoration))
    }

    // Redo, by keyboard, puts the same record away again and leaves it undoable.
    await focusField(0)
    pressKey('Z', ['control', 'shift'])
    for (let waited = 0; waited < 60; waited += 1) {
      const state = JSON.parse(await entryState())
      if (/^Removed/.test(state.status || '')) break
      await sleep(100)
    }
    const redoneState = JSON.parse(await entryState())
    const redone = await logTail()
    console.log('[bench] redone ' + JSON.stringify({ status: redoneState.status, event: redone.type }))
    if (!/^Removed/.test(redoneState.status || '')) throw new Error('redo did not remove the point again')
    if (redone.type !== 'point_retracted' || redone.supersedes !== menuTarget.id) {
      throw new Error('redo did not record a second removal of that point: ' + JSON.stringify(redone))
    }
    await assertPlainSurface('after undo and redo')

    // The keyboard path: select a mark, then Shift+F10. Escape closes it and puts the focus back on
    // the chart rather than on the document body.
    const keyboardPath = JSON.parse(
      await window.webContents.executeJavaScript(`(() => {
        const panels = document.querySelectorAll('.panel')
        const host = panels[panels.length - 1].querySelector('.panel-chart')
        host.focus()
        host.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }))
        const ring = host.querySelector('svg.layer-over .select-dot')
        host.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }))
        const menu = document.querySelector('.menu')
        const opened = Boolean(menu)
        const focused = document.activeElement ? document.activeElement.textContent : ''
        if (menu) {
          document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        }
        return JSON.stringify({
          ring: ring ? ring.getAttribute('visibility') : 'none',
          opened: opened,
          focused: focused,
          closed: document.querySelector('.menu') === null,
          focusReturned: document.activeElement === host,
        })
      })()`),
    )
    console.log('[bench] menu-keyboard ' + JSON.stringify(keyboardPath))
    if (keyboardPath.ring !== 'visible') throw new Error('shift-arrow selected no mark for the menu')
    if (!keyboardPath.opened) throw new Error('Shift+F10 opened no menu')
    if (keyboardPath.focused !== 'Copy details') throw new Error('the keyboard menu is not focusable')
    if (!keyboardPath.closed) throw new Error('Escape did not close the menu')
    if (!keyboardPath.focusReturned) throw new Error('Escape did not return the focus to the chart')

    // A repaint while the menu is open: another writer appends, the window redraws, and the panel the
    // menu was opened from is replaced. The menu goes with it, and the keyboard lands on the panel
    // that replaced it — not on the document body.
    const menuOpenedForRepaint = await window.webContents.executeJavaScript(`(() => {
      const panels = document.querySelectorAll('.panel')
      const host = panels[panels.length - 1].querySelector('.panel-chart')
      const mark = host.__benchChart.marks()[0]
      host.dispatchEvent(new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: mark.x,
        clientY: mark.y,
        button: 2,
      }))
      return Boolean(document.querySelector('.menu'))
    })()`)
    if (!menuOpenedForRepaint) throw new Error('the menu did not open for the repaint check')
    await runCli(['add', '--x', '8.5', '--y', '12.5'])
    for (let waited = 0; waited < 80; waited += 1) {
      const state = JSON.parse(await entryState())
      if (/changed on disk/.test(state.status || '')) break
      await sleep(100)
    }
    await sleep(200)
    const repainted = JSON.parse(
      await window.webContents.executeJavaScript(`(() => JSON.stringify({
        menu: Boolean(document.querySelector('.menu')),
        focus: document.activeElement ? String(document.activeElement.className || '') : '',
        tag: document.activeElement ? document.activeElement.tagName : '',
      }))()`),
    )
    console.log('[bench] menu-repaint ' + JSON.stringify(repainted))
    if (repainted.menu) throw new Error('the menu survived a repaint')
    if (!/panel-chart/.test(repainted.focus)) {
      throw new Error('a repaint during an open menu lost the keyboard: ' + JSON.stringify(repainted))
    }

    // A tab built from the dialog: a name, a dataset, a recipe. It runs against a second, untouched
    // copy of the fixture — the frames above appended and corrected points, and a verdict computed
    // from those edits would say more about this harness than about the door being shown.
    const tabProject = join(dirname(writableDir), 'tab-fixture')
    await cp(startupDir, tabProject, { recursive: true })
    setNextStartup(tabProject)
    window.webContents.reload()
    await new Promise((done) => ipcMain.once('bench:ready', done))
    if (!(await focusWindowForInput())) throw new Error('the window never took focus for the tab door')
    await sleep(400)

    await window.webContents.executeJavaScript("document.getElementById('new-tab').click()")
    for (let waited = 0; waited < 100; waited += 1) {
      const ready = await window.webContents.executeJavaScript(
        "(() => { const d = document.getElementById('tab-dialog'); return d.open && !!document.querySelector('#tab-panel option[value=\"drift\"]') })()",
      )
      if (ready) break
      await sleep(100)
    }
    const dialogReady = await window.webContents.executeJavaScript(
      "(() => { const d = document.getElementById('tab-dialog'); return d.open && !!document.querySelector('#tab-panel option[value=\"drift\"]') })()",
    )
    if (!dialogReady) throw new Error('the tab dialog never offered a recipe')

    await window.webContents.executeJavaScript(`(() => {
      const name = document.getElementById('tab-name')
      name.value = 'regimes'
      name.dispatchEvent(new Event('input', { bubbles: true }))
      const panel = document.getElementById('tab-panel')
      panel.value = 'drift'
      panel.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
    await sleep(200)
    const dialogState = await window.webContents.executeJavaScript(`(() => JSON.stringify({
      name: document.getElementById('tab-name').value,
      dataset: document.getElementById('tab-dataset').value,
      panel: document.getElementById('tab-panel').value,
      replaceShown: !document.getElementById('tab-replace-field').hidden,
      note: document.getElementById('tab-note').textContent,
    }))()`)
    console.log('[bench] tab-dialog ' + dialogState)
    await window.webContents.executeJavaScript("document.getElementById('tab-create').click()")
    for (let waited = 0; waited < 100; waited += 1) {
      const state = JSON.parse(await entryState())
      if (/^(Created|Replaced) tab/.test(state.status || '')) break
      const failed = await window.webContents.executeJavaScript(
        "(() => { const e = document.getElementById('tab-error'); return e.hidden ? null : e.textContent })()",
      )
      if (failed) throw new Error('the tab dialog refused: ' + failed)
      await sleep(100)
    }
    await sleep(400)
    const tabState = JSON.parse(await entryState())
    const tabFile = JSON.parse(await readFile(join(tabProject, 'views', 'regimes.json'), 'utf8'))
    const tabNames = await window.webContents.executeJavaScript(
      "Array.prototype.map.call(document.querySelectorAll('#tabs .item-name'), (n) => n.textContent)",
    )
    console.log(
      '[bench] tab-created ' +
        JSON.stringify({
          status: tabState.status,
          badges: tabState.badges,
          meta: tabState.meta,
          tabs: tabNames,
          recipe: tabFile.panels[0].recipe,
          verdict: tabFile.panels[0].verdict,
        }),
    )
    if (tabFile.panels[0].recipe !== 'drift') throw new Error('the tab was not built by the recipe')
    // Up to date is silence: a badge that asks nothing is not shown (ADR 0015).
    if (!tabState.badges.every((badge) => badge === '')) {
      throw new Error('a freshly built tab still shows a status word: ' + JSON.stringify(tabState.badges))
    }
    if (!/^\d+ panels? · \d+ points?$/.test(tabState.meta || '')) {
      throw new Error('the tab strip is not the plain count: ' + tabState.meta)
    }
    await assertPlainSurface('after creating a tab')
    await assertVerdictExplained('the tab the window built')
    // The frame the review protocol asks for: the word and the sentence it opens.
    await window.webContents.executeJavaScript(
      "document.querySelector('.panel-evidence .verdict').dispatchEvent(new PointerEvent('pointerenter'))",
    )
    await sleep(250)
    await saveFrame(join(captureDir, 'app-verdict.png'), (await window.webContents.capturePage()).toPNG())
    frames += 1
    await window.webContents.executeJavaScript(
      "document.querySelector('.panel-evidence .verdict').dispatchEvent(new PointerEvent('pointerleave'))",
    )
    if (!tabNames.includes('regimes')) throw new Error('the new tab is not in the rail')
    await saveFrame(join(captureDir, 'app-new-tab.png'), (await window.webContents.capturePage()).toPNG())
    frames += 1

    // A recipe panel is kept when a write changes the data: it still draws the marks it was drawn
    // with, and one of them may no longer exist. It says it is out of date, and it must not offer to
    // act on those marks.
    const staleTarget = JSON.parse(
      await window.webContents.executeJavaScript(`(() => {
        const host = document.querySelector('.panel-chart')
        const mark = host.__benchChart.marks()[0]
        host.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: mark.x,
          clientY: mark.y,
          button: 2,
        }))
        const item = document.querySelector('.menu-item[data-action="remove"]')
        if (item) item.click()
        return JSON.stringify({ id: mark.id, marks: Number(host.dataset.marks || 0) })
      })()`),
    )
    for (let waited = 0; waited < 80; waited += 1) {
      const state = JSON.parse(await entryState())
      if (/^Removed/.test(state.status || '')) break
      await sleep(100)
    }
    await sleep(200)
    const staleState = JSON.parse(await entryState())
    const staleMarks = await totalMarks()
    const staleMenu = JSON.parse(
      await window.webContents.executeJavaScript(`(() => {
        const host = document.querySelector('.panel-chart')
        const mark = host.__benchChart.marks()[0]
        host.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: mark.x,
          clientY: mark.y,
          button: 2,
        }))
        host.focus()
        host.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }))
        host.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }))
        return JSON.stringify({
          menu: Boolean(document.querySelector('.menu')),
          ring: host.querySelector('svg.layer-over .select-dot').getAttribute('visibility'),
        })
      })()`),
    )
    console.log(
      '[bench] stale-panel ' +
        JSON.stringify({
          status: staleState.status,
          badges: staleState.badges,
          marks: { before: staleTarget.marks, after: staleMarks },
          menu: staleMenu.menu,
          ring: staleMenu.ring,
        }),
    )
    if (!/^Removed/.test(staleState.status || '')) {
      throw new Error('removing from a recipe panel reported nothing')
    }
    // The kept drawing is kept: its marks are what the file was drawn with, and it says so.
    if (staleMarks !== staleTarget.marks) {
      throw new Error(`the kept panel's marks changed (${staleTarget.marks} → ${staleMarks})`)
    }
    if (!staleState.badges.some((badge) => badge !== '')) {
      throw new Error('the kept panel does not say it is out of date')
    }
    // ... and it offers no menu, no selection and no keyboard menu on marks it cannot vouch for.
    if (staleMenu.menu) throw new Error('a kept panel offered a point menu for a mark it cannot vouch for')
    if (staleMenu.ring !== 'hidden') throw new Error('a kept panel let a mark be selected')

    // The history belongs to the drawing it happened in. The removal above left the bar offering its
    // undo on "regimes"; switching to the other tab must drop it, because that drawing never showed
    // the point.
    const undoOnRegimes = JSON.parse(
      await window.webContents.executeJavaScript(`(() => {
        const button = document.getElementById('entry-undo')
        return JSON.stringify({ label: button.textContent, disabled: button.disabled })
      })()`),
    )
    if (undoOnRegimes.disabled || undoOnRegimes.label !== 'Undo removal') {
      throw new Error('the removal did not reach the bar: ' + JSON.stringify(undoOnRegimes))
    }
    const switched = await window.webContents.executeJavaScript(`(() => {
      const item = Array.prototype.find.call(document.querySelectorAll('#tabs .item'), (button) => {
        const name = button.querySelector('.item-name')
        return name && name.textContent === 'drift over time'
      })
      if (!item) return false
      item.click()
      return true
    })()`)
    if (!switched) throw new Error('no tab in the rail to switch to')
    for (let waited = 0; waited < 60; waited += 1) {
      const title = await window.webContents.executeJavaScript("document.getElementById('view-title').textContent")
      if (title === 'drift over time') break
      await sleep(100)
    }
    const undoAfterSwitch = JSON.parse(
      await window.webContents.executeJavaScript(`(() => {
        const button = document.getElementById('entry-undo')
        return JSON.stringify({ label: button.textContent, disabled: button.disabled, title: button.title })
      })()`),
    )
    console.log('[bench] tab-switch-history ' + JSON.stringify({ before: undoOnRegimes, after: undoAfterSwitch }))
    if (!undoAfterSwitch.disabled) {
      throw new Error('the bar still offers an undo for the tab that was left: ' + JSON.stringify(undoAfterSwitch))
    }

    // Remove while a write is in flight. Enter starts a save and the menu is opened in the same tick,
    // before it settles: the click must say so rather than doing nothing, and the removal must not
    // happen once the save lands.
    const marksBeforeBusy = await totalMarks()
    const busyRemove = JSON.parse(
      await window.webContents.executeJavaScript(`(() => {
        const panels = document.querySelectorAll('.panel')
        const host = panels[panels.length - 1].querySelector('.panel-chart')
        const mark = host.__benchChart.marks()[0]
        const fields = document.querySelectorAll('#entry-fields input')
        fields[0].value = '9.5'
        fields[1].value = '11.5'
        document.getElementById('entry').requestSubmit()
        host.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: mark.x,
          clientY: mark.y,
          button: 2,
        }))
        const item = document.querySelector('.menu-item[data-action="remove"]')
        const opened = Boolean(item)
        if (item) item.click()
        return JSON.stringify({ opened, status: document.getElementById('entry-status').textContent })
      })()`),
    )
    for (let waited = 0; waited < 60; waited += 1) {
      const state = JSON.parse(await entryState())
      if (/^Saved|^Point /.test(state.status || '')) break
      await sleep(100)
    }
    const marksAfterBusy = await totalMarks()
    // The log is the proof, not the count: the tab was one point behind when it was opened, so the
    // save brings the drawing even and the totals do not move. What must be true is that no removal
    // was appended on top of it.
    const afterBusy = JSON.parse(
      (await readFile(join(tabProject, 'data', 'events.jsonl'), 'utf8')).trimEnd().split('\n').at(-1),
    )
    console.log(
      '[bench] remove-while-busy ' +
        JSON.stringify({
          opened: busyRemove.opened,
          status: busyRemove.status,
          marks: { before: marksBeforeBusy, after: marksAfterBusy },
          last: afterBusy.type,
        }),
    )
    if (!busyRemove.opened) throw new Error('the menu did not open during the write')
    if (!/Still saving/.test(busyRemove.status)) {
      throw new Error('Remove during a write said nothing: ' + JSON.stringify(busyRemove.status))
    }
    if (afterBusy.type !== 'point_recorded') {
      throw new Error('the removal ran while a write was in flight: ' + afterBusy.type)
    }

    // A point removed here leaves its undo in the bar; a tab built from the dialog is a different
    // drawing, so the bar must stop offering it.
    const busyTarget = JSON.parse(
      await window.webContents.executeJavaScript(`(() => {
        const panels = document.querySelectorAll('.panel')
        const host = panels[panels.length - 1].querySelector('.panel-chart')
        const mark = host.__benchChart.marks()[1] || host.__benchChart.marks()[0]
        host.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: mark.x,
          clientY: mark.y,
          button: 2,
        }))
        const item = document.querySelector('.menu-item[data-action="remove"]')
        if (item) item.click()
        return JSON.stringify({ id: mark.id })
      })()`),
    )
    for (let waited = 0; waited < 60; waited += 1) {
      const state = JSON.parse(await entryState())
      if (/^Removed/.test(state.status || '')) break
      await sleep(100)
    }
    await window.webContents.executeJavaScript("document.getElementById('new-tab').click()")
    for (let waited = 0; waited < 100; waited += 1) {
      const ready = await window.webContents.executeJavaScript(
        "document.getElementById('tab-dialog').open && !!document.querySelector('#tab-panel option[value=\"plot\"]')",
      )
      if (ready) break
      await sleep(100)
    }
    await window.webContents.executeJavaScript(`(() => {
      const name = document.getElementById('tab-name')
      name.value = 'second look'
      name.dispatchEvent(new Event('input', { bubbles: true }))
      const panel = document.getElementById('tab-panel')
      panel.value = 'plot'
      panel.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
    await sleep(150)
    await window.webContents.executeJavaScript("document.getElementById('tab-create').click()")
    for (let waited = 0; waited < 100; waited += 1) {
      const state = JSON.parse(await entryState())
      if (/^(Created|Replaced) tab/.test(state.status || '')) break
      await sleep(100)
    }
    await sleep(300)
    const undoAfterNewTab = JSON.parse(
      await window.webContents.executeJavaScript(`(() => {
        const button = document.getElementById('entry-undo')
        return JSON.stringify({
          title: document.getElementById('view-title').textContent,
          label: button.textContent,
          disabled: button.disabled,
        })
      })()`),
    )
    const newTabState = JSON.parse(await entryState())
    console.log(
      '[bench] new-tab-history ' + JSON.stringify({ removed: busyTarget.id, status: newTabState.status, ...undoAfterNewTab }),
    )
    if (!/^(Created|Replaced) the tab/.test(newTabState.status || '')) {
      throw new Error('the plain tab was not created: ' + newTabState.status)
    }
    if (undoAfterNewTab.title !== 'second look') {
      throw new Error('creating a tab did not open it: ' + undoAfterNewTab.title)
    }
    // The previous tab's act is gone with the drawing. What the bar offers is this tab's own first
    // act — the fact that it was made — and nothing else.
    if (undoAfterNewTab.disabled || undoAfterNewTab.label !== 'Undo new tab') {
      throw new Error(
        'a new tab does not offer the act that made it: ' + JSON.stringify(undoAfterNewTab),
      )
    }

    // A project created from the window, with fields of its own choosing. The shape is declared at
    // init and every later point inherits it, so the frame shows the bar offering those fields and
    // the first point typed into them.
    const projectRoot = join(dirname(writableDir), 'new-project')
    // The dialog refuses a parent that does not exist rather than creating a tree from a typo; a
    // person arrives here from the folder picker, so the harness makes the folder first.
    await mkdir(projectRoot, { recursive: true })
    await window.webContents.executeJavaScript("document.getElementById('new-project').click()")
    await sleep(300)
    await window.webContents.executeJavaScript(`(() => {
      const set = (id, value) => {
        const input = document.getElementById(id)
        input.value = value
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }
      set('project-name', 'load cells')
      set('project-folder', ${JSON.stringify(projectRoot)})
      const shape = document.getElementById('project-shape')
      shape.value = 'custom'
      shape.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
    await sleep(200)
    const projectDialog = await window.webContents.executeJavaScript(`(() => {
      const names = document.querySelectorAll('#project-fields [data-role="field-name"]')
      names[0].value = 'mass'
      names[1].value = 'extension'
      document.getElementById('project-shape-name').value = 'load'
      return JSON.stringify({
        preview: document.getElementById('project-preview').textContent,
        custom: !document.getElementById('project-custom').hidden,
        fields: Array.prototype.map.call(names, (input) => input.value),
      })
    })()`)
    console.log('[bench] project-dialog ' + projectDialog)
    await window.webContents.executeJavaScript("document.getElementById('project-create').click()")
    for (let waited = 0; waited < 80; waited += 1) {
      const refused = await window.webContents.executeJavaScript(
        "(() => { const e = document.getElementById('project-error'); return e.hidden ? null : e.textContent })()",
      )
      if (refused) throw new Error('the project dialog refused: ' + refused)
      const closed = await window.webContents.executeJavaScript(
        "!document.getElementById('project-dialog').open",
      )
      if (closed) break
      await sleep(100)
    }
    await sleep(300)
    const newProject = join(projectRoot, 'load-cells')
    const projectEvents = (await readFile(join(newProject, 'data', 'events.jsonl'), 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line))
    const declared = projectEvents.find((event) => event.type === 'shape_defined')
    const projectState = JSON.parse(await entryState())
    console.log(
      '[bench] project-created ' +
        JSON.stringify({
          status: projectState.status,
          fields: projectState.typed,
          shape: declared && declared.shape.id,
          declared: declared && declared.shape.fields.map((field) => field.name),
        }),
    )
    if (!declared || declared.shape.id !== 'load.v1') {
      throw new Error('the project did not declare the chosen shape')
    }
    if (JSON.stringify(declared.shape.fields.map((field) => field.name)) !== '["mass","extension"]') {
      throw new Error('the declared shape does not hold the chosen fields')
    }
    if (!/Created project/.test(projectState.status || '')) {
      throw new Error('the bar did not report the project it created')
    }
    if (!/mass/.test(projectState.status || '')) throw new Error('the status does not name the fields')

    // The first tab is created before any point, so the empty panel is part of the first-run proof:
    // axes named from the shape, n = 0, and the core's own sentence for how to add one.
    await window.webContents.executeJavaScript("document.getElementById('new-tab').click()")
    await sleep(300)
    await window.webContents.executeJavaScript(`(() => {
      const set = (id, value, event) => {
        const element = document.getElementById(id)
        element.value = value
        element.dispatchEvent(new Event(event, { bubbles: true }))
      }
      set('tab-name', 'first tab', 'input')
      set('tab-dataset', 'main', 'change')
      set('tab-panel', 'plot', 'change')
      document.getElementById('tab-x-field').value = 'mass'
      document.getElementById('tab-y-field').value = 'extension'
      return true
    })()`)
    await sleep(300)
    await window.webContents.executeJavaScript("document.getElementById('tab-create').click()")
    const customViewPath = join(newProject, 'views', 'first-tab.json')
    let customView = null
    for (let waited = 0; waited < 100; waited += 1) {
      const state = JSON.parse(await entryState())
      try {
        customView = JSON.parse(await readFile(customViewPath, 'utf8'))
      } catch {
        // The tab is written by the core; the next poll reads it.
      }
      if (customView && /^Created tab/.test(state.status || '')) break
      const failed = await window.webContents.executeJavaScript(
        "(() => { const e = document.getElementById('tab-error'); return e.hidden ? null : e.textContent })()",
      )
      if (failed) throw new Error('the empty custom-axis tab was refused: ' + failed)
      await sleep(100)
    }
    if (!customView) throw new Error('the empty custom-axis tab was not saved')
    const emptyPanel = customView.panels[0]
    if (emptyPanel.chart.x.label !== 'mass' || emptyPanel.chart.y.label !== 'extension') {
      throw new Error('the empty tab lost the chosen axes: ' + JSON.stringify(emptyPanel.chart))
    }
    if (emptyPanel.n !== 0) throw new Error(`the empty tab should hold no points, not ${emptyPanel.n}`)
    const emptyState = JSON.parse(await entryState())
    console.log('[bench] empty-tab ' + JSON.stringify({ status: emptyState.status, readout: emptyState.readout, axes: emptyPanel.chart.x.label + '/' + emptyPanel.chart.y.label }))
    if (!/n = 0/.test(emptyState.readout || '')) throw new Error('the empty-tab readout is not n = 0: ' + emptyState.readout)
    if (emptyState.marks !== 0) throw new Error(`the empty tab drew ${emptyState.marks} marks`)
    // A brand-new project's first panel: no shape id, no dataset, and no command to copy.
    const emptySeen = JSON.parse(
      await window.webContents.executeJavaScript(`(() => JSON.stringify({
        sentence: Array.prototype.map.call(document.querySelectorAll('.panel-empty'), (n) => n.textContent).join(' '),
        drawn: Array.prototype.map.call(document.querySelectorAll('.panel-chart svg text'), (n) => n.textContent).join(' '),
      }))()`),
    )
    console.log('[bench] empty-panel ' + JSON.stringify(emptySeen))
    if (!/No observations yet\. Add the first point below\./.test(emptySeen.sentence || '')) {
      throw new Error('the empty panel does not teach the button: ' + emptySeen.sentence)
    }
    // The sentence is DOM from the copy owner; the drawing itself says nothing on an empty frame.
    if (/observations|point below/.test(emptySeen.drawn || '')) {
      throw new Error('the empty drawing still composes its own sentence: ' + emptySeen.drawn)
    }
    await assertPlainSurface('the empty first panel')
    for (const [label, factor] of [['100', 1], ['125', 1.25], ['150', 1.5]]) {
      window.webContents.setZoomFactor(factor)
      await sleep(600)
      await saveFrame(join(captureDir, `app-empty-tab-${label}.png`), (await window.webContents.capturePage()).toPNG())
      frames += 1
    }
    window.webContents.setZoomFactor(1)
    await sleep(400)

    // The same bar types into the new project: the door is only open if a point can follow the shape.
    await typeIntoField(0, '2.5', 'mass')
    await typeIntoField(1, '12', 'extension')
    pressEnter()
    for (let waited = 0; waited < 50; waited += 1) {
      const state = JSON.parse(await entryState())
      if (/^Saved /.test(state.status || '')) break
      await sleep(100)
    }
    await sleep(300)
    const firstPoint = JSON.parse(await entryState())
    console.log(
      '[bench] project-first-point ' +
        JSON.stringify({ status: firstPoint.status, readout: firstPoint.readout, typed: firstPoint.typed }),
    )
    if (!/^Saved /.test(firstPoint.status || '')) {
      throw new Error('the first point in the new project was not recorded')
    }
    if (!/n = 1/.test(firstPoint.readout)) {
      throw new Error(`the new project should hold one point: "${firstPoint.readout}"`)
    }
    await saveFrame(join(captureDir, 'app-new-project.png'), (await window.webContents.capturePage()).toPNG())
    frames += 1

    // A tab whose axes are not x/y, driven through the same bar: the custom shape's fields have to
    // reach the tab dialog, the drawing, the readout and the saved file without any of them assuming
    // the historical pair. This is the one surface the default fixture cannot exercise.
    customView = JSON.parse(await readFile(customViewPath, 'utf8'))
    const customPanel = customView.panels[0]
    if (customPanel.chart.x.label !== 'mass' || customPanel.chart.y.label !== 'extension') {
      throw new Error('the saved tab lost the chosen axes: ' + JSON.stringify(customPanel.chart.x) + ' ' + JSON.stringify(customPanel.chart.y))
    }
    if (customPanel.n !== 1) throw new Error(`the saved tab should hold one point, not ${customPanel.n}`)
    const customBefore = JSON.parse(await entryState())
    console.log('[bench] custom-axis ' + JSON.stringify({ status: customBefore.status, readout: customBefore.readout, meta: customBefore.meta, marks: customBefore.marks, axes: customPanel.chart.x.label + '/' + customPanel.chart.y.label }))
    if (!/n = 1/.test(customBefore.readout)) throw new Error('the custom-axis readout is not n = 1: ' + customBefore.readout)
    if (customBefore.marks !== 1) throw new Error(`the custom-axis chart drew ${customBefore.marks} marks instead of one`)

    const customExposed = await accessibilityImages()
    const customImage = customExposed.find((image) => /first tab/.test(image.name))
    console.log('[bench] custom-axis-a11y ' + JSON.stringify(customExposed))
    if (!customImage) throw new Error('the custom-axis panel is missing from the accessibility tree')
    if (!/x mass, y extension/.test(customImage.name)) {
      throw new Error(`the custom-axis accessible name lost its axes: ${customImage.name}`)
    }
    if (!/1 point/.test(customImage.name)) {
      throw new Error(`the custom-axis accessible name lost its count: ${customImage.name}`)
    }

    if (!(await focusWindowForInput())) throw new Error('the window never took focus for the custom-axis point')
    await typeIntoField(0, '2.6', 'mass')
    await typeIntoField(1, '12.2', 'extension')
    pressEnter()
    let customPatched = customBefore
    for (let waited = 0; waited < 60; waited += 1) {
      customPatched = JSON.parse(await entryState())
      if (customPatched.marks === 2 && /n = 2/.test(customPatched.readout || '')) break
      await sleep(100)
    }
    console.log('[bench] custom-axis-patch ' + JSON.stringify({ readout: customPatched.readout, marks: customPatched.marks, timing: customPatched.timing }))
    if (customPatched.marks !== 2) throw new Error(`the incremental custom-axis point drew ${customPatched.marks} marks`)
    if (!/n = 2/.test(customPatched.readout || '')) throw new Error('the custom-axis readout did not reach n = 2: ' + customPatched.readout)
    for (let waited = 0; waited < 100; waited += 1) {
      const saved = JSON.parse(await readFile(customViewPath, 'utf8'))
      if (saved.panels[0].n === 2) break
      if (waited === 99) throw new Error('the saved custom-axis tab never caught up to two points')
      await sleep(100)
    }

    if (!(await focusWindowForInput())) throw new Error('the window never took focus for the redraw')
    await typeIntoField(0, '1000', 'mass')
    await typeIntoField(1, '5000', 'extension')
    pressEnter()
    let customRedrawn = customPatched
    for (let waited = 0; waited < 80; waited += 1) {
      customRedrawn = JSON.parse(await entryState())
      if (customRedrawn.marks === 3 && /n = 3/.test(customRedrawn.readout || '')) break
      await sleep(100)
    }
    console.log('[bench] custom-axis-redraw ' + JSON.stringify({ readout: customRedrawn.readout, marks: customRedrawn.marks, timing: customRedrawn.timing }))
    if (customRedrawn.marks !== 3) throw new Error(`the redrawn custom-axis chart drew ${customRedrawn.marks} marks`)
    if (!/n = 3/.test(customRedrawn.readout || '')) throw new Error('the custom-axis readout did not reach n = 3: ' + customRedrawn.readout)
    const redrawnView = JSON.parse(await readFile(customViewPath, 'utf8'))
    if (redrawnView.panels[0].chart.x.label !== 'mass' || redrawnView.panels[0].chart.y.label !== 'extension') {
      throw new Error('the redraw changed the custom axes')
    }
    if (redrawnView.panels[0].n !== 3) throw new Error(`the saved custom-axis tab holds ${redrawnView.panels[0].n} points`)
    const redrawnExposed = await accessibilityImages()
    const redrawnImage = redrawnExposed.find((image) => /first tab/.test(image.name))
    if (!redrawnImage || !/x mass, y extension/.test(redrawnImage.name)) {
      throw new Error('the redrawn custom-axis panel lost its axes: ' + JSON.stringify(redrawnExposed))
    }
    await saveFrame(join(captureDir, 'app-custom-axis.png'), (await window.webContents.capturePage()).toPNG())
    frames += 1

    // A tab that is open while an agent writes. Nothing is typed after the CLI runs, so the frame can
    // only change if the window noticed the log move by itself: the watcher, a reload, a redraw.
    const liveProject = join(dirname(writableDir), 'live-fixture')
    await cp(startupDir, liveProject, { recursive: true })
    setNextStartup(liveProject)
    window.webContents.reload()
    await new Promise((done) => ipcMain.once('bench:ready', done))
    if (!(await focusWindowForInput())) throw new Error('the window never took focus for the live frame')
    await sleep(700)

    const liveBefore = JSON.parse(await entryState())
    // Half a number, deliberately unfinished: the redraw must not clear it or move the cursor.
    await focusField(0)
    typeText('4')
    await runCli(['add', '--x', '8.1', '--y', '9.9'], liveProject)

    let live = liveBefore
    for (let waited = 0; waited < 60; waited += 1) {
      live = JSON.parse(await entryState())
      if (live.marks > liveBefore.marks && /n = 15/.test(live.readout || '')) break
      await sleep(100)
    }
    const liveFocus = await window.webContents.executeJavaScript(
      "document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.field : null",
    )
    console.log(
      '[bench] live ' +
        JSON.stringify({
          readout: live.readout,
          marks: live.marks,
          typed: live.typed,
          focused: liveFocus,
          status: live.status,
        }),
    )
    if (!/n = 15/.test(live.readout || '')) {
      throw new Error(`an idle window did not take the CLI's point: "${live.readout}"`)
    }
    if (live.marks <= liveBefore.marks) throw new Error('the idle window kept the old drawing')
    if (live.typed.x !== '4') throw new Error('the live redraw lost the half-typed number')
    if (liveFocus !== 'x') throw new Error('the live redraw lost the cursor')
    if (!/reread and redrawn/.test(live.status || '')) {
      throw new Error('the bar did not say the tab was reread and redrawn')
    }
    await saveFrame(join(captureDir, 'app-live.png'), (await window.webContents.capturePage()).toPNG())
    frames += 1

    // Replaced, not deleted: the same tab name now holds a different file. The window has to draw the
    // file, not the panels it cached when the tab was opened.
    await runCli(['view', 'new', 'drift over time', '--dataset', 'main', '--force'], liveProject)
    let replaced = live
    for (let waited = 0; waited < 60; waited += 1) {
      replaced = JSON.parse(await entryState())
      if (replaced.panels === 1 && replaced.marks === 15 && /reread and redrawn/.test(replaced.status || '')) break
      await sleep(100)
    }
    console.log(
      '[bench] tab-replaced ' +
        JSON.stringify({
          panels: replaced.panels,
          marks: replaced.marks,
          readout: replaced.readout,
          status: replaced.status,
        }),
    )
    if (replaced.panels !== 1) {
      throw new Error(`a replaced tab should hold one panel, the window shows ${replaced.panels}`)
    }
    if (!/reread and redrawn/.test(replaced.status || '')) {
      throw new Error('the bar did not report the replaced tab')
    }
    await saveFrame(join(captureDir, 'app-tab-replaced.png'), (await window.webContents.capturePage()).toPNG())
    frames += 1

    // Deleted under the window: an honest empty state, a rail without the tab, and a bar that still
    // knows where a point would land.
    await rm(join(liveProject, 'views', 'drift-over-time.json'))
    let gone = replaced
    for (let waited = 0; waited < 60; waited += 1) {
      gone = JSON.parse(await entryState())
      if (gone.empty !== 'none' && gone.tabs === 0) break
      await sleep(100)
    }
    console.log(
      '[bench] tab-gone ' +
        JSON.stringify({
          empty: gone.empty,
          text: gone.emptyText,
          tabs: gone.tabs,
          readout: gone.readout,
          status: gone.status,
        }),
    )
    if (gone.empty === 'none') {
      throw new Error('the window kept drawing a tab whose file is gone')
    }
    if (!/This tab was removed/.test(gone.emptyText || '')) {
      throw new Error('the empty state does not say the tab was removed')
    }
    if (gone.tabs !== 0) throw new Error(`the rail still lists the deleted tab (${gone.tabs} items)`)
    if (!/removed on disk/.test(gone.status || '')) throw new Error('the bar did not say the tab was removed')
    if (!/n = 15/.test(gone.readout || '')) throw new Error(`the bar lost its target: "${gone.readout}"`)
    await saveFrame(join(captureDir, 'app-tab-gone.png'), (await window.webContents.capturePage()).toPNG())
    frames += 1

    // Importing from the window. The file is the deliberately messy fixture: two comment lines, extra
    // columns, a blank row, and quoted commas. It is copied first, because the capture proves the
    // preserved original is byte-identical to what was chosen. The project already holds rows, so
    // this is a *replace*: the file becomes a new version, the rows it does not have are withdrawn,
    // and the version it replaced keeps them.
    const importProject = join(dirname(writableDir), 'import-fixture')
    await cp(startupDir, importProject, { recursive: true })
    const messySource = join(here, '..', 'fixtures', 'imports', 'lab-export.csv')
    const messyFile = join(dirname(importProject), 'lab-export.csv')
    await cp(messySource, messyFile)
    setNextStartup(importProject)
    setNextPickedFile(messyFile)
    window.webContents.reload()
    await new Promise((done) => ipcMain.once('bench:ready', done))
    if (!(await focusWindowForInput())) throw new Error('the window never took focus for the import frame')
    await sleep(700)

    const importBefore = JSON.parse(await entryState())
    // How many events the project already had, so the assertions below read only this import's rows.
    importBefore.events = (await readFile(join(importProject, 'data', 'events.jsonl'), 'utf8')).trimEnd().split('\n').length
    await window.webContents.executeJavaScript("document.getElementById('import-open').click()")
    for (let waited = 0; waited < 60; waited += 1) {
      const ready = await window.webContents.executeJavaScript(
        "(() => { const d = document.getElementById('import-dialog'); return d.open && document.querySelectorAll('#import-fields select').length === 2 })()",
      )
      if (ready) break
      await sleep(100)
    }
    const importSheet = await window.webContents.executeJavaScript(`(() => JSON.stringify({
      open: document.getElementById('import-dialog').open,
      path: document.getElementById('import-path').textContent,
      summary: document.getElementById('import-summary').textContent,
      headers: Array.prototype.map.call(document.querySelectorAll('#import-preview th'), (th) => th.textContent),
      rows: document.querySelectorAll('#import-preview tbody tr').length,
      fields: Array.prototype.map.call(document.querySelectorAll('#import-fields select'), (select) => select.dataset.field),
      mapped: Array.prototype.map.call(document.querySelectorAll('#import-fields select'), (select) => select.value),
      apply: !document.getElementById('import-apply').disabled,
    }))()`)
    const sheetState = JSON.parse(importSheet)
    console.log('[bench] import-dialog ' + importSheet)
    if (!sheetState.open || !sheetState.apply) throw new Error('the import sheet did not open with a preview')
    if (!/lab-export\.csv$/.test(sheetState.path)) throw new Error('the sheet names the wrong file: ' + sheetState.path)
    if (!/^5 rows · 5 columns · 2 comment lines skipped/.test(sheetState.summary || '')) {
      throw new Error('the sheet does not report what the core read: ' + sheetState.summary)
    }
    if (!/map a column onto x, y/.test(sheetState.summary)) {
      throw new Error('the sheet did not name the fields that need a column: ' + sheetState.summary)
    }
    if (sheetState.headers.join(',') !== 'timestamp,temp_c,volts,note,operator') {
      throw new Error('the preview headers are wrong: ' + sheetState.headers.join(','))
    }

    // Nothing is mapped yet, so the first click is a refusal, not a write.
    await window.webContents.executeJavaScript("document.getElementById('import-apply').click()")
    for (let waited = 0; waited < 40; waited += 1) {
      const refused = await window.webContents.executeJavaScript(
        "(() => { const e = document.getElementById('import-error'); return e.hidden ? null : e.textContent })()",
      )
      if (refused) break
      await sleep(100)
    }
    const importRefusal = await window.webContents.executeJavaScript(
      "(() => { const e = document.getElementById('import-error'); return JSON.stringify({ hidden: e.hidden, text: e.textContent }) })()",
    )
    console.log('[bench] import-refused ' + importRefusal)
    const refusal = JSON.parse(importRefusal)
    if (refusal.hidden || !/no column for the required field/.test(refusal.text)) {
      throw new Error('the unmapped import was not refused in the sheet')
    }

    // Map the two required fields the way a person would: pick each column, then import.
    await window.webContents.executeJavaScript(`(() => {
      const set = (field, column) => {
        const select = document.querySelector('#import-fields select[data-field="' + field + '"]')
        select.value = column
        select.dispatchEvent(new Event('change', { bubbles: true }))
      }
      set('x', 'temp_c')
      set('y', 'volts')
      return true
    })()`)
    await sleep(200)
    const mapped = await window.webContents.executeJavaScript(`(() => JSON.stringify({
      mapped: Array.prototype.map.call(document.querySelectorAll('#import-fields select'), (select) => select.value),
      error: document.getElementById('import-error').hidden ? null : document.getElementById('import-error').textContent,
    }))()`)
    console.log('[bench] import-mapped ' + mapped)
    if (JSON.parse(mapped).mapped.join(',') !== 'temp_c,volts') {
      throw new Error('the mapping selects did not take: ' + mapped)
    }
    if (JSON.parse(mapped).error !== null) {
      throw new Error('the refusal stayed on screen after the mapping changed: ' + mapped)
    }
    if (!(await acknowledgeExtraColumns())) {
      throw new Error('the sheet did not ask what to do with the undeclared columns')
    }

    // What the sheet says the button will do, worked out from the mapping and written nowhere. This
    // is the line the frame is about: which version this becomes, and which rows leave the dataset.
    const sheetPlan = await window.webContents.executeJavaScript(
      "(() => document.getElementById('import-plan').textContent)()",
    )
    console.log('[bench] import-plan ' + JSON.stringify(sheetPlan))
    if (!/^5 rows · 5 added, 14 removed, none changed/.test(sheetPlan || '')) {
      throw new Error('the sheet did not say what the import changes: ' + sheetPlan)
    }
    if (!/14 rows not in this file will be withdrawn, not deleted/.test(sheetPlan)) {
      throw new Error('the sheet did not say which rows leave: ' + sheetPlan)
    }
    await assertPlainSurface('the import sheet')

    // The frame the verdict is about: the sheet with a real mapping on it, before anything is
    // written. Captured after the import the dialog is gone, which is a screenshot of the wrong state.
    // `capturePage` reads the window's compositor, which can hand back its previous surface when a
    // modal sheet opens; the renderer's own screenshot is the page as it is now.
    await saveFrame(join(captureDir, 'app-import.png'), await rendererScreenshot())
    frames += 1

    await window.webContents.executeJavaScript("document.getElementById('import-apply').click()")
    for (let waited = 0; waited < 100; waited += 1) {
      const state = JSON.parse(await entryState())
      if (/^Imported 5 row/.test(state.status || '')) break
      const failed = await window.webContents.executeJavaScript(
        "(() => { const e = document.getElementById('import-error'); return e.hidden ? null : e.textContent })()",
      )
      if (failed) throw new Error('the import was refused: ' + failed)
      await sleep(100)
    }
    await sleep(500)
    const importedState = JSON.parse(await entryState())
    const importLog = (await readFile(join(importProject, 'data', 'events.jsonl'), 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line))
    // Only what this import appended: the fixture itself was built with an import of its own.
    const appended = importLog.slice(importBefore.events)
    const recorded = appended.filter((event) => event.type === 'import_completed')
    const importedPoints = appended.filter((event) => event.type === 'point_recorded')
    const withdrawn = appended.filter((event) => event.type === 'point_retracted')
    const versionRecord = appended.find((event) => event.type === 'dataset_version_created')
    const preserved = recorded[0] ? recorded[0].file : null
    const preservedText = preserved ? await readFile(join(importProject, preserved), 'utf8') : ''
    const chosenText = await readFile(messyFile, 'utf8')
    console.log(
      '[bench] imported ' +
        JSON.stringify({
          status: importedState.status,
          readout: importedState.readout,
          marks: importedState.marks,
          before: importBefore.marks,
          closed: importedState.importClosed,
          meta: importedState.meta,
          points: importedPoints.length,
          withdrawn: withdrawn.length,
          version: versionRecord
            ? {
                version: versionRecord.version,
                parent: versionRecord.parent,
                rows: versionRecord.rows,
                diff: versionRecord.diff,
                source: versionRecord.source,
              }
            : null,
          record: recorded[0]
            ? { rows: recorded[0].rows, file: recorded[0].file, mapping: recorded[0].mapping }
            : null,
          first: importedPoints[0] ? importedPoints[0].values : null,
          identical: preservedText === chosenText,
        }),
    )
    if (!/^Imported 5 rows · 5 added, 14 removed, none changed/.test(importedState.status || '')) {
      throw new Error('the bar did not report what the import changed: ' + importedState.status)
    }
    if (!/14 rows not in the file were withdrawn; the earlier version still holds them/.test(importedState.status || '')) {
      throw new Error('the bar did not account for the rows that left: ' + importedState.status)
    }
    if (!importedState.importClosed) throw new Error('the import sheet stayed open after a successful import')
    if (!/n = 5/.test(importedState.readout || '')) {
      throw new Error(`the bar should read n = 5, it reads "${importedState.readout}"`)
    }
    if (importedPoints.length !== 5 || recorded.length !== 1 || withdrawn.length !== 14) {
      throw new Error(
        `the log holds ${importedPoints.length} new points, ${withdrawn.length} withdrawals and ${recorded.length} records`,
      )
    }
    if (!versionRecord || versionRecord.version !== 3 || versionRecord.parent !== 2) {
      throw new Error('the log does not record version 3 replacing version 2: ' + JSON.stringify(versionRecord))
    }
    if (JSON.stringify(versionRecord.diff) !== JSON.stringify({ added: 5, removed: 14, changed: 0 })) {
      throw new Error('the recorded diff is not what the sheet promised: ' + JSON.stringify(versionRecord.diff))
    }
    // Every row of this version is tagged with it, and every withdrawal says where it happened: that
    // is what keeps version 2 readable exactly as it was.
    if (importedPoints.some((event) => event.version !== 3) || withdrawn.some((event) => event.version !== 3)) {
      throw new Error('a row or withdrawal does not name its version')
    }
    if (!preserved || preservedText !== chosenText) {
      throw new Error('the preserved original is not the file that was chosen')
    }
    if (!/^data\/raw\//.test(preserved)) throw new Error('the original was not kept under data/raw: ' + preserved)
    const importMapping = recorded[0].mapping || {}
    if (importMapping.x !== 'temp_c' || importMapping.y !== 'volts') {
      throw new Error('the log recorded a different mapping than the sheet showed: ' + JSON.stringify(importMapping))
    }
    if (importMapping.t_observed !== undefined) {
      throw new Error('the log has a field the shape does not: ' + JSON.stringify(importMapping))
    }
    // The timestamp column was picked up by name, not mapped to a field: the first point proves it.
    const firstImported = importedPoints[0]
    if (!firstImported || firstImported.t_observed !== '2026-01-05T09:00:00.000Z') {
      throw new Error('the first point did not take its time from the timestamp column: ' + JSON.stringify(firstImported))
    }

    // The workflow this whole feature exists for: the instrument re-exported a corrected file, and it
    // goes through the same sheet. One reading corrected, one added, two dropped.
    const correctedFile = join(dirname(importProject), 'lab-export-v2.csv')
    await cp(join(here, '..', 'fixtures', 'imports', 'lab-export-v2.csv'), correctedFile)
    const eventsBeforeCorrection = importLog.length
    setNextPickedFile(correctedFile)
    await window.webContents.executeJavaScript("document.getElementById('import-open').click()")
    for (let waited = 0; waited < 60; waited += 1) {
      const ready = await window.webContents.executeJavaScript(
        "(() => document.getElementById('import-dialog').open && /lab-export-v2\\.csv$/.test(document.getElementById('import-path').textContent) && document.querySelectorAll('#import-fields select').length === 2)()",
      )
      if (ready) break
      await sleep(100)
    }
    await window.webContents.executeJavaScript(`(() => {
      const set = (field, column) => {
        const select = document.querySelector('#import-fields select[data-field="' + field + '"]')
        select.value = column
        select.dispatchEvent(new Event('change', { bubbles: true }))
      }
      set('x', 'temp_c')
      set('y', 'volts')
      return true
    })()`)
    await sleep(400)
    if (!(await acknowledgeExtraColumns())) throw new Error('the re-export sheet did not offer the extra columns')
    const correctionPlan = await window.webContents.executeJavaScript(
      "(() => document.getElementById('import-plan').textContent)()",
    )
    console.log('[bench] import-plan-v2 ' + JSON.stringify(correctionPlan))
    if (!/^4 rows · 1 added, 2 removed, 1 changed/.test(correctionPlan || '')) {
      throw new Error('the corrected re-export was not planned as a change: ' + correctionPlan)
    }
    await assertPlainSurface('the corrected re-export plan')
    await window.webContents.executeJavaScript("document.getElementById('import-apply').click()")
    for (let waited = 0; waited < 100; waited += 1) {
      const state = JSON.parse(await entryState())
      if (/^Imported 4 row/.test(state.status || '')) break
      const failed = await window.webContents.executeJavaScript(
        "(() => { const e = document.getElementById('import-error'); return e.hidden ? null : e.textContent })()",
      )
      if (failed) throw new Error('the corrected re-export was refused: ' + failed)
      await sleep(100)
    }
    await sleep(500)
    const reExportedState = JSON.parse(await entryState())
    const stripAfterReExport = await window.webContents.executeJavaScript(
      "(() => document.getElementById('view-meta').textContent)()",
    )
    console.log('[bench] re-exported ' + JSON.stringify({
      status: reExportedState.status,
      readout: reExportedState.readout,
      strip: stripAfterReExport,
    }))
    if (!/^Imported 4 rows · 1 added, 2 removed, 1 changed/.test(reExportedState.status || '')) {
      throw new Error('the corrected re-export was not reported as a change: ' + reExportedState.status)
    }
    if (!/2 rows not in the file were withdrawn; the earlier version still holds them/.test(reExportedState.status || '')) {
      throw new Error('the corrected re-export did not account for what left: ' + reExportedState.status)
    }
    if (!/n = 4/.test(reExportedState.readout || '')) {
      throw new Error(`the corrected re-export should leave n = 4, it reads "${reExportedState.readout}"`)
    }
    // The strip is a count, not a version list: what differs between the panels is said by each
    // panel's own state word, and the versions themselves are agent vocabulary.
    if (!/^2 panels · 4 points$/.test(stripAfterReExport)) {
      throw new Error('the strip is not the plain count: ' + stripAfterReExport)
    }
    await assertPlainSurface('after a re-export')
    await saveFrame(join(captureDir, 'app-version-diff.png'), (await window.webContents.capturePage()).toPNG())
    frames += 1

    // The same log read back through the other door: if the CLI and the window disagreed about what
    // version 3 holds, one of them would be inventing an answer.
    const cliVersions = await readCli(['dataset', 'versions', 'main'], importProject)
    const cliDiff = await readCli(['dataset', 'diff', 'main', '3', '4'], importProject)
    console.log('[bench] cli-versions ' + JSON.stringify(cliVersions.trim().split('\n')))
    console.log('[bench] cli-diff ' + JSON.stringify(cliDiff.trim().split('\n')))
    if (!/v2  14 row\(s\) now · 14 at creation/.test(cliVersions)) {
      throw new Error('the CLI does not see the version the window imported:\n' + cliVersions)
    }
    if (!/v3  5 row\(s\) now · 5 at creation  \+5 −14 ~0/.test(cliVersions)) {
      throw new Error('the version the window wrote does not match what the CLI reads:\n' + cliVersions)
    }
    if (!/v4  4 row\(s\) now · 4 at creation  \+1 −2 ~1/.test(cliVersions)) {
      throw new Error('the corrected re-export is not in the chain the CLI reads:\n' + cliVersions)
    }
    if (!/main: version 3 → 4  \+1 −2 ~1  \(4 row\(s\) in v4\)/.test(cliDiff)) {
      throw new Error('the CLI diff of the window\'s own versions is wrong:\n' + cliDiff)
    }
    // The parent is untouched: version 2's rows are still there, and the CLI can still read them.
    const cliParent = await readCli(['dataset', 'diff', 'main', '2', '3'], importProject)
    if (!/\+5 −14 ~0/.test(cliParent) || !/x 1  y 2\.92/.test(cliParent)) {
      throw new Error('the parent version no longer describes what it held:\n' + cliParent)
    }
    // One version record, one row added, one corrected, two withdrawn, one import record.
    const eventsAfterCorrection = (await readFile(join(importProject, 'data', 'events.jsonl'), 'utf8'))
      .trimEnd()
      .split('\n')
      .length
    if (eventsAfterCorrection - eventsBeforeCorrection !== 6) {
      throw new Error(
        `the corrected re-export appended ${eventsAfterCorrection - eventsBeforeCorrection} events, not 6`,
      )
    }

    // The other refusal, through the same sheet: one cell mistyped, so the whole file is refused and
    // the log is left exactly as the good import left it.
    const badFile = join(dirname(importProject), 'lab-export-bad-row.csv')
    await cp(join(here, '..', 'fixtures', 'imports', 'lab-export-bad-row.csv'), badFile)
    setNextPickedFile(badFile)
    await window.webContents.executeJavaScript("document.getElementById('import-open').click()")
    for (let waited = 0; waited < 60; waited += 1) {
      const ready = await window.webContents.executeJavaScript(
        "(() => document.getElementById('import-dialog').open && /lab-export-bad-row\\.csv$/.test(document.getElementById('import-path').textContent) && document.querySelectorAll('#import-fields select').length === 2)()",
      )
      if (ready) break
      await sleep(100)
    }
    await window.webContents.executeJavaScript(`(() => {
      const set = (field, column) => {
        const select = document.querySelector('#import-fields select[data-field="' + field + '"]')
        select.value = column
        select.dispatchEvent(new Event('change', { bubbles: true }))
      }
      set('x', 'temp_c')
      set('y', 'volts')
      return true
    })()`)
    await sleep(300)
    await acknowledgeExtraColumns()
    await window.webContents.executeJavaScript("document.getElementById('import-apply').click()")
    for (let waited = 0; waited < 60; waited += 1) {
      const shown = await window.webContents.executeJavaScript(
        "(() => { const e = document.getElementById('import-error'); return e.hidden ? null : e.textContent })()",
      )
      if (shown) break
      await sleep(100)
    }
    const badRow = await window.webContents.executeJavaScript(`(() => JSON.stringify({
      error: document.getElementById('import-error').hidden ? null : document.getElementById('import-error').textContent,
      open: document.getElementById('import-dialog').open,
      status: document.getElementById('entry-status').textContent,
    }))()`)
    console.log('[bench] import-bad-row ' + badRow)
    const badRowState = JSON.parse(badRow)
    if (!/row 3/.test(badRowState.error || '') || !/twenty-one/.test(badRowState.error || '')) {
      throw new Error('the bad row was not named in the sheet: ' + badRow)
    }
    if (!/so none were/.test(badRowState.error || '')) {
      throw new Error('the refusal does not say the whole file was refused: ' + badRow)
    }
    if (!badRowState.open) throw new Error('the sheet closed on a refusal, taking the mapping with it')
    const afterRefusal = JSON.parse(await entryState())
    const logAfterRefusal = (await readFile(join(importProject, 'data', 'events.jsonl'), 'utf8')).trimEnd().split('\n')
    // Against the drawing the corrected re-export left, not the first import's: the frame this
    // refusal has to leave alone is the one on screen now.
    if (afterRefusal.marks !== reExportedState.marks) {
      throw new Error(`the refused file changed the drawing: ${reExportedState.marks} -> ${afterRefusal.marks}`)
    }
    if (logAfterRefusal.length !== eventsAfterCorrection) {
      throw new Error(`the refused file appended ${logAfterRefusal.length - eventsAfterCorrection} event(s)`)
    }
    await window.webContents.executeJavaScript("document.getElementById('import-cancel').click()")

    // The clock under a name nobody listed: the values are what find it, and the sheet says so before
    // the click. The diff is computed against the version the file actually shares rows with.
    const currentRows = JSON.parse(await readCli(['list', '--json'], importProject)).data
    const namedFile = join(dirname(importProject), 'lab-export-taken-at.csv')
    await saveFrame(
      namedFile,
      'taken_at,x,y\n' +
        currentRows.map((point) => `${point.t_observed},${point.values.x},${point.values.y}`).join('\n') +
        '\n2026-10-16T09:00:00Z,6,13.4\n',
    )
    setNextPickedFile(namedFile)
    await window.webContents.executeJavaScript("document.getElementById('import-open').click()")
    for (let waited = 0; waited < 60; waited += 1) {
      const ready = await window.webContents.executeJavaScript(
        "(() => { const d = document.getElementById('import-dialog'); const select = document.getElementById('import-time'); return d.open && /lab-export-taken-at\.csv$/.test(document.getElementById('import-path').textContent) && Array.prototype.some.call(select.options, (option) => option.value === 'taken_at') })()",
      )
      if (ready) break
      await sleep(100)
    }
    const namedSheet = JSON.parse(await window.webContents.executeJavaScript(`(() => JSON.stringify({
      open: document.getElementById('import-dialog').open,
      path: document.getElementById('import-path').textContent,
      said: document.getElementById('import-time-said').textContent,
      chosen: document.getElementById('import-time').value,
      columns: Array.prototype.map.call(document.getElementById('import-time').options, (option) => option.value),
    }))()`))
    console.log('[bench] import-named-time-said ' + JSON.stringify({ said: namedSheet.said, chosen: namedSheet.chosen }))
    if (!namedSheet.open || !/lab-export-taken-at\.csv$/.test(namedSheet.path)) {
      throw new Error('the named-time file did not reach the sheet: ' + JSON.stringify(namedSheet))
    }
    // A file with a clock never falls back to the estimate: the values found it, and the line says so.
    if (namedSheet.chosen !== 'taken_at' || !/“taken_at” column/.test(namedSheet.said)) {
      throw new Error('the clock under an unlisted name was not stated: ' + JSON.stringify(namedSheet))
    }
    await window.webContents.executeJavaScript(`(() => {
      const select = document.getElementById('import-time')
      if (!Array.prototype.some.call(select.options, (option) => option.value === 'taken_at')) {
        throw new Error('the time picker does not offer taken_at')
      }
      select.value = 'taken_at'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
    await sleep(500)
    const namedPlan = await window.webContents.executeJavaScript(
      "(() => document.getElementById('import-plan').textContent)()",
    )
    console.log('[bench] import-named-time ' + JSON.stringify(namedPlan))
    if (!/^5 rows · 1 added, none removed, none changed/.test(namedPlan || '')) {
      throw new Error('the named time column was not planned as one added row: ' + namedPlan)
    }
    await assertPlainSurface('the named time column sheet')
    await saveFrame(join(captureDir, 'app-import-time.png'), (await window.webContents.capturePage()).toPNG())
    frames += 1
    await window.webContents.executeJavaScript("document.getElementById('import-apply').click()")
    for (let waited = 0; waited < 100; waited += 1) {
      const state = JSON.parse(await entryState())
      if (/^Imported 5 row/.test(state.status || '')) break
      await sleep(100)
    }
    const namedState = JSON.parse(await entryState())
    console.log(
      '[bench] import-named-time-result ' +
        JSON.stringify({ status: namedState.status, readout: namedState.readout }),
    )
    if (!/^Imported 5 rows · 1 added, none removed, none changed/.test(namedState.status || '')) {
      throw new Error('the named time column was not imported as one added row: ' + namedState.status)
    }
    const namedVersions = await readCli(['dataset', 'versions', 'main'], importProject)
    const namedDiff = await readCli(['dataset', 'diff', 'main', '4', '5'], importProject)
    console.log('[bench] import-named-time-cli ' + JSON.stringify(namedVersions.trim().split('\n')))
    if (!/v5  5 row\(s\) now · 5 at creation  \+1 −0 ~0/.test(namedVersions)) {
      throw new Error('the CLI does not see the window\'s timed import:\n' + namedVersions)
    }
    if (!/main: version 4 → 5  \+1 −0 ~0/.test(namedDiff) || !/2026-10-16T09:00:00\.000Z/.test(namedDiff)) {
      throw new Error('the CLI diff does not name the added instant:\n' + namedDiff)
    }

    // A file with no clock at all. A row is its instant, so the sheet says where the times will come
    // from before the click — the row order, marked as an estimate — and the marker lives in the
    // log, not in the sheet. A correction then replaces it with a measured instant.
    const estimatedRows = JSON.parse(await readCli(['list', '--json'], importProject)).data
    const untimedFile = join(dirname(importProject), 'lab-export-untimed.csv')
    await saveFrame(
      untimedFile,
      'x,y\n' +
        estimatedRows.map((point) => `${point.values.x},${point.values.y}`).join('\n') +
        '\n7,12.9\n',
    )
    setNextPickedFile(untimedFile)
    await window.webContents.executeJavaScript("document.getElementById('import-open').click()")
    for (let waited = 0; waited < 60; waited += 1) {
      const ready = await window.webContents.executeJavaScript(
        "(() => { const d = document.getElementById('import-dialog'); return d.open && /lab-export-untimed\\.csv$/.test(document.getElementById('import-path').textContent) && /row order/.test(document.getElementById('import-time-said').textContent) })()",
      )
      if (ready) break
      await sleep(100)
    }
    await sleep(300)
    const estimateSheet = JSON.parse(await window.webContents.executeJavaScript(`(() => JSON.stringify({
      said: document.getElementById('import-time-said').textContent,
      choice: document.getElementById('import-time').value,
      changeShown: !document.getElementById('import-time-change').hidden,
      pickerShown: !document.getElementById('import-time-field').hidden,
      plan: document.getElementById('import-plan').textContent,
      planClass: document.getElementById('import-plan').className,
    }))()`))
    console.log('[bench] import-estimate ' + JSON.stringify(estimateSheet))
    // The guess is stated, not asked: the picker is shut, the sentence says what will be written,
    // and the plan repeats it before the click.
    if (estimateSheet.choice !== 'estimate') {
      throw new Error('the sheet did not choose the row order: ' + estimateSheet.choice)
    }
    if (!/row order/.test(estimateSheet.said) || !/estimated/.test(estimateSheet.said)) {
      throw new Error('the sheet did not say its guess was an estimate: ' + estimateSheet.said)
    }
    if (!estimateSheet.changeShown) throw new Error('the guess cannot be changed: Change is hidden')
    if (estimateSheet.pickerShown) throw new Error('the full time choice was asked instead of guessed')
    if (!/times estimated from the row order/.test(estimateSheet.plan)) {
      throw new Error('the plan does not say the times are estimates: ' + estimateSheet.plan)
    }
    if (/is-error/.test(estimateSheet.planClass)) {
      throw new Error('a labelled estimate was planned as a refusal: ' + estimateSheet.plan)
    }

    // It is still a choice: Change opens the picker and puts the keyboard in it.
    await window.webContents.executeJavaScript("document.getElementById('import-time-change').click()")
    await sleep(200)
    const pickerOpen = await window.webContents.executeJavaScript(
      "(() => !document.getElementById('import-time-field').hidden && document.activeElement === document.getElementById('import-time'))()",
    )
    if (!pickerOpen) throw new Error('Change did not open the time choice, or left the keyboard behind')
    await saveFrame(join(captureDir, 'app-import-time-choice.png'), (await window.webContents.capturePage()).toPNG())
    frames += 1
    // Saying nothing about the time is still a decision to make: the estimate is a statement, not a
    // default the sheet falls back to when it has no answer.
    await window.webContents.executeJavaScript(`(() => {
      const select = document.getElementById('import-time')
      select.value = ''
      select.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
    await sleep(300)
    const undecided = await window.webContents.executeJavaScript(
      "(() => document.getElementById('import-plan').textContent)()",
    )
    if (!/choose the column that holds the observation time/.test(undecided)) {
      throw new Error('an undecided time was not treated as a choice to make: ' + undecided)
    }
    await window.webContents.executeJavaScript(`(() => {
      const select = document.getElementById('import-time')
      select.value = 'estimate'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
    await sleep(400)
    await assertPlainSurface('the estimated time sheet')
    await saveFrame(join(captureDir, 'app-import-estimated.png'), (await window.webContents.capturePage()).toPNG())
    frames += 1
    const beforeEstimate = await logCount(importProject)
    await window.webContents.executeJavaScript("document.getElementById('import-apply').click()")
    const estimateState = await waitStatus(/times estimated from the row order/, 'the estimated import')
    console.log('[bench] import-estimated-result ' + JSON.stringify({ status: estimateState.status }))
    if (!/ 1 added/.test(estimateState.status || '')) {
      throw new Error('the untimed re-read was not one added row: ' + estimateState.status)
    }
    // The marker is in the log — the sheet could be closed by now and the fact would still be there.
    const estimateLog = (await readFile(join(importProject, 'data', 'events.jsonl'), 'utf8'))
      .trimEnd()
      .split('\n')
      .slice(beforeEstimate)
    if (!estimateLog.some((line) => /"t_estimated":true/.test(line))) {
      throw new Error('the estimate is not in the log:\n' + estimateLog.join('\n'))
    }
    const estimatedPoints = JSON.parse(await readCli(['list', '--json'], importProject)).data.filter(
      (point) => point.t_estimated === true,
    )
    console.log(
      '[bench] import-estimated-cli ' +
        JSON.stringify(estimatedPoints.map((point) => ({ x: point.values.x, t: point.t_observed }))),
    )
    if (estimatedPoints.length !== 1) {
      throw new Error(`the log marks ${estimatedPoints.length} row(s) as estimated, not 1`)
    }
    const estimatedList = await readCli(['list'], importProject)
    if (estimatedList.split('\n').filter((line) => /\(estimated\)/.test(line)).length !== 1) {
      throw new Error('the text list does not mark exactly the estimated row:\n' + estimatedList)
    }

    // The strip is where an estimate is replaced, and it says which time is the guess.
    const estimatedPoint = estimatedPoints[0]
    const clickedEstimated = await selectMarkById(estimatedPoint.id)
    if (!clickedEstimated) {
      throw new Error('the estimated point is not drawn, so its time cannot be replaced from the window')
    }
    await sleep(300)
    const estimatedStrip = JSON.parse(await window.webContents.executeJavaScript(`(() => JSON.stringify({
      shown: !document.getElementById('entry-observed').hidden,
      value: document.getElementById('entry-observed-input').value,
      note: document.getElementById('entry-observed-note').textContent,
    }))()`))
    console.log('[bench] estimated-strip ' + JSON.stringify(estimatedStrip))
    if (!estimatedStrip.shown) throw new Error('the strip does not offer an estimated time for replacement')
    if (estimatedStrip.value === '') throw new Error('the observed control was not filled from the log')
    if (estimatedStrip.note !== 'estimated') {
      throw new Error('the strip does not mark the estimated time: ' + JSON.stringify(estimatedStrip.note))
    }
    await saveFrame(join(captureDir, 'app-point-estimated.png'), (await window.webContents.capturePage()).toPNG())
    frames += 1

    // The strip gained a control, so it has to fit its row at every scaling the window is checked at.
    const stripFit = {}
    for (const scaling of [1, 1.25, 1.5]) {
      await window.webContents.setZoomFactor(scaling)
      await sleep(250)
      stripFit[scaling] = await window.webContents.executeJavaScript(`(() => {
        const row = document.getElementById('entry-correct')
        return row.scrollWidth - Math.round(row.getBoundingClientRect().width)
      })()`)
    }
    await window.webContents.setZoomFactor(1)
    await sleep(250)
    console.log('[bench] estimated-strip-overflow ' + JSON.stringify(stripFit))
    for (const [scaling, overflow] of Object.entries(stripFit)) {
      if (overflow > 1) {
        throw new Error(`the correction row overflows by ${overflow}px at ${scaling}× scaling`)
      }
    }

    // Typing a measured instant and pressing Enter: the same path a person uses, and the only path.
    const replacement = '2026-10-20T09:00'
    await window.webContents.executeJavaScript(`(() => {
      const input = document.getElementById('entry-observed-input')
      input.value = ${JSON.stringify(replacement)}
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.focus()
      return input.value
    })()`)
    pressEnter()
    const replacedState = await waitStatus(/^Corrected /, 'the replacement of an estimated time')
    const replacedAt = new Date(replacement).toISOString()
    const shownAt = new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(replacement))
    console.log('[bench] estimated-replaced ' + JSON.stringify({ status: replacedState.status, replacedAt }))
    if (!(replacedState.status || '').includes('observed ' + shownAt)) {
      throw new Error('the status does not name the measured time: ' + replacedState.status)
    }
    if (/estimated/.test(replacedState.status || '')) {
      throw new Error('a measured time is still called an estimate: ' + replacedState.status)
    }
    if (JSON.parse(await entryState()).correcting) {
      throw new Error('the strip stayed open after the time was replaced')
    }
    const replacedRows = JSON.parse(await readCli(['list', '--json'], importProject)).data
    const replacedRow = replacedRows.find((point) => point.id === estimatedPoint.id)
    if (!replacedRow) throw new Error('the replaced point is not in the data')
    if (replacedRow.t_observed !== replacedAt) {
      throw new Error(`the row's time is ${replacedRow.t_observed}, not ${replacedAt}`)
    }
    if (replacedRow.t_estimated !== undefined) {
      throw new Error('the estimate marker survived a measured instant')
    }
    if (replacedRows.some((point) => point.t_estimated === true)) {
      throw new Error('an estimate remains after the only one was replaced')
    }
    const replacedList = await readCli(['list'], importProject)
    if (/\(estimated\)/.test(replacedList)) {
      throw new Error('the text list still marks an estimate:\n' + replacedList)
    }
    const replacedEvents = (await readFile(join(importProject, 'data', 'events.jsonl'), 'utf8')).trimEnd().split('\n')
    if (!replacedEvents.at(-1).includes('point_corrected')) {
      throw new Error('replacing the time did not append one correction: ' + replacedEvents.at(-1))
    }
    if (!/"t_observed"/.test(replacedEvents.at(-1)) || /"t_estimated"/.test(replacedEvents.at(-1))) {
      throw new Error('the correction does not carry the measured time alone: ' + replacedEvents.at(-1))
    }

    // A tab whose panels were drawn from different versions. A refresh repins only the panels it
    // redraws, so this is a state a tab reaches in normal use — the strip has to name every version
    // on it, not whichever panel happens to be first.
    const mixedProject = join(dirname(importProject), 'mixed-versions')
    await cp(startupDir, mixedProject, { recursive: true })
    await rm(join(mixedProject, 'views', 'drift-over-time.json'))
    await readCli(['view', 'new', 'mixed versions', '--dataset', 'main'], mixedProject)
    const mixedBase = JSON.parse(await readCli(['list', '--json'], mixedProject)).data
    const csvOf = (rows) =>
      't_observed,x,y\n' + rows.map((point) => `${point.t_observed},${point.values.x},${point.values.y}`).join('\n') + '\n'
    // Version 3: the tab's first panel stays pinned to 2; the second is added after this import.
    await saveFrame(
      join(dirname(mixedProject), 'mixed-v3.csv'),
      csvOf(mixedBase) + '2026-10-17T09:00:00Z,9,21\n',
    )
    await readCli(['import', join(dirname(mixedProject), 'mixed-v3.csv'), '--map', 'x=x', '--map', 'y=y'], mixedProject)
    await readCli(['view', 'add', 'mixed versions', '--dataset', 'main'], mixedProject)
    // Version 4: the dataset moves past both panels, so the strip must say what is pinned and what
    // the data is at now.
    await saveFrame(
      join(dirname(mixedProject), 'mixed-v4.csv'),
      csvOf(mixedBase) + '2026-10-17T09:00:00Z,9,21\n2026-10-18T09:00:00Z,10,23\n',
    )
    await readCli(['import', join(dirname(mixedProject), 'mixed-v4.csv'), '--map', 'x=x', '--map', 'y=y'], mixedProject)

    setNextStartup(mixedProject)
    window.webContents.reload()
    await new Promise((done) => ipcMain.once('bench:ready', done))
    await sleep(700)
    const mixedStrip = await window.webContents.executeJavaScript(
      "(() => document.getElementById('view-meta').textContent)()",
    )
    const mixedBadges = await window.webContents.executeJavaScript(
      "(() => JSON.stringify(Array.prototype.map.call(document.querySelectorAll('.panel-strip .badge'), (badge) => badge.textContent)))()",
    )
    console.log('[bench] mixed-versions ' + JSON.stringify({ strip: mixedStrip, badges: JSON.parse(mixedBadges) }))
    if (!/^2 panels · 16 points$/.test(mixedStrip)) {
      throw new Error('the strip is not the plain count: ' + mixedStrip)
    }
    if (JSON.parse(mixedBadges).length !== 2) {
      throw new Error('the mixed tab did not paint two panels: ' + mixedBadges)
    }
    if (!JSON.parse(mixedBadges).every((badge) => badge === 'Out of date')) {
      throw new Error('a panel drawn from older data does not say so: ' + mixedBadges)
    }
    await assertPlainSurface('a tab drawn from two versions')
    await saveFrame(join(captureDir, 'app-mixed-versions.png'), (await window.webContents.capturePage()).toPNG())
    frames += 1

    // Undoing an import from the window. Its own copy of the fixture keeps the version numbers in the
    // frames above as they were. The sheet is the same door a person uses, and the undo is a real
    // Ctrl+Z: the version that was replaced becomes current again *as a new version*, never a
    // deletion, and redo restores the imported one the same way.
    const undoImportProject = join(dirname(writableDir), 'undo-import')
    await cp(startupDir, undoImportProject, { recursive: true })
    const undoImportFile = join(dirname(undoImportProject), 'two-rows.csv')
    await saveFrame(
      undoImportFile,
      'timestamp,x,y\n2026-01-05T09:00:00Z,21.4,3.301\n2026-01-05T09:05:00Z,21.9,3.355\n',
      'utf8',
    )
    setNextStartup(undoImportProject)
    setNextPickedFile(undoImportFile)
    window.webContents.reload()
    await new Promise((done) => ipcMain.once('bench:ready', done))
    if (!(await focusWindowForInput())) {
      throw new Error('the window never took focus for the import-undo frame')
    }
    await sleep(700)

    const beforeUndoImport = JSON.parse(await entryState())
    await window.webContents.executeJavaScript("document.getElementById('import-open').click()")
    for (let waited = 0; waited < 60; waited += 1) {
      const ready = await window.webContents.executeJavaScript(
        "(() => { const d = document.getElementById('import-dialog'); return d.open && !document.getElementById('import-apply').disabled })()",
      )
      if (ready) break
      await sleep(100)
    }
    await window.webContents.executeJavaScript("document.getElementById('import-apply').click()")
    for (let waited = 0; waited < 100; waited += 1) {
      const state = JSON.parse(await entryState())
      if (/^Imported 2 rows/.test(state.status || '')) break
      const failed = await window.webContents.executeJavaScript(
        "(() => { const e = document.getElementById('import-error'); return e.hidden ? null : e.textContent })()",
      )
      if (failed) throw new Error('the import for the undo frame was refused: ' + failed)
      await sleep(100)
    }
    await sleep(500)

    // The version record is the first event of a write, not the last: a restore ends with the row
    // events that brought the rows back. Read the newest version record, whichever write it was.
    const lastVersionEvent = async () => {
      const events = (await readFile(join(undoImportProject, 'data', 'events.jsonl'), 'utf8'))
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line))
      return events.filter((event) => event.type === 'dataset_version_created').at(-1)
    }
    const importedForUndo = JSON.parse(await entryState())
    const importedVersion = await lastVersionEvent()
    const importUndo = JSON.parse(
      await window.webContents.executeJavaScript(
        "(() => { const button = document.getElementById('entry-undo'); return JSON.stringify({ label: button.textContent, title: button.title }) })()",
      ),
    )
    const importUndoLabel = importUndo.label
    console.log(
      '[bench] import-undo-ready ' +
        JSON.stringify({
          status: importedForUndo.status,
          readout: importedForUndo.readout,
          before: beforeUndoImport.readout,
          undo: importUndoLabel,
          undoTitle: importUndo.title,
          version: {
            version: importedVersion.version,
            parent: importedVersion.parent,
            rows: importedVersion.rows,
          },
        }),
    )
    if (!/^Imported 2 rows/.test(importedForUndo.status || '')) {
      throw new Error('the window did not report the import it just made: ' + importedForUndo.status)
    }
    if (!/n = 2/.test(importedForUndo.readout || '')) {
      throw new Error('the imported tab does not read n = 2: ' + importedForUndo.readout)
    }
    if (importUndoLabel !== 'Undo import') {
      throw new Error('the bar does not offer the import it just recorded: ' + importUndoLabel)
    }
    if (importUndo.title !== 'Undo the last import (Ctrl+Z in an empty field)') {
      throw new Error('the import tooltip does not name the act: ' + importUndo.title)
    }
    if (importedVersion.version !== 3 || importedVersion.parent !== 2) {
      throw new Error('the import did not write version 3 over 2: ' + JSON.stringify(importedVersion))
    }

    // Ctrl+Z in an empty field: version 2's rows come back as version 4, not as three hundred edits
    // without a version record.
    await focusField(0)
    pressKey('Z', ['control'])
    for (let waited = 0; waited < 100; waited += 1) {
      const state = JSON.parse(await entryState())
      if (/^Restored the data from before the import/.test(state.status || '')) break
      await sleep(100)
    }
    const undoneImport = JSON.parse(await entryState())
    const restoredVersion = await lastVersionEvent()
    const redoImport = JSON.parse(
      await window.webContents.executeJavaScript(
        "(() => { const button = document.querySelector('#entry-status .status-action'); return JSON.stringify({ label: button ? button.textContent : null, title: button ? button.title : null }) })()",
      ),
    )
    const redoImportLabel = redoImport.label
    console.log(
      '[bench] import-undone ' +
        JSON.stringify({
          status: undoneImport.status,
          readout: undoneImport.readout,
          redo: redoImportLabel,
          redoTitle: redoImport.title,
          version: {
            version: restoredVersion.version,
            parent: restoredVersion.parent,
            rows: restoredVersion.rows,
            source: restoredVersion.source,
            diff: restoredVersion.diff,
          },
        }),
    )
    if (!/^Restored the data from before the import/.test(undoneImport.status || '')) {
      throw new Error('undoing the import reported nothing: ' + undoneImport.status)
    }
    if (!/n = 14/.test(undoneImport.readout || '')) {
      throw new Error('undoing the import did not bring the rows back: ' + undoneImport.readout)
    }
    if (redoImportLabel !== 'Reapply import') {
      throw new Error('undoing the import offers no redo: ' + redoImportLabel)
    }
    if (redoImport.title !== 'Redo the import that was undone (Ctrl+Shift+Z or Ctrl+Y in an empty field)') {
      throw new Error('the redo tooltip does not name the import: ' + redoImport.title)
    }
    if (
      restoredVersion.type !== 'dataset_version_created' ||
      restoredVersion.version !== 4 ||
      restoredVersion.parent !== 3 ||
      restoredVersion.rows !== 14 ||
      restoredVersion.source !== 'restored from version 2'
    ) {
      throw new Error('undoing the import did not restore version 2 as version 4: ' + JSON.stringify(restoredVersion))
    }
    if (JSON.stringify(restoredVersion.diff) !== JSON.stringify({ added: 14, removed: 2, changed: 0 })) {
      throw new Error('the restore recorded a diff that does not match the rows: ' + JSON.stringify(restoredVersion.diff))
    }
    await saveFrame(join(captureDir, 'app-import-undone.png'), (await window.webContents.capturePage()).toPNG())
    frames += 1
    await assertPlainSurface('after undoing an import')

    // Redo by keyboard: the imported version returns, again as a new version.
    pressKey('Z', ['control', 'shift'])
    for (let waited = 0; waited < 100; waited += 1) {
      const state = JSON.parse(await entryState())
      if (/^Reapplied the import/.test(state.status || '')) break
      await sleep(100)
    }
    const redoneImport = JSON.parse(await entryState())
    const reopenedVersion = await lastVersionEvent()
    console.log(
      '[bench] import-redone ' +
        JSON.stringify({
          status: redoneImport.status,
          readout: redoneImport.readout,
          version: {
            version: reopenedVersion.version,
            parent: reopenedVersion.parent,
            rows: reopenedVersion.rows,
            source: reopenedVersion.source,
          },
        }),
    )
    if (!/^Reapplied the import/.test(redoneImport.status || '')) {
      throw new Error('redoing the import reported nothing: ' + redoneImport.status)
    }
    if (!/n = 2/.test(redoneImport.readout || '')) {
      throw new Error('redoing the import did not reapply its rows: ' + redoneImport.readout)
    }
    if (
      reopenedVersion.type !== 'dataset_version_created' ||
      reopenedVersion.version !== 5 ||
      reopenedVersion.parent !== 4 ||
      reopenedVersion.rows !== 2 ||
      reopenedVersion.source !== 'restored from version 3'
    ) {
      throw new Error('redoing the import did not restore version 3 as version 5: ' + JSON.stringify(reopenedVersion))
    }

    // And once more in the other direction, so the stack is proved to cycle rather than work once.
    await focusField(0)
    pressKey('Z', ['control'])
    for (let waited = 0; waited < 100; waited += 1) {
      const state = JSON.parse(await entryState())
      if (/^Restored the data from before the import/.test(state.status || '')) break
      await sleep(100)
    }
    const secondUndo = await lastVersionEvent()
    if (secondUndo.version !== 6 || secondUndo.rows !== 14) {
      throw new Error('the second undo did not restore the older rows again: ' + JSON.stringify(secondUndo))
    }
    await assertPlainSurface('after redoing an import')

    // A refusal that can never succeed must stop being offered. The watcher is stopped for this
    // probe on purpose: a watched reload clears the tab's history, which is what usually hides this
    // case, and clearing it would hide the decision being checked. What is left is the situation the
    // classification exists for — the record moved after the window drew it — driven by the real
    // key, the real handler and the real IPC envelope.
    await enterPoint(22.4, 3.7)
    const offeredUndo = JSON.parse(
      await window.webContents.executeJavaScript(`(() => JSON.stringify({
        label: document.getElementById('entry-undo').textContent,
        enabled: !document.getElementById('entry-undo').disabled,
      }))()`),
    )
    if (offeredUndo.enabled !== true || offeredUndo.label !== 'Undo added point') {
      throw new Error('the probe point left no undo to refuse: ' + JSON.stringify(offeredUndo))
    }
    await window.webContents.executeJavaScript(
      `window.bench.watch(${JSON.stringify(undoImportProject)}, null)`,
    )
    const probePoint = (await readFile(join(undoImportProject, 'data', 'events.jsonl'), 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === 'point_recorded')
      .at(-1)
    const moved = await window.webContents.executeJavaScript(
      `window.bench.retractPoint(${JSON.stringify(undoImportProject)}, ${JSON.stringify(probePoint.id)})`,
    )
    if (!moved || moved.ok !== true) {
      throw new Error('the probe could not move the record under the window: ' + JSON.stringify(moved))
    }
    const eventCount = async () =>
      (await readFile(join(undoImportProject, 'data', 'events.jsonl'), 'utf8')).trimEnd().split('\n').length
    const eventsBeforeUndo = await eventCount()
    await focusField(0)
    pressKey('Z', ['control'])
    for (let waited = 0; waited < 60; waited += 1) {
      const state = JSON.parse(await entryState())
      if (state.status && /already been removed/.test(state.status)) break
      await sleep(100)
    }
    const refusedUndo = JSON.parse(
      await window.webContents.executeJavaScript(`(() => JSON.stringify({
        status: document.getElementById('entry-status').textContent,
        label: document.getElementById('entry-undo').textContent,
        enabled: !document.getElementById('entry-undo').disabled,
      }))()`),
    )
    const eventsAfterUndo = await eventCount()
    console.log(
      '[bench] refused-undo ' +
        JSON.stringify({ ...refusedUndo, eventsWritten: eventsAfterUndo - eventsBeforeUndo }),
    )
    if (!/^That point has already been removed$/.test(refusedUndo.status)) {
      throw new Error('undoing a record another writer withdrew did not say so: ' + refusedUndo.status)
    }
    if (refusedUndo.enabled !== false || refusedUndo.label !== 'Undo') {
      throw new Error('an act that can never succeed is still offered: ' + JSON.stringify(refusedUndo))
    }
    if (eventsAfterUndo !== eventsBeforeUndo) {
      throw new Error('an undo the core refused wrote an event anyway')
    }

    // An import ends only the acts it touched. Two sequences, both driven by the real keys: a point
    // whose row the file already holds must stay undoable across the import, and a point the file
    // leaves out must be dropped rather than offered and then refused.
    const keepsProject = join(dirname(writableDir), 'import-keeps')
    await cp(startupDir, keepsProject, { recursive: true })
    setNextStartup(keepsProject)
    window.webContents.reload()
    await new Promise((done) => ipcMain.once('bench:ready', done))
    if (!(await focusWindowForInput())) {
      throw new Error('the window never took focus for the import-reconciliation frames')
    }
    await sleep(700)

    const lastLoggedEvent = async (project) => {
      const lines = (await readFile(join(project, 'data', 'events.jsonl'), 'utf8')).trimEnd().split('\n')
      return JSON.parse(lines[lines.length - 1])
    }
    const importThroughSheet = async (file, expected, what) => {
      setNextPickedFile(file)
      await window.webContents.executeJavaScript("document.getElementById('import-open').click()")
      for (let waited = 0; waited < 80; waited += 1) {
        const ready = await window.webContents.executeJavaScript(
          "(() => { const d = document.getElementById('import-dialog'); return d.open && !document.getElementById('import-apply').disabled })()",
        )
        if (ready) break
        await sleep(100)
      }
      await window.webContents.executeJavaScript("document.getElementById('import-apply').click()")
      for (let waited = 0; waited < 120; waited += 1) {
        const state = JSON.parse(await entryState())
        if (expected.test(state.status || '')) {
          // The status is written before the write settles, and the bar is redrawn in its `finally`;
          // reading the button here would see the disabled state of the call that just finished.
          for (let settled = 0; settled < 40; settled += 1) {
            if (!(await barUndo()).disabled) return state
            await sleep(50)
          }
          return state
        }
        const failed = await window.webContents.executeJavaScript(
          "(() => { const e = document.getElementById('import-error'); return e.hidden ? null : e.textContent })()",
        )
        if (failed) throw new Error(what + ' was refused: ' + failed)
        await sleep(100)
      }
      throw new Error(what + ' never reported: ' + (await entryState()))
    }
    const rowsOf = (rows) =>
      'timestamp,x,y\n' +
      rows.map((row) => `${row.t_observed},${row.values.x},${row.values.y}`).join('\n') +
      '\n'

    // The rows the project already has, read through the other door: the file below repeats every one
    // of them, so the import has nothing to withdraw or rewrite.
    const baseRows = JSON.parse(await readCli(['list', '--json'], keepsProject)).data
    await enterPoint(4.2, 9.1)
    const typedPoint = (await readFile(join(keepsProject, 'data', 'events.jsonl'), 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === 'point_recorded')
      .at(-1)
    const keepsFile = join(dirname(keepsProject), 'keeps.csv')
    await saveFrame(
      keepsFile,
      rowsOf([
        ...baseRows,
        { t_observed: typedPoint.t_observed, values: typedPoint.values },
        { t_observed: '2026-10-20T23:59:58.000Z', values: { x: 5.5, y: 6.6 } },
      ]),
      'utf8',
    )
    const importedKeeps = await importThroughSheet(keepsFile, /^Imported 16 rows/, 'the import of the kept rows')
    const keptOffered = await barUndo()
    console.log(
      '[bench] import-keeps ' +
        JSON.stringify({ status: importedKeeps.status, readout: importedKeeps.readout, undo: keptOffered }),
    )
    if (keptOffered.disabled || keptOffered.label !== 'Undo import') {
      throw new Error('the import did not become the newest act: ' + JSON.stringify(keptOffered))
    }

    await focusField(0)
    pressKey('Z', ['control'])
    const afterKeepsUndo = await waitStatus(/^Restored the data from before the import/, 'undoing the kept import')
    const earlierAct = await barUndo()
    console.log(
      '[bench] import-keeps-undone ' +
        JSON.stringify({ status: afterKeepsUndo.status, readout: afterKeepsUndo.readout, undo: earlierAct }),
    )
    if (earlierAct.disabled || earlierAct.label !== 'Undo added point') {
      throw new Error('undoing the import lost the typing recorded before it: ' + JSON.stringify(earlierAct))
    }

    // The earlier act still means what it meant: the version the import replaced held that record
    // unchanged, so withdrawing it now is the same undo the person would have had without the import.
    pressKey('Z', ['control'])
    const afterTypedUndo = await waitStatus(/^Removed/, 'undoing the point recorded before the import')
    const typedRetraction = await lastLoggedEvent(keepsProject)
    console.log(
      '[bench] import-keeps-point-undone ' +
        JSON.stringify({ status: afterTypedUndo.status, readout: afterTypedUndo.readout, event: typedRetraction.type }),
    )
    if (typedRetraction.type !== 'point_retracted' || typedRetraction.supersedes !== typedPoint.id) {
      throw new Error('the earlier typing did not withdraw its own record: ' + JSON.stringify(typedRetraction))
    }
    if (!/n = 14/.test(afterTypedUndo.readout || '')) {
      throw new Error('the tab did not go back to the rows the fixture had: ' + afterTypedUndo.readout)
    }

    // Now the other half: a file that leaves the typed point out. The import withdraws that record,
    // so the typing is dropped from the history — not offered and then refused.
    await enterPoint(3.3, 7.7)

    // The row is selected before the import: the strip is the tab's other memory of a record, and an
    // import that withdraws the row must end that edit as well as the history entry about it.
    const typedDrops = (await readFile(join(keepsProject, 'data', 'events.jsonl'), 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === 'point_recorded')
      .at(-1)
    if (!(await selectMarkById(typedDrops.id))) {
      throw new Error('the typed point is not a mark to select')
    }
    const stripBeforeDrops = JSON.parse(await entryState())
    console.log(
      '[bench] import-drops-strip ' +
        JSON.stringify({ correcting: stripBeforeDrops.correcting, status: stripBeforeDrops.status }),
    )
    if (!stripBeforeDrops.correcting || !/^Editing /.test(stripBeforeDrops.status || '')) {
      throw new Error('selecting the typed point did not open its strip: ' + JSON.stringify(stripBeforeDrops))
    }
    const dropsFile = join(dirname(keepsProject), 'drops.csv')
    await saveFrame(dropsFile, rowsOf(baseRows), 'utf8')
    const importedDrops = await importThroughSheet(dropsFile, /^Imported 14 rows/, 'the import that withdraws the point')
    console.log('[bench] import-drops ' + JSON.stringify({ status: importedDrops.status, readout: importedDrops.readout }))

    // The strip ends with the row, so the Save key has nothing left to save to: the bar is adding
    // again, and Enter writes no correction for a record the version withdrew.
    const stripAfterDrops = JSON.parse(await entryState())
    const eventsBeforeSave = await logCount(keepsProject)
    await focusField(0)
    pressEnter()
    await sleep(600)
    const eventsAfterSave = await logCount(keepsProject)
    const correctionsAfter = (await readFile(join(keepsProject, 'data', 'events.jsonl'), 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === 'point_corrected' && event.supersedes === typedDrops.id)
    console.log(
      '[bench] import-drops-save ' +
        JSON.stringify({
          correcting: stripAfterDrops.correcting,
          status: stripAfterDrops.status,
          eventsWritten: eventsAfterSave - eventsBeforeSave,
          corrections: correctionsAfter.length,
        }),
    )
    if (stripAfterDrops.correcting) {
      throw new Error('the strip outlived the row it was editing: ' + JSON.stringify(stripAfterDrops))
    }
    if (eventsAfterSave !== eventsBeforeSave || correctionsAfter.length !== 0) {
      throw new Error('a Save after the row was withdrawn wrote an event')
    }

    await focusField(0)
    pressKey('Z', ['control'])
    const afterDropsUndo = await waitStatus(/^Restored the data from before the import/, 'undoing the withdrawing import')
    const eventsBeforeIdle = await logCount(keepsProject)
    const idleUndo = await barUndo()
    await focusField(0)
    pressKey('Z', ['control'])
    await sleep(500)
    const eventsAfterIdle = await logCount(keepsProject)
    console.log(
      '[bench] import-drops-undone ' +
        JSON.stringify({
          status: afterDropsUndo.status,
          readout: afterDropsUndo.readout,
          undo: idleUndo,
          eventsWritten: eventsAfterIdle - eventsBeforeIdle,
        }),
    )
    if (idleUndo.disabled !== true || idleUndo.label !== 'Undo') {
      throw new Error('the typing the import withdrew is still offered: ' + JSON.stringify(idleUndo))
    }
    if (eventsAfterIdle !== eventsBeforeIdle) {
      throw new Error('an act the import ended wrote an event after all')
    }
    // The other route to the same state: a strip open on a point whose own add is what Ctrl+Z takes
    // back. The strip ends with the record here too, so the Save key cannot land on a row the log no
    // longer holds.
    const undoStripProject = join(dirname(writableDir), 'undo-strip')
    await cp(startupDir, undoStripProject, { recursive: true })
    setNextStartup(undoStripProject)
    window.webContents.reload()
    await new Promise((done) => ipcMain.once('bench:ready', done))
    if (!(await focusWindowForInput())) {
      throw new Error('the window never took focus for the undo-strip frame')
    }
    await sleep(700)

    await enterPoint(8.1, 2.4)
    const addedUnderStrip = (await readFile(join(undoStripProject, 'data', 'events.jsonl'), 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === 'point_recorded')
      .at(-1)
    if (!(await selectMarkById(addedUnderStrip.id))) {
      throw new Error('the point just added is not a mark to select')
    }
    const stripBeforeUndo = JSON.parse(await entryState())
    if (!stripBeforeUndo.correcting) {
      throw new Error('selecting the added point opened no strip: ' + JSON.stringify(stripBeforeUndo))
    }
    // Ctrl+Z is the history's only while the fields hold nothing: a text field owns its own undo, and
    // clearing them is what puts the same keys back on the point history.
    await window.webContents.executeJavaScript(`(() => {
      document.querySelectorAll('#entry-fields input').forEach((input) => { input.value = '' })
      return true
    })()`)
    await focusField(0)
    pressKey('Z', ['control'])
    const afterUndoAdd = await waitStatus(/^Removed/, 'undoing the added point under its strip')
    const stripAfterUndo = JSON.parse(await entryState())
    const eventsBeforeEnter = await logCount(undoStripProject)
    pressEnter()
    await sleep(600)
    const eventsAfterEnter = await logCount(undoStripProject)
    console.log(
      '[bench] undo-strip ' +
        JSON.stringify({
          opened: stripBeforeUndo.correcting,
          status: afterUndoAdd.status,
          correcting: stripAfterUndo.correcting,
          eventsWritten: eventsAfterEnter - eventsBeforeEnter,
        }),
    )
    if (stripAfterUndo.correcting) {
      throw new Error('the strip outlived the point its own undo withdrew')
    }
    if (eventsAfterEnter !== eventsBeforeEnter) {
      throw new Error('a Save after the undo withdrew the row wrote an event')
    }

    // Closing a tab is the one act with an inverse that lives outside the log: the window keeps the
    // tab's own file and its acts, and Ctrl+Shift+T puts the same drawing back. Driven here through
    // the real button and the real keys, in a copy of the fixture so the counts are known.
    const closedProject = join(dirname(writableDir), 'closed-tab')
    await cp(startupDir, closedProject, { recursive: true })
    setNextStartup(closedProject)
    window.webContents.reload()
    await new Promise((done) => ipcMain.once('bench:ready', done))
    if (!(await focusWindowForInput())) {
      throw new Error('the window never took focus for the closed-tab frames')
    }
    await sleep(700)

    const closedFile = join(closedProject, 'views', 'drift-over-time.json')
    if (!existsSync(closedFile)) throw new Error('the tab about to be closed has no file')
    await enterPoint(5.6, 11.3)
    // The tab file catches up after the paint; closing reads that file, so let it land first.
    await sleep(600)
    const specBeforeClose = JSON.parse(await readFile(closedFile, 'utf8'))
    if (!specBeforeClose.panels.some((panel) => panel.n === 15)) {
      throw new Error('the typed point never reached the tab file: ' + JSON.stringify(specBeforeClose.panels.map((panel) => panel.n)))
    }
    const undoBeforeClose = await barUndo()

    await window.webContents.executeJavaScript("document.getElementById('close-tab').click()")
    const closedState = await waitStatus(/^Closed /, 'closing the tab')
    const afterClose = JSON.parse(await entryState())
    const closeAction = await window.webContents.executeJavaScript(`(() => {
      const button = document.querySelector('#entry-status .status-action')
      return button ? { label: button.textContent, title: button.title } : null
    })()`)
    console.log(
      '[bench] tab-closed ' +
        JSON.stringify({
          status: closedState.status,
          tabs: afterClose.tabs,
          readout: closedState.readout,
          fileGone: !existsSync(closedFile),
          action: closeAction,
        }),
    )
    if (existsSync(closedFile)) throw new Error('closing the tab left its file in the project')
    // The bar types into the project now, and its count is the data's: the point typed just before
    // the close is in it, not a figure from when the project was opened.
    if (!/n = 15/.test(closedState.readout || '')) {
      throw new Error('the closed stage counts the wrong rows: ' + closedState.readout)
    }
    // An empty stage names the project: a title and a count from the tab that just left would
    // describe a drawing that is not there.
    const closedHeader = JSON.parse(
      await window.webContents.executeJavaScript(`(() => JSON.stringify({
        title: document.getElementById('view-title').textContent,
        crumb: document.getElementById('crumb').textContent,
        meta: document.getElementById('view-meta').textContent,
      }))()`),
    )
    console.log('[bench] tab-closed-header ' + JSON.stringify(closedHeader))
    if (closedHeader.title === 'drift over time' || closedHeader.meta !== '') {
      throw new Error('the closed stage still describes the closed tab: ' + JSON.stringify(closedHeader))
    }
    if (afterClose.tabs !== 0) {
      throw new Error('the closed tab is still in the rail: ' + JSON.stringify({ tabs: afterClose.tabs }))
    }
    if (!closeAction || closeAction.label !== 'Undo tab close') {
      throw new Error('the status offered no way back to the closed tab: ' + JSON.stringify(closeAction))
    }
    await assertPlainSurface('the tab just closed')

    // The frame a person would review: the stage with nothing on it, and the status offering the way
    // back. Each scaling is measured rather than eyeballed, so a wrapped status or a button pushed
    // off the header is a failure, not a photograph nobody reads.
    for (const [label, factor] of [['100', 1], ['125', 1.25], ['150', 1.5]]) {
      const atClosed = await frameAt(factor, `app-tab-closed-${label}.png`)
      console.log(`[bench] tab-closed-${label} ` + JSON.stringify(atClosed))
      if (atClosed.overflowX > 0) throw new Error(`the closed stage scrolls sideways at ${label}%`)
      if (!atClosed.actionInView) throw new Error(`the way back is outside the window at ${label}%`)
      if (atClosed.actionLines !== 1) throw new Error(`the way back wrapped at ${label}%`)
      // Nothing is open, so there is nothing to close: the control leaves with the tab.
      if (atClosed.closeInView) throw new Error(`the close control outlived its tab at ${label}%`)
    }

    // Ctrl+Shift+T with the cursor in a field: the chord has no meaning to a text input, so unlike
    // Ctrl+Z it is not deferred to the field it is pressed in.
    await focusField(0)
    pressKey('T', ['control', 'shift'])
    const reopenedState = await waitStatus(/^Reopened /, 'reopening the closed tab')
    const reopenedUndo = await barUndo()
    const reopenedTitle = await window.webContents.executeJavaScript(
      "document.getElementById('view-title').textContent",
    )
    console.log(
      '[bench] tab-reopened ' +
        JSON.stringify({
          status: reopenedState.status,
          title: reopenedTitle,
          readout: reopenedState.readout,
          undoBefore: undoBeforeClose,
          undo: reopenedUndo,
          tabs: reopenedState.tabs,
        }),
    )
    if (reopenedTitle !== 'drift over time') {
      throw new Error('the reopened tab is not the tab that closed: ' + reopenedTitle)
    }
    if (!/n = 15/.test(reopenedState.readout || '')) {
      throw new Error('the reopened tab lost its data: ' + reopenedState.readout)
    }
    if (reopenedUndo.disabled || reopenedUndo.label !== 'Undo added point') {
      throw new Error('the reopened tab lost the acts made in it: ' + JSON.stringify(reopenedUndo))
    }
    if (reopenedState.tabs !== 1) throw new Error('the reopened tab is not in the rail again')
    if (!existsSync(closedFile)) throw new Error('the reopened tab wrote no file')
    await assertPlainSurface('the tab that came back')

    // The tab that came back, at each scaling: the close control sits beside the tab's facts, and the
    // bar still holds the act the tab had. A header that wraps the button out of reach fails here.
    for (const [label, factor] of [['100', 1], ['125', 1.25], ['150', 1.5]]) {
      const atReopened = await frameAt(factor, `app-tab-reopened-${label}.png`)
      console.log(`[bench] tab-reopened-${label} ` + JSON.stringify(atReopened))
      if (atReopened.overflowX > 0) throw new Error(`the reopened tab scrolls sideways at ${label}%`)
      if (!atReopened.closeInView) throw new Error(`the close control is outside the window at ${label}%`)
      if (atReopened.closeBelowHeader) {
        throw new Error(`the close control wrapped under the tab's facts at ${label}%`)
      }
      if (!atReopened.undoInView) throw new Error(`the bar's undo is outside the window at ${label}%`)
    }

    // And on an empty stack the chord does nothing at all: no sentence, no write, no repaint.
    const eventsBeforeEmpty = await logCount(closedProject)
    const statusBeforeEmpty = reopenedState.status
    await focusField(0)
    pressKey('T', ['control', 'shift'])
    await sleep(600)
    const emptyStackState = JSON.parse(await entryState())
    console.log(
      '[bench] tab-reopen-empty ' +
        JSON.stringify({
          status: emptyStackState.status,
          unchanged: emptyStackState.status === statusBeforeEmpty,
          eventsWritten: (await logCount(closedProject)) - eventsBeforeEmpty,
          tabs: emptyStackState.tabs,
        }),
    )
    if (emptyStackState.status !== statusBeforeEmpty) {
      throw new Error('an empty closed stack said something: ' + emptyStackState.status)
    }
    if ((await logCount(closedProject)) !== eventsBeforeEmpty) {
      throw new Error('an empty closed stack wrote an event')
    }
    if (emptyStackState.tabs !== 1) throw new Error('an empty closed stack changed the rail')

    // The same close from the keyboard alone: the control is a button with the window's own words, so
    // focus reaches it and the activation key presses it. Closing also has to leave the cursor
    // somewhere useful rather than on a control that just disappeared.
    const closeFocus = JSON.parse(
      await window.webContents.executeJavaScript(`(() => {
        const button = document.getElementById('close-tab')
        button.focus()
        return JSON.stringify({
          focused: document.activeElement === button,
          name: button.textContent,
          tabbable: button.tabIndex >= 0,
        })
      })()`),
    )
    if (!closeFocus.focused || !closeFocus.tabbable || closeFocus.name !== 'Close tab') {
      throw new Error('the close control cannot be reached from the keyboard: ' + JSON.stringify(closeFocus))
    }
    // A button acts on the *char* event, not on keyDown alone: `pressEnter` is the one that moves.
    pressEnter()
    const closedByKey = await waitStatus(/^Closed /, 'closing the tab with the keyboard')
    const focusAfterKey = JSON.parse(
      await window.webContents.executeJavaScript(`(() => JSON.stringify({
        field: (document.activeElement && document.activeElement.dataset.field) || null,
        tab: document.activeElement && document.activeElement.id,
      }))()`),
    )
    console.log(
      '[bench] tab-closed-by-key ' +
        JSON.stringify({ status: closedByKey.status, tabs: closedByKey.tabs, focus: focusAfterKey }),
    )
    if (closedByKey.tabs !== 0) throw new Error('the keyboard close left the tab in the rail')
    if (focusAfterKey.field !== 'x') {
      throw new Error('closing moved focus off the bar: ' + JSON.stringify(focusAfterKey))
    }

    // And the chord brings it back a second time, because the stack takes what it reopens and the
    // next close is a new record rather than a rewind.
    pressKey('T', ['control', 'shift'])
    const twice = await waitStatus(/^Reopened /, 'reopening after the keyboard close')
    console.log('[bench] tab-reopened-again ' + JSON.stringify({ status: twice.status, tabs: twice.tabs, readout: twice.readout }))
    if (twice.tabs !== 1 || !/n = 15/.test(twice.readout || '')) {
      throw new Error('the second reopen is not the same tab: ' + JSON.stringify(twice))
    }
    if ((await logCount(closedProject)) !== eventsBeforeEmpty) {
      throw new Error('closing and reopening a tab wrote an event')
    }

    // One more close, from a window that has a tab to fall back to. Closing changes the drawing, and
    // that change clears the tab's history — the closed stack is outside it, so the tab's own act has
    // to come back with it. This is the case a stack kept inside `showView` would fail.
    await window.webContents.executeJavaScript("document.getElementById('new-tab').click()")
    for (let waited = 0; waited < 100; waited += 1) {
      if (await window.webContents.executeJavaScript("document.getElementById('tab-dialog').open")) break
      await sleep(100)
    }
    await window.webContents.executeJavaScript(`(() => {
      const name = document.getElementById('tab-name')
      name.value = 'second look'
      name.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await sleep(200)
    await window.webContents.executeJavaScript("document.getElementById('tab-create').click()")
    const secondTab = await waitStatus(/^Created the tab/, 'building a second tab')
    // Back to the first tab for one more point: the act the reopen has to bring back.
    await window.webContents.executeJavaScript(`(() => {
      const item = Array.prototype.find.call(document.querySelectorAll('#tabs .item'), (button) =>
        button.textContent.indexOf('drift over time') !== -1,
      )
      item.click()
      return true
    })()`)
    for (let waited = 0; waited < 100; waited += 1) {
      if ((await window.webContents.executeJavaScript("document.getElementById('view-title').textContent")) === 'drift over time') break
      await sleep(100)
    }
    await enterPoint(6.2, 12.1)
    await waitStatus(/^Saved/, 'typing into the tab that will be closed')
    await sleep(600)
    const eventsBeforeSwitchClose = await logCount(closedProject)
    await window.webContents.executeJavaScript("document.getElementById('close-tab').click()")
    const afterSwitchClose = await waitStatus(/^Closed /, 'closing a tab that has a neighbour')
    const landedOn = await window.webContents.executeJavaScript(
      "document.getElementById('view-title').textContent",
    )
    console.log(
      '[bench] tab-closed-with-neighbour ' +
        JSON.stringify({ status: afterSwitchClose.status, tabs: secondTab.tabs, landedOn: landedOn }),
    )
    if (landedOn !== 'second look') {
      throw new Error('closing a tab did not move to the tab beside it: ' + landedOn)
    }
    if (secondTab.tabs !== 2) throw new Error('the second tab was not added to the rail: ' + secondTab.tabs)
    if (afterSwitchClose.tabs !== 1) throw new Error('the rail did not lose exactly one tab')

    pressKey('T', ['control', 'shift'])
    const backAcross = await waitStatus(/^Reopened /, 'reopening after the drawing changed')
    const backUndo = await barUndo()
    const backTitle = await window.webContents.executeJavaScript(
      "document.getElementById('view-title').textContent",
    )
    console.log(
      '[bench] tab-reopened-across-switch ' +
        JSON.stringify({
          status: backAcross.status,
          title: backTitle,
          readout: backAcross.readout,
          undo: backUndo,
          tabs: backAcross.tabs,
        }),
    )
    if (backTitle !== 'drift over time') throw new Error('the wrong tab came back: ' + backTitle)
    if (!/n = 16/.test(backAcross.readout || '')) {
      throw new Error('the tab came back without the point typed in it: ' + backAcross.readout)
    }
    if (backUndo.disabled || backUndo.label !== 'Undo added point') {
      throw new Error('the tab came back without its act: ' + JSON.stringify(backUndo))
    }
    if (backAcross.tabs !== 2) throw new Error('the rail does not hold both tabs again')
    if ((await logCount(closedProject)) !== eventsBeforeSwitchClose) {
      throw new Error('closing a tab with a neighbour, or reopening it, wrote an event')
    }

    // --- the tab's own acts ---------------------------------------------------------------------
    // Everything below is reached the way a person reaches it: the menu on the tab's row, the sheet
    // it opens, and the keyboard. Files and the rail are read back, because "the tab was renamed"
    // is a claim about the project, not about a frame.
    const railNames = async () =>
      window.webContents.executeJavaScript(
        "Array.prototype.map.call(document.querySelectorAll('#tabs .item-name'), (n) => n.textContent)",
      )
    const openRailMenu = async (name) => {
      const opened = await window.webContents.executeJavaScript(`(() => {
        const row = Array.prototype.find.call(document.querySelectorAll('#tabs li'), (item) => {
          const label = item.querySelector('.item-name')
          return label && label.textContent === ${JSON.stringify(name)}
        })
        if (!row) return null
        const trigger = row.querySelector('.tab-more')
        if (!trigger) return null
        trigger.click()
        return { label: trigger.getAttribute('aria-label'), expanded: trigger.getAttribute('aria-expanded') }
      })()`)
      if (!opened) throw new Error('no tab row with a menu for ' + name)
      await sleep(150)
      return opened
    }
    const readTabMenu = async () =>
      JSON.parse(
        await window.webContents.executeJavaScript(`(() => {
          const menu = document.querySelector('.menu')
          if (!menu) return JSON.stringify({ open: false })
          const box = menu.getBoundingClientRect()
          return JSON.stringify({
            open: true,
            role: menu.getAttribute('role'),
            label: menu.getAttribute('aria-label'),
            items: Array.prototype.map.call(menu.querySelectorAll('.menu-item'), (b) => b.textContent),
            focused: document.activeElement ? document.activeElement.textContent : '',
            inside:
              box.left >= 0 && box.top >= 0 && box.right <= window.innerWidth && box.bottom <= window.innerHeight,
          })
        })()`),
      )
    const dismissTabMenu = async () => {
      await window.webContents.executeJavaScript(`(() => {
        const menu = document.querySelector('.menu')
        if (menu) menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        return true
      })()`)
      await sleep(150)
    }

    // The menu on a tab that is not the drawing on screen: the header's close button cannot reach
    // that tab, which is the case this menu exists for.
    const eventsBeforeTabActs = await logCount(closedProject)
    const trigger = await openRailMenu('second look')
    const menu = await readTabMenu()
    console.log('[bench] tab-menu ' + JSON.stringify({ trigger, ...menu }))
    if (!menu.open || menu.role !== 'menu') throw new Error('the tab row opened no menu')
    if (menu.items.join('|') !== 'Rename…|Duplicate…|Close tab') {
      throw new Error('the tab menu does not offer the three acts: ' + JSON.stringify(menu.items))
    }
    if (menu.focused !== 'Rename…') throw new Error('the tab menu did not put the keyboard on its first item')
    if (!menu.inside) throw new Error('the tab menu was not fully inside the window')
    if (trigger.expanded !== 'true') throw new Error('the trigger does not say its menu is open')

    // One frame per scaling, with the menu opened at that scaling: a menu placed at 100% and then
    // zoomed would be measured against a window it was never positioned in.
    for (const [label, factor] of [
      ['100', 1],
      ['125', 1.25],
      ['150', 1.5],
    ]) {
      window.webContents.setZoomFactor(factor)
      await sleep(500)
      await dismissTabMenu()
      await openRailMenu('second look')
      await sleep(250)
      const seen = await readTabMenu()
      const overflowX = await window.webContents.executeJavaScript(
        'document.documentElement.scrollWidth - window.innerWidth',
      )
      await saveFrame(join(captureDir, `app-tab-menu-${label}.png`), await rendererScreenshot())
      frames += 1
      console.log(`[bench] tab-menu-${label} ` + JSON.stringify({ ...seen, overflowX }))
      if (!seen.inside) throw new Error(`the tab menu left the window at ${label}%`)
      if (overflowX > 0) throw new Error(`the rail scrolls sideways at ${label}%`)
      await assertPlainSurface(`the tab menu at ${label}%`)
    }
    window.webContents.setZoomFactor(1)
    await sleep(400)

    // Rename, through the menu and the sheet it opens.
    await dismissTabMenu()
    await openRailMenu('second look')
    await window.webContents.executeJavaScript(
      "document.querySelector('.menu-item[data-action=\"rename\"]').click()",
    )
    for (let waited = 0; waited < 60; waited += 1) {
      if (await window.webContents.executeJavaScript("document.getElementById('rename-dialog').open")) break
      await sleep(100)
    }
    const renameSheet = JSON.parse(
      await window.webContents.executeJavaScript(`(() => JSON.stringify({
        open: document.getElementById('rename-dialog').open,
        title: document.getElementById('rename-dialog-title').textContent,
        note: document.getElementById('rename-note').textContent,
        label: document.getElementById('rename-label').textContent,
        prefilled: document.getElementById('rename-input').value,
        confirm: document.getElementById('rename-confirm').textContent,
      }))()`),
    )
    console.log('[bench] rename-sheet ' + JSON.stringify(renameSheet))
    if (!renameSheet.open) throw new Error('Rename… opened no sheet')
    if (renameSheet.title !== 'Rename tab') throw new Error('the sheet does not say what it will do: ' + renameSheet.title)
    if (renameSheet.prefilled !== 'second look') throw new Error('the sheet did not offer the name the tab has')
    if (renameSheet.confirm !== 'Rename') throw new Error('the sheet\u2019s button does not say Rename: ' + renameSheet.confirm)
    await assertPlainSurface('the rename sheet')
    await window.webContents.executeJavaScript(`(() => {
      const input = document.getElementById('rename-input')
      input.value = 'second look renamed'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      document.getElementById('rename-confirm').click()
      return true
    })()`)
    const renamedStatus = await waitStatus(/^Renamed /, 'renaming a tab')
    const renamedNames = await railNames()
    const renamedTitle = await window.webContents.executeJavaScript(
      "document.getElementById('view-title').textContent",
    )
    console.log(
      '[bench] tab-renamed ' +
        JSON.stringify({ status: renamedStatus.status, names: renamedNames, title: renamedTitle }),
    )
    if (!renamedNames.includes('second look renamed')) throw new Error('the rail kept the old name: ' + renamedNames)
    if (renamedNames.includes('second look')) throw new Error('the rail shows both names: ' + renamedNames)
    if (renamedTitle !== 'drift over time') {
      throw new Error('renaming another tab moved the drawing: ' + renamedTitle)
    }
    if (!existsSync(join(closedProject, 'views', 'second-look-renamed.json'))) {
      throw new Error('the renamed tab has no file under its new name')
    }
    if (existsSync(join(closedProject, 'views', 'second-look.json'))) {
      throw new Error('the renamed tab left its old file behind')
    }

    // A tab that comes into being can be taken back: the bar offers it, Ctrl+Z closes it through the
    // same close path, and the redo restores it from the archive that close left.
    await window.webContents.executeJavaScript("document.getElementById('new-tab').click()")
    for (let waited = 0; waited < 100; waited += 1) {
      if (await window.webContents.executeJavaScript("document.getElementById('tab-dialog').open")) break
      await sleep(100)
    }
    await window.webContents.executeJavaScript(`(() => {
      const name = document.getElementById('tab-name')
      name.value = 'third look'
      name.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await sleep(200)
    await window.webContents.executeJavaScript("document.getElementById('tab-create').click()")
    const madeTab = await waitStatus(/^Created the tab/, 'creating a third tab')
    const madeUndo = JSON.parse(
      await window.webContents.executeJavaScript(`(() => {
        const button = document.getElementById('entry-undo')
        return JSON.stringify({ label: button.textContent, title: button.title, disabled: button.disabled })
      })()`),
    )
    console.log(
      '[bench] tab-created ' +
        JSON.stringify({ status: madeTab.status, tabs: madeTab.tabs, undo: madeUndo }),
    )
    if (madeUndo.disabled || madeUndo.label !== 'Undo new tab') {
      throw new Error('creating a tab offers no way to take it back: ' + JSON.stringify(madeUndo))
    }
    if (madeUndo.title !== 'Undo the tab created here (Ctrl+Z in an empty field)') {
      throw new Error('the tab-creation tooltip does not name the act: ' + madeUndo.title)
    }

    await focusField(0)
    pressKey('Z', ['control'])
    const unmadeTab = await waitStatus(/^Closed /, 'undoing the creation of a tab')
    const afterUnmade = JSON.parse(await entryState())
    const unmadeAction = JSON.parse(
      await window.webContents.executeJavaScript(`(() => {
        const button = document.querySelector('#entry-status .status-action')
        const undo = document.getElementById('entry-undo')
        return JSON.stringify({
          action: button ? button.textContent : null,
          title: button ? button.title : null,
          undo: undo.textContent,
        })
      })()`),
    )
    const unmadeArchives = (await readdir(join(closedProject, 'views', '.trash'))).filter((name) =>
      name.startsWith('third-look-'),
    )
    console.log(
      '[bench] tab-creation-undone ' +
        JSON.stringify({
          status: unmadeTab.status,
          tabs: afterUnmade.tabs,
          archives: unmadeArchives.length,
          ...unmadeAction,
        }),
    )
    if (afterUnmade.tabs !== 2) throw new Error('undoing the creation left the tab in the rail: ' + afterUnmade.tabs)
    if (unmadeArchives.length !== 1) throw new Error('undoing the creation left no archive to redo from')
    // One button for the one way back: the redo names the tab act, and the status does not also
    // offer a second control for the same restoration.
    if (unmadeAction.action !== 'Redo new tab') {
      throw new Error('undoing a creation offered no way back: ' + unmadeAction.action)
    }
    if (unmadeAction.title !== 'Redo the tab created here (Ctrl+Shift+Z or Ctrl+Y in an empty field)') {
      throw new Error('the redo tooltip does not name the tab act: ' + unmadeAction.title)
    }
    if (unmadeAction.undo !== 'Undo') {
      throw new Error('the bar still offers an undo after taking the tab back: ' + unmadeAction.undo)
    }
    await saveFrame(join(captureDir, 'app-tab-creation-undone.png'), await rendererScreenshot())
    frames += 1

    pressKey('Z', ['control', 'shift'])
    const remadeTab = await waitStatus(/^Reopened /, 'redoing the creation of a tab')
    const remadeTitle = await window.webContents.executeJavaScript(
      "document.getElementById('view-title').textContent",
    )
    console.log(
      '[bench] tab-creation-redone ' +
        JSON.stringify({ status: remadeTab.status, tabs: remadeTab.tabs, title: remadeTitle }),
    )
    if (remadeTitle !== 'third look') throw new Error('the redo restored a different tab: ' + remadeTitle)
    if (remadeTab.tabs !== 3) throw new Error('the redone tab is not in the rail: ' + remadeTab.tabs)
    if (!existsSync(join(closedProject, 'views', 'third-look.json'))) {
      throw new Error('the redone tab wrote no file')
    }

    // Duplicate it. The copy opens, is a tab of its own, and closes without taking the original with it.
    await openRailMenu('third look')
    await window.webContents.executeJavaScript(
      "document.querySelector('.menu-item[data-action=\"duplicate\"]').click()",
    )
    for (let waited = 0; waited < 60; waited += 1) {
      if (await window.webContents.executeJavaScript("document.getElementById('rename-dialog').open")) break
      await sleep(100)
    }
    const duplicateSheet = JSON.parse(
      await window.webContents.executeJavaScript(`(() => JSON.stringify({
        title: document.getElementById('rename-dialog-title').textContent,
        note: document.getElementById('rename-note').textContent,
        prefilled: document.getElementById('rename-input').value,
        confirm: document.getElementById('rename-confirm').textContent,
      }))()`),
    )
    console.log('[bench] duplicate-sheet ' + JSON.stringify(duplicateSheet))
    if (duplicateSheet.title !== 'Duplicate tab') throw new Error('the copy sheet is titled ' + duplicateSheet.title)
    if (duplicateSheet.prefilled !== 'third look copy') {
      throw new Error('the copy sheet did not suggest a free name: ' + duplicateSheet.prefilled)
    }
    if (duplicateSheet.confirm !== 'Create copy') {
      throw new Error('the copy sheet\u2019s button says ' + duplicateSheet.confirm)
    }
    await assertPlainSurface('the copy sheet')
    // The sheet at each scaling, measured where it stands: a wide name field or a button pushed off
    // the dialog is a failure at the size it broke at.
    for (const [label, factor] of [
      ['100', 1],
      ['125', 1.25],
      ['150', 1.5],
    ]) {
      window.webContents.setZoomFactor(factor)
      await sleep(500)
      const box = JSON.parse(
        await window.webContents.executeJavaScript(`(() => {
          const dialog = document.getElementById('rename-dialog')
          const rect = dialog.getBoundingClientRect()
          const field = document.getElementById('rename-input')
          const confirm = document.getElementById('rename-confirm')
          const bits = [field, confirm].map((element) => element.getBoundingClientRect())
          return JSON.stringify({
            inside: rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight,
            controlsInside: bits.every((b) => b.left >= rect.left - 1 && b.right <= rect.right + 1),
            overflowX: document.documentElement.scrollWidth - window.innerWidth,
          })
        })()`),
      )
      await saveFrame(join(captureDir, `app-tab-sheet-${label}.png`), await rendererScreenshot())
      frames += 1
      console.log(`[bench] tab-sheet-${label} ` + JSON.stringify(box))
      if (!box.inside) throw new Error(`the name sheet left the window at ${label}%`)
      if (!box.controlsInside) throw new Error(`the name sheet clips its controls at ${label}%`)
      if (box.overflowX > 0) throw new Error(`the window scrolls sideways at ${label}%`)
    }
    window.webContents.setZoomFactor(1)
    await sleep(400)
    await window.webContents.executeJavaScript("document.getElementById('rename-confirm').click()")
    const copiedStatus = await waitStatus(/^Copied /, 'copying a tab')
    const copyTitle = await window.webContents.executeJavaScript(
      "document.getElementById('view-title').textContent",
    )
    const copiedNames = await railNames()
    console.log(
      '[bench] tab-copied ' +
        JSON.stringify({ status: copiedStatus.status, title: copyTitle, names: copiedNames }),
    )
    if (copyTitle !== 'third look copy') throw new Error('the copy did not open: ' + copyTitle)
    if (copiedNames.length !== 4) throw new Error('the copy is not in the rail: ' + JSON.stringify(copiedNames))
    if (!existsSync(join(closedProject, 'views', 'third-look-copy.json'))) {
      throw new Error('the copy wrote no file')
    }

    // Close the original from its own row while the copy is the drawing on screen: a background
    // tab's close changes the rail and nothing else.
    await openRailMenu('third look')
    await window.webContents.executeJavaScript(
      "document.querySelector('.menu-item[data-action=\"close\"]').click()",
    )
    const closedBackground = await waitStatus(/^Closed /, 'closing a background tab from its row')
    const afterBackground = JSON.parse(await entryState())
    const stillDrawn = await window.webContents.executeJavaScript(
      "document.getElementById('view-title').textContent",
    )
    console.log(
      '[bench] tab-closed-in-background ' +
        JSON.stringify({
          status: closedBackground.status,
          tabs: afterBackground.tabs,
          drawn: stillDrawn,
          names: await railNames(),
        }),
    )
    if (stillDrawn !== 'third look copy') {
      throw new Error('closing a background tab moved the drawing: ' + stillDrawn)
    }
    if (afterBackground.tabs !== 3) throw new Error('closing one background tab removed the wrong number')

    // Rename the tab that is on screen: the drawing is the same drawing under another name, so the
    // header and the file move with it and nothing is redrawn into a different tab.
    const titleBeforeOpenRename = await window.webContents.executeJavaScript(
      "document.getElementById('view-title').textContent",
    )
    const marksBeforeOpenRename = await window.webContents.executeJavaScript(
      "Array.prototype.reduce.call(document.querySelectorAll('.panel-chart'), (total, host) => total + Number(host.dataset.marks || 0), 0)",
    )
    const metaBeforeOpenRename = await window.webContents.executeJavaScript(
      "document.getElementById('view-meta').textContent",
    )
    await openRailMenu('third look copy')
    await window.webContents.executeJavaScript(
      "document.querySelector('.menu-item[data-action=\"rename\"]').click()",
    )
    for (let waited = 0; waited < 60; waited += 1) {
      if (await window.webContents.executeJavaScript("document.getElementById('rename-dialog').open")) break
      await sleep(100)
    }
    await window.webContents.executeJavaScript(`(() => {
      const input = document.getElementById('rename-input')
      input.value = 'third copy'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      document.getElementById('rename-confirm').click()
      return true
    })()`)
    const renamedOpen = await waitStatus(/^Renamed /, 'renaming the tab on screen')
    const openRename = JSON.parse(
      await window.webContents.executeJavaScript(`(() => JSON.stringify({
        title: document.getElementById('view-title').textContent,
        meta: document.getElementById('view-meta').textContent,
        marks: Array.prototype.reduce.call(document.querySelectorAll('.panel-chart'), (total, host) => total + Number(host.dataset.marks || 0), 0),
        current: (() => {
          const row = document.querySelector('#tabs .item[aria-current=\"true\"]')
          return row ? row.querySelector('.item-name').textContent : null
        })(),
      }))()`),
    )
    console.log(
      '[bench] tab-renamed-open ' +
        JSON.stringify({
          status: renamedOpen.status,
          before: { title: titleBeforeOpenRename, marks: marksBeforeOpenRename },
          ...openRename,
        }),
    )
    if (openRename.title !== 'third copy') {
      throw new Error('renaming the drawn tab did not rename the header: ' + openRename.title)
    }
    if (openRename.current !== 'third copy') {
      throw new Error('the rail does not mark the renamed tab as the open one: ' + openRename.current)
    }
    // The same drawing, not a rebuilt one: the same facts line and the same marks on the canvas.
    if (metaBeforeOpenRename === '' || openRename.meta !== metaBeforeOpenRename) {
      throw new Error(
        'renaming the drawn tab changed its facts: "' + metaBeforeOpenRename + '" -> "' + openRename.meta + '"',
      )
    }
    if (openRename.marks !== marksBeforeOpenRename || openRename.marks === 0) {
      throw new Error(
        'renaming the drawn tab redrew it differently: ' +
          marksBeforeOpenRename +
          ' -> ' +
          openRename.marks,
      )
    }
    if (!existsSync(join(closedProject, 'views', 'third-copy.json'))) {
      throw new Error('the renamed drawn tab has no file under its new name')
    }

    // Back to the two tabs the relaunch steps expect, under the name they expect.
    await window.webContents.executeJavaScript(`(() => {
      const row = Array.prototype.find.call(document.querySelectorAll('#tabs li'), (item) => {
        const label = item.querySelector('.item-name')
        return label && label.textContent === 'second look renamed'
      })
      row.querySelector('.tab-more').click()
      return true
    })()`)
    await sleep(200)
    await window.webContents.executeJavaScript(
      "document.querySelector('.menu-item[data-action=\"rename\"]').click()",
    )
    for (let waited = 0; waited < 60; waited += 1) {
      if (await window.webContents.executeJavaScript("document.getElementById('rename-dialog').open")) break
      await sleep(100)
    }
    await window.webContents.executeJavaScript(`(() => {
      const input = document.getElementById('rename-input')
      input.value = 'second look'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      document.getElementById('rename-confirm').click()
      return true
    })()`)
    await waitStatus(/^Renamed /, 'renaming the tab back')
    // And the drawn tab leaves from its own row too: the window moves to the tab beside it.
    await openRailMenu('third copy')
    await window.webContents.executeJavaScript(
      "document.querySelector('.menu-item[data-action=\"close\"]').click()",
    )
    const closedThird = await waitStatus(/^Closed /, 'closing the drawn tab from its row')
    await window.webContents.executeJavaScript(`(() => {
      const item = Array.prototype.find.call(document.querySelectorAll('#tabs .item'), (button) =>
        button.textContent.indexOf('drift over time') !== -1,
      )
      item.click()
      return true
    })()`)
    for (let waited = 0; waited < 100; waited += 1) {
      if ((await window.webContents.executeJavaScript("document.getElementById('view-title').textContent")) === 'drift over time') break
      await sleep(100)
    }
    const settledNames = await railNames()
    console.log(
      '[bench] tab-acts-settled ' +
        JSON.stringify({
          status: closedThird.status,
          tabs: closedThird.tabs,
          names: settledNames,
          eventsWritten: (await logCount(closedProject)) - eventsBeforeTabActs,
        }),
    )
    if (settledNames.length !== 2) throw new Error('the tab acts did not settle to two tabs: ' + settledNames)
    if ((await logCount(closedProject)) !== eventsBeforeTabActs) {
      throw new Error('renaming, copying or closing a tab wrote an event')
    }
    // The relaunch proof that follows starts from a project whose trash holds exactly the tab it
    // closes. This section closed several (it is a scratch copy of the fixture), and clearing them
    // keeps that proof about its own close rather than about the ones before it.
    for (const archive of await readdir(join(closedProject, 'views', '.trash'))) {
      await rm(join(closedProject, 'views', '.trash', archive), { force: true })
    }

    // Quit, and start again. The tab is closed first, so the relaunch has something the earlier
    // window knew about and the new one can only find in the project's own files.
    await window.webContents.executeJavaScript("document.getElementById('close-tab').click()")
    const beforeQuit = await waitStatus(/^Closed /, 'closing the tab before the relaunch')
    if (beforeQuit.tabs !== 1) {
      throw new Error('the relaunch would start with ' + beforeQuit.tabs + ' tabs on screen')
    }
    const archives = (await readdir(join(closedProject, 'views', '.trash'))).filter((name) =>
      name.endsWith('.json'),
    )
    if (archives.length === 0) throw new Error('the closed tab left no archive to reopen')
    // The parent stops being the window that knows: its own stack is irrelevant to the child.
    console.log(
      '[bench] relaunch-prepared ' +
        JSON.stringify({ tabs: beforeQuit.tabs, archives: archives.length, status: beforeQuit.status }),
    )

    const relaunchProfile = join(dirname(writableDir), 'relaunch-profile')
    await mkdir(relaunchProfile, { recursive: true })
    const childEnv = { ...process.env }
    // Electron's own "run as node" switch would make the child a script runner, not a window.
    delete childEnv.ELECTRON_RUN_AS_NODE
    const relaunched = spawn(process.execPath, [join(here, 'main.js')], {
      cwd: join(here, '..'),
      env: {
        ...childEnv,
        BENCH_CAPTURE: captureDir,
        BENCH_CAPTURE_PHASE: 'relaunch',
        BENCH_APP_PROJECT: closedProject,
        BENCH_USER_DATA: relaunchProfile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let childOutput = ''
    relaunched.stdout.on('data', (chunk) => {
      childOutput += chunk
    })
    relaunched.stderr.on('data', (chunk) => {
      childOutput += chunk
    })
    const relaunchCode = await new Promise((done) => {
      relaunched.on('exit', (status) => done(status ?? 1))
      relaunched.on('error', (error) => {
        childOutput += '\n' + error.message
        done(1)
      })
    })
    process.stdout.write(childOutput)
    if (relaunchCode !== 0) {
      throw new Error('the relaunched window exited ' + relaunchCode + '\n' + childOutput)
    }
    for (const evidence of ['relaunch-start', 'relaunch-reopened', 'relaunch-empty']) {
      if (!childOutput.includes('[bench] ' + evidence)) {
        throw new Error('the relaunched window never reached ' + evidence)
      }
    }
    // The child photographed its own frame, so the review has a picture of the tab that came back.
    frames += 1

  }

  if (cspViolations > 0) console.log(`[bench] csp-inline-style-blocked=${cspViolations}`)
  const metrics = app.getAppMetrics()
  const memory = metrics.reduce((sum, metric) => sum + (metric.memory?.workingSetSize ?? 0), 0)
  console.log(
    `[bench] painted=${paintedMs}ms processes=${metrics.length} workingSet=${(memory / 1024).toFixed(0)}MB`,
  )
  console.log(`[bench] captured ${frames} frames in ${captureDir}`)
  app.quit()
}
