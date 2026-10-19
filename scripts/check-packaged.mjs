#!/usr/bin/env node
/**
 * Prove the packaged build by running it.
 *
 * A build that exists is not a build that launches, and a launch that shows a window is not a build
 * that can draw a project. This starts `bench.exe` from `artifacts/`, points it at a scratch copy of
 * the committed fixture, and lets the app itself report: `app.isPackaged`, the panels and marks it
 * painted, the fields its entry bar offers, and what the recipe catalog said. Then it checks the
 * artifact for the things that must not be in it.
 *
 * Usage: pnpm app:package:check     (after pnpm app:package)
 */
import { spawn } from 'node:child_process'
import { cp, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const artifact = join(root, 'artifacts', 'bench-win32-x64')
const exe = join(artifact, 'bench.exe')
const reviewDir = join(root, 'docs', 'ui-review')

function fail(message) {
  console.error(`packaged check: ${message}`)
  process.exit(1)
}

if (!existsSync(exe)) fail(`no build at ${exe} — run \`pnpm app:package\` first`)

const scratch = await mkdtemp(join(tmpdir(), 'bench-packaged-'))
const project = join(scratch, 'drift-sensor')
const userData = join(scratch, 'profile')
const home = join(scratch, 'home')
const reportDir = join(scratch, 'report')
await cp(join(root, 'fixtures', 'projects', 'drift-sensor'), project, { recursive: true })

const startedAt = Date.now()
const child = spawn(exe, [], {
  cwd: tmpdir(),
  env: {
    ...process.env,
    BENCH_SMOKE: reportDir,
    BENCH_APP_PROJECT: project,
    BENCH_USER_DATA: userData,
    BENCH_HOME: home,
    // Take Python away on purpose: the build must still open and draw, and must say why no recipe
    // is offered. This is the degradation the artifact is supposed to have, checked rather than
    // assumed from a machine that happens to have an environment.
    PATH: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'),
    BENCH_PYTHON: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let stdout = ''
let stderr = ''
child.stdout.on('data', (chunk) => (stdout += chunk))
child.stderr.on('data', (chunk) => (stderr += chunk))
child.on('error', (error) => fail(`could not start ${exe}: ${error.message}`))

const code = await new Promise((done) => child.on('exit', (status) => done(status ?? 1)))
const elapsed = Date.now() - startedAt

const reported = stdout.split('\n').find((entry) => entry.includes('[bench] packaged '))
if (!reported) {
  console.error(stderr.trim())
  fail(`the packaged build printed no report (exit ${code})`)
}
const report = JSON.parse(reported.slice(reported.indexOf('[bench] packaged ') + '[bench] packaged '.length))
console.log(`launched ${exe}`)
console.log(
  `  packaged=${report.packaged} electron=${report.electron} panels=${report.facts.panels} marks=${report.facts.marks}`,
)
console.log(`  title="${report.facts.title}" readout="${report.facts.readout}" fields=${report.facts.fields.join(',')}`)
console.log(`  recipes offered=${report.recipes.offered.length} problem=${report.recipes.problem ?? '(none)'}`)
console.log(`  tab dialog options=${report.tabDialog.options.join(',')} note="${report.tabDialog.note}"`)
console.log(`  ${elapsed} ms from spawn to report, then exit ${code}`)

if (code !== 0) fail(`the build reported success but exited ${code}`)
if (report.packaged !== true) fail('app.isPackaged was false: this is not a packaged build')
// The renderer has to be the one inside the artifact, not the repository's.
if (!/resources[\\/]app[\\/]renderer[\\/]index\.html$/i.test(report.url)) {
  fail(`the window loaded ${report.url}`)
}
if (!report.facts.panels || !report.facts.marks) fail('the build painted no chart')
if (!report.facts.fields.length) fail('the entry bar offered no fields')
if (report.recipes.offered.length !== 0) fail('a recipe was offered without the analysis runtime')
if (!report.recipes.problem) fail('no recipe was offered and no reason was given')
if (!/python|runtime/i.test(report.recipes.problem)) {
  fail(`the reason does not name the runtime: ${report.recipes.problem}`)
}
// And the window says it, rather than only the core: one option (a plot), and a sentence naming the
// missing runtime. A dialog that silently offered only plots would be a different, quieter failure.
if (!report.tabDialog.open) fail('the tab dialog did not open')
if (JSON.stringify(report.tabDialog.options) !== '["plot"]') {
  fail(`the tab dialog offered ${JSON.stringify(report.tabDialog.options)} without a runtime`)
}
if (!/not available/i.test(report.tabDialog.note)) {
  fail(`the tab dialog gave no reason: "${report.tabDialog.note}"`)
}

// The artifact itself, not the report: these must not be in a build.
const appDir = join(artifact, 'resources', 'app')
for (const path of ['fixtures', 'tests', 'node_modules', 'docs', 'data', join('recipes', '.venv'), join('recipes', '__pycache__')]) {
  if (existsSync(join(appDir, path))) fail(`${path} was shipped in resources/app`)
}
for (const required of ['main.js', 'preload.cjs', 'core.bundle.mjs', join('renderer', 'index.html'), join('recipes', 'runner.py')]) {
  if (!existsSync(join(appDir, required))) fail(`${required} is missing from resources/app`)
}
for (const runtimeFile of ['bench.exe', 'resources.pak', 'icudtl.dat', join('resources', 'app', 'package.json')]) {
  if (!existsSync(join(artifact, runtimeFile))) fail(`${runtimeFile} is missing from the build`)
}
if (existsSync(join(artifact, 'resources', 'default_app.asar'))) {
  fail('Electron\'s fallback app is still in the build')
}

const size = await sizeOf(artifact)
if (size > 450 * 1024 * 1024) fail(`the build is ${(size / 1048576).toFixed(0)} MB, larger than the 450 MB ceiling`)

// Keep the frame with the other review frames, and a receipt beside it. The receipt is committed,
// so it records what was checked rather than this machine's paths: no resourcesPath, no temp dirs.
await cp(join(reportDir, 'app-packaged.png'), join(reviewDir, 'app-packaged.png'))
await writeFile(
  join(reviewDir, 'app-packaged.json'),
  JSON.stringify(
    {
      packaged: report.packaged,
      electron: report.electron,
      url: report.url.replace(/^.*resources[\\/]app/i, 'resources/app'),
      facts: report.facts,
      tabDialog: report.tabDialog,
      recipes: report.recipes,
      elapsedMs: elapsed,
      artifactBytes: size,
    },
    null,
    2,
  ) + '\n',
)

console.log(`  artifact ${(size / 1048576).toFixed(0)} MB · no fixtures, tests, node_modules, docs or .venv`)
console.log(`  frame ${join(reviewDir, 'app-packaged.png')}`)

await rm(scratch, { recursive: true, force: true })

async function sizeOf(dir) {
  let total = 0
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    total += entry.isDirectory() ? await sizeOf(path) : (await stat(path)).size
  }
  return total
}
