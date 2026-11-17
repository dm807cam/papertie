import { navigate, parseRoute, type Route, routePath } from '../src/app/router'

const at = (pathname: string, search = '') => ({ pathname, search })

describe('parseRoute', () => {
  it('maps the settings sections, with export for a missing or unknown one', () => {
    expect(parseRoute(at('/settings/history'), false)).toEqual({
      name: 'settings',
      section: 'history',
    })
    expect(parseRoute(at('/settings/data'), false)).toEqual({ name: 'settings', section: 'data' })
    expect(parseRoute(at('/settings'), false)).toEqual({ name: 'settings', section: 'export' })
    expect(parseRoute(at('/settings/bogus'), false)).toEqual({
      name: 'settings',
      section: 'export',
    })
  })

  it('tolerates a trailing slash', () => {
    expect(parseRoute(at('/shelf/'), false)).toEqual({ name: 'shelf' })
    expect(parseRoute(at('/settings/export/'), false)).toEqual({
      name: 'settings',
      section: 'export',
    })
  })

  it('gives study and bench only in dev', () => {
    expect(parseRoute(at('/study'), true)).toEqual({ name: 'study' })
    expect(parseRoute(at('/study'), false)).toEqual({ name: 'board' })
    expect(parseRoute(at('/bench', '?board=500'), true)).toEqual({ name: 'bench', board: '500' })
    expect(parseRoute(at('/bench', '?board=500'), false)).toEqual({ name: 'board' })
    expect(parseRoute(at('/bench'), true)).toEqual({ name: 'bench', board: 'demo' })
  })

  it('/editor-spike is the board, in dev too: the spike is gone', () => {
    expect(parseRoute({ pathname: '/editor-spike', search: '' }, false)).toEqual({ name: 'board' })
    expect(parseRoute({ pathname: '/editor-spike', search: '' }, true)).toEqual({ name: 'board' })
  })

  it('falls back to the board for unknown paths', () => {
    for (const p of ['/', '/nope', '/shelf/extra', '/settings/export/x'])
      expect(parseRoute(at(p), true)).toEqual({ name: 'board' })
  })

  it('ignores the hash-era query on the board path', () => {
    expect(parseRoute(at('/', '?board=500'), true)).toEqual({ name: 'board' })
  })
})

describe('routePath', () => {
  const routes: Route[] = [
    { name: 'board' },
    { name: 'settings', section: 'export' },
    { name: 'settings', section: 'history' },
    { name: 'settings', section: 'preferences' },
    { name: 'settings', section: 'data' },
    { name: 'study' },
    { name: 'bench', board: '500' },
    { name: 'bench', board: 'far0' },
  ]

  it.each(routes)('round-trips %j', (route) => {
    const path = routePath(route)
    const url = new URL(path, 'http://localhost')
    expect(parseRoute({ pathname: url.pathname, search: url.search }, true)).toEqual(route)
  })

  it('writes plain paths', () => {
    expect(routePath({ name: 'board' })).toBe('/')
    expect(routePath({ name: 'settings', section: 'data' })).toBe('/settings/data')
    expect(routePath({ name: 'shelf' })).toBe('/shelf')
  })
})

describe('the books routes', () => {
  const BOOK = `book_${'0'.repeat(25)}7`

  it('parseRoute and routePath round-trip /shelf and /book/<id>', () => {
    for (const route of [{ name: 'shelf' }, { name: 'book', id: BOOK }] as Route[]) {
      const path = routePath(route)
      const url = new URL(path, 'http://localhost')
      expect(parseRoute({ pathname: url.pathname, search: url.search }, false)).toEqual(route)
    }
    expect(routePath({ name: 'shelf' })).toBe('/shelf')
    expect(routePath({ name: 'book', id: BOOK })).toBe(`/book/${BOOK}`)
    expect(parseRoute(at('/shelf/'), false)).toEqual({ name: 'shelf' })
    expect(parseRoute(at(`/book/${BOOK}/`), false)).toEqual({ name: 'book', id: BOOK })
    // No book named, more after it, or a name no book can have: the board.
    for (const p of ['/book', '/book/', `/book/${BOOK}/x`, '/book/a%2Fb', '/book/..'])
      expect(parseRoute(at(p), false)).toEqual({ name: 'board' })
  })
})

describe('navigate', () => {
  afterEach(() => vi.unstubAllGlobals())

  function stub() {
    const calls: string[][] = []
    const events: string[] = []
    vi.stubGlobal('history', {
      pushState: (_s: unknown, _t: string, url: string) => calls.push(['push', url]),
      replaceState: (_s: unknown, _t: string, url: string) => calls.push(['replace', url]),
    })
    vi.stubGlobal('window', { dispatchEvent: (e: Event) => events.push(e.type) })
    return { calls, events }
  }

  it('pushes the path and announces it with papertie:route', () => {
    const { calls, events } = stub()
    navigate({ name: 'shelf' })
    expect(calls).toEqual([['push', '/shelf']])
    expect(events).toEqual(['papertie:route'])
  })

  it('replaces the entry when asked', () => {
    const { calls, events } = stub()
    navigate({ name: 'settings', section: 'export' }, { replace: true })
    expect(calls).toEqual([['replace', '/settings/export']])
    expect(events).toEqual(['papertie:route'])
  })
})

describe('the dev routes', () => {
  it('do not look at the URL: a bench query param opens nothing in a release build', () => {
    expect(parseRoute(at('/study', '?bench=1'), false)).toEqual({ name: 'board' })
    expect(parseRoute(at('/bench', '?board=500&bench=1'), false)).toEqual({ name: 'board' })
  })
})
