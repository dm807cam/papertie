import { type Prefs, prefsStore, usePrefs } from '../app/prefs'
import { toggleHud } from '../perf/PerfHud'
import '../proto/controls.css'

export const BOARDS = ['demo', '100', '500', '1000', '5000', 'empty'] as const

type ChoiceKey = 'layer' | 'motion' | 'wheel'

/** The prototype's A/B selects: caption, accessible name and options. */
const CHOICES: { [K in ChoiceKey]: { caption: string; label: string; options: Prefs[K][] } } = {
  layer: { caption: 'yarn', label: 'Yarn layer', options: ['over', 'over-fix', 'under'] },
  motion: { caption: 'motion', label: 'Motion', options: ['system', 'full', 'reduced'] },
  wheel: { caption: 'wheel', label: 'Wheel', options: ['pan', 'zoom'] },
}

function Choice<K extends ChoiceKey>({ pref }: { pref: K }) {
  const value = usePrefs((p) => p[pref])
  const { caption, label, options } = CHOICES[pref]
  return (
    <label className="controls-field">
      <span className="controls-caption">{caption}</span>
      <select
        className="controls-select"
        aria-label={label}
        data-pref={pref}
        value={value}
        onChange={(e) => {
          const next = options.find((o) => o === e.currentTarget.value)
          if (next !== undefined) prefsStore.setState({ [pref]: next } as Pick<Prefs, K>)
        }}
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  )
}

function RotationToggle() {
  const tilt = usePrefs((p) => p.tilt)
  return (
    <label className="controls-field controls-check">
      <input
        type="checkbox"
        aria-label="Paper rotation"
        data-pref="tilt"
        checked={tilt}
        onChange={(e) => prefsStore.setState({ tilt: e.currentTarget.checked })}
      />
      <span className="controls-caption">tilt</span>
    </label>
  )
}

function HudToggle() {
  const hud = usePrefs((p) => p.hud)
  return (
    <button
      type="button"
      className="controls-btn"
      data-pref="hud"
      aria-pressed={hud}
      aria-keyshortcuts="`"
      title="Perf HUD (`)"
      onClick={toggleHud}
    >
      hud
    </button>
  )
}

/** Load another board: `?board=` changes and the page reloads. */
function pickBoard(board: string, current: string): void {
  if (board === current) return
  const url = new URL(location.href)
  url.searchParams.set('board', board)
  location.assign(url.href)
}

/**
 * The prototype's compact A/B strip, top right: the board picker (on a dev board, `board`), the
 * yarn layer, paper tilt, motion and wheel prefs and the perf HUD toggle. The tools live in
 * `Sidebar`.
 */
export function Controls({ board }: { board?: string }) {
  return (
    <div className="controls" role="toolbar" aria-label="Canvas controls">
      {board !== undefined && (
        <>
          <fieldset className="controls-group" aria-label="Board">
            <span className="controls-caption">board</span>
            {BOARDS.map((b) => (
              <button
                key={b}
                type="button"
                className="controls-btn"
                data-board={b}
                aria-pressed={b === board}
                onClick={() => pickBoard(b, board)}
              >
                {b}
              </button>
            ))}
          </fieldset>
          <span className="controls-rule" aria-hidden="true" />
        </>
      )}
      <fieldset className="controls-group controls-prefs" aria-label="Prototype">
        <Choice pref="layer" />
        <RotationToggle />
        <Choice pref="motion" />
        <Choice pref="wheel" />
        <HudToggle />
      </fieldset>
    </div>
  )
}
