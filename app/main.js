/**
 * The desktop shell (ADR 0005).
 *
 * Electron's main process is Node, so this file imports the bundled core and calls it exactly like
 * the CLI does — one process, no per-interaction subprocess. The renderer is a WebView that draws
 * what the main process hands it: chart SVGs from the core renderer, plus the view file itself for
 * hover text and panel metadata.
 *
 * The shell adds nothing to the data model. If a window wants something the core cannot answer, the
 * answer belongs in `src/core`, not here.
 */
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as bench from './core.bundle.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const startedAt = Date.now()

/** `BENCH_CAPTURE=<dir>` runs the review capture instead of an interactive window. */
const captureDir = process.env.BENCH_CAPTURE ? resolve(process.env.BENCH_CAPTURE) : null
/** `BENCH_APP_PROJECT=<dir>` opens a project on launch, which the capture run uses. */
const startupDir = process.env.BENCH_APP_PROJECT ? resolve(process.env.BENCH_APP_PROJECT) : null
/**
 * `BENCH_CAPTURE_WRITABLE=<dir>` is a scratch copy of the project. The entry frames are captured
 * there, because appending is what the window is for and a capture that appended to the committed
 * fixture would rewrite the log every test reads.
 */
const writableDir = process.env.BENCH_CAPTURE_WRITABLE ? resolve(process.env.BENCH_CAPTURE_WRITABLE) : null
/** `BENCH_MEASURE=<n>` drives n entries and reports keystroke → painted frame. */
const measureRuns = process.env.BENCH_MEASURE ? Number(process.env.BENCH_MEASURE) : 0
/** What the next renderer boot should open: changed between the read-only and the entry frames. */
let nextStartup = startupDir

// A capture run must not write into the operator's real profile, and neither should a review run
// leave a Chromium cache behind in it.
if (captureDir) app.setPath('userData', resolve(here, '..', 'artifacts', 'electron-profile'))

let window = null

function createWindow() {
  window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#fbfbfa',
    title: 'bench',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  window.once('ready-to-show', () => {
    if (!captureDir) window.show()
  })

  window.loadFile(join(here, 'renderer', 'index.html'))
  return window
}

// --- the core, exposed as calls -------------------------------------------------------------

/**
 * Refusals cross the IPC boundary as data, not as thrown errors: Electron's structured clone keeps
 * an Error's message and drops the rest, and a window that shows "point rejected" without the list
 * of problems is worse than one that shows nothing.
 */
async function guarded(run) {
  try {
    return { ok: true, value: await run() }
  } catch (error) {
    return {
      ok: false,
      error: {
        message: error instanceof Error ? error.message : String(error),
        hint: error?.hint ?? null,
        problems: error?.problems ?? [],
      },
    }
  }
}

ipcMain.handle('bench:projects', () => guarded(() => bench.projects()))

ipcMain.handle('bench:startup', () => ({
  projectDir: nextStartup,
  capture: captureDir !== null,
}))

ipcMain.handle('bench:openProject', (_event, dir) => guarded(() => bench.openProject(dir)))

ipcMain.handle('bench:views', (_event, dir) =>
  guarded(async () => {
    const opened = await bench.openProject(dir)
    return { views: opened.views, problems: opened.viewProblems }
  }),
)

ipcMain.handle('bench:view', (_event, dir, name) => guarded(() => bench.openView(dir, name)))

// The write channel. Three calls, each one a `Workspace` method: there is no generic "run this"
// escape hatch, so the window cannot grow a write path the core has not already agreed to.
ipcMain.handle('bench:recordPoint', (_event, dir, draft, viewName) =>
  guarded(() => bench.recordPoint(dir, draft, viewName)),
)
ipcMain.handle('bench:retractPoint', (_event, dir, id, reason) =>
  guarded(() => bench.retractPoint(dir, id, reason)),
)
ipcMain.handle('bench:refreshView', (_event, dir, name, options) =>
  guarded(() => bench.refreshView(dir, name, options)),
)

ipcMain.handle('bench:pickProject', async (event) => {
  const owner = BrowserWindow.fromWebContents(event.sender)
  const result = await dialog.showOpenDialog(owner, {
    title: 'Open a bench project folder',
    buttonLabel: 'Open',
    properties: ['openDirectory'],
  })
  if (result.canceled || result.filePaths.length === 0) return { ok: true, value: null }
  return guarded(() => bench.openProject(result.filePaths[0]))
})

// --- driving the real window ------------------------------------------------------------------

/**
 * Input goes in as real keyboard events, not as a call to the renderer's own functions: a capture
 * that invoked the handler directly would prove the handler works and nothing about the path a
 * user's fingers take.
 */
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

function typeText(text) {
  for (const character of text) {
    window.webContents.sendInputEvent({ type: 'char', keyCode: character })
  }
}

/**
 * Keyboard events go to a *focused* window, and Windows refuses the focus if the app is not in the
 * foreground — which is exactly the situation a measurement run starts in. So: ask, check
 * `document.hasFocus()`, and keep asking for a moment. A harness that silently typed into nowhere
 * would report a wrong number rather than an error.
 */
async function focusWindowForInput() {
  // An always-on-top window is far harder for another application to take the focus from, which is
  // what kept happening a few entries into a run. It is cleared again when the harness is done.
  window.setAlwaysOnTop(true, 'screen-saver')
  for (let attempt = 0; attempt < 30; attempt += 1) {
    window.show()
    window.focus()
    window.webContents.focus()
    const focused = await window.webContents.executeJavaScript('document.hasFocus()').catch(() => false)
    if (focused) return true
    await sleep(100)
  }
  return false
}

/**
 * Type a value and submit, with the real keystroke path first.
 *
 * If the window cannot hold the OS focus — an automation run on a machine someone else is also
 * using — the keystrokes go nowhere. Rather than reporting a number for a submit that never
 * happened, the harness sets the fields and asks the form to submit itself, and says which samples
 * were taken that way. `pnpm app:capture` is the proof that real keystrokes reach the same handler:
 * the frames it writes were produced by typing into the bar.
 */
async function submitEntry(x, y) {
  const before = await currentTimingId()
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await focusField(0)
    typeText(String(x))
    if ((await fieldValue('x')) === String(x)) {
      const onSecond = await focusField(1)
      if (!onSecond) pressKey('Tab')
      typeText(String(y))
      if ((await fieldValue('y')) === String(y)) {
        pressEnter()
        return { timing: await waitForTiming(before), synthetic: false }
      }
    }
    await focusWindowForInput()
  }

  const submitted = await window.webContents.executeJavaScript(`(() => {
    const set = (name, value) => {
      const input = document.querySelector('input[data-field="' + name + '"]')
      if (!input) return false
      input.value = value
      return true
    }
    if (!set('x', ${JSON.stringify(String(x))}) || !set('y', ${JSON.stringify(String(y))})) return false
    document.getElementById('entry').requestSubmit()
    return true
  })()`)
  if (!submitted) throw new Error('the entry bar is not there to submit')
  return { timing: await waitForTiming(before), synthetic: true }
}

/** Empty both entry fields, so the next typed point starts from nothing. */
function clearFields() {
  return window.webContents.executeJavaScript(`(() => {
    document.querySelectorAll('#entry-fields input').forEach((input) => { input.value = '' })
    return true
  })()`)
}

/** Read one entry field, so a harness can tell "typed" from "not delivered". */
function fieldValue(name) {
  return window.webContents.executeJavaScript(
    `(document.querySelector('input[data-field="${name}"]') || {}).value || ''`,
  )
}

function pressKey(keyCode, modifiers = []) {
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
}

/**
 * Enter arrives as keyDown + char + keyUp. Chromium acts on the *char* event for a text input, so a
 * keyDown alone moves no form: the first attempt at this capture typed both fields and submitted
 * nothing at all.
 */
function pressEnter() {
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
  window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
}

async function focusField(index) {
  return window.webContents.executeJavaScript(`(() => {
    const inputs = document.querySelectorAll('#entry-fields input')
    if (!inputs[${index}]) return false
    inputs[${index}].focus()
    return document.activeElement === inputs[${index}]
  })()`)
}

/** Everything a review needs to see about the bar, read from the live DOM. */
async function entryState() {
  return window.webContents.executeJavaScript(`(() => {
    const field = (name) => document.querySelector('input[data-field="' + name + '"]')
    const status = document.getElementById('entry-status')
    const notice = document.getElementById('notice')
    return JSON.stringify({
      focused: document.activeElement && (document.activeElement.dataset.field || document.activeElement.tagName),
      typed: {
        x: field('x') ? field('x').value : null,
        y: field('y') ? field('y').value : null,
      },
      badges: Array.prototype.map.call(document.querySelectorAll('.panel-strip .badge'), (b) => b.textContent),
      status: status.hidden ? null : status.textContent,
      notice: notice.hidden ? null : notice.textContent,
      readout: document.getElementById('entry-readout').textContent,
      meta: document.getElementById('view-meta').textContent,
      undoEnabled: !document.getElementById('entry-undo').disabled,
      timing: window.__benchTiming || null,
      marks: document.querySelectorAll('circle[data-point-id]').length,
    })
  })()`)
}

/** Wait for the entry the harness just drove to report its own timings. */
async function waitForTiming(previousId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const timing = await window.webContents.executeJavaScript('window.__benchTiming || null')
    if (timing && timing.id !== previousId) return timing
    if (Date.now() > deadline) throw new Error('the entry never reported a painted frame')
    await new Promise((done) => setTimeout(done, 50))
  }
}

async function currentTimingId() {
  return window.webContents.executeJavaScript('(window.__benchTiming && window.__benchTiming.id) || null')
}

/**
 * Type a point and press Enter, exactly as a person would, then report what the window did with it.
 * `values` is [x, y]: the fixture's shape is `xy.v1`, and both fields are required.
 */
/**
 * The real `bench` binary, as an agent in a terminal would run it. Capture-only: the window itself
 * never shells out to the CLI, because that would be a second write path (ADR 0003).
 */
async function runCli(args) {
  const cli = join(here, '..', 'src', 'cli', 'index.ts')
  await new Promise((done, fail) => {
    // `process.execPath` here is Electron, not Node: `ELECTRON_RUN_AS_NODE` is what makes the same
    // binary behave as the runtime the CLI expects, without depending on where `node` is installed.
    const child = spawn(process.execPath, [cli, '--project', writableDir, ...args], {
      cwd: join(here, '..'),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'ignore',
    })
    child.on('error', fail)
    child.on('exit', (code) => (code === 0 ? done() : fail(new Error(`bench ${args[0]} exited ${code}`))))
  })
}

/** The capture run's entry: real keystrokes, and loudly wrong if they do not land. */
async function enterPoint(x, y) {
  const { timing, synthetic } = await submitEntry(x, y)
  if (synthetic) throw new Error('the capture could not type into the window (no focus)')
  return timing
}

// --- review capture --------------------------------------------------------------------------

async function capture() {
  await mkdir(captureDir, { recursive: true })
  const paintedMs = Date.now() - startedAt
  const factors = [
    ['100', 1],
    ['125', 1.25],
    ['150', 1.5],
  ]

  for (const [label, factor] of factors) {
    window.webContents.setZoomFactor(factor)
    // Two frames after a zoom change, so the capture never catches the previous layout.
    await new Promise((done) => setTimeout(done, 600))
    const image = await window.webContents.capturePage()
    await writeFile(join(captureDir, `app-${label}.png`), image.toPNG())
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
        marks: document.querySelectorAll('circle[data-point-id]').length,
      })
    })()`)
    console.log(`[bench] layout ${label}% ${layout}`)
  }

  // Interaction proof: a still frame cannot show that hover, wheel zoom or panning work, and a claim
  // that they do is worth less than a frame that shows it. The events are dispatched into the real
  // renderer, so this exercises the code the user's mouse exercises.
  window.webContents.setZoomFactor(1)
  await new Promise((done) => setTimeout(done, 400))
  const interaction = await window.webContents.executeJavaScript(`(() => {
    const host = document.querySelector('.panel-chart')
    // Nothing to hover when the open project has no tabs; say so rather than throwing.
    if (!host || !host.querySelector('circle[data-point-id]')) {
      return JSON.stringify({ skipped: 'no chart panel on screen' })
    }
    const svg = host.querySelector('svg')
    const label = host.closest('.panel').querySelector('.zoom')
    const at = (element) => {
      const box = element.getBoundingClientRect()
      return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) }
    }
    const first = at(svg.querySelector('circle[data-point-id]'))

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
    const marks = svg.querySelectorAll('circle[data-point-id]')
    const target = at(marks[Math.floor(marks.length / 2)])
    host.dispatchEvent(new PointerEvent('pointermove', { clientX: target.x, clientY: target.y, bubbles: true, pointerId: 1 }))
    const tooltip = document.getElementById('tooltip')

    return JSON.stringify({
      zoomLabel: zoomedLabel,
      panned: beforePan !== afterPan,
      viewBox: afterPan,
      tooltipVisible: !tooltip.hidden,
      tooltip: tooltip.textContent,
      hoveredMark: svg.querySelector('.hover-dot')?.getAttribute('visibility') ?? 'none',
    })
  })()`)
  console.log('[bench] interaction ' + interaction)
  await new Promise((done) => setTimeout(done, 300))
  await writeFile(join(captureDir, 'app-interaction.png'), (await window.webContents.capturePage()).toPNG())

  let frames = factors.length + 1

  // The write path, on a scratch copy so the committed fixture's log stays as it was. Switching to
  // it is a reload, because that is what opening a project does: the renderer boots against a new
  // root rather than half-rewriting its state.
  if (writableDir) {
    // Electron only delivers `sendInputEvent` to a focused window, and the entry frames are worth
    // nothing if they were driven by calling the handler directly. So the window is shown here, for
    // these two frames only: it is the same window a person types into.
    nextStartup = writableDir
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
    await writeFile(join(captureDir, 'app-entry.png'), (await window.webContents.capturePage()).toPNG())
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
    await writeFile(join(captureDir, 'app-undo.png'), (await window.webContents.capturePage()).toPNG())
    frames += 1

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
    await writeFile(join(captureDir, 'app-refused.png'), (await window.webContents.capturePage()).toPNG())
    frames += 1

    // A second writer, which is how this product is meant to be operated: an agent runs `bench` in a
    // terminal while the window is open. This spawns the real binary, not a second Workspace in this
    // process, so the window's cached bind is genuinely behind the file (ADR 0007).
    await clearFields()
    await runCli(['add', '--x', '7.2', '--y', '8.4'])
    // A child process can take the focus on Windows; without it the entry frame would be synthetic.
    if (!(await focusWindowForInput())) throw new Error('the window never took focus back')
    await clearFields()
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
    if (!/the log had changed on disk/.test(settledState.status || '')) {
      throw new Error('the window did not say it reread the log before writing')
    }
    if (!/n = 16/.test(settledState.readout)) {
      throw new Error(`the bar should read n = 16, it reads "${settledState.readout}"`)
    }
    if (savedView.panels[1].n !== 16) {
      throw new Error(`the saved tab says n = ${savedView.panels[1].n}, the log holds 16`)
    }
    await writeFile(join(captureDir, 'app-second-writer.png'), (await window.webContents.capturePage()).toPNG())
    frames += 1
  }

  const metrics = app.getAppMetrics()
  const memory = metrics.reduce((sum, metric) => sum + (metric.memory?.workingSetSize ?? 0), 0)
  console.log(
    `[bench] painted=${paintedMs}ms processes=${metrics.length} workingSet=${(memory / 1024).toFixed(0)}MB`,
  )
  console.log(`[bench] captured ${frames} frames in ${captureDir}`)
  app.quit()
}

/**
 * `BENCH_MEASURE=<n>`: append n points through the running window and report what each one cost,
 * split into the three things a person would blame — the write, the rebuild, and the paint.
 */
async function measure() {
  const runs = Number.isFinite(measureRuns) && measureRuns > 0 ? measureRuns : 5
  // Keyboard input needs a focused window; see the note on `focusWindowForInput`.
  const focused = await focusWindowForInput()
  console.log(`[bench] measure-focused ${focused}`)
  if (!focused) {
    console.error('[bench] measure failed: the window never took focus')
    app.exit(1)
    return
  }
  await sleep(400)
  const samples = []
  let synthetic = 0
  for (let index = 0; index < runs; index += 1) {
    // On the trend the data already follows, so the axes do not move: the common case, and the one
    // the budget is about. An off-domain point is measured separately below, because it is a
    // different job — the whole chart is rescaled, not just one mark added.
    const x = 400 + index
    const result = await submitEntry(x, Math.round(2.5 * x))
    if (result.synthetic) synthetic += 1
    samples.push(result.timing)
    console.log('[bench] entry ' + JSON.stringify(result.timing))
  }

  const rescale = (await submitEntry(900000, 900000)).timing
  console.log('[bench] entry-rescale ' + JSON.stringify(rescale))
  window.setAlwaysOnTop(false)
  const field = (key) => samples.map((sample) => sample[key]).sort((a, b) => a - b)
  const median = (values) => values[Math.floor(values.length / 2)]
  const radius = (values) => `${values[0].toFixed(1)}–${values[values.length - 1].toFixed(1)}`
  const commits = samples.map((sample) => sample.commit).filter((value) => typeof value === 'number')
  const summary = {
    runs: samples.length,
    medianMs: Number(median(field('total')).toFixed(1)),
    rangeMs: radius(field('total')),
    medianRecordMs: Number(median(field('record')).toFixed(1)),
    medianRebuildMs: Number(median(field('rebuild')).toFixed(1)),
    medianPaintMs: Number(median(field('paint')).toFixed(1)),
    medianCommitMs: commits.length > 0 ? Number(commits.sort((a, b) => a - b)[Math.floor(commits.length / 2)].toFixed(1)) : null,
    rescaleMs: Number(rescale.total.toFixed(1)),
    rescaleRedraw: rescale.incremental === false,
    syntheticSubmits: synthetic,
    project: nextStartup,
  }
  console.log('[bench] measure ' + JSON.stringify(summary))
  app.quit()
}

ipcMain.once('bench:ready', () => {
  if (captureDir) {
    capture().catch((error) => {
      console.error('[bench] capture failed:', error)
      app.exit(1)
    })
    return
  }
  if (measureRuns > 0) {
    measure().catch((error) => {
      console.error('[bench] measure failed:', error)
      app.exit(1)
    })
  }
})

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})
