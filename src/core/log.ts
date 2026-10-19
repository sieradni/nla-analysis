import { mkdir, open, readFile, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ulid } from './ids.ts'
import type { BenchEvent } from './events.ts'

export interface LogRead {
  events: BenchEvent[]
  problems: string[]
}

/**
 * What the log file looked like when a reader last looked at it. Appends only ever grow the file, so
 * a different size means someone else has written since. `mtimeMs` rides along because a second
 * writer that appends and then truncates (a restore from a backup, say) would otherwise be invisible
 * by size alone.
 */
export interface LogStamp {
  size: number
  mtimeMs: number
}

export function sameStamp(left: LogStamp | null, right: LogStamp | null): boolean {
  if (left === null || right === null) return left === right
  return left.size === right.size && left.mtimeMs === right.mtimeMs
}

export class EventLog {
  readonly file: string

  constructor(file: string) {
    this.file = file
  }

  /**
   * Append one event. The write is a single call followed by fsync, so a crash leaves either a
   * complete line or a torn tail — never a half-written record in the middle of the file.
   */
  async append(event: BenchEvent): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const handle = await open(this.file, 'a')
    try {
      await handle.write(JSON.stringify(event) + '\n')
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  /**
   * Append several events as one write. Importing ten thousand rows one fsync at a time takes long
   * enough to look broken, and an import that half-lands after an interruption is worse than one
   * that never started.
   *
   * Returns the number of bytes written, so a caller can tell whether the file grew by exactly its
   * own write or by more than that — i.e. whether another writer slipped an event in alongside it.
   */
  async appendMany(events: BenchEvent[]): Promise<number> {
    if (events.length === 0) return 0
    await mkdir(dirname(this.file), { recursive: true })
    const payload = events.map((event) => JSON.stringify(event) + '\n').join('')
    const handle = await open(this.file, 'a')
    try {
      await handle.write(payload)
      await handle.sync()
    } finally {
      await handle.close()
    }
    return Buffer.byteLength(payload)
  }

  /**
   * The file's identity right now, or null when there is no file yet. It is one `stat`, which is
   * what makes it affordable to ask before every mutation — as against not asking, which costs a
   * number that no longer traces to the log.
   */
  async stamp(): Promise<LogStamp | null> {
    try {
      const info = await stat(this.file)
      return { size: info.size, mtimeMs: info.mtimeMs }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async read(): Promise<LogRead> {
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { events: [], problems: [] }
      throw error
    }

    const lines = text.split('\n')
    const events: BenchEvent[] = []
    const problems: string[] = []

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!.trim()
      if (line === '') continue
      try {
        events.push(JSON.parse(line) as BenchEvent)
      } catch {
        const isTail = lines.slice(index + 1).every((rest) => rest.trim() === '')
        problems.push(
          isTail
            ? `line ${index + 1}: incomplete final record ignored (torn write)`
            : `line ${index + 1}: unreadable record`,
        )
      }
    }

    return { events, problems }
  }
}

/** A session groups one conversation's worth of mutations, so STATE can say what changed when. */
export function newSession(): string {
  return ulid()
}
