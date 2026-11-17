import {
  lazy,
  type MouseEvent,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { atIdle } from '../app/atIdle'
import { flushCameraMemory, recallCamera, rememberCamera } from '../app/cameraMemory'
import { usePrefs } from '../app/prefs'
import { navigate } from '../app/router'
import { type BoardSession, canvasHistory } from '../app/session'
import { FocusChip } from '../focus/FocusChip'
import { ImageDrop, loadUpload } from '../images/ImageDrop'
import { PhotoContext } from '../images/PhotoContext'
import { photoSpaceFor } from '../images/space'
import { setZoomBand } from '../images/variant'
import { devHooks } from '../lib/devHooks'
import { PerfHud } from '../perf/PerfHud'
import { PickerChunk } from '../search/LazyPicker'
import { SearchPalette } from '../search/SearchPalette'
import { releaseSearchIndex, searchIndexFor } from '../search/searchIndex'
import { closeSearch } from '../search/searchStore'
import { RecoveryNotice } from '../settings/RecoveryNotice'
import { offerUnsaved } from '../sync/offerUnsaved'
import { SyncSaveDot } from '../sync/SaveDot'
import { SyncNotices } from '../sync/SyncNotices'
import { EmptyHint } from '../ui/EmptyHint'
import { registerPhotoPicker } from '../ui/photoPicker'
import { Sidebar } from '../ui/Sidebar'
import { useNarrow } from '../ui/useNarrow'
import { YarnLayer } from '../yarn/YarnLayer'
import { type Camera, screenToWorld } from './Camera'
import { NoteLayer } from './NoteLayer'
import { CanvasRuntime } from './runtime'
import type { Point, Rect } from './types'
import './canvas.css'

/** `DEV_ROUTES` (app/router.ts), spelt out so a release build drops the import below. */
const DEV = import.meta.env.DEV === true || import.meta.env.VITE_DEV_ROUTES === '1'
/** The prototype's A/B strip: dev builds only, and loaded on demand. */
const Controls = DEV
  ? lazy(() => import('../dev/Controls').then((m) => ({ default: m.Controls })))
  : null

/**
 * The dev strip: on a dev board (`label`), on `?controls=1`, and wherever the perf HUD is open.
 * Dev builds only (`Controls` is null otherwise).
 */
function DevStrip({ label }: { label?: string }) {
  const hud = usePrefs((p) => p.hud)
  if (!Controls) return null
  const asked = new URLSearchParams(location.search).get('controls') === '1'
  if (label === undefined && !asked && !hud) return null
  return (
    <Suspense fallback={null}>
      <Controls board={label} />
    </Suspense>
  )
}

/**
 * The board canvas on `session`'s store. React renders the layer stack once and the notes;
 * everything that moves with the camera is driven by `CanvasRuntime` outside React. The first
 * camera fits `frame`, or every note when there is none. A server session adds the save dot (at
 * the sidebar's foot) and the notice slips, which follow the session's feed and never re-render
 * this tree. `label` names a local board in the dev strip, shown for local boards only. A server
 * board opens where the camera was left (`recallCamera`), else fitting every note;
 * the camera is saved once it rests, from its apply hook, never through React.
 */
export function CanvasView({
  session,
  label,
  frame,
  covered = false,
  books = false,
  sheet,
  beside,
  layout = 'full',
}: {
  session: BoardSession
  label?: string
  frame?: Rect
  /**
   * A sheet (Settings) lies over the board: the canvas and its overlays are dimmed and inert and
   * take no keys, while the sidebar, its save dot and the notice slips stay in use.
   */
  covered?: boolean
  /**
   * The sheet is a book sheet (the shelf, a book): under 768 px it fills the screen too, but the
   * mini-bar stays above it and in use (Books, Search, Settings and the save dot); `book`: a book.
   */
  books?: boolean | 'book'
  /**
   * The sheet lying over the board (Settings), drawn in the UI layer between the dimmed canvas and
   * the sidebar, so the sidebar, its save-dot popover and the notice slips stay above it and in
   * use. Under 768 px it fills the screen and holds them all inert.
   */
  sheet?: ReactNode
  /**
   * What lies beside the board (an open book), given the board's runtime: after the board
   * in one wrapper, in either layout, so a change of layout never remounts it. `split`: the board's
   * root shrinks beside it (the runtime resizes through its `ResizeObserver`); `full`: it lies over
   * the board, which is then `covered`.
   */
  beside?: (rt: CanvasRuntime | null) => ReactNode
  layout?: 'split' | 'full'
}) {
  const narrow = useNarrow()
  const hooks = devHooks()
  if (hooks) hooks.renders.canvasView = (hooks.renders.canvasView ?? 0) + 1

  const { store, sync, feed } = session
  const [runtime, setRuntime] = useState<CanvasRuntime | null>(null)
  const photos = useRef<ImageDrop | null>(null)
  const space = photoSpaceFor(session)
  const photoActions = useMemo(
    () => ({ pending: space.pending, pick: (id: string) => photos.current?.pick({ noteId: id }) }),
    [space],
  )
  const root = useRef<HTMLElement>(null)
  const cork = useRef<HTMLDivElement>(null)
  const world = useRef<HTMLDivElement>(null)
  const yarnCanvas = useRef<HTMLCanvasElement>(null)
  const pinCanvas = useRef<HTMLCanvasElement>(null)
  const overlay = useRef<HTMLDivElement>(null)
  const ui = useRef<HTMLDivElement>(null)
  // Read once, when the runtime is made: the frame only sets the first camera.
  const frameRef = useRef(frame ?? null)
  /** Whether a book's sheet lies over the board now: a runtime made under it starts so. */
  const underBook = useRef(false)
  underBook.current = covered && books === 'book'

  // Made once the board's first paint is in (a session opened on a book is open before it).
  const { opening: open } = session
  const painted = useSyncExternalStore(
    useCallback((fn: () => void) => open.onPainted(fn), [open]),
    () => open.painted,
  )

  useLayoutEffect(() => {
    if (!painted) return
    const r = root.current
    const c = cork.current
    const w = world.current
    const y = yarnCanvas.current
    const p = pinCanvas.current
    const o = overlay.current
    const u = ui.current
    if (!r || !c || !w || !y || !p || !o || !u) return
    const els = { root: r, cork: c, world: w, yarnCanvas: y, pinCanvas: p, overlay: o }
    const boardId = session.boardId
    // Where the board opened (its first paint was read for that camera), else where it was left.
    // A camera remembered closer than 2× is clamped about the middle of this viewport.
    const view = { width: r.clientWidth, height: r.clientHeight }
    const start = boardId === null ? null : (session.camera ?? recallCamera(boardId, view))
    const { opening } = session
    const rt = new CanvasRuntime(
      els,
      store,
      frameRef.current,
      canvasHistory(session),
      start,
      opening.open,
    )
    rt.coverByBook(underBook.current)
    setRuntime(rt)
    const offOpened = opening.subscribe(() => rt.opened())
    // Photos: paste, drop and the picker. Prints follow the camera's zoom band, not the camera.
    const drop = new ImageDrop({
      root: r,
      inputParent: u,
      session,
      toWorld: (x, y) => screenToWorld(rt.drawnCamera(), rt.toViewport(x, y)),
      placeNear: (w, h, placed) => rt.placeNear({ w, h }, placed),
    })
    photos.current = drop
    // A note whose photo is on its way, or a print waiting for one, is not an abandoned blank.
    rt.keepEmpty = (id) =>
      space.pending.has(id) || store.getState().notes.get(id)?.style === 'print'
    setZoomBand(rt.camera.get().zoom)
    const offZoom = rt.camera.onApply((cam) => setZoomBand(cam.zoom))
    // The sidebar's Photo, the mini-bar's and the P key open this board's picker: new photo
    // notes at the middle of the view. Local dev boards have no server to take the photo.
    const offPicker = session.boardId === null ? () => {} : registerPhotoPicker(() => drop.pick())
    // Remembered once per gesture, as the camera settles (`moving` falls): not for where it
    // opened, nor for a resize's refresh, which moves nothing.
    let wasMoving = false
    const offRemember =
      boardId === null
        ? () => {}
        : rt.camera.onApply((c) => {
            const moving = rt.camera.moving
            if (wasMoving && !moving) rememberCamera(boardId, c)
            wasMoving = moving
          })
    // iOS often skips `pagehide`; leaving the page hidden is the last sure moment.
    const onHidden = () => {
      if (document.visibilityState !== 'hidden') return
      // Mid-gesture the camera has not settled: it is saved as it stands.
      if (boardId !== null && wasMoving) rememberCamera(boardId, rt.camera.get())
      flushCameraMemory()
    }
    window.addEventListener('pagehide', flushCameraMemory)
    document.addEventListener('visibilitychange', onHidden)

    const h = devHooks()
    let offReady = () => {}
    let offPerf = () => {}
    if (h) {
      // The bench's perf hooks (and the bench boards they name) load only where the dev hooks are
      // on, never in a user's initial JS (guarded by `pnpm budget`); the page is ready once
      // they are in. Should their chunk fail to load, the page is never ready, and says why.
      let live = true
      let offHooks = () => {}
      const perf = import('../perf/perfHooks').then(
        (m) => {
          if (live) offHooks = m.installPerfHooks(rt)
          return true
        },
        (e: unknown) => {
          h.notReady = `perf hooks did not load: ${e instanceof Error ? e.message : String(e)}`
          console.error(h.notReady)
          return false
        },
      )
      offPerf = () => {
        live = false
        offHooks()
      }
      h.store = store
      h.session = session
      h.runtime = rt
      h.debug.camera = (): Camera => rt.camera.get()
      h.debug.setCamera = (c: Camera) => rt.camera.set(c)
      h.debug.screenToWorld = (p: Point): Point => screenToWorld(rt.camera.get(), p)
      h.debug.pinScreen = (id: string) => rt.pinScreen(id)
      h.debug.attachScreen = (yarnId: string, seg: number, end: 'a' | 'b') =>
        rt.attachScreen(yarnId, seg, end)
      h.debug.yarnPointScreen = (id: string, seg: number, t: number) =>
        rt.yarnPointScreen(id, seg, t)
      h.debug.yarnProbe = (id: string, seg: number, t: number, offsetPx: number) =>
        rt.yarnProbe(id, seg, t, offsetPx)
      h.debug.hitAt = (p: Point) => rt.hitTest(p)
      h.debug.selectedYarn = () => rt.selectedYarnId
      h.debug.stats = () => rt.yarnStats
      h.debug.createYarn = (a: string, b: string) => rt.yarnFlows.tie(a, b).yarnId
      h.debug.deleteYarn = (id: string) => rt.yarnFlows.untie(id)
      h.debug.motion = () => ({
        awakeCount: rt.motion.awakeCount,
        activeAnimations: rt.motion.activeAnimations,
      })
      h.debug.drawInProgress = (id: string) => rt.motion.progressOf(id)
      h.debug.focusCamera = (id: string, zoom: number) => rt.focusNote(id, zoom)
      h.debug.anchor = (): Point => rt.anchor
      h.debug.lod = () => rt.lod
      h.debug.tied = () => ({ computed: rt.tied.computed, spentMs: rt.tied.spentMs })
      h.debug.notesRect = () => rt.notesRect()
      h.debug.noteAt = (w: Point) => rt.noteAt(w)
      h.debug.pyramid = () => rt.pyramidState
      h.debug.holdPyramid = (on: boolean) => rt.holdPyramid(on)
      h.debug.setPyramidAbove = (n: number) => {
        rt.pyramidAbove = n
        rt.requestYarn()
      }
      offReady = rt.camera.onApply(() => {
        offReady()
        void perf.then((loaded) => {
          if (live && loaded) h.ready = true
        })
      })
    }
    return () => {
      offOpened()
      offRemember()
      window.removeEventListener('pagehide', flushCameraMemory)
      document.removeEventListener('visibilitychange', onHidden)
      flushCameraMemory()
      offReady()
      offPerf()
      offZoom()
      offPicker()
      drop.dispose()
      photos.current = null
      rt.dispose()
      if (h) h.ready = false
    }
  }, [store, session, space, painted])

  // Under a book's sheet the far view's card overview is not drawn (the runtime's `coverByBook`).
  useEffect(() => {
    runtime?.coverByBook(covered && books === 'book')
  }, [runtime, covered, books])

  // The board's search index starts as the board opens (its worker loads the notes while the page
  // is idle), so ⌘K, Connect to… and Bring in… find it warm; it stops with the board.
  // The picker those open in comes in at idle too, and so does the upload code photos need.
  useEffect(() => {
    const index = searchIndexFor(store)
    const h = devHooks()
    if (h) h.debug.searchTimes = () => [...index.times]
    const offPicker = atIdle(() => void PickerChunk.load().catch(() => undefined))
    const offUpload = atIdle(() => void loadUpload().catch(() => undefined))
    return () => {
      offPicker()
      offUpload()
      releaseSearchIndex(store)
    }
  }, [store])

  // The layers under a sheet are held with `inert` (the sidebar's and the notices' are not).
  useEffect(() => {
    const r = root.current
    const u = ui.current
    if (!covered || !r || !u) return
    closeSearch()
    const held: Element[] = []
    const hold = (el: Element) => {
      if (el.hasAttribute('inert')) return
      el.setAttribute('inert', '')
      held.push(el)
    }
    for (const el of r.children) if (el !== u) hold(el)
    // The sidebar and the notices stay in use beside the sheet; under it, full screen, they do not.
    // The save dot's live region speaks under either.
    const kept =
      narrow && !books
        ? '.settings-veil, .sync-live'
        : '.sidebar, .minibar, .sync-notices, .settings-veil, .books-veil, .chunk-failed, .sync-live, .save-pop, .picker-sheet'
    for (const el of u.children) if (!el.matches(kept)) hold(el)
    return () => {
      for (const el of held) el.removeAttribute('inert')
    }
  }, [covered, narrow, books])

  // Under a sheet, a tool or command of the sidebar closes it, then acts (Settings' and Books'
  // own buttons, the save dot, the mark that folds the panel and the writer's tools, which act
  // on the book, keep their own say).
  const closeSheetFirst = (e: MouseEvent<HTMLDivElement>) => {
    if (!covered || !(e.target instanceof Element)) return
    const button = e.target.closest('button')
    if (!button?.closest('.sidebar, .minibar')) return
    if (
      button.closest('.sidebar-foot, .minibar-foot, .picker-sheet, [data-writing]') ||
      button.matches('.sidebar-mark, [data-settings], [data-books]')
    )
      return
    navigate({ name: 'board' })
  }

  return (
    <div
      className="board-split"
      data-layout={layout}
      data-book={beside === undefined ? undefined : ''}
    >
      <main
        className="viewport"
        data-testid="canvas"
        aria-label="Board"
        data-covered={covered || undefined}
        ref={root}
      >
        {/* First in the DOM, so Tab reaches the sidebar before it walks the notes; every layer has
          its own z-index, so where it sits in the DOM does not change what is painted over what. */}
        <div className="ui" ref={ui} onClickCapture={closeSheetFirst}>
          <EmptyHint store={store} opening={session.opening} />
          <Sidebar
            onNewNote={(design) => runtime?.createNoteAtCentre(design)}
            selection={runtime}
            boardId={session.boardId}
            books={covered && books}
            foot={
              sync && (
                <SyncSaveDot
                  feed={feed}
                  unsaved={() => sync.unsavedJsonl()}
                  unsavedParts={() => sync.unsavedParts()}
                />
              )
            }
          />
          {sync && (
            <SyncNotices
              feed={feed}
              onDownload={() => void offerUnsaved(sync.unsavedJsonl(), sync.unsavedParts())}
            >
              {/* Stacked with the slips at the foot (column-reverse: lowest), never over the top
                row of notes; under a full-screen sheet it waits, its state kept. */}
              <RecoveryNotice session={session} hidden={covered && narrow} />
            </SyncNotices>
          )}
          <DevStrip label={label} />
          {runtime && <FocusChip runtime={runtime} store={store} />}
          <SearchPalette runtime={runtime} store={store} />
          <YarnLayer runtime={runtime} store={store} />
          <PerfHud runtime={runtime} />
          {sheet}
        </div>
        <div className="cork" ref={cork} />
        <div className="world" ref={world}>
          {runtime && (
            <PhotoContext.Provider value={photoActions}>
              <NoteLayer runtime={runtime} store={store} />
            </PhotoContext.Provider>
          )}
        </div>
        <canvas className="yarn-layer" ref={yarnCanvas} />
        <canvas className="pin-layer" ref={pinCanvas} />
        <div className="overlay" ref={overlay} />
      </main>
      {beside?.(runtime)}
    </div>
  )
}
