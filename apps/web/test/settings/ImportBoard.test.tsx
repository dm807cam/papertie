import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { StrictMode } from 'react'
import * as boards from '../../src/api/boards'
import { ApiError } from '../../src/api/http'
import { Settings } from '../../src/settings/Settings'
import { BOARD_ID, fakeSession } from './fakeSession'

vi.mock('../../src/api/boards', async (actual) => ({
  ...(await actual<typeof boards>()),
  previewImport: vi.fn(),
  commitImport: vi.fn(),
  cancelImport: vi.fn(),
}))
const api = vi.mocked(boards)

const PREVIEW: boards.ImportPreview = {
  name: 'Jardin Garden',
  notes: 12,
  yarns: 3,
  assets: 2,
  bytes: 4096,
  skippedRecords: 0,
}

beforeEach(() => {
  vi.resetAllMocks()
  history.replaceState(null, '', '/settings/export')
})

function show() {
  const { session, sync } = fakeSession()
  const view = render(<Settings section="export" session={session} />)
  return { ...view, session, sync }
}

/** Pick `file` in the import's file chooser. */
function choose(container: HTMLElement, file = new File(['PK'], 'garden.papertie')) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')
  if (!input) throw new Error('no file input')
  fireEvent.click(screen.getByRole('button', { name: 'Import…' }))
  fireEvent.change(input, { target: { files: [file] } })
  return file
}

const dialog = () =>
  screen.findByRole('alertdialog', { name: 'Replace your board with “Jardin Garden”?' })

describe('Settings import', () => {
  it('says it is reading the file, as a status', async () => {
    let answer: (v: { preview: boards.ImportPreview; importId: string }) => void = () => {}
    api.previewImport.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve
      }),
    )
    const { container } = show()
    choose(container)
    expect((await screen.findByRole('status')).textContent).toBe('Reading the file…')
    answer({ preview: PREVIEW, importId: 'IMPORT1' })
    await dialog()
    expect(screen.queryByText('Reading the file…')).toBeNull()
  })

  it('asks under StrictMode too (mounted twice, it still hears the answer)', async () => {
    api.previewImport.mockResolvedValue({ preview: PREVIEW, importId: 'IMPORT1' })
    const { session } = fakeSession()
    const { container } = render(
      <StrictMode>
        <Settings section="export" session={session} />
      </StrictMode>,
    )
    choose(container)
    expect(await dialog()).toBeTruthy()
    expect(api.cancelImport).not.toHaveBeenCalled()
  })

  it('leaving Settings while asking discards the staged file', async () => {
    api.previewImport.mockResolvedValue({ preview: PREVIEW, importId: 'IMPORT1' })
    api.cancelImport.mockResolvedValue()
    const { container, unmount } = show()
    choose(container)
    await dialog()
    unmount()
    await waitFor(() => expect(api.cancelImport).toHaveBeenCalledWith(BOARD_ID, 'IMPORT1'))
    expect(api.commitImport).not.toHaveBeenCalled()
  })

  it('the dialog shows the exact copy, filled from the preview, with the safe answer focused', async () => {
    api.previewImport.mockResolvedValue({ preview: PREVIEW, importId: 'IMPORT1' })
    const { container } = show()
    const file = choose(container)
    await waitFor(() => expect(api.previewImport).toHaveBeenCalledWith(BOARD_ID, file))

    const box = await dialog()
    // An alert on the paper it came from, not a modal: the rest of Settings stays as it is.
    expect(box.getAttribute('aria-modal')).toBeNull()
    expect(
      within(box).getByText(
        'It has 12 notes and 3 threads. Your current board is saved to History first.',
      ),
    ).toBeTruthy()
    const keep = within(box).getByRole('button', { name: 'Keep current' })
    const replace = within(box).getByRole('button', { name: 'Replace board' })
    // The destructive answer is never where focus lands.
    expect(document.activeElement).toBe(keep)
    // Focus stays in the dialog: Tab from the last control comes back round.
    const controls = within(box).getAllByRole('button')
    ;(controls.at(-1) as HTMLElement).focus()
    fireEvent.keyDown(controls.at(-1) as HTMLElement, { key: 'Tab' })
    expect(document.activeElement).toBe(controls[0])
    fireEvent.keyDown(controls[0] as HTMLElement, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(controls.at(-1))
    expect(replace).toBeTruthy()
    expect(api.commitImport).not.toHaveBeenCalled()
  })

  it('Keep current calls cancel, and so does Esc', async () => {
    api.previewImport.mockResolvedValue({ preview: PREVIEW, importId: 'IMPORT1' })
    api.cancelImport.mockResolvedValue()
    const { container } = show()
    choose(container)
    fireEvent.click(within(await dialog()).getByRole('button', { name: 'Keep current' }))
    await waitFor(() => expect(api.cancelImport).toHaveBeenCalledWith(BOARD_ID, 'IMPORT1'))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(api.commitImport).not.toHaveBeenCalled()
    // Focus is back where the import began.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Import…' }))

    api.previewImport.mockResolvedValue({ preview: PREVIEW, importId: 'IMPORT2' })
    choose(container)
    fireEvent.keyDown(await dialog(), { key: 'Escape' })
    await waitFor(() => expect(api.cancelImport).toHaveBeenCalledWith(BOARD_ID, 'IMPORT2'))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    // Esc answered the question; the settings sheet itself stays open.
    expect(screen.getByTestId('settings')).toBeTruthy()
  })

  it('errors map to the three error strings', async () => {
    const cases: Array<[ApiError, string]> = [
      [
        new ApiError(422, 'import-invalid', null, {
          error: 'import-invalid',
          reason: 'entry-name',
        }),
        'This file isn’t a Papertie board.',
      ],
      [
        new ApiError(422, 'import-invalid', null, {
          error: 'import-invalid',
          reason: 'checksum-mismatch',
          line: 1207,
        }),
        'This board file is damaged (line 1207). Nothing was changed.',
      ],
      [
        new ApiError(507, 'quota', null, { error: 'quota', needMb: 120, freeMb: 40 }),
        'This board needs 120 MB and you have 40 MB left.',
      ],
      [
        // Larger than all that is left: the file's own size is what it needs, at least.
        new ApiError(413, 'too-large', null, { error: 'too-large', freeMb: 3 }),
        'This board needs 5 MB and you have 3 MB left.',
      ],
      [
        new ApiError(422, 'import-invalid', null, {
          error: 'import-invalid',
          reason: 'missing-eof',
          line: 41,
        }),
        'This board file is damaged (line 41). Nothing was changed.',
      ],
      [
        new ApiError(422, 'import-invalid', null, {
          error: 'import-invalid',
          reason: 'too-many-notes',
        }),
        'This board has more than 100,000 notes. Nothing was changed.',
      ],
      [
        new ApiError(422, 'import-invalid', null, {
          error: 'import-invalid',
          reason: 'too-many-threads',
        }),
        'This board has more threads than Papertie holds. Nothing was changed.',
      ],
      [
        new ApiError(422, 'import-invalid', null, {
          error: 'import-invalid',
          reason: 'too-many-assets',
        }),
        'This board has more photo records than notes. Nothing was changed.',
      ],
      [
        new ApiError(422, 'import-invalid', null, {
          error: 'import-invalid',
          reason: 'unsupported-version',
        }),
        'This board was made by a different version of Papertie. Nothing was changed.',
      ],
      [
        // A board record of another version names its line; the version is still the reason.
        new ApiError(422, 'import-invalid', null, {
          error: 'import-invalid',
          reason: 'unsupported-version',
          line: 1,
        }),
        'This board was made by a different version of Papertie. Nothing was changed.',
      ],
      [
        new ApiError(422, 'import-invalid', null, {
          error: 'import-invalid',
          reason: 'asset-too-large',
        }),
        'A photo in this file is larger than 25 MB. Nothing was changed.',
      ],
      [
        // A 413 from something in between (no `freeMb`): nothing to say of the quota.
        new ApiError(413, 'too-large', null, null),
        'Something went wrong. Try again in a moment.',
      ],
    ]
    const { container } = show()
    for (const [error, text] of cases) {
      api.previewImport.mockRejectedValueOnce(error)
      choose(container, new File([new Uint8Array(5 * 1_048_576 - 10)], 'big.papertie'))
      expect(await screen.findByText(text)).toBeTruthy()
      expect(screen.queryByRole('alertdialog')).toBeNull()
    }
    expect(api.commitImport).not.toHaveBeenCalled()
  })

  it('the question names the file’s books, and a book refusal says what is wrong', async () => {
    api.previewImport.mockResolvedValueOnce({
      preview: { ...PREVIEW, books: 4, blocks: 900 },
      importId: 'IMPORT1',
    })
    const { container } = show()
    choose(container)
    const box = await dialog()
    expect(
      within(box).getByText(
        'It has 12 notes, 3 threads and 4 books. Your current board is saved to History first.',
      ),
    ).toBeTruthy()
    fireEvent.click(within(box).getByRole('button', { name: 'Keep current' }))
    const cases: Array<[string, string]> = [
      ['too-many-books', 'This board has more than 500 books. Nothing was changed.'],
      [
        'too-many-blocks',
        'A book in this file has more than 60,000 paragraphs. Nothing was changed.',
      ],
      [
        'missing-book',
        'A paragraph in this file belongs to a book that isn’t in it. Nothing was changed.',
      ],
      ['book-too-long', 'A book in this file is longer than Papertie holds. Nothing was changed.'],
    ]
    for (const [reason, text] of cases) {
      api.previewImport.mockRejectedValueOnce(
        new ApiError(422, 'import-invalid', null, { error: 'import-invalid', reason, line: 9 }),
      )
      choose(container)
      expect(await screen.findByText(text)).toBeTruthy()
    }
  })

  it('an import that ends after Settings closed says so in a quiet slip, and remembers its backup', async () => {
    api.previewImport.mockResolvedValue({ preview: PREVIEW, importId: 'IMPORT1' })
    let answer: (v: { revision: number; safetyBackup: string }) => void = () => {}
    api.commitImport.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve
      }),
    )
    const { session } = fakeSession()
    const { container, unmount } = render(<Settings section="export" session={session} />)
    choose(container)
    fireEvent.click(within(await dialog()).getByRole('button', { name: 'Replace board' }))
    await waitFor(() => expect(api.commitImport).toHaveBeenCalled())
    unmount()
    answer({ revision: 42, safetyBackup: 'board.r41.jsonl' })
    await waitFor(() =>
      expect(session.feed.getState().notices.map((n) => n.message)).toEqual([
        'Board replaced. You can undo this from History.',
      ]),
    )
    expect(localStorage.getItem(`papertie.ownRecovery.${BOARD_ID}`)).toBe('board.r41.jsonl')
    localStorage.clear()
  })

  it('Replace board commits, and the line after it points to History', async () => {
    api.previewImport.mockResolvedValue({ preview: PREVIEW, importId: 'IMPORT1' })
    api.commitImport.mockResolvedValue({
      revision: 42,
      safetyBackup: 'board.20261030T094100Z.r41.jsonl',
    })
    const flush = vi.fn(async () => {})
    const { session } = fakeSession({ sync: { flush } })
    const { container } = render(<Settings section="export" session={session} />)
    choose(container)
    fireEvent.click(within(await dialog()).getByRole('button', { name: 'Replace board' }))
    await waitFor(() => expect(api.commitImport).toHaveBeenCalledWith(BOARD_ID, 'IMPORT1'))
    // The page's own unsent edits go first, so the safety backup holds them.
    expect(flush).toHaveBeenCalled()
    const done = await screen.findByText(
      (_, el) =>
        el?.classList.contains('settings-message') === true &&
        el.textContent === 'Board replaced. You can undo this from History.',
    )
    const link = within(done).getByRole('link', { name: 'History' })
    expect(link.getAttribute('href')).toBe('/settings/history')
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(api.cancelImport).not.toHaveBeenCalled()
  })
})
