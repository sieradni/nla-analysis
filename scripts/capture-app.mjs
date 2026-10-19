#!/usr/bin/env node
/**
 * Launch the desktop shell and capture the real window for review.
 *
 * This is not a mock-up: it starts Electron, waits for the renderer to report its first paint, and
 * captures the window at 100%, 125% and 150% scaling exactly as `main.js` renders it. The PNGs land
 * in `docs/ui-review/` and the review log refers to them.
 *
 * Usage: pnpm app:capture
 *   BENCH_PROJECT=<dir>   project to open (defaults to the committed drift-sensor fixture)
 *
 * Frames: three scalings and an interaction frame from the project, then an append, its undo, a
 * refusal, a point typed after the real CLI appended behind the window's back, a correction made by
 * selecting a mark, a tab built from the dialog, and a project created with a shape of its own —
 * captured on scratch copies, so no committed log is ever written by a review run.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'docs', 'ui-review')
const project = process.env.BENCH_PROJECT
  ? resolve(process.env.BENCH_PROJECT)
  : join(root, 'fixtures', 'projects', 'drift-sensor')

if (!existsSync(join(root, 'app', 'core.bundle.mjs'))) {
  console.error('app/core.bundle.mjs is missing — run `pnpm app:build` first')
  process.exit(1)
}

await mkdir(outDir, { recursive: true })

// The entry frames append a point. They do it on a copy: the committed fixture's log is evidence a
// test reads, and a capture run must never rewrite it.
const scratch = await mkdtemp(join(tmpdir(), 'bench-capture-'))
const writable = join(scratch, 'drift-sensor')
await cp(project, writable, { recursive: true })
// And the run gets its own project registry. Opening a project records a recent, so without this
// every capture left another temp copy in the operator's real project list.
const benchHome = await mkdtemp(join(tmpdir(), 'bench-capture-home-'))

const child = spawn(electron, [join(root, 'app', 'main.js')], {
  cwd: root,
  env: {
    ...process.env,
    BENCH_CAPTURE: outDir,
    BENCH_APP_PROJECT: project,
    BENCH_CAPTURE_WRITABLE: writable,
    BENCH_HOME: benchHome,
    // Electron writes its Chromium cache into the user profile; keep the review run self-contained.
    ELECTRON_USER_DATA_DIR: join(root, 'artifacts', 'electron-profile'),
  },
  stdio: 'inherit',
})

let code = await new Promise((done) => {
  child.on('exit', (status) => done(status ?? 1))
  child.on('error', (error) => {
    console.error('could not start electron:', error.message)
    done(1)
  })
})

// A person who presses the exe and clicks New… is the case the recorded launcher exists for, so the
// project the window just created is checked here, not assumed from the fact that the window and the
// CLI share `initProject`. Read the line out of that project's own AGENTS.md and run it from a
// folder unrelated to both the repository and the project.
const windowProject = join(scratch, 'new-project', 'load-cells')
if (code === 0) {
  try {
    const agents = await readFile(join(windowProject, 'AGENTS.md'), 'utf8')
    const recorded = agents.match(/^ {4}(.+?) --project "(.+?)" state$/m)
    if (!recorded) throw new Error(`the window's project AGENTS.md names no launcher:\n${agents}`)
    const [, launcher, recordedProject] = recorded
    if (recordedProject !== windowProject.replaceAll('\\', '/')) {
      throw new Error(`the window's AGENTS.md points at ${recordedProject}`)
    }
    const packaged = launcher.match(/^"(.+?bench\.cmd)"$/)
    const checkout = launcher.match(/^pnpm -C "(.+?)" bench$/)
    if (packaged) {
      if (!existsSync(packaged[1])) throw new Error(`the launcher ${packaged[1]} does not exist`)
    } else if (checkout) {
      if (!existsSync(join(checkout[1], 'package.json'))) {
        throw new Error(`the checkout ${checkout[1]} has no package.json`)
      }
    } else {
      throw new Error(`the window recorded an unknown launcher: ${launcher}`)
    }
    const followed = spawnSync(recorded[0].trim(), {
      shell: true,
      cwd: scratch,
      env: process.env,
      encoding: 'utf8',
      windowsHide: true,
    })
    const output = `${followed.stdout ?? ''}${followed.stderr ?? ''}`
    if (followed.status !== 0) {
      throw new Error(`the window's recorded launcher exited ${followed.status}\n${output}`)
    }
    if (!/# STATE/.test(output)) throw new Error(`the launcher printed:\n${output}`)
    console.log('window project: AGENTS.md names a launcher that runs from an unrelated folder')
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    code = 1
  }
}

const frames = [
  'app-100.png',
  'app-125.png',
  'app-150.png',
  'app-interaction.png',
  'app-entry.png',
  'app-undo.png',
  'app-refused.png',
  'app-second-writer.png',
  'app-corrected.png',
  'app-new-tab.png',
  'app-new-project.png',
  'app-live.png',
  'app-tab-replaced.png',
  'app-tab-gone.png',
  'app-import.png',
  'app-version-diff.png',
  'app-import-untimed.png',
  'app-import-time.png',
  'app-mixed-versions.png',
]
let missing = 0
for (const frame of frames) {
  const path = join(outDir, frame)
  if (!existsSync(path)) {
    console.error(`missing capture: ${path}`)
    missing += 1
    continue
  }
  const size = await stat(path)
  console.log(`captured ${frame} (${(size.size / 1024).toFixed(0)} KB)`)
}

if (code === 0) {
  await rm(scratch, { recursive: true, force: true })
  await rm(benchHome, { recursive: true, force: true })
} else {
  console.error(`capture failed; the scratch project is still at ${writable}`)
}

process.exit(code === 0 && missing === 0 ? 0 : 1)
