import type { ReactNode } from 'react'

/** A 24-unit fine-line icon: stroked in the current colour, 1.5 px, round caps and joins. */
export function Icon({ children }: { children: ReactNode }) {
  return (
    <svg className="sidebar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {children}
    </svg>
  )
}

/**
 * The mark's P, a stem and a bowl in one heavy rounded stroke. It is drawn on the even lines of a
 * 32-unit box (the mark fills 2 to 30), so its edges fall on whole pixels at 16, 28 and 32 px.
 */
export const MARK_P =
  'M10 8C10 4.7 12.7 2 16 2H22C26.4 2 30 5.6 30 10V12C30 14.2 29.2 16.3 27.8 17.9C25.6 20.5 23 21 20.7 21V16C22.5 16 24 14.5 24 12.7V11.3C24 9.5 22.5 8 20.7 8H16V25.7C16 28.1 14.1 30 11.7 30C10.8 30 10 29.2 10 28.4Z'
/** The mark's tie: a ribbon from the lower left across the stem, tucked under the bowl. */
export const MARK_TIE =
  'M2 22.6V19.2C2.9 15.4 6.2 12 10.4 12C13.6 12 17.2 14.6 20.7 16.2C23.3 17.4 25.8 17.9 27.8 17.9C25.6 20.5 23 21 20.7 21C17 21 13.6 18 10.4 18C6.8 18 4.3 20.1 2 22.6Z'

/** The Papertie mark, flat for small sizes: the P in the current colour, the tie in its green. */
export function AppMark() {
  return (
    <svg className="sidebar-mark-svg" viewBox="2 2 28 28" aria-hidden="true" focusable="false">
      <path d={MARK_P} />
      <path className="sidebar-mark-tie" d={MARK_TIE} />
    </svg>
  )
}

export function PlusIcon() {
  return (
    <Icon>
      <path d="M12 6.5v11M6.5 12h11" />
    </Icon>
  )
}

export function SelectIcon() {
  return (
    <Icon>
      <path className="sidebar-icon-fill" d="M6.5 3.8v15l4-3.7 2.7 5.6 2.3-1.1-2.7-5.5h5.4Z" />
    </Icon>
  )
}

export function YarnIcon() {
  return (
    <Icon>
      <circle cx="5.6" cy="18.4" r="1.9" />
      <circle cx="18.4" cy="5.6" r="1.9" />
      <path d="M7.1 17.1c2.6-.6 3.1-2.9 3.9-5.1s2.6-4.4 5.9-5.1" />
    </Icon>
  )
}

export function ImageIcon() {
  return (
    <Icon>
      <rect x="3.5" y="4.8" width="17" height="14.4" rx="1.6" />
      <path d="M4 17.2l4.6-5 3.3 3.4 2.4-2.4 5.6 4.4" />
      <circle cx="15.6" cy="9" r="1.4" />
    </Icon>
  )
}

export function SearchIcon() {
  return (
    <Icon>
      <circle cx="10.6" cy="10.6" r="5.8" />
      <path d="M15 15l4.6 4.6" />
    </Icon>
  )
}

export function DuplicateIcon() {
  return (
    <Icon>
      <rect x="8.5" y="8.5" width="11" height="11" rx="1.8" />
      <path d="M15.5 8.5V6.3a1.8 1.8 0 0 0-1.8-1.8H6.3a1.8 1.8 0 0 0-1.8 1.8v7.4a1.8 1.8 0 0 0 1.8 1.8h2.2" />
    </Icon>
  )
}

export function FocusIcon() {
  return (
    <Icon>
      <path d="M4.5 9V6.3a1.8 1.8 0 0 1 1.8-1.8H9M15 4.5h2.7a1.8 1.8 0 0 1 1.8 1.8V9M19.5 15v2.7a1.8 1.8 0 0 1-1.8 1.8H15M9 19.5H6.3a1.8 1.8 0 0 1-1.8-1.8V15" />
      <circle cx="12" cy="12" r="2.2" />
    </Icon>
  )
}

export function DeleteIcon() {
  return (
    <Icon>
      <path d="M5 7h14M9.5 7V5.2c0-.4.3-.7.7-.7h3.6c.4 0 .7.3.7.7V7M6.8 7l.8 11.3c0 .7.6 1.2 1.3 1.2h6.2c.7 0 1.2-.5 1.3-1.2L17.2 7M10 10.5v6M14 10.5v6" />
    </Icon>
  )
}

/** Books: an open book, its two pages bowed from the spine. */
export function BooksIcon() {
  return (
    <Icon>
      <path d="M12 6.9C10.1 5.5 7.5 5 4.5 5.2v12.6c3-.2 5.6.3 7.5 1.7 1.9-1.4 4.5-1.9 7.5-1.7V5.2c-3-.2-5.6.3-7.5 1.7ZM12 6.9v12.4" />
    </Icon>
  )
}

/** Gear outline: `teeth` flat-topped teeth around a ring, as one closed polygon. */
function gearPath(teeth: number, rOut: number, rIn: number): string {
  const pts: string[] = []
  const step = (Math.PI * 2) / teeth
  const tooth = step * 0.22
  const flank = step * 0.08
  for (let i = 0; i < teeth; i++) {
    const a = i * step - Math.PI / 2
    for (const [da, r] of [
      [-tooth - flank, rIn],
      [-tooth, rOut],
      [tooth, rOut],
      [tooth + flank, rIn],
    ] as const) {
      const t = a + da
      pts.push(`${(12 + r * Math.cos(t)).toFixed(2)} ${(12 + r * Math.sin(t)).toFixed(2)}`)
    }
  }
  return `M${pts.join('L')}Z`
}

const GEAR = gearPath(8, 8.6, 6.6)

export function SettingsIcon() {
  return (
    <Icon>
      <path d={GEAR} />
      <circle cx="12" cy="12" r="2.6" />
    </Icon>
  )
}
