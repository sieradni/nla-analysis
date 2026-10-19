import { watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'

/**
 * Watch a project's log and tabs, and call `onChange` once per burst of filesystem events.
 *
 * An agent's append touches `data/events.jsonl`; a tab written or replaced touches
 * `views/<slug>.json`. Both arrive as one callback after `debounceMs` of quiet, because the window
 * redraws a whole tab and has nothing useful to do with three events describing one act.
 *
 * An event is a hint, not the truth: it only makes the window ask whether the files it drew from
 * have moved (see `reloadTab`). A missed event costs one stale frame until the next one; a spurious
 * event costs a `stat` and nothing else. Returned is the stop function; calling it closes every
 * watcher and drops a pending callback.
 */
export function watchProject(dir: string, onChange: () => void, debounceMs = 150): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const watchers: FSWatcher[] = []

  const fire = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      onChange()
    }, debounceMs)
  }

  for (const child of ['data', 'views']) {
    try {
      const watcher = watch(join(dir, child), fire)
      // A directory that disappears under the window ends this watcher instead of crashing the
      // shell; the window reports the failed reload the next time it asks for one.
      watcher.on('error', () => watcher.close())
      // A watcher is not a reason for a process to stay alive. The window is.
      watcher.unref()
      watchers.push(watcher)
    } catch {
      // `views/` is created with the first tab, so a project without one has nothing to watch there.
    }
  }

  return () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    for (const watcher of watchers) watcher.close()
  }
}
