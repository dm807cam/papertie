import { render, screen, waitFor, within } from '@testing-library/react'
import * as boards from '../../src/api/boards'
import { listenForOpenedFiles, offerFile } from '../../src/app/openedFile'
import { Settings } from '../../src/settings/Settings'
import { BOARD_ID, fakeSession } from './fakeSession'

/*
 * The desktop app: a `.papertie` file the system opened (double-clicked,
 * dropped on the icon, given on the command line) comes in through Settings → Import, asked
 * exactly as a file chosen there is.
 */

vi.mock('../../src/api/boards', async (actual) => ({
  ...(await actual<typeof boards>()),
  previewImport: vi.fn(),
  commitImport: vi.fn(),
  cancelImport: vi.fn(),
}))
const api = vi.mocked(boards)

const PREVIEW: boards.ImportPreview = {
  name: 'Garden',
  notes: 12,
  yarns: 3,
  assets: 2,
  bytes: 4096,
  skippedRecords: 0,
}

type Opened = { url: string; name: string }
const desktop = window as { papertieDesktop?: { onOpenFile(cb: (f: Opened) => void): void } }

beforeEach(() => {
  vi.resetAllMocks()
  history.replaceState(null, '', '/')
})
afterEach(() => {
  delete desktop.papertieDesktop
  vi.unstubAllGlobals()
})

const dialog = () => screen.findByRole('alertdialog', { name: 'Replace your board with “Garden”?' })

describe('a file the desktop app opened', () => {
  it('is fetched once, Settings → Export opens, and the import asks before anything changes', async () => {
    let send: (f: Opened) => void = () => {}
    desktop.papertieDesktop = {
      onOpenFile: (cb) => {
        send = cb
      },
    }
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([0x50, 0x4b, 3, 4])))
    vi.stubGlobal('fetch', fetchMock)
    api.previewImport.mockResolvedValue({ preview: PREVIEW, importId: 'IMPORT1' })

    listenForOpenedFiles()
    send({ url: 'papertie://app/_opened/TOKEN', name: 'Garden.papertie' })
    await waitFor(() => expect(location.pathname).toBe('/settings/export'))
    expect(fetchMock).toHaveBeenCalledWith('papertie://app/_opened/TOKEN')

    const { session } = fakeSession()
    render(<Settings section="export" session={session} />)
    const box = await dialog()
    const [boardId, file] = api.previewImport.mock.calls[0] as [string, File]
    expect(boardId).toBe(BOARD_ID)
    expect(file.name).toBe('Garden.papertie')
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([0x50, 0x4b, 3, 4])
    // Asked, never replaced on its own.
    expect(within(box).getByRole('button', { name: 'Keep current' })).toBeTruthy()
    expect(api.commitImport).not.toHaveBeenCalled()
    expect(api.previewImport).toHaveBeenCalledTimes(1)
  })

  it('a file opened while Settings → Export is open is read there at once', async () => {
    api.previewImport.mockResolvedValue({ preview: PREVIEW, importId: 'IMPORT1' })
    const { session } = fakeSession()
    render(<Settings section="export" session={session} />)
    expect(api.previewImport).not.toHaveBeenCalled()
    offerFile(new File(['PK'], 'Garden.papertie'))
    await dialog()
    expect(api.previewImport).toHaveBeenCalledTimes(1)
  })

  it('a second file opened while the first is being asked about waits for the answer', async () => {
    api.previewImport.mockResolvedValueOnce({ preview: PREVIEW, importId: 'IMPORT1' })
    api.cancelImport.mockResolvedValue()
    const { session } = fakeSession()
    render(<Settings section="export" session={session} />)
    offerFile(new File(['PK'], 'first.papertie'))
    const box = await dialog()
    api.previewImport.mockResolvedValueOnce({
      preview: { ...PREVIEW, name: 'Second' },
      importId: 'IMPORT2',
    })
    offerFile(new File(['PK'], 'second.papertie'))
    // The question about the first stays as it is.
    expect(api.previewImport).toHaveBeenCalledTimes(1)
    within(box).getByRole('button', { name: 'Keep current' }).click()
    await screen.findByRole('alertdialog', { name: 'Replace your board with “Second”?' })
    expect(api.cancelImport).toHaveBeenCalledWith(BOARD_ID, 'IMPORT1')
    expect((api.previewImport.mock.calls[1] as [string, File])[1].name).toBe('second.papertie')
  })

  it('two files opened back to back: the second waits for the answer about the first', async () => {
    api.previewImport.mockResolvedValueOnce({ preview: PREVIEW, importId: 'IMPORT1' })
    api.previewImport.mockResolvedValueOnce({
      preview: { ...PREVIEW, name: 'Second' },
      importId: 'IMPORT2',
    })
    api.cancelImport.mockResolvedValue()
    const { session } = fakeSession()
    render(<Settings section="export" session={session} />)
    // Both arrive before React has drawn anything for the first.
    offerFile(new File(['PK'], 'first.papertie'))
    offerFile(new File(['PK'], 'second.papertie'))
    const box = await dialog()
    expect(api.previewImport).toHaveBeenCalledTimes(1)
    expect((api.previewImport.mock.calls[0] as [string, File])[1].name).toBe('first.papertie')
    within(box).getByRole('button', { name: 'Keep current' }).click()
    await screen.findByRole('alertdialog', { name: 'Replace your board with “Second”?' })
    expect(api.previewImport).toHaveBeenCalledTimes(2)
    expect((api.previewImport.mock.calls[1] as [string, File])[1].name).toBe('second.papertie')
  })

  it('in a browser (no desktop bridge) nothing listens', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(() => listenForOpenedFiles()).not.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(location.pathname).toBe('/')
  })
})
