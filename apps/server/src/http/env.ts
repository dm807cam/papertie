import type { Logger } from '../log'

/** The one user whose data dir this is (`user.ts`): every board and asset is theirs. */
export interface AppUser {
  id: string
}

/** `unmatched` is set by the not-found handler so the request log can tell. */
export type AppEnv = { Variables: { user: AppUser; log: Logger; unmatched?: boolean } }
