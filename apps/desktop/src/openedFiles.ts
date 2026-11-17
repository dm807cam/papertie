import { randomBytes } from 'node:crypto'
import { APP_ORIGIN } from './origin'

/** Where the page fetches a file the system opened: `papertie://app/_opened/<token>`. */
export const OPENED_PREFIX = '/_opened/'

const TOKEN = /^[A-Za-z0-9_-]{32}$/

/**
 * Files the system asked Papertie to open (a `.papertie` double-clicked, dropped on the icon, or
 * given on the command line), each behind a one-time token. The page fetches the file by its
 * token and hands it to Settings → Import as if it had been chosen there, so the import's question
 * and its backup are the same. Only paths the main process put here are ever served, once each.
 */
export class OpenedFiles {
  private readonly files = new Map<string, string>()

  /** The URL the page fetches `path` from, once. */
  add(path: string): string {
    const token = randomBytes(24).toString('base64url')
    this.files.set(token, path)
    return `${APP_ORIGIN}${OPENED_PREFIX}${token}`
  }

  /** The path behind `token`, spent; undefined for an unknown or spent one. */
  take(token: string): string | undefined {
    if (!TOKEN.test(token)) return undefined
    const path = this.files.get(token)
    this.files.delete(token)
    return path
  }
}
