# Visual language

Papertie looks like a physical pinboard: a cork board, paper notes held by brass pins, twisted
yarn tied between them, and a wooden shelf of books. Nothing glows, nothing floats in glass;
every control is ink on paper.

This file is the design reference: the values the app renders with, read from the code. Each
section names its source files, and where this file and the code disagree, the code is right.
Paths are relative to the repository root. Screenshots of the app as built are in
[`docs/screenshots/`](../screenshots/board/index.md).

Some sections mention the design study (`#/study`) and the developer strip and HUD. These are
development pages and controls, built only with the developer routes; they are not part of the
packaged app.

## Palette
Sources: `packages/core/src/palette.ts`, `apps/web/src/styles/palette.ts`, `apps/web/src/main.tsx`.

Eight tokens. Each names a paper, the ink that sits on it, and a yarn dye. Records store the
token name, never a hex value.

| Token | Paper's name | Yarn's name | Paper | Ink | Yarn |
|---|---|---|---|---|---|
| cream | Cream | Undyed | `#F3EBDD` | `#2B2724` | `#EDE4D3` |
| rose | Rose | Rose | `#F4DEDC` | `#2B2724` | `#D98A99` |
| apricot | Apricot | Crimson | `#F2D5BF` | `#2B2724` | `#B8364A` |
| indigo | Indigo | Indigo | `#D9E0EA` | `#2B2724` | `#2E4B7A` |
| sage | Sage | Moss | `#DFE4CB` | `#2B2724` | `#6E8B3D` |
| lilac | Lilac | Lilac | `#E5DAE6` | `#2B2724` | `#9B7EC6` |
| ochre | Ochre | Ochre | `#EEDBAE` | `#2B2724` | `#C9962E` |
| ink | Ink | Ink | `#34312E` | `#F3EBDD` | `#2B2A28` |

- **One path for both renderers.** At start-up `main.tsx` writes core's `PALETTE` to `:root` as
  `--paper-<token>`, `--ink-<token>` and `--yarn-<token>` (`paletteCssVars`). The DOM reads
  those, and the canvas reads `yarnColor(token)`, which reads the same `PALETTE`. An unknown
  token draws as ink.
- **Contrast.** Note text holds at least 7:1 on its paper (`paletteWarnings` flags a pair
  below it).
- **Other fixed colours.** The pins' mid brass is `#B08A3A` (`--pin-brass`), a print's white
  stock `#FBF8F2` (`--print-stock`), the stage behind the cork `#8B6B47` (`--stage`), and the
  logo's crimson and green `#A21D45` and `#86A755`.

## Cork
Sources: `tools/src/textures/cork.ts`, `tools/src/textures/set.ts`,
`apps/web/src/canvas/cork.ts`, `apps/web/src/canvas/mountCork.ts`.
- **Tiles.** Two tiles, generated with seed `TEXTURE_SEED` 20261027 by
  `pnpm --filter @papertie/tools make-textures` (`--check` compares against the committed files):
  - `/textures/cork-fine.webp`: 1024 px, WebP quality 86.
  - `/textures/cork-mottle.webp`: 1597 px, quality 80.

  Both tiles are seamless. Their sizes have no common repeat, so the two patterns never line up.
- **Fine tile** (values in `CORK_FINE`). Agglomerated cork: irregular
  domed granules pressed together, lit from the upper left with a soft self-shadow, crevices
  where they gape. The generator builds it in steps:
  - **Granules.** Tileable cellular noise on 80 × 80 cells (12.8 tile px, 6.4 screen px at zoom
    1). Each feature point has its own orientation and elongation (stretch 1–2.1, the cross axis
    × 0.85), and the lookup is warped by 3-octave fbm (0.75 of a cell), so outlines are ragged
    and granules range from round to worm-like.
  - **Seams and crevices.** An "open" fbm field (period 40) marks 45 % of the borders as gaping.
    A granule is a flat-topped dome, `smoothstep(0, 0.42, F2 − F1)^0.7`, that falls into a
    crevice (height 0) where it gapes and only to 0.55 of its height where it presses against a
    neighbour, so most seams are shallow.
  - **Height.** The dome × a per-granule lift of 0.6–1, plus 0.2 of fine fbm grain (period 320),
    blurred three times with a wrapped 3 × 3 box.
  - **Light.** Lambert from the upper left, direction (−0.55, −0.62, 0.56) normalised, relief
    `(size / cells) · 0.4`; shade `0.79 + 0.45 · lambert`, capped at 1.3.
  - **Self-shadow.** The height 3 px toward the light (0.22 of a granule, up-left) against this
    pixel's: a higher neighbour darkens it by up to 30 % (`(h' − h) · 1.2`), which gives each
    granule a soft shadow on its lower right.
  - **Colour.** A ramp `#925F39` → `#AD7446` → `#D2A06D` (warm brown, not orange), driven by
    tone: 50 % per granule (skewed dark, `hash^1.4`), 25 % broad fbm and 25 % the cork's fine
    porous grain. Crevices mix toward `#4A2E1A` at up to 72 % (about 6 % on closed seams).
  - **Specks.** A Worley grid of 120 cells on the warped lookup, each speck its own radius
    (0.15–0.45 of a cell): 7 % pale bark flecks (`#DCB07F` at 0.55), 10 % dark pores (`#3E2614`
    at 0.65).
  - **Measured.** Tile mean `#A97347`, luma sd 20, WebP 280 KB. On the demo board at zoom 1, with the mottle, the cork averages
    `#A0653A` with luma p5/50/95 of 86/114/139.
- **Mottle tile.** fbm with period 3 and 5 octaves, mapped from white to `#E2BE9A` through
  `smoothstep(0.35, 0.75)`. It is multiplied over the fine tile at a peak opacity of 0.6
  (`CORK_MOTTLE_OPACITY`).
- **Octave rule** (`corkLayers`). Let `t = log2(zoom)` and `f = t − ⌊t⌋`. Each tile has two
  layers one octave apart: the bottom one is drawn at `(px / 2) · 2^f` screen px, the top one at
  `(px / 2) · 2^(f − 1)`.
  - Within an octave the grain grows with the zoom like the world. Across octaves the fine tile
    always shows at 256–1024 screen px, so it never shrinks to mush or blows up.
  - Opacities: the fine bottom layer is 1 (opaque) and the fine top layer is `f`; the mottle
    layers are `0.6 · (1 − f)` and `0.6 · f`, multiplied.
  - As `f` reaches 1, the top layer becomes the next octave's bottom one, so the handover is
    seamless.
  - Paint order: fine bottom, fine top, mottle bottom, mottle top. Each layer's offset is the
    screen position of world (0, 0) modulo its size, so the grain stays anchored to the world.
- **On screen.** One fine cell is 1024 / 80 = 12.8 tile px, so granules in the bottom layer are
  6.4–12.8 screen px at any zoom.
- **Seams.** `e2e/polish.spec.ts` shoots the cork alone at zoom 0.02, 0.1, 0.35, 1 and 2 with sub-pixel offsets and checks that no pixel column
  or row across the view is more than twice as busy as the median one (a seam or a gap would be).
- **At far zoom.** The octave rule is self-similar, so it holds at every zoom: the grain keeps the same screen size and the crossfade continues through every octave. The grain is kept rather than fading the cork to a flat tone: at a
  constant screen size it reads as cork at every zoom, and a flat tone would be a second look
  to design and tune.
- **Mounting.** Four `div`s in `.cork`, with `isolation: isolate`.
  - Each is rastered once at its octave's reference size: `background-size` is `refPx`, which is
    `(px / 2) · √2` for the bottom layer and `(px / 2) / √2` for the top one.
  - Each is placed by `translate3d(offset − size) scale(size / refPx)`, in a box of
    `viewport · √2 + refPx`. Neither panning nor zooming repaints it.
  - `will-change: transform` is set only while the camera moves.
  - The viewport behind the cork is `#8B6B47`.

## Paper
Sources: `apps/web/src/notes/note.css`, `apps/web/src/notes/noteStyle.ts`,
`apps/web/src/lib/seed.ts`, `tools/src/textures/deckle.ts`, `tools/src/textures/fibre.ts`.
- **Every note.**
  - `.note-paper` is filled with `var(--note-paper)` and set in `var(--note-ink)`. Padding
    18 / 26 / 22 px (top, sides, bottom), `white-space: pre-wrap`, `overflow-wrap: break-word`.
  - The shadow is a separate `.note-shadow` element, inset `3px 2px 0`, with
    `0 1px 1px rgb(40 24 8 / 0.18), 0 4px 8px … / 0.14, 0 12px 24px … / 0.1`. Selected:
    `0 2px 2px / 0.18, 0 8px 14px / 0.15, 0 18px 32px / 0.12`.
  - No `filter: drop-shadow` anywhere.
- **rustic** (fibre paper with a torn edge).

  - Fibres: the overlay `fibre.webp` (a 512 px tile drawn at 256 px, WebP quality 90,
    `#8A6A45` fibres on white), `multiply` at 0.55; on ink `screen` at 0.25. It is drawn already flattened onto each paper: the paper's background is
    `fibre-<paper>.webp` (`--fibre-<paper>`, 512 px, lossless, made by
    `tools/make-textures.ts` from the overlay and the palette's paper), with no blended layer
    above the text. A decoration is drawn on that sheet as it is. The overlay itself (`::after`)
    stays where it lies over something else: a fibre note with a photo, an ink backing sheet,
    and the study's palette tuner (`data-palette-tuned`); on ink it is screened at 0.25
    (`deckle.spec.ts`). Measured against the overlay at reading zoom (DPR 2): no pixel of
    the paper differs ([ADR-0003](../adr/0003-rendering.md)).
  - Deckle: `-webkit-mask-box-image: url(/textures/deckle-N.webp) 48 fill / 12px stretch`,
    where `N` is the seeded `maskIndex` 1–8. The masks are 128 × 128 SVGs with 12 px slices
    (`DECKLE_SLICE`; middle 104), a bite of 0.75–8 px, 30 fibres per edge and a corner radius
    of 2, drawn as bitmaps at 4 px a unit (512 × 512, lossless): 48 bitmap px are the SVG's
    12-unit slice, one device px a bitmap px at zoom 2 on DPR 2. The SVGs stay the source.
  - Behind the paper, `.note-shadow` sits 8 px in, with `padding: 1px` and the paper colour on
    its content box: that is the seam backing, 9 px in. Its shadow is
    `0 3px 4px / 0.2, 0 7px 12px / 0.16, 0 16px 28px / 0.12`; selected
    `0 4px 5px / 0.2, 0 11px 18px / 0.17, 0 22px 38px / 0.13`.
  - All of this is inside `@supports (-webkit-mask-box-image: none)`. A browser without that
    property gets fibres, a straight edge and the default shadow.
- **Why `stretch`.** Chrome's tiled path (`round`/`repeat`) for SVG mask images blanks the edge
  slices at some raster scales (zoom 1.25–1.6, 2.5 and 3), leaving straight strips. `stretch`
  never does. The cost is a tear pattern lengthened along long edges, about × 2.3 on a 260 px
  edge. `e2e/deckle.spec.ts` guards it.
- **smooth.** No mask and no fibres. A faint lit edge, `inset 0 0 0 1px rgb(255 255 255 / 0.35)`,
  and the default shadow.
- **print.**
  - White stock `#FBF8F2` with a 12 px border of the same colour and padding 0, laid out as a
    column.
  - The image fills the print down to the caption (`flex: 1 0 auto`, `object-fit: cover`, a
    hairline `0 0 0 1px rgb(40 24 8 / 0.06)`).
  - The caption is Cormorant italic 400 at 17 / 1.35, letter-spacing 0.02em, ink mixed 80 %
    toward the stock, padded `8px 2px 0`. An empty caption is hidden.
  - The image file is the 1024 px one, or 256 px in lite.
- **layered**.
  - The backing sheet is `.note-sheet`, a child of the note's `article`. `sheetStyle` seeds how
    far it reaches past the note: 12–15 px at the top, 18–24 px at the right and bottom, 12–16 px
    at the left.
  - It is turned 0.6–1.3° against the sign of the note's own tilt, and uses its own deckle mask,
    `((maskIndex + 2) mod 8) + 1`.
  - On fibre paper it gets the note's shadow box, seam backing and fibres (fibre offset 64 px / 32 px).
  - It has `pointer-events: none`.
- **tag** (`isTag`: w ≤ `TAG_MAX_W` 120).
  - Padding 30 / 14 / 14 px. A 16 px punched hole, a radial shade, sits 6 px from the top,
    centred.
  - Title 18 px at 0.04em; subtitle 15 px.
  - Decorations: the fold is 22 px, the margin rule runs at 6 and 9 px with the text left
    where it is, and the perforation lies below the eyelet (text 14 px lower).
  - Stamp 20 px, 10 px in from the right and the bottom.
  - A print tag has borders of 24 / 8 / 8 px, with the hole at −18 px, in the top border.
- **heading-only** (title and perhaps a subtitle, not a tag): the text is centred on the paper
  (a flex column).
- **Tilt** (`noteRotationDeg`).
  - Rustic and smooth notes take a seeded tilt in [−1°, 1°), from an FNV-1a hash of the id.
  - Prints take 2.5–5° with the same sign.
  - The pivot is the hanging pin: `transform-origin` is `w / 2 + pinOffsetX` and 14 px down.
  - With the tilt pref off, every note is at 0°. The pref is on/off only; the amount is not a
    pref.
- **Lite.**
  - No mask, no fibres, no decoration or stamp.
  - One shadow, `0 1px 2px rgb(40 24 8 / 0.2)`.
  - Text becomes greeked bars, 0.55em high in 25 % ink, 1.05em apart. A titled note's first bar
    is 0.95em high.

## Decorations, stamp and layered paper
Sources: `apps/web/src/notes/note.css`, `apps/web/src/notes/StampMark.tsx`,
`apps/web/src/notes/noteStyle.ts`.

- **Record fields.** A decoration, the stamp and the layered sheet are optional fields of core's
  `Note` (`motif?`, `stamp?: true`, `layered?`). Absent means none; `null` in a patch removes
  one.
- **Decorations.** Four things paper really has, drawn flat in the note's own colours by
  `note.css` on one element each (`.note-motif--*` in the `.note-decor` layer, under the text,
  clipped to the paper and torn by its deckle, `pointer-events: none`, `aria-hidden`). No image
  is fetched for them and nothing is blended; they are left out in lite LOD and in the overview.
  
  - **Fold.** The top right corner turned down: the paper is cut along the crease with a
    `clip-path` (32 px on a note, 22 px on a tag, `--note-fold`) and the flap is a triangle of
    the paper's colour shaded toward brown (toward white on ink), with a hair of shadow. On
    fibre paper the shadow element's seam backing stops short of the cut, so the cork shows
    through it. The text box is left alone: the paper's padding already clears the flap.
  - **Margin.** Two 1 px hairlines of the paper's dye at 27 and 30 px from the left edge, at
    0.85: the paper's own yarn, crimson on cream (whose yarn is undyed) and ochre on ink
    (`--note-dye`; `ruleDye` for the picker). Everything on the paper is kept to their right
    (the paper's left padding is 40 px, a print's caption 28 px), so no text ever lies on them.
    On a tag they run at 6 and 9 px, in its own narrow margin, and the text stays put.
  - **Dots.** A 12 px grid of dots about 1 px in radius across the whole sheet, the only
    decoration under the text: the note's ink at 15 % on light papers, black at 50 % on ink
    (darker than the paper, so the light text only gains contrast). The subtitle, whose ink is
    softer than the text's, is set at 86 % of the ink on a dotted note. A print has none.
  - **Perforation.** A row of punched holes along the top (cork brown, 10 px apart, spaced
    evenly whatever the width) over the dashed line the sheet would tear at, 19 px down; the
    text starts 6 px lower. A tag is perforated below its eyelet, so the hook's end reads as a
    stub. A print keeps the holes in its top border and has no tear line.
  - **Contrast.** Text over a decoration keeps the 7:1 rule, and a subtitle 4.5:1.
    `tools/test/decorContrast.test.ts` checks the dots at their strongest against every colour
    of each paper's baked fibre sheet; `e2e/study.spec.ts` measures the rendered background
    behind every text line of the study's decorated notes, with the text hidden. Lowest text
    ratios on the dot grid, on fibre paper: cream 8.9, rose 8.2, apricot 7.6, indigo 7.9, sage
    8.0, lilac 7.8, ochre 7.7, ink 8.7 (10.9 on smooth ink); subtitles 5.3–6.8. The margin
    rule, the fold and the perforation lie under no text: those notes read as plain paper does
    (fibre: 10.0–11.4 on light papers, 8.7 on ink).
- **Stamp.** The closure of a string-tie envelope: two buttons and one thread wound between
  them in a figure-eight with a short loose tail, drawn inline by `notes/StampMark.tsx` in a
  40-unit box, in one ink (crimson `#C3352B`, `#E0685C` on ink paper). Under 48 px the buttons
  are plain discs and the thread is 2.6 units; from 48 px up the thread is 1.9 and each button
  has its eyelet, cut through to the paper. It sits 26 px square at the bottom right, 18 px in
  from the right and 16 px up from the bottom (20 px at 10 px on a tag), at 0.92.
- **Layered paper.** `Note.layered` puts a second sheet of that palette paper behind the
  note (`.note-sheet`, a child of the note's `article`, so it moves, rotates and resizes with the
  note on the React and the imperative drag paths alike). `sheetStyle` seeds it: 12–15 px past the
  top, 18–24 px past the right and bottom, 12–16 px past the left (the torn edge eats up to 8 px of
  that), and turned 0.6–1.3° against the note's own tilt. On fibre paper it has its own deckle mask
  (never the note's), fibres, seam backing and shadow box, like the note itself.
  **Hit-testing excludes it**: it has `pointer-events: none`, and the spatial index, culling, pins
  and the `over-fix` erase shapes all keep using the note's own rect. A press on the visible strip
  of backing reaches the cork. One consequence: in `over-fix`, a thread under a layered note is
  erased only where the top sheet covers it, so it seems to pass between the two sheets.

## Prints and tags
Sources: `apps/web/src/lib/seed.ts`, `apps/web/src/canvas/geometry.ts`,
`apps/web/src/canvas/layering.ts`, `apps/web/src/canvas/drawYarn.ts`.
- **Print tilt.** Prints tilt 2.5–5° either way, seeded, with the sign of the note's own ±1°
  seed. `noteRotationDeg` is the only source of a note's tilt, for the DOM, the selection frame
  and hit-testing.
- **Note lookup on turned paper.** The runtime's `noteAt` tests the paper as drawn (the rect
  turned about the pin), so yarn-drop targets follow a 5° print's corners. The spatial index
  keeps unturned rects, and the query pads by how far a 5° turn can move a corner of the largest
  note.
- **Tag rule.** A note 120 px wide or narrower (`isTag`, `TAG_MAX_W`) renders as a tag. Core's
  narrowest note is 120 px, so a tag is a note at exactly that width. The tag look follows a
  live resize. A tag hangs from a brass cup hook instead of the dome pin: a shank rising out of
  the cork into a flat eyelet washer, with a cast shadow, drawn on the pin layer. The eyelet
  centre is the pin point and the pivot, with no seeded x-offset. The paper has a punched hole
  under the eyelet, tighter padding and an 18 px title. Its yarn ends on small edge pins.

## Type
Sources: `apps/web/src/styles/tokens.css`, `apps/web/src/styles/fonts.ts`,
`apps/web/src/notes/note.css`, `apps/web/src/notes/noteText.ts`, `apps/web/package.json`.
- **Faces.** All self-hosted from Fontsource npm packages, their Latin and Latin Extended subsets
  only (`woff2`, each with its `unicode-range`), with `font-display: swap`. All four are under the
  SIL Open Font License 1.1:
  - Instrument Sans 5.3.0: 400, 500 and 600 (and 400 and 600 italic, with the writer).
  - Newsreader 5.3.0: 400, 500 and 600. The display serif: titles, headings, bullets, covers.
  - Patrick Hand 5.3.0: 400. The hand: the writer's pencilled prompts, the sheets' row titles.
  - Cormorant Garamond 5.3.0: 400 italic and 500 italic.
- **Stacks.** Each web face is followed by its metric-matched local fallback ("… Fallback").
  - `--font-note`: Instrument Sans, Instrument Sans Fallback, system-ui, sans-serif.
  - `--font-display`: Newsreader, Newsreader Fallback, Georgia, serif.
  - `--font-italic`: Cormorant Garamond, Cormorant Garamond Fallback, Georgia, serif.
  - `--font-hand`: Patrick Hand, Patrick Hand Fallback, system-ui, sans-serif.
- **Late faces move nothing.** Source:
  `apps/web/src/styles/fallbackFonts.css`, generated by `tools/font-metrics.ts`.
  - Every web face has a local fallback `@font-face` with `size-adjust`, `ascent-override`,
    `descent-override` and `line-gap-override`. The values come from the Fontsource woff2 files'
    `head`, `hhea`, `cmap` and `hmtx` tables and from the macOS system faces.
  - The fallbacks:
    - Instrument Sans → Helvetica Neue (400; Medium for 500 and 600).
    - Newsreader → Georgia.
    - Patrick Hand → Helvetica Neue.
    - Cormorant Garamond italic → Hoefler Text Italic.
  - `size-adjust` matches the average advance over English letter frequencies.
  - The overrides are the web face's `hhea` ascent, descent and line gap.
  - Measured in Chromium with the faces held back, sample strings set in the fallbacks are
    within 2.7% of the web faces' widths, at the same line heights.
  - Metric matching applies on Apple platforms, where the `local()` faces exist. Elsewhere the
    fallback faces don't load and the stacks fall through to the next family.
  - When a face arrives and a mounted note's text reflows, `NoteLayer`'s ResizeObserver reports
    the new height. Through the runtime's `measured()`, the note is re-indexed and its yarn edge
    pins re-attach on the next frame.
  - Culled notes have no DOM to measure. They keep the heights they were measured at (under the
    matched fallbacks on Apple platforms) until they next mount, when the observer's first
    report replaces them. So a font load never walks the board.
  - There is no separate font watch: a `document.fonts` listener would only re-read what the
    observer already reports (`e2e/canvas-type.spec.ts` proves the re-measure end to end).

| Role | Face | Weight | Size / leading | Tracking | Notes |
|---|---|---|---|---|---|
| Body | `--font-note` | 400 | 16 / 1.6 | — | ink 7:1 |
| Title | `--font-display` | 600 | 30 / 1.3 | — | margin 10 / 0 / 2 px |
| Long title | `--font-display` | 600 | 21 / 1.3 | — | `isLongTitle` |
| Subtitle | `--font-italic` italic | 400 | 21 / 1.3 | 0.04em | ink mixed 72 % into the paper; `font-synthesis: none` |
| Bullets | `--font-display` | 500 | 17 / 1.9 | 0.02em | "•" glyph, 1.35em indent |
| Print caption | `--font-italic` italic | 400 | 17 / 1.35 | 0.02em | |
| Tag title, subtitle | as above | | 18 px, 15 px | | |

- **Parse** (`parseNoteText`, rendering only; a note's text stays plain):
  - The first non-empty line is the title, unless it is a bullet.
  - A line straight after the title is the subtitle when `isLatinOnly` holds: Latin letters,
    digits, spaces and basic punctuation, at least one Latin letter (what the italic face draws).
  - Lines that start with "-" or "•" (after optional spaces) are bullets.
  - Runs of other lines are body blocks, with blank lines at their edges dropped.
  - `isLongTitle` steps a title down to 21 px when `textWidthEm · 30` exceeds 1.9 × the
    content width.
  - A title whose longest word is wider than its measure at 30 px steps down a pixel at a
    time, only as far as that word needs (`titleSize`, from the word's measured overflow, cached
    per word and size): “Phrasebook” (158 px at 30 px) takes 28 px in a 150 px measure, not the
    21 px floor. Below 21 px the word breaks.

- **Quotes and apostrophes.** The UI's copy, its accessible names and what the live
  region says set typographic marks: ’ for an apostrophe, “ ” around a quoted name, ‘ ’ inside
  them (“Couldn’t save”; Tied “Spring trip” to “Packing list”). Straight marks stay in code.

## Yarn
Sources: `apps/web/src/canvas/drawYarn.ts` (`YARN_STYLE`, `drawStrand`),
`apps/web/src/canvas/yarnGeometry.ts`, `apps/web/src/canvas/YarnRenderer.ts`,
`apps/web/src/canvas/attach.ts`.
- **Geometry.** Each segment is a cubic Bézier between its two edge pins. Its midpoint B(0.5) is
  exactly the sag point. At rest that point is the chord's midpoint pushed down by
  `min(0.08 · span, 140)` world px (`SAG`). The curve is flattened adaptively, to a depth of at
  most 12.
- **Width** (`strandWidthPx`). 7.2 world px × zoom, clamped to 1.5–17 screen px: 7.2 px at
  zoom 1, the 17 px cap from zoom 2.36 and the 1.5 px floor below 0.21, so it meets overview's
  1.5 px threads at the 0.15 handover. A selected thread is 1.35 × wider. 
- **Strokes,** in order, with round caps and joins; `w` is the strand width:
  1. Shadow: the same width in `rgba(43,28,14,0.26)`, offset (0.2 w, 0.4 w).
  2. Dye.
  3. Twist, only when `w ≥ 4.5` px (from zoom 0.625; finer plies are sub-pixel noise): slanted
     stripes every 1.14 w along the path (8.2 px a turn at zoom 1), reaching 0.38 w either side and
     leaning 0.3 w. First a dark groove (0.16 w, the dye mixed 24 % toward black) half a period
     in, then a lit ply (0.26 w, mixed 24 % toward white): a fine, soft twist.
  4. Crown, with the twist: the path again, 0.24 w wide, mixed 30 % toward white and moved
     (−0.08 w, −0.2 w) toward the light, which rounds the cord.

  Lite draws the dye stroke only. There is no `shadowBlur`, no `filter` and no glow.
- **Edge pins** (`attach.ts`, `EDGE_PIN = { inset: 14, corner: 26, gap: 24, topGap: 28 }`).
  - A segment from A to B ends on A's edge facing B and on B's edge facing A. The facing edge is
    the one the ray from the note's centre toward the neighbour's centre leaves through,
    worked out in the note's turned frame.
  - The pin sits on that ray, 14 px inside the paper and at least 26 px from a corner.
  - Several pins on one edge keep ray order and stay at least 24 px apart. On the top edge they
    keep 28 px clear of the hanging pin either side.
  
- **Caching.** Static yarn is drawn into an offscreen layer covering the viewport plus 25 % per
  side (`STATIC_MARGIN`). Only segments touching moving notes, springs or animations redraw per
  frame.

## Pins
Sources: `apps/web/src/canvas/drawYarn.ts` (`PIN_HEAD`, `renderHead`, `renderHook`, `HOOK`,
`createPinSprites`), `apps/web/src/canvas/geometry.ts` (`PIN`), `apps/web/src/canvas/hitTest.ts`,
`apps/web/src/styles/stationery.ts` (`PIN_BRASS` and `PRINT_STOCK`, also CSS `--pin-brass`
and `--print-stock`).
- **Hanging pin.** Top centre, offset by a seeded −12 to 12 px in x (0 on a tag) and 14 px down
  (`PIN.insetY`). The paper turns about it. It carries no yarn.
- **World radii.** Hanging pin 10, edge pin 10, a tag's edge pin 7, hook 5.5. An edge pin is a hanging pin's size, wide enough for the cord to end under it.
  - Screen radius is world radius × zoom, clamped to [3, 2 × world] px and rounded to 0.5 px.
  - Lite: a flat `#B08A3A` disc of 1.5–3 px, with no edge pins.
- **Glossy dome** (`renderHead`):
  - Cast shadow in two passes of `rgba(43,28,14)`, squashed to 0.78 in height: offset
    (0.55 r, 0.75 r) at 1.35 r and alpha 0.3, then (0.3 r, 0.42 r) at 1.02 r and alpha 0.42.
  - Dome: a radial gradient from (−0.38 r, −0.42 r): `#FFF4CC` 0, `#F1D48A` 0.16, `#C99E48` 0.5,
    `#8C6727` 0.82, `#5A3F14` 1.
  - A reflected-light arc at 0.8 r, from 0.1π to 0.6π, in `rgba(255,228,160,0.38)`.
  - A halo of 0.42 r in `rgba(255,252,236,0.75)`.
  - A specular ellipse, 0.2 r × 0.12 r, in `rgba(255,255,248,0.92)`.
  - The centre pixel stays mid brass.
- **Tag hook** (`renderHook`, `HOOK = { shankUp: 4.6, shankWidth: 0.7 }`, in head radii):
  - A shank 4.6 r long and 0.7 r wide, its rod lit from the left: `#6E5220`, `#EBD08A`,
    `#C9A04A`, `#B08A3A`, `#5E4418`.
  - An eyelet washer squashed to 0.62: `#E9CD7C`, `#B08A3A`, `#6A4E1E`, with an inner ring at
    0.6 r.
  - A two-pass shadow offset (0.35 r, 0.45 r).
  - The eyelet centre is the pin point and the pivot. It has no seeded x-offset.
- **Sprites.** Heads and hooks are pre-rendered per DPR (capped at 4) on a 10 % radius ladder
  (`SPRITE_STEP` 1.1), warmed in idle time, and drawn scaled to the exact size.
- **Hover.** A hovered pin gets a 2 px ring in `rgba(231,200,115,0.6)` at r + 1 when it can be
  pulled from: any pin with the Yarn tool, a selected thread's end pin with Select (where another
  thread's edge pin reads as that thread, and a hanging pin as its note). This is pin
  feedback, not a yarn glow.
- **Hit-testing.** Pins come first, within 10 screen px (`PIN_HIT_RADIUS_PX`), then yarn, within
  `yarnHitTolerancePx(zoom, selected)`: the drawn cord's half-width plus 3 px
  (`YARN_HIT_MARGIN_PX`), never under 6 px
  (`YARN_HIT_TOLERANCE_PX`). That is 6 px up to zoom 0.83, 6.6 px at zoom 1, 10.2 px at 2 and
  11.5 px from 2.36. The selected yarn is drawn 1.35 × wider (`SELECTED_SCALE`) and its tolerance
  follows: 7.9 px at zoom 1, 12.7 px at 2, 14.5 px from 2.36. In lite, edge pins are neither drawn
  nor hit-tested.

## Motion
Sources: `apps/web/src/styles/motion.ts`, `apps/web/src/styles/tokens.css`,
`apps/web/src/canvas/yarnPhysics.ts`, `apps/web/src/canvas/yarnAnim.ts`,
`apps/web/src/canvas/YarnMotion.ts`, `apps/web/src/canvas/CameraController.ts`,
`apps/web/src/app/prefs.ts`.
- **Tokens.** `MOTION = { fast: 120, base: 200, slow: 320 }` ms, mirrored as `--motion-fast`,
  `--motion-base` and `--motion-slow`. The easing is `cubic-bezier(.2, .8, .2, 1)` (`EASE`).
- **Sag spring** (`SPRING`).
  - ζ = 0.75 and ω = 17.8 rad/s, which is 4 / (ζ · 0.3 s): it settles in about 300 ms, with a
    2.84 % overshoot (the rule allows 4 %).
  - It snaps to rest within 0.1 world px and 2 world px/s on both axes.
  - The step uses the closed-form solution, so any dt is exact. A dt that is ≤ 0 or not finite
    is ignored, and a state that would overflow lands on its target.
- **Draw-in.** `DRAW_IN_MS` 350: the drawn share of the path length is `EASE(t)`. The far edge
  pin appears when the draw-in reaches it.
- **Loosen-out on delete.** `DELETE_MS` 200: the sag offset grows to 1.6 × its rest depth
  (`LOOSEN_SAG_SCALE`) along `EASE`, and the opacity falls as `1 − EASE(t)`.
- **Camera.** Keyboard zoom and fits ease over 320 ms with `EASE`. `will-change: transform` is
  set on the world and the cork only while the camera moves, and removed 150 ms after the last
  change (`MOVING_TAIL_MS`).
- **Reduced motion.** The `motion` pref is `system`, `full` or `reduced`; `system` follows
  `prefers-reduced-motion` live. When motion is reduced:
  - springs snap;
  - draw-in and delete become 100 ms opacity fades (`REDUCED_FADE_MS`);
  - camera moves jump;
  - the CSS motion tokens become 0 ms (by the media query, or by `:root[data-motion="reduced"]`).
- **No idle motion.** The frame loop stops once every spring is at rest and no animation runs.
  On the demo board, 2 s after the last input, the page
  runs no `requestAnimationFrame` callback for 3 s (`e2e/canvas-motion.spec.ts`).
- **Only the tokens.** Every CSS transition and animation under `apps/web/src`
  takes `--motion-fast`, `--motion-base` or `--motion-slow` (or 0 s) on `--ease`; a 0 s step (a
  visibility flip held back by a delay) may be `linear`. The one named exception is focus mode's
  fade, `--focus-fade` 250 ms. Every `Element.animate()` takes a `MOTION`
  token (one per beat of its keyframes) and `EASE_CSS`. `test/styles/motionTokens.test.ts` reads
  every stylesheet and call site.
- **Press.** A note under the pointer's press (select tool) lifts `--press-lift` (1 px, the
  `translate` property) and a deeper shadow, `--press-shadow`
  (`0 5px 6px / 0.2, 0 13px 21px / 0.17, 0 26px 44px / 0.13`), comes in over `--motion-fast`;
  at the release the sheet settles back over `--motion-fast`. Transform and opacity only: the
  runtime sets one attribute (`data-pressed`) on the one pressed note, so no other note is
  restyled or rendered (`canvas-motion.spec.ts`). Lite notes lift without the deeper shadow.
- **Stamp press.** A stamp note pinned here (the "+") presses its stamp in on the stamp's first
  appearance: `scale` 1.04 to 1 and its ink from 0.85 of its 0.92 to full, over
  `--motion-slow` on `--ease` (`notes/stampPress.ts`). It never plays for a note that arrives with the board, nor when the note scrolls out and back. Reduced motion: the stamp is
  simply there.

## Level of detail and culling
Sources: `apps/web/src/canvas/lod.ts`, `apps/web/src/canvas/cull.ts`.
- **LOD.** Three levels, each with a gap that stops flicker at its threshold:
  - full → lite below zoom **0.35** (`LOD.lite.enterBelow`), back to full at **≥ 0.38**;
  - lite → overview below **0.15** (`LOD.overview.enterBelow`), back to lite at **≥ 0.18**.

  A jump (fit-all, a key zoom with reduced motion) can skip a level either way; coming up from
  overview, lite's 0.38 decides between lite and full. A non-finite zoom keeps the current mode.
  - **Reading distance** runs from zoom 0.6, where 16 px note text is about
    10 px on screen, to the closest zoom, 2. All of it is full detail, so a note is read as its
    own type, never as lite's greeked bars. 
  - **Crisp text.** At every reading zoom the text is rastered at the scale it is seen at:
    `will-change: transform` (world and cork) is gone 150 ms after the camera rests, nothing in
    the world asks for its own layer, the world's translation is whole device px and every font
    size in a note is whole CSS px. `e2e/canvas-camera.spec.ts` checks this at 0.6, 1, 1.5 and 2
    after an eased `=` zoom (`text is crisp at every reading zoom`).
  - **Why 0.15.** Lite mounts every note in the cull rect (the viewport grown by half its larger
    side). At 0.15 on a 1280 × 720 viewport that is about 800 notes of the wide 5,000 board and
    all of a 1,000-note board. Below it the count grows with 1/zoom², so the DOM goes and the canvas takes over.
- **What lite draws.**
  - Notes: paper colour, greeked bars, 256 px images, one soft shadow; no deckle mask, fibres,
    decoration or stamp.
  - Pins: flat discs, and no edge pins.
  - Yarn: one stroke, with no shadow or twist.
- **What overview draws** (`apps/web/src/canvas/overview.ts`, drawn by `YarnRenderer`). No note
  is mounted (the `.world` layer is hidden), and the notes are canvas cards:
  - **Card.** The note's palette paper (`PALETTE`), its tilt about the pin, and one offset
    shadow painted under the card, never `shadowBlur`: `rgba(40,24,8,0.28)`, 0.75 px right and 1.25 px down at every overview zoom. The brown is
    the DOM papers' shadow colour; the direction follows the cork's light from the upper left;
    1.25 px is about where a paper shadow's middle layer (7 px down) lands at the 0.15 handover,
    and holding it in screen px below that keeps a lifted lower edge on even a 10 px card.
  - **Print.** White stock `#FBF8F2` with the image area inside the 12 px border and above a
    32 px caption band (when there is a caption) in the image's average colour. The colour is
    measured once per file from its 256 px variant (`lib/imageTone.ts`); until then it is
    `#9A968C`. No image is decoded per frame.
  - **Pin.** A flat brass `#B08A3A` dot, 10 world px × zoom clamped to 0.75–1.5 px (it meets
    lite's 1.5 px at the threshold). No edge pins.
  - **Threads.** One Bézier stroke per segment in its dye, 10 world px × zoom clamped to
    1–1.5 px (lite's 1.5 px at the threshold). Their opacity rises with log zoom from 0.45 at
    zoom 0.02 (and below) to 1 at 0.15: a whole board's threads at full strength bury its cards. A selected
    thread is twice as wide.
  - **Selection and hover.** Outlines on the pin layer 1.5 px outside the paper: the selection
    in cream's ink (`#2B2724`) at 1.5 px (ink matches the full-detail graphite
    line and holds 3.3:1 on the cork), a hovered card in `rgba(251,248,242,0.9)` at 1 px. The DOM
    handles are hidden (a card is a few px; there is no resize in overview).
  - **Cursor.** The world is hidden, so no note element sets the cursor: the capture stage
    marks the root `data-card` while the pointer is over a card (any tool but pan), and the note
    tool shows `default` there (`copy` on cork), the yarn tool `crosshair`, as over a mounted
    note.
  - **No text.** Lite's greeked bars are not drawn, so they disappear at the 0.15 handover.
  - **Paint order.** Cards in z order. Cards that overlap nothing share one fill per colour; an
    overlap starts a new level (shadow included), so the z order holds wherever it shows.
    Threads are drawn over every card, batched by dye; their order among themselves is not kept.
- **The picture pyramid** (`apps/web/src/canvas/pyramid/`). On a board of more
  than 5,000 notes, overview is drawn from raster tiles a worker paints with exactly the paint
  above (cards, shadows, threads at their rest sag, pin dots), in levels 2× apart from 0.18 down
  past the zoom floor; a level's screen-size details are drawn for its middle zoom, so they are
  within √2 of the card overview's. Side by side on the 5,000 board the two differ by a mean of
  2.6–5.4 of 255 a channel (resampling softens edges a little). An edit shows in the next frame:
  its old and new rects are drawn over the stale tiles until they are painted again. Focus mode
  and boards of 5,000 notes or fewer draw the card overview. See [ADR-0003](../adr/0003-rendering.md).
- **Culling.** Notes and yarn are mounted and drawn in the viewport grown by half its larger
  side (`CULL.marginFrac` 0.5). A recull is due after panning a quarter of the viewport or
  zooming past × 1.1 either way.
- **Zoom.** The camera's zoom is clamped to 0.005–2 (`ZOOM_MIN`, `ZOOM_MAX` in `Camera.ts`).
   The floor lets fit-all frame a 100,000-note board (about 108,000 × 95,000 world px). The closest zoom is 2×: at 2× a note's 16 px text is 32 px on screen, more than enough to read, and zooming further would only show the paper's tooth.
  Below 0.02 nothing in the look changes but the scale: thread opacity stays at its 0.45 floor,
  pin dots and threads at their screen-px floors. Wheel, pinch and key steps are multiplicative
  and stop at the clamp, about the pointer or the viewport centre. Fits (Shift+1, Shift+2, focus)
  clamp, so Shift+2 on one small note frames it at 2×. A camera remembered on this device at a
  zoom past 2 comes back at 2× about the viewport centre (`recallCamera`).

## Yarn layering modes
Sources: `apps/web/src/canvas/canvas.css`, `apps/web/src/canvas/layering.ts`,
`apps/web/src/canvas/YarnRenderer.ts`, `apps/web/src/canvas/runtime.ts`. The pref is `layer`, default `over`; it can be changed only in developer builds.
- **`over`.** The yarn canvas (z-index 3) sits above the world (z 2), with pins on top (z 4).
  Every thread paints across every note, including an unrelated higher note it passes over. A
  press on any visible span takes the yarn.
- **`over-fix`.** The yarn canvas stays above the world, but segments are painted in order of
  their level, `max(z_a, z_b)`.
  - An occluder is a note higher than both ends of a segment whose rect the segment's polyline
    crosses. Each occluder is erased (`destination-out`) once: after every segment below its z
    and before every segment at or above it.
  - The erase is the note's paper as drawn: its rect inset 1 px and turned about its pin by its
    tilt. It is not the torn outline, and it is not the layered sheet.
  - A press on an erased span goes to the note.
  - Dynamic segments that need an erase are drawn in their own buffer, so the erase never
    touches the static cache.
- **`under`.** The yarn canvas drops to z-index 1, below the world, so every thread passes
  beneath every paper, its own two notes included.
  - The pin layer paints the first and last 24 world px of each segment (`PIN_STUB_WORLD`)
    beneath the pin heads, so each thread visibly leaves its edge pin and crosses the paper's
    edge.
  - A press on a hidden span goes to the note.

## Sidebar
Sources: `apps/web/src/ui/sidebar.css`, `apps/web/src/ui/Sidebar.tsx`, `apps/web/src/ui/MiniBar.tsx`,
`apps/web/src/ui/SelectionActions.tsx`, `apps/web/src/ui/sidebarIcons.tsx`.
- **One way to do each thing.** The sidebar is the board's only
  persistent navigation and its only controls; there is no bar over a selection. Every key is the
  accelerator of a control here (V, Y, P, ⌘K, ⌘D, F, ⌫, ⌘Z / ⇧⌘Z). There are no Pan, Marquee or Text tools: a drag on bare cork pans, a Shift-drag there (on touch and pen
  a long press, then a drag) draws the marquee, "+" makes notes. Only the Yarn tool ties threads
  (`C` is its keyboard path); with Select a pin ties nothing, though a selected thread's end pin
  still extends it.
- **Panel.**
  - Position: 14 px from the left; top `clamp(12px, 4.7vh, 44px)`; bottom
    `clamp(12px, 8vh, 76px)`. Its room, gutters and all, is `--sidebar-room` (80 px).
  - Size and shape: 52 px wide, radius 16 px.
  - Colours: `--sidebar-paper` (cream mixed 72 % with white) for the background, shared with
    the mini-bar and the picker sheet; the UI ink (`--ui-ink`) for the icons.
  - Shadow: a 0.5 px hairline at 0.09, `0 1px 1.5px / 0.07`, `0 3px 10px / 0.07`.
- **The mark.** A crimson capital P, rounded and heavy, with a green ribbon (the tie) sweeping
  across its stem from the lower left and tucking under the bowl. The artwork is
  `docs/assets/logo.svg` (crimson `#A21D45` to `#860F32`, green `#93B25F` to `#7A9C4B`, a
  soft shadow on the stem under the tie). Small sizes use a flat drawing in a 32-unit box with a
  slightly heavier tie and no gradients or shadow (`--brand-crimson` `#A21D45`, `--brand-green`
  `#86A755`): `AppMark` in the sidebar, `apps/web/public/favicon.svg` (lighter inks on a dark tab
  bar), and the app icon at 16 to 48 px. The app icon (`apps/desktop/scripts/make-icons.mjs`) sets
  the mark on a cream paper tile (`#F3EBDD`): on Apple's grid for macOS (an 824 px body on 1024,
  corner 184), full-bleed for Windows and Linux. 
- **Order, top to bottom.** The mark (28 px in a 40 px target), rule, crimson
  "+", rule, then Select, Yarn, Photo and Search; the selection's section (while notes are
  selected), a flexible gap, a rule, the save dot's foot, Books and Settings. Under a book the
  writer's tools take the board's place (Text style, rule, Bold, Italic, Footnote, Pin to board,
  then Search). The rules are 20 × 1 px, rose yarn at 34 %.
- **Items.**
  - Buttons are drawn 36 px square with radius 10 px; an invisible band (`::after`, `--sb-band`
    4 px) takes the press 4 px past each edge, so every target is 44 px. They are spaced
    `clamp(8px, 1vh, 10px)` (8 px at heights up to 900 px), so the bands never overlap.
  - Icons are 20 px, 1.5 px strokes on the 24-unit set, with round caps and joins.
  - The active tool sits on a pill: the ink 8 % into cream, with a faint inset shadow.
  - The "+" is a 32 px disc in the accent (`--yarn-apricot` 80 % with `--yarn-rose`,
    ≈ `#BF475A`), with a white 16 px icon at a 1.75 px stroke; its band reaches 6 px past it,
    a 44 px target.
- **The selection's section.** Under Search, while notes are selected: a rule, then Duplicate,
  Focus and Delete (tooltips name ⌘D, F and ⌫; Delete turns crimson ink under the pointer).
  While a thread is selected it shows Delete alone, which unties it (one undo step).
  It unfolds downward into the gap above the foot (its row grows from 0 over `--motion-base`
  while it fades in) and folds away when nothing is selected, inert; nothing above it moves.
  Focus on one of its buttons as it folds away goes to the board.
- **Folding.** The mark is a button (`aria-expanded`, "Papertie — hide tools" / "show tools").
  The panel is a frame of fixed size holding the paper (`.sidebar-sheet`) and two shadows (the
  panel's and the tile's). Folding, the paper's `clip-path` (an inset rounded at the panel's
  16 px) rises over `--motion-slow` on `--ease` until there is as much paper under the mark as above it, the
  panel's shadow fading out as the tile's fades in, while everything under the mark fades out
  over `--motion-fast` (then hidden and inert); the mark stays as it is. No layout moves: only
  the clip and opacities. Unrolled, the paper
  comes down and the tools fade back in once it is nearly there. Reduced motion: instant.
  Folded, the frame lets presses below the tile through to the board. A save dot with something
  to say (waiting, failing, notices kept, its popover open) rests on the tile under the mark,
  which grows by its 28 px; its live region is the UI layer's, never in what folds. The state is a
  pref (`prefs.sidebar`), kept across restarts; folded, the board still takes every
  key.
- **Hover** styles apply only to pointers that hover (`@media (hover: hover)`), so a tap leaves
  none behind. The "+" stays a crimson disc, a shade deeper under the pointer and while its
  picker is open.
- **Small windows.**
  - Under 768 px wide the sidebar is the mini-bar: a pill at the bottom left of 44 px targets with
    "+", Select, Yarn, Photo, Search and Settings (no mark, so it does not fold), its icons 23 px. The selection's
    row of three unfolds above its tools with a rule under it, so the pill grows upward and the
    tools stay put; the focus chip and the notice slips rise with it (`--minibar-rise`).
  - Under 620 px tall: tighter items, each its own target with no band (buttons
    `max(26px, 5.4vh)`, the "+" disc up to 32 px), and the panel scrolls only as a last resort.
- **Behaviour.** Select sets `prefs.tool` (V too). Yarn opens its colour picker, and a colour
  chosen there takes the tool up (Y too; folded to the mark, Y opens the same picker beside the
  mark and the panel stays folded). "+" opens the paper picker, Photo the file picker (P), Search the ⌘K palette and Settings its sheet over the board
  (pressed while open; a second press closes it).

## Paper picker ("+")
Sources: `apps/web/src/ui/NotePicker.tsx`, `apps/web/src/ui/notePicker.css`,
`apps/web/src/notes/noteDesign.ts`.
- **Design is chosen once.** A note's paper colour, paper style and decoration are chosen here,
  as it is made, and never changed afterwards anywhere in the UI (the file format still allows the change). Duplicate copies a note's design with it. A thread's colour
  is chosen the same way, in Yarn's colour picker (below), and is never changed afterwards.
- **The sheet** (`apps/web/src/ui/PickerSheet.tsx`, `pickerSheet.css`, shared with Yarn's colour
  picker). A popover 12 px right of the panel, its top beside "+" (above the mini-bar in a narrow window), kept 12 px inside the view and placed again on a resize, at most the view's height
  less 24 px (it scrolls past that); in the sidebar's material (cream panel, radius 18 px, the
  panel's shadow); it rises 4 px over `--motion-base`. It is rendered in the board's UI layer,
  never inside the panel (whose clip would cut it). It is as wide as the eight papers
  (266 px): every row and Pin end at the same edge. Rows, each under a Patrick Hand 15 px title:
  - Paper: the 8 palette papers as 28 px sheets with an ink hairline.
  - Style: Rustic and Smooth, two 30 px pills, the chosen one sunk like the active tool (print is
    the Photo tool's).
  - Decoration: None, Fold, Margin, Dots, Perforation, Stamp and Layered sheet, as square
    samples sharing the row's width (about 33 px) drawn on the paper chosen, by the same CSS
    as on a note, in miniature (the stamp is the inline `StampMark`).
  - Tooltips are the names alone (“Rose”, “Stamp”), the same as the accessible names. Yarn’s dyes
    carry their own names (Undyed, Rose, Crimson, Indigo, Moss, Lilac, Ochre, Ink).
  - Sheet: the 8 papers again, for the layered sheet; the row unfolds (0 → its height over
    `--motion-base`) only while Layered sheet is chosen, inert otherwise.
  - Pin note: the ink button of the board's sheets (38 px), with a muted ↵.
  - Opened from the mini-bar or on a touch screen (`pointer: coarse`), as Yarn's colours: the
    papers, decorations and sheets are four to the row, each a 44 px-tall face, the style pills
    and Pin are 44 px high, and the ↵ (no Enter key there) is not shown.
- **Choosing.** Every choice is a real radio over the whole face of its sample (arrow keys move
  within a row); the chosen one has a 2 px ink ring set 2 px off. It opens on the design last
  pinned (`prefs.noteColor`, `noteStyle`, `noteDecoration`, `noteSheet`), the focus
  on its paper, so "+" then Enter pins at once. Enter anywhere in it, or Pin note, pins: the note
  is made at the middle of the view and opens for writing, and the design is remembered (Enter during a composition belongs to the composition). Esc closes it wherever the focus is (the focus back on
  "+"), as do a press outside it, the focus moving on to another control, "+" again and folding.

## Yarn's colour picker
Sources: `apps/web/src/ui/YarnPicker.tsx`, `apps/web/src/ui/PickerSheet.tsx`,
`apps/web/src/ui/pickerSheet.css`.
- **The colour is chosen first, once.** Yarn (and Y) opens a picker in the paper picker's sheet,
  place and behaviour, its top beside Yarn (above the mini-bar in a narrow window; beside the mark
  when the panel is folded, which Y leaves folded, and Esc then gives the mark the focus). One
  row under a Patrick Hand "Colour" title: the palette's eight thread dyes as 28 px rounds of the dye
  with an ink hairline, sharing the 266 px row. Opened from the mini-bar or on a touch screen
  (`pointer: coarse`) they are two rows of four, each a 44 px-tall box (about 62 px wide) around a
  32 px round, so a finger's one-tap choice lands. While it is open Yarn is quietly tinted, as
  "+" deepens while its picker is. It opens on the colour last chosen (`prefs.yarnColor`, default apricot), focused.
- **Choosing.** One press on a dye chooses it (a click, a tap, Space, or Enter on the dye the
  arrows have moved to; the arrows only move): the picker closes, Yarn is the tool, armed with
  that colour, and the keys go to the board. Every thread drawn (and every Shift-drop winding,
  and C's `Connect to…`) is tied in it until the colour is changed. Pressed again while it is the
  tool, Yarn opens the picker again, for the next threads' colour. Esc chooses nothing (the focus
  back on Yarn), as do a press outside it, the focus moving on, Yarn (or Y) again and another
  tool's key (V puts it away and takes Select up; the keys go to the board). One picker is open
  at a time: "+" and Yarn put each other's away.

## Selection, hover, focus and the empty board
Sources: `apps/web/src/canvas/canvas.css`, `apps/web/src/notes/note.css`,
`apps/web/src/ui/EmptyHint.tsx`, `apps/web/src/ui/emptyHint.css`,
`apps/web/src/proto/controls.css`, `apps/web/src/ui/sidebar.css`, `apps/web/src/perf/perfHud.css`.
- **Selection.** A graphite pencil mark, not a UI ring: a 1.5 px line in cream's ink
  (`var(--ink-cream)`, `#2B2724`) 5 px outside the paper, radius 4 px, with a cream `#FBF8F2`
  hairline inside (1 px) and outside (1.5 px).
  Two tones, so the mark stands at least 3:1 off what it lies on, as measured at DPR 1 in
  `e2e/polish.spec.ts`: the ink against the paper 4.0–12.0:1 and against its halo 12.5–13.8:1,
  the halo against the cork 3.6–4.5:1. A lone graphite line on mid-brown cork measured 2.0:1. The
  selected sheet keeps its lifted shadow.
- **Handles.** On the line: 11 px paper discs with a 1.5 px ink rim at the corners, 7 × 16 and
  16 × 7 px tabs on the right and bottom edges, each with the cream halo and a 1–2 px shadow.
- **Hover.** With the select or yarn tool (not while panning or holding Space), a mounted note's
  shadow deepens halfway to the selected lift: fibre `0 3px 4px / 0 9px 15px / 0 19px 33px`,
  other papers `0 2px 2px / 0 6px 11px / 0 15px 28px`. No transition, so a pointer sweeping
  across notes costs one repaint each.
- **Keyboard focus.** Sidebar and strip controls get a 2 px ink outline 2 px out on
  `:focus-visible`: 13.3:1 on the panels' cream and 6.3:1 against the light end of the cork's
  granule ramp (`#D2A06D`).
- **One language for the screen UI** (`apps/web/src/styles/tokens.css`). The
  sidebar and its selection section, the mini-bar, the "+" sheet, the save dot and its popover,
  the focus chip, ⌘K, settings (the import dialog with it), the notice and photo
  slips share one hover, press and focus language, ink on fibre paper:
  - **Hover** moves the control's ink, quietly but always visibly (rest and hover at least
    1.15:1, `uiContrast.test.ts`; 1.17–1.42 as built). A light control's icon, label or
    hairline darkens by `--hover-ink` (15 %), `color-mix(in srgb, <ink>, #000 var(--hover-ink))`;
    an ink-filled button (Pin, the save and settings buttons, the danger button, the "+"
    disc, the save dot) thins toward the paper by `--hover-ink-on-dark` (12 %). A label already
    in full ink shows it in its hairline or underline (quiet buttons, links), or takes the UI
    ink at rest (the focus chip's arrows and Threads, the settings chips) so its hover can
    darken. Add photo, a paper button with a full-ink label, darkens its paper. It lays no
    wash. Delete keeps its own hover, crimson ink.
  - **Press** inks the fibre paper itself: the paper under a quiet control takes `--press-wash`
    (`--ink-cream` at 9 %); an ink button (Pin, the settings buttons, the "+" disc),
    already ink, sinks: its shadow settles to its nearest layer.
  - **Focus** is the indigo ink ring: `--focus-outline` (`--focus-ring-width` 2 px of
    `--focus-ring`, indigo's dye) set `--focus-ring-offset` (2 px) out, on every control and field,
    the text fields included.
  - **A tap** shows the same press, never the browser's own flash: `-webkit-tap-highlight-color`
    is transparent on the page.
  - The UI's inks are two tokens, `--ui-ink` (ink at 84 % on cream) and `--ui-muted` (74 %);
    each surface's muted ink (`--sync-muted`, `--set-muted`, the sheet titles,
    the hint's subtitle) is `--ui-muted`. Every text and icon pair holds 4.5:1 or more, hovered,
    pressed and chosen (`test/styles/uiContrast.test.ts`).
- **Higher contrast.** Under `prefers-contrast: more` the fibre paper loses its fibre (each paper is
  its plain colour, the UI's stationery has no overlay) and `--ui-ink` and `--ui-muted` become
  full ink, `--ink-cream`.
- **Textures for every screen.** The cork tiles, the fibre and the baked papers are one file
  each for every density. A world-space tile is drawn at the board's zoom, so a 1x screen at
  zoom 2 needs every pixel a 2x screen does at zoom 1, and a separate 1x file would leave 1x screens soft from zoom 1 up. `textures.test.ts` checks every
  served file against DPR × zoom × its tile size at DPR 1 and 2 up to zoom 2.
- **The developer strip and HUD** take the sidebar's material: `color-mix(paper-cream 55%, #fff)`,
  radius 14 px, the sidebar's three-layer shadow (two layers on the HUD), no fibre. Strip
  buttons are 8 px pills; a pressed one sinks like the sidebar's active tool
  (`color-mix(ink 8%, paper-cream)` with a 1 px inner shadow).
- **The empty board.** A cream paper hint card, 340 px wide,
  torn with `deckle-3.svg`, fibre at 0.55, its shadow on its own box behind the deepest bite, a
  CSS brass dome pin (highlight up-left, cast shadow down-right), tilted −1.2° and centred in the
  view in screen space. Copy: “A clean board” / *Begin with a blank sheet* / “Press + to pin a
  thought”, in the note type (display serif title, italic subtitle). It catches no pointer, so the cork
  under it still pans, and it leaves with the first note.
- **The marquee.** A Shift-drag on bare cork draws the band (an ink hairline) and adds the notes
  it meets to the selection; a plain drag on cork pans, and a click there clears the selection.
  Touch and pen have no Shift: a press held still on bare cork for 400 ms (`LONG_PRESS_MS`) arms
  the band, its corner showing at the press as an ink L (2 px, fading in over `--motion-fast`),
  and the drag that follows draws it; a drag before then pans. That long press opens no context
  menu or callout.
- The connect-drag preview thread is the full cord in the dye Yarn is armed with: with its landing pin
  glowing it already reads as a thread in hand.

## The app's stationery

The app's sheets, slips and popovers are one stationery set with the board:
cream fibre paper with its fibre (`.sync-paper` in `apps/web/src/sync/sync.css`: `--paper-cream`,
`fibre.webp` multiplied at 0.5, radius 2 px, a three-layer paper shadow
`0 1px 1px / 0.18, 0 4px 8px / 0.14, 0 12px 24px / 0.10` in `rgb(40 24 8)`), ink type, hairline
rules (`--ink-cream` at 16 %), a 2 px indigo-ink outline (`--focus-ring`) on every
`:focus-visible`, the 120/200/320 ms motion tokens on `--ease`. Sheets rise into place (`sync-rise`, 6 px, `--motion-base`) and never
move while they rest. Nothing glows. Under reduced motion the rise and every fade are instant.

## Save dot
Sources: `apps/web/src/sync/SaveDot.tsx`, `apps/web/src/sync/sync.css`.
- **The dot.** An 8 px ink dot in a 28 px hit area at the sidebar's foot; its room is kept
  whether it shows or not. `Saved` shows for 1.5 s, then fades (`--motion-slow`). `Saving…`
  pulses once, at most every second, only when motion is allowed. `Not saved yet — trying again` is a hollow ring (1.5 px ink). `Couldn’t save`, and changes the popover still lists,
  are crimson ink (`--yarn-apricot` 78 % into the ink).  The `aria-label` holds the same words.
- **The popover.** A fibre sheet `min(300px, 100vw − 100px)` wide beside the dot: a display serif 16 px
  status line with its ink mark, the count of changes waiting, the kept notices in Instrument
  Sans 14 px (`--font-note`) under a hairline, and ink buttons (38 px). Esc, an outside press or a resize closes it; focus returns to the dot.
- **Notice slips** stand at the foot of the view on the same paper, Instrument Sans 14 px
  (`--font-note`) for the message. A rejected slip keeps a crimson rule at its edge and stays
  until dismissed; dropped and reset slips fade after 8 s (paused under the pointer or focus).
  The slip over every screen (a reload asked for) stands, beside the book, on the pane the user
  works in, never across the seam (`app/slipPlace.ts`).
  The slips and the popover's notices are set in Instrument Sans.

## Focus chip
Sources: `apps/web/src/focus/focus.css`, `apps/web/src/focus/FocusChip.tsx`.
- **The tag.** A fibre tag at the bottom centre, 28 px up, turned −0.4°, with a punched eyelet
  (8 px, ink 12 % into the paper, an inset shadow) on its left. It rises as focus begins and
  sinks away as it ends; the notice slips move up above it while it is there.
- **Contents.** `Focus · {n} step(s)` in display serif 15 px, round 32 px − and + steps (a disabled one
  greys and takes no click), `All` (pressed at the whole component), `· Bring in…`, and ✕ with
  an `Esc` key cap (hidden on touch screens, which have no Esc). In a window under 768 px wide the label is the steps alone (“2 steps”; the toolbar’s name says Focus), and − and + are a full
  44 × 44, reaching 6 px past the tag above and below, their press wash the drawn 32 px round
  
- **The board.** Notes leaving focus fade over 250 ms (`--focus-fade`, 0 under reduced motion),
  then leave paint and hit-testing; loose ends are faint short cords.

## Merge bridge
Sources: `apps/web/src/canvas/MergeWatch.ts`, `apps/web/src/canvas/mergeBridge.ts`,
`apps/web/src/interactions/merge.ts`.
- **When.** A single note dragged with the select tool with Alt (Option) held (full and lite, not overview; a merge is destructive, so like ⌥ into a book it happens only with ⌥; on touch and pen, which have no ⌥, the hold alone) whose edge
  lies within 18 screen px of another note's facing edge, overlapping it by no more than 2 px and
  alongside it for at least 40 % of the shorter side. A note it is moved over is never its
  target (moving over notes never merges), though lying over one does not stop it joining another
  beside it. Photos, notes focus hides and merges past the text limit never join. Held there
  250 ms, the bridge is armed and a release with Alt still held merges. Without Alt a note held
  beside another only moves there: no bridge, no merge, so notes can sit in a tight row.
- **Look.** A liquid neck of paper across the gap, on a small canvas in the overlay (within the
  viewport; it holds no backing store while idle): the colour runs from one paper to the other,
  the target's fibre runs on into it (multiply 0.55, screen 0.25 on ink; none in lite),
  and it fades in under each torn edge from 4 world px in. Each side is a meniscus: it leaves the
  edge along it and turns into the waist halfway across. A 1 px, 3 px blur shadow falls on the
  cork in the gap only.
- **Motion.** Forming, the waist springs (ζ 0.5) to a narrow neck, 8 to 24 % of the shared
  stretch as the gap closes, its feet 1.8 waists wide: it wobbles once and rests, and then nothing
  draws. Armed, it fills out over 200 ms (`EASE`) to a full join across the whole shared stretch.
  Let go early, moved away or Alt let go, it thins back into the target's edge over 120 ms. After
  a merge (committed at once) the dragged paper flows in over the target, shrinking a little
  toward it, and fades, while the target's paper grows to its new text, its torn edge moving down,
  both over 320 ms. Reduced motion: the waist snaps and the merge lands at once, with no absorb.

## The shelf and book covers
Sources: `apps/web/src/book/shelf.css`, `apps/web/src/book/cover/cover.css`,
`apps/web/src/book/cover/cover.ts`, `packages/core/src/palette.ts`.
- **The shelf** is a case of light wood laid over the dimmed board, at most 1,180 px wide, with
  shelves at a fixed pitch and the books standing face-out on them. The wood is drawn in CSS
  gradients: a pale oak (`--wood` `#D9BF98`) with a slightly warmer grain and darker joints
  between its boards. The planks have a lit top (`#F3E6CB`), a face (`#D9BC8F` to `#C9A573`)
  and a dark edge (`#9C7A50`). Type on the wood is `--shelf-ink` `#3A2A1C`. The case rises 8 px
  into place over `--motion-slow`.
- **The same wood** (`--wood-back`) is the ground a book's page lies on in the writer.
- **A book** on the shelf is 120 × 173 px.
- **A cover** is cream fibre paper with a generated drawing printed on it, fixed by the book's
  `cover` record: a seed, an ink (`rose`, `indigo`, `sage`, `lilac`, `ochre` or `ink`) and a
  motif family: `fields` (flat rectangles of colour), `overprint` (discs and bars in two inks)
  or `contour` (level lines or grain). The title is set on the cover in the display serif and
  scales with it.
