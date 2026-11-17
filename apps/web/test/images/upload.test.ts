import { type Asset, emptyBoardState, type Note } from '@papertie/core'
import { ApiError } from '../../src/api/http'
import { type BoardSession, openLocalSession, stepHistory } from '../../src/app/session'
import {
  addImages,
  type ImageDeps,
  LONG_EDGE,
  MAX_UPLOAD_BYTES,
  MESSAGES,
} from '../../src/images/upload'
import { BOARD_ID, T0 } from '../helpers/fakeServer'
import { file, harness, pendingOf, session } from '../helpers/photos'

const afterTimers = () => new Promise((r) => setTimeout(r, 5))
const notices = (s: BoardSession) => s.feed.getState().notices.map((n) => n.message)
const allNotes = (s: BoardSession): Note[] => [...s.store.getState().notes.values()]

describe('addImages', () => {
  it('makes a staggered print note per file at once, then puts each image on its note', async () => {
    const s = session()
    let release: () => void = () => {}
    const gateOpen = new Promise<void>((r) => {
      release = r
    })
    const h = harness(s, () => gateOpen)
    const done = addImages(
      s,
      [file('a.jpg'), file('b.jpg'), file('c.jpg')],
      { x: 1000, y: 500 },
      h.deps,
    )
    await afterTimers()
    // Before any upload ends: three notes, in the board with no image, each with a preview.
    const notes = allNotes(s).sort((p, q) => p.z - q.z)
    expect(notes).toHaveLength(3)
    expect(notes.every((n) => n.image === null && n.style === 'print' && n.text === '')).toBe(true)
    expect(pendingOf(s).size).toBe(3)
    // Sized by aspect (long edge 320), centred on the drop point and staggered by 28.
    const landscape = notes.find((n) => n.w === LONG_EDGE && n.h === 240)
    const portrait = notes.find((n) => n.w === 240 && n.h === LONG_EDGE)
    expect(landscape).toBeDefined()
    expect(portrait).toBeDefined()
    const xs = notes.map((n) => n.x + n.w / 2).sort((p, q) => p - q)
    const ys = notes.map((n) => n.y + n.h / 2).sort((p, q) => p - q)
    expect(xs).toEqual([1000, 1028, 1056])
    expect(ys).toEqual([500, 528, 556])
    expect(new Set(notes.map((n) => n.z)).size).toBe(3)

    release()
    await done
    await afterTimers()
    const after = allNotes(s)
    expect(after.every((n) => n.image?.frame === 'print')).toBe(true)
    expect(new Set(after.map((n) => n.image?.assetId)).size).toBe(3)
    expect(pendingOf(s).size).toBe(0)
    expect(h.revoked.sort()).toEqual(['blob:fake/1', 'blob:fake/2', 'blob:fake/3'])
  })

  it('without a drop point, asks where each print has room, minding the ones placed before it', async () => {
    const s = session()
    const h = harness(s)
    const placedSeen: number[] = []
    await addImages(
      s,
      [file('a.jpg'), file('b.jpg')],
      {
        x: 1000,
        y: 500,
        free: (_w, _h, placed) => {
          placedSeen.push(placed.length)
          return { x: 300 + placed.length * 500, y: 200 }
        },
      },
      h.deps,
    )
    await afterTimers()
    const xs = allNotes(s)
      .map((n) => n.x + n.w / 2)
      .sort((p, q) => p - q)
    // Each at its own spot (no stagger from the first), the second told where the first went.
    expect(placedSeen.sort()).toEqual([0, 1])
    expect(xs).toEqual([300, 800])
  })

  it('keeps the note with a retry when the upload fails, and retry succeeds', async () => {
    const s = session()
    let failing = true
    const h = harness(s, async () => {
      if (failing) throw new ApiError(0, 'network')
    })
    await addImages(s, [file('a.jpg')], { x: 0, y: 0 }, h.deps)
    const [n] = allNotes(s)
    expect(n?.image).toBeNull()
    const p = pendingOf(s).get(n?.id as string)
    expect(p?.state).toBe('failed')
    expect(h.revoked).toEqual([]) // the preview stays for the retry

    failing = false
    p?.retry()
    await afterTimers()
    await afterTimers()
    expect(s.store.getState().notes.get(n?.id as string)?.image).not.toBeNull()
    expect(pendingOf(s).get(n?.id as string)).toBeUndefined()
    expect(h.uploads).toEqual(['a.jpg', 'a.jpg'])
    expect(h.revoked).toEqual(['blob:fake/1'])
  })

  it('waits for the asset to reach the board, and a retry then commits without uploading again', async () => {
    const s = session()
    const h = harness(s)
    const upload = h.deps.upload as NonNullable<ImageDeps['upload']>
    let late: Asset | undefined
    h.deps.upload = async (b, f, o) => {
      const before = s.store.getState()
      const r = await upload(b, f, o)
      late = r.asset
      s.store.replace(before) // the server's event has not come yet
      return r
    }
    await addImages(s, [file('a.jpg')], { x: 0, y: 0 }, h.deps)
    const noteId = allNotes(s)[0]?.id as string
    expect(pendingOf(s).get(noteId)?.state).toBe('late')
    expect(s.store.getState().notes.get(noteId)?.image).toBeNull()

    const now = s.store.getState()
    s.store.replace({ ...now, assets: new Map(now.assets).set((late as Asset).id, late as Asset) })
    pendingOf(s).get(noteId)?.retry()
    await afterTimers()
    await afterTimers()
    expect(h.uploads).toEqual(['a.jpg'])
    expect(s.store.getState().notes.get(noteId)?.image?.assetId).toBe((late as Asset).id)
  })

  it('rejects a 30 MB file before any request, with a notice', async () => {
    const s = session()
    const h = harness(s)
    await addImages(s, [file('big.jpg', 'image/jpeg', 30 * 1024 * 1024)], { x: 0, y: 0 }, h.deps)
    expect(h.uploads).toEqual([])
    expect(allNotes(s)).toHaveLength(0)
    expect(notices(s)).toEqual([MESSAGES.tooBig('big.jpg')])
    expect(MAX_UPLOAD_BYTES).toBe(25 * 1024 * 1024)
  })

  it('says an unsupported type is not supported, and sends nothing', async () => {
    const s = session()
    const h = harness(s)
    await addImages(s, [file('notes.pdf', 'application/pdf')], { x: 0, y: 0 }, h.deps)
    expect(h.uploads).toEqual([])
    expect(notices(s)).toEqual([
      'notes.pdf isn’t a supported image — use JPEG, PNG, WebP, AVIF or GIF.',
    ])
  })

  it('takes a file by its extension when the browser gave no type', async () => {
    const s = session()
    const h = harness(s)
    await addImages(s, [file('a.jpg', '')], { x: 0, y: 0 }, h.deps)
    expect(h.uploads).toEqual(['a.jpg'])
  })

  it('converts HEIC first, and says so when the browser cannot', async () => {
    const s = session()
    const h = harness(s)
    await addImages(s, [file('IMG_1.HEIC', 'image/heic')], { x: 0, y: 0 }, h.deps)
    expect(h.uploads).toEqual(['IMG_1.jpg'])

    const t = session()
    const g = harness(t)
    g.deps.heic = async () => null
    await addImages(t, [file('IMG_2.heic', '')], { x: 0, y: 0 }, g.deps)
    expect(g.uploads).toEqual([])
    expect(allNotes(t)).toHaveLength(0)
    expect(notices(t)).toEqual([MESSAGES.heic('IMG_2.heic')])
  })

  it('replaces the image on a note by committing only `image`', async () => {
    const s = session()
    const first = harness(s)
    await addImages(s, [file('a.jpg')], { x: 0, y: 0 }, first.deps)
    await afterTimers()
    const [n] = allNotes(s)
    const noteId = n?.id as string
    const oldAsset = n?.image?.assetId

    const commits: unknown[][] = []
    s.store.onCommit((_b, ops) => void commits.push([...ops]))
    const again = harness(s)
    await addImages(s, [file('b.jpg'), file('c.jpg')], { noteId }, again.deps)
    await afterTimers()

    expect(again.uploads).toEqual(['b.jpg']) // one photo replaces one image
    expect(allNotes(s)).toHaveLength(1)
    expect(commits).toHaveLength(1)
    const op = commits[0]?.[0] as { op: string; id: string; set: Record<string, unknown> }
    expect(commits[0]).toHaveLength(1)
    expect(op.op).toBe('note.update')
    expect(op.id).toBe(noteId)
    expect(Object.keys(op.set)).toEqual(['image'])
    const image = s.store.getState().notes.get(noteId)?.image
    expect(image?.frame).toBe('print')
    expect(image?.assetId).not.toBe(oldAsset)
  })

  it('shows the old image until the new one is in: no preview entry means none was ever hidden', async () => {
    const s = session()
    const h0 = harness(s)
    await addImages(s, [file('a.jpg')], { x: 0, y: 0 }, h0.deps)
    await afterTimers()
    const noteId = allNotes(s)[0]?.id as string
    let release: () => void = () => {}
    const h = harness(
      s,
      () =>
        new Promise<void>((r) => {
          release = r
        }),
    )
    const done = addImages(s, [file('b.jpg')], { noteId }, h.deps)
    await afterTimers()
    expect(pendingOf(s).get(noteId)?.committed).toBe(false)
    expect(s.store.getState().notes.get(noteId)?.image).not.toBeNull()
    release()
    await done
    expect(pendingOf(s).get(noteId)?.committed).toBe(true)
  })

  it('makes the note and its image one undo step', async () => {
    const s = session()
    const h = harness(s)
    await addImages(s, [file('a.jpg')], { x: 0, y: 0 }, h.deps)
    expect(allNotes(s)).toHaveLength(1)
    expect(s.undo.canUndo).toBe(true)
    stepHistory(s, 'undo')
    expect(allNotes(s)).toHaveLength(0)
    expect(s.undo.canUndo).toBe(false)
  })

  it('lets go quietly of a note deleted while its photo travelled', async () => {
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
    await afterTimers()
    const [n] = allNotes(s)
    s.store.commit([{ op: 'note.delete', id: n?.id as string }])
    release()
    await done
    expect(pendingOf(s).size).toBe(0)
    expect(h.revoked).toEqual(['blob:fake/1'])
    expect(allNotes(s)).toHaveLength(0)
  })

  it('does nothing on a local board but say so', async () => {
    const local = openLocalSession({
      kind: 'local',
      state: emptyBoardState(BOARD_ID, 'test', T0),
      label: 'test',
    })
    const h = harness(local)
    await addImages(local, [file('a.jpg')], { x: 0, y: 0 }, h.deps)
    expect(h.uploads).toEqual([])
    expect(allNotes(local)).toHaveLength(0)
    expect(notices(local)).toEqual([MESSAGES.local])
  })

  it('shows the photo as being added for the whole upload, with no part-way value', async () => {
    const s = session()
    const seen: unknown[] = []
    const h = harness(s, async () => {
      seen.push({ ...pendingOf(s).get(allNotes(s)[0]?.id as string) })
    })
    await addImages(s, [file('a.jpg')], { x: 0, y: 0 }, h.deps)
    expect(seen).toMatchObject([{ state: 'uploading', committed: false }])
    expect(seen[0]).not.toHaveProperty('progress')
  })

  it('never has more than three uploads in flight', async () => {
    const s = session()
    let live = 0
    let peak = 0
    const gates: Array<() => void> = []
    const h = harness(
      s,
      () =>
        new Promise<void>((r) => {
          peak = Math.max(peak, ++live)
          gates.push(() => {
            live--
            r()
          })
        }),
    )
    const done = addImages(
      s,
      ['a', 'b', 'c', 'd', 'e'].map((n) => file(`${n}.jpg`)),
      { x: 0, y: 0 },
      h.deps,
    )
    for (let i = 0; i < 20 && gates.length < 5; i++) {
      await afterTimers()
      gates.splice(0).forEach((g) => void g())
    }
    await done
    expect(peak).toBeLessThanOrEqual(3)
    expect(allNotes(s).every((n) => n.image !== null)).toBe(true)
  })
})
