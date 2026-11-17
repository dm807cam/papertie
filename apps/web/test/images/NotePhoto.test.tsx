import { act, cleanup, render, screen } from '@testing-library/react'
import { NotePhoto } from '../../src/images/NotePhoto'
import { PhotoContext } from '../../src/images/PhotoContext'
import { type PendingImage, PendingImages } from '../../src/images/pending'
import { setZoomBand } from '../../src/images/variant'

const NOTE = 'note_01JBTEST0000000000000000A1'
const ASSET = 'asset_01JBTEST000000000000000A1'

let pending = new PendingImages()
const pick = vi.fn()

type Props = Parameters<typeof NotePhoto>[0]
const el = (over: Partial<Props> = {}) => (
  <PhotoContext.Provider value={{ pending, pick }}>
    <NotePhoto noteId={NOTE} image={null} style="rustic" lite={false} w={300} h={225} {...over} />
  </PhotoContext.Provider>
)
const view = (over: Partial<Props> = {}) => render(el(over))

function pend(over: Partial<PendingImage> = {}) {
  const entry = {
    url: 'blob:fake/1',
    state: 'uploading',
    committed: false,
    retry: vi.fn(),
    remove: vi.fn(),
    release: vi.fn(),
    ...over,
  } as PendingImage
  pending.set(NOTE, entry)
  return entry
}

beforeEach(() => {
  pending = new PendingImages()
  pick.mockClear()
  setZoomBand(1)
})
afterEach(cleanup)

describe('NotePhoto', () => {
  it('draws nothing on a plain note without an image or a preview', () => {
    const { container } = view()
    expect(container.firstChild).toBeNull()
  })

  it('shows the real image at the variant the zoom needs', () => {
    const { container } = view({ image: { assetId: ASSET, frame: 'print' } })
    expect(container.querySelector('img')?.getAttribute('src')).toBe(`/api/assets/${ASSET}/1024`)
  })

  it('takes the 256 file when lite, and keeps a larger one it already has when only the zoom falls', () => {
    const lite = view({ image: { assetId: ASSET, frame: 'print' }, lite: true })
    expect(lite.container.querySelector('img')?.getAttribute('src')).toBe(
      `/api/assets/${ASSET}/256`,
    )
    lite.unmount()
    const { container, rerender } = view({ image: { assetId: ASSET, frame: 'print' } })
    rerender(el({ image: { assetId: ASSET, frame: 'print' }, lite: true }))
    expect(container.querySelector('img')?.getAttribute('src')).toBe(`/api/assets/${ASSET}/1024`)
  })

  it('asks for a larger file when the zoom band rises, not for every pan', () => {
    const { container } = view({ image: { assetId: ASSET, frame: 'print' } })
    act(() => setZoomBand(4))
    expect(container.querySelector('img')?.getAttribute('src')).toBe(`/api/assets/${ASSET}/2560`)
  })

  it('shows the preview with a line that names no part-way while it is added', () => {
    pend()
    const { container } = view()
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:fake/1')
    const bar = screen.getByRole('progressbar', { name: 'Adding photo' })
    // Indeterminate: no value, and no width or transform set from script.
    for (const attr of ['aria-valuenow', 'aria-valuemin', 'aria-valuemax', 'aria-valuetext']) {
      expect(bar.hasAttribute(attr), attr).toBe(false)
    }
    expect(bar.querySelector('i')?.getAttribute('style')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it("offers `Couldn't upload — Retry` on a failure, and retries", () => {
    const p = pend({ state: 'failed' })
    view()
    expect(screen.queryByRole('progressbar')).toBeNull()
    screen.getByRole('button', { name: 'Couldn’t upload — Retry' }).click()
    expect(p.retry).toHaveBeenCalledTimes(1)
  })

  it('does not call a late arrival a failed upload', () => {
    pend({ state: 'late' })
    view()
    expect(screen.getByRole('button', { name: 'Still on its way — Retry' })).toBeDefined()
    expect(screen.queryByText(/Couldn’t upload/)).toBeNull()
  })

  it('says it is waiting, with nothing to press', () => {
    pend({ state: 'waiting' })
    view()
    expect(screen.getByText('Busy — trying again shortly')).toBeDefined()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('says why a refused file is refused, and offers Remove, not Retry', () => {
    const p = pend({ state: 'rejected', message: 'This photo is too large for the board.' })
    view()
    expect(screen.getByText('This photo is too large for the board.')).toBeDefined()
    expect(screen.queryByText(/Retry/)).toBeNull()
    screen.getByRole('button', { name: 'Remove' }).click()
    expect(p.remove).toHaveBeenCalledTimes(1)
  })

  it('keeps the old image hidden under a replacement preview until the new one is committed', () => {
    pend()
    const { container } = view({ image: { assetId: ASSET, frame: 'print' } })
    expect(container.querySelectorAll('img')).toHaveLength(1)
    expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:fake/1')
  })

  it('lets the preview go once the committed image is in the note', () => {
    const p = pend()
    const { container } = view({ image: { assetId: ASSET, frame: 'print' } })
    expect(container.querySelectorAll('img')).toHaveLength(1)
    act(() => pending.patch(NOTE, { committed: true }))
    expect(p.release).toHaveBeenCalled()
  })

  it('offers Add photo on a print with no photo and none coming, and nothing in lite', () => {
    const { container, rerender } = view({ style: 'print' })
    screen.getByRole('button', { name: 'Add photo' }).click()
    expect(pick).toHaveBeenCalledWith(NOTE)
    rerender(el({ style: 'print', lite: true }))
    expect(container.querySelector('button')).toBeNull()
  })
})
