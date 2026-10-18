import { randomBytes } from 'node:crypto'

/**
 * Crockford base32. ULIDs are lexicographically sortable by creation time, which is what makes the
 * event log readable in file order and stable to diff.
 */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const TIME_CHARS = 10
const RANDOM_CHARS = 16

export const ULID_LENGTH = TIME_CHARS + RANDOM_CHARS

const MAX_RANDOM = (1n << 80n) - 1n

let lastTime = -1
let lastRandom = 0n

function encodeTime(time: number): string {
  let rest = time
  let out = ''
  for (let i = 0; i < TIME_CHARS; i++) {
    out = ENCODING[rest % 32]! + out
    rest = Math.floor(rest / 32)
  }
  return out
}

function encodeRandom(value: bigint): string {
  let rest = value
  let out = ''
  for (let i = 0; i < RANDOM_CHARS; i++) {
    out = ENCODING[Number(rest & 31n)]! + out
    rest >>= 5n
  }
  return out
}

function freshRandom(): bigint {
  const bytes = randomBytes(10)
  let value = 0n
  for (const byte of bytes) value = (value << 8n) | BigInt(byte)
  return value & MAX_RANDOM
}

/**
 * Generate a ULID. Monotonic: ids taken within the same millisecond increase strictly, and time
 * never moves backwards, so a clock correction cannot make a later id sort before an earlier one.
 * That is what lets the event log be ordered by id alone when timestamps tie.
 */
export function ulid(now: number = Date.now()): string {
  if (now > lastTime) {
    lastTime = now
    lastRandom = freshRandom()
  } else {
    lastRandom = (lastRandom + 1n) & MAX_RANDOM
  }
  return encodeTime(lastTime) + encodeRandom(lastRandom)
}

export function isUlid(value: string): boolean {
  if (value.length !== ULID_LENGTH) return false
  for (const char of value.toUpperCase()) {
    if (!ENCODING.includes(char)) return false
  }
  return true
}
