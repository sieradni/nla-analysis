/**
 * A refusal a caller can present. The kind maps onto the CLI's exit codes and nothing else: the core
 * never decides how a refusal is displayed, and never exits the process (ADR 0003).
 *
 * The list is the one place the kinds are written down. A caller that needs them at runtime (the
 * shell's IPC envelope, the window's retry-or-drop policy) reads this rather than repeating the
 * three names, so a kind added here is a kind every caller already knows.
 */
export const ERROR_KINDS = ['invalid', 'missing', 'invariant'] as const

export type ErrorKind = (typeof ERROR_KINDS)[number]

export class BenchError extends Error {
  readonly kind: ErrorKind
  readonly hint?: string
  /** Per-field or per-row detail, printed under the message when there is any. */
  readonly problems: string[]

  constructor(kind: ErrorKind, message: string, options: { hint?: string; problems?: string[] } = {}) {
    super(message)
    this.name = 'BenchError'
    this.kind = kind
    if (options.hint !== undefined) this.hint = options.hint
    this.problems = options.problems ?? []
  }
}
