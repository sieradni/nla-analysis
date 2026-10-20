# ADR 0014 — A shape may designate its observation-time field

Status: accepted, 2026-10-19.

## Context

`t_observed` is the first-class observation time: it is what orders points, identifies rows across
dataset versions, and answers "does this change over time". A custom shape can also carry the same
instant as an ordinary field, because the source export has a `Date` column and a person expects to
see it. That leaves two copies of one fact.

An import kept them aligned because it read one column and wrote both. A hand-added point did not:
`bench add --values '{"date":"2026-10-01",…}'` without `--at` stamped `t_observed` with *now*, and
nothing refused or even warned. Two doors recorded the same observation with different answers to
"when", and the log could not tell a measurement from a typo.

Three designs were possible:

1. **Drop the duplicate field.** Make `t_observed` the only time and remove `date` from shapes. This
   loses the column the export actually carries, and a shape stops describing its own data.
2. **Keep two fields and warn on divergence.** A warning is not a decision: the point is still
   written with two times, and every reader has to choose.
3. **Let the shape name the field.** A declaration says which field carries the observation time.
   Every recording door derives `t_observed` from it and refuses a contradiction.

Non-negotiable 5 ("never mix observed and derived values") and the existing `t_observed` contract
both point at the third design. The field is observed; `t_observed` becomes its canonical form, not
a second observation.

## Decision

`shape_time_designated` is an event with `from`, the complete new `shape`, and the designated
`time_field`. The shape id carries the next version (`qp_stats.v2` → `qp_stats.v3`).

- **One field, named by the declaration.** The field must be required and of type `instant`. A
  number could be epoch seconds or nanoseconds; an optional field would let a point have no time.
- **The field list does not change.** A designation adds no field and reorders none. The event is
  refused if the new declaration differs from the old one except for `time_field`.
- **Append-only, like an extension.** Existing points keep the shape id they were recorded with and
  the `t_observed` they were written with. A designation never rewrites history.
- **One owner.** [`src/core/observation.ts`](../../src/core/observation.ts) decides what the time is.
  `Workspace.recordPoint`, `Workspace.correctPoint`, the import column policy, and the shape
  validator all call it; no command reimplements the rule.
- **Canonical in both places.** The designated field is canonicalised to UTC with milliseconds in
  `values`, and that same string is `t_observed`. `2026-10-01T12:34:56+02:00` becomes
  `2026-10-01T10:34:56.000Z` in both.
- **A contradiction is refused.** `bench add … --at` naming a different instant is an error naming
  both, not a silent choice. An import may read a second time column with `--time`, but every row
  must agree with the designated field; disagreeing rows stop the import before anything is written.
- **`bench correct` moves both.** A correction to the designated field re-derives the instant and
  writes it on the correction event, which the binder applies. A correction that only touches another
  field still canonicalises the designated field in the event.
- **A designation cannot move.** Changing it would reinterpret points already written; that would be
  a different, explicit migration, not this event.
- **No designation keeps the old rule.** `--at`, or now for a single add, and a required time column
  for imports. This is what keeps every existing project and the drift-sensor fixture readable.

The CLI door is `bench shape designate <id> --time-field <name>`. Shapes may also declare
`time_field` at `bench init --shape`, which is the same validator applied before the first point.

## Consequences

- QP Stats designated `date` (`qp_stats.v2` → `qp_stats.v3`). Its one recorded point did not move:
  `date` and `t_observed` are still `2026-10-19T12:41:32.498Z`, and `bench check` stayed at
  `0 error(s) · 0 warning(s)`.
- A matching `bench add` now prints and records one canonical instant twice; a divergent `--at` is
  refused without appending an event.
- `STATE.md` and the project's `AGENTS.md` show `observation time: date` on the shape line.
- `addHint` stops teaching `--at` for a designated shape, because the field already carries it.
- The window's entry bar and import sheet call the same `Workspace`/`planImport` functions, so they
  inherit the rule without a new UI flow.
- `bench check` validates each point against the declaration it was recorded with, so a point
  written before a designation is not retroactively refused. New points cannot diverge.
- The window has no designation editor yet; this ADR covers the core, CLI, and the existing write
  doors. A shape editor, `shape list|show|validate`, and `add --dry-run` remain open.
