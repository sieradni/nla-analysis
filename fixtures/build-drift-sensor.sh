#!/usr/bin/env bash
# Rebuild the drift-sensor fixture from scratch.
#
# The fixture is committed so the tests have a real project to read, and so a fresh clone can see
# what a working project looks like. This script is how it was made, and how it gets refreshed
# after a change to the log format, the binder, or the state renderer. It also exercises every
# mutation the CLI offers, including the ugly paths.
#
# Usage: bash fixtures/build-drift-sensor.sh
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
project="$root/fixtures/projects/drift-sensor"
bench() { node "$root/src/cli/index.ts" --project "$project" "$@"; }

# Read a point id out of `--json` output without needing jq.
id_of() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).data.id))'; }

rm -rf "$project"
node "$root/src/cli/index.ts" init "$project" --name "drift-sensor" >/dev/null

# Week one: the relationship looks like y ~= 2.1x + 0.4.
bench add --x 1 --y 2.55 --at 2026-10-01T09:00:00Z --note "baseline run" >/dev/null
bench add --x 2 --y 4.62 --at 2026-10-01T09:04:00Z >/dev/null
bench add --x 3 --y 6.71 --at 2026-10-02T09:00:00Z >/dev/null
bench add --x 4 --y 8.85 --at 2026-10-03T09:00:00Z >/dev/null
bench add --x 5 --y 10.94 --at 2026-10-04T09:00:00Z >/dev/null

# Week two, after a recalibration: steeper, y ~= 2.6x + 0.3.
bench add --x 1 --y 2.92 --at 2026-10-10T09:00:00Z --note "after recalibration" >/dev/null
bench add --x 2 --y 5.51 --at 2026-10-10T09:05:00Z >/dev/null
bench add --x 3 --y 8.09 --at 2026-10-11T09:00:00Z >/dev/null
bench add --x 4 --y 10.66 --at 2026-10-12T09:00:00Z >/dev/null
bench add --x 5 --y 13.21 --at 2026-10-13T09:00:00Z >/dev/null

# A mistyped extra field: recorded with a warning, surfaced by `bench check`, then retracted and
# re-recorded properly. This is the documented remedy, and it is why `check` only validates the
# active set.
typo="$(bench add --values '{"x":9,"y":21.5,"temprature":21.5}' --at 2026-10-13T09:30:00Z --json 2>/dev/null | id_of)"
bench retract "$typo" --reason 'field name typo; re-recorded correctly' >/dev/null
bench add --x 9 --y 21.5 --at 2026-10-13T09:30:00Z --note "re-recorded after field typo" >/dev/null

# A transcription error, corrected without destroying the original record.
bad="$(bench add --x 6 --y 99.9 --at 2026-10-14T09:00:00Z --json | id_of)"
bench correct "$bad" --values '{"y":16.0}' --reason "transcription error" >/dev/null

# A recorded analysis, so the fixture exercises the verdict path and STATE's Analyses section.
# The pooled slope is a compromise between the two weeks -- which is exactly the question a
# time-varying analysis has to answer, and why this data set is shaped the way it is.
bench run fit --param degree=1 >/dev/null

bench chart >/dev/null
bench check
echo "fixture rebuilt at $project"
