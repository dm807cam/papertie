/** The page asks for the files the system opened (its preload, once a page). */
export const FILES_WANTED = 'papertie:files-wanted'
/** Main → page: one opened file, `{ url, name }` (`OpenedFiles`). */
export const OPEN_FILE = 'papertie:open-file'

/** What `OPEN_FILE` carries: where the page fetches the file, once, and its name. */
export interface OpenedFile {
  url: string
  name: string
}

/** The page asks to be told of a newer release (its preload, once a page). */
export const UPDATES_WANTED = 'papertie:updates-wanted'
/** Main → page: a newer release, `UpdateNotice`. */
export const UPDATE_AVAILABLE = 'papertie:update-available'
/** Page → main, "Download": open the announced release's page in the system browser. */
export const UPDATE_OPEN = 'papertie:update-open'
/** Page → main, "Later": the version (a string) is not announced again. */
export const UPDATE_DISMISS = 'papertie:update-dismiss'
/** Page → main, answered: whether Papertie checks for updates by itself. */
export const UPDATE_SETTING_GET = 'papertie:update-setting-get'
/** Page → main, answered with the setting as kept: switch the automatic check on or off. */
export const UPDATE_SETTING_SET = 'papertie:update-setting-set'

/**
 * What `UPDATE_AVAILABLE` carries: the newer version, and its release page on GitHub (checked in
 * the main process, `isReleaseUrl`). `manual`: the person asked through the menu.
 */
export interface UpdateNotice {
  version: string
  url: string
  manual: boolean
}
