import type { BoardSession } from '../app/session'
import type { Point } from '../canvas/types'
import { reloadMessage } from '../sync/notices'
import { couldNotAdd, STAGGER, tell } from './photoNotice'
import { photoSpaceFor } from './space'
import type { FreeSpot, ImageDeps, PhotoTarget } from './upload'

type Upload = typeof import('./upload')

/**
 * The upload code (`upload.ts`, with HEIC and the image analysis) is a chunk of its own, which
 * the board's first paint never needs (room in the initial JS). It comes
 * in at idle once the board is up (`CanvasView`), or with the first photo before that; once in,
 * a photo is taken in the very event that brings it, as before.
 */
let upload: Upload | null = null
let loading: Promise<Upload> | null = null

/** Load the upload chunk (once; a failed load is tried again on the next call). */
export function loadUpload(): Promise<Upload> {
  loading ??= import('./upload').then(
    (m) => {
      upload = m
      return m
    },
    (e: unknown) => {
      loading = null
      throw e
    },
  )
  return loading
}

/** Whether the upload chunk is in (tests). */
export const uploadLoaded = (): boolean => upload !== null

/** What the file picker offers: the five formats the server takes, and HEIC where it can open it. */
const ACCEPT =
  'image/jpeg,image/png,image/webp,image/avif,image/gif,image/heic,image/heif,.heic,.heif'

export interface ImageDropOptions {
  /** The board's viewport element: drops land on it. */
  root: HTMLElement
  /** Where the hidden file input lives: the board's UI layer. The viewport when absent. */
  inputParent?: HTMLElement
  session: BoardSession
  /** A pointer position (client px) as a world point. */
  toWorld(clientX: number, clientY: number): Point
  /**
   * Where a print of `w` × `h` world px has room near the middle of the view, as a centre
   * (`CanvasRuntime.placeNear`): a paste or the picker puts its first photo there.
   */
  placeNear?: FreeSpot
  /** Test seam: what `addImages` leans on. */
  deps?: Partial<ImageDeps>
}

/** Whether the drag carries files (`types` may be missing, or a DOMStringList). */
const hasFiles = (dt: DataTransfer | null | undefined): boolean =>
  Array.from(dt?.types ?? []).includes('Files')

/** A field, or the note editor, takes what is pasted into it itself. */
function takesText(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  return (
    target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !==
    null
  )
}

/**
 * Photos get onto the board three ways, all ending in `addImages`:
 * - paste (a screenshot, or files copied in Finder) lands at the middle of the view;
 * - drag and drop lands at the pointer, the cork showing a fine ink line while files hang over it;
 *   dropped (or pasted, with the note focused) on a print that has no photo, a file fills it;
 * - a hidden file input, opened with {@link ImageDrop.pick} by the sidebar's Photo (new notes at
 *   the middle of the view) and by a print's `Add photo` (`{noteId}`: that note's image).
 *
 * Nothing here runs on a pan or a drag: the listeners are events of their own, and the
 * highlight is one attribute on the viewport.
 */
export class ImageDrop {
  private readonly input: HTMLInputElement
  private readonly off: Array<() => void> = []
  private target: PhotoTarget | null = null
  private depth = 0
  /** Drops and pastes waiting for the upload chunk: the board keeps its frame for files meanwhile. */
  private waiting = 0

  constructor(private readonly o: ImageDropOptions) {
    const { root, inputParent = root } = o
    const doc = root.ownerDocument
    this.input = doc.createElement('input')
    this.input.type = 'file'
    this.input.accept = ACCEPT
    this.input.hidden = true
    this.input.tabIndex = -1
    this.input.setAttribute('aria-hidden', 'true')
    this.input.dataset.testid = 'photo-input'
    inputParent.append(this.input)
    this.listen(this.input, 'change', this.onPicked)
    // A cancelled picker fires no change: forget what it was opened for.
    this.listen(this.input, 'cancel', () => {
      this.target = null
    })

    this.listen(root, 'dragenter', this.onDragOver)
    this.listen(root, 'dragover', this.onDragOver)
    this.listen(root, 'dragleave', this.onDragLeave)
    this.listen(root, 'drop', this.onDrop)
    this.listen(doc, 'paste', this.onPaste)
    // A note's photo buttons (Retry, Add photo, Remove) would lose their click to the board's
    // pointer capture (the press is the canvas's); catching the press before it gets there lets
    // the click through.
    this.listen(doc, 'pointerdown', this.onPress, true)
  }

  /**
   * Open the file picker. Without a target the photos become new notes at the middle of the
   * view; with `{noteId}` the chosen photo replaces that note's image.
   */
  pick(target?: PhotoTarget): void {
    // The chunk comes while the picker is open, if it is not in yet.
    void loadUpload().catch(() => undefined)
    this.target = target ?? null
    this.input.multiple = target === undefined || !('noteId' in target)
    this.input.value = ''
    this.input.click()
  }

  /** The canvas is going: stop listening, abort uploads in flight and let go of every preview. */
  dispose(): void {
    for (const fn of this.off.splice(0)) fn()
    photoSpaceFor(this.o.session).dispose()
    this.input.remove()
    this.waiting = 0
    this.o.root.removeAttribute('aria-busy')
    this.clearHighlight()
  }

  private listen<K extends string>(
    el: EventTarget,
    type: K,
    fn: (e: never) => void,
    capture = false,
  ): void {
    el.addEventListener(type, fn as EventListener, capture)
    this.off.push(() => el.removeEventListener(type, fn as EventListener, capture))
  }

  /** Inert (a screen lies over it) or covered (Settings), the board takes no photos. */
  private get inert(): boolean {
    return this.o.root.closest('[inert], [data-covered]') !== null
  }

  /** A file drag over a board that takes none: refused, and kept from opening in the tab. */
  private refuse(e: DragEvent): void {
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
  }

  /** The middle of the view, with where a photo of its size has room near it. */
  private center(): Point & { free?: FreeSpot } {
    const r = this.o.root.getBoundingClientRect()
    const c = this.o.toWorld(r.left + r.width / 2, r.top + r.height / 2)
    const near = this.o.placeNear
    return near === undefined ? c : { ...c, free: near }
  }

  private add(files: File[], at: PhotoTarget): void {
    const { session, deps } = this.o
    if (upload !== null) {
      void upload.addImages(session, files, at, deps)
      return
    }
    // The chunk is on its way: the photos wait for it, unless the canvas goes meanwhile (which
    // ends everything a drop has not yet put on the board), the board keeping its frame for
    // files on (and busy) until then. Should it not come, each photo
    // is said not to have been added, and a reload asked for: a failed fetch the module map
    // keeps does not come without one.
    const space = photoSpaceFor(session)
    const generation = space.generation
    this.wait(1)
    loadUpload().then(
      (m) => {
        this.wait(-1)
        if (space.generation === generation) void m.addImages(session, files, at, deps)
      },
      () => {
        this.wait(-1)
        if (space.generation !== generation) return
        for (const f of files) tell(session, couldNotAdd(f.name))
        session.feed.notice({ kind: 'updated', count: 0, message: reloadMessage() })
      },
    )
  }

  /** `by` more (or fewer) photos waiting for the chunk; the frame for files shows while any do. */
  private wait(by: number): void {
    this.waiting = Math.max(0, this.waiting + by)
    const { root } = this.o
    if (this.waiting > 0) {
      this.highlight(true)
      root.setAttribute('aria-busy', 'true')
    } else {
      root.removeAttribute('aria-busy')
      if (this.depth === 0) this.highlight(false)
    }
  }

  /**
   * The note under `target` if it is a print with no photo and none on its way: a photo put
   * there fills it, as a new note beside it would leave it bare.
   */
  private emptyPrintAt(target: EventTarget | null): string | undefined {
    if (!(target instanceof Element)) return undefined
    const id = target.closest<HTMLElement>('article[data-note-id]')?.dataset.noteId
    if (id === undefined) return undefined
    const n = this.o.session.store.getState().notes.get(id)
    const bare = n?.style === 'print' && n.image === null
    return bare && !photoSpaceFor(this.o.session).pending.has(id) ? id : undefined
  }

  private highlight(on: boolean): void {
    // A board with nowhere to keep photos does not invite them (a drop is still kept from
    // opening in the tab). Photos waiting for the upload chunk keep it on.
    if (on && this.o.session.boardId === null) return
    if (!on && this.waiting > 0) return
    if (on) this.o.root.dataset.drop = ''
    else delete this.o.root.dataset.drop
  }

  private clearHighlight(): void {
    this.depth = 0
    this.highlight(false)
  }

  private onPicked = (): void => {
    const files = [...(this.input.files ?? [])]
    const at = this.target ?? this.center()
    this.target = null
    this.input.value = ''
    if (files.length > 0) this.add(files, at)
  }

  /**
   * A drag the board leaves to others: one already handled (the note editor moving its own text
   * calls `preventDefault`), or text over a field or the editor, which takes it itself.
   */
  private leaves(e: DragEvent): boolean {
    return e.defaultPrevented || (takesText(e.target) && !hasFiles(e.dataTransfer))
  }

  private onDragOver = (e: DragEvent): void => {
    if (this.leaves(e) || !hasFiles(e.dataTransfer)) return
    if (this.inert) {
      this.refuse(e)
      return
    }
    // Without this the browser opens the file in the tab.
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    if (e.type === 'dragenter') {
      this.depth++
      // Files over the board: the upload chunk comes while they hang there, if it is not in.
      void loadUpload().catch(() => undefined)
    }
    this.highlight(true)
  }

  private onDragLeave = (e: DragEvent): void => {
    if (!hasFiles(e.dataTransfer)) return
    this.depth = Math.max(0, this.depth - 1)
    if (this.depth === 0) this.highlight(false)
  }

  private onDrop = (e: DragEvent): void => {
    this.clearHighlight()
    if (this.leaves(e) || !hasFiles(e.dataTransfer)) return
    e.preventDefault()
    if (this.inert) return
    const files = [...(e.dataTransfer?.files ?? [])]
    if (files.length === 0) return
    const at = this.o.toWorld(e.clientX, e.clientY)
    const bare = this.emptyPrintAt(e.target)
    if (bare === undefined) {
      this.add(files, at)
      return
    }
    // The first photo fills the bare print; any others become notes beside the drop.
    this.add(files.slice(0, 1), { noteId: bare })
    if (files.length > 1) this.add(files.slice(1), { x: at.x + STAGGER, y: at.y + STAGGER })
  }

  private onPaste = (e: ClipboardEvent): void => {
    const files = [...(e.clipboardData?.files ?? [])]
    if (files.length === 0 || this.inert) return
    // A field is where its paste goes: the note editor, the palette's search, a form.
    if (takesText(e.target)) return
    const { root } = this.o
    const t = e.target
    const onBoard =
      t === root.ownerDocument.body ||
      t === root.ownerDocument.documentElement ||
      (t instanceof Node && root.contains(t))
    if (!onBoard) return
    e.preventDefault()
    const bare = this.emptyPrintAt(t)
    const c = this.center()
    if (bare === undefined) {
      this.add(files, c)
      return
    }
    this.add(files.slice(0, 1), { noteId: bare })
    if (files.length > 1) this.add(files.slice(1), { x: c.x + STAGGER, y: c.y + STAGGER })
  }

  private onPress = (e: PointerEvent): void => {
    if (e.target instanceof Element && e.target.closest('[data-photo-action]') !== null) {
      e.stopPropagation()
    }
  }
}
