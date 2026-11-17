# Books: the shelf and the writer

The shelf, the covers and the writer.
Written by `e2e/app/gallery.spec.ts`; regenerate with
`GALLERY=1 pnpm exec playwright test -c e2e/playwright.config.ts --project=app gallery -g books`.
Motion reduced, fonts loaded, nothing moving.

The images are WebP: quality 82 for the shelf (wood), 90 for the writer (paper and
text). Each lossless original is kept beside the spec, in
`e2e/artifacts/gallery/books-<viewport>-<state>.png` (not committed).

Every state is reached at every viewport; `laptop2x` writes the covers’ and the page’s fine
detail only.

| File | Viewport | State |
| --- | --- | --- |
| [wide-board-books.webp](wide-board-books.webp) | 1672 × 941 (a desktop window) | `board-books`: The board with Books in its tools: beside Settings in the sidebar |
| [wide-shelf-12.webp](wide-shelf-12.webp) | 1672 × 941 (a desktop window) | `shelf-12`: The shelf with twelve books, covers face-out, "New book" at the end of the last shelf |
| [wide-shelf-options.webp](wide-shelf-options.webp) | 1672 × 941 (a desktop window) | `shelf-options`: A book's options on the shelf (Rename, New cover, Delete) |
| [wide-shelf-recently-deleted.webp](wide-shelf-recently-deleted.webp) | 1672 × 941 (a desktop window) | `shelf-recently-deleted`: "Recently deleted" at the shelf’s end, opened: two books to put back |
| [wide-shelf-waiting.webp](wide-shelf-waiting.webp) | 1672 × 941 (a desktop window) | `shelf-waiting`: The shelf while the board is still coming in (Papertie opened again into a book, the whole board held back, Books pressed): the empty wood, waiting |
| [wide-chapter-page.webp](wide-chapter-page.webp) | 1672 × 941 (a desktop window) | `chapter-page`: A chapter page: the chapter label, title and red rule, body text with italic and bold, a quote, a section, a list |
| [wide-popover.webp](wide-popover.webp) | 1672 × 941 (a desktop window) | `popover`: A selected word: the sidebar’s writing tools for it |
| [wide-writer-reload.webp](wide-writer-reload.webp) | 1672 × 941 (a desktop window) | `writer-reload`: "Papertie needs a reload to keep saving." and Reload, over the writer |
| [laptop2x-shelf-12.webp](laptop2x-shelf-12.webp) | 1440 × 900 @ DPR 2 | `shelf-12`: The shelf with twelve books, covers face-out, "New book" at the end of the last shelf |
| [laptop2x-chapter-page.webp](laptop2x-chapter-page.webp) | 1440 × 900 @ DPR 2 | `chapter-page`: A chapter page: the chapter label, title and red rule, body text with italic and bold, a quote, a section, a list |
| [laptop2x-popover.webp](laptop2x-popover.webp) | 1440 × 900 @ DPR 2 | `popover`: A selected word: the sidebar’s writing tools for it |
| [tablet-board-books.webp](tablet-board-books.webp) | 1024 × 768 (tablet) | `board-books`: The board with Books in its tools: beside Settings in the sidebar |
| [tablet-shelf-12.webp](tablet-shelf-12.webp) | 1024 × 768 (tablet) | `shelf-12`: The shelf with twelve books, covers face-out, "New book" at the end of the last shelf |
| [tablet-shelf-options.webp](tablet-shelf-options.webp) | 1024 × 768 (tablet) | `shelf-options`: A book's options on the shelf (Rename, New cover, Delete) |
| [tablet-shelf-recently-deleted.webp](tablet-shelf-recently-deleted.webp) | 1024 × 768 (tablet) | `shelf-recently-deleted`: "Recently deleted" at the shelf’s end, opened: two books to put back |
| [tablet-shelf-waiting.webp](tablet-shelf-waiting.webp) | 1024 × 768 (tablet) | `shelf-waiting`: The shelf while the board is still coming in (Papertie opened again into a book, the whole board held back, Books pressed): the empty wood, waiting |
| [tablet-chapter-page.webp](tablet-chapter-page.webp) | 1024 × 768 (tablet) | `chapter-page`: A chapter page: the chapter label, title and red rule, body text with italic and bold, a quote, a section, a list |
| [tablet-popover.webp](tablet-popover.webp) | 1024 × 768 (tablet) | `popover`: A selected word: the sidebar’s writing tools for it |
| [tablet-writer-reload.webp](tablet-writer-reload.webp) | 1024 × 768 (tablet) | `writer-reload`: "Papertie needs a reload to keep saving." and Reload, over the writer |
| [wide-long-book-scroll.webm](wide-long-book-scroll.webm) | 1280 × 800 | `long-book-scroll`: a 200,000-word book scrolled from its start at a reader’s pace, then flicked far on (a recording, VP9; made with ffmpeg) |
