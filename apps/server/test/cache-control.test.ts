import { createApp } from '../src/app'
import { systemClock } from '../src/clock'
import { loadConfig } from '../src/config'
import { createLogger } from '../src/log'

function testApp() {
  const app = createApp({
    config: loadConfig('/tmp/unused'),
    clock: systemClock,
    log: createLogger(() => {}),
  })
  app.get('/api/test-cached', (c) => {
    c.header('Cache-Control', 'private, max-age=31536000, immutable')
    return c.body('x')
  })
  app.get('/api/test-plain', (c) => c.json({ a: 1 }))
  return app
}

describe('/api Cache-Control', () => {
  it('keeps a Cache-Control header the route set', async () => {
    const r = await testApp().request('/api/test-cached')
    expect(r.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
  })

  it('defaults to no-store when the route sets none', async () => {
    const r = await testApp().request('/api/test-plain')
    expect(r.headers.get('cache-control')).toBe('no-store')
  })
})
