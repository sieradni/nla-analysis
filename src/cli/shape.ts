/**
 * `bench shape` — the two shape-version writes.
 *
 * The command parses and prints; `src/core/shapes.ts` decides what a valid next declaration is, and
 * `Workspace` appends it. Keeping the command here means the CLI dispatcher does not also hold the
 * shape rules or their output format.
 */
import type { Workspace } from '../core/workspace.ts'

export interface ShapeCommandOptions {
  project?: string
  field?: string
  type?: string
  unit?: string
  optional?: boolean
  'time-field'?: string
}

export interface ShapeCommandIO {
  json: boolean
  open: (project?: string) => Promise<Workspace>
  die: (message: string, code?: number, hint?: string) => never
  fail: (error: unknown) => never
}

export async function runShapeCommand(
  args: readonly string[],
  options: ShapeCommandOptions,
  io: ShapeCommandIO,
): Promise<void> {
  const [sub, shapeId] = args
  if (sub !== 'extend' && sub !== 'designate') {
    io.die(
      sub === undefined ? 'missing a shape subcommand' : `unknown shape subcommand "${sub}"`,
      1,
      'use extend or designate',
    )
  }
  if (!shapeId) {
    io.die(
      sub === 'designate' ? 'missing the shape to designate' : 'missing the shape to extend',
      1,
      sub === 'designate'
        ? 'bench shape designate reading.v1 --time-field date'
        : 'bench shape extend reading.v1 --field b2b --type integer',
    )
  }
  const workspace = await io.open(options.project)

  if (sub === 'designate') {
    const fieldName = options['time-field']
    if (fieldName === undefined) {
      io.die('a designation needs a field', 1, 'bench shape designate reading.v1 --time-field date')
    }
    let designation: Awaited<ReturnType<typeof workspace.designateShapeTime>>
    try {
      designation = await workspace.designateShapeTime(shapeId, fieldName)
    } catch (error) {
      io.fail(error)
    }
    await workspace.writeStateBrief()
    const points = designation.datasets.reduce(
      (sum, id) => sum + (workspace.state.datasets.get(id)?.points.length ?? 0),
      0,
    )
    if (io.json) {
      process.stdout.write(
        JSON.stringify(
          {
            ok: true,
            data: {
              event: designation.event.id,
              from: designation.from.id,
              shape: designation.shape,
              time_field: designation.field.name,
              datasets: designation.datasets,
              unchangedPoints: points,
            },
          },
          null,
          2,
        ) + '\n',
      )
      return
    }
    process.stdout.write(
      `designated ${designation.from.id} -> ${designation.shape.id} · observation time: ${designation.field.name}${designation.field.unit ? `[${designation.field.unit}]` : ''}\n`,
    )
    process.stdout.write(
      `  ${designation.datasets.length} dataset(s) moved; ${points} existing point(s) keep the time they were recorded with\n`,
    )
    process.stdout.write(`  event ${designation.event.id}\n`)
    return
  }

  let extended: Awaited<ReturnType<typeof workspace.extendShape>>
  try {
    extended = await workspace.extendShape(shapeId, {
      name: options.field,
      type: options.type,
      unit: options.unit,
      optional: options.optional,
    })
  } catch (error) {
    io.fail(error)
  }
  await workspace.writeStateBrief()

  const rows = extended.datasets.reduce(
    (sum, id) => sum + (workspace.state.datasets.get(id)?.points.length ?? 0),
    0,
  )
  if (io.json) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          data: {
            event: extended.event.id,
            from: extended.from.id,
            shape: extended.shape,
            field: extended.field,
            datasets: extended.datasets,
            unchangedPoints: rows,
          },
        },
        null,
        2,
      ) + '\n',
    )
    return
  }
  process.stdout.write(
    `extended ${extended.from.id} -> ${extended.shape.id} · ${extended.field.name}:${extended.field.type}${extended.field.unit ? `[${extended.field.unit}]` : ''}\n`,
  )
  process.stdout.write(`  ${extended.datasets.length} dataset(s) moved; ${rows} existing point(s) unchanged\n`)
  process.stdout.write(`  event ${extended.event.id}\n`)
}
