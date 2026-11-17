import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { createSyncFeed } from '../../src/sync/feed'
import { droppedMessage, rejectedMessage } from '../../src/sync/notices'
import { SaveDot, SyncSaveDot } from '../../src/sync/SaveDot'
import { SLIP_CALM_MS, SyncNotices } from '../../src/sync/SyncNotices'
import type { SaveStatus } from '../../src/sync/types'

const COPY: Record<SaveStatus, string> = {
  saved: 'Saved',
  saving: 'Saving…',
  offline: 'Not saved yet — trying again',
  error: 'Couldn’t save',
}

const dot = () => screen.getByTestId('save-dot')
const open = () => {}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('SaveDot', () => {
  it('SaveDot shows each status copy and hides "Saved" after 1.5 s', () => {
    const { rerender } = render(<SaveDot status="saving" onOpenDetail={open} />)
    expect(dot().getAttribute('aria-label')).toBe(COPY.saving)
    expect(dot().dataset.shown).toBe('true')

    for (const status of ['offline', 'error'] as const) {
      rerender(<SaveDot status={status} onOpenDetail={open} />)
      expect(dot().getAttribute('aria-label')).toBe(COPY[status])
      // Offline and error stay until they clear, and say so to a screen reader.
      act(() => {
        vi.advanceTimersByTime(60_000)
      })
      expect(dot().dataset.shown).toBe('true')
      expect(screen.getByRole('status').textContent).toBe(COPY[status])
    }

    rerender(<SaveDot status="saved" onOpenDetail={open} />)
    expect(dot().getAttribute('aria-label')).toBe(COPY.saved)
    expect(dot().dataset.shown).toBe('true')
    act(() => {
      vi.advanceTimersByTime(1499)
    })
    expect(dot().dataset.shown).toBe('true')
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(dot().dataset.shown).toBe('false')
    // Hidden means out of reach: no tab stop, nothing read out.
    expect(dot().tabIndex).toBe(-1)
    expect(dot().getAttribute('aria-hidden')).toBe('true')
  })

  it('starts hidden on a board with nothing to save', () => {
    render(<SaveDot status="saved" onOpenDetail={open} />)
    expect(dot().dataset.shown).toBe('false')
  })

  it('stays in reach while it holds notices, and a click opens the detail', () => {
    const onOpen = vi.fn()
    render(<SaveDot status="saved" attention onOpenDetail={onOpen} />)
    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(dot().dataset.shown).toBe('true')
    fireEvent.click(dot())
    expect(onOpen).toHaveBeenCalledTimes(1)
  })
})

describe('SyncSaveDot', () => {
  it('opens a popover with the status, what is waiting and the unsaved download', () => {
    const feed = createSyncFeed()
    feed.status('offline')
    feed.pending(2)
    const unsaved = vi.fn(() => '{"op":"note.delete","id":"note_x"}\n')
    const blobs: Blob[] = []
    const url = vi.fn((b: Blob) => {
      blobs.push(b)
      return 'blob:unsaved'
    })
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: url, revokeObjectURL: vi.fn() }))
    const clicks: HTMLAnchorElement[] = []
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicks.push(this)
    })

    render(<SyncSaveDot feed={feed} unsaved={unsaved} />)
    fireEvent.click(dot())
    const pop = screen.getByRole('dialog', { name: 'Save status' })
    expect(within(pop).getByText(COPY.offline)).toBeTruthy()
    expect(within(pop).getByText('2 changes waiting to be saved')).toBeTruthy()
    fireEvent.click(within(pop).getByRole('button', { name: 'Download unsaved changes' }))

    expect(blobs).toHaveLength(1)
    expect(blobs[0]?.type).toBe('application/x-ndjson')
    expect(clicks[0]?.download).toMatch(/^papertie-unsaved-\d{4}-\d{2}-\d{2}\.jsonl$/)
    expect(clicks[0]?.href).toBe('blob:unsaved')

    // Esc closes it, and the focus goes back to the dot.
    fireEvent.keyDown(pop, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(dot())
    click.mockRestore()
    vi.unstubAllGlobals()
  })
})

describe('the popover’s download', () => {
  it('is a quiet text button while saving or offline, and the ink button only when saving fails', () => {
    const feed = createSyncFeed()
    feed.pending(1)
    render(<SyncSaveDot feed={feed} unsaved={() => '{}\n'} />)
    for (const [status, cls] of [
      ['saving', 'sync-text-button'],
      ['offline', 'sync-text-button'],
      ['error', 'sync-button'],
    ] as const) {
      act(() => feed.status(status))
      if (screen.queryByRole('dialog') === null) fireEvent.click(dot())
      const button = within(screen.getByRole('dialog', { name: 'Save status' })).getByRole(
        'button',
        { name: 'Download unsaved changes' },
      )
      expect(button.className).toBe(cls)
    }
  })
})

describe('SyncSaveDot with nothing to download', () => {
  it('Esc still closes the popover, and the focus goes back to the dot', () => {
    const feed = createSyncFeed()
    feed.status('offline')
    render(<SyncSaveDot feed={feed} unsaved={() => ''} />)
    dot().focus()
    fireEvent.click(dot())
    const pop = screen.getByRole('dialog', { name: 'Save status' })
    expect(within(pop).getByText('Nothing waiting to be saved')).toBeTruthy()
    expect(
      (within(pop).getByRole('button', { name: 'Download unsaved changes' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true)
    // No button can take the focus: the popover holds it, so Esc reaches it.
    expect(document.activeElement).toBe(pop)
    fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(dot())
  })
})

describe('SyncSaveDot as the save lands', () => {
  it('the download going disabled under the focus keeps the focus in the popover, and Esc closes it', () => {
    const feed = createSyncFeed()
    feed.status('saving')
    feed.pending(1)
    let waiting = '{"op":"note.update","id":"note_x"}\n'
    const { rerender } = render(<SyncSaveDot feed={feed} unsaved={() => waiting} />)
    fireEvent.click(dot())
    const pop = screen.getByRole('dialog', { name: 'Save status' })
    const download = within(pop).getByRole('button', { name: 'Download unsaved changes' })
    expect(document.activeElement).toBe(download)
    // Saved: nothing to download, the button the focus was on is disabled.
    waiting = ''
    act(() => {
      feed.pending(0)
      feed.status('saved')
    })
    rerender(<SyncSaveDot feed={feed} unsaved={() => waiting} />)
    expect((download as HTMLButtonElement).disabled).toBe(true)
    expect(document.activeElement).toBe(pop)
    // Esc reaches it from wherever the focus is, the page itself included.
    ;(document.activeElement as HTMLElement).blur()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(dot())
  })
})

describe('SyncSaveDot Esc', () => {
  it('Esc elsewhere is not the popover’s: it stays open and the focus stays put', () => {
    const feed = createSyncFeed()
    feed.status('offline')
    const outside = document.createElement('input')
    document.body.append(outside)
    const seen = vi.fn()
    window.addEventListener('keydown', seen)
    try {
      render(<SyncSaveDot feed={feed} unsaved={() => ''} />)
      fireEvent.click(dot())
      outside.focus()
      fireEvent.keyDown(outside, { key: 'Escape' })
      expect(screen.getByRole('dialog', { name: 'Save status' })).toBeTruthy()
      expect(document.activeElement).toBe(outside)
      // It went on to the page untouched.
      expect(seen).toHaveBeenCalledTimes(1)
      expect((seen.mock.calls[0] as [KeyboardEvent])[0].defaultPrevented).toBe(false)
    } finally {
      window.removeEventListener('keydown', seen)
      outside.remove()
    }
  })

  it('an Esc that ends a composition (Safari: key code 229) leaves the popover open', () => {
    const feed = createSyncFeed()
    feed.status('offline')
    render(<SyncSaveDot feed={feed} unsaved={() => ''} />)
    fireEvent.click(dot())
    const pop = screen.getByRole('dialog', { name: 'Save status' })
    fireEvent.keyDown(pop, { key: 'Escape', keyCode: 229 })
    fireEvent.keyDown(pop, { key: 'Escape', isComposing: true })
    expect(screen.getByRole('dialog', { name: 'Save status' })).toBe(pop)
    fireEvent.keyDown(pop, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('SyncNotices', () => {
  it('a rejected notice stays until dismissed and offers the download', () => {
    const feed = createSyncFeed()
    const onDownload = vi.fn()
    render(
      <>
        <SyncNotices feed={feed} onDownload={onDownload} />
        <SyncSaveDot feed={feed} unsaved={() => 'x\n'} />
      </>,
    )
    const region = screen.getByRole('region', { name: 'Notices' })
    expect(region.getAttribute('aria-live')).toBe('polite')

    act(() => feed.notice({ kind: 'rejected', count: 1, message: rejectedMessage(1) }))
    // Long past a calm interval (and any fade after it), it is still there, not fading.
    for (let i = 0; i < 10; i++) {
      act(() => {
        vi.advanceTimersByTime(SLIP_CALM_MS)
      })
    }
    expect(within(region).getByText(rejectedMessage(1))).toBeTruthy()
    expect(within(region).getByRole('note').dataset.leaving).toBeUndefined()
    fireEvent.click(within(region).getByRole('button', { name: 'Download unsaved changes' }))
    expect(onDownload).toHaveBeenCalledTimes(1)

    fireEvent.click(within(region).getByRole('button', { name: 'Dismiss' }))
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(within(region).queryByText(rejectedMessage(1))).toBeNull()
    // Still within reach from the save dot.
    expect(dot().dataset.shown).toBe('true')
    fireEvent.click(dot())
    expect(within(screen.getByRole('dialog')).getByText(rejectedMessage(1))).toBeTruthy()
  })

  it('a dropped notice fades after a calm interval but stays in the popover, merged', () => {
    const feed = createSyncFeed()
    render(
      <>
        <SyncNotices feed={feed} onDownload={() => {}} />
        <SyncSaveDot feed={feed} unsaved={() => 'x\n'} />
      </>,
    )
    const region = screen.getByRole('region', { name: 'Notices' })
    act(() => feed.notice({ kind: 'dropped', count: 1, message: droppedMessage(1) }))
    act(() => feed.notice({ kind: 'dropped', count: 2, message: droppedMessage(2) }))
    // One slip, counting both.
    expect(within(region).getByText(droppedMessage(3))).toBeTruthy()
    expect(within(region).queryByText(droppedMessage(1))).toBeNull()

    act(() => {
      vi.advanceTimersByTime(SLIP_CALM_MS - 1)
    })
    expect(within(region).getByText(droppedMessage(3))).toBeTruthy()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    // It fades out, then goes.
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(within(region).queryByText(droppedMessage(3))).toBeNull()
    fireEvent.click(dot())
    const pop = screen.getByRole('dialog')
    expect(within(pop).getByText(droppedMessage(3))).toBeTruthy()

    // Cleared from the popover, the dot may rest again.
    fireEvent.click(within(pop).getByRole('button', { name: 'Clear' }))
    expect(within(pop).queryByText(droppedMessage(3))).toBeNull()
  })
})
