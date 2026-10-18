# ADR 0002 — v1 is agent-only; the app is deferred

Date: 2026-10-18
Status: accepted
Supersedes: the phase ordering in [00-requirements.md](../00-requirements.md) §13

## Context

The app is the highest-refinement part of this product: layout, keyboard model, chart rendering,
DPI, focus, latency. It is also the part least able to survive churn in the data model beneath it —
building a frontend against a schema still in motion means rebuilding the frontend.

Meanwhile the durable value lives in the log, the binder, and the recipes. Those can be exercised
entirely through `bench`, with charts emitted as SVG files that are reviewable in the same place the
conversation happens.

## Decision

1. **v1 has no GUI.** `bench` is the only surface. Charts are rendered to SVG artifacts.
2. **The Tauri shell is deferred until** the event log, shapes, binder, and at least three recipes are
   proven against real data. It stays the plan; it just isn't next.
3. **Svelte 5 is the UI framework when the app lands**, chosen for fine-grained reactivity on the
   keystroke→paint budget and for a small bundle in a desktop shell.
4. **The SVG renderer is a core module, not CLI glue**, so the future app renders the identical spec
   with an identical result.
5. **SQLite is deferred.** An in-memory projection of the log handles 10⁵ points in ~10 MB. Add an
   index only when a measured query is slow — not on principle.

## Consequences

- No packaging, signing, WebView2, or DPI work blocks progress. Every step is testable in a terminal.
- Charts still need a visual gate: they are rendered to files and shown for approval.
- The first real UI risk is deferred, not retired. It returns in Phase 5, and it will then sit on a
  data model that no longer moves.
- Manual entry is deferred with the UI; points arrive through `bench add` (by the agent on request).

## Revisit if

- Reviewing SVG artifacts feels slower than looking at a live window.
- A recipe needs interactive parameter exploration to be useful.
