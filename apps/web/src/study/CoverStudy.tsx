import { COVER_MOTIFS } from '@papertie/core'
import { useMemo, useState } from 'react'
import { CoverSvg } from '../book/cover/CoverSvg'
import { type Cover, coverFromSeed, coverLayout } from '../book/cover/cover'

const SHELF = { w: 104, h: 150 }
const LARGE = { w: 208, h: 300 }

const TITLES = [
  'Notes on Collecting',
  'The Quiet Year',
  'Letters to M.',
  'A Field Guide to Small Rooms',
  'Essays 2026',
  'Dissertation',
  '',
  'What the River Kept',
  "Recipes from My Grandmother's Kitchen, Annotated and Tested",
  'Winter Light',
  "The Long Way Round: Walking the Coast from Dover to Land's End",
  'On Paper',
]

/** Twelve covers from `start` on, four of each motif, so a page shows all three. */
function twelve(start: number): Cover[] {
  const out: Cover[] = []
  const per = new Map<string, number>()
  for (let i = start; out.length < 12; i++) {
    const c = coverFromSeed((Math.imul(i, 0x9e3779b1) ^ 0x5f3759df) >>> 0)
    const n = per.get(c.motif) ?? 0
    if (n >= 4) continue
    per.set(c.motif, n + 1)
    out.push(c)
  }
  // Interleaved, so neighbours differ.
  const byMotif = COVER_MOTIFS.map((m) => out.filter((c) => c.motif === m))
  return [0, 1, 2, 3].flatMap((k) => byMotif.map((list) => list[k]).filter((c) => c !== undefined))
}

/** The covers: twelve seeds at shelf size, one of each motif at twice that, and a re-draw. */
export function CoverStudy() {
  const [start, setStart] = useState(1)
  const covers = useMemo(() => twelve(start), [start])
  const large = COVER_MOTIFS.map((m) => covers.find((c) => c.motif === m)).filter(
    (c): c is Cover => c !== undefined,
  )
  return (
    <div className="cover-study" data-testid="cover-study">
      <div className="cover-study-grid" data-testid="cover-study-12">
        {covers.map((c, i) => (
          <figure key={c.seed} className="study-figure cover-study-item">
            <CoverSvg cover={c} title={TITLES[i] ?? ''} size={SHELF} idBase={`study${c.seed}-s`} />
            <figcaption>
              {c.motif} · {c.ink} · {coverLayout(c)}
              <br />
              seed {c.seed}
            </figcaption>
          </figure>
        ))}
      </div>
      <div className="cover-study-large" data-testid="cover-study-large">
        {large.map((c, i) => (
          <figure key={c.seed} className="study-figure cover-study-item">
            <CoverSvg cover={c} title={TITLES[i] ?? ''} size={LARGE} idBase={`study${c.seed}-l`} />
            <figcaption>
              {c.motif} at twice the shelf size · seed {c.seed}
            </figcaption>
          </figure>
        ))}
      </div>
      <button type="button" className="cover-study-redraw" onClick={() => setStart((s) => s + 40)}>
        Draw twelve more
      </button>
    </div>
  )
}
