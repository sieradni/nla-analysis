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
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
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

const child = spawn(electron, [join(root, 'app', 'main.js')], {
  cwd: root,
  env: {
    ...process.env,
    BENCH_CAPTURE: outDir,
    BENCH_APP_PROJECT: project,
    // Electron writes its Chromium cache into the user profile; keep the review run self-contained.
    ELECTRON_USER_DATA_DIR: join(root, 'artifacts', 'electron-profile'),
  },
  stdio: 'inherit',
})

const code = await new Promise((done) => {
  child.on('exit', (status) => done(status ?? 1))
  child.on('error', (error) => {
    console.error('could not start electron:', error.message)
    done(1)
  })
})

const frames = ['app-100.png', 'app-125.png', 'app-150.png', 'app-interaction.png']
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

process.exit(code === 0 && missing === 0 ? 0 : 1)
