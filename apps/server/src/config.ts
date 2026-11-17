import { SERVER_LIMITS } from './limits'

export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T

export interface ServerConfig {
  /** Where the boards live. */
  dataDir: string
  /** The origins whose writes are taken: the app's own page. */
  trustedOrigins: string[]
  /** How often an idle event stream is sent a comment, so nothing between takes it for dead. */
  sseKeepaliveMs: number
  store: {
    cacheSize: number
    idleEvictMs: number
    ringCommits: number
    ringBytes: number
    /** See `BoardStoreOptions.compactEveryHour`; tests that count backup files turn it off. */
    compactEveryHour: boolean
  }
  /** Widened to `number` so tests can override single limits. */
  limits: { [K in keyof typeof SERVER_LIMITS]: number }
  /**
   * The built web app (`apps/web/dist`), served with an SPA fallback for every non-`/api` GET; null
   * serves nothing. Absolute.
   */
  webDist: string | null
}

/** The desktop app's window loads from this privileged custom scheme. */
export const APP_ORIGIN = 'papertie://app'

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function merge(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue
    const cur = out[k]
    out[k] = isPlainObject(cur) && isPlainObject(v) ? merge(cur, v) : v
  }
  return out
}

/** The app's settings on `dataDir`, with `overrides` (tests: limits, store sizes) merged over them. */
export function loadConfig(
  dataDir: string,
  overrides: DeepPartial<ServerConfig> = {},
): ServerConfig {
  const base: ServerConfig = {
    dataDir,
    trustedOrigins: [APP_ORIGIN],
    sseKeepaliveMs: 15_000,
    store: {
      cacheSize: 32,
      idleEvictMs: 600_000,
      ringCommits: 512,
      ringBytes: 16_777_216,
      compactEveryHour: true,
    },
    limits: { ...SERVER_LIMITS },
    webDist: null,
  }
  return merge(
    base as unknown as Record<string, unknown>,
    overrides as Record<string, unknown>,
  ) as unknown as ServerConfig
}
