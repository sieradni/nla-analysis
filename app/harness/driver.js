/* Driving the real window: real keystrokes, real reads, and the CLI as a second door. */
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { window, here, writableDir } from './context.js'

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

export function typeText(text) {
  for (const character of text) {
    window.webContents.sendInputEvent({ type: 'char', keyCode: character })
  }
}

/**
 * Keyboard events go to a *focused* window, and Windows refuses the focus if the app is not in the
 * foreground — which is exactly the situation a measurement run starts in. So: ask, check
 * `document.hasFocus()`, and keep asking for a moment. A harness that silently typed into nowhere
 * would report a wrong number rather than an error.
 */
export async function focusWindowForInput() {
  // An always-on-top window is far harder for another application to take the focus from, which is
  // what kept happening a few entries into a run. It is cleared again when the harness is done.
  window.setAlwaysOnTop(true, 'screen-saver')
  for (let attempt = 0; attempt < 30; attempt += 1) {
    window.show()
    window.focus()
    window.webContents.focus()
    const focused = await window.webContents.executeJavaScript('document.hasFocus()').catch(() => false)
    if (focused) return true
    await sleep(100)
  }
  return false
}

/**
 * Type a value and submit, with the real keystroke path first.
 *
 * If the window cannot hold the OS focus — an automation run on a machine someone else is also
 * using — the keystrokes go nowhere. Rather than reporting a number for a submit that never
 * happened, the harness sets the fields and asks the form to submit itself, and says which samples
 * were taken that way. `pnpm app:capture` is the proof that real keystrokes reach the same handler:
 * the frames it writes were produced by typing into the bar.
 */
export async function submitEntry(x, y) {
  const before = await currentTimingId()
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // A retry must start from an empty bar. The first attempt may have typed x and then lost the
    // focus before y; appending the next x to the old one would fail forever.
    await clearEntryFields()
    await focusField(0)
    typeText(String(x))
    if ((await fieldValue('x')) === String(x)) {
      const onSecond = await focusField(1)
      if (!onSecond) pressKey('Tab')
      typeText(String(y))
      if ((await fieldValue('y')) === String(y)) {
        pressEnter()
        return { timing: await waitForTiming(before), synthetic: false }
      }
    }
    await focusWindowForInput()
  }

  const submitted = await window.webContents.executeJavaScript(`(() => {
    const set = (name, value) => {
      const input = document.querySelector('input[data-field="' + name + '"]')
      if (!input) return false
      input.value = value
      return true
    }
    if (!set('x', ${JSON.stringify(String(x))}) || !set('y', ${JSON.stringify(String(y))})) return false
    document.getElementById('entry').requestSubmit()
    return true
  })()`)
  if (!submitted) throw new Error('the entry bar is not there to submit')
  return { timing: await waitForTiming(before), synthetic: true }
}

/**
 * Type into the entry fields by position, for a shape whose fields are not x and y. Every value is
 * read back after it is typed, so a keystroke that never landed fails the run rather than being
 * submitted by setting the fields.
 */
export async function typeValues(values) {
  if (!(await focusWindowForInput())) throw new Error('the window never took focus')
  await clearEntryFields()
  for (let index = 0; index < values.length; index += 1) {
    if (!(await focusField(index))) throw new Error(`the entry bar has no field ${index + 1}`)
    typeText(String(values[index]))
    // The char events cross a different channel than `executeJavaScript`; poll for the value
    // instead of assuming the renderer applied it before the next round trip.
    let landed = ''
    for (let waited = 0; waited < 500; waited += 25) {
      landed = await window.webContents.executeJavaScript(
        `(document.querySelectorAll('#entry-fields input')[${index}] || {}).value || ''`,
      )
      if (landed === String(values[index])) break
      await sleep(25)
    }
    if (landed !== String(values[index])) {
      throw new Error(
        `typing ${values[index]} into field ${index + 1} did not land (it holds "${landed}")`,
      )
    }
  }
  const before = await currentTimingId()
  pressEnter()
  return waitForTiming(before)
}

/** Read one entry field, so a harness can tell "typed" from "not delivered". */
export function fieldValue(name) {
  return window.webContents.executeJavaScript(
    `(document.querySelector('input[data-field="${name}"]') || {}).value || ''`,
  )
}

export function pressKey(keyCode, modifiers = []) {
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
}

/**
 * Enter arrives as keyDown + char + keyUp. Chromium acts on the *char* event for a text input, so a
 * keyDown alone moves no form: the first attempt at this capture typed both fields and submitted
 * nothing at all.
 */
export function pressEnter() {
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
  window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
}

export async function focusField(index) {
  return window.webContents.executeJavaScript(`(() => {
    const inputs = document.querySelectorAll('#entry-fields input')
    if (!inputs[${index}]) return false
    inputs[${index}].focus()
    return document.activeElement === inputs[${index}]
  })()`)
}

/** Empty the bar without typing: only the submit itself has to be a real keystroke. */
export async function clearEntryFields() {
  return window.webContents.executeJavaScript(`(() => {
    const inputs = document.querySelectorAll('#entry-fields input')
    inputs.forEach((input) => {
      input.value = ''
    })
    return inputs.length > 0
  })()`)
}

/** Everything a review needs to see about the bar, read from the live DOM. */
export async function entryState() {
  return window.webContents.executeJavaScript(`(() => {
    const status = document.getElementById('entry-status')
    return JSON.stringify({
      // Keyed by field name, because a project may declare fields that are not x and y.
      typed: (() => {
        const out = {}
        document.querySelectorAll('#entry-fields input').forEach((input) => {
          out[input.dataset.field] = input.value
        })
        return out
      })(),
      badges: Array.prototype.map.call(document.querySelectorAll('.panel-strip .badge'), (b) => b.textContent),
      correcting: !document.getElementById('entry-correct').hidden,
      status: status.hidden ? null : status.textContent,
      readout: document.getElementById('entry-readout').textContent,
      meta: document.getElementById('view-meta').textContent,
      undoEnabled: !document.getElementById('entry-undo').disabled,
      timing: window.__benchTiming || null,
      marks: Array.prototype.reduce.call(document.querySelectorAll('.panel-chart'), (total, host) => total + Number(host.dataset.marks || 0), 0),
      panels: document.querySelectorAll('.panel').length,
      tabs: document.querySelectorAll('#tabs .item').length,
      importClosed: !document.getElementById('import-dialog').open,
      empty: getComputedStyle(document.getElementById('empty')).display,
      emptyText: (document.getElementById('empty').textContent || '').trim(),
    })
  })()`)
}

/** Wait for the entry the harness just drove to report its own timings. */
export async function waitForTiming(previousId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const timing = await window.webContents.executeJavaScript('window.__benchTiming || null')
    if (timing && timing.id !== previousId) return timing
    if (Date.now() > deadline) throw new Error('the entry never reported a painted frame')
    await new Promise((done) => setTimeout(done, 50))
  }
}

export async function currentTimingId() {
  return window.webContents.executeJavaScript('(window.__benchTiming && window.__benchTiming.id) || null')
}

/**
 * The real `bench` binary, as an agent in a terminal would run it. Capture-only: the window itself
 * never shells out to the CLI, because that would be a second write path (ADR 0003).
 */
export async function runCli(args, dir = writableDir) {
  const cli = join(here, '..', 'src', 'cli', 'index.ts')
  await new Promise((done, fail) => {
    // `process.execPath` here is Electron, not Node: `ELECTRON_RUN_AS_NODE` is what makes the same
    // binary behave as the runtime the CLI expects, without depending on where `node` is installed.
    const child = spawn(process.execPath, [cli, '--project', dir, ...args], {
      cwd: join(here, '..'),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'ignore',
    })
    child.on('error', fail)
    child.on('exit', (code) => (code === 0 ? done() : fail(new Error(`bench ${args[0]} exited ${code}`))))
  })
}

/**
 * Like `runCli`, but hands back what it printed. The capture uses this to read the *window's* own
 * import back through the CLI: one log, two doors, and the second door is what proves the first one
 * wrote what it said it did.
 */
export async function readCli(args, dir = writableDir) {
  const cli = join(here, '..', 'src', 'cli', 'index.ts')
  return await new Promise((done, fail) => {
    const child = spawn(process.execPath, [cli, '--project', dir, ...args], {
      cwd: join(here, '..'),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => (out += chunk))
    child.stderr.on('data', (chunk) => (err += chunk))
    child.on('error', fail)
    child.on('exit', (code) =>
      code === 0 ? done(out) : fail(new Error(`bench ${args.join(' ')} exited ${code}: ${err.trim()}`)),
    )
  })
}

/** The capture run's entry: real keystrokes, and loudly wrong if they do not land. */
export async function enterPoint(x, y) {
  // A previous step may have handed the foreground away (a spawned CLI, the shell itself). Ask for
  // it again here rather than reporting a keystroke that never landed.
  if (!(await focusWindowForInput())) throw new Error('the window never took focus')
  const { timing, synthetic } = await submitEntry(x, y)
  if (synthetic) throw new Error('the capture could not type into the window (no focus)')
  return timing
}
