# AGENTS.md

This folder is a **bench data project**. The append-only event log is the truth.

## Non-negotiables

1. Never edit `data/events.jsonl` by hand. Mutate through the CLI below.
2. Never modify `data/raw/`. Imported files are evidence.
3. Never delete a dataset version. Replacing data creates a version with a diff.
4. Never mix observed and derived values. Fitted values stay out of datasets.
5. Never draw a curve without n, degrees of freedom, an interval band, and a verdict.
6. Never extend a shape silently. Register the field so the change is visible.

## Running bench

The CLI is the only way to read or mutate this project. This file records the launcher that created
it, refreshed to whichever CLI last wrote the brief, so the next session does not have to find it:

    pnpm bench --project "fixtures/projects/drift-sensor" state

That is this checkout's CLI script, and the path above is this project relative to it: run
the line from the checkout root. If `bench` is on PATH it is the same CLI.

If this folder has moved since that line was written, run `pnpm bench` from the checkout root
with `--project` pointing at the folder's current path and run `state`: that rewrites this line.

## After changing anything

Run the `state` command the same way and read the result. It is the brief the next session inherits.

## Before concluding anything

Run the `check` command the same way. A clean log is not the same as a supported claim.

## Shapes

- `main` — xy.v1 (x:number, y:number)
