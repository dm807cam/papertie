import { mulberry32 as toolsMulberry32 } from '@papertie/tools/rng'
import { mulberry32 } from '../src/book/cover/rng'
import { hash32, notePinOffsetX, noteRotationDeg, noteVisual } from '../src/lib/seed'

describe('hash32', () => {
  it('is FNV-1a over UTF-16 code units, unsigned', () => {
    expect(hash32('')).toBe(0x811c9dc5)
    expect(hash32('a')).toBe(0xe40c292c)
    expect(hash32('foobar')).toBe(0xbf9cf968)
  })

  it('always returns a uint32', () => {
    for (let i = 0; i < 200; i++) {
      const h = hash32(`note_${i}`)
      expect(Number.isInteger(h)).toBe(true)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThanOrEqual(0xffffffff)
    }
  })
})

describe('noteVisual', () => {
  const ids = Array.from({ length: 1000 }, (_, i) => `note_${i.toString(36)}x${i * 7919}`)

  it('is deterministic and in range', () => {
    for (const id of ids) {
      const a = noteVisual(id)
      expect(noteVisual(id)).toEqual(a)
      expect(Math.abs(a.rotationDeg)).toBeLessThanOrEqual(1)
      expect(Math.abs(a.pinOffsetX)).toBeLessThanOrEqual(12)
      expect([1, 2, 3, 4, 5, 6, 7, 8]).toContain(a.maskIndex)
    }
  })

  it('1000 ids hit all 8 masks and rotation is unbiased', () => {
    const masks = new Set(ids.map((id) => noteVisual(id).maskIndex))
    expect(masks.size).toBe(8)
    const mean = ids.reduce((s, id) => s + noteVisual(id).rotationDeg, 0) / ids.length
    expect(Math.abs(mean)).toBeLessThan(0.1)
  })

  it('hashes an id and its suffix without joining them, the same as joined', () => {
    // Made for 100,000 notes as they come (each takes its pin and tilt): no string a note.
    for (const id of [...ids, '']) {
      const v = noteVisual(id)
      expect(v.pinOffsetX).toBe(((hash32(`${id}:pin`) / 0x100000000) * 2 - 1) * 12)
      expect(v.maskIndex).toBe((hash32(`${id}:mask`) % 8) + 1)
      expect(v.rotationDeg).toBe((hash32(id) / 0x100000000) * 2 - 1)
      expect(notePinOffsetX(id)).toBe(v.pinOffsetX)
    }
  })

  it('handles the empty id', () => {
    const v = noteVisual('')
    expect(Number.isFinite(v.rotationDeg)).toBe(true)
    expect(Number.isFinite(v.pinOffsetX)).toBe(true)
  })
})

describe('noteRotationDeg', () => {
  const ids = Array.from({ length: 400 }, (_, i) => `note_${i.toString(36)}y${i * 104729}`)

  it('is the seeded ±1° tilt for fibre paper and smooth notes', () => {
    for (const id of ids) {
      expect(noteRotationDeg({ id, style: 'rustic' })).toBe(noteVisual(id).rotationDeg)
      expect(noteRotationDeg({ id, style: 'smooth' })).toBe(noteVisual(id).rotationDeg)
    }
  })

  it('tilts prints 2.5-5° either way, deterministically', () => {
    let left = 0
    for (const id of ids) {
      const deg = noteRotationDeg({ id, style: 'print' })
      expect(noteRotationDeg({ id, style: 'print' })).toBe(deg)
      expect(Math.abs(deg)).toBeGreaterThanOrEqual(2.5)
      expect(Math.abs(deg)).toBeLessThanOrEqual(5)
      expect(Math.sign(deg)).toBe(noteVisual(id).rotationDeg < 0 ? -1 : 1)
      if (deg < 0) left++
    }
    expect(left).toBeGreaterThan(100)
    expect(left).toBeLessThan(300)
    expect(Number.isFinite(noteRotationDeg({ id: '', style: 'print' }))).toBe(true)
  })
})

describe('mulberry32', () => {
  // A copy of tools' generator, not an import: `@papertie/tools` is only a devDependency of the app.
  // With the covers (book/cover/rng.ts): in lib/seed.ts it would sit in the initial JS.
  it("matches tools' rng for seeds 1, 42 and 2**32 - 1 (first 100 values)", () => {
    for (const seed of [1, 42, 2 ** 32 - 1]) {
      const ours = mulberry32(seed)
      const theirs = toolsMulberry32(seed)
      for (let i = 0; i < 100; i++) expect(ours()).toBe(theirs())
    }
  })
})
