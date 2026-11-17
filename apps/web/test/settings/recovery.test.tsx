import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import * as boards from '../../src/api/boards'
import { ApiError } from '../../src/api/http'
import { formatTime, restoreQuestion } from '../../src/settings/format'
import { RecoveryNotice } from '../../src/settings/RecoveryNotice'
import { BOARD_ID, fakeSession } from './fakeSession'

vi.mock('../../src/api/boards', () => ({
  boardMeta: vi.fn(),
  dismissRecovery: vi.fn(),
  restoreBackup: vi.fn(),
}))
const api = vi.mocked(boards)

const LATEST = {
  file: 'board.20261029T091500Z.r10.jsonl',
  revision: 10,
  notes: 12,
  yarns: 3,
}
const meta = (integrity: string, latestBackup: typeof LATEST | null = LATEST) => ({
  id: BOARD_ID,
  name: 'My board',
  revision: 11,
  recovery: { integrity, detectedAt: '2026-10-30T08:00:00.000Z', latestBackup },
  notes: 0,
  extent: null,
})

beforeEach(() => vi.resetAllMocks())

describe('RecoveryNotice', () => {
  it('says nothing for a board that was not recovered', async () => {
    const { session } = fakeSession({ recovered: false })
    const { container } = render(<RecoveryNotice session={session} />)
    await new Promise((r) => setTimeout(r, 10))
    expect(api.boardMeta).not.toHaveBeenCalled()
    expect(container.querySelector('.recovery-slip')).toBeNull()
  })

  it('recovery notice shows counts and dismisses', async () => {
    api.boardMeta.mockResolvedValue(meta('repaired'))
    api.dismissRecovery.mockResolvedValue(undefined)
    const { session } = fakeSession({ recovered: true })
    render(<RecoveryNotice session={session} />)
    expect(
      await screen.findByText('Papertie repaired your board after a problem saving it.'),
    ).toBeTruthy()
    expect(api.boardMeta).toHaveBeenCalledWith(BOARD_ID)

    // Counts side by side: the board now (empty here), and the latest backup.
    fireEvent.click(screen.getByRole('button', { name: 'Compare with latest backup' }))
    const table = screen.getByRole('table')
    const cells = (row: number) =>
      Array.from(table.querySelectorAll('tbody tr')[row]?.children ?? []).map((c) => c.textContent)
    expect(cells(0)).toEqual(['Notes', '0', '12'])
    expect(cells(1)).toEqual(['Threads', '0', '3'])

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(api.dismissRecovery).toHaveBeenCalledWith(BOARD_ID))
    await waitFor(() => expect(screen.queryByRole('note')).toBeNull())
  })

  it('reads differently for a restore', async () => {
    api.boardMeta.mockResolvedValue(meta('restored'))
    render(<RecoveryNotice session={fakeSession({ recovered: true }).session} />)
    expect(await screen.findByText('This board was restored from a backup.')).toBeTruthy()
  })

  it('says a restore that did not finish left the board as it was, and offers no backup', async () => {
    api.boardMeta.mockResolvedValue(meta('restore-interrupted', null))
    render(<RecoveryNotice session={fakeSession({ recovered: true }).session} />)
    expect(
      await screen.findByText('A restore did not finish. Your board is as it was.'),
    ).toBeTruthy()
    expect(screen.queryByText('This board was restored from a backup.')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Restore that backup' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy()
  })

  it('says an import replaced the board, offering the board it replaced; or that one did not finish', async () => {
    api.boardMeta.mockResolvedValue(meta('imported'))
    const { unmount } = render(
      <RecoveryNotice session={fakeSession({ recovered: true }).session} />,
    )
    expect(await screen.findByText('Board replaced. You can undo this from History.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Restore that backup' })).toBeTruthy()
    unmount()

    api.boardMeta.mockResolvedValue(meta('import-interrupted', null))
    render(<RecoveryNotice session={fakeSession({ recovered: true }).session} />)
    expect(
      await screen.findByText('An import did not finish. Your board is as it was.'),
    ).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Restore that backup' })).toBeNull()
  })

  it('restores that backup after asking, naming its time', async () => {
    api.boardMeta.mockResolvedValue(meta('repaired'))
    api.restoreBackup.mockResolvedValue({ revision: 12, safetyBackup: 'x' })
    render(<RecoveryNotice session={fakeSession({ recovered: true }).session} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Restore that backup' }))
    expect(
      screen.getByText(restoreQuestion(formatTime(new Date(Date.UTC(2026, 9, 29, 9, 15, 0))))),
    ).toBeTruthy()
    expect(api.restoreBackup).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Restore this version' }))
    await waitFor(() => expect(api.restoreBackup).toHaveBeenCalledWith(BOARD_ID, LATEST.file))
  })

  it('its own Restore says so in a quiet slip and remembers the backup', async () => {
    api.boardMeta.mockResolvedValue(meta('repaired'))
    api.restoreBackup.mockResolvedValue({ revision: 12, safetyBackup: 'board.s12.jsonl' })
    const { session } = fakeSession({ recovered: true })
    render(<RecoveryNotice session={session} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Restore that backup' }))
    fireEvent.click(screen.getByRole('button', { name: 'Restore this version' }))
    await waitFor(() =>
      expect(session.feed.getState().notices.map((n) => n.message)).toEqual([
        'Board restored. You can undo this from History.',
      ]),
    )
    expect(localStorage.getItem(`papertie.ownRecovery.${BOARD_ID}`)).toBe('board.s12.jsonl')
  })

  it('skips the notice of an import or restore the page asked for; any other is shown', async () => {
    localStorage.setItem(`papertie.ownRecovery.${BOARD_ID}`, LATEST.file)
    api.boardMeta.mockResolvedValue(meta('imported'))
    const mine = render(<RecoveryNotice session={fakeSession({ recovered: true }).session} />)
    await waitFor(() => expect(api.boardMeta).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 10))
    expect(mine.container.querySelector('.recovery-slip')).toBeNull()
    mine.unmount()
    localStorage.setItem(`papertie.ownRecovery.${BOARD_ID}`, 'board.another.jsonl')
    render(<RecoveryNotice session={fakeSession({ recovered: true }).session} />)
    expect(await screen.findByText('Board replaced. You can undo this from History.')).toBeTruthy()
    localStorage.clear()
  })

  it('a board replaced under the page gives one slip: the recovery slip says the reload', async () => {
    api.boardMeta.mockResolvedValue(meta('imported'))
    const { session } = fakeSession({ recovered: false })
    render(<RecoveryNotice session={session} />)
    act(() =>
      session.feed.notice({
        kind: 'reset',
        count: 0,
        message: 'Your board was reloaded.',
        server: true,
        revision: 9,
      }),
    )
    expect(await screen.findByText('Board replaced. You can undo this from History.')).toBeTruthy()
    await waitFor(() => expect(session.feed.getState().notices).toEqual([]))
    // A reset with nothing to recover: its own slip shows.
    api.boardMeta.mockResolvedValue({ ...meta('imported'), recovery: null })
    act(() =>
      session.feed.notice({
        kind: 'reset',
        count: 0,
        message: 'Your board was reloaded.',
        server: true,
        revision: 10,
      }),
    )
    await waitFor(() =>
      expect(session.feed.getState().notices.map((n) => [n.message, n.held ?? false])).toEqual([
        ['Your board was reloaded.', false],
      ]),
    )
  })

  it('dismisses from the slip’s corner, as the other notices do, so the actions keep one row', async () => {
    api.boardMeta.mockResolvedValue(meta('repaired'))
    render(<RecoveryNotice session={fakeSession({ recovered: true }).session} />)
    const dismiss = await screen.findByRole('button', { name: 'Dismiss' })
    expect(dismiss.className).toBe('sync-slip-close')
    expect(dismiss.closest('.recovery-actions')).toBeNull()
    expect(dismiss.parentElement?.classList.contains('recovery-slip')).toBe(true)
  })

  it('hides the corner Dismiss while the restore question is open', async () => {
    api.boardMeta.mockResolvedValue(meta('repaired'))
    render(<RecoveryNotice session={fakeSession({ recovered: true }).session} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Restore that backup' }))
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy()
  })

  it('offers only Dismiss when there is no backup to compare with', async () => {
    api.boardMeta.mockResolvedValue(meta('repaired', null))
    render(<RecoveryNotice session={fakeSession({ recovered: true }).session} />)
    await screen.findByRole('button', { name: 'Dismiss' })
    expect(screen.queryByRole('button', { name: 'Compare with latest backup' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Restore that backup' })).toBeNull()
  })

  it('keeps the slip and says why when dismissing fails', async () => {
    api.boardMeta.mockResolvedValue(meta('repaired'))
    api.dismissRecovery.mockRejectedValue(new ApiError(0, 'network'))
    render(<RecoveryNotice session={fakeSession({ recovered: true }).session} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }))
    expect(await screen.findByText('Can’t reach Papertie — check your connection.')).toBeTruthy()
    expect(screen.getByRole('note')).toBeTruthy()
  })

  it('follows a reset: a restore brings its slip', async () => {
    api.boardMeta.mockResolvedValue(meta('restored'))
    const { session } = fakeSession({ recovered: false })
    render(<RecoveryNotice session={session} />)
    expect(api.boardMeta).not.toHaveBeenCalled()
    act(() =>
      session.feed.notice({
        kind: 'reset',
        count: 0,
        message: 'Your board was reloaded.',
      }),
    )
    expect(await screen.findByText('This board was restored from a backup.')).toBeTruthy()
  })
})
