# ADR 0001 — Stack and control-surface choices

Date: 2026-10-18
Status: accepted

## Decisions

1. **Tauri 2 shell, webview UI.** Small MSI, per-user install, no admin, no browser tab, no server.
   Full-native (Qt/Avalonia) rejected: it would throttle the agent's iteration loop and weaken
   charting for no user-visible gain here.
2. **Python for analysis, TypeScript for UI.** Decisive reason: the alternative is hand-writing a
   statistics library. scipy/statsmodels/sklearn/pymc provide tested numerics; the agent writes real,
   reviewable code. Costs accepted: ~120 MB embedded runtime, a second language, IPC.
3. **No Python in the entry path.** Append, query, and redraw stay in TypeScript. Analysis is
   debounced and cached by `(recipe hash, params hash, data hash)`.
4. **Repo agent only.** No in-app chatbot and no API keys in the hot path. `bench` is the control
   surface, so a durable session needs no bespoke chat interface.
5. **Three-layer data model.** Storage never changes; point shapes are versioned and migrated; the
   analytical model is a recipe parameter. This is what lets the model adapt per request without
   making old data uninterpretable.
6. **Dataset versions are immutable.** "Replace the dataset" creates a version and a diff; nothing
   is destroyed, and stale analyses are marked rather than silently recomputed.

## Consequences

- We own Windows packaging for an embedded interpreter (signing, DLL loading, antivirus false
  positives) — budget real time for it.
- Two languages mean two failure surfaces; mitigated by making `bench` the only mutation path.
- Chart rendering stays swappable so we are not locked into a spec that dies at 100k points.

## Revisit if

- Entry latency exceeds budget because of the UI→store write path.
- A single-language stack becomes viable (e.g. a mature, fast JS stats library we would trust).
