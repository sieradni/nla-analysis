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
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as bench from './core.bundle.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const startedAt = Date.now()

/** `BENCH_CAPTURE=<dir>` runs the review capture instead of an interactive window. */
const captureDir = process.env.BENCH_CAPTURE ? resolve(process.env.BENCH_CAPTURE) : null
/** `BENCH_APP_PROJECT=<dir>` opens a project on launch, which the capture run uses. */
const startupDir = process.env.BENCH_APP_PROJECT ? resolve(process.env.BENCH_APP_PROJECT) : null

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
  projectDir: startupDir,
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

  const metrics = app.getAppMetrics()
  const memory = metrics.reduce((sum, metric) => sum + (metric.memory?.workingSetSize ?? 0), 0)
  console.log(
    `[bench] painted=${paintedMs}ms processes=${metrics.length} workingSet=${(memory / 1024).toFixed(0)}MB`,
  )
  const frames = factors.length + 1
  console.log(`[bench] captured ${frames} frames in ${captureDir}`)
  app.quit()
}

ipcMain.once('bench:ready', () => {
  if (captureDir) {
    capture().catch((error) => {
      console.error('[bench] capture failed:', error)
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
