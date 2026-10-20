/*
 * The desktop shell (ADR 0005).
 *
 * Electron's main process is Node, so this file imports the bundled core and calls it exactly like
 * the CLI does — one process, no per-interaction subprocess. The renderer is a WebView that draws
 * what the main process hands it: chart SVGs from the core renderer, plus the view file itself for
 * hover text and panel metadata.
 *
 * The shell adds nothing to the data model. If a window wants something the core cannot answer, the
 * answer belongs in `src/core`, not here. Capture, measure and smoke runs live in `harness/`:
 * they drive this window, they are not a second shell.
 */
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join, resolve } from 'node:path'
import * as bench from './core.bundle.mjs'
import {
  here,
  captureDir,
  measureRuns,
  smokeDir,
  nextStartup,
  nextPickedFile,
  setNextPickedFile,
  window,
  setWindow,
} from './harness/context.js'
import { capture } from './harness/capture.js'
import { measure } from './harness/measure.js'
import { smoke } from './harness/smoke.js'

// A capture run must not write into the operator's real profile, and neither should a review run
// leave a Chromium cache behind in it. A packaged build has no repository to write into, so the
// proof run points this at a temporary directory instead.
if (process.env.BENCH_USER_DATA) app.setPath('userData', resolve(process.env.BENCH_USER_DATA))
else if (captureDir) app.setPath('userData', resolve(here, '..', 'artifacts', 'electron-profile'))

function createWindow() {
  const created = new BrowserWindow({
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

  setWindow(created)

  window.once('ready-to-show', () => {
    if (!captureDir) window.show()
  })

  window.on('closed', () => {
    stopWatching()
    setWindow(null)
  })

  window.loadFile(join(here, 'renderer', 'index.html'))
  return window
}

// --- live reload ------------------------------------------------------------------------------

/**
 * The tab on screen and the watcher for the project it came from. The renderer says which tab it is
 * drawing; the main process owns the filesystem, so it owns the watching (ADR 0010).
 */
let watchedTab = null
let stopWatcher = null
let reloading = false
let reloadQueued = false

function stopWatching() {
  if (stopWatcher) stopWatcher()
  stopWatcher = null
  watchedTab = null
}

/**
 * Ask the core whether the files behind the open tab moved, and tell the window what it found.
 *
 * The core answers `same` for the window's own writes — the log and tab stamps it recorded are the
 * ones on disk — so typing does not trigger a second read and render behind the keystroke. Anything
 * else is a reload: a whole tab, redrawn, never a patch of a stale drawing (ADR 0007).
 */
async function reloadOpenTab() {
  reloading = true
  try {
    do {
      reloadQueued = false
      const target = watchedTab
      if (!target) return
      let change
      try {
        change = await bench.reloadTab(target.dir, target.name)
      } catch (error) {
        change = { state: 'error', message: error instanceof Error ? error.message : String(error) }
      }
      // The window may have moved on while the read was in flight.
      if (!window || !watchedTab || watchedTab.dir !== target.dir || watchedTab.name !== target.name) return
      if (change.state !== 'same') {
        window.webContents.send('bench:changed', { dir: target.dir, name: target.name, ...change })
      }
    } while (reloadQueued)
  } finally {
    reloading = false
  }
}

function scheduleReload() {
  if (windowCalls > 0) {
    missedWhileBusy = true
    return
  }
  if (reloading) {
    reloadQueued = true
    return
  }
  void reloadOpenTab()
}

// --- the core, exposed as calls -------------------------------------------------------------

let windowCalls = 0
let missedWhileBusy = false

/**
 * Refusals cross the IPC boundary as data, not as thrown errors: Electron's structured clone keeps
 * an Error's message and drops the rest, and a window that shows "point rejected" without the list
 * of problems is worse than one that shows nothing.
 *
 * The two counters above are the live-refresh handshake: a call that saves a tab makes its own
 * filesystem event, and reloading in the middle of that save would redraw a tab the window is
 * already drawing. An event that arrives during a call is answered once the call settles, against
 * the stamps the call left behind.
 */

async function guarded(run) {
  windowCalls += 1
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
  } finally {
    windowCalls -= 1
    if (windowCalls === 0 && missedWhileBusy) {
      missedWhileBusy = false
      scheduleReload()
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

// One tab at a time, because one tab is on screen. The window calls this whenever the tab it is
// drawing changes; `name: null` means nothing is open, and no watcher should be left running.
ipcMain.handle('bench:watch', (_event, dir, name) =>
  guarded(async () => {
    stopWatching()
    if (name === null) return { watching: false }
    watchedTab = { dir, name }
    stopWatcher = bench.watchProject(dir, scheduleReload)
    // A window re-arming the same tab is asking after a write it just did; answer from the stamps.
    scheduleReload()
    return { watching: true }
  }),
)
ipcMain.handle('bench:point', (_event, dir, id, viewName) => guarded(() => bench.point(dir, id, viewName)))
ipcMain.handle('bench:recipes', () => guarded(() => bench.recipes()))
ipcMain.handle('bench:shapeChoice', () => guarded(async () => bench.shapeChoice()))

// Creating a project is a write: one log event, one folder. The dialog collects a name, a parent
// folder and a shape; everything else — the folder's slug, the shape's validation — is the core's.
ipcMain.handle('bench:createProject', (_event, parent, name, shape) =>
  guarded(() => bench.createProject(parent, name, shape)),
)

ipcMain.handle('bench:pickImportFile', async (event) => {
  // Capture-only: the real picker is native and cannot be clicked by the harness. Every interactive
  // run opens it, which is the path a person uses.
  if (captureDir && nextPickedFile) {
    const file = nextPickedFile
    setNextPickedFile(null)
    return { ok: true, value: file }
  }
  const owner = BrowserWindow.fromWebContents(event.sender)
  const result = await dialog.showOpenDialog(owner, {
    title: 'Import a table',
    buttonLabel: 'Preview',
    properties: ['openFile'],
    filters: [
      { name: 'Tables (CSV, TSV, JSON lines)', extensions: ['csv', 'tsv', 'tab', 'jsonl', 'ndjson'] },
      { name: 'All files', extensions: ['*'] },
    ],
  })
  return { ok: true, value: result.canceled ? null : (result.filePaths[0] ?? null) }
})

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
// An import is one plan and one append: a refusal returns before anything is preserved or written.
ipcMain.handle('bench:importPreview', (_event, dir, file) => guarded(() => bench.importPreview(dir, file)))
ipcMain.handle('bench:importPlan', (_event, dir, file, mapping, options) =>
  guarded(() => bench.importPlan(dir, file, mapping, options)),
)
ipcMain.handle('bench:importFile', (_event, dir, file, mapping, options) =>
  guarded(() => bench.importFile(dir, file, mapping, options)),
)
ipcMain.handle('bench:refreshView', (_event, dir, name, options) =>
  guarded(() => bench.refreshView(dir, name, options)),
)
ipcMain.handle('bench:persistView', (_event, dir, name) => guarded(() => bench.persistView(dir, name)))

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
