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
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
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
/**
 * `BENCH_SMOKE=<dir>` is the packaged build's own proof: open a project, draw it, report what the
 * build can and cannot do, write one frame, quit. It runs in the shipped executable, so the answer
 * is about the artifact rather than about the dev checkout.
 */
const smokeDir = process.env.BENCH_SMOKE ? resolve(process.env.BENCH_SMOKE) : null
/** What the next renderer boot should open: changed between the read-only and the entry frames. */
let nextStartup = startupDir

// A capture run must not write into the operator's real profile, and neither should a review run
// leave a Chromium cache behind in it. A packaged build has no repository to write into, so the
// proof run points this at a temporary directory instead.
if (process.env.BENCH_USER_DATA) app.setPath('userData', resolve(process.env.BENCH_USER_DATA))
else if (captureDir) app.setPath('userData', resolve(here, '..', 'artifacts', 'electron-profile'))

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
ipcMain.handle('bench:point', (_event, dir, id, viewName) => guarded(() => bench.point(dir, id, viewName)))
ipcMain.handle('bench:recipes', () => guarded(() => bench.recipes()))
ipcMain.handle('bench:shapeChoice', () => guarded(async () => bench.shapeChoice()))

// Creating a project is a write: one log event, one folder. The dialog collects a name, a parent
// folder and a shape; everything else — the folder's slug, the shape's validation — is the core's.
ipcMain.handle('bench:createProject', (_event, parent, name, shape) =>
  guarded(() => bench.createProject(parent, name, shape)),
)

ipcMain.handle('bench:pickFolder', async (event) => {
  const owner = BrowserWindow.fromWebContents(event.sender)
  const result = await dialog.showOpenDialog(owner, {
    title: 'Where should this project live?',
    buttonLabel: 'Use this folder',
    properties: ['openDirectory', 'createDirectory'],
  })
  return { ok: true, value: result.canceled ? null : result.filePaths[0] }
})

// The write channel. Four calls, each one a `Workspace` method: there is no generic "run this"
// escape hatch, so the window cannot grow a write path the core has not already agreed to.
ipcMain.handle('bench:recordPoint', (_event, dir, draft, viewName) =>
  guarded(() => bench.recordPoint(dir, draft, viewName)),
)
ipcMain.handle('bench:correctPoint', (_event, dir, id, values, viewName) =>
  guarded(() => bench.correctPoint(dir, id, values, viewName)),
)
ipcMain.handle('bench:retractPoint', (_event, dir, id, reason) =>
  guarded(() => bench.retractPoint(dir, id, reason)),
)
ipcMain.handle('bench:writeView', (_event, dir, draft) => guarded(() => bench.writeView(dir, draft)))
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
    const status = document.getElementById('entry-status')
    const notice = document.getElementById('notice')
    return JSON.stringify({
      focused: document.activeElement && (document.activeElement.dataset.field || document.activeElement.tagName),
      // Keyed by field name, because a project may declare fields that are not x and y.
      typed: (() => {
        const out = {}
        document.querySelectorAll('#entry-fields input').forEach((input) => {
          out[input.dataset.field] = input.value
        })
        return out
      })(),
      badges: Array.prototype.map.call(document.querySelectorAll('.panel-strip .badge'), (b) => b.textContent),
      correcting: !document.getElementById('entry-correct').hidden,
      correctLabel: document.getElementById('entry-correct').hidden
        ? null
        : document.getElementById('entry-correct-label').textContent,
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
  // A previous step may have handed the foreground away (a spawned CLI, the shell itself). Ask for
  // it again here rather than reporting a keystroke that never landed.
  if (!(await focusWindowForInput())) throw new Error('the window never took focus')
  const { timing, synthetic } = await submitEntry(x, y)
  if (synthetic) throw new Error('the capture could not type into the window (no focus)')
  return timing
}

// --- packaged smoke --------------------------------------------------------------------------

/**
 * What the shipped build has to be able to answer: it is packaged, it drew a chart from a project
 * folder, the entry bar offers the shape's fields, and it says why no recipe is on offer.
 */
async function smoke() {
  await mkdir(smokeDir, { recursive: true })
  // One paint plus a thumbnail render; the window is offscreen, so there is no other signal.
  await sleep(1500)

  const facts = JSON.parse(await window.webContents.executeJavaScript(`(() => JSON.stringify({
    panels: document.querySelectorAll('.panel').length,
    marks: document.querySelectorAll('circle[data-point-id]').length,
    badges: Array.prototype.map.call(document.querySelectorAll('.panel-strip .badge'), (b) => b.textContent),
    fields: Array.prototype.map.call(document.querySelectorAll('#entry-fields input'), (i) => i.dataset.field),
    readout: document.getElementById('entry-readout').textContent,
    title: document.getElementById('view-title').textContent,
    notice: document.getElementById('notice').hidden ? null : document.getElementById('notice').textContent,
    empty: getComputedStyle(document.getElementById('empty')).display,
  }))()`))

  // The degradation the build has to show honestly: a recipe panel needs the analysis runtime, which
  // this build does not carry. Ask the same catalog the dialog asks.
  let catalog
  try {
    catalog = await bench.recipes()
  } catch (error) {
    catalog = { recipes: [], problem: error instanceof Error ? error.message : String(error) }
  }

  // The degradation has to be visible where a person would look for it, not only in the report:
  // open the tab dialog and read what it offers and why.
  await window.webContents.executeJavaScript("document.getElementById('new-tab').click()")
  let dialog = { open: false, options: [], note: '' }
  for (let waited = 0; waited < 50; waited += 1) {
    dialog = JSON.parse(await window.webContents.executeJavaScript(`(() => {
      const sheet = document.getElementById('tab-dialog')
      if (!sheet.open) return JSON.stringify({ open: false, options: [], note: '' })
      return JSON.stringify({
        open: true,
        options: Array.prototype.map.call(document.querySelectorAll('#tab-panel option'), (o) => o.value),
        note: document.getElementById('tab-note').textContent,
      })
    })()`))
    // Stop as soon as the catalog has arrived one way or the other.
    if (dialog.open && (dialog.options.length > 1 || /not available/.test(dialog.note))) break
    await sleep(100)
  }
  await window.webContents.executeJavaScript("document.getElementById('tab-dialog').close()")

  const report = {
    packaged: app.isPackaged,
    electron: process.versions.electron,
    resources: process.resourcesPath,
    url: window.webContents.getURL(),
    facts,
    tabDialog: dialog,
    recipes: { offered: catalog.recipes.map((recipe) => recipe.name), problem: catalog.problem ?? null },
  }
  console.log('[bench] packaged ' + JSON.stringify(report))
  await writeFile(join(smokeDir, 'app-packaged.png'), (await window.webContents.capturePage()).toPNG())
  await writeFile(join(smokeDir, 'packaged.json'), JSON.stringify(report, null, 2) + '\n')

  const drawn = facts.panels > 0 && facts.marks > 0
  const usable = facts.fields.length > 0
  if (!app.isPackaged) console.error('[bench] packaged smoke: this is not a packaged build')
  if (!drawn) console.error('[bench] packaged smoke: no chart was drawn')
  if (!usable) console.error('[bench] packaged smoke: the entry bar offers no fields')
  app.exit(app.isPackaged && drawn && usable ? 0 : 1)
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

    // Correct a record by selecting it. The click is dispatched into the drawing's own pointer
    // handling, the new value is typed into the bar, and Enter saves — the same path a person uses.
    const selected = await window.webContents.executeJavaScript(`(() => {
      const panels = document.querySelectorAll('.panel')
      const host = panels[panels.length - 1] && panels[panels.length - 1].querySelector('.panel-chart')
      const circle = host && host.querySelector('svg circle[data-point-id]')
      if (!circle) return null
      const box = circle.getBoundingClientRect()
      const at = {
        clientX: Math.round(box.left + box.width / 2),
        clientY: Math.round(box.top + box.height / 2),
      }
      for (const type of ['pointerdown', 'pointerup']) {
        host.dispatchEvent(
          new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, ...at }),
        )
      }
      return circle.getAttribute('data-point-id')
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
        JSON.stringify({ id: selected, label: strip.correctLabel, values: strip.typed, status: strip.status }),
    )
    if (!strip.correcting) throw new Error('clicking a mark did not open the correction strip')
    if (strip.typed.x === '' || strip.typed.y === '') {
      throw new Error('the correction strip was not prefilled from the log')
    }
    // The correction row adds a line to a strip that already holds fields, a button and a readout.
    // Overflow here would clip the record id, which is the one thing the row exists to name.
    const stripLayout = await window.webContents.executeJavaScript(`(() => {
      const entry = document.getElementById('entry')
      const label = document.getElementById('entry-correct-label')
      return JSON.stringify({
        entry: { w: Math.round(entry.getBoundingClientRect().width), h: Math.round(entry.getBoundingClientRect().height) },
        label: { w: Math.round(label.getBoundingClientRect().width), scroll: label.scrollWidth },
        overflowX: label.scrollWidth - Math.round(label.getBoundingClientRect().width),
      })
    })()`)
    console.log('[bench] correction-layout ' + stripLayout)
    const stripBox = JSON.parse(stripLayout)
    if (stripBox.overflowX > 1) {
      throw new Error(`the correction row overflows by ${stripBox.overflowX}px`)
    }

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
    if (!/stale/.test(correctedState.status || '')) {
      throw new Error('the correction did not say the recipe panel is now stale')
    }
    await writeFile(join(captureDir, 'app-corrected.png'), (await window.webContents.capturePage()).toPNG())
    frames += 1

    // A tab built from the dialog: a name, a dataset, a recipe. It runs against a second, untouched
    // copy of the fixture — the frames above appended and corrected points, and a verdict computed
    // from those edits would say more about this harness than about the door being shown.
    const tabProject = join(dirname(writableDir), 'tab-fixture')
    await cp(startupDir, tabProject, { recursive: true })
    nextStartup = tabProject
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
    if (!tabState.badges.every((badge) => badge === 'current')) {
      throw new Error('a freshly built tab must be current')
    }
    if (!tabNames.includes('regimes')) throw new Error('the new tab is not in the rail')
    await writeFile(join(captureDir, 'app-new-tab.png'), (await window.webContents.capturePage()).toPNG())
    frames += 1

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

    // The same bar types into the new project: the door is only open if a point can follow the shape.
    await focusField(0)
    typeText('2.5')
    await focusField(1)
    typeText('12')
    pressEnter()
    for (let waited = 0; waited < 50; waited += 1) {
      const state = JSON.parse(await entryState())
      if (/^Recorded /.test(state.status || '')) break
      await sleep(100)
    }
    await sleep(300)
    const firstPoint = JSON.parse(await entryState())
    console.log(
      '[bench] project-first-point ' +
        JSON.stringify({ status: firstPoint.status, readout: firstPoint.readout, typed: firstPoint.typed }),
    )
    if (!/^Recorded /.test(firstPoint.status || '')) {
      throw new Error('the first point in the new project was not recorded')
    }
    if (!/n = 1/.test(firstPoint.readout)) {
      throw new Error(`the new project should hold one point: "${firstPoint.readout}"`)
    }
    await writeFile(join(captureDir, 'app-new-project.png'), (await window.webContents.capturePage()).toPNG())
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
  if (smokeDir) {
    smoke().catch((error) => {
      console.error('[bench] packaged smoke failed:', error)
      app.exit(1)
    })
    return
  }
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
