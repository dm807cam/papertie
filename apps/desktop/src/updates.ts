import { readFileSync, renameSync, writeFileSync } from 'node:fs'

/*
 * The update check: Papertie asks GitHub whether a newer release exists, and says so. It downloads
 * and installs nothing (the packages are unsigned): the person opens the release page themselves.
 * Everything here is free of Electron, so it is tested with a clock and a fetch of its own;
 * `main.ts` only wires it to the window, the menu and the timers.
 */

/** Where Papertie's releases are. The one place the repository is named. */
export const REPOSITORY = { owner: 'dm807cam', name: 'papertie' } as const
/** The one address asked: the latest release (no drafts, no pre-releases). */
export const LATEST_URL = `https://api.github.com/repos/${REPOSITORY.owner}/${REPOSITORY.name}/releases/latest`
/** A release page starts with this, and nothing else is opened or handed to the page. */
const RELEASES_PATH = `/${REPOSITORY.owner}/${REPOSITORY.name}/releases/`

/** Automatic checks are this far apart at the least. */
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000
/** An answer that takes longer is given up. */
export const TIMEOUT_MS = 10_000
/** An answer longer than this is not a release (GitHub's is a few thousand bytes). */
const MAX_BYTES = 1_000_000

// ---- versions ------------------------------------------------------------------------------

interface Version {
  core: [number, number, number]
  /** The pre-release identifiers (`-beta.1` is `['beta', '1']`); none for a release. */
  pre: string[]
}

const VERSION =
  /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/

/** `1.2.3` or `v1.2.3-beta.1` read; `null` for anything else. */
export function parseVersion(raw: unknown): Version | null {
  if (typeof raw !== 'string' || raw.length > 64) return null
  const m = VERSION.exec(raw)
  if (!m) return null
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] }
}

/** A version as it is written, without a leading `v` or build metadata; `null` when it is none. */
export function cleanVersion(raw: unknown): string | null {
  const v = parseVersion(raw)
  if (!v) return null
  return v.core.join('.') + (v.pre.length > 0 ? `-${v.pre.join('.')}` : '')
}

const NUMERIC = /^\d+$/

/**
 * Semantic-version order: below zero when `a` is older than `b`, above when newer, zero when the
 * same. A pre-release sorts before its release. A version that cannot be read is older than any
 * that can (two unreadable ones are the same).
 */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0)
  for (let i = 0; i < 3; i++) {
    const d = (x.core[i] as number) - (y.core[i] as number)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  // One of the two is a release: the release is the newer.
  if (x.pre.length === 0 || y.pre.length === 0) {
    if (x.pre.length === y.pre.length) return 0
    return x.pre.length === 0 ? 1 : -1
  }
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    if (p === q) continue
    const pn = NUMERIC.test(p)
    const qn = NUMERIC.test(q)
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1
    if (pn !== qn) return pn ? -1 : 1
    return p < q ? -1 : 1
  }
  return 0
}

// ---- the answer ----------------------------------------------------------------------------

/** A newer release: its version, and its page on GitHub. */
export interface Update {
  version: string
  url: string
}

/** Whether `raw` is a page of Papertie's releases on GitHub: the only kind of address trusted. */
export function isReleaseUrl(raw: unknown): raw is string {
  if (typeof raw !== 'string' || raw.length > 300) return false
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  return (
    u.protocol === 'https:' &&
    u.hostname === 'github.com' &&
    u.port === '' &&
    u.username === '' &&
    u.password === '' &&
    u.pathname.startsWith(RELEASES_PATH) &&
    // As GitHub writes it: nothing the parser had to mend (a backslash, a dot segment, a space).
    u.href === raw
  )
}

/**
 * GitHub's answer, checked field by field: the release (its version without the `v`, its page),
 * `'none'` for a draft or a pre-release (never announced), `null` for anything that is not a
 * release of Papertie's.
 */
export function parseRelease(raw: unknown): Update | 'none' | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const version = cleanVersion(r.tag_name)
  if (version === null || !isReleaseUrl(r.html_url)) return null
  if (typeof r.draft !== 'boolean' || typeof r.prerelease !== 'boolean') return null
  if (r.draft || r.prerelease || version.includes('-')) return 'none'
  return { version, url: r.html_url }
}

/** The part of `fetch` the check uses (Electron's `net.fetch`, or a test's). */
export type Fetch = (
  url: string,
  init: {
    method: 'GET'
    headers: Record<string, string>
    redirect: 'error'
    credentials: 'omit'
    cache: 'no-store'
    signal: AbortSignal
  },
) => Promise<Pick<Response, 'status' | 'text'>>

/**
 * The one request: a GET that says only which Papertie asks (`User-Agent`), with no cookies, no
 * language of the person's and no redirect followed. Resolves with the answer's JSON, unchecked; rejects when there is no answer in
 * time, when it is not a 200 (a rate limit's 403 or 429 too), or when it is not JSON.
 */
export async function fetchLatest(o: {
  fetch: Fetch
  url: string
  version: string
  signal: AbortSignal
  timeoutMs?: number
}): Promise<unknown> {
  const signal = AbortSignal.any([o.signal, AbortSignal.timeout(o.timeoutMs ?? TIMEOUT_MS)])
  const gone = new Promise<never>((_resolve, reject) => {
    const stop = () => reject(new Error('aborted'))
    if (signal.aborted) stop()
    else signal.addEventListener('abort', stop, { once: true })
  })
  // Raced with the signal, so a fetch that does not heed it still ends in time.
  const asked = (async () => {
    const res = await o.fetch(o.url, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `Papertie/${o.version}`,
        // Said plainly, so the network stack does not send the system's language in its place.
        'Accept-Language': 'en',
      },
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      signal,
    })
    if (res.status !== 200) throw new Error(`status ${res.status}`)
    const text = await res.text()
    if (text.length > MAX_BYTES) throw new Error('too long')
    return JSON.parse(text) as unknown
  })()
  asked.catch(() => {})
  return Promise.race([asked, gone])
}

/**
 * The address to ask instead of GitHub, for the end-to-end tests (`PAPERTIE_UPDATE_URL`): only a
 * plain `http` address on this machine. Anything else is no override.
 */
export function testUrl(raw: string | undefined): string | null {
  if (!raw) return null
  try {
    const u = new URL(raw)
    const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost'
    return u.protocol === 'http:' && local ? u.href : null
  } catch {
    return null
  }
}

// ---- what is remembered ----------------------------------------------------------------------

/** What `updates.json` holds, beside `window-state.json`. */
export interface UpdateState {
  /** Settings → Preferences: whether Papertie checks by itself. */
  auto: boolean
  /** When GitHub last answered (ms since the epoch); 0 before the first answer. */
  lastCheck: number
  /** The version the person answered "Later" to: not announced again. */
  dismissed: string | null
  /** The release GitHub last named, so a launch within the day can still say it. */
  latest: Update | null
}

export const DEFAULT_UPDATE_STATE: UpdateState = {
  auto: true,
  lastCheck: 0,
  dismissed: null,
  latest: null,
}

/** The state from what was saved (anything: a missing or damaged file is the default). */
export function parseUpdateState(raw: unknown): UpdateState {
  const state = { ...DEFAULT_UPDATE_STATE }
  if (typeof raw !== 'object' || raw === null) return state
  const r = raw as Record<string, unknown>
  if (typeof r.auto === 'boolean') state.auto = r.auto
  if (typeof r.lastCheck === 'number' && Number.isSafeInteger(r.lastCheck) && r.lastCheck > 0) {
    state.lastCheck = r.lastCheck
  }
  state.dismissed = cleanVersion(r.dismissed)
  if (typeof r.latest === 'object' && r.latest !== null) {
    const l = r.latest as Record<string, unknown>
    const version = cleanVersion(l.version)
    if (version !== null && isReleaseUrl(l.url)) state.latest = { version, url: l.url }
  }
  return state
}

/** The saved state, read from `file`. */
export function readUpdateState(file: string): UpdateState {
  let raw: unknown = null
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    raw = null
  }
  return parseUpdateState(raw)
}

/** Saves `state` to `file` whole or not at all (a temporary file renamed over it). */
export function writeUpdateState(file: string, state: UpdateState): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state)}\n`)
  renameSync(tmp, file)
}

// ---- when to ask, and what to say ------------------------------------------------------------

export interface UpdaterOptions {
  /** The version running (`app.getVersion()`). */
  current: string
  /** Whether Papertie may check by itself at all: never in development or under test. */
  enabled: boolean
  now(): number
  /** The request (`fetchLatest`): GitHub's JSON, or a rejection. */
  latest(signal: AbortSignal): Promise<unknown>
  state: UpdateState
  /** The state changed: keep it. */
  save(state: UpdateState): void
  /** Tell the page. `manual`: the person asked (the menu), so it is said wherever they are. */
  announce(update: Update, manual: boolean): void
}

/** What a manual check answers. */
export type CheckResult = 'newer' | 'current' | 'failed'

/**
 * The update check's rules. By itself (`automatic`, called at launch and each hour after):
 * only when allowed and switched on, GitHub at most once in 24 hours, a version once in a run,
 * a version answered "Later" never again, every failure silent. Asked for (`manual`): always
 * GitHub, and always an answer.
 */
export class Updater {
  private state: UpdateState
  /** The update the page shows now, for a page that asks again (a reload). */
  private showing: { update: Update; manual: boolean } | null = null
  /** The version announced by an automatic check in this run. */
  private said: string | null = null
  private asking: Promise<Update | 'none' | null> | null = null
  private abort: AbortController | null = null
  private stopped = false

  constructor(private readonly o: UpdaterOptions) {
    this.state = { ...o.state }
  }

  /** Settings → Preferences: whether Papertie checks by itself. */
  get auto(): boolean {
    return this.state.auto
  }

  setAuto(on: boolean): void {
    if (this.state.auto === on) return
    this.keep({ auto: on })
  }

  /** What the page shows, when there is something to show. */
  get shown(): { update: Update; manual: boolean } | null {
    return this.showing
  }

  /** The check Papertie makes by itself. Says nothing unless there is a newer release to name. */
  async automatic(): Promise<void> {
    if (!this.o.enabled || !this.state.auto || this.stopped) return
    const since = this.o.now() - this.state.lastCheck
    // A clock set back leaves the last check in the future: asked again.
    if (this.state.lastCheck > 0 && since >= 0 && since < CHECK_EVERY_MS) {
      this.offer(this.state.latest)
      return
    }
    const found = await this.ask()
    // Switched off while GitHub answered: nothing is said.
    if (found !== null && found !== 'none' && this.state.auto) this.offer(found)
  }

  /** The menu's check: GitHub is asked now, whatever the switch, the spacing and "Later" say. */
  async manual(): Promise<CheckResult> {
    const found = await this.ask()
    if (found === null) return 'failed'
    if (found === 'none' || compareVersions(found.version, this.o.current) <= 0) return 'current'
    this.showing = { update: found, manual: true }
    this.o.announce(found, true)
    return 'newer'
  }

  /** "Later": `version` is not announced again; a newer one is. */
  dismiss(version: unknown): void {
    const v = cleanVersion(version)
    if (v === null) return
    if (this.showing?.update.version === v) this.showing = null
    // Only what GitHub named is remembered: the page cannot silence a version yet to come.
    if (this.state.latest?.version !== v) return
    this.keep({ dismissed: v })
  }

  /** "Download": the release page to open, once; the slip is answered for this run. */
  take(): string | null {
    const url = this.showing?.update.url ?? null
    this.showing = null
    return url
  }

  /** Quitting: a request in flight is given up, and no other is made. */
  stop(): void {
    this.stopped = true
    this.abort?.abort()
  }

  private offer(update: Update | null): void {
    if (update === null || compareVersions(update.version, this.o.current) <= 0) return
    const { dismissed } = this.state
    if (dismissed !== null && compareVersions(update.version, dismissed) <= 0) return
    if (this.said === update.version) return
    this.said = update.version
    this.showing = { update, manual: false }
    this.o.announce(update, false)
  }

  /** GitHub asked (one request at a time): the release, `'none'`, or `null` when it failed. */
  private ask(): Promise<Update | 'none' | null> {
    if (this.stopped) return Promise.resolve(null)
    if (this.asking) return this.asking
    const abort = new AbortController()
    this.abort = abort
    const asking = this.o
      .latest(abort.signal)
      .then(parseRelease, () => null)
      .then((found) => {
        if (found !== null && !this.stopped) {
          this.keep({ lastCheck: this.o.now(), latest: found === 'none' ? null : found })
        }
        return found
      })
      .finally(() => {
        this.asking = null
        this.abort = null
      })
    this.asking = asking
    return asking
  }

  private keep(change: Partial<UpdateState>): void {
    this.state = { ...this.state, ...change }
    try {
      this.o.save({ ...this.state })
    } catch {
      // Not saved: the next launch asks again.
    }
  }
}
