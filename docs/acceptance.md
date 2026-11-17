# Acceptance criteria

What Papertie must do, and what proves it. Each criterion below has one test in
`e2e/app/acceptance.spec.ts`, titled with the criterion word for word. That test runs a cheap
version of the check in the built desktop app and names the tests and suites that prove the
criterion in full (they are listed in the tables here, and attached to the test as annotations).

The spec reads the lists between the HTML comment markers on this page, and fails when a
criterion has no test, a test has no criterion, or a test is skipped. To add a criterion, add it
to a list here, write its test, and name its proof in the spec.

Run the suite with:

```sh
pnpm e2e:app acceptance.spec.ts
```

## The board

Notes, yarn, focus, saving and recovery.

<!-- board-criteria:start -->
- Notes can be created, edited, moved, resized, and deleted.
- Text and images persist correctly after reload.
- Notes retain their positions and styling.
- Yarn can connect notes and maintain its connections when notes move.
- Multi-note collections behave according to the documented model.
- Yarn animation is smooth, restrained, and does not materially impair interaction.
- Focus mode displays the selected network and expands by connection depth.
- Exiting focus mode restores the full board without changing its underlying data.
- Autosave, backup, and recovery behaviour has been tested.
- Malformed records and interrupted writes do not cause silent corruption.
- The minimal sidebar is the only persistent navigation structure; no top navigation bar is present.
- The interface stays readable and responsive.
- Performance and accessibility are checked against documented test cases.
<!-- board-criteria:end -->

| Criterion | Proved in full by |
|---|---|
| Notes can be created, edited, moved, resized, and deleted. | e2e/app/journey.spec.ts: steps 2 (create, write, move, resize) and 6 (delete, undo); e2e/app/keyboard.spec.ts: steps 2–4 (create, write, Alt+arrow move); e2e/sidebar.spec.ts, e2e/canvas-drag.spec.ts, e2e/note-editor.spec.ts (proto); apps/web/test/selectTool.test.ts, drag.test.ts (pnpm test) |
| Text and images persist correctly after reload. | e2e/app/journey.spec.ts: step 5 (reload: text, motif and the uploaded photo); e2e/app/keyboard.spec.ts: step 9 (reload); apps/server/test/assets.test.ts, store.test.ts (pnpm test:server) |
| Notes retain their positions and styling. | e2e/app/journey.spec.ts: step 5 (every note equal after reload, paper and motif on the server); packages/core/test/serialize.test.ts, properties.test.ts (pnpm test) |
| Yarn can connect notes and maintain its connections when notes move. | e2e/app/journey.spec.ts: step 4 (Yarn tool, Shift-drop winds on); e2e/canvas-yarn.spec.ts, e2e/yarn-flows.spec.ts, e2e/canvas-drag.spec.ts (proto); e2e/app/shared-pins.spec.ts: "threads tied at one pin are saved so, and drawn at it after a reload" |
| Multi-note collections behave according to the documented model. | docs/adr/0002-yarn-semantics.md (one thread pin to pin; the whole thread is one group); packages/core/test/focus.test.ts, threadIndex.test.ts, invariants.test.ts (pnpm test); e2e/yarn-flows.spec.ts: "shift-drop winds A, B, C and D into one thread" (proto) |
| Yarn animation is smooth, restrained, and does not materially impair interaction. | e2e/canvas-motion.spec.ts: "a new thread draws in over 350 ms, then the loop goes idle within 1 s", "the board is idle when nothing moves: no frame callback for 3 s" (proto); e2e/desktop/desktop.bench.ts: "desktop drag 20 threads" (pnpm bench:desktop) |
| Focus mode displays the selected network and expands by connection depth. | e2e/focus.spec.ts (proto); packages/core/test/focus.test.ts (pnpm test); e2e/app/journey.spec.ts step 7; e2e/app/keyboard.spec.ts step 6 |
| Exiting focus mode restores the full board without changing its underlying data. | e2e/app/journey.spec.ts step 7 (the board file unchanged); e2e/app/keyboard.spec.ts step 6; e2e/focus.spec.ts: "hidden yarn is gone from the yarn layer and back after focus" (proto) |
| Autosave, backup, and recovery behaviour has been tested. | apps/server/test/backups.test.ts, backups-routes.test.ts, recovery.test.ts (pnpm test:server); apps/server/test/crash/recovery.crash.test.ts (pnpm test:crash); e2e/desktop/desktop.spec.ts: "opens straight on the board; a note, a thread and the window outlive a quit" |
| Malformed records and interrupted writes do not cause silent corruption. | apps/server/test/crash/crash.test.ts, corruption.test.ts, journal.crash.test.ts, import.crash.test.ts (pnpm test:crash); packages/core/test/parse.test.ts (the eof checksum, torn lines; pnpm test); apps/server/test/import.test.ts (a damaged file names its line; pnpm test:server) |
| The minimal sidebar is the only persistent navigation structure; no top navigation bar is present. | e2e/sidebar.spec.ts: "the floating sidebar sits on the left in the UI layer, in its fixed order" (proto); e2e/settings-sidebar.spec.ts (proto) |
| The interface stays readable and responsive. | Readability: the contrast checks in e2e/app/a11y.spec.ts and apps/web/test/styles; Responsiveness: e2e/desktop/desktop.bench.ts (pnpm bench:desktop); The look: e2e/app/gallery.spec.ts (docs/screenshots) |
| Performance and accessibility are checked against documented test cases. | tools/budgets.json (pnpm budget); pnpm bench, bench:desktop, bench:report; e2e/app/a11y.spec.ts (axe, every state); e2e/app/keyboard.spec.ts; docs/a11y/voiceover-walkthrough.md |

## Books, the shelf and the writer

Tests titled `Books: …`.

<!-- books-criteria:start -->
- A new book appears on the wooden shelf at once, with a generated ink cover that stays when the book is renamed.
- A book opens into the writer, its chapters, sections, quotes and lists set in the agreed typography.
- Formatting has one visible home, the writing tools in the sidebar, and the typed shortcuts are their accelerators.
- Writing is saved like the board, and is there when Papertie opens again.
- Undo in the writer goes through the board's one history.
- A deleted book can be put back from Recently deleted.
- Papertie opens where you left off: in the book, at the same place.
- The board and its books are one unit for the export and the import.
<!-- books-criteria:end -->

| Criterion | Proved in full by |
|---|---|
| A new book appears on the wooden shelf at once, with a generated ink cover that stays when the book is renamed. | e2e/app/shelf.spec.ts: "Books opens the shelf over the board and goes back; a new book is made and kept"; apps/web/test/book/cover.test.tsx, shelf.test.tsx (pnpm test); packages/core/test/book/records.test.ts (a random seed, fixed) |
| A book opens into the writer, its chapters, sections, quotes and lists set in the agreed typography. | e2e/app/writer.spec.ts: "typing "# On collecting" makes a chapter with its label and rule…"; e2e/app/gallery.spec.ts: books chapter-page (docs/screenshots/books) |
| Formatting has one visible home, the writing tools in the sidebar, and the typed shortcuts are their accelerators. | e2e/app/writer.spec.ts: "a multi-paragraph paste …; the sidebar formats"; apps/web/test/app/writerSidebar.test.tsx (pnpm test: the sidebar’s writing tools); apps/web/test/book/blockEngine.test.tsx (pnpm test) |
| Writing is saved like the board, and is there when Papertie opens again. | packages/core/test/book/ops.test.ts, rekey.test.ts (the block ops; undo and redo fitted to the book); apps/server/test/books.test.ts (pnpm test:server); apps/web/test/sync/books/ (pnpm test); e2e/desktop/desktop.spec.ts: "a book is opened and written in, and the words outlive a quit" |
| Undo in the writer goes through the board's one history. | e2e/app/writer.spec.ts: "Enter splits keeping the paragraph’s id, Backspace merges, ⌘Z undoes through the board’s history"; apps/web/test/history/sessionUndo.test.ts, UndoStack.test.ts (pnpm test) |
| A deleted book can be put back from Recently deleted. | apps/web/test/book/shelf.test.tsx (Recently deleted), apps/web/test/sync/books/putBackLate.test.ts (pnpm test); apps/server/test/books.test.ts (the purge after 30 days) |
| Papertie opens where you left off: in the book, at the same place. | e2e/app/writer-scale.spec.ts: "reopening Papertie after writing lands in the book at the caret"; apps/web/test/app/screenMemory.test.ts, bootRemembered.test.tsx (pnpm test) |
| The board and its books are one unit for the export and the import. | apps/server/test/export.test.ts, import.test.ts, backups.test.ts (pnpm test:server); docs/adr/0001-storage.md (served text without blocks; one file, one unit) |

## The board and the book as one

The split view, and what crosses the seam between the board and an open book. Tests titled `Board and book: …`.

<!-- together-criteria:start -->
- The board and an open book sit side by side, the seam can be dragged, and one key toggles the board beside the book.
- A card dragged into the book lands at once as a paragraph, a quote or a prompt, chosen at the drop without slowing it.
- An image card dragged into the book becomes a figure with its caption.
- Alt-drag moves a card into the book, and one undo brings it back.
- Selected text dragged onto the board becomes a card that remembers its book.
- A paragraph from a card carries a pin that shows the card and finds it on the board, through rewriting, splitting and merging.
- A card used in a book shows a mark on the board that lists the books.
- Every drag has a keyboard path: ⌘K inserts a card, and Pin to board makes one.
- Find in the writer finds text anywhere in the book.
<!-- together-criteria:end -->

| Criterion | Proved in full by |
|---|---|
| The board and an open book sit side by side, the seam can be dragged, and one key toggles the board beside the book. | e2e/app/split.spec.ts (the split, the seam kept, ⌘\, below 1024 px); apps/web/test/app/split*.test.tsx, test/book/bookScreen.test.tsx (pnpm test); docs/adr/0008-split-view.md |
| A card dragged into the book lands at once as a paragraph, a quote or a prompt, chosen at the drop without slowing it. | e2e/app/seam.spec.ts: "a card dropped into the book is a copy with its pin; …"; apps/web/test/book/cardDrop.test.tsx, dropChooser.test.tsx, dropForms.test.ts (pnpm test) |
| An image card dragged into the book becomes a figure with its caption. | apps/web/test/book/cardBlocks.test.ts: "an image card makes a figure with its asset and card, captioned with its text" |
| Alt-drag moves a card into the book, and one undo brings it back. | e2e/app/seam.spec.ts (⌥ at the drop moves …; one undo brings both back); apps/server/test/sync/sync.test.ts (a move racing an edit of the card loses no words) |
| Selected text dragged onto the board becomes a card that remembers its book. | e2e/app/seam.spec.ts: "a selection dragged out of the book onto the board …"; apps/web/test/book/toCard.test.ts, selectionDrag.test.tsx (pnpm test) |
| A paragraph from a card carries a pin that shows the card and finds it on the board, through rewriting, splitting and merging. | e2e/app/provenance.spec.ts: "a pin beside text from a card: …"; packages/core/test/book (card marks kept through edits, splits and merges); apps/web/test/book/pins.test.ts, pinLayer.test.tsx (pnpm test) |
| A card used in a book shows a mark on the board that lists the books. | e2e/app/provenance.spec.ts: "the reverse mark lists the shelf books using the card …"; apps/server/test/books.test.ts (the server stamps `cards`), apps/web/test/book/cardUses.test.tsx |
| Every drag has a keyboard path: ⌘K inserts a card, and Pin to board makes one. | apps/web/test/book/insertCard.test.tsx (pnpm test); e2e/app/seam.spec.ts: "Pin to board makes the card at the view’s centre; …" |
| Find in the writer finds text anywhere in the book. | e2e/app/writer-scale.spec.ts: "Enter jumps to a match 150,000 words away and selects it", "axe: no serious violations with the find bar"; apps/web/test/book/find.test.ts, findBar.test.tsx (pnpm test) |

## References, footnotes and export

Tests titled `Sources and export: …`.

<!-- sources-criteria:start -->
- A note can carry a free-text reference at its bottom, shown under a hairline.
- A card with a reference drops into the book as a quote with the reference as its footnote.
- Footnotes can be written by hand, from the sidebar or `^[`, and filled from a card’s reference with ⌘K.
- A book exports to Markdown with its images and to Word with real footnotes.
- Prompts and pins are never exported.
<!-- sources-criteria:end -->

| Criterion | Proved in full by |
|---|---|
| A note can carry a free-text reference at its bottom, shown under a hairline. | e2e/app/ref.spec.ts (Add reference, the field, the hairline, search, axe, CSP); apps/web/test/notes/noteRef.test.tsx; packages/core/test/ref.test.ts (pnpm test); docs/screenshots/sources (ref-note, ref-edit) |
| A card with a reference drops into the book as a quote with the reference as its footnote. | e2e/app/seam.spec.ts (a card with a ref dropped as a quote with its footnote, one undo); apps/web/test/book/cardBlocks.test.ts, dropChooser.test.tsx, pinLayer.test.tsx (pnpm test) |
| Footnotes can be written by hand, from the sidebar or `^[`, and filled from a card’s reference with ⌘K. | e2e/app/writer.spec.ts: "footnotes: …"; apps/web/test/book/footnotes.test.tsx, blockEngine.test.tsx (pnpm test); packages/core/test/book/footnotes.test.ts (5,000-run convergence) |
| A book exports to Markdown with its images and to Word with real footnotes. | apps/server/test/bookExport.test.ts (the whole .md, every docx part parsed); e2e/app/export.spec.ts (the downloads unzip); apps/web/test/book/bookPopover.test.tsx (pnpm test); docs/screenshots/sources (docx-preview.png through Quick Look) |
| Prompts and pins are never exported. | apps/server/test/bookExport.test.ts: "prompts and pins are never exported" |

## The desktop app

The criteria above run in the desktop app (its store in-process, its window on the same web
app). Two more things are checked for the app itself:

| What | Proved by |
|---|---|
| The packaged app works: it opens on the board; a note, a thread, a book's words and the window outlive a quit; a photo goes through sharp; a `.papertie` file the system opens, or one on the command line, is asked about before it replaces the board; web links leave for the system browser; ⌘Z and the menu's Undo reach the app's undo; a second launch hands over and leaves; the update check tells of a newer release and installs nothing. | The `desktop` e2e project, `e2e/desktop/desktop.spec.ts`: `pnpm e2e:desktop` on the development build, or against a packaged build with `PAPERTIE_DESKTOP_EXE` set to its executable. |
| Releases are built for every system and published. | `.github/workflows/release.yml` on a pushed `v*` tag: the desktop tests and the typecheck, then Linux (AppImage, .deb), Windows (NSIS) and macOS (zip, ad-hoc signed) packages, each package's contents checked (`apps/desktop/scripts/checkPackages.mjs`), the Linux app launched under Xvfb with the desktop specs, `SHA256SUMS`, and a GitHub release with every file. See [release.md](release.md). |
