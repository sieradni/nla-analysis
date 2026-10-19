# ADR 0003 — The app binds the core in process; `bench` becomes a wrapper over it

Date: 2026-10-19
Status: accepted
Related: [0001](0001-stack-choices.md) (stack), [0002](0002-agent-only-v1.md) (v1 is agent-only)

## Context

[00-requirements.md](../00-requirements.md) §14 left one question open: *"Does the UI write through the
CLI, or call an in-process library the CLI also wraps? Decide before Phase 5, since it shapes the write
path."* It has now been measured, so it can be answered with numbers instead of taste.

Measured on 2026-10-19, Windows, Node 24.9.0, a project with 10,000 points and a 2.6 MB event log.
Every command through `node src/cli/index.ts`:

| through the CLI | ms | core work, in process | ms |
|---|---|---|---|
| `list` / `state` / `runs` (no real work) | 161–166 | module load (once, at boot) | 43.8 |
| `check` | 172 | read + parse the log | 18.1 |
| `chart`, 10k points → 933 KB SVG | 165 | bind (sort, fold) | 9.2 |
| `import`, 10,000 rows | 265 | extract plottable points | 1.5 |
| `run fit`, uncached | 1202–1327 | render SVG (10,000 circles) | 7.6 |
| `rerun fit` | 1197 | hash the analysis input | 6.7 |

and the entry path itself, five consecutive appends at 10,000 points, in process:

| step | ms |
|---|---|
|---|---|
| append (write + fsync) | 3.0 – 4.8 |
| re-bind the log | 5.1 – 9.3 |
| re-render SVG | 4.6 – 8.5 |
| **keystroke → paint** | **15.7** |

The budget (§6) is keystroke → paint **< 100 ms**, re-render **< 50 ms** at 10k, cold start **< 1.5 s**.

So: the core meets the budget with roughly six times the headroom, and **no command can meet it through
the CLI**, because process startup and loading the CLI already cost more than the entire budget — for a
command that does nothing at all. This is not a micro-optimisation problem. It is a wall, and it sits
between the user and the one interaction the product is most opinionated about.

A second, quieter finding: `bench chart` and `bench run` each built their chart spec by hand, and
`bench rerun` was a copy of `bench run` — 52 of `rerun`'s 85 substantive lines also appeared in `run`,
including the whole "assemble the band, footer and caption" block. That block is the honesty surface.
Two copies of it is two chances to forget one.

## Decision

1. **The core is the API.** `src/core` is imported directly and used in process. A UI, a script, and the
   CLI are all clients of the same modules; no client gets its own path to the log.
2. **All writes go through one seam: `Workspace`** (`src/core/workspace.ts`). Opening a project, reading
   its state, appending a point, correcting one, retracting one, recording a decision, and running and
   recording an analysis are methods on it. The CLI becomes argument parsing, a call, and printing.
3. **`bench` stays the only mutation path for agents and scripts**, and stays the thing requirements and
   AGENTS.md point at. It is a *wrapper over* the seam, not a parallel implementation of it. Its output
   is unchanged, with one exception that is a fix rather than a redefinition: `--dataset <unknown>` is
   now refused by name by every command. `list` used to print an empty table and `chart` used to blame
   the points; both now say the dataset does not exist.
4. **The chart spec carries identity and provenance.** A plotted point may carry the id of the log event
   it came from, and the spec names the dataset and shape it was drawn from. Hover, selection and saved
   views need a stable handle; a spec of anonymous `{x, y}` pairs cannot provide one, and matching by
   value would be a guess.
5. **The analysis path is one function.** `run` and `rerun` differ in where the parameters come from and
   in what they report; they do not differ in how an artifact is rendered or an event is recorded.
6. **No caching in this decision.** `run fit` costs 1.2 s uncached, which is acceptable off the entry
   path (§6, principle 6). Requirement §8's cache stays specified and unbuilt, to be added when a
   measured interaction needs it — the same standard that deferred SQLite.

## Consequences

- The entry path is reachable inside budget (15.7 ms measured, not projected), so the app can be built
  without the core being rewritten underneath it.
- One code path per operation means a fix to the honesty assembly cannot miss the other caller.
- The CLI pays no extra cost: it does what it did before, through a function call.
- `Workspace` must not grow a UI's concerns. It knows about projects, events and artifacts; it knows
  nothing about windows, focus, or rendering to a screen.
- Process lifetime is still the caller's problem: the CLI starts and disposes a Python runner per
  command, which is correct for a command that exits and wrong for a window that stays open. A
  long-lived client holds a long-lived runner; that is why `runAnalysis` takes the runner as an
  argument rather than owning one.
- Identity in the spec means recipes must echo it, so a recipe can no longer return bare `{x, y}`
  points if it wants its chart to be inspectable. Both shipped recipes do.

## Revisit if

- `Workspace` accumulates methods that only one caller uses.
- A long-lived client needs incremental state that re-binding the whole log cannot provide; that is the
  measured trigger for the SQLite projection (§3.5), not a principle.
