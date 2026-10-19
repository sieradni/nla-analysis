/**
 * Reading tabular input. Excel, most instruments, and every export button on the internet produce
 * one of three things: comma-separated, tab-separated, or one JSON object per line. This handles
 * those three and refuses to guess beyond them.
 *
 * Everything comes back as a string. Coercion happens later, against the shape's declared field
 * types, so a value is only turned into a number when the shape says a number belongs there.
 */

export interface Table {
  columns: string[]
  rows: Record<string, string>[]
  /** Rows whose field count disagreed with the header. Reported, not silently dropped. */
  raggedRows: number
  /** Lines starting with `#` or `//`, the metadata preamble most instrument exports carry. */
  comments?: number
}

export function detectDelimiter(sample: string): string {
  const firstLine = sample.split(/\r?\n/, 1)[0] ?? ''
  const candidates: [string, number][] = [
    ['\t', (firstLine.match(/\t/g) ?? []).length],
    [',', (firstLine.match(/,/g) ?? []).length],
    [';', (firstLine.match(/;/g) ?? []).length],
  ]
  let best = candidates[0]!
  for (const candidate of candidates) {
    if (candidate[1] > best[1]) best = candidate
  }
  return best[1] === 0 ? ',' : best[0]
}

/** Split one line, honouring quoted fields, doubled quotes, and embedded delimiters or newlines. */
function parseLine(line: string, delimiter: string): string[] {
  const fields: string[] = []
  let current = ''
  let quoted = false

  for (let index = 0; index < line.length; index++) {
    const character = line[index]!
    if (quoted) {
      if (character === '"') {
        if (line[index + 1] === '"') {
          current += '"'
          index += 1
        } else {
          quoted = false
        }
      } else {
        current += character
      }
      continue
    }
    if (character === '"' && current === '') {
      quoted = true
      continue
    }
    if (character === delimiter) {
      fields.push(current)
      current = ''
      continue
    }
    current += character
  }
  fields.push(current)
  return fields
}

/** Split into records first: a quoted field may legally contain a newline. */
function splitRecords(text: string): string[] {
  const records: string[] = []
  let current = ''
  let quoted = false

  for (let index = 0; index < text.length; index++) {
    const character = text[index]!
    if (character === '"') quoted = !quoted
    if (!quoted && (character === '\n' || character === '\r')) {
      if (character === '\r' && text[index + 1] === '\n') index += 1
      records.push(current)
      current = ''
      continue
    }
    current += character
  }
  if (current !== '') records.push(current)
  return records
}

/**
 * Instrument exports usually open with `# instrument: ...` metadata lines. Dropping them is what a
 * person means by "import this file", but it is counted and reported rather than done silently -- a
 * skipped line could just as easily be a broken row.
 */
function isCommentLine(record: string): boolean {
  const leading = record.trimStart()
  return leading.startsWith('#') || leading.startsWith('//')
}

export function parseDelimited(text: string, delimiter?: string): Table {
  const all = splitRecords(text).filter((record) => record.trim() !== '')
  const comments = all.filter(isCommentLine).length
  const records = all.filter((record) => !isCommentLine(record))
  if (records.length === 0) return { columns: [], rows: [], raggedRows: 0, comments }

  const separator = delimiter ?? detectDelimiter(text)
  const header = parseLine(records[0]!, separator).map((name) => name.trim())
  const columns = header.map((name, index) => (name === '' ? `column_${index + 1}` : name))

  const rows: Record<string, string>[] = []
  let raggedRows = 0
  for (const record of records.slice(1)) {
    const values = parseLine(record, separator)
    if (values.length !== columns.length) raggedRows += 1
    const row: Record<string, string> = {}
    columns.forEach((column, index) => {
      row[column] = (values[index] ?? '').trim()
    })
    rows.push(row)
  }

  return { columns, rows, raggedRows, comments }
}

export function parseJsonl(text: string): Table {
  const rows: Record<string, string>[] = []
  const seen: string[] = []
  let raggedRows = 0
  let comments = 0

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    if (isCommentLine(trimmed)) {
      comments += 1
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      raggedRows += 1
      continue
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      raggedRows += 1
      continue
    }
    const row: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!seen.includes(key)) seen.push(key)
      row[key] = value === null || value === undefined ? '' : String(value)
    }
    rows.push(row)
  }

  return { columns: seen, rows, raggedRows, comments }
}

export type CoercedValue = number | string | boolean | null

/**
 * Turn a table cell into a value of the declared type. An empty cell is null (absent), never zero:
 * inventing a zero for a missing reading is how a gap turns into a spike.
 */
export function coerce(cell: string, type: string): CoercedValue {
  const trimmed = cell.trim()
  if (trimmed === '') return null
  switch (type) {
    case 'number': {
      const value = Number(trimmed)
      return Number.isFinite(value) ? value : trimmed
    }
    case 'integer': {
      const value = Number(trimmed)
      return Number.isInteger(value) ? value : trimmed
    }
    case 'boolean':
      if (/^(true|yes|1)$/i.test(trimmed)) return true
      if (/^(false|no|0)$/i.test(trimmed)) return false
      return trimmed
    default:
      return trimmed
  }
}
