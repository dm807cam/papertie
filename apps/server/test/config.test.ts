import { loadConfig } from '../src/config'
import { SERVER_LIMITS } from '../src/limits'
import { createLogger } from '../src/log'

describe('loadConfig', () => {
  it('is the data dir and the defaults: only the app scheme trusted, no web app served', () => {
    const c = loadConfig('/tmp/x')
    expect(c.dataDir).toBe('/tmp/x')
    expect(c.trustedOrigins).toEqual(['papertie://app'])
    expect(c.webDist).toBeNull()
    expect(c.limits).toEqual(SERVER_LIMITS)
  })

  it('deep-merges overrides over the defaults', () => {
    const c = loadConfig('/tmp/x', { limits: { maxBoardsPerUser: 3 }, sseKeepaliveMs: 20 })
    expect(c.limits.maxBoardsPerUser).toBe(3)
    expect(c.limits.jsonBodyBytes).toBe(SERVER_LIMITS.jsonBodyBytes)
    expect(c.sseKeepaliveMs).toBe(20)
  })
})

describe('limits', () => {
  it('pins the limits', () =>
    expect(SERVER_LIMITS).toMatchObject({
      opsBodyBytes: 1_048_576,
      uploadFileBytes: 26_214_400,
      quotaBytes: 68_719_476_736,
      importStagingBytes: 69_793_218_560,
      maxBoardsPerUser: 50,
    }))
})

describe('logger', () => {
  it('drops non-allowlisted keys', () => {
    const out: string[] = []
    createLogger((l) => out.push(l)).info('x', { route: '/a', text: 'secret' } as never)
    expect(out[0]).not.toContain('secret')
    expect(JSON.parse(out[0] ?? '')).toMatchObject({ level: 'info', msg: 'x', route: '/a' })
  })
})
