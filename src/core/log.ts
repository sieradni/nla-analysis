import { mkdir, open, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ulid } from './ids.ts'
import type { BenchEvent } from './events.ts'

export interface LogRead {
  events: BenchEvent[]
  problems: string[]
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
