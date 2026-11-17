# ADR-0002: Yarn semantics

Status: Accepted

## Context

A piece of yarn ties notes together, but what it means has to be fixed: it shapes the data model, the editing UI and focus mode. A collection of several notes could be one strand through all of them, a strand between every pair, or strands from a hub.

## Decision

- **One thread, pin to pin.** A `yarn` record has an ordered `noteIds` list and is one strand winding through those notes. A thread joining two notes is the simple case.
- **The whole thread is one group.** Every note on a thread is one step from every other note on it. The thread is the collection, and focus mode walks this membership graph.

Rules that follow:

- **Hard invariants.** A thread has at least 2 notes, no note twice, and every `noteId` exists. Every op preserves these and a batch may not introduce a violation. On load and on import, dangling references are repaired and reported rather than rejected.
- **Redundant ties are a UI rule, not an invariant.** If the user ties two notes that already share a thread of that colour, the UI selects that thread and pulses it instead of creating a new one (`apps/web/src/yarn/yarnFlows.ts`). Two different threads may still share a pair of notes: a different colour or label is a different relationship.
- **Deleting a note closes the strand up.** Deleting B from A-B-C leaves A-C. A thread left with fewer than 2 notes is deleted. All of this is one undoable batch.
- **Threads are edited with list ops** (`yarn.insertNote`, `yarn.removeNote`), never by replacing `noteIds` whole, so each edit says exactly what it changed and inverts cleanly for undo (see [ADR-0005](0005-ops-commit-and-undo.md)).
- **Focus is computed, never stored.** It is a breadth-first search over the membership graph from the seed notes (`packages/core/src/graph/`), depth 1 by default, up to 3, or the whole connected component.

## Consequences

- Winding A→B→C is one record, not two, and the UI offers one popover with an ordered note list.
- Membership is simple to explain and to test: a thread with n notes makes all n mutually one step apart, so focus at depth 1 on any note shows its whole thread.
- Position within a thread has no meaning for focus distance, only for how the strand is drawn.
- A large thread connects many notes at once, so focus at depth 1 can reveal a lot of the board.
- Because redundant ties are not an invariant, the data can hold overlapping threads, and an import must accept them.

## Alternatives considered

- **Pairwise strands**: one yarn per pair of notes. A group of n notes would need n(n−1)/2 records that the user must keep consistent by hand. Not chosen.
- **Hub and spoke**: a central point with strands out to the members. It needs a hub that is not a note. Not chosen.
