import { CAMERA_SAVE_MS, cameraKey, createCameraMemory } from '../../src/app/cameraMemory'
import { ZOOM_MAX } from '../../src/canvas/Camera'

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: vi.fn((k: string, v: string) => {
      data.set(k, v)
    }),
  }
}

const A = 'board_aaaaaaaaaaaaaaaaaaaaaaaaaa'
const B = 'board_bbbbbbbbbbbbbbbbbbbbbbbbbb'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('camera memory', () => {
  it('camera is recalled per board', () => {
    const storage = memoryStorage()
    const mem = createCameraMemory(storage)
    expect(mem.recall(A)).toBeNull()
    mem.remember(A, { x: 10, y: -20, zoom: 0.5 })
    mem.remember(B, { x: 1, y: 2, zoom: 2 })
    vi.advanceTimersByTime(CAMERA_SAVE_MS)

    // A fresh page reads what was saved, each board its own.
    const later = createCameraMemory(storage)
    expect(later.recall(A)).toEqual({ x: 10, y: -20, zoom: 0.5 })
    expect(later.recall(B)).toEqual({ x: 1, y: 2, zoom: 2 })
    expect(later.recall('board_cccccccccccccccccccccccccc')).toBeNull()
  })

  it('saves once, 500 ms after the camera settles', () => {
    const storage = memoryStorage()
    const mem = createCameraMemory(storage)
    // A pan: a camera every frame for a second.
    for (let i = 0; i < 60; i++) {
      mem.remember(A, { x: i, y: 0, zoom: 1 })
      vi.advanceTimersByTime(16)
    }
    expect(storage.setItem).not.toHaveBeenCalled()
    // The last camera came 16 ms ago.
    vi.advanceTimersByTime(CAMERA_SAVE_MS - 16 - 1)
    expect(storage.setItem).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(storage.setItem).toHaveBeenCalledTimes(1)
    expect(JSON.parse(storage.data.get(cameraKey(A)) ?? 'null')).toEqual({ x: 59, y: 0, zoom: 1 })
  })

  it('flush saves what waits, and a waiting camera is the one recalled', () => {
    const storage = memoryStorage()
    const mem = createCameraMemory(storage)
    mem.remember(A, { x: 5, y: 5, zoom: 1 })
    expect(mem.recall(A)).toEqual({ x: 5, y: 5, zoom: 1 })
    mem.flush()
    expect(storage.setItem).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(CAMERA_SAVE_MS * 2)
    expect(storage.setItem).toHaveBeenCalledTimes(1)
  })

  it('a camera left closer than reading distance comes back at 2×, centred where it was', () => {
    // Saved at 4× before the closest zoom became 2×: the view's centre is the note being read.
    const raw = JSON.stringify({ x: 100, y: 50, zoom: 4 })
    const vp = { width: 1000, height: 800 }
    const mem = createCameraMemory(memoryStorage({ [cameraKey(A)]: raw }))
    // The centre (100 + 500 / 4, 50 + 400 / 4) = (225, 150) stays put at 2×.
    expect(mem.recall(A, vp)).toEqual({ x: 225 - 500 / 2, y: 150 - 400 / 2, zoom: ZOOM_MAX })
    // With no viewport to centre on, only the zoom is clamped.
    expect(mem.recall(A)).toEqual({ x: 100, y: 50, zoom: ZOOM_MAX })
    // A camera in range comes back as it was, whatever the viewport.
    const ok = createCameraMemory(memoryStorage({ [cameraKey(B)]: '{"x":1,"y":2,"zoom":1.5}' }))
    expect(ok.recall(B, vp)).toEqual({ x: 1, y: 2, zoom: 1.5 })
  })

  it('ignores unusable or unreadable memory, and a storage that throws', () => {
    for (const raw of [
      '{bad',
      'null',
      '7',
      '{"x":1,"y":2}',
      '{"x":1,"y":2,"zoom":0}',
      '{"x":"1","y":2,"zoom":1}',
    ]) {
      const mem = createCameraMemory(memoryStorage({ [cameraKey(A)]: raw }))
      expect(mem.recall(A)).toBeNull()
    }
    const throwing = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('quota')
      },
    }
    const mem = createCameraMemory(throwing)
    expect(mem.recall(A)).toBeNull()
    mem.remember(A, { x: 0, y: 0, zoom: 1 })
    expect(() => vi.advanceTimersByTime(CAMERA_SAVE_MS)).not.toThrow()
    expect(createCameraMemory(undefined).recall(A)).toBeNull()
  })
})
