import type { NoteImage, PaperStyle } from '@papertie/core'
import { useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { type AssetSize, assetUrl } from '../lib/assets'
import { PhotoContext } from './PhotoContext'
import type { PendingImage } from './pending'
import { variantFor, zoomBand } from './variant'
import './photos.css'

const dprNow = () =>
  typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1

function usePending(noteId: string) {
  const { pending } = useContext(PhotoContext)
  const subscribe = useCallback(
    (fn: () => void) => pending.subscribe(noteId, fn),
    [pending, noteId],
  )
  return useSyncExternalStore(subscribe, () => pending.get(noteId))
}

/**
 * The real image. The first file goes straight into the page (the browser loads and decodes it
 * off the main thread, and it fades in when loaded), unless a preview is under it: that stays
 * until the image has been decoded (`img.decode()`). A closer zoom swaps in a larger file only
 * once that is decoded too, and a farther one keeps the larger file it has. It re-renders only
 * when its file changes, not with the camera: it follows the zoom band, which changes a few
 * times over a whole zoom.
 */
function PhotoImage({
  assetId,
  lite,
  w,
  over,
  onReady,
}: {
  assetId: string
  lite: boolean
  w: number
  /** Laid over the preview it will replace, instead of in the flow. */
  over: boolean
  onReady(assetId: string): void
}) {
  const band = useSyncExternalStore(zoomBand.subscribe, zoomBand.get)
  const size: AssetSize = lite ? 256 : variantFor(band, dprNow(), w)
  const [shown, setShown] = useState<{ url: string; size: AssetSize } | null>(() =>
    over ? null : { url: assetUrl(assetId, size), size },
  )

  // Visible once decoded or loaded. One owner: a re-render (the preview going, `over` flipping)
  // never takes it back, and a fresh file for a larger variant swaps in without a fade.
  const [loaded, setLoaded] = useState(false)
  const announced = useRef(false)
  useEffect(() => {
    if (shown !== null && size <= shown.size) {
      if (!announced.current) {
        announced.current = true
        onReady(assetId)
      }
      return
    }
    const url = assetUrl(assetId, size)
    let live = true
    const img = new Image()
    img.src = url
    const arrive = () => {
      if (!live) return
      setShown({ url, size })
      setLoaded(true)
      onReady(assetId)
    }
    if (typeof img.decode === 'function') img.decode().then(arrive, () => {})
    else arrive()
    return () => {
      live = false
    }
  }, [assetId, size, shown, onReady])

  if (shown === null) return null
  return (
    <img
      className={over ? 'note-image photo-real photo-over' : 'note-image photo-real'}
      src={shown.url}
      onLoad={() => setLoaded(true)}
      data-loaded={loaded ? '' : undefined}
      alt=""
      decoding="async"
      draggable={false}
    />
  )
}

/** What a photo on its way says on its note, and the one thing it offers (a button). */
function Slip({ pending }: { pending: PendingImage }) {
  const { state, message } = pending
  if (state === 'uploading') {
    if (pending.committed) return null
    // No part-way value exists: the store has the file at once and then processes it, so the
    // line says only that the photo is being added (it moves; still under reduced motion).
    return (
      <span className="photo-progress" role="progressbar" aria-label="Adding photo">
        <i />
      </span>
    )
  }
  if (state === 'waiting') {
    return (
      <p className="photo-slip" role="status">
        Busy — trying again shortly
      </p>
    )
  }
  if (state === 'rejected') {
    return (
      <div className="photo-slip" role="alert">
        <span>{message}</span>
        <button type="button" className="photo-action" data-photo-action onClick={pending.remove}>
          <span className="photo-retry-act">Remove</span>
        </button>
      </div>
    )
  }
  return (
    <button
      type="button"
      className="photo-retry photo-slip"
      data-photo-action
      onClick={pending.retry}
    >
      {state === 'late' ? 'Still on its way — ' : 'Couldn’t upload — '}
      <span className="photo-retry-act">Retry</span>
    </button>
  )
}

/**
 * A note's photo. While it is added, its local preview (dimmed, with a thin ink line that
 * moves until it is stored, or what went wrong and what to do); then the real image, decoded, fades in over
 * the preview, which goes once it is there. A print with no photo and none on its way (one
 * whose upload never finished) is a quiet frame offering
 * `Add photo`. Only mounted for culled-visible notes, like the note.
 */
export function NotePhoto({
  noteId,
  image,
  style,
  lite,
  w,
  h,
}: {
  noteId: string
  image: NoteImage | null
  style: PaperStyle
  lite: boolean
  w: number
  h: number
}) {
  const { pick } = useContext(PhotoContext)
  const pending = usePending(noteId)
  // The asset whose real image is decoded and in the note.
  const [readyFor, setReadyFor] = useState<string | null>(null)
  const ready = image !== null && readyFor === image.assetId
  const release = pending?.committed ? pending.release : undefined
  useEffect(() => {
    if (ready && release !== undefined) release()
  }, [ready, release])

  // A replacement shows only its preview until the new image is in the note.
  const real = image !== null && !(pending !== undefined && !pending.committed)
  if (!real && pending === undefined) {
    if (image !== null || style !== 'print' || lite) return null
    return (
      <div className="photo photo-empty" style={{ aspectRatio: `${w} / ${h}` }}>
        <button
          type="button"
          className="photo-add"
          data-photo-action
          onClick={() => pick?.(noteId)}
        >
          Add photo
        </button>
      </div>
    )
  }
  return (
    <div
      className="photo"
      data-lite={lite || undefined}
      style={!ready && pending === undefined ? { aspectRatio: `${w} / ${h}` } : undefined}
    >
      {pending !== undefined && (
        <>
          <img
            className="note-image photo-preview"
            data-busy={pending.state === 'uploading' && !pending.committed ? '' : undefined}
            src={pending.url}
            alt=""
            decoding="async"
            draggable={false}
          />
          <Slip pending={pending} />
        </>
      )}
      {real && image !== null && (
        <PhotoImage
          key={image.assetId}
          assetId={image.assetId}
          lite={lite}
          w={w}
          over={pending !== undefined}
          onReady={setReadyFor}
        />
      )}
    </div>
  )
}
