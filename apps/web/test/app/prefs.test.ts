import {
  createPrefsStore,
  DEFAULT_PREFS,
  isReducedMotion,
  PREFS_KEY,
  type Prefs,
} from '../../src/app/prefs'

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v)
    },
  }
}

describe('prefs', () => {
  it('defaults', () => {
    expect(DEFAULT_PREFS).toEqual({
      tool: 'select',
      motion: 'system',
      wheel: 'pan',
      tilt: true,
      noteColor: 'cream',
      noteStyle: 'rustic',
      noteDecoration: 'none',
      noteSheet: 'rose',
      yarnColor: 'apricot',
      sidebar: 'open',
      layer: 'over',
      hud: false,
    })
    expect(PREFS_KEY).toBe('papertie.prefs')
    expect(createPrefsStore(undefined, true).getState()).toEqual(DEFAULT_PREFS)
  })

  it('motion "system" follows the media query; "reduced"/"full" override it', () => {
    const p = (motion: Prefs['motion']): Prefs => ({ ...DEFAULT_PREFS, motion })
    expect(isReducedMotion(p('system'), true)).toBe(true)
    expect(isReducedMotion(p('system'), false)).toBe(false)
    expect(isReducedMotion(p('reduced'), false)).toBe(true)
    expect(isReducedMotion(p('full'), true)).toBe(false)
  })

  it('persists changes and reloads them', () => {
    const storage = memoryStorage()
    const a = createPrefsStore(storage, true)
    a.setState({ tool: 'yarn', wheel: 'zoom', sidebar: 'folded' })
    expect(JSON.parse(storage.data.get(PREFS_KEY) ?? '{}')).toEqual({
      ...DEFAULT_PREFS,
      tool: 'yarn',
      wheel: 'zoom',
      sidebar: 'folded',
    })
    expect(createPrefsStore(storage, true).getState()).toEqual({
      ...DEFAULT_PREFS,
      tool: 'yarn',
      wheel: 'zoom',
      sidebar: 'folded',
    })
  })

  it('drops unknown or invalid stored values field by field', () => {
    const storage = memoryStorage({
      [PREFS_KEY]: JSON.stringify({
        tool: 'laser',
        layer: 'under',
        tilt: 'yes',
        noteColor: 'chartreuse',
        noteStyle: 'print',
        noteDecoration: 'glitter',
        yarnColor: 'neon',
        sidebar: 'gone',
        extra: 1,
      }),
    })
    expect(createPrefsStore(storage, true).getState()).toEqual({ ...DEFAULT_PREFS, layer: 'under' })
    for (const raw of ['{not json', 'null', '42', '[]']) {
      const s = memoryStorage({ [PREFS_KEY]: raw })
      expect(createPrefsStore(s, true).getState()).toEqual(DEFAULT_PREFS)
    }
  })

  it('remembers the yarn colour last chosen, which a new thread is tied in', () => {
    const s = memoryStorage()
    createPrefsStore(s, true).setState({ yarnColor: 'indigo', tool: 'yarn' })
    expect(createPrefsStore(s, true).getState()).toMatchObject({
      yarnColor: 'indigo',
      tool: 'yarn',
    })
  })

  it('survives a storage that throws', () => {
    const throwing = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('quota')
      },
    }
    const store = createPrefsStore(throwing, true)
    expect(store.getState()).toEqual(DEFAULT_PREFS)
    expect(() => store.setState({ hud: true })).not.toThrow()
    expect(store.getState().hud).toBe(true)
  })

  it('keeps the dev-only keys out of a production build', () => {
    const storage = memoryStorage({
      [PREFS_KEY]: JSON.stringify({ wheel: 'zoom', layer: 'under', hud: true }),
    })
    const prod = createPrefsStore(storage, false)
    expect(prod.getState()).toEqual({ ...DEFAULT_PREFS, wheel: 'zoom' })
    prod.setState({ noteColor: 'rose', hud: true })
    const saved = JSON.parse(storage.data.get(PREFS_KEY) ?? '{}')
    expect(saved).toEqual({
      tool: 'select',
      motion: 'system',
      wheel: 'zoom',
      tilt: true,
      noteColor: 'rose',
      noteStyle: 'rustic',
      noteDecoration: 'none',
      noteSheet: 'rose',
      yarnColor: 'apricot',
      sidebar: 'open',
    })
  })
})
