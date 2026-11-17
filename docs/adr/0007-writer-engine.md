# ADR-0007: The writer's engine

Status: Accepted

## Context

The writer edits books of up to 60,000 blocks and 4,000,000 characters (core's `LIMITS`). It must meet these constraints:

- typing in a 200,000-word book: Event Timing p95 ≤ 32 ms and max ≤ 50 ms, with no long task over 50 ms;
- the app's strict Content Security Policy: no `style=` attributes in markup, no `<style>` elements, no `data:` URLs;
- dead keys and other composition input work (`isComposing` is respected);
- a split keeps the existing block's id and a merge keeps the surviving block's (core's `block.split` and `block.merge`), a multi-paragraph paste is `create`s, and a delete across paragraphs is `edit` + `delete`s + `merge`;
- changes that do not come from the keyboard (an undo or redo, the store's own commits) are applied without moving the caret or breaking a composition.

Two candidates were built behind one adapter and measured in the production build under the app's CSP, in headless Chrome at 1280 × 800, on a generated 200,000-word book (2,478 blocks, 1.17 million characters):

- **A, ProseMirror**: one `EditorView` per chapter, only the chapters in the window mounted.
- **B, custom**: one `contenteditable` per block, only the blocks around the reading place in the DOM, a spacer for each run of blocks between.

| Row | Budget | A: ProseMirror | B: custom |
|---|---|---|---|
| Typing, windowed, 200,000 words | p95 ≤ 32 ms, max ≤ 50 ms | p95 16 ms; **max 56–64 ms**, the first key of every run | p95 16–24 ms; max 16–24 ms |
| Long tasks while typing | none over 50 ms | none | none |
| Split and merge keep ids | required | pass | pass |
| Multi-paragraph paste, cross-paragraph delete | the changes listed above | pass | pass |
| An outside change applied during a composition | caret kept, composition unbroken | pass | pass |
| JS heap after GC | – | 5.7–7.1 MB | 5.1–5.9 MB |
| Engine chunk, gzip | smaller breaks a tie | 61 KB | 5 KB |

The rule was set before the runs: ProseMirror is kept only if it passes every row the custom engine passes and has the lower typing p95 (within 2 ms is a tie, decided by the smaller chunk).

## Decision

**The custom engine: one `contenteditable` per block.** ProseMirror missed the typing maximum in every run; on p95 the two tied, and the tie goes to the custom engine's chunk, about 13 times smaller. No editor library is a dependency of the app.

Why this is a good place to be beyond the numbers: the browser does all text entry inside one block, so dead keys, autocorrect and spellcheck are the platform's own and the engine only reads the result. Each block is its own editing host, so a change to any other block cannot touch a composition. The cost of a key does not grow with the book.

### The engine

It lives in `apps/web/src/book/editor/`:

- `blockEngine.ts`: the events, the commands, the adapter;
- `pageWindow.ts`: which blocks are on the page;
- `compose.ts`: a composition held over outside changes and rebased at its end;
- `dom.ts`: a block drawn and read back, offsets and DOM points;
- `model.ts`: the book's blocks in chunks of 128, each with the sum of its blocks' estimated heights, and an id-to-chunk map, so no structural change costs the whole book.

**The window.** 60 blocks (`SIDE`) each side of the block at the scroller's middle are in the DOM, plus the focused or composing block wherever it is, and both ends of a selection. Spacers stand for the rest at their heights: estimated from the text until a block has been drawn, then measured. The window keeps the view still as it moves. Scrolling through the whole 200,000-word book mounts at most 121 blocks.

**Selections across blocks.** A pointer press makes the book element one editing host for the drag, so a selection can cross blocks; it returns to one host per block as soon as the selection is inside one block again. The engine clears such a selection itself before a composition starts. ⌘A selects the whole book, and copy, cut and Delete then act through the model in one change.

**The browser's own text drag never starts** (`dragstart` is prevented). A press inside the selection that travels far enough is handed to the writer, which makes a card of the text.

### What the adapter hides

`BookEditor` (`BookEditor.ts`) speaks `EditorChange`s, never DOM or core ops; `book/editorOps.ts` maps them to `block.*` ops.

- **Native input.** Typing and composed input arrive as an `edit` with one splice and any added or removed marks, coalesced per block, and only after a composition ends.
- **Ids.** A split keeps the head's id and asks `newBlockId()` for the tail; a merge keeps `into`'s. A paste of several paragraphs is an `edit` and `create`s; a delete across blocks is `edit`s, `delete`s and a `merge`, in that order.
- **Compositions.** `apply` takes every change into the model at once. A change to the composing block waits for the page until the composition ends; other blocks change at once. At `compositionend` the composed text is rebased onto the model (through edits to its block, onto the tail of a split it falls behind, onto `into` for a merge) and emitted. If its block was deleted meanwhile, the edit still goes out naming that block, so the writer refuses it whole and offers the text as unsaved. `reset` during a composition waits for its end.
- **Marks.** Bold, italic and card marks (the text came from a note on the board) are carried with core's own mark functions, so the page and the board never disagree. After each commit the writer checks every block a change named against the board and shows the board's when they differ.
- **Kinds.** Paragraph, two heading levels, quote, list item, prompt, figure and footnote all go through the same changes. A figure's text is its caption; its image is drawn above it and is never editable. A prompt is drawn in the page's margin when there is room, else under its paragraph.
- **Find.** Matches are drawn with the CSS Custom Highlight API, outside the text's DOM. The search itself reads the board's blocks, never the page (`book/find/find.ts`).
- **History.** ⌘Z, ⇧⌘Z and `beforeinput` `historyUndo`/`historyRedo` go to `onHistory`, into the app's one history ([ADR-0005](0005-ops-commit-and-undo.md)). The browser's own undo stack is never used.

### Around the engine

- **Typing rules** run on a key typed outside a composition: the book's typography (`typography.ts`) as part of that keystroke's own splice, then a shortcut it completes (`# `, `## `, `> `, `- `, `*…*`, `**…**`), its syntax taken out and its kind or mark set in the same change.
- **Paste and copy** read and write HTML as well as text. Pasted HTML keeps the block kinds, bold and italic (`pasteHtml.ts`); scripts, handlers and inline styles are removed from the markup before it is parsed.
- **A long book goes onto the page in slices**: the model is built a step at a time, the first window goes up a screenful per task, and the word count follows in slices.
- **A place in the book** (the caret's block and offset, or the block at the view's top and how far the page is scrolled past it) is remembered per device, and a book opens there.
- **The outline** lists the chapter titles. A title jumps to its chapter; dragging one, or Alt+↑/↓ on it, moves the chapter in one commit and one undo step (`chapterMove.ts` moves whichever side has fewer blocks).

## Consequences

- No runtime dependency for the writer, and a small chunk that loads only when a book opens.
- The engine owns more than a library would: caret moves between blocks (←/→ at an edge, ↑/↓ on a first or last line), the one-host switch for selections across blocks, reading back markup the browser writes, and rebasing a composition over held changes. Defects are most likely there, and that part has the densest tests (`apps/web/test/book/`).
- Mounting the whole book at once is a long task of about 95 ms, so the writer must window. The browser's own find-in-page cannot reach blocks that are off the page; the writer has its own Find.
- The largest possible chapter move (about half of a 60,000-block book) is one long task of some 70–100 ms. A chapter of a few hundred blocks moves in well under a millisecond.

## Alternatives considered

- **ProseMirror**, one view per chapter, windowed: passed every behaviour row, but missed the typing maximum on the first key of every run and is 13 times the weight. A single view over the whole book was not built, since the windowed one already missed.
- **Lexical**: to be built only if both candidates failed. Not built.
- **One `contenteditable` for the whole book** with block-level reconciliation: rejected before measurement. A change anywhere in the host can disturb a composition, which per-block hosts rule out by construction.
