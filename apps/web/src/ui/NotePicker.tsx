import { PALETTE, PALETTE_TOKENS } from '@papertie/core'
import { type CSSProperties, useId, useState } from 'react'
import { prefsStore } from '../app/prefs'
import {
  NOTE_DECORATIONS,
  NOTE_STYLES,
  type NoteDecoration,
  type NoteDesign,
  type NoteStyle,
  pinnedDesign,
  ruleDye,
} from '../notes/noteDesign'
import { StampMark } from '../notes/StampMark'
import { Choice, PickerSheet, Row } from './PickerSheet'
import { openPhotoPicker } from './photoPicker'
import { ImageIcon } from './sidebarIcons'
import './notePicker.css'

const STYLE_NAMES: Record<NoteStyle, string> = { rustic: 'Rustic', smooth: 'Smooth' }

/** The decorations' names: their accessible names and tooltips. */
const DECORATION_NAMES: Record<NoteDecoration, string> = {
  none: 'None',
  fold: 'Fold',
  margin: 'Margin',
  dots: 'Dots',
  perforation: 'Perforation',
  stamp: 'Stamp',
  layered: 'Layered sheet',
}

/** The design the picker opens on: the one last pinned. */
const lastDesign = (): NoteDesign => pinnedDesign(prefsStore.getState())

/**
 * The paper picker of the sidebar's "+": the paper colour, the paper style and one decoration of
 * a new note, which are its design for good. It opens on the design last pinned
 * and pins with one press (the Pin button, or Enter anywhere in it). A layered sheet unfolds its
 * colours beneath. The decorations are drawn on small sheets of the chosen paper. It opens in a
 * picker sheet beside the panel (`PickerSheet`: Esc, a press outside it and the focus leaving it
 * close it). `anchor` is "+".
 */
export function NotePicker({
  anchor,
  onPin,
  onClose,
}: {
  anchor: HTMLElement | null
  onPin(design: NoteDesign): void
  /** `refocus`: put the focus back on "+" (Esc). */
  onClose(refocus: boolean): void
}) {
  const [design, setDesign] = useState(lastDesign)
  const names = { paper: useId(), style: useId(), decoration: useId(), sheet: useId() }
  const set = (patch: Partial<NoteDesign>) => setDesign((d) => ({ ...d, ...patch }))
  const layered = design.decoration === 'layered'

  const pin = () => {
    prefsStore.setState({
      noteColor: design.paper,
      noteStyle: design.style,
      noteDecoration: design.decoration,
      noteSheet: design.sheet,
    })
    onPin(design)
  }

  return (
    <PickerSheet
      anchor={anchor}
      label="New note"
      className="note-picker"
      style={
        {
          '--pick-paper': PALETTE[design.paper].paper,
          '--pick-ink': PALETTE[design.paper].ink,
          '--pick-dye': PALETTE[ruleDye(design.paper)].yarn,
          '--pick-sheet': PALETTE[design.sheet].paper,
        } as CSSProperties
      }
      // The sheet's row unfolding changes its height: keep it inside the view.
      layout={layered}
      onEnter={pin}
      onClose={onClose}
    >
      <form
        className="picker-form"
        onSubmit={(e) => {
          e.preventDefault()
          pin()
        }}
      >
        <Row title="Paper" cols={PALETTE_TOKENS.length}>
          {PALETTE_TOKENS.map((t) => (
            <Choice
              key={t}
              className="sheet-swatch"
              name={names.paper}
              label={PALETTE[t].name}
              title={PALETTE[t].name}
              checked={design.paper === t}
              onPick={() => set({ paper: t })}
              style={{ '--swatch': PALETTE[t].paper } as CSSProperties}
            />
          ))}
        </Row>
        <Row title="Style">
          {NOTE_STYLES.map((s) => (
            <Choice
              key={s}
              className="note-picker-style"
              name={names.style}
              checked={design.style === s}
              onPick={() => set({ style: s })}
            >
              <span className="note-picker-style-name">{STYLE_NAMES[s]}</span>
            </Choice>
          ))}
        </Row>
        <Row title="Decoration" cols={NOTE_DECORATIONS.length}>
          {NOTE_DECORATIONS.map((d) => {
            const name = DECORATION_NAMES[d]
            return (
              <Choice
                key={d}
                className="note-picker-tile"
                name={names.decoration}
                label={name}
                title={name}
                checked={design.decoration === d}
                onPick={() => set({ decoration: d })}
              >
                <span
                  className="note-picker-sample"
                  data-decoration={d}
                  data-on={design.paper === 'ink' ? 'ink' : undefined}
                  aria-hidden="true"
                >
                  {d === 'stamp' && <StampMark className="note-picker-stamp" size={18} />}
                </span>
              </Choice>
            )
          })}
        </Row>
        <div className="note-picker-sheets" data-open={layered || undefined} inert={!layered}>
          <div className="note-picker-sheets-inner">
            <Row title="Sheet" cols={PALETTE_TOKENS.length}>
              {PALETTE_TOKENS.map((t) => (
                <Choice
                  key={t}
                  className="sheet-swatch"
                  name={names.sheet}
                  label={PALETTE[t].name}
                  title={PALETTE[t].name}
                  checked={design.sheet === t}
                  onPick={() => set({ sheet: t })}
                  style={{ '--swatch': PALETTE[t].paper } as CSSProperties}
                />
              ))}
            </Row>
          </div>
        </div>
        <button type="submit" className="note-picker-pin">
          Pin note
          <span className="note-picker-key" aria-hidden="true">
            ↵
          </span>
        </button>
        {/* Below 360 px Photo is here, not in the mini-bar (notePicker.css shows it there only). */}
        <button
          type="button"
          className="note-picker-photo"
          onClick={() => {
            onClose(false)
            openPhotoPicker()
          }}
        >
          <ImageIcon />
          Photo
        </button>
      </form>
    </PickerSheet>
  )
}
