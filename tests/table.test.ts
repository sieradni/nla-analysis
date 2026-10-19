import { describe, expect, it } from 'vitest'
import { coerce, detectDelimiter, parseDelimited, parseJsonl } from '../src/core/table.ts'

describe('detectDelimiter', () => {
  it('picks tabs over commas, because Excel pastes tabs', () => {
    expect(detectDelimiter('x\ty\n1\t2')).toBe('\t')
  })

  it('picks commas when that is all there is', () => {
    expect(detectDelimiter('x,y\n1,2')).toBe(',')
  })

  it('falls back to a comma for a single column', () => {
    expect(detectDelimiter('x\n1')).toBe(',')
  })
})

describe('parseDelimited', () => {
  it('reads a plain table', () => {
    const table = parseDelimited('x,y\n1,2\n3,4')
    expect(table.columns).toEqual(['x', 'y'])
    expect(table.rows).toEqual([
      { x: '1', y: '2' },
      { x: '3', y: '4' },
    ])
    expect(table.raggedRows).toBe(0)
  })

  it('honours quoted fields containing the delimiter', () => {
    const table = parseDelimited('name,x\n"Smith, John",1')
    expect(table.rows[0]).toEqual({ name: 'Smith, John', x: '1' })
  })

  it('honours doubled quotes', () => {
    const table = parseDelimited('note,x\n"he said ""go""",1')
    expect(table.rows[0]?.note).toBe('he said "go"')
  })

  it('honours a newline inside a quoted field', () => {
    const table = parseDelimited('note,x\n"line one\nline two",1')
    expect(table.rows).toHaveLength(1)
    expect(table.rows[0]?.note).toContain('line one')
    expect(table.rows[0]?.note).toContain('line two')
  })

  it('tolerates CRLF, trailing newlines, and blank lines', () => {
    const table = parseDelimited('x,y\r\n1,2\r\n\r\n')
    expect(table.rows).toEqual([{ x: '1', y: '2' }])
  })

  it('reports ragged rows instead of dropping them silently', () => {
    const table = parseDelimited('x,y\n1,2\n3\n4,5,6')
    expect(table.raggedRows).toBe(2)
    expect(table.rows).toHaveLength(3)
    expect(table.rows[1]?.y).toBe('')
  })

  it('names an unnamed column rather than losing its data', () => {
    const table = parseDelimited('x,,y\n1,2,3')
    expect(table.columns).toEqual(['x', 'column_2', 'y'])
    expect(table.rows[0]?.column_2).toBe('2')
  })
})

describe('parseJsonl', () => {
  it('reads one object per line and unions the keys', () => {
    const table = parseJsonl('{"x":1,"y":2}\n{"x":3,"z":4}\n')
    expect(table.columns).toEqual(['x', 'y', 'z'])
    expect(table.rows).toHaveLength(2)
    expect(table.rows[1]?.z).toBe('4')
  })

  it('counts unparseable lines as ragged instead of throwing', () => {
    const table = parseJsonl('{"x":1}\nnot json\n[1,2]\n')
    expect(table.rows).toHaveLength(1)
    expect(table.raggedRows).toBe(2)
  })
})

describe('coerce', () => {
  it('treats an empty cell as absent, never as zero', () => {
    expect(coerce('', 'number')).toBeNull()
    expect(coerce('   ', 'number')).toBeNull()
  })

  it('converts numbers and integers only when they really are', () => {
    expect(coerce('2.5', 'number')).toBe(2.5)
    expect(coerce('2.5', 'integer')).toBe('2.5')
    expect(coerce('3', 'integer')).toBe(3)
    expect(coerce('abc', 'number')).toBe('abc')
  })

  it('accepts the boolean spellings instruments and spreadsheets emit', () => {
    expect(coerce('TRUE', 'boolean')).toBe(true)
    expect(coerce('no', 'boolean')).toBe(false)
    expect(coerce('maybe', 'boolean')).toBe('maybe')
  })

  it('keeps text as text', () => {
    expect(coerce('2026-10-01', 'string')).toBe('2026-10-01')
  })
})
