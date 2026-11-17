# References, footnotes and export

A note’s reference, footnotes and a book’s export.
Written by `e2e/app/gallery.spec.ts`; regenerate with
`GALLERY=1 pnpm exec playwright test -c e2e/playwright.config.ts --project=app gallery -g sources`.
Motion reduced, fonts loaded. The run checks that the book options fit the width (nothing cut,
nothing scrolling sideways), and that an orphaned footnote keeps 4.5:1 on the paper.

The images are WebP at quality 90 (the board's at 82). Each lossless original is kept beside the spec, in
`e2e/artifacts/gallery/sources-<viewport>-<state>.png` (not committed).

| File | Viewport | State |
| --- | --- | --- |
| [wide-ref-note.webp](wide-ref-note.webp) | 1672 × 941 (a desktop window) | `ref-note`: A note with its ref at its bottom: under a hairline, in small type |
| [laptop2x-ref-note.webp](laptop2x-ref-note.webp) | 1440 × 900 @ DPR 2 | `ref-note`: A note with its ref at its bottom: under a hairline, in small type |
| [tablet-ref-note.webp](tablet-ref-note.webp) | 1024 × 768 (tablet) | `ref-note`: A note with its ref at its bottom: under a hairline, in small type |
| [wide-ref-edit.webp](wide-ref-edit.webp) | 1672 × 941 (a desktop window) | `ref-edit`: A note being written on: "Add reference" opened into the ref field |
| [wide-ref-drop.webp](wide-ref-drop.webp) | 1672 × 941 (a desktop window) | `ref-drop`: A card with a ref inserted with ⌘K: a quote at once, its ref as the footnote, the chooser |
| [laptop2x-ref-drop.webp](laptop2x-ref-drop.webp) | 1440 × 900 @ DPR 2 | `ref-drop`: A card with a ref inserted with ⌘K: a quote at once, its ref as the footnote, the chooser |
| [wide-footnotes.webp](wide-footnotes.webp) | 1672 × 941 (a desktop window) | `footnotes`: Footnotes under their paragraph, numbered through the book, the crimson superscripts |
| [laptop2x-footnotes.webp](laptop2x-footnotes.webp) | 1440 × 900 @ DPR 2 | `footnotes`: Footnotes under their paragraph, numbered through the book, the crimson superscripts |
| [tablet-footnotes.webp](tablet-footnotes.webp) | 1024 × 768 (tablet) | `footnotes`: Footnotes under their paragraph, numbered through the book, the crimson superscripts |
| [wide-orphan.webp](wide-orphan.webp) | 1672 × 941 (a desktop window) | `orphan`: An orphaned footnote: faded (AA), no number, "No longer anchored · Remove" |
| [wide-popover-footnote.webp](wide-popover-footnote.webp) | 1672 × 941 (a desktop window) | `popover-footnote`: The writing tools with Footnote |
| [wide-export-choices.webp](wide-export-choices.webp) | 1672 × 941 (a desktop window) | `export-choices`: A book's options on the shelf with Export open: Markdown · Word |
| [laptop2x-export-choices.webp](laptop2x-export-choices.webp) | 1440 × 900 @ DPR 2 | `export-choices`: A book's options on the shelf with Export open: Markdown · Word |
| [docx-preview.png](docx-preview.png) | — | The Word file from the export route, rendered by macOS Quick Look (`qlmanage -t -s 1200`) |
