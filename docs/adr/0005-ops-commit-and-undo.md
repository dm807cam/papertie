# ADR-0005: Ops, the commit and undo

Status: Accepted

## Context

Papertie is one window writing to one store on the same machine. The window (the page) and the store still sit on two sides of a request: the page must show an edit at once, the store must make it durable, and the store also changes the board on its own (it takes in a photo, sweeps an unused one, purges a deleted book) or replaces it whole (an import, a restore, a recovery). Undo, saving and validation need to share one model of a change so they cannot disagree.

## Decision

### One op model

Every change is an op. `packages/core/src/ops/` defines them and provides `apply`, `invert` and the invariant check:

- notes: `note.create`, `note.update`, `note.delete`
- threads: `yarn.create`, `yarn.update`, `yarn.insertNote`, `yarn.removeNote`, `yarn.delete`
- the board: `board.update`
- books: `book.create`, `book.update`
- blocks: `block.create`, `block.edit`, `block.set`, `block.split`, `block.merge`, `block.delete`
- the store's own: `asset.add`, `asset.remove`, `book.cards`, `book.purge`, `block.purge`

Threads are edited with list ops, never by replacing `noteIds`; field updates set only the fields they name. One gesture is one batch: a whole drag is one `note.update` at pointer-up, and typing coalesces per editing session.

Core's `BoardState` maps are persistent maps (`packages/core/src/pmap.ts`): an edit copies the root and the buckets it touches, so a commit costs the same at 100,000 notes as at 100.

### The commit

The page posts a batch to `POST /api/boards/:id/ops` as `{clientId, seq, baseRevision, ops}`. The store (`apps/server/src/store/boardStore.ts`):

- validates the schema and applies the batch whole or refuses all of it. The invariant check refuses only violations the batch introduces, so a board that already breaks one stays editable;
- stamps it with the commit's time and revision. It may add ops of its own to the batch: the time a book was deleted, and `book.cards` for a book whose set of cited cards changed;
- appends it to the journal and acknowledges it only once that is durable ([ADR-0001](0001-storage.md));
- records `{lastSeq, lastRevision}` for the page's `clientId` in the board record. A batch whose `seq` is not above `lastSeq` is answered with the stored acknowledgement instead of being applied again, so a retry after a lost answer is safe. Marks older than 90 days are pruned.

A batch made against an older revision commits as posted, with two exceptions:

- **`409 block-stale`**: a block it names changed after its base, or the board was replaced since. Its text splices count from text that is no longer there. The page reads the book again.
- **`422 rejected`, code `conflict`**: a move of a card into a book (block creates with a `note.delete`) whose card, or a thread on it, changed after its base.

**Staged transactions.** A batch over 1 MiB or 500 ops is sent as parts (at most 64). The parts wait in the store's staging area and the last one to arrive commits all of them as one revision. The parts carry a content digest so a mixed-up set is refused.

### The page's client

`apps/web/src/sync/SyncClient.ts` keeps two boards:

- **`confirmed`**, the store's board, built from the store's commits exactly as the store builds it (core's `commitChanges`);
- **`view`**, `confirmed` with this page's edits not yet committed on top. The page shows `view`.

`submit` is synchronous: it applies the ops to `view` and queues them. Edits are sent one at a time, oldest first, each against the confirmed board, and the next goes once the one before is in it. Nothing is rebased.

- **The typing window.** Batches with the same coalesce key merge while unsent. Such an edit is sent 600 ms after its last keystroke and never later than 3 s after it opened.
- **Failures.** A request that fails for a passing reason is tried again with a backoff; the save indicator says so. An edit the store refuses for good is dropped as a whole batch, never op by op: the user sees a notice, and its content stays available in the unsaved-changes download (the ops as JSONL, and typed book text as Markdown).
- **Edits made while the board opens** are held in order, shown on what is painted, and submitted once the board is in.

### The event stream

`GET /api/boards/:id/events` is a Server-Sent Events stream of the board's commits, in order. It is how the confirmed board advances:

- the page's own commit leaves the queue when its event arrives; if the acknowledgement came but the event has not after 2 s, the page asks for the commits since its revision (`GET /api/boards/:id/ops?since=`), which the store answers from an in-memory ring of recent commits;
- the store's own commits (a photo taken in or swept, a deleted book purged) arrive the same way and are applied under the page's pending edits. A pending edit that no longer applies is dropped as above;
- a `reset` event means the board was replaced (an import, a restore). The page reads the board whole again, and the books it had open are read again.

### Undo and redo

`apps/web/src/history/UndoStack.ts` is the one history for the board and the books.

- A recorded batch is kept as its inverse ops, never as a copy of the board. The stack holds 200 steps, in memory only.
- A typing session (one coalesce key) is one step.
- Undo applies the inverse to the board **as it is now**. An op that no longer applies (its note was swept, its paragraph is gone) is skipped and counted, and the skip is announced quietly. Redo mirrors it.
- An undo or redo is itself a batch, committed like any edit.
- In a book, a step's splits and moves are given positions against the book as it is when the step is applied (`fitBatch`, `packages/core/src/book/rekey.ts`).
- The store's asset ops are never in an inverse: assets are collected by the sweep, not undone.

### When the page goes away

Unsent edits live in the page's memory only. On `visibilitychange` to hidden and on `pagehide` the client flushes, typing included. On `pagehide` every edit not yet sent also goes as one `keepalive` request when its body is under 60,000 bytes, so the edits land together or not at all (`sync/unload.ts`).

## Consequences

- Validation, saving and undo run on the same ops, so what the page shows after a commit is what the store holds.
- The page never merges or transforms: with one writer, an edit is either applied as made or refused whole. The cost is the two refusals above, which are met only when the store changed the board under an edit.
- A crash of the app within the typing window loses at most those keystrokes (up to 3 s). Everything acknowledged is durable.
- Undo history does not survive closing the window.
- Undo can skip part of a step after the store changed the board (for example, a note's photo was swept). The user is told.

## Alternatives considered

- **Sending whole records or whole boards instead of ops.** Simpler, but undo would need snapshots, and a thread edit would overwrite the whole list.
- **Rebasing the page's pending edits over newer commits (operational transform).** Needed when several writers edit the same text. Papertie has one writer, so a stale block edit is refused and the book read again instead.
- **Keeping unsent edits in a browser database.** Would survive a crash inside the typing window, at the price of a second store to keep consistent with the first. The window is at most 3 s, so they stay in memory.
- **Undo by restoring a previous state.** Would also revert what the store did in between (a sweep, a purge). Undo applies inverses to the current state instead.
