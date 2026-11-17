# ADR-0001: Board storage

Status: Accepted

## Context

Papertie keeps one person's board on their own machine. The board is meant to last: it is measured and budgeted at 100,000 notes (about 43 MB of text) and 500 books, and holds up to 500,000 notes. The data must stay readable without Papertie, a crash or a bad write must never lose a change the app has confirmed, and the cost of saving one edit must not grow with the size of the board.

## Decision

**The live store is one JSONL file per board, `board.jsonl`, with the images as separate files beside it.** There is no database. A `.papertie` zip (the same JSONL plus the images) is the export and import format. The file format is described in [`docs/schema/board-v1.md`](../schema/board-v1.md).

### Layout

The desktop app keeps its data in `data/` inside Electron's `userData` directory. In it:

- `local-user.json` holds the id of the one user, made on the first start.
- `users/<userId>/boards/<boardId>/` holds a board: `board.jsonl`, `journal.jsonl`, `summary.json`, `repairs.jsonl`, and the directories `assets/`, `backups/` and `quarantine/`.

Paths are built only from ids the store generated, checked against the id pattern, then resolved and checked to lie inside `users/` (`apps/server/src/store/paths.ts`).

### The snapshot

`board.jsonl` holds, in order: the board record, asset records by id, notes by `(z, id)`, yarns by id, books by `(shelfPos, id)`, blocks by `(bookId, pos, id)`, and a final `eof` record. The `eof` line holds the revision, the record count and a SHA-256 of the lines before it. It detects truncation and edits made by hand. If it is missing or does not match, the board loads through recovery: the damaged file is copied to `quarantine/` and the user is told and offered the latest backup.

Books and their blocks are records of the same board, so the journal, compaction, backups, a restore, the export and the import carry them with the notes.

### Snapshot plus journal

Rewriting 43 MB per edit would make the cost of an edit follow the board's size. So a commit appends one line to `journal.jsonl`, and `board.jsonl` is rewritten only by compaction. Code: `apps/server/src/store/journal.ts`, `compact.ts`, `boardFile.ts`, `boardLoad.ts`, `boardStore.ts`.

- **Commit.** Each batch becomes one journal line, `{rev, ops, now, origin, crc}`, replayed with core's `commitBatch`. A group of waiting batches is one write and one fsync, then the acknowledgements. `crc` is the hex of the first 8 bytes of the SHA-256 of the line without it. Nothing on the commit path depends on the board's size.
- **Which snapshot a journal belongs to.** The journal also holds base lines, `{snapshot, sha256, crc}`, naming a `board.jsonl` by its revision and the `sha256` of its `eof` record. A rotated journal starts with one, and a compaction appends one for the new snapshot before renaming it into place. The journal is replayed only over a `board.jsonl` one of its base lines names.
- **Compaction** runs at once when the journal passes 4 MiB (`JOURNAL_MAX_BYTES`) or 2,000 commits (`JOURNAL_MAX_COMMITS`), or when a commit lands in a UTC hour that has no backup yet. Otherwise it runs after 60 s without a commit (`COMPACT_IDLE_MS`) when the journal is not empty. It takes the current state (the maps are persistent, so later commits leave that copy alone), serializes it outside the board's lock in slices, writes `board.jsonl.next` and fsyncs it, then under the lock appends the base line, renames the new snapshot over `board.jsonl`, fsyncs the directory and rotates the journal. Before the rename it checks that `board.jsonl` is still the file the store last wrote or loaded; a file edited by hand meanwhile is reloaded through recovery instead.
- **Load.** The load replays the journal lines above the snapshot's revision, so a crash between the rename and the rotation doubles nothing. An incomplete final line (no trailing newline) is an append the process died in; it was never acknowledged and is cut off. A complete line that fails its checksum or does not parse may have been acknowledged: it is copied to `quarantine/`, and the board loads as *repaired* with a notice that counts the commits set aside.
- **A `board.jsonl` no base line names** was edited, replaced or removed by hand. It loads through recovery and the journal moves to `quarantine/`.
- **Canonical.** `board.jsonl` is the whole board whenever the journal is empty, which is within about a minute of the last edit. A stopped app leaves its journal, and the next start replays it. Export always serializes the current state.

### Backups

- A backup is the new snapshot of the first compaction in each UTC hour that has edits, written as a file of its own in `backups/` (never a hard link to `board.jsonl`).
- Retention (`selectBackupsToDelete`, `backups.ts`): everything for 48 hours, then the newest per day for 30 days, then the newest per ISO week for 183 days. The newest backup is always kept.
- A restore or an import first takes a safety backup, marked `backups/<name>.safety`. Retention keeps a marked backup for at least 30 days, and the newest marked one for as long as it is the newest.
- Backups are on the same disk as the board. They protect against crashes, corruption and mistakes, not against losing the disk. Papertie has no off-machine backup; the user's own backup of the data folder covers that.

### Assets

- A photo is stored as WebP variants (long edge 2560, 1024 and 256 px) under `assets/<assetId>/`, re-encoded on the way in. Asset files are immutable and referenced by id.
- **The sweep** (`assetSweep.ts`, `assetSweeper.ts`) collects an asset only when it is at least 30 days old (`ASSET_GRACE_MS`), no note or figure on the board shows it, and no retained backup shows it, so a restore always finds its photos. It runs at most once per board every 23 hours, only for a board that is already loaded, and never on a request's path.
- The sweep works in two runs: the first commits `asset.remove` for the record, and a later run deletes the directory once no record names it. The commit re-checks that nothing shows the asset, so an undo that brought a note back in between makes the batch fail whole and the next run tries again.
- A restore drops the record of an asset whose files are gone, with the image of every note that showed it, and logs each in `repairs.jsonl`.

### Import

An import replaces the board, after its safety backup, through the same install as a restore. It refuses a file with more than 500 books (`too-many-books`), more than 60,000 blocks in one book (`too-many-blocks`), a block whose book is missing (`missing-book`), a book over the text limit (`book-too-long`), or a figure naming an asset the file does not hold (`missing-asset`). A book's `cards` (the notes its blocks name) is derived, so the import recomputes it and never takes the file's value. Photos are re-encoded under new ids.

### Deleted books

A deleted book keeps its blocks for 30 days (`BOOK_TRASH_MS`) and can be put back whole. After that the purge (`bookPurge.ts`) removes its blocks in `block.purge` commits of at most 500, then the book. Each purge commit checks that the book is still deleted and due.

### Reading without blocking

Every job that walks the whole board or a whole book yields to the event loop through one queue (`Slicer`, `compact.ts`): compaction, a cold load, the region index build, whole-board serialization, import, a book stream, the asset sweep's scans. A slice ends after 4 ms of wall time (`SLICE_MS`), and each event-loop turn wakes only the job that has waited longest. The app's store runs in Electron's main process, so a long block there would stall the window.

- **Serialization** writes records straight into 128 KiB buffers. A whole-board read and both exports stream those buffers as they are.
- **A whole-board read is the snapshot without blocks**: the file's lines up to its first `block` line, then an `eof` computed over those lines. A book's blocks are read on their own (`GET /api/boards/:id/books/:bookId`, `bookStream.ts`).
- **A cold load** reads `board.jsonl` as bytes, decodes it 64 KiB at a time and parses it line by line (`BoardParser`), replays the journal in slices and builds the region index in slices.
- **Clean files skip the per-record schema check.** In a file whose `eof` checksum vouches for every line, a record whose keys are all known to the schema is taken as it parses. If the checksum fails or the parse reports any issue, the whole file is parsed again with every check. This is why `CURRENT_SCHEMA_VERSION` must be raised by any change to the values a record may hold (see `packages/core/src/schema/version.ts`).
- **The kept summary.** When the store drops a loaded board in good order it writes `summary.json` (name, revision, times, and the stamps of the two files it describes), so listing boards does not parse a board that is not loaded. It is a cache: it is used only while both files still carry those stamps.
- **A region answer** of at most 4,096 notes (`REGION_INLINE_NOTES`) takes its first slice in the request's own turn; a larger one queues like any other job.

### Crash safety

The crash suite (`apps/server/test/crash/`) kills the store with SIGKILL at every journal and compaction fault point, and at the fault points of the sweep, the import and recovery. After each kill the board holds exactly the acknowledged batches. An unacknowledged batch is either there (its retry is a duplicate) or not (its retry applies), never applied twice.

## Consequences

- The board stays human-readable and portable. Anyone can read `board.jsonl` with a text editor.
- A commit costs one journal append and one flush whatever the board's size. On macOS, Node's `FileHandle.sync()` is a full flush (`F_FULLFSYNC`), a few milliseconds on an SSD.
- Measured on a Mac laptop with a 100,000-note board: a compaction takes about a quarter of a second in total with no slice longer than about 4 ms, and a cold load parses about 30 MB in roughly half a second, sliced the same way. The budget is no event-loop block over 50 ms.
- Export and backup must carry the assets as separate files.
- The board is whole on disk only together with its journal; tools that read `board.jsonl` directly see the state as of the last compaction.
- A build refuses a board of another schema version whole. Nothing is converted.
- Encryption at rest is left to the operating system's disk encryption.

## Alternatives considered

- **Images as base64 inside the one file.** Self-contained, but every write would carry every image, memory use would be higher, and a bad write would risk more. Rejected.
- **A database with JSONL export.** Incremental updates would be easier, but JSONL would then be only an exchange format and the live data would not be readable without the app. Rejected.
- **Rewriting the whole file on every commit.** Simple, and fine at 1,000 notes (about 0.5 MB). At 100,000 notes each edit would write 43 MB, so commits go to the journal.
