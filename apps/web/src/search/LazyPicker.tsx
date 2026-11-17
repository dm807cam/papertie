import {
  Component,
  type ComponentProps,
  type ReactNode,
  Suspense,
  useEffect,
  useState,
} from 'react'
import { lazyChunk, retryChunks } from '../app/ChunkBoundary'
import { isTypingTarget } from '../interactions/keys'
import type { Picker as PickerScreen } from './Picker'

type PickerProps = ComponentProps<typeof PickerScreen>

/**
 * The note picker (⌘K, Connect to…, Bring in…) is a chunk of its own, loaded at idle once the
 * board is up (`CanvasView`) or when first opened before that: once in, it opens in the very
 * commit that opens it. Until then nothing shows (no loading state), and the keys typed meanwhile
 * are the picker's, never the board's shortcuts (C, V…). Should the chunk not load (a failed fetch), the
 * picker closes quietly and the board stays in use; opened again, it tries the chunk again.
 */
export const PickerChunk = lazyChunk<PickerProps>(() => import('./Picker').then((m) => m.Picker))

let failures = 0

/** The picker's chunk did not come (it failed, or it hung): counted, and the picker put away. */
function gaveUp(onClose: () => void): void {
  failures++
  console.error(`picker did not load (${failures})`)
  onClose()
}

/** How long a picker waits for its chunk before it is put away. */
const WAIT_MS = 3000

/** A picker whose chunk did not load: closed, counted, the board left as it was. */
class Quiet extends Component<{ onClose(): void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(): void {
    gaveUp(this.props.onClose)
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}

/**
 * While the chunk comes: a letter typed on the board waits for the picker, never a board
 * shortcut (C, V…); Esc puts the picker away. What is typed into a field, a dead key or an IME's
 * composition, Tab, the F-keys and chords go on as ever. A chunk that has not come in 3 s is
 * given up.
 */
function Opening({ onClose }: { onClose(): void }) {
  useEffect(() => {
    const swallow = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1 || isTypingTarget(e.target))
        return
      e.preventDefault()
      e.stopPropagation()
    }
    const late = setTimeout(() => gaveUp(onClose), WAIT_MS)
    window.addEventListener('keydown', swallow, true)
    return () => {
      clearTimeout(late)
      window.removeEventListener('keydown', swallow, true)
    }
  }, [onClose])
  return null
}

export function Picker(props: PickerProps) {
  // Each picker opened asks again for a chunk that failed before.
  useState(retryChunks)
  return (
    <Quiet onClose={props.onClose}>
      <Suspense fallback={<Opening onClose={props.onClose} />}>
        <PickerChunk.Component {...props} />
      </Suspense>
    </Quiet>
  )
}
