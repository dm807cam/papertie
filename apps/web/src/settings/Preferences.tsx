import { useEffect, useState } from 'react'
import { type Prefs, prefsStore, usePrefs } from '../app/prefs'
import { type UpdateBridge, updateBridge } from '../app/updates'
import { Choice } from './controls'

const MOTION: readonly { value: Prefs['motion']; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'full', label: 'Full' },
  { value: 'reduced', label: 'Reduced' },
]

const WHEEL: readonly { value: Prefs['wheel']; label: string }[] = [
  { value: 'pan', label: 'Pan' },
  { value: 'zoom', label: 'Zoom' },
]

const TILT: readonly { value: 'tilted' | 'straight'; label: string }[] = [
  { value: 'tilted', label: 'Tilted' },
  { value: 'straight', label: 'Straight' },
]

const ON_OFF: readonly { value: 'on' | 'off'; label: string }[] = [
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
]

export const UPDATES_LEGEND = 'Check for updates automatically'
export const UPDATES_HINT =
  'Once a day, Papertie asks GitHub whether a newer version exists. Nothing about you or your board is sent.'

/**
 * Desktop app: whether Papertie checks for a newer version by itself. The choice is the main
 * process's (it checks with no page open to ask), read and set through the bridge; shown once it
 * is known. The menu's "Check for Updates…" works either way.
 */
function UpdateSetting({ bridge }: { bridge: UpdateBridge }) {
  const [on, setOn] = useState<boolean | null>(null)
  useEffect(() => {
    let live = true
    bridge.getUpdateSetting().then(
      (v) => {
        if (live) setOn(v)
      },
      () => {},
    )
    return () => {
      live = false
    }
  }, [bridge])
  if (on === null) return null
  return (
    <Choice
      legend={UPDATES_LEGEND}
      name="updates"
      value={on ? 'on' : 'off'}
      options={ON_OFF}
      hint={UPDATES_HINT}
      onChange={(v) => {
        const want = v === 'on'
        setOn(want)
        // What the main process kept is what is shown.
        bridge.setUpdateSetting(want).then(setOn, () => setOn(!want))
      }}
    />
  )
}

/**
 * How the app shows the board. The choices are the prefs store's: the canvas listens to it,
 * so a change takes hold at once, with no reload. They stay with the app, never in the board.
 */
export function Preferences() {
  const motion = usePrefs((p) => p.motion)
  const wheel = usePrefs((p) => p.wheel)
  const tilt = usePrefs((p) => p.tilt)
  const bridge = updateBridge()
  return (
    <div className="settings-section">
      <p className="settings-lead">These are kept with the app, not in your board.</p>
      <Choice
        legend="Motion"
        name="motion"
        value={motion}
        options={MOTION}
        onChange={(v) => prefsStore.setState({ motion: v })}
      />
      <Choice
        legend="Mouse wheel"
        name="wheel"
        value={wheel}
        options={WHEEL}
        onChange={(v) => prefsStore.setState({ wheel: v })}
      />
      <Choice
        legend="Paper tilt"
        name="tilt"
        value={tilt ? 'tilted' : 'straight'}
        options={TILT}
        hint="Each note rests at its own small angle."
        onChange={(v) => prefsStore.setState({ tilt: v === 'tilted' })}
      />
      {bridge && <UpdateSetting bridge={bridge} />}
    </div>
  )
}
