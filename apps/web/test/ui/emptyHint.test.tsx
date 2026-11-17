import { emptyBoardState } from '@papertie/core'
import { render, screen } from '@testing-library/react'
import { createBoardStore } from '../../src/store/boardStore'
import { EmptyHint } from '../../src/ui/EmptyHint'

const empty = () =>
  createBoardStore(
    emptyBoardState('board_01JBX0000000000000000000AA', 'B', '2026-11-07T00:00:00.000Z'),
  )

describe('EmptyHint', () => {
  it('is titled and says how to begin', () => {
    render(<EmptyHint store={empty()} />)
    expect(screen.getByText('A clean board').tagName).toBe('P')
    expect(screen.getByText('Begin with a blank sheet')).toBeTruthy()
  })

  it('says Press + with a mouse, and Tap + on a touch screen', () => {
    const was = window.matchMedia
    try {
      window.matchMedia = ((q: string) => ({ matches: false, media: q })) as never
      const { unmount } = render(<EmptyHint store={empty()} />)
      expect(screen.getByText('Press + to pin a thought')).toBeTruthy()
      unmount()
      window.matchMedia = ((q: string) => ({
        matches: q === '(pointer: coarse)',
        media: q,
      })) as never
      render(<EmptyHint store={empty()} />)
      expect(screen.getByText('Tap + to pin a thought')).toBeTruthy()
    } finally {
      window.matchMedia = was
    }
  })
})
