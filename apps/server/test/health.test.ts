import { startTestServer } from './helpers/harness'

describe('GET /api/health', () => {
  it('→ 200 {ok:true} with no-store', async () => {
    const s = await startTestServer()
    try {
      const r = await fetch(`${s.url}/api/health`)
      expect(r.status).toBe(200)
      expect(await r.json()).toEqual({ ok: true })
      expect(r.headers.get('cache-control')).toBe('no-store')
    } finally {
      await s.close()
    }
  })
})
