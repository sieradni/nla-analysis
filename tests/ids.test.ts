import { describe, expect, it } from 'vitest'
import { isUlid, ulid, ULID_LENGTH } from '../src/core/ids.ts'

describe('ulid', () => {
  it('produces 26-character crockford ids', () => {
    const id = ulid()
    expect(id).toHaveLength(ULID_LENGTH)
    expect(isUlid(id)).toBe(true)
  })

  it('is unique across rapid calls', () => {
    const ids = new Set(Array.from({ length: 500 }, () => ulid()))
    expect(ids.size).toBe(500)
  })

  it('sorts lexicographically by time', () => {
    const base = Date.now()
    const early = ulid(base + 1_000_000)
    const late = ulid(base + 2_000_000)
    expect(early < late).toBe(true)
  })

  it('increases strictly within the same millisecond', () => {
    const at = Date.now() + 5_000_000
    const ids = Array.from({ length: 50 }, () => ulid(at))
    for (let i = 1; i < ids.length; i++) expect(ids[i - 1]! < ids[i]!).toBe(true)
  })

  it('never goes backwards when the clock does', () => {
    const first = ulid(1_700_000_005_000)
    const second = ulid(1_700_000_004_000)
    expect(first.slice(0, 10) <= second.slice(0, 10)).toBe(true)
  })
})
