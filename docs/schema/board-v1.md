# Papertie board format

A Papertie board is stored as **canonical JSONL**: one JSON object per line, UTF-8, every line terminated by `\n`. This document describes `schemaVersion: 6`, as implemented by `@papertie/core`. A file whose `schemaVersion` is any other number is refused whole (see [Versions and strictness](#versions-and-strictness)); nothing is converted.

The machine-readable form is [`board-v1.schema.json`](./board-v1.schema.json). It is generated from the same Zod schemas the code validates with (`pnpm --filter @papertie/core gen:schema`, and `... gen:schema --check` to verify it is current). It has two entries: `line` (any board line) and `op` (any mutation op). JSON Schema cannot express every rule (see [What the JSON Schema cannot express](#what-the-json-schema-cannot-express)); this document and the code are authoritative where they differ.

## Conventions

| Thing | Rule |
|---|---|
| IDs | `<prefix>_<ULID>`. Prefixes: `board`, `note`, `yarn`, `asset`, `tab`, `book`, `block`. Pattern: `^[a-z]+_[0-9A-HJKMNP-TV-Z]{26}$`. Each id field requires its own prefix (a `note` id must start `note_`). |
| Timestamps | ISO-8601 UTC ending in `Z`, e.g. `2026-10-27T10:00:00.000Z`. Fractional seconds are optional. Offsets such as `+02:00` are rejected. |
| Colours | Stored as palette token names, never hex: `cream`, `rose`, `apricot`, `indigo`, `sage`, `lilac`, `ochre`, `ink`. |
| Paper styles | `rustic`, `smooth`, `print`. |
| Image frames | `none`, `print`. |
| Motifs | `fold`, `margin`, `dots`, `perforation`. |
| Cover motifs | `fields`, `overprint`, `contour`. |
| Cover inks | `rose`, `indigo`, `sage`, `lilac`, `ochre`, `ink` (palette tokens). |
| Block kinds | `p` (paragraph), `h1` (chapter title), `h2` (section title), `quote`, `li` (list item), `prompt`, `figure`, `footnote`. |
| Position keys | Base-62 digits `0-9A-Za-z`, 1 to 128 of them, never ending in `0`; compared as strings (by UTF-16 code unit). See [Position keys](#position-keys). |
| Strictness | Every record is `.strict()`: an unknown or misspelled field makes the record invalid (see [Versions and strictness](#versions-and-strictness)). |
| Numbers | Finite JSON numbers only. A value such as `1e400` (which overflows to infinity) is invalid. |

### Limits

| Limit | Value |
|---|---|
| Note text | at most 20,000 characters (counted as UTF-16 code units, as JavaScript `String.length`) |
| Notes per board | at most 500,000 |
| Ops per batch | at most 500 |
| Thread label | at most 80 characters |
| Notes per thread | at most 200 |
| Note width `w` | 120 to 2000 |
| Note (minimum) height `h` | 60 to 4000 |
| `x`, `y` | within +/-10,000,000 |
| `z` | integer |
| Books per board | at most 500, deleted ones included until they are purged |
| Book title | at most 200 characters (may be empty, shown as "Untitled") |
| Block text | at most 20,000 characters |
| Blocks per book | at most 60,000 |
| A book's text | at most 4,000,000 characters, all its blocks together |
| Marks per block | at most 2,000 (a mark every 10 characters of the longest paragraph; bounds what one `block.edit` carries through its splices) |
| Splices per `block.edit` | at most 1,000 |
| Position key | at most 128 characters |
| Blocks per `block.purge` | at most 500 |

## Records

### `board` (exactly one, first line)

| Field | Type | Limits | Meaning |
|---|---|---|---|
| `type` | `"board"` | | Record discriminator. |
| `schemaVersion` | `6` | literal `6` | Format version. Any other number is refused, see [Versions and strictness](#versions-and-strictness). |
| `id` | `board_` id | | Board id. |
| `name` | string | 1 to 120 characters | Display name. |
| `revision` | integer | >= 0 | Commit counter; increases with each committed op batch. Repeated in `eof`. |
| `clients` | object | keys are `tab_` ids | Idempotency marks, one per page that has written to the board (each time the app's window loads it takes a new `tab_` id): `{ "<tab id>": { "lastSeq", "lastRevision", "seenAt" } }`. A replayed batch with `seq <= lastSeq` returns the stored ack instead of re-applying. |
| `clients[*].lastSeq` | integer | >= 0 | Highest batch `seq` applied from that page. |
| `clients[*].lastRevision` | integer | >= 0 | Revision at which that batch was committed. |
| `clients[*].seenAt` | timestamp | | When that page last committed. Entries older than 90 days are pruned by the store. |
| `createdAt` | timestamp | | Creation time. |
| `updatedAt` | timestamp | | Time of the last change. |

### `asset` (zero or more)

An image stored beside the board file. The asset record describes the already re-encoded image; the bytes live in `assets/`.

| Field | Type | Limits | Meaning |
|---|---|---|---|
| `type` | `"asset"` | | Record discriminator. |
| `id` | `asset_` id | unique | Asset id. |
| `mime` | `"image/webp"` | literal | Uploads are always re-encoded to WebP. |
| `width` | integer | >= 1 | Pixel width. |
| `height` | integer | >= 1 | Pixel height. |
| `bytes` | integer | >= 1 | Size of the stored file in bytes. |
| `sha256` | string | 64 lowercase hex characters | Hex SHA-256 digest of the asset. |
| `createdAt` | timestamp | | Upload time. |
| `rev` | integer, optional | >= 0 | The board `revision` this record last changed at. Set by the store when it commits; always the last key. See [Record revisions](#record-revisions). |

### `note` (zero or more)

| Field | Type | Limits | Meaning |
|---|---|---|---|
| `type` | `"note"` | | Record discriminator. |
| `id` | `note_` id | unique | Note id. |
| `x`, `y` | number | finite, `abs(v) <= 10,000,000` | Position on the infinite board. |
| `w` | number | 120 to 2000 | Width, set by the user. |
| `h` | number | 60 to 4000 | Minimum height; the note grows with its content. |
| `z` | integer | | Stacking order (higher is in front). Notes are written in `z` order. |
| `paper` | palette token | one of the eight tokens | Paper colour. |
| `style` | `rustic` / `smooth` / `print` | | Paper style. |
| `text` | string | at most 20,000 characters | Plain Unicode text with line breaks. May be empty. |
| `image` | object or `null` | | Optional attached image, shown above the text. |
| `image.assetId` | `asset_` id | must name an `asset` record | The image. |
| `image.frame` | `none` / `print` | | Frame style. |
| `motif` | motif, optional | omitted when none | The decoration drawn on the paper: `fold` (a folded corner), `margin` (a margin rule), `dots` (a dot grid) or `perforation` (a perforated top edge). |
| `stamp` | `true`, optional | `true` or omitted, never `false` | The stamp, a string tie in crimson, in the bottom-right corner. |
| `layered` | palette token, optional | omitted when none | A second sheet of this paper layered behind the note. |
| `from` | object, optional | `{ book, block }`: a `book_` id and a `block_` id, no other key | The book and block the card was made from. Nothing checks that they still exist (a book can be purged later). |
| `ref` | string, optional | trimmed, 1 to 2,000 characters, line breaks allowed | The note's reference, free text. Shown at the note's bottom; a card with a ref dropped into a book lands as a quote with the ref as its footnote. |
| `createdAt` | timestamp | | Creation time. |
| `updatedAt` | timestamp | | Time of the last change. |
| `rev` | integer, optional | >= 0 | The board `revision` this record last changed at. Set by the store when it commits; always the last key. See [Record revisions](#record-revisions). |

The three decoration fields (`motif`, `stamp`, `layered`) are written after `image`, in that order. **Absent means none**: a note without decoration has none of these keys. `from` and `ref` follow them, in that order, and are absent when there is none. `note.update` removes any of the five with a `null` patch value (`{"set":{"motif":null}}`); the key is then absent, never stored as `null`.

A note whose `image.assetId` has no matching `asset` record is repaired on load (the image is set to `null` and the repair is reported).

### `yarn` (zero or more)

A thread (yarn) is **one strand winding through an ordered list of notes**. See [Thread semantics](#thread-semantics).

| Field | Type | Limits | Meaning |
|---|---|---|---|
| `type` | `"yarn"` | | Record discriminator. |
| `id` | `yarn_` id | unique | Thread id. |
| `noteIds` | array of `note_` ids | 2 to 200 entries, no duplicates | The notes on the thread, in winding order. |
| `color` | palette token | one of the eight tokens | Yarn colour. |
| `label` | string | at most 80 characters | Relationship label. May be empty. |
| `pins` | object, optional | keys are `note_` ids on this thread; values match `^[0-9A-Za-z_-]{1,32}$`; never empty | Shared pins: which pin the thread is tied at on a note. Written after `label`; absent means every end has its own edge pin. See [Shared pins](#shared-pins). |
| `createdAt` | timestamp | | Creation time. |
| `updatedAt` | timestamp | | Time of the last change. |
| `rev` | integer, optional | >= 0 | The board `revision` this record last changed at. Set by the store when it commits; always the last key. See [Record revisions](#record-revisions). |

### `book` and `block`

See [Books](#books).

### `eof` (exactly one, last line)

| Field | Type | Limits | Meaning |
|---|---|---|---|
| `type` | `"eof"` | | Record discriminator. |
| `revision` | integer | >= 0 | Equals the board's `revision` when written. |
| `records` | integer | >= 0 | Number of lines before the `eof` line. |
| `sha256` | string | 64 lowercase hex characters | Checksum of those lines, defined below. |

## File layout

**Line order:** `board`, then `asset` sorted by id, then `note` sorted by (`z`, `id`), then `yarn` sorted by id, then `book` sorted by (`shelfPos`, `id`), then `block` sorted by (`bookId`, `pos`, `id`), then `eof`. The file ends with `\n`.

Sorting compares by UTF-16 code unit (not locale), so every platform writes the same bytes for the same board. Serializing the same state twice yields identical text.

**`eof.sha256`** is the lowercase hex SHA-256 of the UTF-8 bytes of every preceding line, each followed by `\n`. **`eof.records`** is the number of preceding lines.

The `eof` line detects truncation and hand-edits. It is a checksum, not a signature: it does not defend against someone who recomputes it.

## Thread semantics

- Every note on a thread is one step from every other note on it (a **membership graph**): the thread *is* the collection, and focus mode traverses this graph. `noteIds` is ordered (the strand's winding order) but order does not change who is adjacent to whom.
- **Thread invariants** (checked after every op batch): a thread has at least 2 notes, no note appears twice on one thread, and every `noteId` names an existing note. `validateInvariants` also checks three non-thread kinds: `missing-asset` (a note image names a missing asset), `too-many-notes` (more than 100,000 notes) and `id-prefix` (an id or map key with the wrong prefix). Every op preserves them, and a batch is rejected only if it *introduces* a violation the state did not already have. On load, violations are not rejected: `parseBoard` repairs dangling references and reports each as a `dangling-reference` issue (see [Integrity states](#integrity-states)). It does not enforce board-wide limits, so a loaded state is not always invariant-valid: a file with more than 100,000 notes loads with a `too-many-notes` violation and stays editable (edits and deletes are accepted; creating another note is refused with `limit`).
- Two different threads may share notes; different colours or labels are different relationships. Preventing a redundant tie between two notes already on the same thread is a UI rule, not an invariant.
- Threads are edited by list ops (`yarn.insertNote`, `yarn.removeNote`), never by replacing `noteIds` wholesale, so each edit says exactly what it changed and inverts cleanly for undo.
- **Deleting a note closes up each thread:** the note is removed from every thread that contains it, and the strand closes up (A-B-C minus B gives A-C). A thread left with fewer than 2 notes is deleted. This happens in one undoable batch.

### Shared pins

Without `pins`, each end of a thread on a note is tied at an edge pin of its own, placed by the app on the edge facing the neighbouring note. `pins` maps a note on the thread to a **pin key**:

- `"hanging"`: the thread is tied at the note's own hanging pin (the brass pin holding the paper to the cork; on a narrow tag, its hook).
- Any other key (a short string the app makes): a pin the thread shares with every other end on that note carrying the same key, of this thread or of others. They are drawn as one pin.

A note in the middle of a thread uses its key for both of its segment ends there (the strand passes round that pin). `yarn.update` replaces the whole map, and `{"set":{"pins":null}}` removes it. Entries naming notes that are not (or no longer) on the thread are dropped when the update applies, and a map left empty removes `pins`: a map built before one of its notes left the thread, or an undo that puts one back, still applies. A record itself never names a note off its thread. Taking a note off a thread (`yarn.removeNote`, or deleting the note) drops its entry, and `pins` itself when that was the last one; undo restores it. Loading repairs a thread's missing notes the same way.

Where a shared pin is drawn is the app's choice, not part of the format. The app keys a pin after the thread end that held it before others joined (`y`, that thread's 26-character id tail, then `n` for its end toward its next note or `p` toward its previous one), and that end goes on placing the pin, so it does not move as threads join it.

## Books

Books live in the board's own file, in the same unit as the notes (one journal, compaction, backups, History restore and the `.papertie` export). A book is a `book` record; its text is its `block` records, one per paragraph, heading, quote or list item, in `pos` order.

### `book` (zero or more)

| Field | Type | Limits | Meaning |
|---|---|---|---|
| `type` | `"book"` | | Record discriminator. |
| `id` | `book_` id | unique | Book id. |
| `title` | string | at most 200 characters | The title; empty shows as "Untitled". |
| `lang` | `de` / `en` | | The book's language: its quotation marks, chapter label and the page's `lang`. |
| `shelfPos` | position key | | Where it stands on the shelf. |
| `cover` | object | | The cover, drawn from these: fibre ground, the motif in the ink and a second ink the seed picks. |
| `cover.seed` | integer | 0 to 4,294,967,295 | Random at creation, fixed afterwards ("New cover" draws a new one; renaming keeps it). |
| `cover.ink` | cover ink | | The motif's palette ink. |
| `cover.motif` | cover motif | | The family of drawing: `fields` (flat rectangles of colour), `overprint` (discs and bars in two inks) or `contour` (level lines or grain). |
| `trashedAt` | timestamp or `null` | | When it was deleted (`null`: on the shelf). Deleting is setting it and putting back is setting it `null`, so both undo in one op; the store purges a book 30 days after `trashedAt`. |
| `createdAt` | timestamp | | Creation time. |
| `updatedAt` | timestamp | | Time of the last change to the book record itself. |
| `cards` | array of `note_` ids, optional | sorted, unique, at most 60,000; omitted when none | The notes its blocks name (card marks, figures' `image.card`). Derived, see [Cards in books](#cards-in-books). |
| `rev` | integer, optional | >= 0 | The last revision **anything in the book** changed at: every block op stamps its book, so the app can tell whether the blocks it has read for a book are current from the book record alone. |

### `block` (zero or more)

| Field | Type | Limits | Meaning |
|---|---|---|---|
| `type` | `"block"` | | Record discriminator. |
| `id` | `block_` id | unique | Block id. |
| `bookId` | `book_` id | must name a `book` record | The book it is in. |
| `pos` | position key | | Its place in the book: blocks are in (`pos`, `id`) order, so two blocks that carry the same key still have one order. |
| `kind` | block kind | | `p`, `h1`, `h2`, `quote`, `li`, `prompt`, `figure` or `footnote`. |
| `text` | string | at most 20,000 characters | Plain Unicode text, no line breaks inside a paragraph. May be empty. |
| `marks` | array of marks | normalized | Bold, italic, card marks and footnote anchors, see below. |
| `image` | object, optional | `{ assetId, card? }`; present exactly when `kind` is `figure` | A figure's image: the asset it shows and the card it was made from. |
| `rev` | integer, optional | >= 0 | As for every record. |

A **mark** is `{ "t", "from", "to" }` over the text's UTF-16 range `[from, to)`. `t` is `b` (bold), `i` (italic), `c:` followed by a note id (a card mark, see [Cards in books](#cards-in-books)) or `n:` followed by a block id (a footnote anchor, see [Footnotes](#footnotes)); any other `t` is invalid. A block's marks are **normalized**, an invariant checked after every batch (`mark-range`): sorted by (`t`, `from`) in plain code-unit order (so `b` < `c:…` < `i` < `n:…`), same-`t` ranges that overlap or touch merged into one, and `0 <= from < to <= text.length`. The mark object is closed (a key it does not know makes the block invalid).

A block whose book is missing is dropped on load and reported as a `dangling-reference` (the original record in `raw`).

### Position keys

A position key is a base-62 fraction: the digits `0-9A-Za-z` in that order (which is also their code-unit order), never ending in `0`, so keys compare as plain strings and any two keys have keys between them. `posBetween(a, b)` gives one key between two (either may be open); appending or prepending steps by one in the two digits after the leading `z`s (or `0`s), so writing a book paragraph after paragraph grows the key one character per thousands of paragraphs, while repeated inserts at one place halve the gap each time (about one character per six). `posKeysBetween(a, b, n)` spreads `n` keys evenly at the fewest digits that hold them, for re-spacing a book's keys and moving a chapter. A key longer than 128 characters is invalid.

### Held books

`board.jsonl` holds every book's blocks, and so does the store. The app's window reads the board without blocks and reads a book's blocks when it opens that book. A block op on a book the window does not hold changes no block there (the store, which holds it, judges it), but it still stamps the book's `rev`.

### Cards in books

A card can cross into a book, and the book remembers it.

- **Card marks.** A mark's `t` may be `c:` followed by a note id (`c:note_…`, the id pattern with the `note_` prefix, nothing else): the text a card's passage holds, the card it came from. Two cards' marks over the same text both stay. They split, merge, slice and follow edits as bold and italic do. A `block.edit`'s `takes` may name card types (text typed inside or right after pinned text takes the card); each entry lists at most 8 types, each once.
- **`prompt` blocks.** A note to the writer beside the block before it, drawn in the margin, never counted as the book's text or exported. An ordinary text block to the format.
- **`figure` blocks.** A figure has `image: { assetId, card? }`: the asset it shows (which must exist: `missing-asset`) and the card it was made from. A block has `image` exactly when its kind is `figure` (`figure-image`). Its text is its caption (it may be empty), with `b`, `i` and card marks. A figure never changes kind (`block.set kind` to or from `figure` is refused), is never split and never merged; `block.set {image}` changes its image. Removing an asset a figure shows breaks `missing-asset`, so the asset sweep keeps it.
- **`book.cards`.** A book's `cards` is derived: the store stamps it with the store-only op `book.cards {id, add?, remove?}` in the very commit that changed it (the batch's revision), and an import recomputes it from the blocks, never trusting the file. Past 60,000 cards the list is incomplete (the stamp stops adding; a commit never fails for it).

### Footnotes

- **`footnote` blocks.** A note after the paragraph it belongs to, an ordinary text block whose marks are bold and italic only (`footnote-marks`). A footnote never changes kind (`block.set kind` to or from `footnote` is refused), is never split and never merged.
- **Footnote anchors.** A mark's `t` may be `n:` followed by a block id (`n:block_…`): the text a footnote annotates, anchored to that `footnote` block of the same book. Anchors split, merge, slice and follow edits as the other marks do: typing inside one extends it, and deleting all of its text removes it, which leaves the footnote an orphan (kept, never dropped).
- **Dangling anchors.** An anchor that names no footnote of its book (missing, another kind, another book) is a normal leftover: it is dropped on load quietly, its text kept, with no `dangling-reference` issue (so a file or backup holding one is not damaged).
- **Numbering.** Footnotes are numbered through the book by their references, at their anchors' ends (`to`), then the orphans; an anchor in a prompt counts for nothing, so its footnote is an orphan.

## Integrity states

`parseBoard` reports one integrity state for every file, independent of whether the records themselves loaded.

| State | Meaning |
|---|---|
| `ok` | An `eof` line exists, its `records` equals the number of lines before it, and its `sha256` matches. |
| `missing-eof` | No valid `eof` record (typically a truncated file). |
| `checksum-mismatch` | `eof` is present and the count matches, but the hash does not (the file was edited or damaged). |
| `count-mismatch` | `eof.records` differs from the number of preceding non-blank lines, or non-blank content follows `eof`. |

What the store does with each state:

- **`missing-eof`, `checksum-mismatch` or `count-mismatch`:** the board is marked *recovered*. The damaged file is preserved, and the UI shows a calm notice offering the latest backup, with note and yarn counts for comparison. Nothing is silently dropped.
- **`ok`:** loaded normally.

Independently of integrity, loading never drops a line silently. Each problem line is reported as a load issue carrying its raw text, so the store can write it to `quarantine/`, and loading continues:

| Issue kind | Cause | Result |
|---|---|---|
| `invalid-json` | The line is not JSON. | Line skipped and reported. |
| `invalid-record` | Not an object, no string `type`, or it fails the record schema. | Line skipped and reported. |
| `unknown-type` | `type` is not one of `board`, `asset`, `note`, `yarn`, `book`, `block`, `eof`. | Line skipped and reported. |
| `duplicate-id` | A second record with an id already loaded (including a second `board`). | First wins; later one reported. |
| `missing-board` | No valid `board` record. | No board is loaded, unless the caller passes `fallbackBoard` (for example the last known good board record): then every valid record is loaded under it, and the issue is still reported. |
| `unsupported-version` | `board.schemaVersion` is a number other than 6. | No board is loaded. |
| `content-after-eof` | Non-blank line after the first valid `eof`. | Line reported (also `count-mismatch`). |
| `dangling-reference` | Repair: an image points at a missing asset, a thread lists missing notes, or a block names a missing book. | Image removed, or missing notes removed from the thread (a thread left with fewer than 2 notes is dropped), or the block dropped. The original record is reported (for `repairs.jsonl`). |

When no board is loaded (`state: null`), the file must be preserved whole and never overwritten. The issue list is then not a complete quarantine list: valid lines are not reported, and `unsupported-version` discards every other issue.

Also: a leading byte-order mark is stripped, `\r\n` is accepted when reading, and blank lines are skipped (but counted in reported line numbers). The writer always emits `\n`.

## Versions and strictness

- The **`unsupported-version` gate** runs on the `board` line before it is validated. If `schemaVersion` is a number other than the supported version (6), lower or higher, the board is refused (`state: null`) and only the `unsupported-version` issue is returned. Other lines are not judged against this version's schema, and nothing is converted: the load, an import, and a backup listed or restored in History all refuse such a file.
- A missing or non-numeric `schemaVersion` is left to schema validation, which rejects it (`invalid-record`).
- Every record schema is `.strict()`. A record with a field this version does not know is **invalid**, never loaded with the extra field dropped.
- Tightening the values a record may hold (a limit lowered, an enum value removed) needs a version bump, and so does a value **added** to an enum or union (a mark's `t`, a block kind, a cover motif or ink): the store loads a file this build wrote, whose `eof` checksum vouches for it, checking only each record's keys (those of its closed objects too: a note's `image` and `from`, a book's `cover`, a block's marks and `image`), never their values. A key removed needs no bump: a record that carries a key the schema does not have is checked in full and reported as `invalid-record`.
- An unknown `type` is not silently ignored: it is reported as an `unknown-type` issue (and quarantined) rather than dropped without a trace.

## Record revisions

Every asset, note, yarn, book and block the store commits carries `rev`: the board `revision` of the commit that last created or changed it. A commit stamps every record its ops wrote, including a thread whose `noteIds` (and `pins`) changed because one of its notes was deleted. A record a commit has not written since the board was imported has no `rev` (an import installs the file's records without one), which reads as 0. A `rev` the page sends in a `note.create` or `yarn.create` is replaced by the commit's, and a create repeating a stored record that differs only in `rev` is the same record (no conflict).

## Ops

All changes go through ops; the `op` entry in the JSON Schema lists them:

`note.create`, `note.update {id, set}`, `note.delete`, `yarn.create`, `yarn.update {id, set}` (colour, label and pins), `yarn.insertNote {id, noteId, afterNoteId | null}`, `yarn.removeNote {id, noteId}`, `yarn.delete`, `board.update {set: {name}}`, and the store-only `asset.add` and `asset.remove {id}` (the asset sweep's: it fails while a note still shows the asset).

For books:

- `book.create {book}` (`trashedAt` must be `null`) and `book.update {id, set: {title?, lang?, shelfPos?, cover?, trashedAt?}}` (deleting and putting back).
- `block.create {block, after?}`, `block.delete {bookId, id}`, `block.set {bookId, id, set: {kind?, pos?, image?}, after?}` (`image` is a figure's). `after` (a block id, or `null` for the book's start) names the block a new or moved one followed where the op was made: the store counts it among the blocks the batch names, an undo or redo of a move keys the block after it, and it is not stored on the block.
- `block.edit {bookId, id, splices, addMarks?, removeMarks?}`: each splice `{at, del, ins}` replaces `del` UTF-16 units at `at` with `ins`, against the text the splice before it left (at most 1,000). Marks follow the text: text inserted inside a mark or at its end takes it, at its start does not, and a mark whose text is all deleted goes. `removeMarks` then `addMarks` are stated against the text after the op's own splices.
- `block.split {bookId, id, at, newId, pos, kind}`: the text from `at` on, and its marks, move to the new block `newId`; `id` keeps the head. `block.merge {bookId, from, into, at}`: `from`'s text and marks are appended to `into` (whose text must be `at` long) and `from` is removed. Each is the other's inverse.

and, store-only, `book.cards {id, add?, remove?}` (see [Cards in books](#cards-in-books)), `block.purge {bookId, ids}` (up to 500 blocks) and `book.purge {id}` (the book must be deleted; it takes any blocks of it still there, and is refused with `limit` while more than 500 remain): the 30-day purge, a batch of blocks at a time. None of them is ever undone.

An edit to a block that is gone (`not-found`) is rejected whole, through the usual rejected-batch path: nothing re-creates a block on its own.

In a `note.update` or `yarn.update` patch, `null` on an optional field (`motif`, `stamp`, `layered`, `from`, `ref`, `pins`) removes the key. For `image` it is a value (no image). An inverse op built for a decoration that was absent before is such a `null`.

A batch (`clientId`, `seq >= 1`, `baseRevision >= 0`, 1 to 500 `ops`) is committed whole or rejected whole. `asset.add`, `asset.remove`, `block.purge`, `book.purge` and `book.cards` are not accepted from the page: only the store makes them.

## What the JSON Schema cannot express

`z.toJSONSchema` drops refinements. These rules hold in the code but do not appear in `board-v1.schema.json`:

- Each id field's **specific prefix** (the schema shows only the generic id pattern).
- `yarn.noteIds` **uniqueness**.
- `yarn.pins` keys must be notes **on that thread**, and the map must **not be empty**.
- Patches (`note.update.set`, `yarn.update.set`) must set **at least one field**.
- All cross-record invariants: references exist, line order, `eof` count and checksum, board-wide limits (500,000 notes, 500 books), per-book limits (60,000 blocks, 4,000,000 characters) and normalized marks (`missing-book`, `too-many-books`, `too-many-blocks`, `book-too-long`, `mark-range`), a figure's image and its asset (`figure-image`, `missing-asset`), a footnote's marks (`footnote-marks`), an anchor naming a footnote of its book, and a book's `cards` matching its blocks.
- `book.create`'s `trashedAt: null` and a position key's pattern are in the schema; a block's marks being within its text is not.

## Annotated example

Real files contain no comments (JSONL has none), so the annotations follow the block. This example is verified by the test suite: it parses with integrity `ok`.

```jsonl
{"type":"board","schemaVersion":6,"id":"board_00000000000000000000000001","name":"Reading list","revision":3,"clients":{"tab_00000000000000000000000001":{"lastSeq":2,"lastRevision":3,"seenAt":"2026-10-27T10:00:00.000Z"}},"createdAt":"2026-10-27T10:00:00.000Z","updatedAt":"2026-10-27T10:05:00.000Z"}
{"type":"asset","id":"asset_00000000000000000000000001","mime":"image/webp","width":1024,"height":768,"bytes":48210,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","createdAt":"2026-10-27T10:00:00.000Z"}
{"type":"note","id":"note_00000000000000000000000001","x":0,"y":0,"w":240,"h":160,"z":1,"paper":"cream","style":"rustic","text":"Cork is a bark","image":null,"createdAt":"2026-10-27T10:00:00.000Z","updatedAt":"2026-10-27T10:00:00.000Z"}
{"type":"note","id":"note_00000000000000000000000002","x":320,"y":40,"w":240,"h":160,"z":2,"paper":"rose","style":"rustic","text":"Paper is made from fibres","image":null,"from":{"book":"book_00000000000000000000000001","block":"block_00000000000000000000000003"},"createdAt":"2026-10-27T10:00:00.000Z","updatedAt":"2026-10-27T10:00:00.000Z"}
{"type":"note","id":"note_00000000000000000000000003","x":160,"y":260,"w":240,"h":160,"z":3,"paper":"indigo","style":"print","text":"A photograph","image":{"assetId":"asset_00000000000000000000000001","frame":"print"},"createdAt":"2026-10-27T10:00:00.000Z","updatedAt":"2026-10-27T10:00:00.000Z"}
{"type":"yarn","id":"yarn_00000000000000000000000001","noteIds":["note_00000000000000000000000001","note_00000000000000000000000002","note_00000000000000000000000003"],"color":"apricot","label":"material","createdAt":"2026-10-27T10:00:00.000Z","updatedAt":"2026-10-27T10:00:00.000Z"}
{"type":"book","id":"book_00000000000000000000000001","title":"Field notes","lang":"en","shelfPos":"V","cover":{"seed":2654435769,"ink":"indigo","motif":"fields"},"trashedAt":null,"createdAt":"2026-10-27T10:00:00.000Z","updatedAt":"2026-10-27T10:05:00.000Z","cards":["note_00000000000000000000000001","note_00000000000000000000000003"],"rev":3}
{"type":"block","id":"block_00000000000000000000000001","bookId":"book_00000000000000000000000001","pos":"V","kind":"h1","text":"Cork","marks":[],"rev":2}
{"type":"block","id":"block_00000000000000000000000002","bookId":"book_00000000000000000000000001","pos":"W","kind":"p","text":"Cork is the bark of the cork oak.","marks":[{"t":"b","from":0,"to":4},{"t":"c:note_00000000000000000000000001","from":0,"to":14},{"t":"i","from":24,"to":32}],"rev":3}
{"type":"block","id":"block_00000000000000000000000004","bookId":"book_00000000000000000000000001","pos":"Wk","kind":"prompt","text":"Where is it grown?","marks":[],"rev":3}
{"type":"block","id":"block_00000000000000000000000003","bookId":"book_00000000000000000000000001","pos":"X","kind":"quote","text":"It grows back.","marks":[],"rev":3}
{"type":"block","id":"block_00000000000000000000000005","bookId":"book_00000000000000000000000001","pos":"Y","kind":"figure","text":"A photograph","marks":[],"image":{"assetId":"asset_00000000000000000000000001","card":"note_00000000000000000000000003"},"rev":3}
{"type":"eof","revision":3,"records":12,"sha256":"533b72433bcf8b8401e09fec8a176f68726a40e2da69a8c78eba73e8a6608553"}
```

1. **Line 1, `board`.** Version 6, revision 3. `clients` records that page `…0001` has had batches up to `seq` 2 committed (at revision 3), so a late retry of those batches is acknowledged, not re-applied.
2. **Line 2, `asset`.** A 1024 x 768 WebP image. The record sits before all notes because assets come first, sorted by id.
3. **Lines 3 to 5, `note`.** Sorted by `z` (1, 2, 3). The first two are text-only (`"image":null`). The second was made from the book's quote (`from`: its book and block). The third shows a framed print: `image.assetId` names the asset on line 2.
4. **Line 6, `yarn`.** One thread through all three notes, in order. Each pair of them is one step apart. Colour is the palette token `apricot`, not a hex value.
5. **Line 7, `book`.** One book on the shelf (`trashedAt` is `null`), its cover colour fields in indigo. Its `cards` are the notes its blocks name, sorted: note 1 (a card mark on line 9) and note 3 (the figure on line 12). Its `rev` 3 is the last revision anything in it changed (the edit to line 9 at revision 3), though the book record itself last changed at 10:05.
6. **Lines 8 to 12, `block`.** The book's text in `pos` order: a chapter title; a paragraph with "Cork" bold (`[0, 4)`), "cork oak" italic (`[24, 32)`) and its first words taken from note 1 (the card mark `c:note_…01` over `[0, 14)`, sorted between `b` and `i`); a prompt after it (drawn in the margin, not the book's text); a quote; and a figure showing the asset of line 2, made from note 3, captioned "A photograph".
7. **Line 13, `eof`.** `records` is 12, the twelve lines above it. `sha256` is the SHA-256 of those twelve lines, each followed by `\n`. `revision` repeats the board's.
