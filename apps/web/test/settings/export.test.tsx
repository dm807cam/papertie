import { act, fireEvent, render, screen } from '@testing-library/react'
import { exportHref } from '../../src/api/boards'
import { Settings } from '../../src/settings/Settings'
import * as download from '../../src/sync/unsavedDownload'
import { BOARD_ID, fakeSession } from './fakeSession'

beforeEach(() => {
  history.replaceState(null, '', '/settings/export')
})

describe('Settings export', () => {
  it('links the two exports to the server', () => {
    const { session } = fakeSession()
    render(<Settings section="export" session={session} />)
    const papertie = screen.getByRole('link', { name: 'Download .papertie' })
    const jsonl = screen.getByRole('link', { name: 'Download JSONL' })
    expect(papertie.getAttribute('href')).toBe(exportHref(BOARD_ID, 'papertie'))
    expect(jsonl.getAttribute('href')).toBe(exportHref(BOARD_ID, 'jsonl'))
    expect(papertie.hasAttribute('download')).toBe(true)
    expect(screen.queryByRole('button', { name: 'Download unsaved changes' })).toBeNull()
  })

  it('offers the unsaved changes while some are pending, as a file', () => {
    const spy = vi.spyOn(download, 'downloadUnsaved').mockImplementation(() => {})
    const { session } = fakeSession({
      sync: { unsavedJsonl: () => '{"op":{"op":"note.delete","id":"n"}}\n', pending: 1 },
    })
    render(<Settings section="export" session={session} />)
    fireEvent.click(screen.getByRole('button', { name: 'Download unsaved changes' }))
    expect(spy).toHaveBeenCalledWith('{"op":{"op":"note.delete","id":"n"}}\n')
    spy.mockRestore()
  })

  it('shows the unsaved changes the moment the feed reports some, and not before', () => {
    let jsonl = ''
    const { session } = fakeSession({ sync: { unsavedJsonl: () => jsonl } })
    render(<Settings section="export" session={session} />)
    expect(screen.queryByRole('button', { name: 'Download unsaved changes' })).toBeNull()
    jsonl = '{"op":{}}\n'
    act(() => session.feed.pending(2))
    expect(screen.getByRole('button', { name: 'Download unsaved changes' })).toBeTruthy()
  })
})
