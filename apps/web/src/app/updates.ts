import { useSyncExternalStore } from 'react'

/**
 * The desktop app's update check, as the page sees it (apps/desktop's preload). The main process
 * asks GitHub, never the page; the page is told of a newer release and answers "Download" or
 * "Later", and Settings → Preferences reads and sets the one switch. In a browser there is no
 * bridge: nothing listens, nothing is shown.
 */
export interface UpdateBridge {
  onUpdateAvailable(cb: (update: AvailableUpdate) => void): void
  /** "Download": the main process opens the release page it announced, in the system browser. */
  openUpdate(): void
  /** "Later": this version is not announced again. */
  dismissUpdate(version: string): void
  getUpdateSetting(): Promise<boolean>
  setUpdateSetting(on: boolean): Promise<boolean>
}

/** A newer Papertie. `manual`: the person asked through the menu. */
export interface AvailableUpdate {
  version: string
  url: string
  manual: boolean
}

/** The bridge, when this page runs in the desktop app and it has the update check. */
export function updateBridge(): UpdateBridge | null {
  if (typeof window === 'undefined') return null
  const b = (window as { papertieDesktop?: Partial<UpdateBridge> }).papertieDesktop
  return b && typeof b.onUpdateAvailable === 'function' && typeof b.getUpdateSetting === 'function'
    ? (b as UpdateBridge)
    : null
}

/** What the slip says. */
export const updateCopy = (version: string): string => `Papertie ${version} is available.`

/** A version as the slip prints it: digits and dots, nothing a release could smuggle words in by. */
const VERSION = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/

let update: AvailableUpdate | null = null
const listeners = new Set<() => void>()

/** Show `next` on the slip (`null`: no slip). */
export function showUpdate(next: AvailableUpdate | null): void {
  if (next !== null && !VERSION.test(next.version)) return
  update = next
  for (const fn of listeners) fn()
}

const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** The newer release to say, or `null`. */
export function useUpdate(): AvailableUpdate | null {
  return useSyncExternalStore(subscribe, () => update)
}

/** Desktop app: a newer release the main process found is shown on the slip. */
export function listenForUpdates(): void {
  updateBridge()?.onUpdateAvailable((u) => showUpdate(u))
}

/** "Download": the release page opens in the system browser, and the slip goes. */
export function downloadUpdate(): void {
  if (update === null) return
  updateBridge()?.openUpdate()
  showUpdate(null)
}

/** "Later": the slip goes, and this version is not announced again. */
export function laterUpdate(): void {
  if (update === null) return
  updateBridge()?.dismissUpdate(update.version)
  showUpdate(null)
}
