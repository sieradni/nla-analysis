# AGENTS.md

This folder is a **bench data project**. The append-only event log is the truth.

## Non-negotiables

1. Never edit `data/events.jsonl` by hand. Mutate through `bench`.
2. Never modify `data/raw/`. Imported files are evidence.
3. Never delete a dataset version. Replacing data creates a version with a diff.
4. Never mix observed and derived values. Fitted values stay out of datasets.
5. Never draw a curve without n, degrees of freedom, an interval band, and a verdict.
6. Never extend a shape silently. Register the field so the change is visible.

## After changing anything

Run `bench state` and read the result. It is the brief the next session inherits.

## Before concluding anything

Run `bench check`. A clean log is not the same as a supported claim.
