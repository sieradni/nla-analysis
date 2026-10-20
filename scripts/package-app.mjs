#!/usr/bin/env node
/**
 * Build a standalone Windows copy of the desktop shell.
 *
 * This deliberately does not use a packager that fetches its own Electron: the runtime is already in
 * `node_modules/electron/dist`, put there by the install, and this machine's network has already
 * needed a retry once. So the build copies that dist as-is, drops the app into `resources/app`, and
 * renames the executable. No download, no archive, no asar.
 *
 * What ships is an explicit list, not a filter over the repository: the fixtures are review data and
 * the tests are development tooling, and neither belongs in a build. The Python environment is not
 * shipped either — it is 164 MB of local machine state — so recipes degrade to "not available" with
 * the reason, while plot panels and every other door keep working.
 *
 * Usage: pnpm app:package        (runs `pnpm app:build` first)
 * Artifact: artifacts/bench-win32-x64/bench.exe
 */
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'node_modules', 'electron', 'dist')
const out = join(root, 'artifacts', 'bench-win32-x64')
const appDir = join(out, 'resources', 'app')

/** The whole application: the shell, its preload, the bundled core, and the renderer. */
const APP_FILES = [
  'main.js',
  'preload.cjs',
  'core.bundle.mjs',
  join('src', 'cli', 'index.mjs'),
  join('renderer', 'index.html'),
  join('renderer', 'app.js'),
  join('renderer', 'chart.js'),
  join('renderer', 'state.js'),
  join('renderer', 'format.js'),
  join('renderer', 'navigation.js'),
  join('renderer', 'rail.js'),
  join('renderer', 'panels.js'),
  join('renderer', 'entry.js'),
  join('renderer', 'tabs.js'),
  join('renderer', 'projects.js'),
  join('renderer', 'import.js'),
  join('renderer', 'app.css'),
  join('renderer', 'tokens.css'),
  join('harness', 'context.js'),
  join('harness', 'driver.js'),
  join('harness', 'smoke.js'),
  join('harness', 'capture.js'),
  join('harness', 'measure.js'),
]

/**
 * The recipes are data for `assessRuns` — a panel's freshness is a hash of the recipe file — so they
 * ship even though the interpreter that runs them does not. `requirements.lock.txt` travels with
 * them so a machine that *does* create an environment creates the same one.
 */
const RECIPE_FILES = ['runner.py', 'fit.py', 'drift.py', 'requirements.lock.txt']

/** The CLI launcher: the artifact's own Electron binary, in Node mode, running the bundled CLI. */
const CLI_LAUNCHER = [
  '@echo off',
  'setlocal',
  'set "ELECTRON_RUN_AS_NODE=1"',
  '"%~dp0bench.exe" "%~dp0resources/app/src/cli/index.mjs" %*',
  'exit /b %ERRORLEVEL%',
].join('\r\n') + '\r\n'

const LAUNCH = `bench — desktop data workspace
============================

Double-click bench.exe. No installation, no terminal, no repository needed.

The window lists the projects this machine has opened. "Open…" adds an existing project folder;
"New…" creates one, including the shape its points will have.

Where things live
  projects          wherever you keep them — a project is a folder with data/events.jsonl
  project list      %USERPROFILE%\\.bench\\projects.json  (app state; losing it loses recency, not data)

The CLI
  bench.cmd beside bench.exe is the same bench CLI, run by the bundled Electron runtime in Node
  mode. It needs no Node install and no repository. Call it by path:

      C:\path\to\bench-win32-x64\bench.cmd --project C:\path\to\project state

  Do not add this folder to PATH and expect \`bench\` to mean the CLI: \`bench.exe\` is the window, and
  PATHEXT resolves it first. The CLI itself is resources/app/src/cli/index.mjs.

What needs Python
  A tab whose panel is drawn by a recipe (a fit or a drift) needs the analysis environment, which is
  not bundled. Plot tabs, imports, and the CLI's init/check/state/view commands work without it, and
  the tab dialog says why no recipe is offered. \`bench run fit\` and \`bench run drift\` need a Python
  found at resources/app/recipes/.venv or on PATH. The repository explains how to create that
  environment; a build this size stays small by not carrying 164 MB of local machine state.

Reports and limits
  A tab's saved file is drawn again from the log, so nothing in this folder is the only copy of
  anything. There is no installer, no auto-update and no code signing in this build.
`

function fail(message) {
  console.error(`package: ${message}`)
  process.exit(1)
}

if (!existsSync(dist)) {
  fail(`no Electron runtime at ${dist} — run \`pnpm exec install-electron\` first`)
}
if (!existsSync(join(root, 'app', 'core.bundle.mjs'))) {
  fail('app/core.bundle.mjs is missing — run `pnpm app:build` first (or `pnpm app:package`)')
}
if (!existsSync(join(root, 'app', 'src', 'cli', 'index.mjs'))) {
  fail('app/src/cli/index.mjs is missing — run `pnpm app:build` first (or `pnpm app:package`)')
}

const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version
const runtime = (await readFile(join(dist, 'version'), 'utf8')).trim()

// Start from nothing: a stale file from a previous build is worse than no file, because it looks
// shipped. `artifacts/` is ignored by git, so this only ever removes generated output.
await rm(out, { recursive: true, force: true })
await mkdir(join(out, 'resources', 'app'), { recursive: true })

// 1. The runtime, as fetched.
await cp(dist, out, { recursive: true })
await rm(join(out, 'electron.exe'))
await cp(join(dist, 'electron.exe'), join(out, 'bench.exe'))
// Electron's fallback app is never used once resources/app exists, and shipping it invites the
// question of which one starts.
await rm(join(out, 'resources', 'default_app.asar'), { force: true })

// 2. The application, by explicit list.
for (const file of APP_FILES) {
  const source = join(root, 'app', file)
  if (!existsSync(source)) fail(`missing ${source}`)
  await mkdir(dirname(join(appDir, file)), { recursive: true })
  await cp(source, join(appDir, file))
}

// 3. The recipes as data (not the environment that runs them).
await mkdir(join(appDir, 'recipes'), { recursive: true })
for (const file of RECIPE_FILES) {
  const source = join(root, 'recipes', file)
  if (!existsSync(source)) fail(`missing ${source}`)
  await cp(source, join(appDir, 'recipes', file))
}

// 4. A package.json for the app itself: `type: module` is what lets main.js run as ESM.
await writeFile(
  join(appDir, 'package.json'),
  JSON.stringify(
    {
      name: 'bench',
      productName: 'bench',
      version,
      description: 'Durable data-analysis workspace',
      main: 'main.js',
      type: 'module',
      private: true,
    },
    null,
    2,
  ) + '\n',
)

// 5. The CLI, launched through the runtime that is already here.
await writeFile(join(out, 'bench.cmd'), CLI_LAUNCHER)

// 6. Launch instructions where the person who receives the folder will look.
await writeFile(join(out, 'LAUNCH.txt'), LAUNCH)

const bytes = await directorySize(out)
const shipped = await readdir(appDir)
console.log(`built ${out}`)
console.log(`  bench.exe + Electron ${runtime}`)
console.log(`  ${(bytes / 1024 / 1024).toFixed(0)} MB on disk · resources/app holds ${shipped.join(', ')}`)
console.log(`  not shipped: fixtures/, tests/, node_modules/, docs/, recipes/.venv (164 MB), all git history`)
console.log(`  launch: double-click ${join(out, 'bench.exe')}`)
console.log(`  CLI: ${join(out, 'bench.cmd')} (resources/app/src/cli/index.mjs)`)
console.log(`  prove it: pnpm app:package:check`)

async function directorySize(dir) {
  let total = 0
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) total += await directorySize(path)
    else total += (await stat(path)).size
  }
  return total
}
