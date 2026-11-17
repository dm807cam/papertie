import { PALETTE, PALETTE_TOKENS, type PaletteToken } from '@papertie/core'
import { type CSSProperties, type KeyboardEvent, useId, useRef, useState } from 'react'
import { prefsStore } from '../app/prefs'
import { Choice, PickerSheet, Row } from './PickerSheet'

const isArrow = (e: KeyboardEvent) => e.key.startsWith('Arrow')

/**
 * The colours of the sidebar's Yarn: the palette's eight thread dyes, a new thread's colour for
 * good. It opens on the colour last chosen, and one press on a dye chooses it (a
 * click, Space, or Enter on the dye the arrows have moved to; the arrows only move). It opens in
 * a picker sheet beside the panel (`PickerSheet`: Esc, a press outside it and the focus leaving it
 * close it, choosing nothing). `anchor` is the Yarn button.
 */
export function YarnPicker({
  anchor,
  onChoose,
  onClose,
}: {
  anchor: HTMLElement | null
  onChoose(color: PaletteToken): void
  /** `refocus`: put the focus back on Yarn (Esc). */
  onClose(refocus: boolean): void
}) {
  const [color, setColor] = useState(() => prefsStore.getState().yarnColor)
  const name = useId()
  // An arrow checks the next dye with a click of its own: that moves, it does not choose.
  const arrowing = useRef(false)

  return (
    <PickerSheet
      anchor={anchor}
      label="New thread"
      className="yarn-picker"
      onEnter={() => onChoose(color)}
      onClose={onClose}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: it only watches its radios' arrows */}
      <div
        className="picker-form"
        onKeyDown={(e) => {
          if (isArrow(e)) arrowing.current = true
        }}
        onKeyUp={(e) => {
          if (isArrow(e)) arrowing.current = false
        }}
      >
        {/* Its columns are pickerSheet.css's: eight, or four of a finger's size. */}
        <Row title="Colour">
          {PALETTE_TOKENS.map((t) => (
            <Choice
              key={t}
              className="picker-dye"
              name={name}
              label={PALETTE[t].yarnName}
              title={PALETTE[t].yarnName}
              checked={color === t}
              onPick={() => setColor(t)}
              onPress={() => {
                if (!arrowing.current) onChoose(t)
              }}
              style={{ '--swatch': PALETTE[t].yarn } as CSSProperties}
            />
          ))}
        </Row>
      </div>
    </PickerSheet>
  )
}
