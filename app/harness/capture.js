/*
 * The review capture: read-only frames, the entry path, the import sheet, and the accessibility tree.
 *
 * One linear scenario, because the frames are the argument: each step is a thing a person does, and
 * each assertion is what the window should have said afterwards.
 */
import { app, ipcMain } from 'electron'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  window,
  here,
  captureDir,
  writableDir,
  startupDir,
  startedAt,
  setNextStartup,
  setNextPickedFile,
} from './context.js'
import {
  sleep,
  typeText,
  focusWindowForInput,
  submitEntry,
  fieldValue,
  pressKey,
  pressEnter,
  focusField,
  entryState,
  waitForTiming,
  currentTimingId,
  runCli,
  readCli,
  enterPoint,
} from './driver.js'

/**
 * A frame taken by the renderer, not the window compositor. `capturePage` can return the surface it
 * last composited, which for a dialog that has just opened is the page underneath it.
 */
export async function rendererScreenshot() {
  const session = window.webContents.debugger
  if (!session.isAttached()) session.attach('1.3')
  const shot = await session.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: true })
  return Buffer.from(shot.data, 'base64')
}

/**
 * The image nodes Chromium actually exposes, not the attributes we put on them. A label that is
 * present in the DOM but ignored by the accessibility tree would pass an attribute check and fail
 * the screen reader, so the capture reads the tree.
 */
/** Acknowledge the columns the shape cannot store, which the core requires before it will plan. */
async function acknowledgeExtraColumns() {
  const checked = await window.webContents.executeJavaScript(`(() => {
    const field = document.getElementById('import-extra-field')
    const box = document.getElementById('import-ignore-extra')
    if (!field || field.hidden || !box) return false
    box.checked = true
    box.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  if (checked) await sleep(300)
  return checked
}

async function accessibilityImages() {
  const session = window.webContents.debugger
  if (!session.isAttached()) session.attach('1.3')
  const { nodes } = await session.sendCommand('Accessibility.getFullAXTree')
  return nodes
    .filter((node) => !node.ignored && node.role && node.role.value === 'image')
    .map((node) => ({
      name: (node.name && node.name.value) || '',
      description: (node.description && node.description.value) || '',
    }))
}

export async function capture() {
  // The renderer's own errors, so a script that throws says why instead of just "failed to execute".
  // Content-Security-Policy violations are counted rather than printed: the core's chart markup sets
  // `font-variant-numeric` as an inline style, which the shell's `style-src 'self'` blocks, so every
  // axis label reports one and a stack of them buries whatever else the renderer said.
  let cspViolations = 0
  window.webContents.on('console-message', (_event, level, message) => {
    if (/Content Security Policy/.test(message)) {
      cspViolations += 1
      return
    }
    if (level >= 2) console.log(`[renderer] ${message}`)
  })
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
        marks: Array.prototype.reduce.call(document.querySelectorAll('.panel-chart'), (total, host) => total + Number(host.dataset.marks || 0), 0),
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
    if (!host || !host.__benchChart || host.__benchChart.marks().length === 0) {
      return JSON.stringify({ skipped: 'no chart panel on screen' })
    }
    const svg = host.querySelector('svg.layer-under')
    const label = host.closest('.panel').querySelector('.zoom')
    const at = (element) => {
      const box = element.getBoundingClientRect()
      return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) }
    }
    const first = host.__benchChart.marks()[0]

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
    const marks = host.__benchChart.marks()
    const target = marks[Math.floor(marks.length / 2)]
    host.dispatchEvent(new PointerEvent('pointermove', { clientX: target.x, clientY: target.y, bubbles: true, pointerId: 1 }))
    const tooltip = document.getElementById('tooltip')

    // The marks live on a canvas, so their existence has to be checked in pixels, not in the DOM.
    // Alignment is checked against the drawing the canvas sits on: the same box, to the pixel.
    const canvas = host.querySelector('canvas.marks')
    const canvasBox = canvas.getBoundingClientRect()
    const underBox = svg.getBoundingClientRect()
    const aligned =
      Math.abs(canvasBox.left - underBox.left) < 1 &&
      Math.abs(canvasBox.top - underBox.top) < 1 &&
      Math.abs(canvasBox.width - underBox.width) < 1 &&
      Math.abs(canvasBox.height - underBox.height) < 1
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
    let marksPainted = 0
    for (let index = 3; index < pixels.length; index += 4) if (pixels[index] > 0) marksPainted += 1

    return JSON.stringify({
      zoomLabel: zoomedLabel,
      panned: beforePan !== afterPan,
      viewBox: afterPan,
      tooltipVisible: !tooltip.hidden,
      tooltip: tooltip.textContent,
      hoveredMark: host.querySelector('svg.layer-over .hover-dot')?.getAttribute('visibility') ?? 'none',
      aligned: aligned,
      marksPainted: marksPainted,
    })
  })()`)
  console.log('[bench] interaction ' + interaction)
  const seenInteraction = JSON.parse(interaction)
  if (!seenInteraction.skipped) {
    if (!seenInteraction.aligned) throw new Error('the mark canvas does not cover the drawing')
    if (!(seenInteraction.marksPainted > 0)) throw new Error('the mark canvas painted no marks')
    if (seenInteraction.hoveredMark !== 'visible') throw new Error('hover did not draw its ring')
  }
  await new Promise((done) => setTimeout(done, 300))
  await writeFile(join(captureDir, 'app-interaction.png'), (await window.webContents.capturePage()).toPNG())

  // The canvas hides both SVG halves from the accessibility tree, so the host label is what a
  // screen reader hears. Read the tree itself: an aria-label that Chromium ignores would still be
  // in the DOM and still be useless.
  const exposed = await accessibilityImages()
  console.log('[bench] accessibility ' + JSON.stringify(exposed))
  const recipeImage = exposed.find((image) => /slope before and after the split/.test(image.name))
  if (!recipeImage) throw new Error('the recipe panel is missing from the accessibility tree')
  if (!/x x, y y/.test(recipeImage.name)) {
    throw new Error(`the recipe panel's accessible name lost its axes: ${recipeImage.name}`)
  }
  if (!/Slope 2\.053/.test(recipeImage.name)) {
    throw new Error(`the recipe panel's accessible name lost its caption: ${recipeImage.name}`)
  }

  let frames = factors.length + 1

  // The write path, on a scratch copy so the committed fixture's log stays as it was. Switching to
  // it is a reload, because that is what opening a project does: the renderer boots against a new
  // root rather than half-rewriting its state.
  if (writableDir) {
    // Electron only delivers `sendInputEvent` to a focused window, and the entry frames are worth
    // nothing if they were driven by calling the handler directly. So the window is shown here, for
    // these two frames only: it is the same window a person types into.
    setNextStartup(writableDir)
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
    await window.webContents.executeJavaScript(
      "document.querySelectorAll('#entry-fields input').forEach((input) => { input.value = '' })",
    )
    await runCli(['add', '--x', '7.2', '--y', '8.4'])
    // A child process can take the focus on Windows; without it the entry frame would be synthetic.
    if (!(await focusWindowForInput())) throw new Error('the window never took focus back')
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
      const mark = host && host.__benchChart && host.__benchChart.marks()[0]
      if (!mark) return null
      const at = { clientX: mark.x, clientY: mark.y }
      for (const type of ['pointerdown', 'pointerup']) {
        host.dispatchEvent(
          new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, ...at }),
        )
      }
      return mark.id
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
        JSON.stringify({ id: selected, values: strip.typed, status: strip.status }),
    )
    if (!strip.correcting) throw new Error('clicking a mark did not open the correction strip')
    if (strip.typed.x === '' || strip.typed.y === '') {
      throw new Error('the correction strip was not prefilled from the log')
    }
    // The correction row adds a line to a strip that already holds fields, a button and a readout.
    // Overflow here would clip the record id, which is the one thing the row exists to name.
    const overflowX = await window.webContents.executeJavaScript(`(() => {
      const label = document.getElementById('entry-correct-label')
      return label.scrollWidth - Math.round(label.getBoundingClientRect().width)
    })()`)
    console.log('[bench] correction-overflow ' + overflowX + 'px')
    if (overflowX > 1) throw new Error(`the correction row overflows by ${overflowX}px`)

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
    setNextStartup(tabProject)
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

    // The first tab is created before any point, so the empty panel is part of the first-run proof:
    // axes named from the shape, n = 0, and the core's own sentence for how to add one.
    await window.webContents.executeJavaScript("document.getElementById('new-tab').click()")
    await sleep(300)
    await window.webContents.executeJavaScript(`(() => {
      const set = (id, value, event) => {
        const element = document.getElementById(id)
        element.value = value
        element.dispatchEvent(new Event(event, { bubbles: true }))
      }
      set('tab-name', 'first tab', 'input')
      set('tab-dataset', 'main', 'change')
      set('tab-panel', 'plot', 'change')
      document.getElementById('tab-x-field').value = 'mass'
      document.getElementById('tab-y-field').value = 'extension'
      return true
    })()`)
    await sleep(300)
    await window.webContents.executeJavaScript("document.getElementById('tab-create').click()")
    const customViewPath = join(newProject, 'views', 'first-tab.json')
    let customView = null
    for (let waited = 0; waited < 100; waited += 1) {
      const state = JSON.parse(await entryState())
      try {
        customView = JSON.parse(await readFile(customViewPath, 'utf8'))
      } catch {
        // The tab is written by the core; the next poll reads it.
      }
      if (customView && /^Created tab/.test(state.status || '')) break
      const failed = await window.webContents.executeJavaScript(
        "(() => { const e = document.getElementById('tab-error'); return e.hidden ? null : e.textContent })()",
      )
      if (failed) throw new Error('the empty custom-axis tab was refused: ' + failed)
      await sleep(100)
    }
    if (!customView) throw new Error('the empty custom-axis tab was not saved')
    const emptyPanel = customView.panels[0]
    if (emptyPanel.chart.x.label !== 'mass' || emptyPanel.chart.y.label !== 'extension') {
      throw new Error('the empty tab lost the chosen axes: ' + JSON.stringify(emptyPanel.chart))
    }
    if (emptyPanel.n !== 0) throw new Error(`the empty tab should hold no points, not ${emptyPanel.n}`)
    const emptyState = JSON.parse(await entryState())
    console.log('[bench] empty-tab ' + JSON.stringify({ status: emptyState.status, readout: emptyState.readout, axes: emptyPanel.chart.x.label + '/' + emptyPanel.chart.y.label }))
    if (!/n = 0/.test(emptyState.readout || '')) throw new Error('the empty-tab readout is not n = 0: ' + emptyState.readout)
    if (emptyState.marks !== 0) throw new Error(`the empty tab drew ${emptyState.marks} marks`)
    for (const [label, factor] of [['100', 1], ['125', 1.25], ['150', 1.5]]) {
      window.webContents.setZoomFactor(factor)
      await sleep(600)
      await writeFile(join(captureDir, `app-empty-tab-${label}.png`), (await window.webContents.capturePage()).toPNG())
      frames += 1
    }
    window.webContents.setZoomFactor(1)
    await sleep(400)

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

    // A tab whose axes are not x/y, driven through the same bar: the custom shape's fields have to
    // reach the tab dialog, the drawing, the readout and the saved file without any of them assuming
    // the historical pair. This is the one surface the default fixture cannot exercise.
    customView = JSON.parse(await readFile(customViewPath, 'utf8'))
    const customPanel = customView.panels[0]
    if (customPanel.chart.x.label !== 'mass' || customPanel.chart.y.label !== 'extension') {
      throw new Error('the saved tab lost the chosen axes: ' + JSON.stringify(customPanel.chart.x) + ' ' + JSON.stringify(customPanel.chart.y))
    }
    if (customPanel.n !== 1) throw new Error(`the saved tab should hold one point, not ${customPanel.n}`)
    const customBefore = JSON.parse(await entryState())
    console.log('[bench] custom-axis ' + JSON.stringify({ status: customBefore.status, readout: customBefore.readout, meta: customBefore.meta, marks: customBefore.marks, axes: customPanel.chart.x.label + '/' + customPanel.chart.y.label }))
    if (!/n = 1/.test(customBefore.readout)) throw new Error('the custom-axis readout is not n = 1: ' + customBefore.readout)
    if (customBefore.marks !== 1) throw new Error(`the custom-axis chart drew ${customBefore.marks} marks instead of one`)

    const customExposed = await accessibilityImages()
    const customImage = customExposed.find((image) => /first tab/.test(image.name))
    console.log('[bench] custom-axis-a11y ' + JSON.stringify(customExposed))
    if (!customImage) throw new Error('the custom-axis panel is missing from the accessibility tree')
    if (!/x mass, y extension/.test(customImage.name)) {
      throw new Error(`the custom-axis accessible name lost its axes: ${customImage.name}`)
    }
    if (!/n = 1/.test(customImage.name)) {
      throw new Error(`the custom-axis accessible name lost its count: ${customImage.name}`)
    }

    if (!(await focusWindowForInput())) throw new Error('the window never took focus for the custom-axis point')
    await focusField(0)
    typeText('2.6')
    await focusField(1)
    typeText('12.2')
    pressEnter()
    let customPatched = customBefore
    for (let waited = 0; waited < 60; waited += 1) {
      customPatched = JSON.parse(await entryState())
      if (customPatched.marks === 2 && /n = 2/.test(customPatched.readout || '')) break
      await sleep(100)
    }
    console.log('[bench] custom-axis-patch ' + JSON.stringify({ readout: customPatched.readout, marks: customPatched.marks, timing: customPatched.timing }))
    if (customPatched.marks !== 2) throw new Error(`the incremental custom-axis point drew ${customPatched.marks} marks`)
    if (!/n = 2/.test(customPatched.readout || '')) throw new Error('the custom-axis readout did not reach n = 2: ' + customPatched.readout)
    for (let waited = 0; waited < 100; waited += 1) {
      const saved = JSON.parse(await readFile(customViewPath, 'utf8'))
      if (saved.panels[0].n === 2) break
      if (waited === 99) throw new Error('the saved custom-axis tab never caught up to two points')
      await sleep(100)
    }

    if (!(await focusWindowForInput())) throw new Error('the window never took focus for the redraw')
    await focusField(0)
    typeText('1000')
    await focusField(1)
    typeText('5000')
    pressEnter()
    let customRedrawn = customPatched
    for (let waited = 0; waited < 80; waited += 1) {
      customRedrawn = JSON.parse(await entryState())
      if (customRedrawn.marks === 3 && /n = 3/.test(customRedrawn.readout || '')) break
      await sleep(100)
    }
    console.log('[bench] custom-axis-redraw ' + JSON.stringify({ readout: customRedrawn.readout, marks: customRedrawn.marks, timing: customRedrawn.timing }))
    if (customRedrawn.marks !== 3) throw new Error(`the redrawn custom-axis chart drew ${customRedrawn.marks} marks`)
    if (!/n = 3/.test(customRedrawn.readout || '')) throw new Error('the custom-axis readout did not reach n = 3: ' + customRedrawn.readout)
    const redrawnView = JSON.parse(await readFile(customViewPath, 'utf8'))
    if (redrawnView.panels[0].chart.x.label !== 'mass' || redrawnView.panels[0].chart.y.label !== 'extension') {
      throw new Error('the redraw changed the custom axes')
    }
    if (redrawnView.panels[0].n !== 3) throw new Error(`the saved custom-axis tab holds ${redrawnView.panels[0].n} points`)
    const redrawnExposed = await accessibilityImages()
    const redrawnImage = redrawnExposed.find((image) => /first tab/.test(image.name))
    if (!redrawnImage || !/x mass, y extension/.test(redrawnImage.name)) {
      throw new Error('the redrawn custom-axis panel lost its axes: ' + JSON.stringify(redrawnExposed))
    }
    await writeFile(join(captureDir, 'app-custom-axis.png'), (await window.webContents.capturePage()).toPNG())
    frames += 1

    // A tab that is open while an agent writes. Nothing is typed after the CLI runs, so the frame can
    // only change if the window noticed the log move by itself: the watcher, a reload, a redraw.
    const liveProject = join(dirname(writableDir), 'live-fixture')
    await cp(startupDir, liveProject, { recursive: true })
    setNextStartup(liveProject)
    window.webContents.reload()
    await new Promise((done) => ipcMain.once('bench:ready', done))
    if (!(await focusWindowForInput())) throw new Error('the window never took focus for the live frame')
    await sleep(700)

    const liveBefore = JSON.parse(await entryState())
    // Half a number, deliberately unfinished: the redraw must not clear it or move the cursor.
    await focusField(0)
    typeText('4')
    await runCli(['add', '--x', '8.1', '--y', '9.9'], liveProject)

    let live = liveBefore
    for (let waited = 0; waited < 60; waited += 1) {
      live = JSON.parse(await entryState())
      if (live.marks > liveBefore.marks && /n = 15/.test(live.readout || '')) break
      await sleep(100)
    }
    const liveFocus = await window.webContents.executeJavaScript(
      "document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.field : null",
    )
    console.log(
      '[bench] live ' +
        JSON.stringify({
          readout: live.readout,
          marks: live.marks,
          typed: live.typed,
          focused: liveFocus,
          status: live.status,
        }),
    )
    if (!/n = 15/.test(live.readout || '')) {
      throw new Error(`an idle window did not take the CLI's point: "${live.readout}"`)
    }
    if (live.marks <= liveBefore.marks) throw new Error('the idle window kept the old drawing')
    if (live.typed.x !== '4') throw new Error('the live redraw lost the half-typed number')
    if (liveFocus !== 'x') throw new Error('the live redraw lost the cursor')
    if (!/reread and redrawn/.test(live.status || '')) {
      throw new Error('the bar did not say the tab was reread and redrawn')
    }
    await writeFile(join(captureDir, 'app-live.png'), (await window.webContents.capturePage()).toPNG())
    frames += 1

    // Replaced, not deleted: the same tab name now holds a different file. The window has to draw the
    // file, not the panels it cached when the tab was opened.
    await runCli(['view', 'new', 'drift over time', '--dataset', 'main', '--force'], liveProject)
    let replaced = live
    for (let waited = 0; waited < 60; waited += 1) {
      replaced = JSON.parse(await entryState())
      if (replaced.panels === 1 && replaced.marks === 15 && /reread and redrawn/.test(replaced.status || '')) break
      await sleep(100)
    }
    console.log(
      '[bench] tab-replaced ' +
        JSON.stringify({
          panels: replaced.panels,
          marks: replaced.marks,
          readout: replaced.readout,
          status: replaced.status,
        }),
    )
    if (replaced.panels !== 1) {
      throw new Error(`a replaced tab should hold one panel, the window shows ${replaced.panels}`)
    }
    if (!/reread and redrawn/.test(replaced.status || '')) {
      throw new Error('the bar did not report the replaced tab')
    }
    await writeFile(join(captureDir, 'app-tab-replaced.png'), (await window.webContents.capturePage()).toPNG())
    frames += 1

    // Deleted under the window: an honest empty state, a rail without the tab, and a bar that still
    // knows where a point would land.
    await rm(join(liveProject, 'views', 'drift-over-time.json'))
    let gone = replaced
    for (let waited = 0; waited < 60; waited += 1) {
      gone = JSON.parse(await entryState())
      if (gone.empty !== 'none' && gone.tabs === 0) break
      await sleep(100)
    }
    console.log(
      '[bench] tab-gone ' +
        JSON.stringify({
          empty: gone.empty,
          text: gone.emptyText,
          tabs: gone.tabs,
          readout: gone.readout,
          status: gone.status,
        }),
    )
    if (gone.empty === 'none') {
      throw new Error('the window kept drawing a tab whose file is gone')
    }
    if (!/This tab was removed/.test(gone.emptyText || '')) {
      throw new Error('the empty state does not say the tab was removed')
    }
    if (gone.tabs !== 0) throw new Error(`the rail still lists the deleted tab (${gone.tabs} items)`)
    if (!/removed on disk/.test(gone.status || '')) throw new Error('the bar did not say the tab was removed')
    if (!/n = 15/.test(gone.readout || '')) throw new Error(`the bar lost its target: "${gone.readout}"`)
    await writeFile(join(captureDir, 'app-tab-gone.png'), (await window.webContents.capturePage()).toPNG())
    frames += 1

    // Importing from the window. The file is the deliberately messy fixture: two comment lines, extra
    // columns, a blank row, and quoted commas. It is copied first, because the capture proves the
    // preserved original is byte-identical to what was chosen. The project already holds rows, so
    // this is a *replace*: the file becomes a new version, the rows it does not have are withdrawn,
    // and the version it replaced keeps them.
    const importProject = join(dirname(writableDir), 'import-fixture')
    await cp(startupDir, importProject, { recursive: true })
    const messySource = join(here, '..', 'fixtures', 'imports', 'lab-export.csv')
    const messyFile = join(dirname(importProject), 'lab-export.csv')
    await cp(messySource, messyFile)
    setNextStartup(importProject)
    setNextPickedFile(messyFile)
    window.webContents.reload()
    await new Promise((done) => ipcMain.once('bench:ready', done))
    if (!(await focusWindowForInput())) throw new Error('the window never took focus for the import frame')
    await sleep(700)

    const importBefore = JSON.parse(await entryState())
    // How many events the project already had, so the assertions below read only this import's rows.
    importBefore.events = (await readFile(join(importProject, 'data', 'events.jsonl'), 'utf8')).trimEnd().split('\n').length
    await window.webContents.executeJavaScript("document.getElementById('import-open').click()")
    for (let waited = 0; waited < 60; waited += 1) {
      const ready = await window.webContents.executeJavaScript(
        "(() => { const d = document.getElementById('import-dialog'); return d.open && document.querySelectorAll('#import-fields select').length === 2 })()",
      )
      if (ready) break
      await sleep(100)
    }
    const importSheet = await window.webContents.executeJavaScript(`(() => JSON.stringify({
      open: document.getElementById('import-dialog').open,
      path: document.getElementById('import-path').textContent,
      summary: document.getElementById('import-summary').textContent,
      headers: Array.prototype.map.call(document.querySelectorAll('#import-preview th'), (th) => th.textContent),
      rows: document.querySelectorAll('#import-preview tbody tr').length,
      fields: Array.prototype.map.call(document.querySelectorAll('#import-fields select'), (select) => select.dataset.field),
      mapped: Array.prototype.map.call(document.querySelectorAll('#import-fields select'), (select) => select.value),
      apply: !document.getElementById('import-apply').disabled,
    }))()`)
    const sheetState = JSON.parse(importSheet)
    console.log('[bench] import-dialog ' + importSheet)
    if (!sheetState.open || !sheetState.apply) throw new Error('the import sheet did not open with a preview')
    if (!/lab-export\.csv$/.test(sheetState.path)) throw new Error('the sheet names the wrong file: ' + sheetState.path)
    if (!/5 row\(s\)/.test(sheetState.summary) || !/2 comment line\(s\) skipped/.test(sheetState.summary)) {
      throw new Error('the sheet does not report what the core read: ' + sheetState.summary)
    }
    if (!/map a column onto x, y/.test(sheetState.summary)) {
      throw new Error('the sheet did not name the fields that need a column: ' + sheetState.summary)
    }
    if (sheetState.headers.join(',') !== 'timestamp,temp_c,volts,note,operator') {
      throw new Error('the preview headers are wrong: ' + sheetState.headers.join(','))
    }

    // Nothing is mapped yet, so the first click is a refusal, not a write.
    await window.webContents.executeJavaScript("document.getElementById('import-apply').click()")
    for (let waited = 0; waited < 40; waited += 1) {
      const refused = await window.webContents.executeJavaScript(
        "(() => { const e = document.getElementById('import-error'); return e.hidden ? null : e.textContent })()",
      )
      if (refused) break
      await sleep(100)
    }
    const importRefusal = await window.webContents.executeJavaScript(
      "(() => { const e = document.getElementById('import-error'); return JSON.stringify({ hidden: e.hidden, text: e.textContent }) })()",
    )
    console.log('[bench] import-refused ' + importRefusal)
    const refusal = JSON.parse(importRefusal)
    if (refusal.hidden || !/no column for the required field/.test(refusal.text)) {
      throw new Error('the unmapped import was not refused in the sheet')
    }

    // Map the two required fields the way a person would: pick each column, then import.
    await window.webContents.executeJavaScript(`(() => {
      const set = (field, column) => {
        const select = document.querySelector('#import-fields select[data-field="' + field + '"]')
        select.value = column
        select.dispatchEvent(new Event('change', { bubbles: true }))
      }
      set('x', 'temp_c')
      set('y', 'volts')
      return true
    })()`)
    await sleep(200)
    const mapped = await window.webContents.executeJavaScript(`(() => JSON.stringify({
      mapped: Array.prototype.map.call(document.querySelectorAll('#import-fields select'), (select) => select.value),
      error: document.getElementById('import-error').hidden ? null : document.getElementById('import-error').textContent,
    }))()`)
    console.log('[bench] import-mapped ' + mapped)
    if (JSON.parse(mapped).mapped.join(',') !== 'temp_c,volts') {
      throw new Error('the mapping selects did not take: ' + mapped)
    }
    if (JSON.parse(mapped).error !== null) {
      throw new Error('the refusal stayed on screen after the mapping changed: ' + mapped)
    }
    if (!(await acknowledgeExtraColumns())) {
      throw new Error('the sheet did not ask what to do with the undeclared columns')
    }

    // What the sheet says the button will do, worked out from the mapping and written nowhere. This
    // is the line the frame is about: which version this becomes, and which rows leave the dataset.
    const sheetPlan = await window.webContents.executeJavaScript(
      "(() => document.getElementById('import-plan').textContent)()",
    )
    console.log('[bench] import-plan ' + JSON.stringify(sheetPlan))
    if (!/version 3 replaces version 2 · \+5 −14 ~0/.test(sheetPlan)) {
      throw new Error('the sheet did not name the version it would create: ' + sheetPlan)
    }
    if (!/14 row\(s\) not in this file are withdrawn/.test(sheetPlan)) {
      throw new Error('the sheet did not say which rows leave: ' + sheetPlan)
    }

    // The frame the verdict is about: the sheet with a real mapping on it, before anything is
    // written. Captured after the import the dialog is gone, which is a screenshot of the wrong state.
    // `capturePage` reads the window's compositor, which can hand back its previous surface when a
    // modal sheet opens; the renderer's own screenshot is the page as it is now.
    await writeFile(join(captureDir, 'app-import.png'), await rendererScreenshot())
    frames += 1

    await window.webContents.executeJavaScript("document.getElementById('import-apply').click()")
    for (let waited = 0; waited < 100; waited += 1) {
      const state = JSON.parse(await entryState())
      if (/^Imported 5 row/.test(state.status || '')) break
      const failed = await window.webContents.executeJavaScript(
        "(() => { const e = document.getElementById('import-error'); return e.hidden ? null : e.textContent })()",
      )
      if (failed) throw new Error('the import was refused: ' + failed)
      await sleep(100)
    }
    await sleep(500)
    const importedState = JSON.parse(await entryState())
    const importLog = (await readFile(join(importProject, 'data', 'events.jsonl'), 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line))
    // Only what this import appended: the fixture itself was built with an import of its own.
    const appended = importLog.slice(importBefore.events)
    const recorded = appended.filter((event) => event.type === 'import_completed')
    const importedPoints = appended.filter((event) => event.type === 'point_recorded')
    const withdrawn = appended.filter((event) => event.type === 'point_retracted')
    const versionRecord = appended.find((event) => event.type === 'dataset_version_created')
    const preserved = recorded[0] ? recorded[0].file : null
    const preservedText = preserved ? await readFile(join(importProject, preserved), 'utf8') : ''
    const chosenText = await readFile(messyFile, 'utf8')
    console.log(
      '[bench] imported ' +
        JSON.stringify({
          status: importedState.status,
          readout: importedState.readout,
          marks: importedState.marks,
          before: importBefore.marks,
          closed: importedState.importClosed,
          meta: importedState.meta,
          points: importedPoints.length,
          withdrawn: withdrawn.length,
          version: versionRecord
            ? {
                version: versionRecord.version,
                parent: versionRecord.parent,
                rows: versionRecord.rows,
                diff: versionRecord.diff,
                source: versionRecord.source,
              }
            : null,
          record: recorded[0]
            ? { rows: recorded[0].rows, file: recorded[0].file, mapping: recorded[0].mapping }
            : null,
          first: importedPoints[0] ? importedPoints[0].values : null,
          identical: preservedText === chosenText,
        }),
    )
    if (!/^Imported 5 row\(s\) into main as version 3 \(\+5 −14 ~0, replacing version 2\)/.test(importedState.status || '')) {
      throw new Error('the bar did not report the version the import created: ' + importedState.status)
    }
    if (!/14 row\(s\) not in the file were withdrawn from version 3; version 2 still holds them/.test(importedState.status || '')) {
      throw new Error('the bar did not account for the rows that left: ' + importedState.status)
    }
    if (!importedState.importClosed) throw new Error('the import sheet stayed open after a successful import')
    if (!/n = 5/.test(importedState.readout || '')) {
      throw new Error(`the bar should read n = 5, it reads "${importedState.readout}"`)
    }
    if (importedPoints.length !== 5 || recorded.length !== 1 || withdrawn.length !== 14) {
      throw new Error(
        `the log holds ${importedPoints.length} new points, ${withdrawn.length} withdrawals and ${recorded.length} records`,
      )
    }
    if (!versionRecord || versionRecord.version !== 3 || versionRecord.parent !== 2) {
      throw new Error('the log does not record version 3 replacing version 2: ' + JSON.stringify(versionRecord))
    }
    if (JSON.stringify(versionRecord.diff) !== JSON.stringify({ added: 5, removed: 14, changed: 0 })) {
      throw new Error('the recorded diff is not what the sheet promised: ' + JSON.stringify(versionRecord.diff))
    }
    // Every row of this version is tagged with it, and every withdrawal says where it happened: that
    // is what keeps version 2 readable exactly as it was.
    if (importedPoints.some((event) => event.version !== 3) || withdrawn.some((event) => event.version !== 3)) {
      throw new Error('a row or withdrawal does not name its version')
    }
    if (!preserved || preservedText !== chosenText) {
      throw new Error('the preserved original is not the file that was chosen')
    }
    if (!/^data\/raw\//.test(preserved)) throw new Error('the original was not kept under data/raw: ' + preserved)
    const importMapping = recorded[0].mapping || {}
    if (importMapping.x !== 'temp_c' || importMapping.y !== 'volts') {
      throw new Error('the log recorded a different mapping than the sheet showed: ' + JSON.stringify(importMapping))
    }
    if (importMapping.t_observed !== undefined) {
      throw new Error('the log has a field the shape does not: ' + JSON.stringify(importMapping))
    }
    // The timestamp column was picked up by name, not mapped to a field: the first point proves it.
    const firstImported = importedPoints[0]
    if (!firstImported || firstImported.t_observed !== '2026-01-05T09:00:00.000Z') {
      throw new Error('the first point did not take its time from the timestamp column: ' + JSON.stringify(firstImported))
    }

    // The workflow this whole feature exists for: the instrument re-exported a corrected file, and it
    // goes through the same sheet. One reading corrected, one added, two dropped.
    const correctedFile = join(dirname(importProject), 'lab-export-v2.csv')
    await cp(join(here, '..', 'fixtures', 'imports', 'lab-export-v2.csv'), correctedFile)
    const eventsBeforeCorrection = importLog.length
    setNextPickedFile(correctedFile)
    await window.webContents.executeJavaScript("document.getElementById('import-open').click()")
    for (let waited = 0; waited < 60; waited += 1) {
      const ready = await window.webContents.executeJavaScript(
        "(() => document.getElementById('import-dialog').open && /lab-export-v2\\.csv$/.test(document.getElementById('import-path').textContent) && document.querySelectorAll('#import-fields select').length === 2)()",
      )
      if (ready) break
      await sleep(100)
    }
    await window.webContents.executeJavaScript(`(() => {
      const set = (field, column) => {
        const select = document.querySelector('#import-fields select[data-field="' + field + '"]')
        select.value = column
        select.dispatchEvent(new Event('change', { bubbles: true }))
      }
      set('x', 'temp_c')
      set('y', 'volts')
      return true
    })()`)
    await sleep(400)
    if (!(await acknowledgeExtraColumns())) throw new Error('the re-export sheet did not offer the extra columns')
    const correctionPlan = await window.webContents.executeJavaScript(
      "(() => document.getElementById('import-plan').textContent)()",
    )
    console.log('[bench] import-plan-v2 ' + JSON.stringify(correctionPlan))
    if (!/version 4 replaces version 3 · \+1 −2 ~1/.test(correctionPlan)) {
      throw new Error('the corrected re-export was not planned as version 4: ' + correctionPlan)
    }
    await window.webContents.executeJavaScript("document.getElementById('import-apply').click()")
    for (let waited = 0; waited < 100; waited += 1) {
      const state = JSON.parse(await entryState())
      if (/^Imported 4 row/.test(state.status || '')) break
      const failed = await window.webContents.executeJavaScript(
        "(() => { const e = document.getElementById('import-error'); return e.hidden ? null : e.textContent })()",
      )
      if (failed) throw new Error('the corrected re-export was refused: ' + failed)
      await sleep(100)
    }
    await sleep(500)
    const reExportedState = JSON.parse(await entryState())
    const stripAfterReExport = await window.webContents.executeJavaScript(
      "(() => document.getElementById('view-meta').textContent)()",
    )
    console.log('[bench] re-exported ' + JSON.stringify({
      status: reExportedState.status,
      readout: reExportedState.readout,
      strip: stripAfterReExport,
    }))
    if (!/as version 4 \(\+1 −2 ~1, replacing version 3\)/.test(reExportedState.status || '')) {
      throw new Error('the corrected re-export was not reported as version 4: ' + reExportedState.status)
    }
    if (!/2 row\(s\) not in the file were withdrawn from version 4; version 3 still holds them/.test(reExportedState.status || '')) {
      throw new Error('the corrected re-export did not account for what left: ' + reExportedState.status)
    }
    if (!/n = 4/.test(reExportedState.readout || '')) {
      throw new Error(`the corrected re-export should leave n = 4, it reads "${reExportedState.readout}"`)
    }
    // The strip names every version on the tab: the plot panel was refreshed to v4 by the import,
    // while the recipe panel stayed at v2 because the window will not rerun it here. Saying only
    // `v2` would hide the panel that is current; saying only `v4` would hide the one that is not.
    if (!/main · v2, v4/.test(stripAfterReExport)) {
      throw new Error(
        'the strip does not name every version the tab was drawn from: ' + stripAfterReExport,
      )
    }
    await writeFile(join(captureDir, 'app-version-diff.png'), (await window.webContents.capturePage()).toPNG())
    frames += 1

    // The same log read back through the other door: if the CLI and the window disagreed about what
    // version 3 holds, one of them would be inventing an answer.
    const cliVersions = await readCli(['dataset', 'versions', 'main'], importProject)
    const cliDiff = await readCli(['dataset', 'diff', 'main', '3', '4'], importProject)
    console.log('[bench] cli-versions ' + JSON.stringify(cliVersions.trim().split('\n')))
    console.log('[bench] cli-diff ' + JSON.stringify(cliDiff.trim().split('\n')))
    if (!/v2  14 row\(s\) now · 14 at creation/.test(cliVersions)) {
      throw new Error('the CLI does not see the version the window imported:\n' + cliVersions)
    }
    if (!/v3  5 row\(s\) now · 5 at creation  \+5 −14 ~0/.test(cliVersions)) {
      throw new Error('the version the window wrote does not match what the CLI reads:\n' + cliVersions)
    }
    if (!/v4  4 row\(s\) now · 4 at creation  \+1 −2 ~1/.test(cliVersions)) {
      throw new Error('the corrected re-export is not in the chain the CLI reads:\n' + cliVersions)
    }
    if (!/main: version 3 → 4  \+1 −2 ~1  \(4 row\(s\) in v4\)/.test(cliDiff)) {
      throw new Error('the CLI diff of the window\'s own versions is wrong:\n' + cliDiff)
    }
    // The parent is untouched: version 2's rows are still there, and the CLI can still read them.
    const cliParent = await readCli(['dataset', 'diff', 'main', '2', '3'], importProject)
    if (!/\+5 −14 ~0/.test(cliParent) || !/x 1  y 2\.92/.test(cliParent)) {
      throw new Error('the parent version no longer describes what it held:\n' + cliParent)
    }
    // One version record, one row added, one corrected, two withdrawn, one import record.
    const eventsAfterCorrection = (await readFile(join(importProject, 'data', 'events.jsonl'), 'utf8'))
      .trimEnd()
      .split('\n')
      .length
    if (eventsAfterCorrection - eventsBeforeCorrection !== 6) {
      throw new Error(
        `the corrected re-export appended ${eventsAfterCorrection - eventsBeforeCorrection} events, not 6`,
      )
    }

    // The other refusal, through the same sheet: one cell mistyped, so the whole file is refused and
    // the log is left exactly as the good import left it.
    const badFile = join(dirname(importProject), 'lab-export-bad-row.csv')
    await cp(join(here, '..', 'fixtures', 'imports', 'lab-export-bad-row.csv'), badFile)
    setNextPickedFile(badFile)
    await window.webContents.executeJavaScript("document.getElementById('import-open').click()")
    for (let waited = 0; waited < 60; waited += 1) {
      const ready = await window.webContents.executeJavaScript(
        "(() => document.getElementById('import-dialog').open && /lab-export-bad-row\\.csv$/.test(document.getElementById('import-path').textContent) && document.querySelectorAll('#import-fields select').length === 2)()",
      )
      if (ready) break
      await sleep(100)
    }
    await window.webContents.executeJavaScript(`(() => {
      const set = (field, column) => {
        const select = document.querySelector('#import-fields select[data-field="' + field + '"]')
        select.value = column
        select.dispatchEvent(new Event('change', { bubbles: true }))
      }
      set('x', 'temp_c')
      set('y', 'volts')
      return true
    })()`)
    await sleep(300)
    await acknowledgeExtraColumns()
    await window.webContents.executeJavaScript("document.getElementById('import-apply').click()")
    for (let waited = 0; waited < 60; waited += 1) {
      const shown = await window.webContents.executeJavaScript(
        "(() => { const e = document.getElementById('import-error'); return e.hidden ? null : e.textContent })()",
      )
      if (shown) break
      await sleep(100)
    }
    const badRow = await window.webContents.executeJavaScript(`(() => JSON.stringify({
      error: document.getElementById('import-error').hidden ? null : document.getElementById('import-error').textContent,
      open: document.getElementById('import-dialog').open,
      status: document.getElementById('entry-status').textContent,
    }))()`)
    console.log('[bench] import-bad-row ' + badRow)
    const badRowState = JSON.parse(badRow)
    if (!/row 3/.test(badRowState.error || '') || !/twenty-one/.test(badRowState.error || '')) {
      throw new Error('the bad row was not named in the sheet: ' + badRow)
    }
    if (!/so none were/.test(badRowState.error || '')) {
      throw new Error('the refusal does not say the whole file was refused: ' + badRow)
    }
    if (!badRowState.open) throw new Error('the sheet closed on a refusal, taking the mapping with it')
    const afterRefusal = JSON.parse(await entryState())
    const logAfterRefusal = (await readFile(join(importProject, 'data', 'events.jsonl'), 'utf8')).trimEnd().split('\n')
    // Against the drawing the corrected re-export left, not the first import's: the frame this
    // refusal has to leave alone is the one on screen now.
    if (afterRefusal.marks !== reExportedState.marks) {
      throw new Error(`the refused file changed the drawing: ${reExportedState.marks} -> ${afterRefusal.marks}`)
    }
    if (logAfterRefusal.length !== eventsAfterCorrection) {
      throw new Error(`the refused file appended ${logAfterRefusal.length - eventsAfterCorrection} event(s)`)
    }
    await window.webContents.executeJavaScript("document.getElementById('import-cancel').click()")

    // A file with no clock at all. A row is its instant, so the sheet must not let the core stamp
    // one invented instant on every row and then call the result a diff.
    const currentRows = JSON.parse(await readCli(['list', '--json'], importProject)).data
    const untimedFile = join(dirname(importProject), 'lab-export-untimed.csv')
    await writeFile(
      untimedFile,
      'x,y\n' + currentRows.map((point) => `${point.values.x},${point.values.y}`).join('\n') + '\n',
    )
    setNextPickedFile(untimedFile)
    await window.webContents.executeJavaScript("document.getElementById('import-open').click()")
    for (let waited = 0; waited < 60; waited += 1) {
      const ready = await window.webContents.executeJavaScript(
        "(() => { const d = document.getElementById('import-dialog'); const times = Array.prototype.map.call(document.getElementById('import-time').options, (option) => option.value); return d.open && /lab-export-untimed\.csv$/.test(document.getElementById('import-path').textContent) && times.join(',') === ',x,y' })()",
      )
      if (ready) break
      await sleep(100)
    }
    await sleep(300)
    const untimedSheet = JSON.parse(await window.webContents.executeJavaScript(`(() => JSON.stringify({
      time: document.getElementById('import-time').value,
      columns: Array.prototype.map.call(document.getElementById('import-time').options, (option) => option.value),
      plan: document.getElementById('import-plan').textContent,
      planClass: document.getElementById('import-plan').className,
    }))()`))
    console.log('[bench] import-untimed ' + JSON.stringify(untimedSheet))
    if (untimedSheet.time !== '') throw new Error('the sheet selected a time column that is not there')
    if (!/choose the column that holds the observation time/.test(untimedSheet.plan)) {
      throw new Error('the sheet did not ask for the time column: ' + untimedSheet.plan)
    }
    if (!/is-error/.test(untimedSheet.planClass)) {
      throw new Error('the missing time column was not shown as a refusal: ' + untimedSheet.planClass)
    }
    await writeFile(join(captureDir, 'app-import-untimed.png'), (await window.webContents.capturePage()).toPNG())
    frames += 1
    await window.webContents.executeJavaScript("document.getElementById('import-apply').click()")
    for (let waited = 0; waited < 60; waited += 1) {
      const shown = await window.webContents.executeJavaScript(
        "(() => { const e = document.getElementById('import-error'); return e.hidden ? null : e.textContent })()",
      )
      if (shown) break
      await sleep(100)
    }
    const untimedRefusal = await window.webContents.executeJavaScript(
      "(() => document.getElementById('import-error').hidden ? null : document.getElementById('import-error').textContent)()",
    )
    console.log('[bench] import-untimed-refusal ' + JSON.stringify(untimedRefusal))
    if (!/no column holds the observation time/.test(untimedRefusal || '')) {
      throw new Error('the untimed file was not refused by the core: ' + untimedRefusal)
    }
    if (!/x, y/.test(untimedRefusal || '')) {
      throw new Error('the refusal did not name the columns it could have meant: ' + untimedRefusal)
    }
    const logAfterUntimed = (await readFile(join(importProject, 'data', 'events.jsonl'), 'utf8')).trimEnd().split('\n')
    if (logAfterUntimed.length !== eventsAfterCorrection) {
      throw new Error(`the untimed file appended ${logAfterUntimed.length - eventsAfterCorrection} event(s)`)
    }
    await window.webContents.executeJavaScript("document.getElementById('import-cancel').click()")
    await sleep(300)

    // The clock under a name bench does not guess. The sheet's picker is the only place that can say
    // it, and the diff is computed against the version the file actually shares rows with.
    const namedFile = join(dirname(importProject), 'lab-export-taken-at.csv')
    await writeFile(
      namedFile,
      'taken_at,x,y\n' +
        currentRows.map((point) => `${point.t_observed},${point.values.x},${point.values.y}`).join('\n') +
        '\n2026-10-16T09:00:00Z,6,13.4\n',
    )
    setNextPickedFile(namedFile)
    await window.webContents.executeJavaScript("document.getElementById('import-open').click()")
    for (let waited = 0; waited < 60; waited += 1) {
      const ready = await window.webContents.executeJavaScript(
        "(() => { const d = document.getElementById('import-dialog'); const select = document.getElementById('import-time'); return d.open && /lab-export-taken-at\.csv$/.test(document.getElementById('import-path').textContent) && Array.prototype.some.call(select.options, (option) => option.value === 'taken_at') })()",
      )
      if (ready) break
      await sleep(100)
    }
    const namedSheet = JSON.parse(await window.webContents.executeJavaScript(`(() => JSON.stringify({
      open: document.getElementById('import-dialog').open,
      path: document.getElementById('import-path').textContent,
      columns: Array.prototype.map.call(document.getElementById('import-time').options, (option) => option.value),
    }))()`))
    if (!namedSheet.open || !/lab-export-taken-at\.csv$/.test(namedSheet.path)) {
      throw new Error('the named-time file did not reach the sheet: ' + JSON.stringify(namedSheet))
    }
    await window.webContents.executeJavaScript(`(() => {
      const select = document.getElementById('import-time')
      if (!Array.prototype.some.call(select.options, (option) => option.value === 'taken_at')) {
        throw new Error('the time picker does not offer taken_at')
      }
      select.value = 'taken_at'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    })()`)
    await sleep(500)
    const namedPlan = await window.webContents.executeJavaScript(
      "(() => document.getElementById('import-plan').textContent)()",
    )
    console.log('[bench] import-named-time ' + JSON.stringify(namedPlan))
    if (!/version 5 replaces version 4 · \+1 −0 ~0/.test(namedPlan)) {
      throw new Error('the named time column was not planned as a correct version: ' + namedPlan)
    }
    await writeFile(join(captureDir, 'app-import-time.png'), (await window.webContents.capturePage()).toPNG())
    frames += 1
    await window.webContents.executeJavaScript("document.getElementById('import-apply').click()")
    for (let waited = 0; waited < 100; waited += 1) {
      const state = JSON.parse(await entryState())
      if (/^Imported 5 row/.test(state.status || '')) break
      await sleep(100)
    }
    const namedState = JSON.parse(await entryState())
    console.log(
      '[bench] import-named-time-result ' +
        JSON.stringify({ status: namedState.status, readout: namedState.readout }),
    )
    if (!/as version 5 \(\+1 −0 ~0, replacing version 4\)/.test(namedState.status || '')) {
      throw new Error('the named time column was not imported as version 5: ' + namedState.status)
    }
    const namedVersions = await readCli(['dataset', 'versions', 'main'], importProject)
    const namedDiff = await readCli(['dataset', 'diff', 'main', '4', '5'], importProject)
    console.log('[bench] import-named-time-cli ' + JSON.stringify(namedVersions.trim().split('\n')))
    if (!/v5  5 row\(s\) now · 5 at creation  \+1 −0 ~0/.test(namedVersions)) {
      throw new Error('the CLI does not see the window\'s timed import:\n' + namedVersions)
    }
    if (!/main: version 4 → 5  \+1 −0 ~0/.test(namedDiff) || !/2026-10-16T09:00:00\.000Z/.test(namedDiff)) {
      throw new Error('the CLI diff does not name the added instant:\n' + namedDiff)
    }

    // A tab whose panels were drawn from different versions. A refresh repins only the panels it
    // redraws, so this is a state a tab reaches in normal use — the strip has to name every version
    // on it, not whichever panel happens to be first.
    const mixedProject = join(dirname(importProject), 'mixed-versions')
    await cp(startupDir, mixedProject, { recursive: true })
    await rm(join(mixedProject, 'views', 'drift-over-time.json'))
    await readCli(['view', 'new', 'mixed versions', '--dataset', 'main'], mixedProject)
    const mixedBase = JSON.parse(await readCli(['list', '--json'], mixedProject)).data
    const csvOf = (rows) =>
      't_observed,x,y\n' + rows.map((point) => `${point.t_observed},${point.values.x},${point.values.y}`).join('\n') + '\n'
    // Version 3: the tab's first panel stays pinned to 2; the second is added after this import.
    await writeFile(
      join(dirname(mixedProject), 'mixed-v3.csv'),
      csvOf(mixedBase) + '2026-10-17T09:00:00Z,9,21\n',
    )
    await readCli(['import', join(dirname(mixedProject), 'mixed-v3.csv'), '--map', 'x=x', '--map', 'y=y'], mixedProject)
    await readCli(['view', 'add', 'mixed versions', '--dataset', 'main'], mixedProject)
    // Version 4: the dataset moves past both panels, so the strip must say what is pinned and what
    // the data is at now.
    await writeFile(
      join(dirname(mixedProject), 'mixed-v4.csv'),
      csvOf(mixedBase) + '2026-10-17T09:00:00Z,9,21\n2026-10-18T09:00:00Z,10,23\n',
    )
    await readCli(['import', join(dirname(mixedProject), 'mixed-v4.csv'), '--map', 'x=x', '--map', 'y=y'], mixedProject)

    setNextStartup(mixedProject)
    window.webContents.reload()
    await new Promise((done) => ipcMain.once('bench:ready', done))
    await sleep(700)
    const mixedStrip = await window.webContents.executeJavaScript(
      "(() => document.getElementById('view-meta').textContent)()",
    )
    const mixedBadges = await window.webContents.executeJavaScript(
      "(() => JSON.stringify(Array.prototype.map.call(document.querySelectorAll('.panel-strip .badge'), (badge) => badge.textContent)))()",
    )
    console.log('[bench] mixed-versions ' + JSON.stringify({ strip: mixedStrip, badges: JSON.parse(mixedBadges) }))
    if (!/main · v2, v3 \(now v4\)/.test(mixedStrip)) {
      throw new Error('the strip does not name every version the tab was drawn from: ' + mixedStrip)
    }
    if (JSON.parse(mixedBadges).length !== 2) {
      throw new Error('the mixed tab did not paint two panels: ' + mixedBadges)
    }
    await writeFile(join(captureDir, 'app-mixed-versions.png'), (await window.webContents.capturePage()).toPNG())
    frames += 1
  }

  if (cspViolations > 0) console.log(`[bench] csp-inline-style-blocked=${cspViolations}`)
  const metrics = app.getAppMetrics()
  const memory = metrics.reduce((sum, metric) => sum + (metric.memory?.workingSetSize ?? 0), 0)
  console.log(
    `[bench] painted=${paintedMs}ms processes=${metrics.length} workingSet=${(memory / 1024).toFixed(0)}MB`,
  )
  console.log(`[bench] captured ${frames} frames in ${captureDir}`)
  app.quit()
}
