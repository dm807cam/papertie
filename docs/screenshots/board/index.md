# The board

Every state of the board at three window sizes.
Written by `e2e/app/gallery.spec.ts`; regenerate with
`GALLERY=1 pnpm exec playwright test -c e2e/playwright.config.ts --project=app gallery`.
Motion reduced, fonts loaded, the camera at rest.

The images here are WebP: quality 82 where the cork fills the frame, 90 where a
Settings sheet covers it. The run keeps each lossless original beside the spec, in
`e2e/artifacts/gallery/<viewport>-<state>.png` (not committed).

Every state is reached at every viewport. The shots of `wide` cover every state; `laptop2x`
covers the screens whose fine detail a dense display shows, and `tablet` one of each kind of
screen (the repository's size).

| File | Viewport | State |
| --- | --- | --- |
| [wide-empty-board.webp](wide-empty-board.webp) | 1672 × 941 (a desktop window) | `empty-board`: The empty board, its hint (the welcome note deleted) |
| [wide-board-30.webp](wide-board-30.webp) | 1672 × 941 (a desktop window) | `board-30`: The board with 30 notes and five threads, at reading zoom |
| [wide-one-selected.webp](wide-one-selected.webp) | 1672 × 941 (a desktop window) | `one-selected`: One note selected: its section in the tools |
| [wide-multi-select.webp](wide-multi-select.webp) | 1672 × 941 (a desktop window) | `multi-select`: Three notes selected (live region: "Selected 3 notes") |
| [wide-new-note-sheet.webp](wide-new-note-sheet.webp) | 1672 × 941 (a desktop window) | `new-note-sheet`: The "+" sheet: the paper picker |
| [wide-new-thread-sheet.webp](wide-new-thread-sheet.webp) | 1672 × 941 (a desktop window) | `new-thread-sheet`: The "+" sheet: the yarn colour picker |
| [wide-save-popover.webp](wide-save-popover.webp) | 1672 × 941 (a desktop window) | `save-popover`: The save-dot popover, after a nudge |
| [wide-search-results.webp](wide-search-results.webp) | 1672 × 941 (a desktop window) | `search-results`: ⌘K with results ("trip") |
| [wide-focus-depth-2.webp](wide-focus-depth-2.webp) | 1672 × 941 (a desktop window) | `focus-depth-2`: Focus mode at depth 2 (the focus chip) |
| [wide-far-zoom-lite.webp](wide-far-zoom-lite.webp) | 1672 × 941 (a desktop window) | `far-zoom-lite`: Far zoom, 25 % (the lite view) |
| [wide-far-zoom-overview.webp](wide-far-zoom-overview.webp) | 1672 × 941 (a desktop window) | `far-zoom-overview`: Far zoom, 10 % (the overview) |
| [wide-typing.webp](wide-typing.webp) | 1672 × 941 (a desktop window) | `typing`: Typing in a new note (the view is full: it covers the least it can) |
| [wide-place-free.webp](wide-place-free.webp) | 1672 × 941 (a desktop window) | `place-free`: A new note from "+" where the middle of the view is free cork: it lands right there |
| [wide-photo-uploading.webp](wide-photo-uploading.webp) | 1672 × 941 (a desktop window) | `photo-uploading`: A pasted photo uploading (held on its way to the store) |
| [wide-dropped-notice.webp](wide-dropped-notice.webp) | 1672 × 941 (a desktop window) | `dropped-notice`: A dropped-batch notice (a change that could not be applied) |
| [wide-save-saving.webp](wide-save-saving.webp) | 1672 × 941 (a desktop window) | `save-saving`: The save dot: Saving… |
| [wide-save-saved.webp](wide-save-saved.webp) | 1672 × 941 (a desktop window) | `save-saved`: The save dot: Saved (it shows for 1.5 s, then rests) |
| [wide-save-error.webp](wide-save-error.webp) | 1672 × 941 (a desktop window) | `save-error`: The save dot: Couldn't save |
| [wide-settings-export.webp](wide-settings-export.webp) | 1672 × 941 (a desktop window) | `settings-export`: Settings: Export |
| [wide-settings-history.webp](wide-settings-history.webp) | 1672 × 941 (a desktop window) | `settings-history`: Settings: History |
| [wide-settings-preferences.webp](wide-settings-preferences.webp) | 1672 × 941 (a desktop window) | `settings-preferences`: Settings: Preferences |
| [wide-settings-data.webp](wide-settings-data.webp) | 1672 × 941 (a desktop window) | `settings-data`: Settings: Data (Delete all data) |
| [wide-import-confirm.webp](wide-import-confirm.webp) | 1672 × 941 (a desktop window) | `import-confirm`: Import: the confirmation step (Keep current focused) |
| [wide-import-replaced.webp](wide-import-replaced.webp) | 1672 × 941 (a desktop window) | `import-replaced`: Import: the board replaced |
| [wide-recovery-notice.webp](wide-recovery-notice.webp) | 1672 × 941 (a desktop window) | `recovery-notice`: The board-recovery slip at the foot, after the board was replaced behind the window (it says the reload too: one slip) |
| [wide-opening-catch-up.webp](wide-opening-catch-up.webp) | 1672 × 941 (a desktop window) | `opening-catch-up`: The board opening, still catching up (the whole board held back) |
| [laptop2x-board-30.webp](laptop2x-board-30.webp) | 1440 × 900 @ DPR 2 | `board-30`: The board with 30 notes and five threads, at reading zoom |
| [laptop2x-new-note-sheet.webp](laptop2x-new-note-sheet.webp) | 1440 × 900 @ DPR 2 | `new-note-sheet`: The "+" sheet: the paper picker |
| [laptop2x-search-results.webp](laptop2x-search-results.webp) | 1440 × 900 @ DPR 2 | `search-results`: ⌘K with results ("trip") |
| [laptop2x-typing.webp](laptop2x-typing.webp) | 1440 × 900 @ DPR 2 | `typing`: Typing in a new note (the view is full: it covers the least it can) |
| [laptop2x-settings-export.webp](laptop2x-settings-export.webp) | 1440 × 900 @ DPR 2 | `settings-export`: Settings: Export |
| [tablet-empty-board.webp](tablet-empty-board.webp) | 1024 × 768 (tablet) | `empty-board`: The empty board, its hint (the welcome note deleted) |
| [tablet-board-30.webp](tablet-board-30.webp) | 1024 × 768 (tablet) | `board-30`: The board with 30 notes and five threads, at reading zoom |
| [tablet-multi-select.webp](tablet-multi-select.webp) | 1024 × 768 (tablet) | `multi-select`: Three notes selected (live region: "Selected 3 notes") |
| [tablet-new-note-sheet.webp](tablet-new-note-sheet.webp) | 1024 × 768 (tablet) | `new-note-sheet`: The "+" sheet: the paper picker |
| [tablet-new-thread-sheet.webp](tablet-new-thread-sheet.webp) | 1024 × 768 (tablet) | `new-thread-sheet`: The "+" sheet: the yarn colour picker |
| [tablet-search-results.webp](tablet-search-results.webp) | 1024 × 768 (tablet) | `search-results`: ⌘K with results ("trip") |
| [tablet-focus-depth-2.webp](tablet-focus-depth-2.webp) | 1024 × 768 (tablet) | `focus-depth-2`: Focus mode at depth 2 (the focus chip) |
| [tablet-far-zoom-overview.webp](tablet-far-zoom-overview.webp) | 1024 × 768 (tablet) | `far-zoom-overview`: Far zoom, 10 % (the overview) |
| [tablet-typing.webp](tablet-typing.webp) | 1024 × 768 (tablet) | `typing`: Typing in a new note (the view is full: it covers the least it can) |
| [tablet-photo-uploading.webp](tablet-photo-uploading.webp) | 1024 × 768 (tablet) | `photo-uploading`: A pasted photo uploading (held on its way to the store) |
| [tablet-dropped-notice.webp](tablet-dropped-notice.webp) | 1024 × 768 (tablet) | `dropped-notice`: A dropped-batch notice (a change that could not be applied) |
| [tablet-settings-export.webp](tablet-settings-export.webp) | 1024 × 768 (tablet) | `settings-export`: Settings: Export |
| [tablet-settings-history.webp](tablet-settings-history.webp) | 1024 × 768 (tablet) | `settings-history`: Settings: History |
| [tablet-import-confirm.webp](tablet-import-confirm.webp) | 1024 × 768 (tablet) | `import-confirm`: Import: the confirmation step (Keep current focused) |
