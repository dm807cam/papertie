import { contextBridge, ipcRenderer } from 'electron'
import {
  FILES_WANTED,
  OPEN_FILE,
  type OpenedFile,
  UPDATE_AVAILABLE,
  UPDATE_DISMISS,
  UPDATE_OPEN,
  UPDATE_SETTING_GET,
  UPDATE_SETTING_SET,
  UPDATES_WANTED,
  type UpdateNotice,
} from './channels'

/*
 * The page's one door to the desktop (sandboxed, context-isolated). Two things pass through it,
 * and nothing else of Electron or Node reaches the page:
 *
 * `.papertie` files the system opened. The page (apps/web `app/openedFile.ts`) listens once; each
 * file comes as a one-time `papertie://app/_opened/…` URL and its name, which it fetches and hands
 * to Settings → Import.
 *
 * The update check (apps/web `app/updates.ts`). The main process asks GitHub, never the page; the
 * page is told of a newer release (its version and its release page, both checked in main), and
 * answers "Download" (main opens the page it announced: the page names no address), "Later" (a
 * version), or reads and sets the one switch. Every value is made a plain string or boolean here,
 * and checked again in main.
 */
let listening = false
let listeningForUpdates = false

contextBridge.exposeInMainWorld('papertieDesktop', {
  onOpenFile(cb: (file: OpenedFile) => void): void {
    if (listening || typeof cb !== 'function') return
    listening = true
    ipcRenderer.on(OPEN_FILE, (_event, file: OpenedFile) => {
      cb({ url: String(file.url), name: String(file.name) })
    })
    ipcRenderer.send(FILES_WANTED)
  },
  onUpdateAvailable(cb: (update: UpdateNotice) => void): void {
    if (listeningForUpdates || typeof cb !== 'function') return
    listeningForUpdates = true
    ipcRenderer.on(UPDATE_AVAILABLE, (_event, update: UpdateNotice) => {
      cb({
        version: String(update.version),
        url: String(update.url),
        manual: update.manual === true,
      })
    })
    ipcRenderer.send(UPDATES_WANTED)
  },
  openUpdate(): void {
    ipcRenderer.send(UPDATE_OPEN)
  },
  dismissUpdate(version: string): void {
    ipcRenderer.send(UPDATE_DISMISS, String(version))
  },
  async getUpdateSetting(): Promise<boolean> {
    return (await ipcRenderer.invoke(UPDATE_SETTING_GET)) === true
  },
  async setUpdateSetting(on: boolean): Promise<boolean> {
    return (await ipcRenderer.invoke(UPDATE_SETTING_SET, on === true)) === true
  },
})
