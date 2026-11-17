import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import * as boards from '../../src/api/boards'
import { ApiError } from '../../src/api/http'
import { formatTime, restoreQuestion } from '../../src/settings/format'
import { Settings } from '../../src/settings/Settings'
import { BOARD_ID, fakeSession } from './fakeSession'

vi.mock('../../src/api/boards', () => ({ listBackups: vi.fn(), restoreBackup: vi.fn() }))
const api = vi.mocked(boards)

const backup = (file: string, o: Partial<boards.BackupRow> = {}): boards.BackupRow => ({
  id: file,
  revision: 10,
  takenAt: '2026-10-29T09:15:00.000Z',
  notes: 12,
  yarns: 3,
  books: 0,
  words: 0,
  bytes: 4096,
  damaged: false,
  ...o,
})
const NEWER = backup('board.20261029T091500Z.r10.jsonl')
const OLDER = backup('board.20261028T180000Z.r7.jsonl', {
  takenAt: '2026-10-28T18:00:00.000Z',
  notes: 1,
  yarns: 0,
})

beforeEach(() => {
  vi.resetAllMocks()
  history.replaceState(null, '', '/settings/history')
})

const show = () => render(<Settings section="history" session={fakeSession().session} />)
const rowOf = async (index: number) => {
  const list = await screen.findByRole('list', { name: 'Backups' })
  return within(within(list).getAllByRole('listitem')[index] as HTMLElement)
}

describe('Settings history', () => {
  it('lists the backups newest first with their time, notes and threads', async () => {
    api.listBackups.mockResolvedValue([OLDER, NEWER]) // out of order on purpose
    show()
    const first = await rowOf(0)
    expect(first.getByText(formatTime(NEWER.takenAt))).toBeTruthy()
    expect(first.getByText('12 notes · 3 threads · no books')).toBeTruthy()
    const second = await rowOf(1)
    expect(second.getByText('1 note · 0 threads · no books')).toBeTruthy()
    expect(api.listBackups).toHaveBeenCalledWith(BOARD_ID)
  })

  it('shows the books a backup holds and their words: a version is the board and its books', async () => {
    api.listBackups.mockResolvedValue([
      backup('board.20261029T091500Z.r10.jsonl', { books: 3, words: 4210 }),
      backup('board.20261028T180000Z.r7.jsonl', {
        takenAt: '2026-10-28T18:00:00.000Z',
        notes: 1,
        yarns: 1,
        books: 1,
        words: 1,
      }),
      backup('board.20261027T180000Z.r4.jsonl', {
        takenAt: '2026-10-27T18:00:00.000Z',
        books: 0,
        words: 0,
      }),
    ])
    show()
    const words = (4210).toLocaleString()
    expect(
      (await rowOf(0)).getByText(`12 notes · 3 threads · 3 books · ${words} words`),
    ).toBeTruthy()
    expect((await rowOf(1)).getByText('1 note · 1 thread · 1 book · 1 word')).toBeTruthy()
    // No book then: said so, so the line never reads as notes alone.
    expect((await rowOf(2)).getByText('12 notes · 3 threads · no books')).toBeTruthy()
  })

  it('marks a damaged backup calmly', async () => {
    api.listBackups.mockResolvedValue([
      backup('board.20261029T091500Z.r10.jsonl', { damaged: true }),
    ])
    show()
    expect(await screen.findByText('Damaged — some lines will be set aside')).toBeTruthy()
  })

  it('history restore asks, posts, and shows the safety-backup line', async () => {
    api.listBackups.mockResolvedValue([NEWER, OLDER])
    api.restoreBackup.mockResolvedValue({
      revision: 14,
      safetyBackup: 'board.20261030T094100Z.r13.jsonl',
    })
    show()
    const older = await rowOf(1)
    fireEvent.click(older.getByRole('button', { name: 'Restore' }))
    // The question names the time of the version; nothing is posted yet.
    expect(older.getByText(restoreQuestion(formatTime(OLDER.takenAt)))).toBeTruthy()
    expect(
      screen.getByText(
        /^Replace the board with this version from .+\? Your current board is saved first, so you can come back to it\.$/,
      ),
    ).toBeTruthy()
    expect(api.restoreBackup).not.toHaveBeenCalled()

    fireEvent.click(older.getByRole('button', { name: 'Restore this version' }))
    await waitFor(() => expect(api.restoreBackup).toHaveBeenCalledWith(BOARD_ID, OLDER.id))
    const safety = formatTime(new Date(Date.UTC(2026, 9, 30, 9, 41, 0)))
    expect(
      await screen.findByText(
        new RegExp(
          `Restored\\. The board as it was at ${safety.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
        ),
      ),
    ).toBeTruthy()
    // The list is read again: the safety backup joins it.
    await waitFor(() => expect(api.listBackups).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('alertdialog')).toBeNull()
  })

  it('a restore that ends after Settings closed says so in a quiet slip, and remembers its backup', async () => {
    api.listBackups.mockResolvedValue([NEWER, OLDER])
    let answer: (v: { revision: number; safetyBackup: string }) => void = () => {}
    api.restoreBackup.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve
      }),
    )
    const { session } = fakeSession()
    const view = render(<Settings section="history" session={session} />)
    const older = await rowOf(1)
    fireEvent.click(older.getByRole('button', { name: 'Restore' }))
    fireEvent.click(older.getByRole('button', { name: 'Restore this version' }))
    await waitFor(() => expect(api.restoreBackup).toHaveBeenCalled())
    view.unmount()
    answer({ revision: 14, safetyBackup: 'board.r13.jsonl' })
    await waitFor(() =>
      expect(session.feed.getState().notices.map((n) => n.message)).toEqual([
        'Board restored. You can undo this from History.',
      ]),
    )
    expect(localStorage.getItem(`papertie.ownRecovery.${BOARD_ID}`)).toBe('board.r13.jsonl')
    localStorage.clear()
  })

  it('a restore that fails after Settings closed says so in a quiet slip', async () => {
    api.listBackups.mockResolvedValue([NEWER, OLDER])
    let fail: (e: unknown) => void = () => {}
    api.restoreBackup.mockReturnValue(
      new Promise((_, reject) => {
        fail = reject
      }),
    )
    const { session } = fakeSession()
    const view = render(<Settings section="history" session={session} />)
    const older = await rowOf(1)
    fireEvent.click(older.getByRole('button', { name: 'Restore' }))
    fireEvent.click(older.getByRole('button', { name: 'Restore this version' }))
    await waitFor(() => expect(api.restoreBackup).toHaveBeenCalled())
    view.unmount()
    fail(new ApiError(503, 'storage'))
    await waitFor(() =>
      expect(session.feed.getState().notices.map((n) => n.message)).toEqual([
        'Couldn’t restore that version. Your board is as it was.',
      ]),
    )
  })

  it('undoing a restore that fails after Settings closed says so in a quiet slip', async () => {
    api.listBackups.mockResolvedValue([NEWER, OLDER])
    let fail: (e: unknown) => void = () => {}
    api.restoreBackup
      .mockResolvedValueOnce({ revision: 14, safetyBackup: 'board.20261030T094100Z.r13.jsonl' })
      .mockReturnValueOnce(
        new Promise((_, reject) => {
          fail = reject
        }),
      )
    const { session } = fakeSession()
    const view = render(<Settings section="history" session={session} />)
    const older = await rowOf(1)
    fireEvent.click(older.getByRole('button', { name: 'Restore' }))
    fireEvent.click(older.getByRole('button', { name: 'Restore this version' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Undo restore' }))
    await waitFor(() => expect(api.restoreBackup).toHaveBeenCalledTimes(2))
    view.unmount()
    fail(new ApiError(503, 'storage'))
    await waitFor(() =>
      expect(session.feed.getState().notices.map((n) => n.message)).toEqual([
        'Couldn’t undo the restore. Your board is as it was.',
      ]),
    )
  })

  it('does not restore when the question is cancelled', async () => {
    api.listBackups.mockResolvedValue([NEWER])
    show()
    const row = await rowOf(0)
    fireEvent.click(row.getByRole('button', { name: 'Restore' }))
    fireEvent.click(row.getByRole('button', { name: 'Cancel' }))
    expect(api.restoreBackup).not.toHaveBeenCalled()
    expect(row.getByRole('button', { name: 'Restore' })).toBeTruthy()
  })

  it('says why when a restore fails, and leaves the list as it was', async () => {
    api.listBackups.mockResolvedValue([NEWER])
    api.restoreBackup.mockRejectedValue(new ApiError(0, 'network'))
    show()
    const row = await rowOf(0)
    fireEvent.click(row.getByRole('button', { name: 'Restore' }))
    fireEvent.click(row.getByRole('button', { name: 'Restore this version' }))
    expect(await screen.findByText('Can’t reach Papertie — check your connection.')).toBeTruthy()
    expect(api.listBackups).toHaveBeenCalledTimes(1)
  })

  it('undo restore puts the replaced board back with one click', async () => {
    api.listBackups.mockResolvedValue([NEWER, OLDER])
    api.restoreBackup.mockResolvedValueOnce({
      revision: 14,
      safetyBackup: 'board.20261030T094100Z.r13.jsonl',
    })
    api.restoreBackup.mockResolvedValueOnce({
      revision: 15,
      safetyBackup: 'board.20261030T094200Z.r14.jsonl',
    })
    show()
    const older = await rowOf(1)
    fireEvent.click(older.getByRole('button', { name: 'Restore' }))
    fireEvent.click(older.getByRole('button', { name: 'Restore this version' }))
    const undo = await screen.findByRole('button', { name: 'Undo restore' })
    expect(api.restoreBackup).toHaveBeenCalledTimes(1)
    fireEvent.click(undo)
    // No second question: it only brings back what the first restore saved. It is saved first too.
    await waitFor(() =>
      expect(api.restoreBackup).toHaveBeenLastCalledWith(
        BOARD_ID,
        'board.20261030T094100Z.r13.jsonl',
      ),
    )
    expect(await screen.findByText(/^Undone\./)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Undo restore' })).toBeNull()
  })
})
