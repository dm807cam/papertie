import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CHECK_EVERY_MS,
  cleanVersion,
  compareVersions,
  DEFAULT_UPDATE_STATE,
  type Fetch,
  fetchLatest,
  isReleaseUrl,
  LATEST_URL,
  parseRelease,
  parseUpdateState,
  readUpdateState,
  testUrl,
  type Update,
  Updater,
  type UpdateState,
  writeUpdateState,
} from '../src/updates'

const PAGE = 'https://github.com/dm807cam/papertie/releases/tag/v0.3.1'
const release = (over: Record<string, unknown> = {}) => ({
  tag_name: 'v0.3.1',
  html_url: PAGE,
  draft: false,
  prerelease: false,
  name: 'Papertie 0.3.1',
  assets: [{ name: 'Papertie-0.3.1-mac-arm64.zip' }],
  ...over,
})

describe('version comparison', () => {
  it('orders by major, minor and patch, as numbers', () => {
    expect(compareVersions('0.3.1', '0.3.0')).toBeGreaterThan(0)
    expect(compareVersions('0.3.0', '0.3.1')).toBeLessThan(0)
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0)
    expect(compareVersions('2.0.0', '10.0.0')).toBeLessThan(0)
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0)
  })

  it('reads a leading v and ignores build metadata', () => {
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('1.2.3+build.5', '1.2.3')).toBe(0)
    expect(cleanVersion('v1.2.3+build.5')).toBe('1.2.3')
    expect(cleanVersion('v1.2.3-beta.1')).toBe('1.2.3-beta.1')
  })

  it('a pre-release sorts before its release, and pre-releases among themselves', () => {
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBeLessThan(0)
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.10')).toBeLessThan(0)
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBeLessThan(0)
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.beta')).toBeLessThan(0)
    expect(compareVersions('1.0.0-beta', '1.0.0-alpha')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-rc.1', '1.0.0-rc.1')).toBe(0)
    expect(compareVersions('1.0.1-alpha', '1.0.0')).toBeGreaterThan(0)
  })

  it('what is not a version is older than any version, and is never cleaned into one', () => {
    for (const bad of [
      '',
      'latest',
      '1.2',
      '1.2.3.4',
      'v',
      '1.2.x',
      ' 1.2.3',
      '1.2.3\n',
      '01x.2.3',
    ])
      expect(cleanVersion(bad), bad).toBeNull()
    expect(cleanVersion(123)).toBeNull()
    expect(cleanVersion(`1.2.${'9'.repeat(80)}`)).toBeNull()
    expect(compareVersions('nonsense', '0.0.1')).toBeLessThan(0)
    expect(compareVersions('0.0.1', 'nonsense')).toBeGreaterThan(0)
    expect(compareVersions('nonsense', 'more')).toBe(0)
  })
})

describe('the release page', () => {
  it('is a page of Papertie’s releases on github.com, over https', () => {
    expect(isReleaseUrl(PAGE)).toBe(true)
    expect(isReleaseUrl('https://github.com/dm807cam/papertie/releases/latest')).toBe(true)
  })

  it('is nothing else', () => {
    for (const bad of [
      'http://github.com/dm807cam/papertie/releases/tag/v0.3.1',
      'https://github.com.evil.example/dm807cam/papertie/releases/tag/v0.3.1',
      'https://evil.example/dm807cam/papertie/releases/tag/v0.3.1',
      'https://api.github.com/dm807cam/papertie/releases/tag/v0.3.1',
      'https://github.com@evil.example/dm807cam/papertie/releases/tag/v0.3.1',
      'https://user:pw@github.com/dm807cam/papertie/releases/tag/v0.3.1',
      'https://github.com:8443/dm807cam/papertie/releases/tag/v0.3.1',
      'https://github.com/someone/papertie/releases/tag/v0.3.1',
      'https://github.com/dm807cam/other/releases/tag/v0.3.1',
      'https://github.com/dm807cam/papertie/releases',
      'https://github.com/dm807cam/papertie/issues/1',
      'https://github.com/dm807cam/papertie/releases/../../../evil/repo',
      'https://github.com\\@evil.example/dm807cam/papertie/releases/tag/v0.3.1',
      'https://GITHUB.com/dm807cam/papertie/releases/tag/v0.3.1',
      'javascript:alert(1)',
      'file:///dm807cam/papertie/releases/x',
      'papertie://app/dm807cam/papertie/releases/x',
      '',
      `${PAGE}${'a'.repeat(400)}`,
    ])
      expect(isReleaseUrl(bad), bad).toBe(false)
    expect(isReleaseUrl(null)).toBe(false)
    expect(isReleaseUrl({ href: PAGE })).toBe(false)
  })
})

describe('GitHub’s answer', () => {
  it('a release: its version without the v, and its page', () => {
    expect(parseRelease(release())).toEqual({ version: '0.3.1', url: PAGE })
    expect(parseRelease(release({ tag_name: '0.3.1' }))).toEqual({ version: '0.3.1', url: PAGE })
  })

  it('a draft or a pre-release is never announced', () => {
    expect(parseRelease(release({ draft: true }))).toBe('none')
    expect(parseRelease(release({ prerelease: true }))).toBe('none')
    expect(parseRelease(release({ tag_name: 'v0.4.0-beta.1' }))).toBe('none')
  })

  it('missing or wrong fields are no release', () => {
    for (const bad of [
      null,
      undefined,
      'v0.3.1',
      [],
      [release()],
      {},
      { message: 'API rate limit exceeded' },
      release({ tag_name: undefined }),
      release({ tag_name: 31 }),
      release({ tag_name: 'nightly' }),
      release({ html_url: undefined }),
      release({ draft: undefined }),
      release({ prerelease: 'false' }),
    ])
      expect(parseRelease(bad), JSON.stringify(bad)).toBeNull()
  })

  it('a page on another host is refused, whatever the version', () => {
    expect(parseRelease(release({ html_url: 'https://evil.example/papertie/releases/v9' }))).toBe(
      null,
    )
    expect(
      parseRelease(release({ html_url: 'https://github.com/someone/else/releases/tag/v9.9.9' })),
    ).toBeNull()
    expect(parseRelease(release({ html_url: 'javascript:alert(1)' }))).toBeNull()
  })
})

describe('the request', () => {
  const answer = (status: number, body: string) => ({ status, text: async () => body })
  const ask = (fetch: Fetch, o: { signal?: AbortSignal; timeoutMs?: number } = {}) =>
    fetchLatest({
      fetch,
      url: LATEST_URL,
      version: '0.3.0',
      signal: o.signal ?? new AbortController().signal,
      timeoutMs: o.timeoutMs,
    })

  it('is one GET to GitHub’s latest release, saying only which Papertie asks', async () => {
    const fetch = vi.fn<Fetch>(async () => answer(200, JSON.stringify(release())))
    expect(await ask(fetch)).toEqual(release())
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0] as Parameters<Fetch>
    expect(url).toBe('https://api.github.com/repos/dm807cam/papertie/releases/latest')
    expect(init.method).toBe('GET')
    expect(init.headers).toEqual({
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Papertie/0.3.0',
      'Accept-Language': 'en',
    })
    expect(init.redirect).toBe('error')
    expect(init.credentials).toBe('omit')
    expect(init).not.toHaveProperty('body')
  })

  it('anything but a 200 is a failure: a rate limit, a redirect, a missing repository', async () => {
    for (const status of [403, 429, 301, 302, 404, 500, 204])
      await expect(ask(async () => answer(status, JSON.stringify(release())))).rejects.toThrow()
  })

  it('an answer that is not JSON, or far too long, is a failure', async () => {
    await expect(ask(async () => answer(200, '<html>'))).rejects.toThrow()
    await expect(ask(async () => answer(200, `"${'a'.repeat(1_000_001)}"`))).rejects.toThrow()
  })

  it('a network error is a failure', async () => {
    await expect(
      ask(async () => {
        throw new Error('net::ERR_INTERNET_DISCONNECTED')
      }),
    ).rejects.toThrow()
  })

  it('no answer in time is given up, even from a fetch that never ends', async () => {
    const never: Fetch = () => new Promise(() => {})
    await expect(ask(never, { timeoutMs: 20 })).rejects.toThrow()
  })

  it('is given up at once when the app quits', async () => {
    const abort = new AbortController()
    let seen: AbortSignal | undefined
    const pending = ask(
      (_url, init) => {
        seen = init.signal
        return new Promise(() => {})
      },
      { signal: abort.signal },
    )
    abort.abort()
    await expect(pending).rejects.toThrow()
    expect(seen?.aborted).toBe(true)
  })

  it('the tests’ stand-in for GitHub is an http address on this machine, or nothing', () => {
    expect(testUrl('http://127.0.0.1:4010/latest')).toBe('http://127.0.0.1:4010/latest')
    expect(testUrl('http://localhost:4010/latest')).toBe('http://localhost:4010/latest')
    for (const bad of [
      undefined,
      '',
      'nonsense',
      'https://evil.example/latest',
      'http://evil.example/latest',
      'http://127.0.0.1.evil.example/latest',
      'file:///etc/hosts',
    ])
      expect(testUrl(bad), String(bad)).toBeNull()
  })
})

describe('what is remembered', () => {
  const dirs: string[] = []
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
  })

  it('a missing or damaged file is the default: automatic, never checked', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'papertie-updates-'))
    dirs.push(dir)
    const file = join(dir, 'updates.json')
    expect(readUpdateState(file)).toEqual(DEFAULT_UPDATE_STATE)
    await writeFile(file, '{ not json')
    expect(readUpdateState(file)).toEqual(DEFAULT_UPDATE_STATE)
    expect(DEFAULT_UPDATE_STATE.auto).toBe(true)
  })

  it('is read back as it was written, whole', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'papertie-updates-'))
    dirs.push(dir)
    const file = join(dir, 'updates.json')
    const state: UpdateState = {
      auto: false,
      lastCheck: 1_800_000_000_000,
      dismissed: '0.3.1',
      latest: { version: '0.3.1', url: PAGE },
    }
    writeUpdateState(file, state)
    expect(readUpdateState(file)).toEqual(state)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(state)
  })

  it('each field is checked: a release page elsewhere is not kept', () => {
    expect(
      parseUpdateState({
        auto: 'no',
        lastCheck: -5,
        dismissed: 'everything',
        latest: { version: '9.9.9', url: 'https://evil.example/releases/v9.9.9' },
      }),
    ).toEqual(DEFAULT_UPDATE_STATE)
    expect(parseUpdateState([1, 2])).toEqual(DEFAULT_UPDATE_STATE)
    expect(parseUpdateState({ auto: false }).auto).toBe(false)
  })
})

describe('when Papertie asks, and what it says', () => {
  const T0 = 1_800_000_000_000
  const HOUR = 60 * 60 * 1000

  function harness(
    o: { current?: string; enabled?: boolean; state?: Partial<UpdateState>; answer?: unknown } = {},
  ) {
    const h = {
      now: T0,
      answer: (o.answer === undefined ? release() : o.answer) as unknown,
      fail: false,
      asked: 0,
      said: [] as Array<Update & { manual: boolean }>,
      saved: { ...DEFAULT_UPDATE_STATE, ...o.state } as UpdateState,
      updater: null as unknown as Updater,
    }
    h.updater = new Updater({
      current: o.current ?? '0.3.0',
      enabled: o.enabled ?? true,
      now: () => h.now,
      latest: async () => {
        h.asked++
        if (h.fail) throw new Error('offline')
        return h.answer
      },
      state: h.saved,
      save: (s) => {
        h.saved = s
      },
      announce: (update, manual) => h.said.push({ ...update, manual }),
    })
    return h
  }

  it('the first launch asks GitHub and names the newer release', async () => {
    const h = harness()
    await h.updater.automatic()
    expect(h.asked).toBe(1)
    expect(h.said).toEqual([{ version: '0.3.1', url: PAGE, manual: false }])
    expect(h.saved.lastCheck).toBe(T0)
    expect(h.saved.latest).toEqual({ version: '0.3.1', url: PAGE })
    expect(h.updater.shown).toEqual({ update: { version: '0.3.1', url: PAGE }, manual: false })
  })

  it('the same or an older release says nothing', async () => {
    for (const current of ['0.3.1', '0.4.0', '1.0.0']) {
      const h = harness({ current })
      await h.updater.automatic()
      expect(h.asked).toBe(1)
      expect(h.said).toEqual([])
      expect(h.saved.lastCheck).toBe(T0)
    }
  })

  it('within 24 hours GitHub is not asked again; after them it is', async () => {
    const h = harness({ current: '0.3.1' })
    await h.updater.automatic()
    h.now = T0 + HOUR
    await h.updater.automatic()
    h.now = T0 + CHECK_EVERY_MS - 1
    await h.updater.automatic()
    expect(h.asked).toBe(1)
    h.now = T0 + CHECK_EVERY_MS
    await h.updater.automatic()
    expect(h.asked).toBe(2)
    expect(h.saved.lastCheck).toBe(T0 + CHECK_EVERY_MS)
  })

  it('a launch within the day does not ask, and still names the release it knows of', async () => {
    const h = harness({
      state: { lastCheck: T0 - HOUR, latest: { version: '0.3.1', url: PAGE } },
    })
    await h.updater.automatic()
    expect(h.asked).toBe(0)
    expect(h.said).toEqual([{ version: '0.3.1', url: PAGE, manual: false }])
  })

  it('a version is announced once in a run, not each hour', async () => {
    const h = harness()
    await h.updater.automatic()
    expect(h.updater.take()).toBe(PAGE)
    h.now = T0 + HOUR
    await h.updater.automatic()
    h.now = T0 + CHECK_EVERY_MS
    await h.updater.automatic()
    expect(h.asked).toBe(2)
    expect(h.said).toHaveLength(1)
  })

  it('a dismissed version stays quiet, in this run and the next', async () => {
    const h = harness()
    await h.updater.automatic()
    h.updater.dismiss('0.3.1')
    expect(h.saved.dismissed).toBe('0.3.1')
    expect(h.updater.shown).toBeNull()
    h.now = T0 + CHECK_EVERY_MS
    await h.updater.automatic()
    expect(h.said).toHaveLength(1)

    // The next launch, on what was saved: within the day, and after it.
    const next = harness({ state: h.saved })
    next.now = T0 + CHECK_EVERY_MS + HOUR
    await next.updater.automatic()
    expect(next.asked).toBe(0)
    next.now = T0 + 3 * CHECK_EVERY_MS
    await next.updater.automatic()
    expect(next.asked).toBe(1)
    expect(next.said).toEqual([])
  })

  it('a release newer than the dismissed one speaks', async () => {
    const h = harness({
      state: { dismissed: '0.3.1', lastCheck: T0 - 2 * CHECK_EVERY_MS },
      answer: release({
        tag_name: 'v0.3.2',
        html_url: 'https://github.com/dm807cam/papertie/releases/tag/v0.3.2',
      }),
    })
    await h.updater.automatic()
    expect(h.said.map((s) => s.version)).toEqual(['0.3.2'])
    expect(h.saved.dismissed).toBe('0.3.1')
  })

  it('only a version GitHub named can be dismissed', async () => {
    const h = harness()
    await h.updater.automatic()
    h.updater.dismiss('99.0.0')
    h.updater.dismiss('not a version')
    h.updater.dismiss({ version: '0.3.1' })
    expect(h.saved.dismissed).toBeNull()
  })

  it('with the setting off Papertie does not ask by itself, or say what it knew', async () => {
    const h = harness({ state: { auto: false } })
    await h.updater.automatic()
    expect(h.asked).toBe(0)
    const known = harness({
      state: { auto: false, lastCheck: T0 - HOUR, latest: { version: '0.3.1', url: PAGE } },
    })
    await known.updater.automatic()
    expect(known.said).toEqual([])

    h.updater.setAuto(true)
    expect(h.saved.auto).toBe(true)
    await h.updater.automatic()
    expect(h.asked).toBe(1)
    h.updater.setAuto(false)
    expect(h.saved.auto).toBe(false)
    expect(h.updater.auto).toBe(false)
  })

  it('in development and under test Papertie never asks by itself', async () => {
    const h = harness({ enabled: false })
    await h.updater.automatic()
    expect(h.asked).toBe(0)
    expect(h.said).toEqual([])
  })

  it('an automatic check that fails is silent, and asked again at the next turn', async () => {
    const h = harness()
    h.fail = true
    await expect(h.updater.automatic()).resolves.toBeUndefined()
    expect(h.said).toEqual([])
    expect(h.saved.lastCheck).toBe(0)
    h.fail = false
    h.now = T0 + HOUR
    await h.updater.automatic()
    expect(h.asked).toBe(2)
    expect(h.said).toHaveLength(1)
  })

  it('an answer that is not a release of Papertie’s is a failure, and nothing is kept', async () => {
    const h = harness({
      answer: release({ html_url: 'https://evil.example/dm807cam/papertie/releases/tag/v9.9.9' }),
    })
    await h.updater.automatic()
    expect(h.said).toEqual([])
    expect(h.saved).toEqual(DEFAULT_UPDATE_STATE)
    expect(await h.updater.manual()).toBe('failed')
  })

  it('a draft or a pre-release answers "up to date"', async () => {
    const h = harness({ answer: release({ tag_name: 'v0.4.0', prerelease: true }) })
    await h.updater.automatic()
    expect(h.said).toEqual([])
    expect(h.saved.lastCheck).toBe(T0)
    expect(await h.updater.manual()).toBe('current')
  })

  it('a manual check ignores the spacing, the setting and a dismissed version', async () => {
    const h = harness({
      enabled: false,
      state: { auto: false, lastCheck: T0 - 1000, dismissed: '0.3.1' },
    })
    expect(await h.updater.manual()).toBe('newer')
    expect(h.asked).toBe(1)
    expect(h.said).toEqual([{ version: '0.3.1', url: PAGE, manual: true }])
    // Asked again at once: asked again.
    expect(await h.updater.manual()).toBe('newer')
    expect(h.asked).toBe(2)
    expect(h.saved.dismissed).toBe('0.3.1')
    expect(h.saved.auto).toBe(false)
  })

  it('a manual check always answers: up to date, or could not check', async () => {
    const same = harness({ current: '0.3.1' })
    expect(await same.updater.manual()).toBe('current')
    expect(same.said).toEqual([])
    const off = harness()
    off.fail = true
    expect(await off.updater.manual()).toBe('failed')
    expect(off.said).toEqual([])
    expect(off.saved.lastCheck).toBe(0)
  })

  it('"Download" hands the release page once', async () => {
    const h = harness()
    expect(h.updater.take()).toBeNull()
    await h.updater.automatic()
    expect(h.updater.take()).toBe(PAGE)
    expect(h.updater.take()).toBeNull()
    expect(h.saved.dismissed).toBeNull()
  })

  it('quitting gives up the request in flight, and none is made after', async () => {
    let signal: AbortSignal | undefined
    const said: Update[] = []
    let saves = 0
    const updater = new Updater({
      current: '0.3.0',
      enabled: true,
      now: () => T0,
      latest: (s) => {
        signal = s
        return new Promise((_resolve, reject) => {
          s.addEventListener('abort', () => reject(new Error('aborted')))
        })
      },
      state: DEFAULT_UPDATE_STATE,
      save: () => {
        saves++
      },
      announce: (u) => said.push(u),
    })
    const pending = updater.automatic()
    updater.stop()
    await pending
    expect(signal?.aborted).toBe(true)
    expect(said).toEqual([])
    expect(saves).toBe(0)
    signal = undefined
    await updater.automatic()
    expect(await updater.manual()).toBe('failed')
    expect(signal).toBeUndefined()
  })

  it('two checks at once are one request', async () => {
    const h = harness()
    const [, result] = await Promise.all([h.updater.automatic(), h.updater.manual()])
    expect(h.asked).toBe(1)
    expect(result).toBe('newer')
  })
})
