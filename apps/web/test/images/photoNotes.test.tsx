import type { Note } from '@papertie/core'
import { applyBatch, emptyBoardState } from '@papertie/core'
import { act, cleanup, render } from '@testing-library/react'
import { prefsStore } from '../../src/app/prefs'
import { openLocalSession } from '../../src/app/session'
import { CanvasView } from '../../src/canvas/CanvasView'
import { ImageDrop, loadUpload } from '../../src/images/ImageDrop'
import { NotePhoto } from '../../src/images/NotePhoto'
import { PhotoContext } from '../../src/images/PhotoContext'
import { PendingImages } from '../../src/images/pending'
import { installCanvasStubs } from '../helpers/domCanvas'
import { BOARD_ID, idOf, note, T0 } from '../helpers/fakeServer'
import { file, harness, pendingOf, session } from '../helpers/photos'

const NOTE = 'note_01JBTEST0000000000000000A1'
const ASSET = 'asset_01JBTEST000000000000000A1'
const flush = () => new Promise((r) => setTimeout(r, 10))
const event = (type: string, extra: object) =>
  Object.assign(new Event(type, { bubbles: true, cancelable: true }), extra)
const dragData = (files: File[]) => ({ types: ['Files'], files, dropEffect: 'none' })

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

// The upload code is a chunk of its own, in once the board is up: here, before any drop.
beforeAll(() => loadUpload())

describe('a print without a photo is not a bare sheet', () => {
  function emptyPrintSetup() {
    const s = session()
    const h = harness(s)
    const id = idOf('note', 7)
    s.store.commit([
      {
        op: 'note.create',
        note: note(id, { style: 'print', text: '', image: null, w: 320, h: 240 }),
      },
    ])
    const root = document.createElement('main')
    document.body.append(root)
    const el = document.createElement('article')
    el.dataset.noteId = id
    root.append(el)
    new ImageDrop({ root, session: s, toWorld: (x, y) => ({ x, y }), deps: h.deps })
    const notes = (): Note[] => [...s.store.getState().notes.values()]
    return { s, h, root, el, id, notes }
  }

  it('fills an image-less print with a dropped file instead of making a second note', async () => {
    const { root, el, id, notes, h, s } = emptyPrintSetup()
    el.dispatchEvent(
      event('drop', { dataTransfer: dragData([file('a.jpg')]), clientX: 5, clientY: 5 }),
    )
    await flush()
    root.getBoundingClientRect()
    expect(notes()).toHaveLength(1)
    expect(h.uploads).toEqual(['a.jpg'])
    expect(s.store.getState().notes.get(id)?.image).not.toBeNull()
  })

  it('fills the image-less print that has the focus with a pasted file', async () => {
    const { el, id, notes, h, s } = emptyPrintSetup()
    el.tabIndex = -1
    el.focus()
    el.dispatchEvent(
      event('paste', {
        clipboardData: { files: [file('shot.png', 'image/png')], types: ['Files'] },
      }),
    )
    await flush()
    expect(notes()).toHaveLength(1)
    expect(s.store.getState().notes.get(id)?.image).not.toBeNull()
    expect(h.uploads).toEqual(['shot.png'])
  })
})

describe('a paste into a field stays in the field', () => {
  function pasteInto(make: () => HTMLElement, parent?: (root: HTMLElement) => HTMLElement) {
    const s = session()
    const h = harness(s)
    const root = document.createElement('main')
    document.body.append(root)
    new ImageDrop({ root, session: s, toWorld: (x, y) => ({ x, y }), deps: h.deps })
    const el = make()
    ;(parent ? parent(root) : root).append(el)
    const e = event('paste', {
      clipboardData: { files: [file('shot.png', 'image/png')], types: ['Files'] },
    })
    el.dispatchEvent(e)
    return { e, h, s }
  }

  it.each([
    ['a textarea', () => document.createElement('textarea')],
    ['an input in the ui layer', () => document.createElement('input')],
    [
      'a contenteditable',
      () => {
        const d = document.createElement('div')
        d.setAttribute('contenteditable', 'plaintext-only')
        return d
      },
    ],
  ])('leaves a files-only paste into %s alone', async (_n, make) => {
    const { e, h, s } = pasteInto(make)
    await flush()
    expect(e.defaultPrevented).toBe(false)
    expect(h.uploads).toEqual([])
    expect(s.store.getState().notes.size).toBe(0)
  })

  it('still takes a paste made on the board itself', async () => {
    const { e, h } = pasteInto(() => document.createElement('div'))
    await flush()
    expect(e.defaultPrevented).toBe(true)
    expect(h.uploads).toEqual(['shot.png'])
  })
})

describe('the preview stays until the image is in', () => {
  const decodes: Array<() => void> = []
  beforeEach(() => {
    decodes.length = 0
    Object.defineProperty(HTMLImageElement.prototype, 'decode', {
      configurable: true,
      value: () => new Promise<void>((r) => decodes.push(r)),
    })
  })
  afterEach(() => {
    delete (HTMLImageElement.prototype as { decode?: unknown }).decode
  })

  it('releases the preview only after the new image has decoded, already showing', async () => {
    const release = vi.fn()
    const pending = new PendingImages()
    pending.set(NOTE, {
      url: 'blob:fake/1',
      state: 'uploading',
      committed: true,
      retry: vi.fn(),
      remove: vi.fn(),
      release,
    } as never)
    const { container } = render(
      <PhotoContext.Provider value={{ pending }}>
        <NotePhoto
          noteId={NOTE}
          image={{ assetId: ASSET, frame: 'print' }}
          style="print"
          lite={false}
          w={300}
          h={225}
        />
      </PhotoContext.Provider>,
    )
    await act(flush)
    // Decoding has not finished: the preview is all there is, and it stays.
    expect(release).not.toHaveBeenCalled()
    expect(container.querySelector('.photo-preview')).not.toBeNull()
    await act(async () => {
      for (const d of decodes.splice(0)) d()
      await flush()
    })
    const real = container.querySelector('.photo-real') as HTMLElement
    expect(real.dataset.loaded).toBe('')
    expect(release).toHaveBeenCalled()
  })
})

describe('a local board', () => {
  it('does not light the cork for a drop it cannot take, and still keeps the browser from opening the file', () => {
    const local = openLocalSession({
      kind: 'local',
      state: emptyBoardState(BOARD_ID, 'test', T0),
      label: 'test',
    })
    const root = document.createElement('main')
    document.body.append(root)
    new ImageDrop({ root, session: local, toWorld: (x, y) => ({ x, y }) })
    const over = event('dragenter', { dataTransfer: dragData([file('a.jpg')]) })
    root.dispatchEvent(over)
    expect(over.defaultPrevented).toBe(true)
    expect(root.dataset.drop).toBeUndefined()
  })
})

describe('leaving the caption of a photo note mid-upload', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(T0))
    prefsStore.setState({ tool: 'select' })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  async function leaveCaption(withPending: boolean) {
    const restore = installCanvasStubs()
    try {
      const id = idOf('note', 3)
      const state = applyBatch(
        emptyBoardState(BOARD_ID, 'Test board', T0),
        [
          {
            op: 'note.create',
            note: note(id, { style: 'print', text: '', image: null, x: 500, y: 300 }),
          },
        ],
        { now: T0 },
      )
      const s = { ...openLocalSession({ kind: 'local', state, label: 'test' }), boardId: BOARD_ID }
      if (withPending) {
        pendingOf(s).set(id, {
          url: 'blob:fake/1',
          state: 'uploading',
          committed: false,
          retry: () => {},
          remove: () => {},
          release: () => {},
        })
      }
      render(<CanvasView session={s} />)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(50)
      })
      const rt = window.__papertie?.runtime as {
        startEditing(id: string): boolean
        stopEditing(id: string): void
      }
      expect(rt.startEditing(id)).toBe(true)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20)
      })
      act(() => rt.stopEditing(id))
      const kept = s.store.getState().notes.has(id)
      s.dispose()
      return kept
    } finally {
      restore()
    }
  }

  it('keeps a note whose photo is still on its way', async () => {
    expect(await leaveCaption(true)).toBe(true)
  })

  it('keeps a print that is waiting for its photo', async () => {
    expect(await leaveCaption(false)).toBe(true)
  })
})
