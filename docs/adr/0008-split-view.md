# ADR-0008: The split view shares the board's runtime

Status: Accepted

## Context

The board and an open book can sit side by side (`sidebar | board | seam | book`), so a card can go into the book and text can go back onto the cork. Several constraints shape how:

- There is one board, and it may hold 100,000 notes. Its `CanvasRuntime` is expensive to make: it builds the spatial index, the yarn caches and the far-zoom pyramid.
- The writer must never be remounted while it is written in. A remount ends a dead key's composition, loses the caret and builds a long book's model again.
- In a window narrower than 1,024 px there is no room for both, and the book lies over the board at full width.
- The board's frame budgets must hold with the book open beside it, and typing in a long book must hold with the board live beside it.

## Decision

### One slot for the open book

`CanvasView` takes `beside?: (rt) => ReactNode` and renders it after the board's viewport, inside one wrapper, `div.board-split[data-layout]`. `BoardWithBooks` (`apps/web/src/app/BoardScreen.tsx`) always renders an open book through `beside`, in both layouts. A change of layout only changes attributes and classes: the wrapper's `data-layout`, the pane's classes, and whether the board is covered.

Nothing in the React tree moves, so neither the board's runtime nor the writer (its engine, its model, a pending composition) is made again.

The shelf and Settings are sheets over the covered board.

At full width the board stays under the book at its own size. It is not shrunk to zero width: the runtime's zero-size branch in `resize` would reset its camera.

### The resize path

In the split layout the board's root is a flex item (`min-width: 360px`). The book's pane takes `calc(var(--book-share) * 100%)` (`min-width: 600px`). The board's runtime already observes its root with a `ResizeObserver`, so a narrower root is an ordinary resize: the camera keeps its top-left, the notes are culled for the new view, and nothing is remounted.

The layout is `split` when the window is at least 1,024 px wide (`splitFits`) and the device's preference says so, else `full`. The preference is per device, not per board: `papertie.split` in local storage holds `{ ratio, board }`. Unusable values read as the default, and the ratio is clamped to the two minimum widths.

To keep a full-width pane under the board's UI layer (the sidebar and the notices stay above it and in use), the board's root makes no stacking context. Its layers (z 0 to 5) and the pane (z 6) stack in the wrapper, and the UI layer sits above both (z 7).

### The seam

The seam (`apps/web/src/book/Seam.tsx`, in the book's chunk) sets `--book-share` on the wrapper through the CSSOM, clamped so the board keeps 360 px and the book 600 px.

While the seam is dragged, the writer's sheet keeps the width it had at the press (`--sheet-frozen` on the pane, `data-seam="drag"`), clipped at the pane's edge, and takes the new width at release. The writer therefore re-estimates the book's heights once, not on every frame of the drag. The board's root does follow the drag frame by frame; its resize costs only the notes in view.

From the keyboard, ←/→ move the seam by 5 %, and Home/End go to the book's least and most. Each move is announced ("Book takes 60% of the window") and remembered on the device.

### Key scoping

The board listens for keys on `window`. In the split view the book's pane is outside the board's root, so:

- `CanvasRuntime.onKeyDown` takes a key only when its target is the document, its body, or inside the board's root (`ownsKey`). Delete, the tool letters, ⌘Z and the arrows typed in the book never act on the board.
- ⌘K whose target is in `.book-pane` is the writer's (Insert card), not the board's search.
- The book's Esc goes to the shelf only when its target is in the pane.
- ⌘\ (Ctrl+\ outside macOS) is the shortcut of two visible controls. In the pane it is the writer's "Board", which switches between split and full width. On the board side it is Books: from the board alone it opens the last book; from a split view with the focus on the board it closes the book side.

### Pointer drags, not HTML5 drag and drop

The drags across the seam (a card into the book, text onto the board) and the seam's own drag are pointer drags with capture. Native drag and drop is not used, for two reasons:

- On macOS, ⌥ during a native drag shows the copy badge, the opposite of Papertie's ⌥ = move.
- A native text drag would also move text inside the book and would let the browser edit across blocks, which the engine never allows ([ADR-0007](0007-writer-engine.md)).

The runtime's gestures stay its own pointer handlers on its root, so a drag on the board never reaches the pane and none in the pane reaches the board.

### Dropping a card into the book

A card dropped into a book becomes blocks in one batch, which is one undo step. The seam, the pane's styles, the drop and its chooser are all in the book's lazily loaded chunk, so the board's initial code carries only the wrapper, the layout hook, the split preference and the key scoping.

## Consequences

- Switching layouts and dragging the seam are cheap: no runtime, index or editor is rebuilt.
- Any later change to the board's stacking must keep the UI layer above a full-width pane (z 7 over z 6). The board's root must not become a stacking context again, or the pane would lie over the sidebar.
- A key handler added on `window` for the board must scope its target the same way (`ownsKey`), or it would act from the book's pane.
- Features that need both sides (drops, pins beside a paragraph, revealing a card on the board) get the runtime through `beside`.

## Alternatives considered

- **A second board runtime beside the book.** Would double the index, the caches and the pyramid for the same board. Rejected.
- **Moving the book between a sheet and a pane in the React tree.** Simpler markup, but every switch would remount the writer and lose its composition and caret. Rejected.
- **Native drag and drop across the seam.** Rejected for the reasons above.
