/* The packaged build's own proof: it drew a chart, typed into a custom shape, and says why no recipe. */
import { app, ipcMain } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import * as bench from '../core.bundle.mjs'
import { window, smokeDir, startupDir, setNextStartup } from './context.js'
import { sleep, typeValues, entryState, focusWindowForInput } from './driver.js'

function expect(condition, message) {
  if (!condition) throw new Error(message)
}

async function waitFor(description, check) {
  const deadline = Date.now() + 12000
  for (;;) {
    const result = await check()
    if (result) return result
    if (Date.now() > deadline) throw new Error(`the packaged window never ${description}`)
    await sleep(100)
  }
}

/**
 * The one project the default fixture cannot exercise: a shape whose fields are not x/y. The tab is
 * built by the core the window calls, then the packaged window is reloaded onto it and typed into —
 * a real keystroke path, not a synthetic submit.
 */
async function customAxes() {
  expect(startupDir !== null, 'BENCH_APP_PROJECT is not set: there is no project to prove')
  const opened = await bench.createProject(dirname(startupDir), 'load cells', {
    id: 'load.v1',
    fields: [
      { name: 'mass', type: 'number' },
      { name: 'extension', type: 'number' },
    ],
  })
  await bench.writeView(opened.dir, {
    name: 'first tab',
    dataset: 'main',
    xField: 'mass',
    yField: 'extension',
  })

  const loaded = new Promise((done) => ipcMain.once('bench:ready', done))
  setNextStartup(opened.dir)
  window.webContents.reload()
  await loaded
  expect(await focusWindowForInput(), 'the packaged window never took focus for typing')
  await waitFor('opened the custom-axis tab', async () => {
    const state = JSON.parse(await entryState())
    return state.panels === 1 && state.marks === 0 && /n = 0/.test(state.readout)
  })

  const typed = [
    [2.5, 12, 1],
    [2.6, 12.2, 2],
    // Outside both axes, so the third point forces a whole redraw rather than one more mark.
    [1000, 5000, 3],
  ]
  for (const [x, y, n] of typed) {
    await typeValues([x, y])
    await waitFor(`reached n = ${n}`, async () => {
      const state = JSON.parse(await entryState())
      return state.marks === n && new RegExp(`n = ${n}\\b`).test(state.readout)
    })
  }
  window.setAlwaysOnTop(false)

  const viewPath = join(opened.dir, 'views', 'first-tab.json')
  const saved = await waitFor('saved three points', async () => {
    const file = JSON.parse(await readFile(viewPath, 'utf8'))
    return file.panels[0].n === 3 ? file : null
  })
  const panel = saved.panels[0]
  expect(
    panel.chart.x.label === 'mass' && panel.chart.y.label === 'extension',
    `the saved tab lost its axes: ${panel.chart.x.label}/${panel.chart.y.label}`,
  )

  // Hover and selection through the drawing's own pointer handlers: the hover reads out the values
  // and the correction strip names the same measurement, both without the record's id.
  const target = await window.webContents.executeJavaScript(`(() => {
    const host = document.querySelector('.panel-chart')
    const marks = host.__benchChart.marks()
    const mark = marks[marks.length - 1]
    const at = { clientX: mark.x, clientY: mark.y }
    host.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, ...at }))
    // The readout is one block per fact, and textContent on the box would glue the lines together
    // ("… 5 000Observed …"). Read the blocks and join them the way they are drawn, one per line.
    // The separator is a code point rather than an escape because this text is already inside a
    // template literal: an escape here would be consumed twice and reach the page as a raw newline.
    const rows = document.getElementById('tooltip').children
    const lines = Array.prototype.map.call(rows, (row) => row.textContent)
    return JSON.stringify({ id: mark.id, tooltip: lines.join(String.fromCharCode(10)) })
  })()`)
  const hovered = JSON.parse(target)
  expect(hovered.id, 'the redrawn custom-axis chart exposed no mark id')
  expect(
    !hovered.tooltip.includes(hovered.id),
    `hover still shows the record id: "${hovered.tooltip}"`,
  )
  expect(
    /mass \S/.test(hovered.tooltip) && /extension \S/.test(hovered.tooltip),
    `hover lost the custom fields: "${hovered.tooltip}"`,
  )

  const selected = await window.webContents.executeJavaScript(`(() => {
    const host = document.querySelector('.panel-chart')
    const mark = host.__benchChart.marks().slice(-1)[0]
    for (const type of ['pointerdown', 'pointerup']) {
      host.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 1,
          button: 0,
          clientX: mark.x,
          clientY: mark.y,
        }),
      )
    }
    return mark.id
  })()`)
  const correction = await waitFor('named the selected point', async () => {
    const label = await window.webContents.executeJavaScript(
      "document.getElementById('entry-correct-label').textContent",
    )
    return /Editing/.test(label) ? label : null
  })
  expect(
    !correction.includes(selected),
    `the correction strip still shows the record id: "${correction}"`,
  )
  expect(
    /mass \S/.test(correction) && /extension \S/.test(correction),
    `the correction strip lost the measurement: "${correction}"`,
  )

  return {
    saved: { n: panel.n, x: panel.chart.x.label, y: panel.chart.y.label },
    hover: { tooltip: hovered.tooltip },
    selection: correction,
  }
}

/**
 * What the shipped build has to be able to answer: it is packaged, it drew a chart from a project
 * folder, the entry bar offers the shape's fields, it says why no recipe is on offer, and a point
 * typed into a custom shape reaches the drawing and the saved tab.
 */
export async function smoke() {
  await mkdir(smokeDir, { recursive: true })
  // One paint plus a thumbnail render; the window is offscreen, so there is no other signal.
  await sleep(1500)

  const facts = JSON.parse(await window.webContents.executeJavaScript(`(() => JSON.stringify({
    panels: document.querySelectorAll('.panel').length,
    marks: Array.prototype.reduce.call(document.querySelectorAll('.panel-chart'), (total, host) => total + Number(host.dataset.marks || 0), 0),
    badges: Array.prototype.map.call(document.querySelectorAll('.panel-strip .badge'), (b) => b.textContent),
    fields: Array.prototype.map.call(document.querySelectorAll('#entry-fields input'), (i) => i.dataset.field),
    readout: document.getElementById('entry-readout').textContent,
    title: document.getElementById('view-title').textContent,
    meta: document.getElementById('view-meta').textContent,
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

  const drawn = facts.panels > 0 && facts.marks > 0
  const usable = facts.fields.length > 0
  expect(app.isPackaged, 'this is not a packaged build')
  expect(drawn, 'no chart was drawn')
  expect(usable, 'the entry bar offers no fields')
  // The review frame stays the fixture's tab; the custom project is proof, not a new visual.
  await writeFile(join(smokeDir, 'app-packaged.png'), (await window.webContents.capturePage()).toPNG())

  const custom = await customAxes()

  const report = {
    packaged: app.isPackaged,
    electron: process.versions.electron,
    url: window.webContents.getURL(),
    facts,
    tabDialog: dialog,
    recipes: { offered: catalog.recipes.map((recipe) => recipe.name), problem: catalog.problem ?? null },
    custom,
  }
  console.log('[bench] packaged ' + JSON.stringify(report))
  app.exit(0)
}
