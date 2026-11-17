# ADR-0003: Rendering approach

Status: Accepted

## Context

Notes are rich: textured paper, editable text, images. They need real text editing, dead keys and composition input, and accessibility. Yarn needs smooth physical motion and a cheap way to draw hundreds of curves. The board must pan and zoom at 60 fps at reading zoom, stay usable at 100,000 notes, and let the user zoom out far enough to see all of it.

## Decision

### Layers

Back to front, inside the board's viewport (`apps/web/src/canvas/canvas.css`):

1. **Cork**, a CSS background.
2. **Notes**, as DOM inside a world `div` with `transform: translate3d() scale()`.
3. **Yarn**, one Canvas 2D element with `pointer-events: none`. Yarn passes over paper, as real thread does.
4. **Pins**, a second canvas, so brass pin heads sit on top of the yarn.
5. **Selection overlay**, DOM handles.
6. **Screen-space UI**: the sidebar, popovers and notices.

### Supporting choices

- **Camera outside React.** The camera is `{x, y, zoom}`, zoom 0.005 to 2 (`Camera.ts`). Changes are applied straight to the DOM transform and the canvases once per animation frame, never through React re-renders.
- **Capture-phase hit-testing.** Because the yarn canvas ignores pointer events, a capture-phase `pointerdown` on the viewport root runs first. It tests pins (10 px radius on screen), then yarn (distance to the flattened Bézier, queried through rbush). The yarn tolerance follows the drawn cord: its on-screen half-width plus a 3 px margin, never under 6 px, and wider for the selected thread, which is drawn 1.35× thicker (`hitTest.ts`). Only if nothing is hit does the event reach the note's own DOM handlers. Hover uses the same order.
- **Single source of truth.** The board store (Zustand, `store/boardStore.ts`) holds note positions. During a drag, a transient override map moves DOM nodes and yarn directly, and the store is committed once at pointer-up.
- **Edge pins.** Each yarn segment ends on its own pin on the note edge facing its neighbour (`attach.ts`, pure geometry over a memoised topology). The spatial index, the renderer, the springs and hit-testing all read segment ends from there. An edge pin depends on the neighbour's position, so a moved note re-indexes and redraws its neighbours' segments too.
- **Yarn over paper.** Yarn draws over the notes. Two other modes exist behind a developer-only preference: `over-fix` (yarn erased where a higher note's paper covers it) and `under` (yarn below the notes, with stubs at the pins).
- **Floating origin.** Space is unbounded up to core's `LIMITS.maxCoord` (±10,000,000), but the compositor works in float32 and CSS lengths are clamped. The camera, the store, the index and hit-testing keep world doubles; every layer is drawn relative to an *anchor*, a whole-pixel world point near the camera. When the viewport centre is more than `ANCHOR_REACH_PX` (2^15) from the anchor, the frame's camera apply moves the anchor to the viewport centre and re-places mounted notes in that same apply, with no React render. The anchor is a function of the camera, so repeated rebases never drift. `e2e/canvas-far.spec.ts` checks that a board at (9.8M, −9.8M) draws as the same board at the origin.
- **Deckled edges** are CSS mask images served as files from the app's own origin (`/textures/deckle-N.webp`), never generated `data:` URLs, so the strict Content Security Policy holds.

### Levels of detail

An rbush index culls notes and yarn to the viewport. There are three levels (`lod.ts`), each entered below one zoom and left at a slightly higher one so they do not flicker:

| Level | Entered below | Left at or above | What is drawn |
|---|---|---|---|
| full | – | – | Every note in view as DOM, yarn with its twist, edge pins |
| lite | 0.35 | 0.38 | Notes as DOM in a lighter form (paper colour, greeked text, 256 px thumbnails) |
| overview | 0.15 | 0.18 | No note is mounted; the canvases draw cards, threads and pin dots |

In overview the world `div` is hidden. The yarn canvas draws the culled notes as cards (paper colour, tilt, an offset shadow; photos as their average colour) and each thread as one Bézier stroke in its colour. Cards are painted in z order in *levels*: cards that overlap no earlier card share one fill per colour. A press on a card reaches the tools as a press on its note, so select, drag and the yarn tool work; pins and yarn are not hit-tested there.

Static yarn is drawn into a cache (the viewport plus a margin), blitted while panning and redrawn on a zoom or when the view passes the margin. Moving notes and their threads are drawn over the cache each frame. In lite, a commit that moved notes patches the cache where things changed instead of redrawing it (`YarnRenderer.patchStatic`).

Notes mount at most 64 a frame once the camera has moved (`MOUNT_BATCH`), nearest the middle first, so a jump into a dense view fills in over a few frames instead of freezing.

### The far-zoom picture pyramid

On a board of more than 5,000 notes (`PYRAMID_ABOVE`) overview is drawn from raster tiles instead of from the board's cards each frame (`canvas/pyramid/`). Redrawing 100,000 cards on every zoom step and every commit cost about 270 ms; with the pyramid a frame is a few tile blits and a commit costs what it changed.

- **Levels.** Tiles are 512 device px. Levels are 2× apart, from overview's upper edge down past the zoom floor. A zoom is drawn from the coarsest level rastered at or above it, so a tile is never enlarged and never shown more than 2× smaller. (At 4× apart the tiles in view would exceed the cache.)
- **Look.** A tile is painted by the same code as the card overview (`overviewPaint.ts`). `e2e/canvas-pyramid.spec.ts` compares the two.
- **Worker.** A worker keeps every card and thread segment in two rbush trees and rasters a requested tile into an `OffscreenCanvas`, handed back as a transferred `ImageBitmap`. The tiles are rastered on the CPU (`willReadFrequently`): on a GPU-backed canvas the coarse levels' large fills held up the page's own frames. The cache is LRU, capped at 96 MB.
- **Edits.** The spatial index logs what it re-indexes; each frame the runtime hands those notes and segments to the pyramid, which stales exactly the tiles their old and new rects touch. Until a stale tile is back, each stale rect is drawn on the page from the board, clipped to it, so a move, recolour or delete shows in the next frame. A tile keeps at most 16 stale rects before it is treated as stale whole, and a frame draws a bounded number of rects from the board, so a bulk change may show a slightly old picture for a few frames rather than stall.
- **Fallbacks.** Focus mode, a page without module workers or `OffscreenCanvas`, a worker that fails, and the moments before the pyramid is ready draw the card overview, which looks the same.

### Keeping a note cheap to raster

Chrome replays an SVG image as vector operations into every raster tile it touches. So what a note's paper is made of is served as bitmaps: the deckle masks are 512 px WebP files drawn from their SVGs, and the paper fibre is baked into one opaque image per paper colour (`fibre-<paper>.webp`), so a paper paints one image and no blended layer. A note's decorations (folded corner, margin rule, dot grid, perforated edge) are CSS gradients on one element each.

Other measures that came from profiling at 100,000 notes:

- A long thread's twist stripes are traced only for the pieces of its path on the canvas.
- The top z of the board is followed incrementally, so starting a drag never walks every note.
- A commit does not cull the view again when every changed note and segment is in or out of view as before (`cullStands`).
- A large change told to the canvas while a board opens is taken in a few notes per step, in slices of a few milliseconds.

## Consequences

- DOM notes give native text editing, composition input, focusability and screen-reader semantics.
- One canvas for yarn keeps draw cost low, and the animation loop stops when every spring is at rest, so nothing runs while idle.
- The capture-phase hit-test is custom code that must stay consistent with how yarn is drawn. It has its own tests.
- With yarn over paper, a thread can pass over an unrelated note stacked higher. This is accepted.
- Measured in headless Chrome at 1280 × 720 on a Mac laptop: pan and zoom in overview on 100,000 notes hold 60 fps; zooming at reading distance with the view full of deckled notes runs at about 59 to 60 fps.
- The pyramid and the card overview are two paths that must look the same; the comparison spec guards that.

## Alternatives considered

- **Camera in React state.** Ruled out: a pan would re-render the tree every frame.
- **Yarn under paper.** Built as the `under` mode and compared side by side with `over`. Yarn over paper reads as real thread and was chosen.
- **Drawing overview from the cards every frame, at any board size.** Kept for boards up to 5,000 notes and as the fallback; replaced by the tile pyramid above that, where a redraw cost about 270 ms.
