# Project onboarding frictions

Status: **observed 2026-10-19** while creating `QP Stats`, a project with a custom shape
(`qp_stats.v1`: `altitude`, `app`, `apm`, `pps` numbers, `date` instant).

This is a findings note, not a promise. The open rows belong in
[03-roadmap.md](03-roadmap.md); this file keeps the reproduction and the reasoning behind them.

## What worked

- `bench init <dir> --name "QP Stats" --shape shape.json` created a project, registered it, and
  wrote `AGENTS.md` + `STATE.md` in one step.
- `bench check` was green immediately: `3 events · 0 active points · 0 error(s) · 0 warning(s)`.
- `bench state` named the shape and every field without any manual edit.
- `bench decide` recorded the field semantics in the log, so the next session inherits them.
- `bench import --dry-run` mapped `Date,Altitude,APP,APM,PPS` case-insensitively, recognised
  `Date` as the observation time, coerced the four numbers, and wrote nothing (`data/raw/` stayed
  empty). This is the right shape for a reversible probe.

## Frictions, in the order they appeared

### 1. The init "next" command cannot add a point to a custom shape

**Fixed (2026-10-19).** `bench init` used to print `add --x 1.2 --y 3.4` for every shape, which
fails on `qp_stats.v1` because it has no `x` or `y` and requires `date`. The same lesson appeared in
the empty-panel refusal and the window's no-tabs state.

[hints.ts](../src/core/hints.ts) is now the one owner. `init`, `view list`, point and recipe
refusals, the empty chart, and the window's `entry.nextTab` all derive their command from the
declared shape:

```text
next: … add --values '{"altitude":1.2,"app":1.2,"apm":1.2,"pps":1.2,"date":"2026-10-01T00:00:00Z","b2b":3}' --at 2026-10-01T00:00:00Z
```

The first plot example uses the first distinct plottable pair, not a hardcoded recipe or `x`/`y`.
A shape with no numeric vertical field says what field to add instead of printing a command that
would be refused. Evidence: `tests/cli.test.ts` takes a custom shape from `init` through its own
sample values to a rendered first tab; `tests/shell.test.ts` checks the same dialog candidates.

### 2. Custom shapes can be stored, listed and imported — and now plotted

**Fixed (2026-10-19).** A plain panel and `bench chart` now name their fields:

```text
bench chart --x-field date --y-field altitude
bench view new "altitude over time" --dataset main --x-field date --y-field altitude
```

[axes.ts](../src/core/axes.ts) is the one resolver: it validates both fields against the declared
shape, keeps `x`/`y` as the defaults, and marks an `instant` horizontal axis as time. The chart
spec carries `x.format = 'time'`, so tick labels are clock labels rather than epoch milliseconds;
a single instant gets a one-day domain and draws its mark rather than an empty frame. Numeric
field pairs work the same way, and the window's New tab dialog lists the selected shape's fields
(numeric or instant horizontally, numeric vertically) instead of offering only the historical
`x`/`y`. A shape with no numeric vertical field says so and disables the plot button.

The old failure is kept here as history: `bench chart` used to refuse with `dataset "main" has no
points with numeric x and y`, and a plain panel used to be created as `n = 0` with the footer
`1 point(s) without x/y not plotted`. Neither can happen now when the fields are named.

**Evidence:** QP Stats has `altitude over time` (date/altitude) and `app against pps` (pps/app);
both render with one mark, and `bench view render` writes the same spec. The window capture is
[app-field-pair-altitude-100.png](ui-review/app-field-pair-altitude-100.png) with the three scalings beside it, plus
[app-field-pair-dialog-100.png](ui-review/app-field-pair-dialog-100.png). The review row was closed by
direction on 2026-10-20; the 150% layout issue it exposed is U20 in the roadmap.

### 3. `date` is a second copy of `t_observed`, and the two can disagree

**Fixed (2026-10-19).** A shape can now designate one of its fields as the observation time
([ADR 0014](adr/0014-observation-time.md)). The declaration is a recorded `shape_time_designated`
event and its own version, so existing points keep the shape and instant they were written with:

```text
designated qp_stats.v2 -> qp_stats.v3 · observation time: date
  1 dataset(s) moved; 1 existing point(s) keep the time they were recorded with
```

Once designated, the field is the truth. `bench add`, `bench correct` and both import doors derive
`t_observed` from it and canonicalise the field in `values`, so `2026-10-20T12:00:00+02:00` is
recorded as `2026-10-20T10:00:00.000Z` in both places. A hand-added point with an `--at` that names
a different instant is refused, naming both:

```text
bench: field "date" says 2026-10-19T13:00:00.000Z, but --at says 2026-10-19T14:00:00.000Z
  hint: drop --at, or make it 2026-10-19T13:00:00.000Z
```

An import may still read a second time column with `--time`; every row must agree with the mapped
designated field, and the first disagreement stops the import before anything is written. The
core has one owner for the rule ([observation.ts](../src/core/observation.ts)); no command
reimplements it. QP Stats designated `date` on `qp_stats.v3`; its recorded point did not move, and
`bench check` stayed green with `0 error(s) · 0 warning(s)`.

The old failure is history: a `date` field used to be stored verbatim while `t_observed` was
canonical, and a hand-added point without `--at` stamped *now* with no warning. Shapes that
designate nothing keep that old `--at`/time-column behaviour.

### 4. Field names are lowercase identifiers; display names and units have no home

The shape validator accepts only `/^[a-z][a-z0-9_]{0,31}$/`
([shapes.ts:8](../src/core/shapes.ts#L8)). `Altitude`, `APP`, `APM`, `PPS` and `Date` therefore
become `altitude`, `app`, `apm`, `pps`, `date`. The entry bar, tooltips and `STATE.md` show the
lowercase names; there is no display-label field, so `APP` reads `app` everywhere.

Units exist on a field (`unit`), but were not supplied for this project, so all four numbers are
deliberately unitless rather than guessed.

**Decided 2026-10-20** ([ADR 0015](adr/0015-user-surface.md), [05-user-surface.md](05-user-surface.md) U28):
an optional `label` on `ShapeField`, set by an explicit, recorded **declaration-only** shape version.
Fields, types and order do not change, and points keep the shape they were recorded with. A unit
change stays refused, because it would reinterpret measurements. Use the label wherever a person
reads a field name; the lowercase identifier remains in the log and in copied details. Not built yet.

### 5. A shape is final after init

**Fixed for appending a field (2026-10-19).** `bench shape extend <id> --field <name> --type
<type>` writes a `shape_extended` event and a new version (`qp_stats.v1` → `qp_stats.v2`). Old
points keep the declaration they were recorded with; the dataset moves forward, so `add` and
`import` accept the new field immediately. `bench check` re-validates every extension, and both
`STATE.md` and the project's `AGENTS.md` show the new declaration. [ADR
0013](adr/0013-shape-extension.md) records the design.

**Still final for a change.** Renaming, retyping, reordering or changing an existing field's unit is
refused: that is a different shape, not an extension, and rewriting old points would reinterpret
measurements. A project whose field is wrong still needs a new shape (or a future, explicit
migration). The window has no shape-extension flow yet; this is the CLI path only.

### 6. A fresh project cannot have a tab

**Fixed (2026-10-19).** `view new` used to refuse when the dataset had no active points, so a
project created with zero rows could not have its first tab. A plain plot now materializes with
`n = 0`: the axes are named, the plot area carries a sentence saying no observations exist yet and
showing the shape's own `add` command, and no fake `0 … 1` tick labels or marks are drawn.
`bench chart` writes the same empty artifact with `(0 points)`. A recipe panel still refuses,
because there is nothing to model, and its refusal names the shape's add command.

Evidence: [app-empty-tab-100.png](ui-review/app-empty-tab-100.png) with its 125/150 siblings;
`tests/views.test.ts`, `tests/chart.test.ts`, and `tests/shell.test.ts` write the empty first tab
through the same core call the window uses.

### 7. Minor inconsistencies

- `bench init --shape` requires the `.v1` suffix in the shape id; the window's create dialog
  appends it automatically. A CLI user who writes `"id": "qp_stats"` is refused with a hint, but
  the two doors could agree.
- `--dry-run` exists on `import` only. It was exactly what this onboarding needed; a matching
  `add --dry-run` would let an agent validate a custom point without appending it.
- `bench add` accepts custom fields only through `--values` JSON. That is workable now that the
  help synopsis and every hint use `--values`; `--x`/`--y` remain a shorthand for the default shape.

## 8. A real observation with an undeclared field (`b2b`)

Use case (2026-10-19T12:41:32.498Z): `altitude 992.4`, `app 0.675`, `apm 52.24`, `pps 1.29`,
`b2b 14` (integer), exact timestamp.

**Fixed on both paths (2026-10-19).** The import fix came first: a `B2B` column now refuses by
default with `1 column has no shape field: B2B` and the exact way forward: `--ignore-unmapped B2B`.
That opt-out is per invocation, must name every undeclared column, is printed by both the dry run
and the apply, and is recorded as `ignored_columns` on `import_completed`. The window's import sheet
shows a checkbox naming the columns it would drop; a mapping change resets the acknowledgement.

`bench shape extend qp_stats.v1 --field b2b --type integer` then removed the need to ignore it.
The event records the whole `qp_stats.v2` declaration and the one added field; the dataset moved
without touching any recorded point. `bench add --values '{…,"b2b":14}' --at
2026-10-19T12:41:32.498Z` recorded the observation as `01M5A56EJ9E9B8XMWY97C8GBHV`, with no
warning. `bench check` reports **11 events · 1 active point · 0 error(s) · 0 warning(s)** (the
extra event is a decision noting that the old blocked note is history), and the import dry run now
maps `B2B` to `b2b` with nothing ignored. The values and timestamp read back exactly.

## 9. Exact timestamps

Yes. `date` is an `instant` field, and the designation now makes it the one input. `bench add
--values '{"date":"2026-10-19T12:41:32.498Z",…}'` records `date` and `t_observed` as that same
canonical UTC string, with no `--at` needed. An offset is accepted and canonicalised, not copied
through; an unparseable string is refused before the event is appended. An import dry run with a
matching `Date` column produces an identical `t` and canonical `date`.

One caveat remains: the window's entry bar is a text input, not a date/time picker. It accepts the
string but does not help compose an exact timestamp. Decided 2026-10-20: the correction row gets a
date/time input, and an imported estimate can be replaced from the window (roadmap U11).

## Suggested order

The first-run hints (§1), empty first tabs (§6), and the observation-time model (§3) are fixed.
What remains, now scheduled in [03-roadmap.md](03-roadmap.md) §6:

1. Field display labels through a declaration-only shape version (U28), a window flow for
   `shape extend` / `shape designate`, and a date/time input in the correction row (U11).
2. `shape list|show|validate` and `add --dry-run` (roadmap §3), so a person can inspect and probe a
   declaration without appending.
