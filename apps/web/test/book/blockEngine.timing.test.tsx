/**
 * The writer's engine at `maxBlocksPerBook`, timed (`blockEngine.test.tsx`'s wall-time row).
 */
import { LIMITS } from '@papertie/core'
import { cleanup } from '@testing-library/react'
import type { EditorBlock } from '../../src/book/editor/BookEditor'
import { BookModel } from '../../src/book/editor/model'

const id = (n: number) => `block_${String(n).padStart(26, '0')}`
const para = (n: number, text: string, kind: EditorBlock['kind'] = 'p'): EditorBlock => ({
  id: id(n),
  kind,
  text,
  marks: [],
})

afterEach(() => {
  cleanup()
  document.body.textContent = ''
})

// The timed row of blockEngine.test.tsx (a wall-time bound per Enter; the file keeps its untimed
// proof), in the timing project (`vitest.config.ts`).
describe('the model at maxBlocksPerBook', () => {
  it('an Enter costs the chunks, not the book: places, heights and chapters stay right', () => {
    const n = LIMITS.maxBlocksPerBook
    const blocks = Array.from({ length: n }, (_, i) =>
      para(i + 1, `p${i}`, i % 1000 === 0 ? 'h1' : 'p'),
    )
    const m = new BookModel(blocks)
    const t0 = performance.now()
    for (let k = 0; k < 200; k++) {
      const at = 30_000 + k
      m.apply({
        t: 'split',
        id: id(at),
        at: 1,
        newId: `block_new${String(k).padStart(22, '0')}`,
        kind: 'p',
      })
      m.indexOf(id(n))
      m.heightOf(0, m.length - 1)
    }
    const per = (performance.now() - t0) / 200
    expect(m.length).toBe(n + 200)
    expect(m.indexOf(id(n))).toBe(n + 199)
    expect(m.at(29_999)?.id).toBe(id(30_000))
    expect(m.at(30_000)?.id).toBe('block_new0000000000000000000000')
    expect(m.chaptersBefore(m.length)).toBe(60)
    expect(m.chaptersBefore(m.indexOf(id(30_001)))).toBe(30)
    // Each Enter (with a place and the book's height read) is well under a millisecond.
    expect(per).toBeLessThan(1)
  })
})
