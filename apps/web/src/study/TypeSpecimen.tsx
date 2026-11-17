import type { ReactNode } from 'react'

const MIXED =
  'To tie is to bind, to bring to a conclusion. Tie thoughts with thread and loose notes become one figure. Words and figures sit on one line — “quoted” and plain, 27.10.2026 and October 2026 — without the rhythm jumping between them.'

const COVERAGE = 'àéîõü ÅØß çñ ĄĘŁ ŐŰ ﬁ ﬂ « » ‹ › „ “ … — ‘’ “” ½ € 🧵'

function Row({ name, detail, children }: { name: string; detail: string; children: ReactNode }) {
  return (
    <div className="type-row">
      <div className="type-meta">
        <span className="type-name">{name}</span>
        <span className="type-detail">{detail}</span>
      </div>
      <div className="type-sample">{children}</div>
    </div>
  )
}

/** The four faces at their working sizes, plus a Unicode coverage line. */
export function TypeSpecimen() {
  return (
    <div className="type-specimen">
      <Row name="Newsreader" detail="600 · 40 px · wordmark">
        <p className="type-wordmark">Papertie</p>
      </Row>
      <Row name="Newsreader" detail="400 · 20 px · editorial">
        <p className="type-editorial">A quiet board for thinking with paper and thread.</p>
      </Row>
      <Row name="Instrument Sans" detail="400 · 16 / 1.6 · note text">
        <p className="type-para">{MIXED}</p>
      </Row>
      <Row name="Patrick Hand" detail="400 · 14 px · yarn labels and accents only">
        <div className="type-labels">
          {['supports', 'objection', 'next step'].map((label) => (
            <span key={label} className="yarn-tag">
              {label}
            </span>
          ))}
        </div>
      </Row>
      <Row name="Coverage" detail="accents, ligatures, punctuation, emoji">
        <p className="type-coverage">{COVERAGE}</p>
      </Row>
    </div>
  )
}
