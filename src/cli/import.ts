/**
 * `bench import` — one plan, one commit, and the output a person or an agent reads.
 *
 * The command resolves paths and parses flags; `core/import` owns parsing, the column policy, and
 * the all-or-nothing write. Keeping the output here means the dispatcher stays a dispatcher.
 */
import { existsSync } from 'node:fs'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { commitImport, planImport } from '../core/import.ts'
import { diffCounts } from '../core/versions.ts'
import type { Workspace } from '../core/workspace.ts'
import { printDiffDetails } from './diff-output.ts'

export interface ImportCommandOptions {
  project?: string
  dataset?: string
  map?: string[]
  time?: string
  'ignore-unmapped'?: string[]
  force?: boolean
  'dry-run'?: boolean
  format?: string
}

export interface ImportCommandIO {
  json: boolean
  open: (project?: string) => Promise<Workspace>
  die: (message: string, code?: number, hint?: string) => never
  fail: (error: unknown) => never
}

/** What an import does to the rows that are already there, in one sentence. */
function versionSentence(plan: {
  dataset: string
  version: number
  parent: number | null
  diff: { added: number; removed: number; changed: number }
  rows: number
}): string {
  if (plan.parent === null) return `first version of ${plan.dataset} · ${plan.rows} row(s)`
  return `replaces version ${plan.parent} · ${diffCounts(plan.diff)}`
}

export async function runImportCommand(
  args: readonly string[],
  options: ImportCommandOptions,
  io: ImportCommandIO,
): Promise<void> {
  const file = args[0]
  if (!file) io.die('missing a file to import', 1, 'bench import readings.csv')
  const workspace = await io.open(options.project)

  // A relative path is looked for where the shell is, then inside the project. Both are what a
  // person means by `import readings.csv`, especially when --project points somewhere else.
  const candidates = isAbsolute(file) ? [file] : [resolve(file), resolve(workspace.dir, file)]
  const source = candidates.find((candidate) => existsSync(candidate))
  if (!source) {
    io.die(`cannot find ${file}`, 2, `looked in ${candidates.map((candidate) => dirname(candidate)).join(' and ')}`)
  }

  const format = options.format?.toLowerCase()
  if (format !== undefined && !['csv', 'tsv', 'jsonl'].includes(format)) {
    io.die(`unknown format "${format}"`, 1, 'use csv, tsv, or jsonl')
  }

  const mapping: Record<string, string> = {}
  for (const entry of options.map ?? []) {
    const separator = entry.indexOf('=')
    if (separator <= 0) io.die(`--map must look like field=column, got "${entry}"`)
    mapping[entry.slice(0, separator).trim()] = entry.slice(separator + 1).trim()
  }
  const ignoreColumns = options['ignore-unmapped'] ?? []

  // One plan answers every question before anything is written; `commitImport` is the only part
  // that touches the disk, so a refusal cannot leave half a file behind.
  let plan
  try {
    plan = await planImport(workspace, source, {
      ...(options.dataset === undefined ? {} : { dataset: options.dataset }),
      mapping,
      ...(options.time === undefined ? {} : { time: options.time }),
      ...(ignoreColumns.length === 0 ? {} : { ignoreColumns }),
      ...(options.force === true ? { force: true } : {}),
      ...(format === undefined ? {} : { format: format as 'csv' | 'tsv' | 'jsonl' }),
    })
  } catch (error) {
    io.fail(error)
  }

  const summary = {
    dataset: plan.dataset,
    shape: plan.shape,
    format: plan.format,
    rows: plan.rows,
    columns: plan.columns,
    mapping: plan.mapping,
    // Omitted when nothing was ignored, so a file with exactly the declared columns keeps
    // the JSON shape it had before this check existed.
    ...(plan.ignoredColumns.length === 0 ? {} : { ignoredColumns: plan.ignoredColumns }),
    timeColumn: plan.timeColumn,
    sourceHash: plan.sourceHash,
    raggedRows: plan.raggedRows,
    comments: plan.comments,
    version: plan.version,
    parent: plan.parent,
    diff: { added: plan.diff.added, removed: plan.diff.removed, changed: plan.diff.changed },
  }

  if (options['dry-run'] === true) {
    if (io.json) {
      process.stdout.write(
        JSON.stringify({ ok: true, data: { ...summary, dryRun: true, sample: plan.sample } }, null, 2) + '\n',
      )
    } else {
      process.stdout.write(`would import ${plan.rows} row(s) into ${plan.dataset} (${plan.shape})\n`)
      process.stdout.write(`  ${versionSentence(plan)}\n`)
      for (const [field, column] of Object.entries(plan.mapping)) {
        process.stdout.write(`  ${field} <= ${column}\n`)
      }
      if (plan.timeColumn) process.stdout.write(`  t_observed <= ${plan.timeColumn}\n`)
      if (plan.ignoredColumns.length > 0) {
        process.stdout.write(`  ignored ${plan.ignoredColumns.join(', ')} (no shape field)\n`)
      }
      printDiffDetails(plan.diff, 5)
      process.stdout.write(`  nothing was written\n`)
    }
    return
  }

  // The original is copied before anything is recorded: an import is evidence, and the file that
  // produced it must outlive whatever is done to the working copy. It is never read again.
  try {
    await commitImport(workspace, plan)
  } catch (error) {
    io.fail(error)
  }

  for (const warning of plan.warnings.slice(0, 5)) process.stderr.write(`  warning: ${warning}\n`)
  if (io.json) {
    process.stdout.write(
      JSON.stringify({ ok: true, data: { ...summary, preserved: plan.preserved, warnings: plan.warnings } }, null, 2) +
        '\n',
    )
  } else {
    process.stdout.write(
      `imported ${plan.rows} row(s) into ${plan.dataset} as version ${plan.version} from ${basename(source)}\n`,
    )
    process.stdout.write(`  ${versionSentence(plan)}\n`)
    process.stdout.write(`  preserved as ${plan.preserved}\n`)
    for (const [field, column] of Object.entries(plan.mapping)) {
      process.stdout.write(`  ${field} <= ${column}\n`)
    }
    if (plan.timeColumn) process.stdout.write(`  t_observed <= ${plan.timeColumn}\n`)
    if (plan.ignoredColumns.length > 0) {
      process.stdout.write(`  ignored ${plan.ignoredColumns.join(', ')} (no shape field)\n`)
    }
    printDiffDetails(plan.diff, 5)
    if (plan.parent !== null) {
      const rows = workspace.rowsOfVersion(plan.dataset, plan.parent).length
      process.stdout.write(`  version ${plan.parent} is untouched: still ${rows} row(s)\n`)
    }
    if (plan.raggedRows > 0) {
      process.stdout.write(`  ${plan.raggedRows} row(s) had a different number of fields than the header\n`)
    }
    if (plan.comments > 0) {
      process.stdout.write(`  ${plan.comments} comment line(s) skipped\n`)
    }
  }
}
