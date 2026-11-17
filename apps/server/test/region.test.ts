import { type Asset, type Note, newId, type Op, type Yarn } from '@papertie/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { REGION_MAX_TILES, RegionIndex, TILE } from '../src/store/region'
import { createBoard, noteCreate, postOps, tabNow } from './helpers/boards'
import { blockCreate, blockRecord, bookCreate, bookRecord } from './helpers/books'
import type { TestUser } from './helpers/client'
import { FakeClock } from './helpers/clock'
import { startTestServer, type TestServer } from './helpers/harness'

const T0 = '2026-10-27T10:00:00.000Z'

let server: TestServer
let owner: TestUser
let board: string
let clientId: string
let seq: number
let revision: number

beforeEach(async () => {
  server = await startTestServer({ clock: new FakeClock(T0) })
  owner = server.user
  board = await createBoard(owner)
  clientId = tabNow(server)
  seq = 0
  revision = 0
})
afterEach(async () => {
  await server.close()
})

async function commit(ops: unknown[]): Promise<void> {
  const res = await postOps(owner, board, { clientId, seq: ++seq, baseRevision: revision, ops })
  if (res.status !== 200) throw new Error(`ops: ${res.status} ${await res.text()}`)
  revision = ((await res.json()) as { revision: number }).revision
}

function note(id: string, x: number, y: number, over: Record<string, unknown> = {}) {
  const op = noteCreate({ id, at: T0 })
  return { ...op, note: { ...op.note, x, y, ...over } }
}

function yarn(id: string, noteIds: string[], pins?: Yarn['pins']): Op {
  return {
    op: 'yarn.create',
    yarn: {
      type: 'yarn',
      id,
      noteIds,
      color: 'apricot',
      label: '',
      ...(pins ? { pins } : {}),
      createdAt: T0,
      updatedAt: T0,
    },
  }
}

type Line = Record<string, unknown> & { type: string; id?: string }

async function region(q: string): Promise<Line[]> {
  const res = await owner.request(`/api/boards/${board}/region?${q}`)
  if (res.status !== 200) throw new Error(`region: ${res.status} ${await res.text()}`)
  expect(res.headers.get('content-type')).toBe('application/x-ndjson; charset=utf-8')
  expect(res.headers.get('cache-control')).toBe('no-store')
  return (await res.text())
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Line)
}

const ids = (lines: Line[], type: string) =>
  lines
    .filter((l) => l.type === type)
    .map((l) => l.id)
    .sort()

/** The viewport the tests look through: one tile at the origin. */
const VIEW = `x0=0&y0=0&x1=${TILE}&y1=${TILE}`

describe('GET /api/boards/:id/region', () => {
  it('region returns the viewport’s notes and the threads that leave it', async () => {
    const asset: Asset = {
      type: 'asset',
      id: newId('asset'),
      mime: 'image/webp',
      width: 800,
      height: 600,
      bytes: 1234,
      sha256: 'b'.repeat(64),
      createdAt: T0,
    }
    const store = server.deps.store
    if (!store) throw new Error('no store')
    revision = (await store.submitServer(owner.id, board, [{ op: 'asset.add', asset }])).revision
    const unused: Asset = { ...asset, id: newId('asset') }
    revision = (await store.submitServer(owner.id, board, [{ op: 'asset.add', asset: unused }]))
      .revision

    const [inside, photo, edge, far, farther, alone] = [1, 2, 3, 4, 5, 6].map(() => newId('note'))
    const [leaving, shared, elsewhere] = [newId('yarn'), newId('yarn'), newId('yarn')]
    await commit([
      note(inside as string, 100, 100),
      note(photo as string, 2000, 3000, { image: { assetId: asset.id, frame: 'print' } }),
      // Its rect reaches into the viewport across the right edge.
      note(edge as string, TILE - 100, 500),
      note(far as string, 50_000, 0),
      note(farther as string, 90_000, 90_000),
      note(alone as string, -20_000, 0),
      // Leaves the viewport for `far`, tied at a pin it shares there with `shared`.
      yarn(leaving as string, [inside as string, far as string], { [far as string]: 'p' }),
      yarn(shared as string, [photo as string, far as string, farther as string], {
        [far as string]: 'p',
      }),
      // Touches no note in the viewport.
      yarn(elsewhere as string, [far as string, alone as string]),
    ])

    const lines = await region(VIEW)
    expect(lines[0]).toMatchObject({ type: 'board', id: board, revision })
    expect(lines.at(-1)).toEqual({ type: 'eof', revision })
    expect(ids(lines, 'note')).toEqual([inside, photo, edge].sort())
    expect(ids(lines, 'yarn')).toEqual([leaving, shared].sort())
    // Nothing of the threads' ends outside the viewport: the client draws a thread once all its
    // notes are in (it never drew one to a bare frame).
    expect(lines.some((l) => l.id === far || l.id === farther)).toBe(false)
    expect(lines.some((l) => l.type === 'frame')).toBe(false)
    // Threads come whole, pins and all.
    expect(lines.find((l) => l.id === shared)).toMatchObject({ pins: { [far as string]: 'p' } })
    // Only the photos the viewport's notes show.
    expect(ids(lines, 'asset')).toEqual([asset.id])
    // Every line is a record as the board holds it.
    const view = await store.read(owner.id, board)
    expect(lines.find((l) => l.id === photo)).toEqual(view.state.notes.get(photo as string))
    // Assets before the notes that use them, threads after their notes.
    const order = lines.map((l) => l.type)
    expect(order.lastIndexOf('asset')).toBeLessThan(order.indexOf('note'))
    expect(order.lastIndexOf('note')).toBeLessThan(order.indexOf('yarn'))
  })

  it('follows every commit: moved, resized, deleted and new notes', async () => {
    const [a, b, c] = [newId('note'), newId('note'), newId('note')]
    await commit([note(a, 100, 100), note(b, 50_000, 0)])
    expect(ids(await region(VIEW), 'note')).toEqual([a])

    await commit([{ op: 'note.update', id: b, set: { x: 200, y: 200 } }])
    expect(ids(await region(VIEW), 'note')).toEqual([a, b].sort())
    // Grown until it reaches the viewport from the left.
    await commit([note(c, -2000, 0), { op: 'note.update', id: c, set: { w: 2000 } }])
    expect(ids(await region(VIEW), 'note')).toEqual([a, b, c].sort())
    await commit([{ op: 'note.update', id: c, set: { w: 1000 } }])
    expect(ids(await region(VIEW), 'note')).toEqual([a, b].sort())
    await commit([{ op: 'note.delete', id: a }])
    expect(ids(await region(VIEW), 'note')).toEqual([b])
    const elsewhere = `x0=${-TILE}&y0=0&x1=-1&y1=${TILE}`
    expect(ids(await region(elsewhere), 'note')).toEqual([c])

    // The same after a restart (the index is built again from the loaded board).
    const dataDir = server.dataDir
    await server.deps.store?.close()
    const again = await startTestServer({ clock: new FakeClock(T0), dataDir })
    try {
      const res = await again.deps.store?.region(owner.id, board, {
        x0: 0,
        y0: 0,
        x1: TILE,
        y1: TILE,
      })
      const got = (res?.text ?? '')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Line)
      expect(ids(got, 'note')).toEqual([b])
    } finally {
      await again.close()
    }
  })

  it('region never names a book or block', async () => {
    const book = bookRecord()
    await commit([
      note(newId('note'), 10, 10),
      bookCreate(book),
      blockCreate(blockRecord(book.id, 'V', 'a sentence')),
    ])
    const lines = await region(VIEW)
    expect(lines.map((l) => l.type)).toEqual(['board', 'note', 'eof'])
    const text = JSON.stringify(lines)
    expect(text).not.toContain(book.id)
    expect(text).not.toContain('a sentence')
  })

  it('the area is capped at 64 tiles (4096² each); larger, inverted or malformed is 400', async () => {
    expect(TILE).toBe(4096)
    expect(REGION_MAX_TILES).toBe(64)
    const side = 8 * TILE
    expect(
      (await owner.request(`/api/boards/${board}/region?x0=0&y0=0&x1=${side}&y1=${side}`)).status,
    ).toBe(200)
    for (const q of [
      `x0=0&y0=0&x1=${side}&y1=${side + 1}`,
      `x0=0&y0=0&x1=${64 * TILE + 1}&y1=${TILE}`,
      `x0=10&y0=0&x1=0&y1=10`,
      `x0=0&y0=0&x1=10`,
      `x0=a&y0=0&x1=10&y1=10`,
      `x0=0&y0=0&x1=Infinity&y1=10`,
      `x0=0x10&y0=0&x1=10&y1=10`,
      `x0=0&y0=0&x1=1e400&y1=10`,
      `x0=&y0=0&x1=10&y1=10`,
      // No area, but a whole column of tiles.
      `x0=0&y0=-1000000&x1=0&y1=1000000`,
    ]) {
      const res = await owner.request(`/api/boards/${board}/region?${q}`)
      expect(res.status, q).toBe(400)
      expect(await res.json(), q).toEqual({ error: 'invalid' })
    }
    // Fractions and negative coordinates are fine.
    expect(
      (await owner.request(`/api/boards/${board}/region?x0=-10.5&y0=-3&x1=0.25&y1=7`)).status,
    ).toBe(200)
  })
})

describe('RegionIndex.build', () => {
  it('finds exactly what RegionIndex.of finds, for every rect', async () => {
    const at = '2026-10-27T10:00:00.000Z'
    const notes = new Map<string, Note>()
    // More than two of build's chunks, spread unevenly, some overlapping.
    for (let i = 0; i < 10_000; i++) {
      const id = newId('note')
      const n = noteCreate({ id, at }).note as unknown as Note
      notes.set(id, {
        ...n,
        x: ((i * 7919) % 200_000) - 100_000,
        y: ((i * 104_729) % 150_000) - 75_000,
        w: 120 + (i % 7) * 100,
        h: 60 + (i % 5) * 150,
      })
    }
    const of = RegionIndex.of(notes)
    const built = await RegionIndex.build(notes)
    let found = 0
    for (let k = 0; k < 300; k++) {
      const x0 = ((k * 6151) % 220_000) - 110_000
      const y0 = ((k * 3571) % 160_000) - 80_000
      const r = { x0, y0, x1: x0 + 1 + ((k * 97) % 30_000), y1: y0 + 1 + ((k * 89) % 30_000) }
      const want = of.search(r).sort()
      expect(built.search(r).sort(), JSON.stringify(r)).toEqual(want)
      found += want.length
    }
    expect(found).toBeGreaterThan(300)
    // Both follow a commit the same way.
    const [first] = notes.keys()
    const moved = new Map(notes)
    moved.set(first as string, { ...(notes.get(first as string) as Note), x: 500_000, y: 500_000 })
    of.update(moved, [first as string])
    built.update(moved, [first as string])
    const far = { x0: 499_000, y0: 499_000, x1: 501_000, y1: 501_000 }
    expect(built.search(far)).toEqual(of.search(far))
    expect(built.search(far)).toEqual([first])
  })
})
