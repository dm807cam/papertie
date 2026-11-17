import { type Asset, type BoardState, newId, type Op } from '@papertie/core'
import sharp from 'sharp'
import { CLUSTERED_LIFETIME, generateClusteredBoard } from './genBoard'
import { type Library, libraryOps } from './genBook'

/**
 * Seeding a board through Papertie's app: the clustered lifetime board with its photos, and a
 * library of books, sent as the page sends them (uploads, then ops in batches of 500).
 */

const BATCH_OPS = 500

/**
 * A way to Papertie's app: `fetch` hands it one request for `path` (`/api/…`) from an origin it
 * trusts for writes, and resolves with its answer.
 */
export interface Session {
  fetch(path: string, init?: RequestInit): Promise<Response>
}

/** One request, a string body sent as JSON. */
export function call(s: Session, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  if (typeof init.body === 'string') headers.set('Content-Type', 'application/json')
  return s.fetch(path, { ...init, headers })
}

const post = (s: Session, path: string, body: unknown) =>
  call(s, path, { method: 'POST', body: JSON.stringify(body) })

/** `count` generated photos (a seeded gradient with grain, 1600 × 1067 JPEG), uploaded. */
export async function uploadPhotos(s: Session, boardId: string, count: number): Promise<Asset[]> {
  const out: Asset[] = []
  for (let i = 0; i < count; i++) {
    const [w, h] = [1600, 1067]
    const px = Buffer.alloc(w * h * 3)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 3
        const grain = ((x * 7919 + y * 104_729 + i * 31) % 23) - 11
        px[o] = (90 + ((x * 120) / w + i * 37) + grain) & 255
        px[o + 1] = (110 + (y * 90) / h + grain) & 255
        px[o + 2] = (140 + ((x + y) * 60) / (w + h) - i * 11 + grain) & 255
      }
    }
    const jpeg = await sharp(px, { raw: { width: w, height: h, channels: 3 } })
      .jpeg({ quality: 85 })
      .toBuffer()
    const form = new FormData()
    form.set('file', new Blob([new Uint8Array(jpeg)], { type: 'image/jpeg' }), `photo-${i}.jpg`)
    const res = await call(s, `/api/boards/${boardId}/assets`, { method: 'POST', body: form })
    if (res.status !== 201) throw new Error(`upload: ${res.status} ${await res.text()}`)
    out.push(((await res.json()) as { asset: Asset }).asset)
  }
  return out
}

/** A client of one board: one tab id, rising seq, the last revision acked. */
export class BoardClient {
  readonly clientId = newId('tab', Date.now())
  seq = 0
  revision = 0
  constructor(
    readonly s: Session,
    readonly boardId: string,
  ) {}

  /** Send `ops` as one batch, and keep the revision its ack names. */
  async send(ops: readonly Op[]): Promise<void> {
    const body = { clientId: this.clientId, seq: ++this.seq, baseRevision: this.revision, ops }
    const res = await post(this.s, `/api/boards/${this.boardId}/ops`, body)
    if (res.status !== 200) throw new Error(`ops: ${res.status} ${await res.text()}`)
    this.revision = ((await res.json()) as { revision: number }).revision
  }
}

/**
 * A new board of the user's filled with the clustered lifetime board (`photos` uploaded photos
 * shown in turn by its photo notes), 500 ops a batch.
 */
export async function seedClustered(
  s: Session,
  photos = 12,
  board: { notes: number; yarns: number; seed: number } = CLUSTERED_LIFETIME,
): Promise<{ boardId: string; state: BoardState; client: BoardClient }> {
  const made = await post(s, '/api/boards', { name: 'My board' })
  if (made.status !== 201) throw new Error(`board: ${made.status} ${await made.text()}`)
  const boardId = ((await made.json()) as { id: string }).id
  const assets = await uploadPhotos(s, boardId, photos)
  const state = generateClusteredBoard({ ...board, photoAssets: assets })
  const client = new BoardClient(s, boardId)
  // The uploads committed `asset.add`s: the board's revision is theirs.
  const meta = await call(s, `/api/boards/${boardId}/meta`)
  client.revision = ((await meta.json()) as { revision: number }).revision
  const ops: Op[] = [
    ...[...state.notes.values()].map((note): Op => ({ op: 'note.create', note })),
    ...[...state.yarns.values()].map((yarn): Op => ({ op: 'yarn.create', yarn })),
  ]
  for (let i = 0; i < ops.length; i += BATCH_OPS) await client.send(ops.slice(i, i + BATCH_OPS))
  return { boardId, state, client }
}

/** Put `lib` on the client's board (`libraryOps`), 500 ops a batch. */
export async function seedLibrary(client: BoardClient, lib: Library): Promise<void> {
  const ops = libraryOps(lib)
  for (let i = 0; i < ops.length; i += BATCH_OPS) await client.send(ops.slice(i, i + BATCH_OPS))
}
