# ADR 0015 — The window speaks to the person; the log speaks to the agent

Date: 2026-10-20
Status: accepted
Supersedes: [ADR 0005](0005-desktop-shell.md) item 5, "the tooltip shows the id". It also changes the
import-time rule in [ADR 0012](0012-dataset-versions.md) and [ADR 0014](0014-observation-time.md) from
*refuse without a time column* to *state the assumption, let it be corrected*.
Related: [0011](0011-import-door.md) (import door), [0006](0006-window-write-path.md) (write path),
[0007](0007-freshness-before-writes.md) (freshness)

## Context

The first window was built by people reading the log. Its tooltip showed the record's ULID and the
dataset and shape ids; the strip repeated the dataset, the recipe and `n`; statuses quoted event names
such as `point_corrected`; a stale panel carried a `bench view render --refresh` command; an import
plan read `version 5 replaces version 4 · +1 −0 ~0`. Every one of those facts is true and auditable,
and every one of them was chosen because it is what the *log* calls the thing.

The person using the window does not have that vocabulary, and does not need it. They need to know
what they are looking at, whether it is trustworthy, and what to do next. The agent — which reads and
writes the log — needs the ids, event names, versions and hashes. Mixing the two audiences is what
made the first UI feel like a debug view: it is precise about things the user cannot use and vague
about the one thing they can (what this number means, and whether they should care).

The same confusion produced the retraction question. The log keeps every correction and retraction
forever, which is right; the window then treated every small mistake as an audit event worth
describing, asking for a reason and printing back a `point_retracted` sentence. The user's stance is
the opposite: **a mistake should be easy to take back, not a ceremony to record.** Integrity is the
agent's job; recoverability is the window's.

Finally, the review log asked for approval of frames described in internal terms — "Chart renderer v1",
"the `current` badge", "the strip reads `main · v2, v4`". A person cannot approve what they cannot
read, and a gate that cannot be read is not a gate.

## Decision

**1. Two audiences, two vocabularies.** Anything the window shows a person is stated in their terms:
values, units, what changed, what to do. Record ids, event names, dataset versions, shape ids and
recipe hashes are agent vocabulary. They may be *copied* for a conversation, or shown in an explicitly
expanded technical detail, but they are never the primary label and never the thing a tooltip leads
with.

**2. A hover answers "what is this point?" in one line.** The tooltip shows the measured values with
their labels and units, plus the observation time when it is not already an axis. No ULID, no dataset
name, no shape id. The full record — including its id and the dataset it belongs to — is available
from the point's own menu, "Copy details", because the reason to know an id is to paste it into a
conversation with the agent.

**3. Recoverable outranks recorded.** Undo and redo cover every reversible action a person can take
in the window: adding a point, removing a point, correcting a point, deleting a tab, and importing a
file. Undo is one gesture, and it writes only what the log needs to explain the new state — usually
one event, no event at all for a deleted tab, and a version with its row events for an import. The
window does not ask for a reason for a routine mistake, and it does not narrate the event it wrote.
The log still records the act, because the log is the truth and a retraction that is not recorded is
indistinguishable from data loss. What is dropped is the *ceremony around the record*, not the record.

An import is a dataset version, and **non-negotiable 7 forbids deleting one**. Its undo is therefore
a *revert version*: a new version holding the parent's rows, with a diff that says what it restored.
Redo appends the imported rows again as another version. The history names these actions **Restore
version 3** and **Reapply import**, and the version number moves forward in both directions. The
person gets their data back; the log never loses a version.

**4. The agent asks before it acts on an assumption, and says what it did afterwards.** A guessed time
column, a missing unit, a synthetic instant for a file with no clock, a field the file did not carry:
each is an assumption, and each is stated in one sentence before the write and summarised after it.
When the user and agent are aligned, the agent may fill the gap; it may not fill it silently. The
window applies the same rule in miniature: it preselects the time column it believes, says so in one
line, and offers to change it — rather than making a person choose from a dropdown before it will
plan anything.

**5. Explain in place, at the level of the consequence.** Every status word that is not self-evident
(`tentative`, `stale`, `insufficient`, `degrees of freedom`) carries a hover sentence saying what it
means *for the reader*: why this is uncertain, what would strengthen it, and what they can do. A badge
that is merely true ("current") and asks nothing of the reader is not shown at all.

**6. Actions are buttons; commands are for the agent.** A state the window can fix is fixed with a
control, or fixed automatically when fixing it is cheap and safe. A CLI command may appear inside a
collapsed "for agents" detail, never as the only way forward. A stale plot panel refreshes itself
after a write; a stale recipe panel offers **Refresh** and says why it will not rerun by itself.

**7. One fact, once.** A fact appears at the level where it applies: the tab name in the stage header,
the panel's own `n` in the panel, the dataset's size once when panels disagree. Duplicate facts are
removed, not restyled. A dataset named `main` in a project with one dataset is not information.

**8. The review gate is readable or it is not a gate.** A frame's row states, in plain language: what
this screen is for, the one thing to check, what "wrong" looks like, and the decision the user is
being asked for. Internal names are not allowed in the "what to look at" column. The user may close a
batch of frames by stating a direction instead of approving them one by one; that is recorded in
[`docs/ui-review-log.md`](../ui-review-log.md) with their words, and it is a decision about the
direction, not a claim that every pixel was inspected.

## What this changes concretely

| surface | before | after |
|---|---|---|
| point tooltip | ULID, `x 3  y 8.09`, `main · xy.v1` | `x 3`, `y 8.09` with units; time only if not on an axis |
| point menu | selection ring, then a correction row | **Copy details**, **Correct…**, **Remove** |
| remove a point | reason prompt, `point_retracted` sentence | one action, undoable, silent beyond "Removed · Undo" |
| undo | last point only, cannot be redone | full history for add / remove / correct / import / tab delete |
| stale panel | badge `stale` + a CLI command in the notice | "Out of date — drawn from v2, data is at v4" + **Refresh** |
| current panel | badge `current` | no badge: nothing to do |
| verdict | `tentative` pill | `Tentative` with a hover: why, what would strengthen it |
| import time | a required picker row, refusal without it | preselected guess, one sentence, **Change**, or an explicit estimated fallback |
| import plan | `version 5 replaces version 4 · +1 −0 ~0` | "1 row added, 0 removed, 0 changed" and a version in **Details** |
| empty tab | `bench … view render` / `add --values` | **Add a point**, **Create a tab…**, **Import…** |
| rail | fixed width, three buttons spread apart, `New…` / `Open…` | resizable, collapsible, `New project` / `Open project` in one group |
| tab | title + dataset + panel count | title, and the facts that differ |

## Consequences

- The core needs one new event, `point_restored`, so undoing a removal brings the *same* record back
  instead of re-recording the values under a new id. That is the one addition to the log this decision
  requires; everything else undo needs is already recorded.
- Undoing an import adds a version rather than removing one. That is a deliberate consequence of
  non-negotiable 7, and the UI must say "restore" rather than imply a rollback.
- `docs/05-user-surface.md` is the register: every observation from the 2026-10-20 review, the decision
  taken, and the roadmap id that implements it. The roadmap's §6 is the work list.
- The UI copy in `app/renderer` is now a first-class surface with a testable rule: no raw id, no event
  name, no version list and no CLI command in a primary label or a status line.
- The review log's historical rows stay as evidence but their verdicts are closed by direction; new
  rows follow the protocol in item 8.
- Two earlier ADRs are narrowed rather than reversed: the log is still append-only and still the
  truth; the window still never writes outside `Workspace`. What changes is who the window is written
  for.

## Revisit if

- Copying details for a conversation proves insufficient and people need to see ids on screen. Then
  show them in an explicitly opened "record" popover, not on hover.
- Undo/redo needs to span sessions (closing the window loses the stack). That is a new decision about
  app state, not a quiet extension of this one.
- A stale panel's automatic refresh becomes expensive enough to break the entry-path budget; then it
  moves behind the button, and the button says why.
