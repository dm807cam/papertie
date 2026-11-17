import type { Note } from '@papertie/core'
import { ApiError } from '../../src/api/http'
import { stepHistory } from '../../src/app/session'
import { addImages, type ImageDeps } from '../../src/images/upload'
import { file, harness, pendingOf, session } from '../helpers/photos'

const tick = () => new Promise((r) => setTimeout(r, 5))
const notesOf = (s: ReturnType<typeof session>): Note[] => [...s.store.getState().notes.values()]
const upload = (h: ReturnType<typeof harness>) => h.deps.upload as NonNullable<ImageDeps['upload']>

describe('Retry-After is honoured in full', () => {
  it('waits the whole 120 s the server asked, then tries again by itself', async () => {
    const s = session()
    const slept: number[] = []
    const h = harness(s)
    const real = upload(h)
    let calls = 0
    h.deps.upload = async (b, f, o) => {
      if (calls++ === 0) throw new ApiError(429, 'rate-limited', 120_000)
      return real(b, f, o)
    }
    h.deps.sleep = async (ms) => void slept.push(ms)
    await addImages(s, [file('a.jpg')], { x: 0, y: 0 }, h.deps)
    await tick()
    expect(slept).toEqual([120_000])
    expect(calls).toBe(2)
    expect(notesOf(s)[0]?.image).not.toBeNull()
  })

  it('says it is waiting, with no Retry to press, while it waits', async () => {
    const s = session()
    const h = harness(s)
    let wake: () => void = () => {}
    h.deps.upload = async () => {
      throw new ApiError(429, 'rate-limited', 5_000)
    }
    h.deps.sleep = () =>
      new Promise<void>((r) => {
        wake = r
      })
    const done = addImages(s, [file('a.jpg')], { x: 0, y: 0 }, h.deps)
    await tick()
    expect(pendingOf(s).get(notesOf(s)[0]?.id as string)?.state).toBe('waiting')
    wake()
    h.deps.sleep = async () => {}
    await tick()
    void done
  })
})

describe('one undo step for a photo note, however long the upload takes', () => {
  it('undoes a three-file drop in one step, and redo brings the photos back', async () => {
    const s = session()
    const h = harness(s)
    await addImages(s, [file('a.jpg'), file('b.jpg'), file('c.jpg')], { x: 0, y: 0 }, h.deps)
    await tick()
    expect(notesOf(s)).toHaveLength(3)
    stepHistory(s, 'undo')
    expect(notesOf(s)).toHaveLength(0)
    stepHistory(s, 'redo')
    expect(notesOf(s)).toHaveLength(3)
    expect(notesOf(s).every((n) => n.image !== null)).toBe(true)
  })

  it('an image arriving late neither splits the step nor clears redo', async () => {
    const s = session()
    let release: () => void = () => {}
    const h = harness(
      s,
      () =>
        new Promise<void>((r) => {
          release = r
        }),
    )
    const done = addImages(s, [file('a.jpg')], { x: 0, y: 0 }, h.deps)
    await tick()
    const id = notesOf(s)[0]?.id as string
    // The user moves the note and takes it back while the photo travels: redo is available.
    s.store.commit([{ op: 'note.update', id, set: { x: 50 } }], { label: 'move' })
    s.undo.seal()
    stepHistory(s, 'undo')
    expect(s.undo.canRedo).toBe(true)
    release()
    await done
    await tick()
    expect(notesOf(s)[0]?.image).not.toBeNull()
    expect(s.undo.canRedo).toBe(true)
    // One undo takes the whole note, never leaving a blank print.
    stepHistory(s, 'undo')
    expect(notesOf(s)).toHaveLength(0)
  })
})

describe('pending photos belong to their session', () => {
  it("keeps one session's previews out of another's", async () => {
    const a = session()
    const b = session()
    const h = harness(a, () => new Promise<void>(() => {}))
    void addImages(a, [file('a.jpg')], { x: 0, y: 0 }, h.deps)
    await tick()
    expect(pendingOf(a).size).toBe(1)
    expect(pendingOf(b).size).toBe(0)
  })

  it('lets go of the preview of a note that is deleted while it shows Retry', async () => {
    const s = session()
    const h = harness(s, async () => {
      throw new ApiError(0, 'network')
    })
    await addImages(s, [file('a.jpg')], { x: 0, y: 0 }, h.deps)
    const id = notesOf(s)[0]?.id as string
    expect(pendingOf(s).get(id)?.state).toBe('failed')
    s.store.commit([{ op: 'note.delete', id }])
    expect(pendingOf(s).size).toBe(0)
    expect(h.revoked).toEqual(['blob:fake/1'])
  })

  it("aborts uploads and revokes every preview when the session's canvas goes", async () => {
    const s = session()
    const signals: AbortSignal[] = []
    const h = harness(s)
    h.deps.upload = (_b, _f, o) =>
      new Promise((_, reject) => {
        if (o?.signal) {
          signals.push(o.signal)
          o.signal.addEventListener('abort', () => reject(new DOMException('x', 'AbortError')))
        }
      })
    void addImages(s, [file('a.jpg'), file('b.jpg')], { x: 0, y: 0 }, h.deps)
    await tick()
    const { photoSpaceFor } = await import('../../src/images/space')
    photoSpaceFor(s).dispose()
    await tick()
    expect(signals).toHaveLength(2)
    expect(signals.every((x) => x.aborted)).toBe(true)
    expect(pendingOf(s).size).toBe(0)
    expect(h.revoked.sort()).toEqual(['blob:fake/1', 'blob:fake/2'])
    // Nothing commits into the closed session afterwards.
    expect(notesOf(s).every((n) => n.image === null)).toBe(true)
  })
})

describe('errors say what is wrong', () => {
  const failWith = async (status: number, code = 'x') => {
    const s = session()
    const h = harness(s, async () => {
      throw new ApiError(status, code)
    })
    await addImages(s, [file('a.jpg')], { x: 0, y: 0 }, h.deps)
    const id = notesOf(s)[0]?.id as string
    return { s, id, p: pendingOf(s).get(id) }
  }

  it('does not offer Retry for what will fail again, and says why', async () => {
    for (const [status, message] of [
      [413, 'This photo is too large for the board.'],
      [415, 'This file couldn’t be read as a photo.'],
      [422, 'This file couldn’t be read as a photo.'],
      [403, 'Your board can’t take photos right now.'],
    ] as const) {
      const { p } = await failWith(status)
      expect(p?.state).toBe('rejected')
      expect(p?.message).toBe(message)
    }
  })

  it("keeps Retry for a dropped connection and for the server's own trouble", async () => {
    expect((await failWith(0, 'network')).p?.state).toBe('failed')
    expect((await failWith(503)).p?.state).toBe('failed')
  })

  it('Remove takes the note a photo was made for away, and its preview', async () => {
    const { s, id, p } = await failWith(413)
    p?.remove()
    expect(s.store.getState().notes.has(id)).toBe(false)
    expect(pendingOf(s).size).toBe(0)
  })

  it('does not say the upload failed when it was the arrival that is late', async () => {
    const s = session()
    const h = harness(s)
    const real = upload(h)
    h.deps.upload = async (b, f, o) => {
      const before = s.store.getState()
      const r = await real(b, f, o)
      s.store.replace(before)
      return r
    }
    await addImages(s, [file('a.jpg')], { x: 0, y: 0 }, h.deps)
    expect(pendingOf(s).get(notesOf(s)[0]?.id as string)?.state).toBe('late')
  })
})

describe('preparing a photo is cheap and bounded', () => {
  it('prepares at most three photos at once', async () => {
    const s = session()
    const h = harness(s)
    let live = 0
    let peak = 0
    h.deps.measure = async () => {
      peak = Math.max(peak, ++live)
      await tick()
      live--
      return { width: 800, height: 600 }
    }
    await addImages(
      s,
      ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => file(`${n}.jpg`)),
      { x: 0, y: 0 },
      h.deps,
    )
    expect(peak).toBeLessThanOrEqual(3)
    expect(notesOf(s)).toHaveLength(6)
  })

  it('takes size, tone and a small preview from one decode', async () => {
    const closed: string[] = []
    const calls: unknown[][] = []
    const bitmap = (w: number, h: number, name: string) => ({
      width: w,
      height: h,
      close: () => void closed.push(name),
    })
    vi.stubGlobal(
      'createImageBitmap',
      async (src: unknown, opts?: { resizeWidth?: number; resizeHeight?: number }) => {
        calls.push([src, opts])
        if (opts?.resizeWidth === 16) return bitmap(16, 16, 'tone')
        if (opts?.resizeWidth) return bitmap(opts.resizeWidth, opts.resizeHeight ?? 0, 'preview')
        return bitmap(4000, 3000, 'full')
      },
    )
    try {
      const blob = new Blob(['x'])
      const { analyzeImage } = await import('../../src/images/analyze')
      const a = await analyzeImage(blob)
      expect(a?.width).toBe(4000)
      expect(a?.height).toBe(3000)
      // The full image is decoded once; the tone and the preview are scaled from that bitmap.
      const full = calls.filter(([src]) => src === blob)
      expect(full).toHaveLength(1)
      expect(
        calls
          .filter(([src]) => src !== blob)
          .every(([src]) => (src as { width: number }).width === 4000),
      ).toBe(true)
      expect(
        calls.some(([, o]) => (o as { resizeWidth?: number } | undefined)?.resizeWidth === 16),
      ).toBe(true)
      expect(closed).toContain('full')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
