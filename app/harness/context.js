/*
 * Paths and the mutable handles the shell and its harness share.
 *
 * The shell owns the window; a capture, measure or smoke run drives the same one. Exporting the
 * handle as a live binding keeps every helper reading the window that exists now, not the one that
 * existed when the module was first imported.
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The app directory, so a helper can reach preload, renderer and the repository without guessing. */
export const here = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const startedAt = Date.now()

/** `BENCH_CAPTURE=<dir>` runs the review capture instead of an interactive window. */
export const captureDir = process.env.BENCH_CAPTURE ? resolve(process.env.BENCH_CAPTURE) : null
/** `BENCH_APP_PROJECT=<dir>` opens a project on launch, which the capture run uses. */
export const startupDir = process.env.BENCH_APP_PROJECT ? resolve(process.env.BENCH_APP_PROJECT) : null
/** `BENCH_CAPTURE_PHASE=relaunch` makes the capture the second process of the relaunch proof. */
export const capturePhase = process.env.BENCH_CAPTURE_PHASE || ''
/** `BENCH_CAPTURE_WRITABLE=<dir>` is the scratch copy the entry frames are captured against. */
export const writableDir = process.env.BENCH_CAPTURE_WRITABLE ? resolve(process.env.BENCH_CAPTURE_WRITABLE) : null
/** `BENCH_MEASURE=<n>` drives n entries and reports keystroke → painted frame. */
export const measureRuns = process.env.BENCH_MEASURE ? Number(process.env.BENCH_MEASURE) : 0
/** `BENCH_SMOKE=<dir>` is the packaged build's own proof. */
export const smokeDir = process.env.BENCH_SMOKE ? resolve(process.env.BENCH_SMOKE) : null

export let window = null
export function setWindow(value) {
  window = value
}

/** What the next renderer boot should open: changed between capture scenarios. */
export let nextStartup = startupDir
export function setNextStartup(value) {
  nextStartup = value
}

/** A file the capture run hands to the import picker, because a native dialog cannot be driven. */
export let nextPickedFile = null
export function setNextPickedFile(value) {
  nextPickedFile = value
}
