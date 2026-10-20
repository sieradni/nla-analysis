/* BENCH_MEASURE: append points through the running window and report what each one cost. */
import { app } from 'electron'
import { window, measureRuns, nextStartup } from './context.js'
import { focusWindowForInput, sleep, submitEntry } from './driver.js'

/**
 * `BENCH_MEASURE=<n>`: append n points through the running window and report what each one cost,
 * split into the three things a person would blame — the write, the rebuild, and the paint.
 */
export async function measure() {
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
