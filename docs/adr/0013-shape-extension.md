# ADR 0013 — Shape extension is a new declaration, not a migration

Status: accepted, 2026-10-19.

## Context

A shape is declared once at `init`, and a point's shape is part of its record. That made the
first shape permanently final: adding a field that the data later produced required a new
project, and `bench add` would store the field with a warning while `bench check` called it drift.

Two designs were possible:

1. **Migrate existing rows.** Rewrite or backfill values into old points so every point matches the
   current shape. This makes queries simple, but it changes what was observed: a `null` backfill is
   not a measurement, and a derived default silently mixes observed and derived values.
2. **Append a declaration.** Leave every point exactly as recorded; add a new shape version and
   record the event that produced it. Readers resolve each point against the declaration that was
   current when it was written.

Non-negotiable 7 ("never change a point's shape silently") and non-negotiable 5 ("never mix
observed and derived values") both point at the second design.

## Decision

`shape_extended` is an event with `from`, the complete new `shape`, and the one appended `field`.
The shape id carries the version (`qp_stats.v1` → `qp_stats.v2`).

- **Append-only.** The previous declaration and every point are untouched. No backfill event exists.
- **One new field.** The new declaration must be the old one, with the same fields in the same
  order, plus exactly one field. A rename, retype, unit change or reorder is refused; that is a new
  shape, not an extension.
- **Explicit type required.** `--type` must be one of the shape field types. There is no inferred
  default, because a guessed type is a permanent claim about data that has not arrived yet.
- **Latest only.** The extended shape must be the newest version of its base. Extending an older
  version would fork the history into two declarations that both claim to be next.
- **Datasets move; points do not.** Current readers resolve a dataset to the new shape, so
  `bench add` and `bench import` accept the new field with no extra wiring. A point recorded before
  the extension keeps the shape id it was written with.
- **Validated in the fold.** `bind` re-runs the same extension rules on every read and reports a
  hand-written or corrupt extension as a structural problem, so `bench check` fails rather than
  trusting the newest declaration.

## Consequences

- A field added later has no value on older points. That is honest: the value was not observed.
  Shape `optional: true` is the declaration for a field that may be absent.
- `STATE.md` and the project's `AGENTS.md` show the current declaration, because they are generated
  from the folded state.
- A window flow that shows which points lack the new field is still open; this ADR covers the core
  and CLI path only.
- Migrations that rewrite values remain out of scope. If one is ever needed, it must be an explicit
  analysis or a new dataset version, never an edit to a point's shape.
