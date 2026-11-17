import { type ReactNode, useEffect, useState } from 'react'
import { devHooks } from '../lib/devHooks'
import { applyPaletteVars, paletteCssVars } from '../styles/palette'
import { CorkSection } from './CorkPanel'
import { CoverStudy } from './CoverStudy'
import { DecorNotes } from './DecorNotes'
import { MockupNotes } from './MockupNotes'
import { loadPalette, type Palette, PaletteTuner } from './PaletteTuner'
import { PaperGrid } from './PaperGrid'
import { PinSpecimen } from './PinSpecimen'
import { TypeSpecimen } from './TypeSpecimen'
import { YarnSwatches } from './YarnSwatches'
import './study.css'

const SECTIONS = [
  { id: 'cork', title: 'Cork' },
  { id: 'papers', title: 'Paper' },
  { id: 'type', title: 'Type' },
  { id: 'yarn', title: 'Yarn' },
  { id: 'pins', title: 'Pins' },
  { id: 'mockup', title: 'Mockup notes' },
  { id: 'decor', title: 'Decorations' },
  { id: 'palette', title: 'Palette' },
  { id: 'covers', title: 'Covers' },
] as const

type SectionId = (typeof SECTIONS)[number]['id']

function Section({ id, lede, children }: { id: SectionId; lede: string; children: ReactNode }) {
  const i = SECTIONS.findIndex((s) => s.id === id)
  const s = SECTIONS[i]
  return (
    <section
      className="study-section"
      id={`study-${id}`}
      data-section={id}
      aria-labelledby={`h-${id}`}
    >
      <header className="study-section-head">
        <span className="study-section-num">{String(i + 1).padStart(2, '0')}</span>
        <h2 id={`h-${id}`}>{s?.title}</h2>
        <p>{lede}</p>
      </header>
      {children}
    </section>
  )
}

/** The material study at `#/study`: cork, paper, type, yarn, pins and a live palette tuner. */
export function StudyPage() {
  const [palette, setPalette] = useState<Palette>(loadPalette)

  useEffect(() => {
    const root = document.documentElement
    const vars = paletteCssVars(palette)
    applyPaletteVars(root, vars)
    // Rustic's papers come with their fibre baked in (note.css): a tuned paper draws it live.
    const base = paletteCssVars()
    const tuned = Object.entries(vars).some(([k, v]) => base[k as keyof typeof base] !== v)
    root.toggleAttribute('data-palette-tuned', tuned)
  }, [palette])
  useEffect(
    () => () => {
      applyPaletteVars(document.documentElement, paletteCssVars())
      document.documentElement.removeAttribute('data-palette-tuned')
    },
    [],
  )
  useEffect(() => {
    const hooks = devHooks()
    if (!hooks) return
    hooks.ready = true
    return () => {
      hooks.ready = false
    }
  }, [])

  const jump = (id: SectionId) =>
    document.getElementById(`study-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  return (
    <main className="study" data-testid="study">
      <header className="study-masthead">
        <p className="study-kicker">Material study</p>
        <h1>Papertie</h1>
        <p className="study-intro">
          Cork, fibre paper, type, yarn and brass, studied together at the sizes they will be used.
          Everything here renders with the production note view and canvas code.
        </p>
        <nav className="study-index" aria-label="Sections">
          {SECTIONS.map((s, i) => (
            <button key={s.id} type="button" onClick={() => jump(s.id)}>
              <span>{String(i + 1).padStart(2, '0')}</span> {s.title}
            </button>
          ))}
        </nav>
      </header>

      <Section
        id="cork"
        lede="Two seamless tiles of non-commensurate size, each with two octaves that crossfade with zoom, so the grain stays plausible from 0.02× to 4× and the repeat never lines up."
      >
        <CorkSection />
      </Section>

      <Section
        id="papers"
        lede="Three paper styles across the eight pigments. Every note has a seeded tilt of up to 1° about its pin, a separate layered shadow and, on fibre paper, a fibre overlay and one of eight deckle masks."
      >
        <PaperGrid />
      </Section>

      <Section
        id="type"
        lede="Self-hosted with unicode-range subsets, so a page only fetches the glyphs it shows. Content readability comes first; the handwritten face is kept for labels."
      >
        <TypeSpecimen />
      </Section>

      <Section
        id="yarn"
        lede="Each dye at rest sag between two pins, crossing cream and ink paper: base stroke, lighter dashed ply and a low offset shadow — no blur, no filters."
      >
        <YarnSwatches palette={palette} />
      </Section>

      <Section
        id="pins"
        lede="The brass head at three zooms, on bare cork and on cream fibre paper. The highlight sits up-left so the centre always reads as brass."
      >
        <PinSpecimen />
      </Section>

      <Section
        id="mockup"
        lede="The note kinds: a display serif title, an italic Latin subtitle and display serif bullets parsed from plain text; a decoration or the stamp; a layered sheet behind a note; a print tilted 2.5–5°; and tags, 120 px wide or narrower, hanging from a brass hook."
      >
        <MockupNotes />
      </Section>

      <Section
        id="decor"
        lede="The four decorations a note can carry, drawn in its own colours with no image behind them: a folded corner, a margin rule in the paper's dye, a dot grid and a perforated edge. Only the dot grid lies under the text, which keeps 7:1 on it. Then the stamp, a string tie in crimson."
      >
        <DecorNotes />
      </Section>

      <Section
        id="palette"
        lede="Tune paper and yarn against the cork above; the whole page follows. Ink must stay at 7:1 or better on every paper."
      >
        <PaletteTuner palette={palette} onChange={setPalette} />
      </Section>

      <Section
        id="covers"
        lede="A book's cover: cream fibre paper and one abstract drawing in a palette ink and a second ink beside it (colour fields, an overprint or contour lines), the title on the paper the drawing leaves bare. All of it is drawn from the seed the book was given when it was made; renaming keeps it, and only “New cover” draws again."
      >
        <CoverStudy />
      </Section>

      <footer className="study-footer">Material study · 2026</footer>
    </main>
  )
}
