import { type ClientOp, LIMITS, type Note, OpError } from '@papertie/core'
import { assetUrl, uploadAsset } from '../api/assets'
import { ApiError } from '../api/http'
import type { BoardSession } from '../app/session'
import type { Point, Rect } from '../canvas/types'
import { primeTone } from '../lib/imageTone'
import { clampCoord, LABELS, noteIdAt, photoKey, topZOf } from '../notes/noteCommands'
import type { BoardStore } from '../store/boardStore'
import { type Analysis, analyzeImage } from './analyze'
import { heicToJpeg, isHeic } from './heic'
import type { PendingImage } from './pending'
import { couldNotAdd, STAGGER, tell } from './photoNotice'
import { type PhotoSpace, photoSpaceFor } from './space'
import { variantFor, zoomBand } from './variant'

/** The largest file the server takes (25 MB). */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024

/** A photo note's long edge (world px), before the note limits. */
export const LONG_EDGE = 320

export { STAGGER }

/** How long the uploaded asset may take to reach the board (the server's event) before Retry. */
const ASSET_WAIT_MS = 15_000

/** A committed preview stays under its note this long, should no note ever show the real image. */
const RELEASE_AFTER_MS = 3_000

/** How many times in a row a `Retry-After` is waited out before the photo asks for a Retry. */
const MAX_WAITS = 3

const ACCEPTED: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
  'image/gif',
])

const BY_EXTENSION: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
}

/**
 * Where photos go: a world point they are centred on (where they were dropped), or a note whose
 * image is replaced. A point with `free` was only the middle of the view (a paste, the picker):
 * `free` says where a print of that size has room near it (`CanvasRuntime.placeNear`), minding
 * the prints of the same paste `placed` before it.
 */
export type FreeSpot = (w: number, h: number, placed: readonly Rect[]) => Point
export type PhotoTarget = (Point & { free?: FreeSpot }) | { noteId: string }

/** What `addImages` leans on, replaceable in tests (a browser has them all). */
export interface ImageDeps {
  upload: typeof uploadAsset
  heic(file: File): Promise<File | null>
  /** Size, tone and a small preview of an image; null when it cannot be decoded. */
  measure(blob: Blob): Promise<Analysis | null>
  createUrl(blob: Blob): string
  revokeUrl(url: string): void
  /** Have the browser fetch and decode the real image, so the note shows it at once. */
  warm(url: string): Promise<void>
  /** Wait `ms`; ends early, quietly, when `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>
  assetWaitMs: number
  releaseAfterMs: number
}

export const MESSAGES = {
  local: 'Photos can’t be added to a demo board.',
  unsupported: (name: string) =>
    `${name} isn’t a supported image — use JPEG, PNG, WebP, AVIF or GIF.`,
  tooBig: (name: string) => `${name} is over 25 MB — try a smaller photo.`,
  heic: (name: string) =>
    `This browser can’t open ${name} — save it as a JPEG first, or try Safari.`,
  failed: couldNotAdd,
  /** Refused by the server, whatever is tried again. */
  tooLarge: 'This photo is too large for the board.',
  unreadable: 'This file couldn’t be read as a photo.',
  refused: 'Your board can’t take photos right now.',
} as const

async function warmImage(url: string): Promise<void> {
  if (typeof Image !== 'function') return
  const img = new Image()
  img.src = url
  try {
    await img.decode()
  } catch {
    // The note's own image reports a failure; nothing to wait for.
  }
}

const defaults: ImageDeps = {
  upload: uploadAsset,
  heic: heicToJpeg,
  measure: analyzeImage,
  createUrl: (b) => URL.createObjectURL(b),
  revokeUrl: (u) => URL.revokeObjectURL(u),
  warm: warmImage,
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
    }),
  assetWaitMs: ASSET_WAIT_MS,
  releaseAfterMs: RELEASE_AFTER_MS,
}

/** What a file is, by its type or, when the browser gave none, its extension. */
function kindOf(file: Pick<File, 'type' | 'name'>): 'heic' | 'image' | null {
  if (isHeic(file)) return 'heic'
  const type = file.type.toLowerCase()
  if (ACCEPTED.has(type)) return 'image'
  if (type === '') {
    const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
    if (ACCEPTED.has(BY_EXTENSION[ext] ?? '')) return 'image'
  }
  return null
}

/** A note's size from the image's aspect: its long edge `LONG_EDGE`, within the note limits. */
export function noteSizeFor(width: number, height: number): { w: number; h: number } {
  const aspect = width > 0 && height > 0 ? width / height : 1
  const w = aspect >= 1 ? LONG_EDGE : Math.round(LONG_EDGE * aspect)
  const h = aspect >= 1 ? Math.round(LONG_EDGE / aspect) : LONG_EDGE
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
  return {
    w: clamp(w, LIMITS.noteMinW, LIMITS.noteMaxW),
    h: clamp(h, LIMITS.noteMinH, LIMITS.noteMaxH),
  }
}

/** Resolves true once the board holds `assetId` (the server's `asset.add` arrives by its event). */
function assetOnBoard(
  store: BoardStore,
  assetId: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  if (store.getState().assets.has(assetId)) return Promise.resolve(true)
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = (ok: boolean) => {
      off()
      clearTimeout(timer)
      signal.removeEventListener('abort', giveUp)
      resolve(ok)
    }
    const giveUp = () => done(false)
    const off = store.subscribe((s) => {
      if (s.assets.has(assetId)) done(true)
    })
    signal.addEventListener('abort', giveUp, { once: true })
    timer = setTimeout(() => done(false), timeoutMs)
  })
}

const dpr = () =>
  typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1

interface Job {
  session: BoardSession
  space: PhotoSpace
  boardId: string
  noteId: string
  file: Blob
  deps: ImageDeps
  ctl: AbortController
  /** The coalesce key of this photo's commits (and its drop's). */
  key: string
  /** The note was made for this photo: its image lands outside the undo history. */
  created: boolean
  /** The asset, once the server has it: a Retry after that only waits for it and commits. */
  uploaded: string | null
  tone: string | undefined
}

/**
 * Commit the image onto the note; false if the note is gone (deleted or undone meanwhile).
 * For a note made for the photo the commit is not an undo step of its own: undoing the note's
 * creation takes the image with it, and redoing it brings the note back with its image.
 */
function commitImage(job: Job): boolean {
  const { store } = job.session
  const note = store.getState().notes.get(job.noteId)
  if (note === undefined || job.uploaded === null) return false
  const op: ClientOp = {
    op: 'note.update',
    id: job.noteId,
    set: { image: { assetId: job.uploaded, frame: note.image?.frame ?? 'print' } },
  }
  store.commit([op], {
    coalesceKey: job.key,
    label: LABELS.photo,
    ...(job.created ? { undo: 'skip' as const } : {}),
  })
  return true
}

/** The refusal the server makes of a file that will be refused again, in calm words. */
function refusal(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null
  if (e.status === 413) return MESSAGES.tooLarge
  if (e.status === 400 || e.status === 415 || e.status === 422) return MESSAGES.unreadable
  if (e.status === 403 || e.status === 404) return MESSAGES.refused
  return null
}

/** Send the file; a `Retry-After` is waited out in full and the send tried again by itself. */
async function send(job: Job, set: (f: Partial<PendingImage>) => void): Promise<void> {
  const { deps, ctl } = job
  for (let waits = 0; ; waits++) {
    try {
      const { asset } = await job.space.uploads(() =>
        deps.upload(job.boardId, job.file, { signal: ctl.signal }),
      )
      job.uploaded = asset.id
      if (job.tone !== undefined) primeTone(asset.id, job.tone)
      return
    } catch (e) {
      const wait = e instanceof ApiError ? e.retryAfterMs : null
      if (ctl.signal.aborted || wait === null || waits >= MAX_WAITS) throw e
      set({ state: 'waiting' })
      await deps.sleep(wait, ctl.signal)
      if (ctl.signal.aborted) throw e
      set({ state: 'uploading' })
    }
  }
}

async function transmit(job: Job): Promise<void> {
  const { noteId, deps, ctl, space } = job
  const { store } = job.session
  const set = (fields: Partial<PendingImage>) => space.pending.patch(noteId, fields)
  set({ state: 'uploading' })
  try {
    if (job.uploaded === null) await send(job, set)
    const arrived = await assetOnBoard(store, job.uploaded as string, deps.assetWaitMs, ctl.signal)
    if (ctl.signal.aborted) return
    if (!arrived) {
      set({ state: 'late' })
      return
    }
    // Fetch and decode the real image first, so the swap below shows it at once.
    const note = store.getState().notes.get(noteId)
    if (note !== undefined) {
      const size = variantFor(zoomBand.get(), dpr(), note.w)
      await deps.warm(assetUrl(job.uploaded as string, size))
    }
    if (ctl.signal.aborted) return
    if (!commitImage(job)) {
      space.pending.get(noteId)?.release()
      return
    }
    set({ committed: true })
    // Normally the note lets go once the real image is decoded; this is for one nobody is looking at.
    setTimeout(() => space.pending.get(noteId)?.release(), deps.releaseAfterMs)
  } catch (e) {
    if (ctl.signal.aborted) return
    if (store.getState().notes.get(noteId) === undefined) {
      // The note was deleted or undone while its photo travelled: nothing is left to show it on.
      space.pending.get(noteId)?.release()
      return
    }
    const message = refusal(e)
    set(message === null ? { state: 'failed' } : { state: 'rejected', message })
  }
}

/** One photo made ready: converted if HEIC, analysed once and previewed. Null if it cannot be used. */
async function prepare(
  session: BoardSession,
  original: File,
  deps: ImageDeps,
  alive: () => boolean,
): Promise<{ file: Blob; url: string; width: number; height: number; tone?: string } | null> {
  let file: Blob = original
  if (isHeic(original)) {
    const jpeg = await deps.heic(original)
    if (!alive()) return null
    if (jpeg === null) {
      tell(session, MESSAGES.heic(original.name))
      return null
    }
    if (jpeg.size > MAX_UPLOAD_BYTES) {
      tell(session, MESSAGES.tooBig(original.name))
      return null
    }
    file = jpeg
  }
  const a = await deps.measure(file)
  if (!alive()) return null
  if (a === null || !(a.width > 0) || !(a.height > 0)) {
    tell(session, MESSAGES.unsupported(original.name))
    return null
  }
  const url = deps.createUrl(a.preview ?? file)
  return { file, url, width: a.width, height: a.height, ...(a.tone ? { tone: a.tone } : {}) }
}

/**
 * Add photos to the board.
 *
 * Each file that is a supported type and at most 25 MB (HEIC is converted first, where the
 * browser can decode it) gets a note at once: a `print` note shaped like the photo (long edge
 * 320), showing the photo from a local preview while it uploads. The preview, its state and
 * a failure live in the session's photo space, not in the board. When the server has the asset,
 * the note takes `image: {assetId, frame: 'print'}` and the preview goes. A failure keeps the
 * note and says what happened (`Couldn't upload — Retry`, or why a file is refused). Several
 * files are staggered by (+28, +28) from the point. The notes of one drop are one undo step,
 * and their images are not steps of their own.
 *
 * With `{noteId}` the first file puts its image on that note (only `image` changes). A local
 * board has nowhere to keep a photo: it says so and does nothing.
 */
export async function addImages(
  session: BoardSession,
  files: readonly File[],
  at: PhotoTarget,
  overrides: Partial<ImageDeps> = {},
): Promise<void> {
  if (files.length === 0) return
  const deps = { ...defaults, ...overrides }
  const { boardId, store } = session
  if (boardId === null) {
    tell(session, MESSAGES.local)
    return
  }
  const replacing = 'noteId' in at ? at.noteId : null
  if (replacing !== null && !store.getState().notes.has(replacing)) return

  // Judge every file first, synchronously: nothing is sent for one that cannot be.
  const accepted: File[] = []
  for (const file of files) {
    if (replacing !== null && accepted.length === 1) break
    if (kindOf(file) === null) tell(session, MESSAGES.unsupported(file.name))
    else if (file.size > MAX_UPLOAD_BYTES) tell(session, MESSAGES.tooBig(file.name))
    else accepted.push(file)
  }
  if (accepted.length === 0) return

  const space = photoSpaceFor(session)
  // The canvas going (dispose) ends everything this call has not yet put on the board.
  const generation = space.generation
  const alive = () => space.generation === generation
  // One walk over the notes per drop, not per photo.
  let z = replacing === null ? topZOf(store.getState()) : 0
  // The prints of this paste placed so far, for the next one's free spot.
  const placed: Rect[] = []
  const dropKey = photoKey(replacing ?? noteIdAt(store.now()))
  const started: Promise<void>[] = []

  await Promise.all(
    accepted.map(async (original, slot) => {
      const ready = await space.prepares(() => prepare(session, original, deps, alive))
      if (ready === null) return
      const { file, url, width, height, tone } = ready
      if (!alive()) {
        deps.revokeUrl(url)
        return
      }
      let noteId: string
      if (replacing !== null) {
        if (!store.getState().notes.has(replacing)) {
          deps.revokeUrl(url)
          return
        }
        noteId = replacing
      } else {
        const { w, h } = noteSizeFor(width, height)
        const target = at as Point & { free?: FreeSpot }
        // A free spot of its own for each print; a drop point staggers the rest from it.
        const point = target.free?.(w, h, placed) ?? target
        const stagger = target.free === undefined ? slot * STAGGER : 0
        placed.push({ x: point.x - w / 2, y: point.y - h / 2, w, h })
        const now = store.now()
        const note: Note = {
          type: 'note',
          id: noteIdAt(now),
          x: clampCoord(Math.round(point.x - w / 2 + stagger), w),
          y: clampCoord(Math.round(point.y - h / 2 + stagger), h),
          w,
          h,
          z: ++z,
          paper: 'cream',
          style: 'print',
          text: '',
          image: null,
          createdAt: now,
          updatedAt: now,
        }
        noteId = note.id
        try {
          store.commit([{ op: 'note.create', note }], { coalesceKey: dropKey, label: LABELS.photo })
        } catch (e) {
          if (!(e instanceof OpError)) throw e
          deps.revokeUrl(url)
          tell(session, MESSAGES.failed(original.name))
          return
        }
      }
      space.drop(noteId)
      const job: Job = {
        session,
        space,
        boardId,
        noteId,
        file,
        deps,
        ctl: space.begin(noteId),
        key: dropKey,
        created: replacing === null,
        uploaded: null,
        tone,
      }
      let released = false
      space.pending.set(noteId, {
        url,
        state: 'uploading',
        committed: false,
        retry: () => void transmit(job),
        remove: () => {
          space.drop(noteId)
          if (job.created && store.getState().notes.has(noteId)) {
            store.commit([{ op: 'note.delete', id: noteId }], { label: LABELS.delete })
          }
        },
        release: () => {
          if (released) return
          released = true
          if (space.pending.get(noteId)?.url === url) space.pending.delete(noteId)
          space.end(noteId, job.ctl)
          deps.revokeUrl(url)
        },
      })
      started.push(transmit(job))
    }),
  )
  await Promise.all(started)
}
