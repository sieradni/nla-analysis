#!/usr/bin/env node
/**
 * Measure what one typed point costs in the real window, at 10k points.
 *
 * ADR 0003 puts a 100 ms budget on the entry path and was measured against the core alone (15.7 ms).
 * The window adds three things the core never pays: the log append, the tab rebuild, and the paint.
 * This drives the actual window — real keyboard events into the entry bar — and reports the split,
 * so "it fits the budget" is a number rather than a hope.
 *
 * Usage: node scripts/measure-window.mjs [runs]   (default 8)
 *
 * The project is built in a temp folder by the public CLI: 10,000 rows imported from a CSV, one
 * plot panel. Nothing here is committed and nothing touches the operator's registry.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runs = Number(process.argv[2] ?? 8)
const POINTS = 10_000

if (!Number.isFinite(runs) || runs < 1) {
  console.error('usage: node scripts/measure-window.mjs [runs]')
  process.exit(1)
}

const scratch = await mkdtemp(join(tmpdir(), 'bench-measure-'))
const home = await mkdtemp(join(tmpdir(), 'bench-measure-home-'))
const project = join(scratch, 'bench-10k')
const csv = join(scratch, 'readings.csv')

function bench(args, options = {}) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [join(root, 'src', 'cli', 'index.ts'), ...args], {
      cwd: root,
      env: { ...process.env, BENCH_HOME: home },
      stdio: options.quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    })
    let out = ''
    child.stdout?.on('data', (chunk) => (out += chunk))
    child.on('error', fail)
    child.on('exit', (code) => (code === 0 ? done(out) : fail(new Error(`bench ${args[0]} exited ${code}`))))
  })
}

console.log(`building a ${POINTS.toLocaleString()}-point project in ${project}`)

// A deterministic band, so two runs measure the same chart. An LCG rather than Math.random: a
// measurement that cannot be reproduced is an anecdote.
let seed = 42
const noise = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return (seed / 2147483648 - 0.5) * 40
}

// A row is identified by its instant, so the seed carries one: an import with no observation time
// is refused now. One minute apart, from a fixed epoch, keeps the fixture deterministic.
const rows = ['t_observed,x,y']
for (let index = 1; index <= POINTS; index += 1) {
  const at = new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString()
  rows.push(`${at},${index},${(2.5 * index + noise()).toFixed(3)}`)
}
await writeFile(csv, rows.join('\n') + '\n')

await bench(['init', project, '--name', 'bench-10k'])
const imported = await bench(
  ['--project', project, 'import', csv, '--map', 'x=x', '--map', 'y=y', '--time', 't_observed'],
  { quiet: true },
)
console.log(imported.trim().split('\n').slice(-1)[0])
await bench(['--project', project, 'view', 'new', 'all readings', '--dataset', 'main'], { quiet: true })

const samples = []
const rescale = []
let summary = null
const child = spawn(electron, [join(root, 'app', 'main.js')], {
  cwd: root,
  env: {
    ...process.env,
    BENCH_MEASURE: String(runs),
    BENCH_APP_PROJECT: project,
    BENCH_HOME: home,
    ELECTRON_USER_DATA_DIR: join(root, 'artifacts', 'electron-profile'),
  },
  stdio: ['ignore', 'pipe', 'inherit'],
})

child.stdout.on('data', (chunk) => {
  for (const line of String(chunk).split('\n')) {
    if (line.includes('[bench] entry-rescale ')) {
      const payload = JSON.parse(line.slice(line.indexOf('{')))
      rescale.push(payload)
      console.log(
        `  point outside the current axes: ${payload.total.toFixed(1)} ms ` +
          `(record ${payload.record.toFixed(1)} · rebuild ${payload.rebuild.toFixed(1)} · paint ${payload.paint.toFixed(1)})` +
          `${payload.incremental ? ' [patched, not redrawn]' : ' [full redraw]'}`,
      )
    } else if (line.includes('[bench] entry ')) {
      const payload = JSON.parse(line.slice(line.indexOf('{')))
      samples.push(payload)
      console.log(
        `  run ${samples.length}: ${payload.total.toFixed(1)} ms ` +
          `(record ${payload.record.toFixed(1)} · rebuild ${payload.rebuild.toFixed(1)} · paint ${payload.paint.toFixed(1)}` +
          `${typeof payload.commit === 'number' ? ` · tab file ${payload.commit.toFixed(1)}` : ''})` +
          `${payload.incremental ? '' : ' [full redraw]'}`,
      )
    } else if (line.includes('[bench] measure ')) {
      summary = JSON.parse(line.slice(line.indexOf('{')))
    } else if (line.trim() !== '') {
      console.log(line)
    }
  }
})

const code = await new Promise((done) => {
  child.on('error', (error) => {
    console.error('could not start electron:', error.message)
    done(1)
  })
  child.on('exit', (status) => done(status ?? 1))
})

await rm(scratch, { recursive: true, force: true })
await rm(home, { recursive: true, force: true })

if (code !== 0) {
  console.error(`measurement failed (electron exited ${code})`)
  process.exit(1)
}
if (samples.length === 0) {
  console.error('measurement failed: the window reported no typed entry')
  process.exit(1)
}
if (!summary) {
  console.error('measurement failed: the window reported no summary')
  process.exit(1)
}
// A sample taken by setting the fields and submitting the form is not a keystroke. The measurement
// is about the path a person uses, so it is refused rather than annotated and counted.
if (summary.syntheticSubmits > 0) {
  console.error(
    `measurement failed: ${summary.syntheticSubmits} of ${samples.length} entries were submitted ` +
      'programmatically, so the window was not measuring keystrokes',
  )
  process.exit(1)
}
// The re-render budget only has a number when a point outside the axes forced a whole redraw. A
// missing sample, or one the window patched instead, is a gate that would pass without measuring.
if (rescale.length === 0) {
  console.error('measurement failed: no full-redraw sample — the window reported no off-domain point')
  process.exit(1)
}
if (rescale[0].incremental !== false) {
  console.error('measurement failed: the off-domain point was patched, not fully redrawn')
  process.exit(1)
}

const totals = samples.map((sample) => sample.total).sort((a, b) => a - b)
const median = totals[Math.floor(totals.length / 2)]
const p90 = totals[Math.min(totals.length - 1, Math.floor(totals.length * 0.9))]
const pick = (key) => samples.map((sample) => sample[key]).sort((a, b) => a - b)[Math.floor(samples.length / 2)]
// Only some points catch the tab file up after the paint; the ones that do not have no commit time.
const commits = samples
  .map((sample) => sample.commit)
  .filter((value) => typeof value === 'number')
  .sort((a, b) => a - b)

console.log('')
console.log(`${POINTS.toLocaleString()} points · 1 plot panel · ${samples.length} typed points`)
console.log(`  median ${median.toFixed(1)} ms   p90 ${p90.toFixed(1)} ms   max ${totals[totals.length - 1].toFixed(1)} ms`)
console.log(
  `  median split: record ${pick('record').toFixed(1)} ms · rebuild ${pick('rebuild').toFixed(1)} ms · paint ${pick('paint').toFixed(1)} ms`,
)
if (commits.length > 0) {
  console.log(
    `  after the paint, the tab file catches up in ${commits[Math.floor(commits.length / 2)].toFixed(1)} ms (not on the keystroke path)`,
  )
}
const rescaleMs = rescale[0].total
console.log(`  point outside the current axes: ${rescaleMs.toFixed(1)} ms (full redraw)`)
console.log(`  budget: 100 ms entry (ADR 0003) — ${median <= 100 ? 'within' : 'OVER'} budget at the median`)
console.log(
  `  budget: 50 ms re-render (requirements §6) — ${rescaleMs <= 50 ? 'within' : 'OVER'} budget`,
)

process.exit(median <= 100 && rescaleMs <= 50 ? 0 : 1)
