/** The scheme the window loads from: privileged, standard and secure (`main.ts`). */
export const SCHEME = 'papertie'
/** The one host under it: the app. */
export const APP_HOST = 'app'
/** The page's origin, which the server trusts for writes (`APP_ORIGIN` in apps/server). */
export const APP_ORIGIN = `${SCHEME}://${APP_HOST}`
/** Where the window opens: the board. */
export const START_URL = `${APP_ORIGIN}/`

/** Whether `raw` is a page of the app itself (`papertie://app/...`). */
export function isAppUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    return u.protocol === `${SCHEME}:` && u.host === APP_HOST
  } catch {
    return false
  }
}

/** Whether `raw` is a web link, for the system browser. */
export function isWebUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch {
    return false
  }
}
