import { focusKey, type KeyLike } from '../../src/interactions/keys'

const key = (k: string, code: string, extra: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  code,
  shiftKey: false,
  target: null,
  ...extra,
})

describe('focusKey', () => {
  it('F focuses and Esc leaves, on any layout', () => {
    expect(focusKey(key('f', 'KeyF'))).toBe('focus')
    expect(focusKey(key('F', 'KeyF', { shiftKey: false }))).toBe('focus')
    // A Cyrillic layout's F key types а.
    expect(focusKey(key('а', 'KeyF'))).toBe('focus')
    expect(focusKey(key('Escape', 'Escape'))).toBe('exit')
  })

  it('is null in a text field, for chords and for Shift+F', () => {
    const field = { tagName: 'INPUT', type: 'text' } as unknown as EventTarget
    expect(focusKey(key('f', 'KeyF', { target: field }))).toBeNull()
    expect(focusKey(key('Escape', 'Escape', { target: field }))).toBeNull()
    expect(focusKey(key('f', 'KeyF', { metaKey: true }))).toBeNull()
    expect(focusKey(key('F', 'KeyF', { shiftKey: true }))).toBeNull()
    expect(focusKey(key('g', 'KeyG'))).toBeNull()
  })
})
