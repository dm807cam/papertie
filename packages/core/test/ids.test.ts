import { isId, newId } from '../src/index'
import { setIdRandomness } from '../src/testing'

describe('ids', () => {
  it('formats prefix_ULID', () =>
    expect(newId('note', 0)).toMatch(/^note_0{10}[0-9A-HJKMNP-TV-Z]{16}$/))
  it('encodes time big-endian so ids sort by time', () =>
    expect(newId('note', 1) < newId('note', 2)).toBe(true))
  it('isId checks prefix', () => {
    const id = newId('yarn')
    expect(isId(id, 'yarn')).toBe(true)
    expect(isId(id, 'note')).toBe(false)
    expect(isId('yarn_../../etc')).toBe(false)
  })
  it('1000 ids are unique', () =>
    expect(new Set(Array.from({ length: 1000 }, () => newId('note', 5))).size).toBe(1000))
})

// A test that must replay exactly gives ids their random bits; the app never does.
describe('ids from a seeded source', () => {
  afterEach(() => setIdRandomness(null))

  it('takes each id’s 80 random bits from the source, in order', () => {
    let n = 0
    setIdRandomness((bytes) => {
      expect(bytes).toHaveLength(10)
      bytes.fill(n++)
    })
    expect(newId('tab', 0)).toBe(`tab_${'0'.repeat(26)}`)
    expect(newId('tab', 0)).toBe(`tab_${'0'.repeat(10)}${'040G2081'.repeat(2)}`)
  })

  it('without one, the bits are crypto’s, ten bytes an id', () => {
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues')
    setIdRandomness((bytes) => bytes.fill(0))
    setIdRandomness(null)
    newId('note', 5)
    expect(spy).toHaveBeenCalledTimes(1)
    const [bytes] = spy.mock.calls[0] ?? []
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes).toHaveLength(10)
    spy.mockRestore()
    expect(new Set(Array.from({ length: 1000 }, () => newId('note', 5))).size).toBe(1000)
  })
})
