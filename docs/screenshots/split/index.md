# The board beside the book

The board and the book side by side.
Written by `e2e/app/gallery.spec.ts`; regenerate with
`GALLERY=1 pnpm exec playwright test -c e2e/playwright.config.ts --project=app gallery -g split`.
Motion reduced, fonts loaded. The split needs a window of 1,024 px or more; below it the book is
full width.

The images are WebP at quality 90. Each lossless original is kept beside the spec, in
`e2e/artifacts/gallery/split-<viewport>-<state>.png` (not committed).

| File | Viewport | State |
| --- | --- | --- |
| [wide-split.webp](wide-split.webp) | 1672 × 941 (a desktop window) | `split`: The split view: a chapter page beside the live board (the seam between them) |
| [laptop2x-split.webp](laptop2x-split.webp) | 1440 × 900 @ DPR 2 | `split`: The split view: a chapter page beside the live board (the seam between them) |
| [tablet-split.webp](tablet-split.webp) | 1024 × 768 (tablet) | `split`: The split view: a chapter page beside the live board (the seam between them) |
| [wide-seam-drag.webp](wide-seam-drag.webp) | 1672 × 941 (a desktop window) | `seam-drag`: The seam mid-drag (the sheet’s width held while it moves) |
| [wide-card-drag-copy.webp](wide-card-drag-copy.webp) | 1672 × 941 (a desktop window) | `card-drag-copy`: A card mid-drag over the page: its ghost and the crimson gap line (a copy) |
| [laptop2x-card-drag-copy.webp](laptop2x-card-drag-copy.webp) | 1440 × 900 @ DPR 2 | `card-drag-copy`: A card mid-drag over the page: its ghost and the crimson gap line (a copy) |
| [wide-card-drag-move.webp](wide-card-drag-move.webp) | 1672 × 941 (a desktop window) | `card-drag-move`: The same drag with ⌥ held: the ghost reads Move |
| [wide-chooser.webp](wide-chooser.webp) | 1672 × 941 (a desktop window) | `chooser`: The chooser after a drop: Paragraph · Quote · Prompt, with their keys |
| [laptop2x-chooser.webp](laptop2x-chooser.webp) | 1440 × 900 @ DPR 2 | `chooser`: The chooser after a drop: Paragraph · Quote · Prompt, with their keys |
| [tablet-chooser.webp](tablet-chooser.webp) | 1024 × 768 (tablet) | `chooser`: The chooser after a drop: Paragraph · Quote · Prompt, with their keys |
| [wide-pins-peek.webp](wide-pins-peek.webp) | 1672 × 941 (a desktop window) | `pins-peek`: A paragraph from two cards: two brass pins in the margin, one peek open |
| [laptop2x-pins-peek.webp](laptop2x-pins-peek.webp) | 1440 × 900 @ DPR 2 | `pins-peek`: A paragraph from two cards: two brass pins in the margin, one peek open |
| [wide-pin-faded.webp](wide-pin-faded.webp) | 1672 × 941 (a desktop window) | `pin-faded`: A faded pin: its card was deleted (the peek says so) |
| [wide-prompts-margin.webp](wide-prompts-margin.webp) | 1672 × 941 (a desktop window) | `prompts-margin`: Prompts in the right margin (Patrick Hand, pencil), on a wide page |
| [tablet-prompts-inline.webp](tablet-prompts-inline.webp) | 1024 × 768 (tablet) | `prompts-inline`: Prompts inline, under their paragraph, on a narrow pane |
| [wide-figure.webp](wide-figure.webp) | 1672 × 941 (a desktop window) | `figure`: A figure: the photo at the measure, its caption under it |
| [wide-reverse-mark.webp](wide-reverse-mark.webp) | 1672 × 941 (a desktop window) | `reverse-mark`: The reverse mark (a small ink dot) on a used card, and its list |
| [laptop2x-reverse-mark.webp](laptop2x-reverse-mark.webp) | 1440 × 900 @ DPR 2 | `reverse-mark`: The reverse mark (a small ink dot) on a used card, and its list |
| [wide-find.webp](wide-find.webp) | 1672 × 941 (a desktop window) | `find`: The find bar with matches, the current one in a crimson wash |
| [laptop2x-find.webp](laptop2x-find.webp) | 1440 × 900 @ DPR 2 | `find`: The find bar with matches, the current one in a crimson wash |
| [wide-top-band.webp](wide-top-band.webp) | 1672 × 941 (a desktop window) | `top-band`: The writer’s top band: Books; Find, Insert card and Board |
| [tablet-copy-move.webp](tablet-copy-move.webp) | 1024 × 768 (tablet) | `copy-move`: The tablet’s Copy · Move chip after a long press on a card |
| [wide-card-in-and-out.webm](wide-card-in-and-out.webm) | 1440 × 900 | `card-in-and-out`: a card dragged into the book, switched to a quote in the chooser, then its words pinned back out onto the board (20 s, VP9; made with ffmpeg) |
