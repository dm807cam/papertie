import { navigate } from './router'

/**
 * The desktop app's one bridge (apps/desktop's preload): a `.papertie` file the system opened
 * (double-clicked, dropped on the icon, given on the command line) arrives as a one-time
 * `papertie://app/_opened/…` URL and its name. In a browser there is no bridge and nothing listens.
 */
interface DesktopBridge {
  onOpenFile(cb: (file: { url: string; name: string }) => void): void
}

let offered: File | null = null
const takers = new Set<() => void>()

/** Hand `file` to Settings → Import, which asks before it replaces the board, as for a chosen file. */
export function offerFile(file: File): void {
  offered = file
  for (const take of takers) take()
}

/**
 * The offered file, taken now if one waits, and each one offered until the returned stop. `use`
 * returns `false` to leave the file waiting (it is busy), for the next take.
 */
export function takeOfferedFiles(use: (file: File) => boolean | undefined): () => void {
  const take = () => {
    const file = offered
    if (!file || use(file) === false) return
    if (offered === file) offered = null
  }
  takers.add(take)
  take()
  return () => {
    takers.delete(take)
  }
}

/** Desktop app: each opened file is fetched and offered, and Settings → Export opens for it. */
export function listenForOpenedFiles(): void {
  ;(window as { papertieDesktop?: DesktopBridge }).papertieDesktop?.onOpenFile(({ url, name }) => {
    fetch(url)
      .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(String(res.status)))))
      .then(
        (blob) => {
          offerFile(new File([blob], name))
          navigate({ name: 'settings', section: 'export' })
        },
        () => {},
      )
  })
}
