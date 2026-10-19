import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ulid } from './ids.ts'
import type { ChartSpec } from './chart.ts'
import type { Verdict } from './events.ts'

/**
 * The analysis runtime lives in Python; this is the typed door to it. The contract is deliberately
 * narrow -- one JSON object per line, one request at a time -- because the alternative is a second
 * language with an untyped boundary, which is where projects like this rot.
 *
 * Failure is contained by design: if the interpreter is missing, the environment is unpinned, or a
 * recipe raises, this returns an error envelope. Charts and the event log keep working.
 */

export interface RecipeParam {
  name: string
  type: 'field' | 'int' | 'float' | 'enum' | 'text' | 'bool'
  default?: unknown
  min?: number
  max?: number
  values?: string[]
  label?: string
}

export interface RecipeSchema {
  name: string
  summary: string
  params: RecipeParam[]
  outputs: string[]
  hash: string
  source: string
}

export interface RunPoint {
  id: string
  t: string
  values: Record<string, unknown>
}

export interface RunInput {
  dataset: string
  shape: string
  fields: { name: string; type: string; unit?: string }[]
  labels?: Record<string, string>
  points: RunPoint[]
}

export interface RunResult {
  recipe: string
  recipeHash: string
  verdict: Verdict
  narrative: string
  /** A short form of the conclusion, written on the chart. Falls back to the narrative. */
  caption?: string
  chart: ChartSpec
  diagnostics: Record<string, unknown>
  data: Record<string, unknown>
  warnings: string[]
}

export interface RunnerError {
  code: string
  message: string
  hint?: string
}

export type RunnerOutcome =
  | { ok: true; result: RunResult }
  | { ok: false; error: RunnerError }

const REQUEST_TIMEOUT_MS = 30_000

/** Candidate interpreters, best first. A project-local environment beats whatever is on PATH. */
export function interpreterCandidates(root: string): string[] {
  const venv = join(root, 'recipes', '.venv')
  return [
    join(venv, 'Scripts', 'python.exe'),
    join(venv, 'bin', 'python'),
    process.env.BENCH_PYTHON ?? '',
    'python',
    'python3',
  ].filter((candidate) => candidate !== '')
}

export function resolveInterpreter(root: string): string | undefined {
  for (const candidate of interpreterCandidates(root)) {
    if (candidate.includes('/') || candidate.includes('\\')) {
      if (existsSync(candidate)) return candidate
      continue
    }
    return candidate
  }
  return undefined
}

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void
  reject: (reason: Error) => void
  timer: NodeJS.Timeout
}

export class RecipeRunner {
  private child: ChildProcessWithoutNullStreams | undefined
  private readonly pending = new Map<string, PendingRequest>()
  private readonly root: string
  private readonly script: string
  private readonly timeoutMs: number
  private buffer = ''
  private stderrTail = ''
  private lastError: string | undefined

  // Written out longhand rather than as parameter properties: this file is executed directly by
  // Node, whose type-stripping mode cannot express them. See tests/cli.test.ts, which runs the real
  // binary precisely so that this class of difference cannot hide behind a transpiling test runner.
  constructor(root: string, script = join('recipes', 'runner.py'), timeoutMs = REQUEST_TIMEOUT_MS) {
    this.root = root
    this.script = script
    this.timeoutMs = timeoutMs
  }

  /** Start the interpreter. Warmed deliberately: analysis is never in the entry path, so the
   *  startup cost is paid off the critical loop rather than during it. */
  async start(): Promise<void> {
    if (this.child) return
    const interpreter = resolveInterpreter(this.root)
    if (!interpreter) {
      throw new Error(
        'no Python interpreter found; run `pnpm setup:recipes` to create the analysis environment',
      )
    }

    const child = spawn(interpreter, [this.script], {
      cwd: this.root,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.consume(chunk))

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2000)
    })

    child.on('error', (error) => {
      this.lastError = error.message
      this.failAll(new Error(`analysis runtime failed to start: ${error.message}`))
    })
    child.on('close', (code) => {
      this.child = undefined
      const reason = this.lastError ?? this.stderrTail.trim().split('\n').at(-1) ?? `exit code ${code}`
      this.failAll(new Error(`analysis runtime exited: ${reason}`))
    })
  }

  private consume(chunk: string): void {
    this.buffer += chunk
    let index = this.buffer.indexOf('\n')
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line !== '') this.dispatch(line)
      index = this.buffer.indexOf('\n')
    }
  }

  private dispatch(line: string): void {
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(line) as Record<string, unknown>
    } catch {
      // A non-JSON line on stdout is a bug in the runtime, not in the caller. Surface it rather
      // than silently dropping it.
      this.stderrTail = (this.stderrTail + `\nunparseable line: ${line.slice(0, 200)}`).slice(-2000)
      return
    }
    const id = typeof payload.id === 'string' ? payload.id : undefined
    if (id === undefined) return
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timer)
    pending.resolve(payload)
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
      this.pending.delete(id)
    }
  }

  private send(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const child = this.child
    if (!child) return Promise.reject(new Error('analysis runtime is not running'))

    const id = typeof request.id === 'string' ? request.id : ulid()
    const message = { ...request, id }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`analysis runtime did not answer within ${this.timeoutMs} ms`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      child.stdin.write(JSON.stringify(message) + '\n')
    })
  }

  async environment(): Promise<Record<string, string>> {
    const response = await this.send({ kind: 'ping' })
    return (response.data ?? {}) as Record<string, string>
  }

  async catalog(): Promise<RecipeSchema[]> {
    const response = await this.send({ kind: 'catalog' })
    if (response.ok !== true) throw new Error(describe(response))
    return (response.data ?? []) as RecipeSchema[]
  }

  async run(recipe: string, params: Record<string, unknown>, input: RunInput): Promise<RunnerOutcome> {
    const response = await this.send({ kind: 'run', recipe, params, input })
    if (response.ok !== true) {
      const error = (response.error ?? {}) as RunnerError
      return {
        ok: false,
        error: {
          code: typeof error.code === 'string' ? error.code : 'unknown',
          message: typeof error.message === 'string' ? error.message : 'the recipe failed',
          ...(typeof error.hint === 'string' ? { hint: error.hint } : {}),
        },
      }
    }

    return {
      ok: true,
      result: {
        recipe: typeof response.recipe === 'string' ? response.recipe : recipe,
        recipeHash: typeof response.recipe_hash === 'string' ? response.recipe_hash : '',
        verdict: asVerdict(response.verdict),
        narrative: typeof response.narrative === 'string' ? response.narrative : '',
        ...(typeof response.caption === 'string' && response.caption !== ''
          ? { caption: response.caption }
          : {}),
        chart: coerceChartSpec(response.chart),
        diagnostics: (response.diagnostics ?? {}) as Record<string, unknown>,
        data: (response.data ?? {}) as Record<string, unknown>,
        warnings: Array.isArray(response.warnings) ? (response.warnings as string[]) : [],
      },
    }
  }

  async dispose(): Promise<void> {
    const child = this.child
    this.child = undefined
    if (!child) return
    child.stdin.end()
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill()
        resolve()
      }, 1000)
      child.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}

function describe(response: Record<string, unknown>): string {
  const error = (response.error ?? {}) as RunnerError
  return typeof error.message === 'string' ? error.message : 'the analysis runtime refused the request'
}

function asVerdict(value: unknown): Verdict {
  return value === 'supported' || value === 'tentative' || value === 'contradicted'
    ? value
    : 'insufficient'
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function pairs(value: unknown, keys: ['x', 'y']): { x: number; y: number }[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: { x: number; y: number }[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const x = finite(record[keys[0]])
    const y = finite(record[keys[1]])
    if (x === undefined || y === undefined) continue
    out.push({ x, y })
  }
  return out.length > 0 ? out : undefined
}

/**
 * Never hand a renderer something it cannot draw. A recipe is trusted to compute, not trusted to be
 * well-formed: any non-finite number, missing axis, or malformed series is dropped here rather than
 * turning into a blank chart or a NaN in a path attribute.
 */
export function coerceChartSpec(value: unknown): ChartSpec {
  const source = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>

  const axisOf = (key: 'x' | 'y'): { label: string; unit?: string } => {
    const axis = source[key]
    if (typeof axis !== 'object' || axis === null) return { label: key }
    const record = axis as Record<string, unknown>
    return {
      label: typeof record.label === 'string' && record.label !== '' ? record.label : key,
      ...(typeof record.unit === 'string' && record.unit !== '' ? { unit: record.unit } : {}),
    }
  }

  const band: { x: number; y0: number; y1: number }[] = []
  if (Array.isArray(source.band)) {
    for (const item of source.band) {
      if (typeof item !== 'object' || item === null) continue
      const record = item as Record<string, unknown>
      const x = finite(record.x)
      const y0 = finite(record.y0)
      const y1 = finite(record.y1)
      if (x === undefined || y0 === undefined || y1 === undefined) continue
      band.push({ x, y0: Math.min(y0, y1), y1: Math.max(y0, y1) })
    }
  }

  const points = pairs(source.points, ['x', 'y'])
  const line = pairs(source.line, ['x', 'y'])

  const lines: { points: { x: number; y: number }[]; label?: string; muted?: boolean }[] = []
  if (Array.isArray(source.lines)) {
    for (const item of source.lines) {
      if (typeof item !== 'object' || item === null) continue
      const record = item as Record<string, unknown>
      const points = pairs(record.points, ['x', 'y'])
      if (!points || points.length < 2) continue
      lines.push({
        points,
        ...(typeof record.label === 'string' && record.label !== '' ? { label: record.label } : {}),
        ...(record.muted === true ? { muted: true } : {}),
      })
    }
  }

  return {
    x: axisOf('x'),
    y: axisOf('y'),
    ...(typeof source.title === 'string' ? { title: source.title } : {}),
    ...(typeof source.subtitle === 'string' ? { subtitle: source.subtitle } : {}),
    ...(points ? { points } : {}),
    ...(line ? { line } : {}),
    ...(lines.length > 0 ? { lines } : {}),
    ...(band.length > 1 ? { band } : {}),
    ...(typeof source.footer === 'string' ? { footer: source.footer } : {}),
  }
}
