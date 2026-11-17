import { cleanup, render } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import { CoverSvg } from '../../src/book/cover/CoverSvg'
import { coverFromSeed, coverShapes } from '../../src/book/cover/cover'

// coverShapes, counted: the real one, called through.
vi.mock('../../src/book/cover/cover', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../src/book/cover/cover')>()
  return { ...m, coverShapes: vi.fn(m.coverShapes) }
})

afterEach(() => {
  cleanup()
  vi.mocked(coverShapes).mockClear()
})

describe('CoverSvg memo', () => {
  it('two renders with equal but distinct size (and cover) objects do not recompute coverShapes', () => {
    const cover = coverFromSeed(42)
    const { rerender } = render(
      <CoverSvg cover={cover} title="Winter Light" size={{ w: 104, h: 150 }} idBase="b_1-shelf" />,
    )
    expect(coverShapes).toHaveBeenCalledTimes(1)
    rerender(
      <CoverSvg
        cover={{ ...cover }}
        title="Winter Light"
        size={{ w: 104, h: 150 }}
        idBase="b_1-shelf"
      />,
    )
    expect(coverShapes).toHaveBeenCalledTimes(1)
  })

  it('draws again when the size, the cover or the title changes', () => {
    const cover = coverFromSeed(42)
    const { rerender } = render(
      <CoverSvg cover={cover} title="A" size={{ w: 104, h: 150 }} idBase="b_1-shelf" />,
    )
    rerender(<CoverSvg cover={cover} title="A" size={{ w: 208, h: 300 }} idBase="b_1-shelf" />)
    expect(coverShapes).toHaveBeenCalledTimes(2)
    rerender(
      <CoverSvg cover={coverFromSeed(43)} title="A" size={{ w: 208, h: 300 }} idBase="b_1-shelf" />,
    )
    expect(coverShapes).toHaveBeenCalledTimes(3)
    const before = document.querySelector('.cover-title')?.textContent
    rerender(
      <CoverSvg cover={coverFromSeed(43)} title="B" size={{ w: 208, h: 300 }} idBase="b_1-shelf" />,
    )
    expect(before).toBe('A')
    expect(document.querySelector('.cover-title')?.textContent).toBe('B')
  })
})
