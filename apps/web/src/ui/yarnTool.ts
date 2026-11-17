import { prefsStore, type Tool } from '../app/prefs'

/** What the sidebar registers: Yarn's colour picker, opened and put away by the tool keys. */
export interface YarnPickerHost {
  /** Open it (closed), or put it away (open), as Yarn's button does. */
  toggle(): void
  /** Put it away, choosing nothing. */
  close(): void
}

/**
 * The one place the tool keys take a tool up from: `takeUpTool`. The sidebar registers its
 * colour picker; until it does (or once it is gone) Y takes Yarn up at once, in the colour last
 * chosen.
 */
let host: YarnPickerHost | null = null

/** Register the sidebar's colour picker; the returned function takes it back. */
export function registerYarnPicker(h: YarnPickerHost): () => void {
  host = h
  return () => {
    if (host === h) host = null
  }
}

/**
 * A tool's key (V, Y). Y opens Yarn's colour picker, or puts it away again, as Yarn does; any other
 * tool's key puts it away, choosing nothing, and takes that tool up.
 */
export function takeUpTool(tool: Tool): void {
  if (tool === 'yarn') {
    if (host !== null) host.toggle()
    else prefsStore.setState({ tool })
    return
  }
  host?.close()
  prefsStore.setState({ tool })
}
