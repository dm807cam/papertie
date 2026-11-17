import {
  type BoardState,
  type FocusResult,
  type Membership,
  mapChangesWithin,
  type Note,
  PMap,
  threadsOf,
  type Yarn,
} from '@papertie/core'
import type { StoreApi } from 'zustand/vanilla'
import { announce } from '../app/liveRegion'
import { isReducedMotion, type Prefs, prefsStore, type Tool } from '../app/prefs'
import type { CanvasHistory } from '../app/session'
import {
  type BoardDiff,
  expandLooseEnd,
  FocusMode,
  type FocusPaint,
  type FocusState,
  type FocusView,
  type LooseEndHit,
  looseStub,
  normaliseFocus,
  sameFocus,
  withIncludes,
} from '../focus/focusMode'
import {
  type CaptureStage,
  inEditor,
  installCaptureHandlers,
  onEditedNote,
  releaseCapture,
  releasedMouse,
} from '../interactions/capture'
import type { LiveThread } from '../interactions/connectTool'
import { DRAG_THRESHOLD_PX } from '../interactions/drag'
import {
  focusKey,
  historyKey,
  KEY_ZOOM_STEP,
  type KeyCommand,
  keyCommand,
  photoKey,
  toolKey,
} from '../interactions/keys'
import { pinchCamera } from '../interactions/pinch'
import {
  createSelectTool,
  GESTURE_LABELS,
  type ToolHandlers,
  type ToolPointer,
  toolTarget,
} from '../interactions/selectTool'
import { interpretWheel } from '../interactions/wheel'
import { createToneCache } from '../lib/imageTone'
import { MAX_TILT_DEG, noteRotationDeg } from '../lib/seed'
import { caretOffsetAt } from '../notes/NoteEditor'
import {
  followTopZ,
  forgetTopZ,
  LABELS,
  newNoteCopy,
  primeTopZ,
  textKey,
  topZOf,
} from '../notes/noteCommands'
import { createOptions, NEW_NOTE, type NoteDesign, newNoteOp } from '../notes/noteDesign'
import { noteStyle, writeNoteStyle } from '../notes/noteStyle'
import { isHeading, parseNoteText } from '../notes/noteText'
import type { EditorHandle } from '../notes/sourceEditor'
import { markPinned } from '../notes/stampPress'
import { createViewStore, type ViewState, type ViewStore } from '../proto/viewStore'
import {
  type Direction,
  nearestAmong,
  nearestInDirection,
  readingOrder,
  readingRank,
  revealCamera,
  type SelectionCommand,
  selectionKey,
  stableOrder,
} from '../selection/keyboardNav'
import { createMarqueeTool, marqueeHits } from '../selection/marquee'
import {
  movedCopy,
  nextSelection,
  nudgeOps,
  type SelectMode,
  selectedCopy,
} from '../selection/selection'
import type { BoardStore } from '../store/boardStore'
import { yarnColor } from '../styles/palette'
import { pagePace } from '../sync/pace'
import { openPhotoPicker } from '../ui/photoPicker'
import { takeUpTool } from '../ui/yarnTool'
import { EdgeSides } from '../yarn/edgeSides'
import { TiedDescriptions } from '../yarn/tiedDescriptions'
import { createYarnFlows, newYarnColor, type YarnFlows } from '../yarn/yarnFlows'
import {
  type Attach,
  adoptTopology,
  advanceTopology,
  boardFrames,
  createAttach,
  type End,
  type SegmentRef,
  type Topology,
  type TopologyBoard,
  topologyOf,
  withNeighbours,
} from './attach'
import {
  anchorFor,
  anchorScreen,
  type Camera,
  cameraTransform,
  clampZoom,
  drawnCamera,
  FIT_PADDING_PX,
  fitRect,
  fitRectIn,
  needsRebase,
  panBy,
  screenMapper,
  screenToWorld,
  visibleWorldRect,
  ZOOM_MAX,
  zoomAt,
} from './Camera'
import { CameraController } from './CameraController'
import { CULL, cullRect, inPaintOrder, needsRecull } from './cull'
import { FrameLoop } from './FrameLoop'
import { type CoverPaper, coverCost, freeSpot } from './freeSpot'
import { isTag, noteBounds, pinPosition } from './geometry'
import { compareDrawOrder, type EdgePin, type Hit, hitTest, yarnHitTolerancePx } from './hitTest'
import {
  coveredTest,
  type LayerMode,
  type PaperShape,
  paperBounds,
  paperContains,
  polylineIntersectsRect,
  segmentOccluders,
  tiltReach,
  topPaperAt,
  underOwnPaper,
} from './layering'
import { LOD, type LodMode, nextLod } from './lod'
import { MergeWatch } from './MergeWatch'
import { mountCork } from './mountCork'
import {
  createPyramid,
  type NoteFrame,
  type Pyramid,
  type PyramidStats,
  pyramidSupported,
  type SegFrame,
} from './pyramid/pyramid'
import { overlayFrame, SelectionOverlay } from './SelectionOverlay'
import type { SeamDrop } from './seamDrop'
import { SpatialIndex } from './spatialIndex'
import { TransientOverrides } from './transient'
import { expandRect, type Point, type Rect, rectsIntersect, type Size, unionRects } from './types'
import { YarnMotion } from './YarnMotion'
import { type GlowPin, type RenderStats, YarnRenderer } from './YarnRenderer'
import {
  bezierTangent,
  distanceToPolyline,
  evalBezier,
  flattenBezier,
  restSagPoint,
  segmentBezier,
} from './yarnGeometry'

/** The DOM layers `CanvasView` renders, back to front (`.ui` is React-only). */
export interface CanvasElements {
  root: HTMLElement
  cork: HTMLElement
  world: HTMLElement
  yarnCanvas: HTMLCanvasElement
  pinCanvas: HTMLCanvasElement
  overlay: HTMLElement
}

const dprNow = () =>
  typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1

const sameCamera = (a: Camera | null, b: Camera) =>
  a !== null && a.x === b.x && a.y === b.y && a.zoom === b.zoom

const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i])

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  a.size === b.size && [...a].every((id) => b.has(id))

const reducedQuery = () =>
  typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null

const NO_GLOW: readonly GlowPin[] = []

const NO_HIT: Hit = { kind: 'none' }

const sameImage = (a: Note['image'], b: Note['image']) =>
  a === b || (a !== null && b !== null && a.assetId === b.assetId && a.frame === b.frame)

/** What a note's record holds besides its paper: its text and its stamps. */
const NOT_PAPER: ReadonlySet<string> = new Set<keyof Note>(['text', 'updatedAt', 'rev'])

/**
 * Whether two records of a note draw the same paper: they differ in text and stamps at most (the
 * time, and the revision a commit stamps, `rev`, which a record gains at its first commit), so
 * the index, the threads and the cards stay as they are (a height the text changes arrives
 * through `measured`). Typing is such a change, on every keystroke, and so is a text written
 * elsewhere.
 */
function samePaper(a: Note, b: Note): boolean {
  const ka = Object.keys(a) as (keyof Note)[]
  const kb = Object.keys(b) as (keyof Note)[]
  let shared = 0
  for (const k of ka) {
    if (NOT_PAPER.has(k)) continue
    // The one field that is an object: a commit's copy of the record makes a new one.
    if (k === 'image') {
      if (!sameImage(a.image, b.image)) return false
    } else if (a[k] !== b[k]) return false
    shared++
  }
  for (const k of kb) if (!NOT_PAPER.has(k)) shared--
  return shared === 0
}

/** The pause in typing that ends the key hold after writing ended on its own (`holdKeys`). */
const KEY_HOLD_MS = 600

/** The highest zoom a board opens at when its first camera fits its notes. */
const OPEN_ZOOM_MAX = 1

/** Air a fit leaves between what it frames and the app's chrome (`safeViewport`). */
const CHROME_GAP_PX = 24
/** The focus chip at the foot: its 28 px off the edge (10 px over the mini-bar), 36 px tag, 28 px air. */
const CHIP_OFF_EDGE_PX = 28
const CHIP_OVER_BAR_PX = 10
const CHIP_ROOM_PX = 36 + 28
/**
 * Focus frames its notes at reading size: never closer than a board opens at, never so far that
 * they go lite (the lite level's exit, so the notes come back to full detail).
 */
const FOCUS_ZOOM = { min: LOD.lite.exitAtOrAbove, max: OPEN_ZOOM_MAX } as const
/**
 * On a phone (the mini-bar's width, under 768 px) focus keeps reading size for its small screen:
 * titles about 18 px. The focused notes are centred and the rest run off the screen, their cords
 * showing the way, for a pan.
 */
const FOCUS_PHONE_MIN = 0.6
const PHONE_MAX_WIDTH = 767
/** Screen px between the spots a new note may take (`placeNear`), and the paper it keeps clear of. */
const PLACE_STEP_PX = 24
const PLACE_GAP_PX = 12
/** What covering a note's text, per world px², and a pin cost a new note's spot, beside paper's 1. */
const PLACE_TEXT_COST = 8
const PLACE_PIN_COST = 1e9
/** More papers in view than this, and a new note simply takes the middle. */
const PLACE_PAPERS_MAX = 8000

/** The most papers read for one pin's cover: past that (a deep pile), the pin is shown. */
const PIN_COVER_READ = 48

/** A fit's padding: `FIT_PADDING_PX`, less on a small screen (a tenth of the area's short side). */
const fitPadding = (area: Rect): number =>
  Math.min(FIT_PADDING_PX, Math.max(16, Math.round(Math.min(area.w, area.h) / 10)))

/**
 * Overview draws from the far-zoom picture pyramid on a board of more than this many notes (spec
 * decision 8); at or under it, from the card overview, which looks the same.
 */
export const PYRAMID_ABOVE = 5000
/** The pyramid goes once the board is back under this share of `pyramidAbove`. */
const PYRAMID_KEEP_SHARE = 0.8
/**
 * Notes and segments handed to the pyramid in one piece (each is a card's geometry, a few µs and
 * some garbage): a larger change goes over a piece at a time, as many a frame as start within
 * {@link PYRAMID_SYNC_MS} (at least one).
 */
const PYRAMID_SYNC_MAX = 128
/**
 * A frame hands the pyramid pieces of a large change for this long at most: a thousand cards in
 * one frame, while a collection was marking, held it 80–122 ms (an opening's
 * slices); timed, a frame the collector slows hands over less.
 */
const PYRAMID_SYNC_MS = 2
/**
 * The pyramid is made only once no told change (an opening's) has come for this long: it is then
 * built from the board in idle slices, not handed an opening's 100,000 cards a frame at a time
 * (most of an opening's frame garbage, by a heap profile). Meanwhile far zoom draws
 * the card overview, which looks the same.
 */
const PYRAMID_AFTER_TOLD_MS = 1000
/** A group drag's members in view are found by walking it up to this size, else by the index. */
const GROUP_WALK = 2000

const NO_KEYS: ReadonlySet<string> = new Set()

/** The largest |z| used as a z-index as it is: a lifted note's z-index (2^30) lies above it. */
const STACK_MAX = 2 ** 29

/** Nudges (Alt+arrows) this close together, with the same selection, are one undo step. */
const NUDGE_WINDOW_MS = 500

/** The coalesce key (and label) of Alt+arrow nudges. */
const NUDGE = 'nudge'

/**
 * A touch or pen press held this long on bare cork without travelling arms the marquee: the drag
 * that follows draws the band (as a Shift-drag does with a mouse).
 */
export const LONG_PRESS_MS = 400

/**
 * Once the camera has moved, at most this many notes start to mount in one frame: fit-all from reading zoom eases through lite, whose first frame wanted 453 notes of the
 * lifetime grid at once (a 133 ms frame, 116 ms of it React). The notes in view nearest its
 * middle come first, the rest in the frames after, until every note the cull wants is mounted.
 * A board's first cull (its opening) mounts everything it wants at once.
 */
export const MOUNT_BATCH = 64

/** How long after a press on a loose end a double-click is that press's own. */
const LOOSE_DOUBLE_MS = 500

/** Past this share of the board changing at once, the index is rebuilt instead of patched. */
const REBUILD_SHARE = 0.5
/**
 * A change of more records than this (or a board swapped in whole, `all`) is taken in slices: the
 * board is caught up with a slice at a time ({@link CanvasRuntime.catchUp}), never in one task.
 */
const CATCH_UP_ABOVE = 2000
/**
 * A slice of catching up starts a step only while there is time for one like the last within
 * this many ms, so it ends by 8 ms even with a step or a collection
 * that runs long: the headroom is for those.
 */
const CATCH_UP_BUDGET_MS = 4
/** Records a step of catching up looks at, and changes it takes (as notes' worth). */
const CATCH_UP_LOOK = 512
const CATCH_UP_TAKE = 32
/** A thread taken costs about this many notes beside its own (its neighbours' pins move). */
const THREAD_WEIGHT = 4
/**
 * A told change (an opening's slice, its catch-up, its hand-over: only those are told) of more
 * than this is caught up a step at a time as well, so its task stays a few ms: a collector that
 * is marking runs its steps on what a task allocates, and a slice's 150 notes taken at once held
 * the page 52–88 ms. An edit, never told, is taken at once as before.
 */
const CATCH_UP_TOLD_ABOVE = CATCH_UP_TAKE
/**
 * A thread naming more notes than this is not taken in one step with them: its notes are taken
 * first, a step at a time, and then it, alone. Meanwhile it is drawn as the canvas had it, through
 * notes it has, so the board drawn stays one board.
 */
const LONG_THREAD = 32
/**
 * An edit's notes are taken at once with their threads ({@link CanvasRuntime.takeNow}); a thread
 * naming more notes than this is left to the catch-up.
 */
const TAKE_NOW_THREAD = 200

type Kind = 'note' | 'yarn'

/**
 * Catching up with a board swapped in whole. The notes in view are looked at first; then every
 * id in turn, those in view taken as they are found and the rest after the walk. A note is taken
 * with its threads, and a thread with its notes, so the board drawn is always one board: no
 * thread is drawn through a note it no longer names, nor between notes of another board.
 */
interface CatchUp {
  /** The notes in view, as the canvas had them: looked at first. */
  first: string[]
  /** Every id to look at (null: one looked at that needs nothing). */
  walk: Iterator<readonly [Kind, string] | null>
  walked: boolean
  /** Found to differ outside the view: taken once the walk is done. */
  later: Array<readonly [Kind, string]>
  /**
   * Taken next, last first: the notes of a long thread, then the thread ({@link LONG_THREAD}),
   * whose ids are in `deferred` meanwhile.
   */
  soon: Array<readonly [Kind, string]>
  deferred: Set<string>
  next: number
  /** The world rect in view when the catch-up began. */
  view: Rect
  /** What a step costs, ms: the last one's, or a costlier recent one's, slowly forgotten. */
  step: number
}

/** Whether two versions of a thread run through the same notes, tied at the same pins. */
function sameThreading(a: Yarn, b: Yarn): boolean {
  if (a.noteIds.length !== b.noteIds.length) return false
  for (let i = 0; i < a.noteIds.length; i++) if (a.noteIds[i] !== b.noteIds[i]) return false
  const p = a.pins ?? {}
  const q = b.pins ?? {}
  const keys = Object.keys(p)
  return keys.length === Object.keys(q).length && keys.every((k) => p[k] === q[k])
}

/** What a change touched: ids of notes and of threads added, changed or removed. */
interface Changed {
  notes: Iterable<string>
  yarns: Iterable<string>
}

/**
 * What took the board from `prev` to `s`, found in O(changes) between two versions of one board;
 * null for more than {@link CATCH_UP_ABOVE} records, or two boards that share too little to tell
 * cheaply (a board loaded again).
 */
function changesBetween(prev: TopologyBoard, s: TopologyBoard): Changed | null {
  const notes = mapChangesWithin(prev.notes, s.notes, CATCH_UP_ABOVE)
  const yarns = notes && mapChangesWithin(prev.yarns, s.yarns, CATCH_UP_ABOVE)
  if (notes === null || yarns === null) return null
  return { notes: [...notes.set, ...notes.deleted], yarns: [...yarns.set, ...yarns.deleted] }
}

/**
 * Every id of a board swapped in whole, then every id of the board it replaces that it lacks;
 * null for each of the replaced board's ids it has, so that a step costs what it looks at.
 */
function* idsToCatchUp(
  next: TopologyBoard,
  from: TopologyBoard,
): Generator<readonly [Kind, string] | null> {
  for (const id of next.notes.keys()) yield ['note', id]
  for (const id of from.notes.keys()) yield next.notes.has(id) ? null : ['note', id]
  for (const id of next.yarns.keys()) yield ['yarn', id]
  for (const id of from.yarns.keys()) yield next.yarns.has(id) ? null : ['yarn', id]
}

/** The rest of each iterator in turn. */
function* chain<T>(...its: Array<Iterator<T>>): Generator<T> {
  for (const it of its) for (let r = it.next(); !r.done; r = it.next()) yield r.value
}

/** The ids a told change names: its notes, then its threads. */
function* idsTold(changed: Changed): Generator<readonly [Kind, string]> {
  for (const id of changed.notes) yield ['note', id]
  for (const id of changed.yarns) yield ['yarn', id]
}

/** `m` with each of `ids` as `from` has it (set, or deleted where `from` has none). */
function patched<V>(
  m: ReadonlyMap<string, V>,
  from: ReadonlyMap<string, V>,
  ids: Iterable<string>,
) {
  let t: ReturnType<PMap<string, V>['asTransient']> | null = null
  for (const id of ids) {
    const v = from.get(id)
    if ((t ?? m).get(id) === v && (v !== undefined || !(t ?? m).has(id))) continue
    t ??= (m instanceof PMap ? m : PMap.from(m)).asTransient()
    if (v === undefined) t.delete(id)
    else t.set(id, v)
  }
  return t === null ? m : t.persist()
}

/**
 * World px a paper's bounds grow by when finding the notes a thread passes under: the stroke's
 * width and offset shadow reach past its centre line (up to ~7 world px at the lowest zoom).
 * Extra occluders only cost an erase that removes nothing.
 */
const OCCLUDER_PAD = 12

/** How far the most-tilted note's paper can reach past its unturned rect. */
const TILT_REACH = tiltReach(MAX_TILT_DEG)

/** World bounds of a polyline's finite points, or null when it has none. */
function polylineBounds(pts: readonly Point[]): Rect | null {
  let x0 = Number.POSITIVE_INFINITY
  let y0 = Number.POSITIVE_INFINITY
  let x1 = Number.NEGATIVE_INFINITY
  let y1 = Number.NEGATIVE_INFINITY
  for (const p of pts) {
    if (!(Number.isFinite(p.x) && Number.isFinite(p.y))) continue
    x0 = Math.min(x0, p.x)
    y0 = Math.min(y0, p.y)
    x1 = Math.max(x1, p.x)
    y1 = Math.max(y1, p.y)
  }
  return x0 > x1 ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/**
 * The imperative canvas: one frame loop, the camera, and the input that drives it. Camera changes
 * reach the DOM inside the frame (world transform, cork, `will-change`), never through React.
 * A second frame task culls through the spatial index (writing `view` only when the mounted set
 * or LOD changes) and draws yarn and pins, but only when something it shows has changed.
 * The select tool drags and resizes through `overrides`: a frame task writes the moved notes'
 * styles and the selection handles, and the yarn reads pins through the overrides.
 * `motion` springs each segment's sag after its pins move and animates created and deleted
 * threads; segments it is moving are drawn as dynamic until all of its motion has stopped.
 * Pointer input is one capture-phase dispatcher on the root, in a fixed order: pinch and pan
 * (middle button, held Space) first, then the hit-testing stage (`installCaptureHandlers`: pins,
 * then yarn), and only presses neither takes bubble on to the tools: on bare cork a pan (a click
 * there clears the selection), or with Shift the marquee, whatever the tool.
 * The layer pref decides what paper hides: in `over-fix` the renderer erases each thread under
 * the notes above it, and in `over-fix` and `under` a press on a hidden span goes to the note.
 * Floating origin: the camera, the board, the index and hit-testing keep world doubles, but every
 * layer is drawn relative to `anchor`, a world point near the camera, so the numbers the
 * compositor and the canvases see stay small. The frame that takes the camera past
 * `ANCHOR_REACH_PX` from it rebases (`apply`), moving every layer at once.
 * Overview LOD (zoom below 0.15): no note is mounted (the view's `visible` is empty) and the
 * renderer draws the culled notes as cards. A press on a card reaches the tools as a press on
 * that note (`noteAt`, a world-space test through rbush); pins and yarn are not hit-tested, the
 * DOM selection handles are hidden and the renderer outlines the selection and the hovered card.
 * The selection holds many notes (`selectNotes`): Shift toggles, a Shift-drag on bare cork
 * rubber-bands the notes the band meets (adding them), found through the index at any level of
 * detail, and a drag of a selected note moves them all.
 * Arrows move the selection to the nearest note that way, Alt+arrows nudge it, ⌘A takes every
 * note. The notes are in the DOM in reading order (the tab order); `--stack` orders them for
 * painting (their z, or a rank where z repeats), since the DOM no longer says what is on top.
 * A group drag is one shared move in `overrides`; what it draws, culls and hit-tests is bounded
 * by the view, never by the size of the selection. Several selected notes are framed on the pin
 * layer (the culled ones), in screen px.
 *
 * Focus mode (`setFocus`) is a view over all of this: hidden notes stay mounted
 * (marked hidden and inert) and are filtered out inside the culled set, never over the board:
 * out of hit-testing, out of selection and out of what the renderer draws. Nothing is committed.
 */
export class CanvasRuntime {
  readonly loop = new FrameLoop()
  readonly camera: CameraController
  viewport: Size
  /** Rendered note heights in world px, written by `NoteLayer`'s ResizeObserver. */
  readonly measuredH = new Map<string, number>()
  readonly noteEls = new Map<string, HTMLElement>()
  /** The note under the pointer's press (`data-pressed`, note.css's lift), or null. */
  private pressedEl: HTMLElement | null = null
  /**
   * Notes Shift+2 fits and the handles frame; set through `selectNotes` (or `selectNote`). A new
   * set on every change, never mutated.
   */
  selection: ReadonlySet<string> = new Set()
  /** Gesture-time note geometry; the store changes only when the gesture commits. */
  readonly overrides = new TransientOverrides()
  /** Culled note ids and LOD; `NoteLayer` mounts from it. */
  readonly view: ViewStore
  readonly index = new SpatialIndex()
  readonly yarn: YarnRenderer
  readonly motion: YarnMotion
  readonly yarnFlows: YarnFlows
  /** The mounted notes' "Tied to … by … yarn." descriptions, kept per note (`NoteLayer`). */
  readonly tied: TiedDescriptions
  /** The mounted notes' sides that carry an edge pin, which their titles keep clear of. */
  readonly edgeSides: EdgeSides
  /** Segments and notes drawn every frame rather than from the static cache (drag, motion). */
  readonly dynamicKeys = new Set<string>()
  readonly dynamicNotes = new Set<string>()
  /** The selected yarn; set through `selectYarn` (a note selection clears it). */
  selectedYarnId: string | undefined = undefined

  private readonly cork: ReturnType<typeof mountCork>
  private readonly overlay: SelectionOverlay
  private readonly selectTool: ToolHandlers
  private readonly marqueeTool: ToolHandlers
  /** Merging a dragged note into one it is held beside (with Alt), with its liquid bridge. */
  private readonly merge: MergeWatch
  /** The drag is a touch's or a pen's, which have no Alt: the hold alone merges. */
  private holdMerges = false
  /** The note arrows move on from: the one last selected, if it still is. */
  private primary: string | undefined = undefined
  /** A note to focus once it mounts (the arrow keys reached it before it was in view). */
  private wantFocus: string | undefined = undefined
  /** Each mounted note's rank in z order, written as its `--stack` (see `restack`). */
  private stack = new Map<string, number>()
  /** The ids `NoteLayer` mounts, in DOM (reading) order, as the last cull left them. */
  private mountedOrder: string[] = []
  /** The last nudge: when, and the selection it moved (a new nudge on another is a new step). */
  private nudged: { at: number; of: ReadonlySet<string> } | null = null
  private nudgeSaid: ReturnType<typeof setTimeout> | undefined = undefined
  /** The pointer driving a bubble-phase tool (select or marquee), captured on the root. */
  private toolPointerId: number | null = null
  private toolActive: ToolHandlers | null = null
  /** The active tool's last pointer, replayed when the camera moves under a still pointer. */
  private lastTool: ToolPointer | null = null
  private stage: CaptureStage | null = null
  private live: LiveThread | null = null
  private hoverPin: { noteId: string; edge?: EdgePin } | null = null
  private glow: ReadonlySet<string> = new Set()
  /** Edge-pin attachment for the current board, overrides, heights and tilt; see `attachOf`. */
  private attachCache: {
    s: BoardState
    topo: Topology
    overrides: number
    measured: number
    rotation: boolean
    attach: Attach
  } | null = null
  /** Bumped whenever a note's displayed height changes (it moves that note's edge pins). */
  private measuredVersion = 0
  /** Which hanging pins paper hides (`pinCovered`), for one attachment: kept until paper moves. */
  private pinCover: { key: Attach; covered: Map<string, boolean> } | null = null
  /** Segments of the moved notes' neighbours, whose edge pins shift with them: drawn dynamic. */
  private neighbourKeys: ReadonlySet<string> = new Set()
  /** Note elements currently styled from overrides, and the overrides version written. */
  private readonly styled = new Map<string, HTMLElement>()
  private styledVersion = -1
  private readonly cleanups: Array<() => void> = []
  private readonly removedListeners = new Set<(id: string) => void>()
  private readonly yarnSelectionListeners = new Set<(id: string | undefined) => void>()
  private readonly reducedMq = reducedQuery()
  /** Overridden notes at the last override change, so released ones are retargeted too. */
  private overrideIds: ReadonlySet<string> = new Set()
  /** Segments motion has moved since it was last idle; dynamic until it is idle again. */
  private readonly motionRefs = new Map<string, SegmentRef>()
  /**
   * The board the spatial index, the springs and the thread topology stand for: the store's,
   * except while a board swapped in whole is caught up with, a slice at a time ({@link catchUp}).
   */
  private model: TopologyBoard
  /** Catching up with a board swapped in whole ({@link catchUp}); null when caught up. */
  private catching: CatchUp | null = null
  /** The board drawn while catching up: the store's, with the model's notes and threads. */
  private drawnMemo: { s: BoardState; model: TopologyBoard; board: BoardState } | null = null
  private disposed = false
  /** What the slice under way has taken (the `papertie:catch-up` measure's detail). */
  private sliceTook = { steps: 0, notes: 0, yarns: 0, shown: 0 }
  private motionActive = false
  private origin: Point = { x: 0, y: 0 }
  /** The floating origin: the world point every layer is drawn relative to. */
  private anchorPt: Point
  private currentDpr = dprNow()
  private lodMode: LodMode = 'full'
  /** Overview: the card under the pointer, outlined. */
  private hoverCard: string | undefined = undefined
  /** Overview: prints' image tones, measured once per file. */
  private readonly toneOf = createToneCache((asset) => {
    this.yarn.invalidateStatic()
    this.pyramid?.retone(asset)
    this.requestYarn()
  })
  /**
   * The far-zoom picture pyramid, made once the board has more than `pyramidAbove` notes (it
   * follows the index's changes from then on); null on a smaller board or where no worker can
   * draw it.
   */
  private pyramid: Pyramid | null = null
  /** Overview is drawn from the pyramid (not the card overview) this frame. */
  private pyramidOn = false
  /** Notes and segments the pyramid takes again besides what the index re-indexed. */
  private readonly pyramidNotes = new Set<string>()
  private readonly pyramidSegs = new Set<string>()
  /** Above this many notes overview draws from the pyramid (lowered by the test hooks). */
  pyramidAbove = PYRAMID_ABOVE
  /** The pyramid's worker could not start or failed: the card overview from then on. */
  private pyramidBroken = false
  /** When the store last told a change (`performance.now()`), and the frame asked for after it. */
  private toldAt = Number.NEGATIVE_INFINITY
  private pyramidWake: ReturnType<typeof setTimeout> | null = null
  /** A large selection's notes in view, kept for the cull and selection they were found for. */
  private selectedSeen: {
    cull: object | null
    selection: ReadonlySet<string>
    ids: string[]
  } | null = null
  private lastCull: { c: Camera; viewport: Size } | null = null
  private segments: SegmentRef[] = []
  /** The keys of `segments`, made once per cull when a change asks which are in view. */
  private segmentKeys: ReadonlySet<string> | null = null
  /** `over-fix`: static segments under a moving note's paper, drawn dynamic with its erase. */
  private coverKeys: ReadonlySet<string> = new Set()
  private coverVersion = -1
  private visibleNotes: string[] = []
  /** `visibleNotes` as a set, made once per cull when a change asks which are in view. */
  private visibleSet: ReadonlySet<string> | null = null
  /** Each mounted note's place in `mountedOrder`, made once per cull when a change asks. */
  private mountedAt: ReadonlyMap<string, number> | null = null
  private recullDue = false
  /** The spatial index as the yarn's static patches ask it what lies near a change. */
  private readonly near = {
    segments: (r: Rect) => this.index.segmentsIn(r),
    notes: (r: Rect) => this.index.notesIn(r),
  }
  /** The notes the last cull wanted mounted (paint order), while some are still to mount. */
  private mountWanted: string[] | null = null
  /** Among several selected notes, the one the keyboard is on (its frame is drawn in focus ink). */
  private focusedNote: string | undefined = undefined
  /** The group move the last cull allowed for, so a drag far from it culls again. */
  private cullMove: { dx: number; dy: number } | null = null
  /** Notes whose measured height changed their bounds since the last frame. */
  private readonly pendingNotes = new Set<string>()
  private renderedCamera: Camera | null = null
  private renderDue = true
  private stats: RenderStats = {
    segmentsStatic: 0,
    segmentsDynamic: 0,
    pins: 0,
    staticRedrawn: false,
  }
  private lastTransform = ''
  private lastWillChange = ''
  private spaceHeld = false
  /**
   * The pan under way. One from a press on bare cork (`from`) waits until the pointer travels
   * `DRAG_THRESHOLD_PX`; released before that, it was a click on the cork, which clears the
   * selection.
   */
  private pan: { id: number; last: Point; from?: Point } | null = null
  /** A touch or pen press on bare cork waiting to arm the marquee (`LONG_PRESS_MS`). */
  private longPress: ReturnType<typeof setTimeout> | undefined = undefined
  private readonly touches = new Map<number, Point>()
  private pinch: { ids: [number, number]; prev: [Point, Point] } | null = null
  /** The note being written on; `fresh` when it was created for it (empty, it leaves no trace). */
  private edit: { noteId: string; fresh: boolean } | null = null
  /**
   * Until when (performance.now ms) board keys do nothing after writing ended without the
   * writer asking; see `holdKeys`.
   */
  private keyHoldUntil = 0
  /** The mounted editor and its note. */
  private editor: { noteId: string; handle: EditorHandle } | null = null
  /** Where the current or last tool press went down, and whether it travelled into a drag. */
  private pressFrom: Point | null = null
  private travelled = false
  /** Focus mode: what it shows, the mounted notes' marks and the fade. */
  private readonly focusMode: FocusMode
  /** Where the camera was heading when focus began, for leaving it. */
  private focusReturn: Camera | null = null
  /** When (performance.now ms) a press last took a loose end: its double-click is not cork's. */
  private loosePressAt = Number.NEGATIVE_INFINITY

  /**
   * `frame` is the world rect the first camera fits (and refits when a hidden viewport first gets
   * a size); without one, every note. `start` is a remembered camera that wins over both.
   * `history` takes ⌘Z and ⇧⌘Z (the session's undo and redo)
   * and hears where writing sessions end. `opening`: the board is still coming in (its first
   * paint is part of it), so `start` is kept even where no note shows yet ({@link opened}).
   */
  constructor(
    readonly els: CanvasElements,
    readonly store: BoardStore,
    private readonly frame: Rect | null = null,
    private readonly history: CanvasHistory | null = null,
    private readonly start: Camera | null = null,
    private opening = false,
  ) {
    this.viewport = this.measure()
    this.cork = mountCork(els.cork)
    this.yarn = new YarnRenderer(els.yarnCanvas, els.pinCanvas)
    this.overlay = new SelectionOverlay(els.overlay)
    this.motion = new YarnMotion(
      () => this.reducedMotion(),
      () => this.loop.request(),
    )
    this.model = store.getState()
    const endsOfYarn = (id: string) => {
      const s = this.board()
      const refs = this.topology.byYarn.get(id) ?? []
      return refs.flatMap((ref) => this.attachOf(s).ends(ref) ?? [])
    }
    this.tied = new TiedDescriptions(store)
    this.edgeSides = new EdgeSides(store)
    this.yarnFlows = createYarnFlows(store, {
      select: (id) => this.selectYarn(id),
      drawIn: (id) => this.motion.startDrawIn(id, performance.now()),
      pulse: (id) => this.motion.startPulse(id, performance.now()),
      loosen: (yarn) => this.motion.startLoosen(yarn, endsOfYarn(yarn.id), performance.now()),
    })
    this.sizeCanvases()
    // The index first: a remembered camera is checked against it.
    this.index.rebuild(this.model, this.measuredH, prefsStore.getState().tilt)
    this.camera = new CameraController(this.initialCamera(), this.loop)
    this.motion.sync(this.model, (ref) => this.attachOf(store.getState()).ends(ref))
    const c = this.camera.get()
    this.anchorPt = anchorFor(c, this.viewport)
    this.focusMode = new FocusMode({
      board: () => this.board(),
      noteEls: this.noteEls,
      root: els.root,
    })
    this.view = createViewStore({
      ...this.cull(c, nextLod('full', c.zoom)),
      selected: this.selection,
      editing: null,
      drawn: null,
    })
    this.merge = new MergeWatch({
      board: () => this.board(),
      takeNow: (ids) => this.takeNow(ids),
      notesIn: (r) => this.focusIndex().notesIn(r),
      heightOf: (n) => Math.max(n.h, this.measuredH.get(n.id) ?? 0),
      zoom: () => this.camera.get().zoom,
      lod: () => this.lodMode,
      now: () => performance.now(),
      reduced: () => this.reducedMotion(),
      mapper: () => this.mapper(),
      dpr: () => this.currentDpr,
      viewport: () => this.viewport,
      rotation: () => prefsStore.getState().tilt,
      anchor: () => this.anchorPt,
      overlay: els.overlay,
      noteEl: (id) => this.noteEls.get(id),
      request: () => this.loop.request(),
      commit: (ops, o) => {
        this.store.commit(ops, o)
      },
      select: (id) => this.selectNote(id),
    })
    this.selectTool = createSelectTool({
      getNote: (id) => this.board().notes.get(id),
      overrides: this.overrides,
      commit: (ops, o) => {
        this.store.commit(ops, o)
        // A group drag is said once, when it lands.
        if (o?.label === GESTURE_LABELS.dragging && ops.length > 1) announce(movedCopy(ops.length))
      },
      select: (id) => this.selectNote(id),
      selection: () => this.selection,
      selectNotes: (ids, mode) => {
        this.selectNotes(ids, mode)
        if (mode === 'toggle') this.announceSelection()
      },
      topZ: () => this.topZ(),
      zoom: () => this.camera.get().zoom,
      aspectOf: (n) => {
        const a = n.image && this.board().assets.get(n.image.assetId)
        return a && a.width > 0 && a.height > 0 ? a.width / a.height : undefined
      },
      heightOf: (n) => Math.max(n.h, this.measuredH.get(n.id) ?? 0),
      watch: this.merge,
    })
    this.marqueeTool = createMarqueeTool({
      // With focus on, the band meets the shown notes only (the index query, filtered).
      hits: (rect) => marqueeHits(this.focusIndex(), rect),
      selection: () => this.selection,
      setSelection: (ids) => this.selectNotes(ids, 'replace'),
      show: (rect) => this.showBand(rect),
      done: () => this.announceSelection(),
    })
    this.cleanups.push(this.camera.onApply((c) => this.apply(c)))
    this.cleanups.push(this.loop.add(this.gestureFrame))
    this.cleanups.push(this.loop.add(this.motionFrame))
    this.cleanups.push(this.loop.add(this.focusFrame))
    this.cleanups.push(this.loop.add(this.yarnFrame))
    this.cleanups.push(this.loop.add((_dt, now) => this.merge.frame(now)))
    this.cleanups.push(this.overrides.subscribe(this.onOverrides))
    this.cleanups.push(store.subscribe(this.onBoard))
    // The board's top z, met in idle time: a drag's start then reads only what changed.
    primeTopZ(() => this.store.getState())
    this.cleanups.push(forgetTopZ)
    this.wire()
  }

  /** Device pixel ratio the canvases are sized for. */
  get dpr(): number {
    return this.currentDpr
  }

  /** The world point every layer is drawn relative to (floating origin). */
  get anchor(): Point {
    return this.anchorPt
  }

  /** `anchor` as a stable getter, for notes to read when they render without subscribing. */
  readonly anchorOf = (): Point => this.anchorPt

  /** The level of detail the canvas draws now. */
  get lod(): LodMode {
    return this.lodMode
  }

  /** What the last yarn frame drew. */
  get yarnStats(): RenderStats {
    return this.stats
  }

  /** Test hook: hold the pyramid worker's replies (a slow worker), or let them go. */
  holdPyramid(on: boolean): void {
    this.pyramid?.holdReplies(on)
  }

  /** The far-zoom pyramid's state (null on a board without one), and whether overview uses it. */
  get pyramidState(): (PyramidStats & { on: boolean }) | null {
    const p = this.pyramid
    return p === null ? null : { ...p.stats(), on: this.pyramidOn }
  }

  /** The threads' segments and ends as the canvas draws them (memoised on the board). */
  get topology(): Topology {
    return topologyOf(this.model)
  }

  /** Viewport CSS px of a note's pin, as drawn; undefined for an unknown note. */
  pinScreen(noteId: string): Point | undefined {
    const p = this.pinOf(this.board(), noteId)
    return p && this.mapper()(p)
  }

  /** Viewport CSS px of the edge pin at one end of a yarn's `seg`-th segment, as drawn. */
  attachScreen(yarnId: string, seg: number, end: End): Point | undefined {
    const p = this.attachWorld(yarnId, seg, end)
    return p && this.mapper()(p)
  }

  /** A thread as drawn: the store's, or while catching up, the model's until it is taken. */
  drawnYarn(yarnId: string): Yarn | undefined {
    return this.board().yarns.get(yarnId)
  }

  /**
   * A gesture on a pin or a thread starts from the store's records, as one on a note does: while
   * catching up, these notes and their threads are taken now. True when that changed what is
   * drawn, so a hit made before it is stale; false once caught up.
   */
  takeBeforeGesture(noteIds: Iterable<string>): boolean {
    if (this.catching === null) return false
    const was = this.model
    this.takeNow(noteIds)
    return this.model !== was
  }

  /** World px of the pin at one end of a yarn's `seg`-th segment, as drawn. */
  attachWorld(yarnId: string, seg: number, end: End): Point | undefined {
    const s = this.board()
    const ref = this.topology.byYarn.get(yarnId)?.[seg]
    return ref && this.attachOf(s).point(ref, end)
  }

  /** Viewport CSS px of the point at `t` on a yarn's `seg`-th segment, at its rest sag. */
  yarnPointScreen(yarnId: string, seg: number, t: number): Point | undefined {
    const s = this.board()
    const ref = this.topology.byYarn.get(yarnId)?.[seg]
    const e = ref && this.attachOf(s).ends(ref)
    if (e === undefined) return undefined
    const w = evalBezier(segmentBezier(e.a, e.b, restSagPoint(e.a, e.b)), t)
    return this.mapper()(w)
  }

  /**
   * Viewport CSS px of the point at `t` on a yarn's `seg`-th segment at its current (spring) sag,
   * moved `normalOffsetPx` screen px along the curve's normal.
   */
  yarnProbe(yarnId: string, seg: number, t: number, normalOffsetPx: number): Point | undefined {
    const s = this.board()
    const ref = this.topology.byYarn.get(yarnId)?.[seg]
    const e = ref && this.attachOf(s).ends(ref)
    if (ref === undefined || e === undefined) return undefined
    const c = segmentBezier(e.a, e.b, this.motion.sagOf(ref, e.a, e.b))
    const p = this.mapper()(evalBezier(c, t))
    const d = bezierTangent(c, t)
    const len = Math.hypot(d.x, d.y)
    const n = len > 0 ? { x: -d.y / len, y: d.x / len } : { x: 0, y: 1 }
    return { x: p.x + n.x * normalOffsetPx, y: p.y + n.y * normalOffsetPx }
  }

  /**
   * The camera as drawn: the world layer and canvases snap their offset to device pixels, so
   * pointer positions map through this to land exactly where things are painted.
   */
  drawnCamera(): Camera {
    return drawnCamera(this.camera.get(), this.currentDpr, this.anchorPt)
  }

  /** World to viewport CSS px, as every layer draws it now. */
  private mapper(): (p: Point) => Point {
    return screenMapper(this.camera.get(), this.currentDpr, this.anchorPt)
  }

  /**
   * What a viewport point lands on: pins first, then yarn at its current sag that the layer
   * pref (read live) leaves uncovered. Nothing in overview, which draws neither for hitting.
   */
  hitTest(screen: Point): Hit {
    if (this.lodMode === 'overview') return NO_HIT
    const s = this.board()
    const camera = this.drawnCamera()
    const tolerance = 0.25 / camera.zoom
    const curveOf = (ref: SegmentRef) => this.curve(s, ref, tolerance)
    const { layer, tilt: rotation } = prefsStore.getState()
    const index = this.focusIndex()
    const attach = this.attachOf(s)
    // Above the paper, a strand from a hanging pin lies beneath its own note's paper.
    const ownPaper = (ref: SegmentRef, w: Point) =>
      (['a', 'b'] as const).some((end) => {
        if (attach.sharedPin(ref, end) !== null) return false
        const id = end === 'a' ? ref.aNoteId : ref.bNoteId
        const paper = this.paperOf(s, id)
        const pin = this.pinOf(s, id)
        return paper !== undefined && pin !== undefined && underOwnPaper(w, pin, paper)
      })
    const covered =
      layer === 'over'
        ? undefined
        : coveredTest(layer, {
            notes: s.notes,
            notesAt: (w) => {
              const near = expandRect({ x: w.x, y: w.y, w: 0, h: 0 }, OCCLUDER_PAD)
              return [...index.notesIn(near), ...this.overriddenNear(near)]
            },
            rectOf: (n) => noteBounds(this.overrides.effective(n), this.measuredH.get(n.id)),
            angleOf: (n) => (rotation ? noteRotationDeg(n) : 0),
            occludersOf: (ref) => this.occludersOf(s, ref, curveOf(ref)),
            pinOf: (id) => this.pinOf(s, id),
            endsOf: (ref) => this.attachOf(s).ends(ref),
          })
    return hitTest(screen, {
      camera,
      index,
      notes: s.notes,
      // A pin under a higher note's paper is hidden, and takes no press: the paper does.
      pinOf: (id) => (this.pinCovered(s, attach, id) ? undefined : this.pinOf(s, id)),
      endsOf: (ref) => attach.ends(ref),
      lite: this.lodMode === 'lite',
      curveOf,
      isCovered:
        layer === 'under' ? covered : (ref, w) => ownPaper(ref, w) || (covered?.(ref, w) ?? false),
      // Awake springs can swing outside their rest bounds in the index.
      liveSegments: () =>
        this.focusMode.state === null
          ? this.motion.activeRefs()
          : [...this.motion.activeRefs()].filter((ref) => this.segmentShown(ref)),
      selectedYarnId: this.selectedYarnId,
    })
  }

  /**
   * The topmost note whose paper as drawn (through gesture overrides, measured height and, with
   * the tilt pref on, its rotation about the pin) contains world point `w`.
   */
  noteAt(w: Point): string | undefined {
    if (!(Number.isFinite(w.x) && Number.isFinite(w.y))) return undefined
    const s = this.board()
    // The index holds unturned rects; a turned paper reaches up to `TILT_REACH` past its own.
    const pad = prefsStore.getState().tilt ? TILT_REACH : 0
    const near = expandRect({ x: w.x, y: w.y, w: 0, h: 0 }, pad)
    const ids = new Set([...this.index.notesIn(near), ...this.overriddenNear(near)])
    const notes: Note[] = []
    for (const id of ids) {
      const stored = s.notes.get(id)
      if (stored !== undefined && this.focusMode.shown(id)) {
        notes.push(this.overrides.effective(stored))
      }
    }
    return topPaperAt(w, notes, (n) => this.paperShape(n))?.id
  }

  /** A note's hanging pin in world px, as drawn (through overrides). */
  pinWorld(noteId: string): Point | undefined {
    return this.pinOf(this.board(), noteId)
  }

  /** Where a new thread from `fromNoteId` would attach on `noteId` (its edge pin), world px. */
  landingWorld(noteId: string, fromNoteId: string): Point | undefined {
    return this.attachOf(this.board()).preview(noteId, fromNoteId)
  }

  /** Whether a pan is running or Space is held to pan. */
  get panning(): boolean {
    return this.pan !== null || this.spaceHeld
  }

  /** Call `fn` with the selected yarn's id (undefined for none) whenever it changes. */
  onYarnSelection(fn: (id: string | undefined) => void): () => void {
    this.yarnSelectionListeners.add(fn)
    return () => {
      this.yarnSelectionListeners.delete(fn)
    }
  }

  /** Select a yarn (clearing the note selection), or none. */
  selectYarn(id: string | null): void {
    if (id !== null) this.selectNote(null)
    this.setSelectedYarn(id ?? undefined)
  }

  /** Show or hide the thread being connected; its sag springs under `LIVE_KEY`. */
  setLiveThread(l: LiveThread | null): void {
    this.live = l
    if (l === null) this.motion.clearLive()
    else this.motion.setLive(l.from, l.to)
    this.updateGlow()
    this.requestYarn()
  }

  /** The pin under the hover (or the connect source), which glows: a hanging or an edge pin. */
  setHoverPin(noteId: string | null, edge?: EdgePin): void {
    const prev = this.hoverPin
    const same =
      noteId === null
        ? prev === null
        : prev !== null &&
          prev.noteId === noteId &&
          prev.edge?.yarnId === edge?.yarnId &&
          prev.edge?.segIndex === edge?.segIndex &&
          prev.edge?.end === edge?.end
    if (same) return
    this.hoverPin = noteId === null ? null : edge === undefined ? { noteId } : { noteId, edge }
    this.updateGlow()
    this.requestYarn()
  }

  /**
   * Create a blank note of `design` centred on world point `w`, on top, select it and open its
   * editor; its id, or undefined. Stamped by the store's clock.
   */
  createNoteAt(w: Point, design?: NoteDesign): string | undefined {
    const op = newNoteOp(w, this.topZ(), this.store.now(), design)
    // Marked before the commit, so a stamp that mounts inside it is pressed all the same; a refused
    // commit leaves a mark nothing takes (the ledger keeps 16).
    if (op.note.stamp === true) markPinned(op.note.id)
    try {
      this.store.commit([op], createOptions(op.note.id))
    } catch {
      return undefined
    }
    this.selectNote(op.note.id)
    this.beginEditing(op.note.id, undefined, true)
    announce(newNoteCopy(op.note.paper))
    return op.note.id
  }

  /**
   * A new note for the sidebar's "+", of the design chosen there: centred in the view, selected
   * and open for writing. Its id, or undefined.
   */
  createNoteAtCentre(design?: NoteDesign): string | undefined {
    return this.createNoteAt(this.placeNear(NEW_NOTE), design)
  }

  /**
   * Where a new note of `size` (world px) goes, as a centre: the middle of the view's free part
   * (`safeViewport`) when no paper is there, else the nearest spot around it, on a 24 px grid,
   * that keeps 12 px clear of every paper and stays in that part of the view (`freeSpot`: the
   * papers in view read from the index once, then at most `COVER_VISIT_MAX` near each spot).
   * With none free, the spot that covers least: bare paper costs its area, a note's text eight
   * times that, a pin far more, so a crowded view puts the note on gutters and corners. `avoid`: rects placed just now that the index does not
   * hold yet (the photos of one paste), kept clear as papers are.
   */
  placeNear(size: { w: number; h: number }, avoid: readonly Rect[] = []): Point {
    const cam = this.camera.get()
    const view = this.safeViewport()
    const tl = screenToWorld(cam, { x: view.x, y: view.y })
    const area = { x: tl.x, y: tl.y, w: view.w / cam.zoom, h: view.h / cam.zoom }
    const centre = { x: area.x + area.w / 2, y: area.y + area.h / 2 }
    const { notes } = this.board()
    const gap = PLACE_GAP_PX / cam.zoom
    // The papers in view, read from the index once for the whole search, each a paper, a text
    // box and a pin; the photos of this paste beside them. Past a sane count, the middle.
    const ids = this.index.notesIn(expandRect(area, gap + TILT_REACH))
    if (ids.length > PLACE_PAPERS_MAX) return centre
    const papers: CoverPaper[] = []
    for (const id of ids) {
      const stored = notes.get(id)
      if (stored === undefined || !this.focusMode.shown(id)) continue
      const n = this.overrides.effective(stored)
      const b = noteBounds(n, this.measuredH.get(id))
      papers.push({
        paper: paperBounds(this.paperShape(n)),
        text: { x: b.x + 26, y: b.y + 18, w: Math.max(0, b.w - 52), h: Math.max(0, b.h - 40) },
        pin: pinPosition(n),
      })
    }
    for (const a of avoid) papers.push({ paper: a, text: a, pin: null })
    const cost = coverCost(papers, {
      gap,
      textCost: PLACE_TEXT_COST,
      pinCost: PLACE_PIN_COST,
      cell: 256 / cam.zoom,
    }).of
    const step = PLACE_STEP_PX / cam.zoom
    return freeSpot({ centre, size, area, step, cost }) ?? centre
  }

  /**
   * The board is not the writer's to drive: its stage is inert (a screen lies over it), or it is
   * covered under a sheet (Settings). Its keys, ⌘K included, are then theirs.
   */
  get held(): boolean {
    return this.els.root.closest('[inert]') !== null || this.els.root.hasAttribute('data-covered')
  }

  /** The note being written on, or null. */
  get editing(): string | null {
    return this.edit?.noteId ?? null
  }

  /** Whether a press of the select tool or the marquee is under way (a drag, a resize, a band). */
  get pressing(): boolean {
    return this.toolPointerId !== null
  }

  /** Whether the last press of the select tool or the marquee travelled into a drag. */
  get pressTravelled(): boolean {
    return this.travelled
  }

  /**
   * Open the editor on a note (selecting it), with the caret where the rendered text is under
   * client point `caret`, or at the end. Not while a press is under way: a drag never turns into
   * editing. The editor shows once the note is mounted (overview mounts none). Returns whether
   * the note is now being edited.
   */
  startEditing(noteId: string, caret?: { clientX: number; clientY: number }): boolean {
    return this.beginEditing(noteId, caret, false)
  }

  /**
   * Whether a note with no text and no image is still wanted when its editor closes (a photo on
   * its way, a print waiting for one). Set by the canvas view; nothing is kept by default.
   */
  keepEmpty: (noteId: string) => boolean = () => false

  /**
   * Close the editor (only if it is on `noteId`, when given); the selection stays. Every
   * keystroke has been committed already. A note left with no text and no image is deleted: a
   * fresh one unrecorded, its creation's undo step dropped too, so nothing of it is left to undo;
   * one that had text before, as a recorded step with the session's typing (one undo brings it
   * back with its text). Either way the writing session's undo step ends here.
   */
  stopEditing(noteId?: string): void {
    const e = this.edit
    if (e === null || (noteId !== undefined && e.noteId !== noteId)) return
    // What the field holds first, a composition the browser has not ended yet included: a press
    // elsewhere comes before the blur that would end it, and the field is about to go.
    if (this.editor?.noteId === e.noteId) this.editor.handle.flush()
    this.edit = null
    this.view.setState({ editing: null })
    this.syncFocusMark()
    this.reorderSoon()
    // Whether it is empty is the store's to say, not a record drawn before a restore came in.
    this.takeNow([e.noteId])
    const n = this.board().notes.get(e.noteId)
    // A note with a ref keeps it with no text of its own.
    const empty = n !== undefined && n.text.trim() === '' && n.image === null && n.ref === undefined
    if (n !== undefined && empty && !this.keepEmpty(e.noteId)) {
      const key = textKey(e.noteId)
      const del = [{ op: 'note.delete' as const, id: e.noteId }]
      try {
        if (e.fresh) {
          this.store.commit(del, { coalesceKey: key, label: LABELS.delete, undo: 'skip' })
          this.history?.retract(key)
        } else this.store.commit(del, { coalesceKey: key, label: LABELS.delete })
      } catch {
        // Not deletable after all (it went meanwhile): nothing to tidy.
      }
    }
    this.history?.seal()
  }

  /** The mounted editor of note `noteId` (null: it unmounted), for flushing and focusing it. */
  registerEditor(noteId: string, handle: EditorHandle | null): void {
    if (handle !== null) this.editor = { noteId, handle }
    else if (this.editor?.noteId === noteId) this.editor = null
  }

  /** The editor's caret to the end of its text, the focus in it (a press beside the text). */
  private caretToEnd(): void {
    if (this.edit !== null && this.editor?.noteId === this.edit.noteId)
      this.editor.handle.focusEnd()
  }

  private beginEditing(
    noteId: string,
    caret: { clientX: number; clientY: number } | undefined,
    fresh: boolean,
  ): boolean {
    // The editor is seeded from the note drawn: the store's, taken now if not yet.
    this.takeNow([noteId])
    const n = this.board().notes.get(noteId)
    if (n === undefined || this.pressing) return false
    if (this.edit?.noteId === noteId) return true
    this.selectNote(noteId)
    const el = this.noteEls.get(noteId)
    const at = caret && el ? caretOffsetAt(el, caret.clientX, caret.clientY, n.text) : undefined
    const held = this.measuredH.get(noteId)
    this.edit = { noteId, fresh }
    this.view.setState({
      editing: {
        noteId,
        ...(at === undefined ? {} : { caret: at }),
        ...(held === undefined ? {} : { holdH: held }),
        heading: isHeading(parseNoteText(n.text)),
      },
    })
    this.syncFocusMark()
    // Overview mounts no notes, and lite text is too small to write in: ease in to the note
    // (its editor opens, focused, as it mounts). The cull keeps the edited note mounted.
    if (this.lodMode === 'overview' || (fresh && this.lodMode === 'lite')) this.easeTo(noteId)
    this.recullDue = true
    this.loop.request()
    return true
  }

  /**
   * Writing ended without the writer asking (zoomed out to overview, the note taken off the
   * board by a restore) while keys may still be coming: hold the board's keys until the typing pauses
   * (`KEY_HOLD_MS` with no key) or the pointer is pressed, so a Backspace meant for the text never
   * deletes the note and a letter never switches the tool.
   */
  private holdKeys(): void {
    this.keyHoldUntil = performance.now() + KEY_HOLD_MS
  }

  /** Whether a key now falls in the hold; each one held keeps the hold on a while longer. */
  private keysHeld(): boolean {
    const now = performance.now()
    if (now >= this.keyHoldUntil) return false
    this.keyHoldUntil = now + KEY_HOLD_MS
    return true
  }

  /** Ease the camera to centre note `noteId` at zoom 1. */
  private easeTo(noteId: string): void {
    const r = this.notesRect([noteId])
    if (r === null) return
    const zoom = 1
    const to = {
      x: r.x + r.w / 2 - this.viewport.width / 2 / zoom,
      y: r.y + r.h / 2 - this.viewport.height / 2 / zoom,
      zoom,
    }
    this.camera.animateTo(to, this.reducedMotion())
  }

  /** Install (or with null, remove) the hit-testing stage of the capture-phase dispatch. */
  setCaptureStage(stage: CaptureStage | null): void {
    this.stage = stage
  }

  /** What takes a card dragged across the seam (the open book's page); `seamOver`: hovering it. */
  private seamDrop: SeamDrop | null = null
  private seamOver = false
  /** A touch or pen press on a card waiting to offer Copy · Move (`SeamDrop.press`). */
  private cardHold: ReturnType<typeof setTimeout> | undefined = undefined
  /** Install (or with null, remove) the target beside the board that a card drag can end on. */
  setSeamDrop(t: SeamDrop | null): void {
    this.seamLeave()
    this.seamDrop = t
  }

  private seamLeave(): void {
    if (!this.seamOver) return
    this.seamOver = false
    this.seamDrop?.leave()
  }

  /** The select tool's drag with the pointer over the seam's target: the notes it moves. */
  private seamIds(e: PointerEvent): readonly string[] | null {
    if (this.seamDrop === null || this.toolActive !== this.selectTool) return null
    const ids = this.selectTool.dragged?.() ?? null
    return ids !== null && this.seamDrop.over(e.clientX, e.clientY) ? ids : null
  }

  /**
   * A book lies over the board (the writer's sheet): on a board past `pyramidAbove`, its far
   * view's card overview, every card of the view in one frame, is not drawn under it until the
   * pyramid draws it (or the book goes).
   * What was drawn before stays, dimmed under the sheet.
   */
  private underBook = false
  coverByBook(on: boolean): void {
    if (on === this.underBook) return
    this.underBook = on
    if (!on) this.requestYarn()
  }

  /** Ask for a yarn redraw next frame, e.g. after the dynamic sets changed. */
  requestYarn(): void {
    this.renderDue = true
    this.loop.request()
  }

  /** Draw these notes' pins and segments every frame instead of from the static cache. */
  setDynamicNotes(ids: Iterable<string>): void {
    const next = new Set(ids)
    if (sameSet(next, this.dynamicNotes)) return
    this.dynamicNotes.clear()
    for (const id of next) this.dynamicNotes.add(id)
    this.requestYarn()
  }

  /**
   * Select one note (or none): handles, the lifted shadow and Shift+2 follow it. Selecting
   * another note than the one being written on closes its editor.
   */
  selectNote(id: string | null): void {
    this.selectNotes(id === null ? [] : [id], 'replace', { bringIn: true })
  }

  /**
   * Change the selection by `ids`: `replace` makes them the whole selection, `add` joins them to
   * it, `toggle` flips each one (Shift-click). The last id given becomes the note the arrow keys
   * move on from. Unless the selection ends as the one note being written on, the editor closes.
   * Several selected notes are framed on the pin layer; one keeps the overlay's frame, with
   * handles. The selection set is replaced, never mutated.
   *
   * With focus on, a selected note is always shown. Notes outside the focus are left out (the
   * marquee, ⌘A and the arrows never take them), unless `bringIn`: then they are brought into
   * the focus first (`include`), so a note just made, a search jump or every copy a duplicate
   * made is selected and shown. O(ids), never over the board.
   */
  selectNotes(
    ids: Iterable<string>,
    mode: SelectMode = 'replace',
    o: { bringIn?: boolean } = {},
  ): void {
    let incoming = [...ids]
    const f = this.focusMode.state
    if (f !== null) {
      const hidden = incoming.filter((id) => !this.focusMode.shown(id))
      if (hidden.length > 0 && o.bringIn === true) {
        const { notes } = this.board()
        const next = withIncludes(
          f,
          hidden.filter((id) => notes.has(id)),
        )
        if (next !== f) this.setFocus(next, { fit: false })
      } else if (hidden.length > 0) {
        incoming = incoming.filter((id) => this.focusMode.shown(id))
      }
    }
    this.setSelectedYarn(undefined)
    this.wantFocus = undefined
    let next = nextSelection(this.selection, incoming, mode)
    if (this.edit !== null && !(next.size === 1 && next.has(this.edit.noteId))) {
      this.stopEditing()
      next = nextSelection(this.selection, incoming, mode)
    }
    const last = incoming.at(-1)
    if (last !== undefined && next.has(last)) this.primary = last
    this.applySelection(next)
  }

  /** Select nothing. */
  clearSelection(): void {
    this.selectNotes([], 'replace')
  }

  /**
   * Select every note on the board (⌘A): a command over the whole board, not a frame's work. The
   * store's board, even while catching up: the notes not drawn yet are on it too.
   * With focus on, every note the focus shows: its own set, never the board filtered.
   */
  selectAll(): void {
    const focus = this.focusMode.result
    this.selectNotes(focus?.notes.keys() ?? this.store.getState().notes.keys(), 'replace')
    this.announceSelection()
  }

  /** Say how many notes are selected, when it is several (one is named by its own label). */
  private announceSelection(): void {
    if (this.selection.size > 1) announce(selectedCopy(this.selection.size))
  }

  /** The note the arrow keys move on from: the last one selected, or any that still is. */
  private anchorNote(): string | undefined {
    if (this.primary !== undefined && this.selection.has(this.primary)) return this.primary
    return this.selection.values().next().value
  }

  private applySelection(next: ReadonlySet<string>): void {
    if (sameSet(next, this.selection)) return
    this.selection = next
    this.view.setState({ selected: next })
    // A note that kept the keyboard lets it go with the selection: focus is never left unmarked.
    const active = this.els.root.ownerDocument.activeElement
    if (active instanceof HTMLElement && active.matches('article[data-note-id]')) {
      if (!next.has(active.dataset.noteId ?? '')) active.blur()
    }
    this.syncFocusMark()
    // Overview outlines the selection on the pin layer.
    this.requestYarn()
  }

  /** The one selected note, when exactly one is. */
  private soleSelected(): string | undefined {
    return this.selection.size === 1 ? this.selection.values().next().value : undefined
  }

  /** The marquee's rubber band over a world rect, drawn in viewport px; none for null. */
  private showBand(r: Rect | null): void {
    if (r === null) {
      this.overlay.setBand(null)
      return
    }
    const map = this.mapper()
    const a = map({ x: r.x, y: r.y })
    const b = map({ x: r.x + r.w, y: r.y + r.h })
    this.overlay.setBand({ x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y })
  }

  /**
   * The selection frame in the focus ink while the selected note has the keyboard: written on,
   * or focused from the keyboard (Esc out of the editor). One selected note has the overlay's
   * frame; among several, the frame the pin layer draws for the focused one takes the ink.
   */
  private syncFocusMark = (): void => {
    const sole = this.soleSelected()
    const active = this.els.root.ownerDocument.activeElement
    const el =
      active instanceof HTMLElement && active.matches('article[data-note-id]') ? active : null
    const keyed = el !== null && this.focusVisible(el)
    this.overlay.setFocus(
      sole !== undefined && (this.edit?.noteId === sole || (keyed && el?.dataset.noteId === sole)),
    )
    const id = el?.dataset.noteId
    const framed =
      this.selection.size > 1 && keyed && id !== undefined && this.selection.has(id)
        ? id
        : undefined
    if (framed !== this.focusedNote) {
      this.focusedNote = framed
      this.requestYarn()
    }
  }

  /** Whether `el` has the focus as a keyboard user does (where `:focus-visible` is unknown: yes). */
  private focusVisible(el: HTMLElement): boolean {
    if (el !== el.ownerDocument.activeElement) return false
    try {
      return el.matches(':focus-visible')
    } catch {
      return true
    }
  }

  /**
   * A note took the keyboard. Reached by Tab or the arrow keys (not a press, which selects on its
   * own), it joins the selection when it is not in it, alone: Enter then writes on it. One that is
   * already selected leaves the selection as it is, several included.
   */
  private onFocusIn = (e: FocusEvent): void => {
    this.syncFocusMark()
    const el = e.target
    if (!(el instanceof HTMLElement) || !el.matches('article[data-note-id]')) return
    const id = el.dataset.noteId
    if (id === undefined || this.selection.has(id) || this.pressing) return
    if (this.focusVisible(el)) this.selectNote(id)
  }

  private onFocusOut = (e: FocusEvent): void => {
    this.syncFocusMark()
    // The DOM order a held keyboard postponed is settled once a note lets it go.
    if (e.target instanceof HTMLElement && e.target.matches('article[data-note-id]')) {
      this.reorderSoon()
    }
  }

  /**
   * Call `fn` with the id of every note that leaves the board (deleted, or taken off by a
   * restore), after the runtime has let go of it: the editor closes on it. Returns the
   * unsubscribe.
   */
  onNoteRemoved(fn: (id: string) => void): () => void {
    this.removedListeners.add(fn)
    return () => {
      this.removedListeners.delete(fn)
    }
  }

  /** Overview: outline the card under the pointer (or none). */
  setHoverCard(id: string | undefined): void {
    if (id === this.hoverCard) return
    this.hoverCard = id
    if (this.lodMode === 'overview') this.requestYarn()
  }

  /** What focus mode shows, or null: the whole board. */
  get focus(): FocusResult | null {
    return this.focusMode.result
  }

  /** What focus mode was asked for (the URL hash holds it), or null. */
  get focusState(): FocusState | null {
    return this.focusMode.state
  }

  /** Focus mode's state and result as a store, for the focus chip to render from. */
  get focusView(): StoreApi<FocusView> {
    return this.focusMode.view
  }

  /** Focus mode's membership, patched per commit; null until focus is first used (tests). */
  get focusMembership(): Membership | null {
    return this.focusMode.liveMembership
  }

  /** How often focus mode built its membership from the whole board (tests, the bench). */
  get membershipBuilds(): number {
    return this.focusMode.membershipBuilds
  }

  /** What the yarn layer draws of the focus now; null with the whole board shown. */
  get focusPaint(): FocusPaint | null {
    return this.focusMode.paint
  }

  /** Call `fn` whenever the focus asked for changes (null: it ended); returns the unsubscribe. */
  onFocusChange(fn: (f: FocusState | null) => void): () => void {
    return this.focusMode.view.subscribe((v, prev) => {
      if (v.state !== prev.state) fn(v.state)
    })
  }

  /**
   * Focus on `f` (null: the whole board again). Ids not on the board are dropped. The notes
   * leaving the view fade out (250 ms; at once under reduced motion or `instant`) and become
   * inert and hidden from assistive tech, and the camera eases to fit what is shown (unless
   * `fit` is false); leaving focus eases it back to where it was before. Positions never change
   * and nothing is committed.
   */
  setFocus(f: FocusState | null, opts: { instant?: boolean; fit?: boolean } = {}): void {
    // Seeds and notes brought in (Bring in…) that the catch-up has not reached count as they are.
    if (f !== null) this.takeNow([...f.seeds, ...f.include])
    const next = f === null ? null : normaliseFocus(f, this.board())
    const was = this.focusMode.state
    if (sameFocus(was, next)) return
    if (was === null) this.focusReturn = this.camera.target()
    const instant = opts.instant === true || this.reducedMotion()
    this.focusMode.set(next, !instant)
    this.afterFocusChange()
    const back = this.focusReturn
    if (next === null) this.focusReturn = null
    if (opts.fit === false) return
    const to = next === null ? back : this.focusCamera(this.focusMode.result?.notes, next.seeds)
    if (to === null) return
    if (instant) this.camera.set(to)
    else this.camera.animateTo(to, false)
  }

  /** Focus on the selection at depth 1 (F, the sidebar's Focus); false with none selected. */
  focusSelection(): boolean {
    if (this.selection.size === 0) return false
    this.setFocus({ seeds: [...this.selection], depth: 1, include: [] })
    return true
  }

  /**
   * The loose end under viewport point `screen` (its stub, within the yarn's hit tolerance), or
   * undefined. Found through the index around the point, so it costs the threads there only.
   */
  looseEndAt(screen: Point): LooseEndHit | undefined {
    const focus = this.focusMode.result
    if (focus === null || this.lodMode === 'overview') return undefined
    const camera = this.drawnCamera()
    const w = screenToWorld(camera, screen)
    if (!(Number.isFinite(w.x) && Number.isFinite(w.y))) return undefined
    const s = this.board()
    const tol = yarnHitTolerancePx(camera.zoom) / camera.zoom
    let best: { hit: LooseEndHit; d: number } | undefined
    for (const ref of this.index.segmentsIn(expandRect({ x: w.x, y: w.y, w: 0, h: 0 }, tol))) {
      const a = focus.notes.has(ref.aNoteId)
      if (a === focus.notes.has(ref.bNoteId)) continue
      const d = distanceToPolyline(
        w,
        looseStub(this.curve(s, ref, 0.25 / camera.zoom), a ? 'a' : 'b'),
      )
      if (!(d <= tol) || (best !== undefined && d >= best.d)) continue
      const [noteId, toward] = a ? [ref.aNoteId, ref.bNoteId] : [ref.bNoteId, ref.aNoteId]
      best = { hit: { yarnId: ref.yarnId, noteId, toward }, d }
    }
    return best?.hit
  }

  /** Whether a segment is drawn whole, so it takes presses: with focus on, both notes shown. */
  private segmentShown(ref: SegmentRef): boolean {
    return this.focusMode.shown(ref.aNoteId) && this.focusMode.shown(ref.bNoteId)
  }

  /** The index as hit-testing sees it: with focus on, hidden notes and their threads left out. */
  private focusIndex(): Pick<SpatialIndex, 'notesIn' | 'segmentsIn'> {
    if (this.focusMode.state === null) return this.index
    return {
      notesIn: (r) => this.index.notesIn(r).filter((id) => this.focusMode.shown(id)),
      segmentsIn: (r) => this.index.segmentsIn(r).filter((ref) => this.segmentShown(ref)),
    }
  }

  /**
   * After the focus changed: writing on a note now hidden ends (what the field holds is kept),
   * and no selection, selected thread or hovered pin is left on a hidden note.
   */
  private afterFocusChange(): void {
    const shown = (id: string) => this.focusMode.shown(id)
    if (this.edit !== null && !shown(this.edit.noteId)) {
      this.stopEditing()
      this.holdKeys()
    }
    this.pruneHidden()
    // Which papers cover which pins follows which notes are shown.
    this.pinCover = null
    this.recullDue = true
    this.renderDue = true
    this.loop.request()
  }

  /** No selection, selected thread or hovered pin on a hidden note. Commits nothing. */
  private pruneHidden(): void {
    const shown = (id: string) => this.focusMode.shown(id)
    if ([...this.selection].some((id) => !shown(id))) {
      // Through `applySelection`, so the pin-layer frames and the keyboard follow the selection.
      this.applySelection(new Set([...this.selection].filter(shown)))
    }
    const y = this.selectedYarnId
    const yarn = y === undefined ? undefined : this.board().yarns.get(y)
    if (yarn !== undefined && !yarn.noteIds.every(shown)) this.setSelectedYarn(undefined)
    if (this.hoverPin !== null && !shown(this.hoverPin.noteId)) this.setHoverPin(null)
    if (this.focusMode.state === null) delete this.els.root.dataset.loose
  }

  /** A loose end under a press: focus expands across it (`expandLooseEnd`). */
  private pressLooseEnd(screen: Point): boolean {
    const f = this.focusMode.state
    const end = f === null ? undefined : this.looseEndAt(screen)
    if (f === null || end === undefined) return false
    this.loosePressAt = performance.now()
    this.setFocus(expandLooseEnd(f, end.toward))
    return true
  }

  /** A loose end under a hovering mouse takes the pointer cursor. */
  private hoverLooseEnd(e: PointerEvent): void {
    const { dataset } = this.els.root
    const on =
      this.focusMode.state !== null &&
      e.pointerType !== 'touch' &&
      e.buttons === 0 &&
      !this.panning &&
      this.looseEndAt(this.toViewport(e.clientX, e.clientY)) !== undefined
    if (on === (dataset.loose !== undefined)) return
    if (on) dataset.loose = ''
    else delete dataset.loose
  }

  /**
   * Abandon any gesture (drag, resize, note press, connect): overrides dropped, notes restored,
   * the live thread gone, nothing committed.
   */
  cancelGesture(): void {
    this.setPressed(null)
    const id = this.toolPointerId
    this.toolPointerId = null
    this.toolActive = null
    this.lastTool = null
    // A pointer-up that never came leaves the capture set; later presses would hit the root.
    if (id !== null) releaseCapture(this.els.root, id)
    this.seamLeave()
    clearTimeout(this.cardHold)
    this.selectTool.cancel()
    this.marqueeTool.cancel()
    this.overlay.armBand(null)
    this.stage?.cancel()
  }

  /**
   * The part of the viewport a fit frames notes in (viewport px): what the app's chrome leaves
   * free, with `CHROME_GAP_PX` of air. The chrome says where it is (`data-chrome="left"`: the
   * sidebar, `"bottom"`: the mini-bar); `chip` keeps room for the focus chip at the foot, which
   * mounts only once focus is on. Read once per fit, never per frame.
   */
  safeViewport(o: { chip?: boolean } = {}): Rect {
    const { width, height } = this.viewport
    const box = this.els.root.getBoundingClientRect()
    let left = 0
    let barTop = 0
    for (const el of this.els.root.querySelectorAll<HTMLElement>('[data-chrome]')) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      if (el.dataset.chrome === 'left') left = Math.max(left, r.right - box.left + CHROME_GAP_PX)
      else if (el.dataset.chrome === 'bottom') barTop = Math.max(barTop, box.bottom - r.top)
    }
    let bottom = barTop > 0 ? barTop + CHROME_GAP_PX : 0
    if (o.chip) {
      const base = barTop > 0 ? barTop + CHIP_OVER_BAR_PX : CHIP_OFF_EDGE_PX
      bottom = Math.max(bottom, base + CHIP_ROOM_PX)
    }
    // Never less than half the view, whatever the chrome claims.
    left = Math.min(left, width / 2)
    bottom = Math.min(bottom, height / 2)
    return { x: left, y: 0, w: width - left, h: height - bottom }
  }

  /**
   * The camera fitting `r` into the safe part of the view (`safeViewport`), with padding to
   * spare (less on a small screen), at most `maxZoom`.
   */
  private fitSafe(r: Rect | null, maxZoom = ZOOM_MAX): Camera {
    const area = this.safeViewport()
    return fitRectIn(r, area, fitPadding(area), maxZoom)
  }

  /**
   * Where focus takes the camera: the shown notes fitted into the safe view at reading size
   * (`FOCUS_ZOOM`). A cluster too big for that, at the floor, centres the focused notes (the
   * seeds) for the user to pan from.
   */
  private focusCamera(shown: Iterable<string> | undefined, seeds: readonly string[]): Camera {
    const area = this.safeViewport({ chip: true })
    const pad = fitPadding(area)
    const min = this.viewport.width <= PHONE_MAX_WIDTH ? FOCUS_PHONE_MIN : FOCUS_ZOOM.min
    const all = this.notesRect(shown)
    const cam = fitRectIn(all, area, pad, FOCUS_ZOOM.max, min)
    if (all === null || cam.zoom > min) return cam
    const fits = Math.min((area.w - 2 * pad) / all.w, (area.h - 2 * pad) / all.h)
    if (fits >= min) return cam
    return fitRectIn(this.notesRect(seeds), area, pad, min, min)
  }

  /** The camera the board opened fitted at ({@link initialCamera}), while it is still there. */
  private openFit: Camera | null = null

  private initialCamera(): Camera {
    // A board opens at no more than 100%: a new board's lone welcome note (or an empty board)
    // is not blown up to fill the view, so there is cork around it.
    const fit = () =>
      this.frame === null
        ? this.fitSafe(this.notesRect(), OPEN_ZOOM_MAX)
        : fitRect(this.frame, this.viewport)
    const s = this.start
    // While the board opens, the notes not yet in may be the ones this view shows.
    if (s !== null && (this.opening || !this.blank(s))) return s
    const fitted = fit()
    this.openFit = this.frame === null ? fitted : null
    return fitted
  }

  /** A remembered view that shows no note at all (they moved or went elsewhere) is blank cork. */
  private blank(c: Camera): boolean {
    return (
      this.board().notes.size > 0 &&
      this.index.notesIn(visibleWorldRect(c, this.viewport, 0)).length === 0
    )
  }

  /**
   * The whole board is in. A view opened where no note is after all, and not moved since, fits
   * the notes instead, as a board opened whole would have.
   */
  opened(): void {
    if (!this.opening) return
    this.opening = false
    const s = this.start
    if (s === null || this.camera.moving || !sameCamera(this.camera.get(), s)) return
    if (this.blank(s)) {
      this.camera.set(this.fitSafe(this.notesRect(), OPEN_ZOOM_MAX))
    }
  }

  /** World rect of the given notes (all by default), using measured heights; null when none. */
  notesRect(ids?: Iterable<string>): Rect | null {
    const { notes } = this.board()
    const rects: Rect[] = []
    for (const id of ids ?? notes.keys()) {
      const n = notes.get(id)
      if (n) rects.push(noteBounds(n, this.measuredH.get(id)))
    }
    return unionRects(rects)
  }

  /** Record a note's rendered height (world px). */
  measured(id: string, h: number): void {
    if (!(Number.isFinite(h) && h > 0)) return
    const before = this.measuredH.get(id)
    if (before === h) return
    this.measuredH.set(id, h)
    const note = this.board().notes.get(id)
    if (note === undefined) return
    if (Math.max(note.h, before ?? 0) !== Math.max(note.h, h)) {
      this.measuredVersion++
      // A gesture's note is re-indexed once, by its commit.
      if (!this.overrides.has(id)) this.pendingNotes.add(id)
      this.loop.request()
    }
  }

  /** The motion pref, with "system" following `prefers-reduced-motion` live. */
  reducedMotion(): boolean {
    return isReducedMotion(prefsStore.getState(), this.reducedMq?.matches ?? false)
  }

  /** Run a keyboard command; zooms and fits ease unless motion is reduced. */
  run(cmd: Exclude<KeyCommand, 'panHold'>): void {
    const reduced = this.reducedMotion()
    const base = this.camera.target()
    const centre = { x: this.viewport.width / 2, y: this.viewport.height / 2 }
    let next: Camera | null = null
    if (cmd === 'zoomIn') next = zoomAt(base, centre, base.zoom * KEY_ZOOM_STEP)
    else if (cmd === 'zoomOut') next = zoomAt(base, centre, base.zoom / KEY_ZOOM_STEP)
    else if (cmd === 'fitAll') next = this.fitSafe(this.notesRect())
    else if (this.selection.size > 0) next = this.fitSafe(this.notesRect(this.selection))
    if (next) this.camera.animateTo(next, reduced)
  }

  /** Jump to `zoom` centred on a note; false for an unknown note or an unusable zoom. */
  focusNote(noteId: string, zoom: number): boolean {
    // A note the catch-up has not reached is found where the store has it.
    this.takeNow([noteId])
    const r = this.notesRect([noteId])
    if (r === null || !(Number.isFinite(zoom) && zoom > 0)) return false
    const z = clampZoom(zoom)
    this.camera.set({
      x: r.x + r.w / 2 - this.viewport.width / 2 / z,
      y: r.y + r.h / 2 - this.viewport.height / 2 / z,
      zoom: z,
    })
    return true
  }

  /** Viewport-relative CSS px of a client-space point. */
  toViewport(clientX: number, clientY: number): Point {
    return { x: clientX - this.origin.x, y: clientY - this.origin.y }
  }

  dispose(): void {
    this.disposed = true
    this.catching = null
    if (this.pyramidWake !== null) clearTimeout(this.pyramidWake)
    this.cancelGesture()
    clearTimeout(this.nudgeSaid)
    clearTimeout(this.longPress)
    this.edit = null
    for (const fn of this.cleanups.splice(0)) fn()
    this.focusMode.dispose()
    this.merge.dispose()
    this.overlay.dispose()
    this.camera.dispose()
    this.cork.dispose()
    this.tied.dispose()
    this.edgeSides.dispose()
    this.pyramid?.dispose()
    this.pyramid = null
  }

  private apply(c: Camera): void {
    const dpr = dprNow()
    if (needsRebase(c, this.viewport, this.anchorPt)) this.rebase(anchorFor(c, this.viewport))
    const a = this.anchorPt
    const s = this.els.world.style
    const transform = cameraTransform(c, dpr, a)
    if (transform !== this.lastTransform) {
      this.lastTransform = transform
      s.transform = transform
    }
    // The cork's phase only needs the world origin's screen position modulo a tile, which world
    // doubles give to ~1e-8 px even at the coordinate limit.
    const o = anchorScreen(c, a, dpr)
    this.cork.update(
      c.zoom,
      o.x - a.x * c.zoom,
      o.y - a.y * c.zoom,
      this.viewport,
      this.camera.moving,
    )
    const willChange = this.camera.moving ? 'transform' : 'auto'
    if (willChange !== this.lastWillChange) {
      this.lastWillChange = willChange
      s.willChange = willChange
    }
    this.retrack()
  }

  /**
   * Move the floating origin to `a` within this apply, outside React: every mounted note's
   * transform is rewritten here (through the gesture overrides), and the handles, the yarn and
   * the pins (their cache redrawn) follow later in this same frame, so no layer pairs the old
   * anchor with the new transform. Notes read the anchor whenever they next render, so React
   * writes the same values then.
   */
  private rebase(a: Point): void {
    this.anchorPt = a
    const s = this.board()
    const { tilt: rotation } = prefsStore.getState()
    for (const [id, el] of this.noteEls) {
      const n = s.notes.get(id)
      if (n !== undefined)
        el.style.transform = noteStyle(this.overrides.effective(n), rotation, a).transform
    }
    this.styledVersion = -1
    this.yarn.invalidateStatic()
    this.renderDue = true
  }

  /** A camera move under a still pointer: re-run the active tool there, so a drag stays put. */
  private retrack(): void {
    const last = this.lastTool
    if (last === null || this.toolActive === null) return
    const world = screenToWorld(this.drawnCamera(), last.screen)
    if (world.x === last.world.x && world.y === last.world.y) return
    const p = { ...last, world }
    this.lastTool = p
    this.toolActive.pointerMove(p)
  }

  /**
   * A group drag moves notes into view from where the index holds them: once the delta has
   * moved a quarter of the viewport since the last cull (as a pan would), or the drag has ended,
   * cull again.
   */
  private recullForGroup(): void {
    const g = this.overrides.group
    const last = this.cullMove
    if (g === null) {
      if (last !== null) this.recullDue = true
      return
    }
    const dx = Math.abs(g.dx - (last?.dx ?? 0)) * this.camera.get().zoom
    const dy = Math.abs(g.dy - (last?.dy ?? 0)) * this.camera.get().zoom
    if (
      dx > CULL.recullMoveFrac * this.viewport.width ||
      dy > CULL.recullMoveFrac * this.viewport.height
    ) {
      this.recullDue = true
    }
  }

  /**
   * The notes a gesture holds that are in view: those with an override of their own, and the
   * group's members among the culled notes. Bounded by the view, whatever the group's size.
   */
  private heldIds(): Set<string> {
    const ids = new Set(this.overrides.ids())
    const g = this.overrides.group
    if (g !== null) for (const id of this.visibleNotes) if (g.ids.has(id)) ids.add(id)
    return ids
  }

  /**
   * Overridden notes whose paper as drawn may touch world rect `r`: those with an override of
   * their own, and the group's members that the index finds there once the group's move is
   * taken back (it still holds them where they were). A query, not a walk of the group.
   */
  private overriddenNear(r: Rect): string[] {
    const out = new Set(this.overrides.ids())
    const g = this.overrides.group
    if (g !== null) {
      const there = { x: r.x - g.dx, y: r.y - g.dy, w: r.w, h: r.h }
      for (const id of this.index.notesIn(there)) if (g.ids.has(id)) out.add(id)
    }
    return [...out]
  }

  /**
   * Whether note `id`'s hanging pin is hidden: it lies on the paper of a higher note that is
   * shown, and no thread end is tied at it (a cord must end on brass). Answered through the
   * spatial index around the pin, and kept per note until paper moves (the attachment `attach`,
   * which the board, the overrides, the heights and the tilt key): a pan asks nothing again, a
   * frame of a drag asks only for the pins it draws live.
   */
  private pinCovered(s: BoardState, attach: Attach, id: string): boolean {
    if (this.pinCover?.key !== attach) this.pinCover = { key: attach, covered: new Map() }
    const kept = this.pinCover.covered.get(id)
    if (kept !== undefined) return kept
    const covered = this.pinUnderPaper(s, attach, id)
    this.pinCover.covered.set(id, covered)
    return covered
  }

  /**
   * The papers that may cover a pin at `p`: at most `PIN_COVER_READ` from the index around it
   * (`notesInUpTo`, so a pin on a deep pile reads a bounded few), and the papers a gesture holds
   * away from their indexed place.
   */
  private coverCandidates(p: Point): Iterable<string> {
    const near = expandRect({ x: p.x, y: p.y, w: 0, h: 0 }, TILT_REACH)
    return new Set([
      ...this.index.notesInUpTo(near, PIN_COVER_READ + 1),
      ...this.overriddenNear(near),
    ])
  }

  private pinUnderPaper(s: BoardState, attach: Attach, id: string): boolean {
    const stored = s.notes.get(id)
    if (stored === undefined) return false
    const n = this.overrides.effective(stored)
    for (const e of this.topology.byNote.get(id) ?? []) {
      if (attach.sharedPin(e.ref, e.end) === null) return false
    }
    const p = pinPosition(n)
    let read = 0
    for (const o of this.coverCandidates(p)) {
      if (o === id || !this.focusMode.shown(o)) continue
      // A pin on a deep pile: past a few papers read, it is shown (a stray pin, not a lost one).
      if (read++ >= PIN_COVER_READ) return false
      const m = s.notes.get(o)
      if (m === undefined) continue
      const top = this.overrides.effective(m)
      // Above in paint order (`inPaintOrder`: z, then id), as the board draws the papers.
      const above = top.z > n.z || (top.z === n.z && top.id > n.id)
      if (above && paperContains(this.paperShape(top), p)) return true
    }
    return false
  }

  /** A note's hanging pin where it is drawn: through any gesture override. */
  private pinOf(s: BoardState, noteId: string): Point | undefined {
    const n = s.notes.get(noteId)
    return n && pinPosition(this.overrides.effective(n))
  }

  /**
   * Edge-pin attachment as drawn: through the gesture overrides, at displayed heights and, with
   * the tilt pref, turned. Kept until the board, the overrides, a height or the pref changes.
   */
  private attachOf(s: BoardState): Attach {
    const rotation = prefsStore.getState().tilt
    const c = this.attachCache
    const topo = this.topology
    if (
      c !== null &&
      c.s === s &&
      c.topo === topo &&
      c.overrides === this.overrides.version &&
      c.measured === this.measuredVersion &&
      c.rotation === rotation
    ) {
      return c.attach
    }
    const frames = boardFrames(s.notes, {
      rotation,
      heightOf: (n) => Math.max(n.h, this.measuredH.get(n.id) ?? 0),
      effective: (n) => this.overrides.effective(n),
    })
    const attach = createAttach(topo, frames)
    this.attachCache = {
      s,
      topo,
      overrides: this.overrides.version,
      measured: this.measuredVersion,
      rotation,
      attach,
    }
    return attach
  }

  /** A segment's flattened world curve at its current sag; empty when a note is gone. */
  private curve(s: BoardState, ref: SegmentRef, tolerance: number): Point[] {
    const e = this.attachOf(s).ends(ref)
    if (e === undefined) return []
    return flattenBezier(segmentBezier(e.a, e.b, this.motion.sagOf(ref, e.a, e.b)), tolerance)
  }

  /** A note's paper as drawn (`n` already through overrides): measured rect, pin, rotation. */
  private paperShape(n: Note): PaperShape {
    return {
      rect: noteBounds(n, this.measuredH.get(n.id)),
      pivot: pinPosition(n),
      deg: prefsStore.getState().tilt ? noteRotationDeg(n) : 0,
    }
  }

  private paperOf(s: BoardState, id: string): (PaperShape & { z: number }) | undefined {
    const stored = s.notes.get(id)
    if (stored === undefined) return undefined
    const n = this.overrides.effective(stored)
    return { ...this.paperShape(n), z: n.z }
  }

  /** Notes above a segment whose paper (through overrides) its world polyline `pts` crosses. */
  private occludersOf(s: BoardState, ref: SegmentRef, pts: readonly Point[]): string[] {
    const a = s.notes.get(ref.aNoteId)
    const b = s.notes.get(ref.bNoteId)
    const box = polylineBounds(pts)
    if (a === undefined || b === undefined || box === null) return []
    const near = expandRect(box, OCCLUDER_PAD)
    const ids = new Set(this.index.notesIn(near))
    for (const id of this.overriddenNear(near)) ids.add(id)
    const candidates: Note[] = []
    for (const id of ids) {
      const n = s.notes.get(id)
      // A hidden note's paper covers nothing.
      if (n !== undefined && this.focusMode.shown(id)) candidates.push(this.overrides.effective(n))
    }
    return segmentOccluders(
      { aNote: this.overrides.effective(a), bNote: this.overrides.effective(b), pts },
      candidates,
      (n) => expandRect(paperBounds(this.paperShape(n)), OCCLUDER_PAD),
    )
  }

  /**
   * `over-fix` during a gesture: the static segments a moved note now lies across (and above),
   * so they are drawn each frame with its erase instead of from the cache. Recomputed only when
   * the overrides change.
   */
  private updateCoverKeys(s: BoardState, layer: LayerMode): void {
    if (layer !== 'over-fix' || this.overrides.size === 0) {
      if (this.coverKeys.size > 0) this.coverKeys = new Set()
      this.coverVersion = -1
      return
    }
    if (this.coverVersion === this.overrides.version) return
    this.coverVersion = this.overrides.version
    const keys = new Set<string>()
    for (const id of this.heldIds()) {
      const stored = s.notes.get(id)
      if (stored === undefined) continue
      const n = this.overrides.effective(stored)
      const r = expandRect(paperBounds(this.paperShape(n)), OCCLUDER_PAD)
      for (const ref of this.index.segmentsIn(r)) {
        if (this.dynamicNotes.has(ref.aNoteId) || this.dynamicNotes.has(ref.bNoteId)) continue
        const level = Math.max(s.notes.get(ref.aNoteId)?.z ?? 0, s.notes.get(ref.bNoteId)?.z ?? 0)
        if (n.z > level && polylineIntersectsRect(this.curve(s, ref, 0.5), r)) keys.add(ref.key)
      }
    }
    this.coverKeys = keys
  }

  private setSelectedYarn(id: string | undefined): void {
    if (id === this.selectedYarnId) return
    this.selectedYarnId = id
    for (const fn of this.yarnSelectionListeners) fn(id)
    this.requestYarn()
  }

  private updateGlow(): void {
    const next = new Set<string>()
    if (this.hoverPin !== null && this.hoverPin.edge === undefined) next.add(this.hoverPin.noteId)
    // A connect about to be tied at a note's hanging pin lights that pin.
    if (this.live?.shared === 'hanging' && this.live.targetNoteId !== undefined) {
      next.add(this.live.targetNoteId)
    }
    if (sameSet(next, this.glow)) return
    this.glow = next
    this.requestYarn()
  }

  /** The top z on the board: the store's (a new note goes above every note, drawn yet or not). */
  private topZ(): number {
    return topZOf(this.store.getState())
  }

  /**
   * A moved note's edge pins move, and so do its neighbours' (their pins face it): every segment
   * touching the moved notes or their neighbours is retargeted, and the neighbours' other
   * segments are drawn dynamic for the gesture.
   */
  private onOverrides = (): void => {
    const ids = this.heldIds()
    this.setDynamicNotes(ids)
    this.recullForGroup()
    const s = this.board()
    const topo = this.topology
    const touched = withNeighbours(topo, [...this.overrideIds, ...ids])
    this.overrideIds = ids
    const keys = new Set<string>()
    if (ids.size > 0) {
      for (const ref of this.motion.segmentsOf(withNeighbours(topo, ids))) {
        if (!ids.has(ref.aNoteId) && !ids.has(ref.bNoteId)) keys.add(ref.key)
      }
    }
    // A thread with an end in the group moves with it, whether or not that end is in view (a
    // thread across the view from a member outside it): drawn live, not from the static cache.
    // Only the culled threads are looked at.
    const g = this.overrides.group
    const ofGroup: SegmentRef[] = []
    if (g !== null) {
      for (const ref of this.segments) {
        if (g.ids.has(ref.aNoteId) || g.ids.has(ref.bNoteId)) {
          keys.add(ref.key)
          ofGroup.push(ref)
        }
      }
    }
    if (!sameSet(keys, this.neighbourKeys)) {
      this.neighbourKeys = keys
      this.renderDue = true
    }
    const endsOf = (ref: SegmentRef) => this.attachOf(s).ends(ref)
    const followedRefs = this.motion.segmentsOf(touched)
    this.motion.retarget(followedRefs, endsOf)
    // The threads of the group the springs above do not follow (to a member out of view) settle
    // at their new rest as the drag goes, so a spring never sleeps at the old sag to be woken at
    // the drop and swing from there. O(culled).
    if (ofGroup.length > 0) {
      const followed = new Set(followedRefs.map((ref) => ref.key))
      this.motion.retarget(
        ofGroup.filter((ref) => !followed.has(ref.key)),
        endsOf,
        { snap: true },
      )
    }
    this.loop.request()
  }

  /**
   * Step the springs and animations. Every segment motion moved stays in `dynamicKeys` until
   * all motion has stopped, so the static cache is redrawn once when it settles, not per spring.
   */
  private motionFrame = (dt: number, now: number): boolean => {
    const active = this.motion.step(dt, now)
    if (active) for (const ref of this.motion.activeRefs()) this.motionRefs.set(ref.key, ref)
    else this.motionRefs.clear()
    const keys = new Set(this.motionRefs.keys())
    if (!sameSet(keys, this.dynamicKeys)) {
      this.dynamicKeys.clear()
      for (const k of keys) this.dynamicKeys.add(k)
      this.renderDue = true
    }
    // One more draw after motion stops, to clear the last ghost or draw-in frame.
    if (active || this.motionActive) this.renderDue = true
    this.motionActive = active
    return active
  }

  /** Step focus mode's fade: the yarn layer blits its two caches at the new opacity. */
  private focusFrame = (_dt: number, now: number): boolean => {
    const { changed, more } = this.focusMode.frame(now)
    if (changed) this.renderDue = true
    return more
  }

  /** Write overridden notes' styles (restoring released ones) and place the handles. */
  private gestureFrame = (): boolean => {
    const s = this.board()
    const rotation = prefsStore.getState().tilt
    if (this.styled.size > 0 || this.overrides.size > 0) {
      const changed = this.overrides.version !== this.styledVersion
      this.styledVersion = this.overrides.version
      for (const [id, el] of this.styled) {
        if (this.overrides.has(id)) continue
        this.styled.delete(id)
        const n = s.notes.get(id)
        if (n && this.noteEls.get(id) === el) writeNoteStyle(el, n, rotation, false, this.anchorPt)
      }
      for (const id of this.heldIds()) {
        const el = this.noteEls.get(id)
        const n = s.notes.get(id)
        if (el === undefined || n === undefined) continue
        if (!changed && this.styled.get(id) === el) continue
        const lifted =
          this.overrides.get(id)?.z !== undefined || this.overrides.group?.ids.has(id) === true
        writeNoteStyle(el, this.overrides.effective(n), rotation, lifted, this.anchorPt)
        this.styled.set(id, el)
      }
    }
    const selected = this.soleSelected()
    const n = selected === undefined ? undefined : s.notes.get(selected)
    // Overview has no handles: cards are a few px, and the renderer outlines the selection. The
    // level this frame draws at, which `yarnFrame` switches to later in the same frame.
    const lod = nextLod(this.lodMode, this.camera.get().zoom)
    this.overlay.update(
      n === undefined || lod === 'overview'
        ? null
        : overlayFrame(
            this.overrides.effective(n),
            this.measuredH.get(n.id),
            this.camera.get(),
            this.currentDpr,
            rotation,
            this.anchorPt,
          ),
    )
    return false
  }

  /**
   * Whether the last cull still stands after notes `ids` changed from `before` to `after` (and the
   * index followed them), their threads' segments `segs` with them: each is still in view or out
   * of it as it was, at the same z and in the same reading place among the mounted notes (unless a
   * note holds the keyboard, when the DOM order is kept anyway), and so is each segment. Then
   * the cull would give what it gave, and need not run (it is O(view): 10–15 ms at 3,600 notes
   * mounted). O(changed). Never in overview, nor during a group drag or a catch-up, which cull
   * their own way.
   */
  private cullStands(
    before: BoardState['notes'],
    after: BoardState['notes'],
    ids: Iterable<string>,
    segs: readonly SegmentRef[],
  ): boolean {
    const last = this.lastCull
    if (
      last === null ||
      this.recullDue ||
      this.lodMode === 'overview' ||
      this.overrides.group !== null ||
      this.catching !== null ||
      last.viewport.width !== this.viewport.width ||
      last.viewport.height !== this.viewport.height
    )
      return false
    const r = cullRect(last.c, this.viewport)
    const touches = (b: { minX: number; minY: number; maxX: number; maxY: number }) =>
      b.minX <= r.x + r.w && b.maxX >= r.x && b.minY <= r.y + r.h && b.maxY >= r.y
    this.visibleSet ??= new Set(this.visibleNotes)
    const shown = this.visibleSet
    // While a note holds the keyboard a cull keeps the DOM order as it is: a reading place that
    // changed asks for none (it is brought up to date once the keyboard leaves).
    const held = this.orderHeld()
    for (const id of ids) {
      const n = after.get(id)
      const o = before.get(id)
      if (n === undefined || o === undefined || n.z !== o.z) return false
      const b = this.index.noteBox(id)
      const now = b !== undefined && touches(b)
      if (now !== shown.has(id)) return false
      if (now && !held && !this.readingPlaceStands(id, after)) return false
    }
    this.segmentKeys ??= new Set(this.segments.map((ref) => ref.key))
    const keys = this.segmentKeys
    for (const ref of segs) {
      const item = this.index.segment(ref.key)
      if ((item !== undefined && touches(item)) !== keys.has(ref.key)) return false
    }
    return true
  }

  /** Whether mounted note `id` still sits between its neighbours in reading (DOM) order. */
  private readingPlaceStands(id: string, notes: BoardState['notes']): boolean {
    if (this.mountedAt === null) {
      const at = new Map<string, number>()
      for (const [k, m] of this.mountedOrder.entries()) at.set(m, k)
      this.mountedAt = at
    }
    const k = this.mountedAt.get(id)
    if (k === undefined) return false
    const prev = this.mountedOrder[k - 1]
    const next = this.mountedOrder[k + 1]
    return (
      (prev === undefined || readingRank(prev, id, notes) < 0) &&
      (next === undefined || readingRank(id, next, notes) < 0)
    )
  }

  /**
   * Query the index for camera `c`, keeping the result for the renderer; returns the view, whose
   * `visible` (the notes to mount) is empty in overview.
   */
  private cull(c: Camera, lod: LodMode): Pick<ViewState, 'visible' | 'lod'> {
    const r = cullRect(c, this.viewport)
    // A camera moved since the last cull (not the first one, a board opening) mounts in batches.
    const was = this.lastCull?.c
    const moved = was !== undefined && (was.x !== c.x || was.y !== c.y || was.zoom !== c.zoom)
    const { notes } = this.board()
    const g = this.overrides.group
    this.cullMove = g === null ? null : { dx: g.dx, dy: g.dy }
    let ids: string[]
    if (this.pyramidOn && lod === 'overview') {
      // The pyramid draws the board: only a group drag's members in view are culled (they are
      // drawn live), with their threads. O(group), never O(board).
      ids = g === null ? [] : inPaintOrder(this.groupIn(g, r), notes)
      this.segments = this.segmentsTouching(ids)
    } else {
      const found = this.index.notesIn(r)
      // A group drag moves its members away from where the index holds them: the ones that are
      // now in view (found by asking where they were) are culled in too.
      if (g !== null) {
        const there = { x: r.x - g.dx, y: r.y - g.dy, w: r.w, h: r.h }
        const have = new Set(found)
        for (const id of this.index.notesIn(there)) {
          if (g.ids.has(id) && !have.has(id)) found.push(id)
        }
      }
      ids = inPaintOrder(found, notes)
      // Drawn in hit-test order, so on a tie the thread drawn later is the one hit. Overview
      // neither hit-tests yarn nor keeps the threads' order among themselves.
      const segments = this.index.segmentsIn(r)
      if (g !== null) {
        // Threads of the group that its move brings into view are in the index where they were,
        // so they are found by asking where they were: the member's end of each is there (a
        // thread between members moves whole; one to a note outside the group is found by its
        // group end).
        const have = new Set(segments.map((ref) => ref.key))
        const there = { x: r.x - g.dx, y: r.y - g.dy, w: r.w, h: r.h }
        for (const ref of this.index.segmentsIn(there)) {
          if (have.has(ref.key) || !(g.ids.has(ref.aNoteId) || g.ids.has(ref.bNoteId))) continue
          segments.push(ref)
        }
      }
      this.segments = lod === 'overview' ? segments : segments.sort(compareDrawOrder(notes))
    }
    this.visibleNotes = ids
    this.visibleSet = null
    this.mountedAt = null
    this.segmentKeys = null
    this.lastCull = { c, viewport: this.viewport }
    if (this.els.root.dataset.lod !== lod) this.els.root.dataset.lod = lod
    // Only overview outlines a hovered card; the next pointer move sets it again there.
    if (lod !== 'overview') this.hoverCard = undefined
    this.lodMode = lod
    this.recullDue = false
    const wanted = lod === 'overview' ? [] : this.withEdited(ids, notes)
    const mounted = this.mountBatch(wanted, c, moved)
    this.restack(mounted, notes)
    // Focus mode filters this culled set where it is drawn and hit (`focusMode.shown`), not
    // here: a hidden note stays mounted, marked hidden and inert as it mounts, so entering and
    // leaving focus flip marks on the mounted notes and never mount or unmount a page of them.
    return { visible: this.domOrder(mounted, notes), lod }
  }

  /**
   * Of `wanted` (paint order), the notes to mount this frame: all of them for a board opening,
   * or when few are new; once the camera has moved (`moved`), and until every note an earlier
   * move left is mounted, the ones mounted now, the note being written on, the one the keys go
   * to, and at most {@link MOUNT_BATCH} more, those in view nearest its middle first. What waits
   * is kept for the next frame (`mountWanted`). O(wanted log wanted) when it batches.
   */
  private mountBatch(wanted: string[], c: Camera, moved: boolean): string[] {
    // Still mounting what an earlier move left: a cull at rest (a height measured) batches too.
    const behind = this.mountWanted !== null
    this.mountWanted = null
    if (wanted.length <= MOUNT_BATCH || !(moved || behind)) return wanted
    const have = new Set(this.mountedOrder)
    const keep = (id: string) => have.has(id) || id === this.edit?.noteId || id === this.wantFocus
    let fresh = 0
    for (const id of wanted) if (!keep(id)) fresh++
    if (fresh <= MOUNT_BATCH) return wanted
    const v = visibleWorldRect(c, this.viewport, 0)
    const cx = v.x + v.w / 2
    const cy = v.y + v.h / 2
    const rank: Array<{ id: string; d: number }> = []
    for (const id of wanted) {
      if (keep(id)) continue
      const b = this.index.noteBox(id)
      if (b === undefined) {
        rank.push({ id, d: Number.POSITIVE_INFINITY })
        continue
      }
      const seen = b.maxX >= v.x && b.minX <= v.x + v.w && b.maxY >= v.y && b.minY <= v.y + v.h
      const dx = (b.minX + b.maxX) / 2 - cx
      const dy = (b.minY + b.maxY) / 2 - cy
      rank.push({ id, d: (seen ? 0 : 1e18) + dx * dx + dy * dy })
    }
    rank.sort((a, b) => a.d - b.d)
    const now = new Set<string>()
    for (let k = 0; k < MOUNT_BATCH; k++) now.add((rank[k] as { id: string }).id)
    this.mountWanted = wanted
    return wanted.filter((id) => keep(id) || now.has(id))
  }

  /**
   * A group drag's members whose stored rect, moved by the drag, touches world rect `r`: by
   * walking a small group, or (a large one) by asking the index where they were.
   */
  private groupIn(g: NonNullable<TransientOverrides['group']>, r: Rect): string[] {
    const there = { x: r.x - g.dx, y: r.y - g.dy, w: r.w, h: r.h }
    if (g.ids.size > GROUP_WALK) return this.index.notesIn(there).filter((id) => g.ids.has(id))
    const out: string[] = []
    for (const id of g.ids) {
      const b = this.index.noteBox(id)
      if (b === undefined) continue
      if (b.minX <= there.x + there.w && there.x <= b.maxX) {
        if (b.minY <= there.y + there.h && there.y <= b.maxY) out.push(id)
      }
    }
    return out
  }

  /** The segments with an end on any of `ids`, once each. O(their threads' ends). */
  private segmentsTouching(ids: readonly string[]): SegmentRef[] {
    if (ids.length === 0) return []
    const topo = this.topology
    const out = new Map<string, SegmentRef>()
    for (const id of ids) for (const e of topo.byNote.get(id) ?? []) out.set(e.ref.key, e.ref)
    return [...out.values()]
  }

  /**
   * Give each mounted note its place in paint order as the CSS variable `--stack`, which `.note`
   * takes as its z-index. The notes sit in the DOM in reading order, so the DOM no longer says
   * what paints over what. The place is the note's own z while every mounted note has a z of its
   * own (the usual case): a note entering the view then changes nobody else's, and only the
   * entrants and the notes whose z changed are written. When two share a z (paint order breaks
   * the tie by id) the places are dense ranks instead, 1 up, and a swap between the two kinds
   * rewrites them all. Only values that changed are written; new notes get theirs as they mount
   * (`noteMounted`). O(mounted), on a recull.
   */
  private restack(paint: readonly string[], notes: BoardState['notes']): void {
    const next = new Map<string, number>()
    let own = true
    let prevZ = Number.NEGATIVE_INFINITY
    for (const id of paint) {
      const z = notes.get(id)?.z ?? 0
      // Strictly rising z (paint order is by z) and room under the lift's z-index.
      if (!(z > prevZ) || Math.abs(z) > STACK_MAX) own = false
      prevZ = z
    }
    for (let i = 0; i < paint.length; i++) {
      const id = paint[i] as string
      next.set(id, own ? (notes.get(id)?.z ?? 0) : i + 1)
    }
    for (const [id, place] of next) {
      if (this.stack.get(id) !== place)
        this.noteEls.get(id)?.style.setProperty('--stack', `${place}`)
    }
    this.stack = next
  }

  /**
   * The mounted ids in DOM order: reading order (rows of 200 world px, then x), so Tab walks the
   * board as a page is read. While a note holds the keyboard (an editor, or a note focused from
   * the keys) the order is kept as it was apart from notes coming and going: React would move
   * the mounted note, and a moved element loses its focus. It is brought up to date once the
   * keyboard leaves (`reorderSoon`).
   */
  private domOrder(paint: readonly string[], notes: BoardState['notes']): string[] {
    const wanted = readingOrder(paint, notes)
    this.mountedOrder = this.orderHeld() ? stableOrder(this.mountedOrder, wanted) : wanted
    return this.mountedOrder
  }

  /** Whether a note holds the keyboard (an editor, or a focused note): the DOM order is kept. */
  private orderHeld(): boolean {
    const active = this.els.root.ownerDocument.activeElement
    return (
      this.edit !== null ||
      (active instanceof HTMLElement &&
        this.els.root.contains(active) &&
        active.closest('article[data-note-id]') !== null)
    )
  }

  /** Cull again on the next frame, to settle the DOM order a held keyboard postponed. */
  private reorderSoon(): void {
    this.recullDue = true
    this.loop.request()
  }

  /**
   * `NoteLayer` mounted note `id`'s element: give it its paint rank, its focus marks (hidden and
   * inert from the start, outside the focus), and the keyboard if the arrow keys were on their
   * way to it.
   */
  noteMounted(id: string, el: HTMLElement): void {
    if (this.focusMode.state !== null || this.focusMode.busy) this.focusMode.mounted(id, el)
    const rank = this.stack.get(id)
    if (rank !== undefined) el.style.setProperty('--stack', `${rank}`)
    if (this.wantFocus === id) {
      this.wantFocus = undefined
      el.focus({ preventScroll: true })
    }
  }

  /**
   * The culled ids with the note being written on among them wherever the camera goes, in its
   * own paint-order place: its editor holds the focus (perhaps a composition), and a mounted
   * note React moved to another place in the list would lose it. O(visible), on a recull.
   */
  private withEdited(ids: string[], notes: BoardState['notes']): string[] {
    const edited = this.edit?.noteId
    const n = edited === undefined ? undefined : notes.get(edited)
    if (edited === undefined || n === undefined || ids.includes(edited)) return ids
    const before = (id: string) => {
      const z = notes.get(id)?.z ?? 0
      return z < n.z || (z === n.z && id < edited)
    }
    let at = 0
    while (at < ids.length && before(ids[at] as string)) at++
    return [...ids.slice(0, at), edited, ...ids.slice(at)]
  }

  private yarnFrame = (): boolean => {
    const c = this.camera.get()
    const s = this.board()
    const { layer } = prefsStore.getState()
    if (this.pendingNotes.size > 0) {
      this.reindex(this.model, this.pendingNotes)
      // A new height moves the note's edge pins and its neighbours': settle them, no swing.
      const refs = this.motion.segmentsOf(withNeighbours(this.topology, this.pendingNotes))
      this.motion.retarget(refs, (ref) => this.attachOf(s).ends(ref), { snap: true })
      // Edge pins (and, in over-fix, the erased paper shapes) follow measured heights: patched
      // where they were and are; culled again only if the view's notes or threads changed.
      this.yarn.invalidateStatic({ segments: refs.map((ref) => ref.key), notes: this.pendingNotes })
      const notes = this.model.notes
      if (!this.cullStands(notes, notes, this.pendingNotes, refs)) this.recullDue = true
      this.pendingNotes.clear()
    }
    this.syncPyramid()
    const lod = nextLod(this.lodMode, c.zoom)
    // Overview mounts no notes: zooming out to it ends the writing first, keeping what the field
    // holds (a composition under way included) before the editor goes.
    if (lod === 'overview' && this.lodMode !== 'overview' && this.edit !== null) {
      this.stopEditing()
      this.holdKeys()
    }
    const pyramidOn = this.pyramidWanted(lod)
    if (pyramidOn !== this.pyramidOn) {
      // The cull differs (the pyramid needs none of the board's), and so does what is drawn.
      this.pyramidOn = pyramidOn
      this.recullDue = true
      this.renderDue = true
      if (!pyramidOn) this.pyramid?.setHidden(NO_KEYS, NO_KEYS)
    }
    if (this.recullDue || lod !== this.lodMode || needsRecull(this.lastCull, c, this.viewport)) {
      const prev = this.view.getState()
      const next = this.cull(c, lod)
      if (next.lod !== prev.lod || !sameIds(next.visible, prev.visible)) this.view.setState(next)
      // Members of a group drag that came into view are held notes now.
      if (this.overrides.group !== null) this.onOverrides()
    } else if (this.mountWanted !== null && this.lastCull !== null) {
      // Notes the last cull wanted and the last frames left to mount: the next batch of them.
      const notes = this.board().notes
      const mounted = this.mountBatch(this.mountWanted, this.lastCull.c, true)
      this.restack(mounted, notes)
      this.view.setState({ visible: this.domOrder(mounted, notes) })
    }
    this.updateCoverKeys(s, layer)
    const dynamicKeys =
      this.coverKeys.size === 0 && this.neighbourKeys.size === 0
        ? this.dynamicKeys
        : new Set([...this.dynamicKeys, ...this.coverKeys, ...this.neighbourKeys])
    const dynamic = dynamicKeys.size > 0 || this.dynamicNotes.size > 0
    // Under a book, the card overview of a board the pyramid draws waits (for the pyramid, or
    // for the book to go); a smaller board's, which the pyramid never draws, is drawn as ever.
    const held =
      this.underBook &&
      this.lodMode === 'overview' &&
      !pyramidOn &&
      this.model.notes.size > this.pyramidAbove &&
      // The pyramid can be made here: else nothing would ever draw it (drawn as ever, then).
      !this.pyramidBroken &&
      pyramidSupported()
    if (
      !held &&
      (!sameCamera(this.renderedCamera, c) ||
        this.renderDue ||
        this.yarn.staticInvalid ||
        this.yarn.passing ||
        dynamic)
    ) {
      this.renderedCamera = c
      this.renderDue = false
      const motion = this.motion
      const attach = this.attachOf(s)
      const live = this.pyramidLive(dynamicKeys)
      this.stats = this.yarn.render({
        state: s,
        topology: this.topology,
        camera: c,
        anchor: this.anchorPt,
        viewport: this.viewport,
        dpr: this.currentDpr,
        lod: this.lodMode,
        segments: live?.segments ?? this.withMotionRefs(this.segments),
        visibleNotes: live?.notes ?? this.visibleNotes,
        pinOf: (id) => this.pinOf(s, id),
        pinCovered: (id) => this.pinCovered(s, attach, id),
        endsOf: (ref) => attach.ends(ref),
        sharedPinOf: (ref, end) => attach.sharedPin(ref, end),
        hookOf: (id) => {
          const n = s.notes.get(id)
          return n !== undefined && isTag(this.overrides.effective(n))
        },
        sagOf: (ref, a, b) => motion.sagOf(ref, a, b),
        alphaOf: (id) => motion.alphaOf(id),
        progressOf: (id) => motion.progressOf(id),
        ghosts: motion.ghosts(),
        dynamicKeys: live?.keys ?? dynamicKeys,
        dynamicNotes: this.dynamicNotes,
        selectedYarnId: this.selectedYarnId,
        pulseOf: (id) => motion.pulseOf(id),
        glowNotes: this.glow,
        glowPins: this.glowPins(s, attach),
        live: this.liveStrand(),
        layer,
        paperOf: (id) => this.paperOf(s, id),
        occludersOf: (ref, pts) => this.occludersOf(s, ref, pts),
        selectedNotes: this.selection,
        framedNotes: this.selection,
        ...(this.focusedNote === undefined ? {} : { focusedNote: this.focusedNote }),
        hoverNoteId: this.hoverCard,
        toneOf: this.toneOf,
        // Memoised on the board, the overrides, the heights and the tilt: what moves paper.
        geometryKey: attach,
        focus: this.focusMode.paint,
        near: this.near,
        ...(live === null || this.pyramid === null
          ? {}
          : {
              pyramid: this.pyramid,
              selectedInView: () => this.selectedInView(),
            }),
      })
    }
    // Notes still to mount ask for the next frame, and so does a card overview drawn over
    // several, unless it waits under a book: one under way, or one just ended on a
    // board that changed while it ran (the next pass draws the change).
    return this.mountWanted !== null || ((this.yarn.passing || this.yarn.behind) && !held)
  }

  /**
   * Drawing from the pyramid: what is drawn live over it, which its tiles leave out (`setHidden`):
   * the moving notes, the dynamic segments (springs, a drag's neighbours), every segment of a
   * moving note, and the selected thread (drawn twice as wide). Null with the card overview.
   * O(what is live).
   */
  private pyramidLive(dynamicKeys: ReadonlySet<string>): {
    notes: string[]
    segments: SegmentRef[]
    keys: ReadonlySet<string>
  } | null {
    const p = this.pyramid
    if (!this.pyramidOn || p === null) return null
    const refs = new Map<string, SegmentRef>()
    for (const ref of this.withMotionRefs(this.segments)) refs.set(ref.key, ref)
    const moving = [...this.dynamicNotes]
    for (const ref of this.segmentsTouching(moving)) refs.set(ref.key, ref)
    const picked =
      this.selectedYarnId === undefined ? [] : (this.topology.byYarn.get(this.selectedYarnId) ?? [])
    const keys = picked.length === 0 ? dynamicKeys : new Set(dynamicKeys)
    for (const ref of picked) {
      ;(keys as Set<string>).add(ref.key)
      refs.set(ref.key, ref)
    }
    for (const k of keys) {
      if (refs.has(k)) continue
      const ref = this.index.segment(k)?.ref
      if (ref !== undefined) refs.set(k, ref)
    }
    const hidden = new Set(keys)
    for (const ref of refs.values()) {
      if (this.dynamicNotes.has(ref.aNoteId) || this.dynamicNotes.has(ref.bNoteId)) {
        hidden.add(ref.key)
      }
    }
    p.setHidden(new Set(this.dynamicNotes), hidden)
    const have = new Set(this.visibleNotes)
    const notes = [...this.visibleNotes, ...moving.filter((id) => !have.has(id))]
    return { notes, segments: [...refs.values()].filter((r) => hidden.has(r.key)), keys }
  }

  /**
   * A selection too large to walk each frame, outlined over the pyramid: its notes in the cull
   * rect, found once per cull (and per selection), not per frame.
   */
  private selectedInView(): string[] {
    const m = this.selectedSeen
    if (m !== null && m.cull === this.lastCull && m.selection === this.selection) return m.ids
    const r = cullRect(this.camera.get(), this.viewport)
    const ids = this.index.notesIn(r).filter((id) => this.selection.has(id))
    this.selectedSeen = { cull: this.lastCull, selection: this.selection, ids }
    return ids
  }

  /**
   * Whether overview is drawn from the pyramid: a board of more than `pyramidAbove` notes whose
   * pyramid has its coarsest level, with focus off (focus draws a part of the board, from the card
   * overview, which looks the same).
   */
  private pyramidWanted(lod: LodMode): boolean {
    return (
      lod === 'overview' &&
      this.pyramid?.ready === true &&
      this.model.notes.size > this.pyramidAbove &&
      this.focusMode.paint === null &&
      !this.focusMode.busy
    )
  }

  /**
   * Keep the pyramid with the board: made once the board has more than `pyramidAbove` notes (then
   * built in idle slices), told each frame what the index re-indexed since (plus a print's caption
   * or a thread's dye, which move nothing), made again when the index was rebuilt, and gone once
   * the board is well under the threshold. O(changes).
   */
  private syncPyramid(): void {
    const changes = this.index.takeChanges()
    const size = this.model.notes.size
    let p = this.pyramid
    if (p?.failed) this.pyramidBroken = true
    if (p !== null && (p.failed || changes.all || size <= this.pyramidAbove * PYRAMID_KEEP_SHARE)) {
      p.dispose()
      p = this.pyramid = null
      this.pyramidOn = false
    }
    if (p === null) {
      this.pyramidNotes.clear()
      this.pyramidSegs.clear()
      // Made once the board is whole: a catch-up re-indexes tens of thousands of notes a frame,
      // which the build then takes from the board in idle slices instead. A page whose worker
      // failed keeps the card overview.
      if (
        size > this.pyramidAbove &&
        this.catching === null &&
        !this.pyramidBroken &&
        pyramidSupported()
      ) {
        const wait = this.toldAt + PYRAMID_AFTER_TOLD_MS - performance.now()
        if (wait <= 0) this.makePyramid()
        else {
          this.pyramidWake ??= setTimeout(() => {
            this.pyramidWake = null
            this.loop.request()
          }, wait)
        }
      }
      return
    }
    // Kept but not drawn (the board just under the threshold): its tiles go.
    if (size <= this.pyramidAbove) p.sleep()
    for (const id of changes.notes) this.pyramidNotes.add(id)
    for (const k of changes.segments) this.pyramidSegs.add(k)
    const pending = this.pyramidNotes.size + this.pyramidSegs.size
    if (pending === 0) return
    if (pending <= PYRAMID_SYNC_MAX) {
      p.changed(this.pyramidNotes, this.pyramidSegs)
      this.pyramidNotes.clear()
      this.pyramidSegs.clear()
      return
    }
    // A large change (a catch-up, a select-all move, an opening) goes over in pieces, a few a
    // frame.
    const until = performance.now() + PYRAMID_SYNC_MS
    do {
      const notes: string[] = []
      const segs: string[] = []
      for (const id of this.pyramidNotes) {
        if (notes.length >= PYRAMID_SYNC_MAX) break
        notes.push(id)
        this.pyramidNotes.delete(id)
      }
      for (const k of this.pyramidSegs) {
        if (notes.length + segs.length >= PYRAMID_SYNC_MAX) break
        segs.push(k)
        this.pyramidSegs.delete(k)
      }
      p.changed(notes, segs)
    } while (this.pyramidNotes.size + this.pyramidSegs.size > 0 && performance.now() < until)
    if (this.pyramidNotes.size + this.pyramidSegs.size > 0) this.loop.request()
  }

  private makePyramid(): void {
    const model = this.model
    const topo = this.topology
    // Each frame is read as it is taken, from the board then: a change meanwhile is never undone.
    const self = this
    function* notes(): Generator<NoteFrame> {
      for (const id of model.notes.keys()) {
        const f = self.noteFrame(id)
        if (f !== undefined) yield f
      }
    }
    function* segments(): Generator<SegFrame> {
      for (const refs of topo.byYarn.values()) {
        for (const ref of refs) {
          const f = self.segFrame(ref.key)
          if (f !== undefined) yield f
        }
      }
    }
    try {
      this.pyramid = createPyramid(notes(), segments(), {
        source: {
          note: (id) => this.noteFrame(id),
          segment: (key) => this.segFrame(key),
          notesIn: (r) => this.index.notesIn(expandRect(r, TILT_REACH)),
          segmentsIn: (r) => this.index.segmentsIn(r).map((ref) => ref.key),
          wantTone: (asset) => {
            this.toneOf(asset)
          },
        },
        onChange: () => this.requestYarn(),
        dpr: this.currentDpr,
      })
    } catch {
      // No worker to draw it: overview stays the card overview, and no other is tried.
      this.pyramid = null
      this.pyramidBroken = true
    }
  }

  /** A note as the pyramid draws it: its stored paper at the displayed height, tilted. */
  private noteFrame(id: string): NoteFrame | undefined {
    const n = this.model.notes.get(id)
    if (n === undefined) return undefined
    const { rect, pivot, deg } = this.paperShape(n)
    const asset = n.style === 'print' && n.image ? n.image.assetId : null
    return {
      id,
      ...rect,
      z: n.z,
      paper: n.paper,
      style: n.style,
      tag: isTag(n),
      deg,
      pin: pivot,
      caption: n.text.trim() !== '',
      asset,
      tone: asset === null ? null : (this.toneOf.peek(asset) ?? null),
    }
  }

  /** A segment as the pyramid draws it: between its edge pins at rest, in its dye. */
  private segFrame(key: string): SegFrame | undefined {
    const item = this.index.segment(key)
    const y = item && this.model.yarns.get(item.ref.yarnId)
    if (item === undefined || y === undefined) return undefined
    return { key, a: item.a, b: item.b, color: yarnColor(y.color) }
  }

  /** The hovered edge pin and the connect's landing pin, which glow; shared and empty if none. */
  private glowPins(s: BoardState, attach: Attach): readonly GlowPin[] {
    if (this.hoverPin?.edge === undefined && this.live?.targetNoteId === undefined) return NO_GLOW
    const out: GlowPin[] = []
    const kindOf = (noteId: string) => {
      const n = s.notes.get(noteId)
      return n !== undefined && isTag(this.overrides.effective(n)) ? 'tag' : 'edge'
    }
    const edge = this.hoverPin?.edge
    if (this.hoverPin !== null && edge !== undefined) {
      const ref = this.topology.byYarn.get(edge.yarnId)?.[edge.segIndex]
      const p = ref && attach.point(ref, edge.end)
      if (p !== undefined) out.push({ p, kind: kindOf(this.hoverPin.noteId) })
    }
    const l = this.live
    if (l?.targetNoteId !== undefined && l.shared !== 'hanging') {
      out.push({ p: l.to, kind: kindOf(l.targetNoteId) })
    }
    return out
  }

  private liveStrand() {
    const l = this.live
    if (l === null) return null
    return {
      from: l.from,
      to: l.to,
      sag: this.motion.liveSag(l.from, l.to),
      color: l.color ?? newYarnColor(),
      ...(l.under === undefined ? {} : { under: l.under }),
    }
  }

  /**
   * The culled segments plus any segment motion is moving outside them: a live sag can leave the
   * index's rest bounds, so moving segments are drawn regardless of culling.
   */
  private withMotionRefs(segments: SegmentRef[]): SegmentRef[] {
    if (this.motionRefs.size === 0) return segments
    const keys = new Set(segments.map((r) => r.key))
    const extra = [...this.motionRefs.values()].filter((r) => !keys.has(r.key))
    return extra.length === 0 ? segments : [...segments, ...extra]
  }

  /**
   * The board changed: what changed (what the store was told a `replace` touched, else what
   * differs between two versions of one board, found in O(changes)) is taken at once. A board
   * swapped in whole (`all`, or more than {@link CATCH_UP_ABOVE} records, a thread counted as
   * {@link THREAD_WEIGHT}) is caught up with a slice at a time instead ({@link catchUp}).
   */
  private onBoard = (s: BoardState, prev: BoardState): void => {
    // Only books changed (a paragraph typed, a book shelved): nothing on the board moves.
    if (s.notes === prev.notes && s.yarns === prev.yarns && s.assets === prev.assets) return
    if (this.selectedYarnId !== undefined && !s.yarns.has(this.selectedYarnId)) {
      this.setSelectedYarn(undefined)
    }
    const told = this.store.touched(s, prev)
    if (told !== undefined) this.toldAt = performance.now()
    // The top of the stack follows what changed (O(changed)); a board swapped in whole is met
    // afresh in idle time. Either way a drag's start never walks the board.
    if (told === 'all') primeTopZ(() => this.store.getState())
    else if (told !== undefined) followTopZ(prev.notes, s.notes, told.notes)
    if (told === 'all') this.catchUp(s)
    else if (told !== undefined) {
      // A told change (an opening's) is taken a slice at a time too, a thread counted at what
      // taking it costs: 1,000 threads taken at once held a frame for 123 ms (an opening's
      // threads, told a chunk at a time).
      if (told.notes.size + THREAD_WEIGHT * told.yarns.size > CATCH_UP_TOLD_ABOVE) {
        this.catchUp(s, told)
      } else this.take(s, told)
    } else {
      // The store's last board is the model's unless catching up, and then changes are patched in.
      const changed = changesBetween(prev, s)
      if (changed === null) {
        primeTopZ(() => this.store.getState())
        this.catchUp(s)
      } else {
        followTopZ(prev.notes, s.notes, changed.notes)
        this.take(s, changed)
      }
    }
  }

  /**
   * Take `changed`, which took the board from the store's last to `s`: onto the model (which is
   * `s` itself unless catching up) and from it to the topology, the index and the springs.
   */
  private take(s: BoardState, changed: Changed): void {
    const before = this.model
    const next: TopologyBoard =
      this.catching === null
        ? s
        : {
            notes: patched(before.notes, s.notes, changed.notes),
            yarns: patched(before.yarns, s.yarns, changed.yarns),
          }
    this.applyModel(before, next, changed)
  }

  /**
   * The model goes from `before` to `next`, which differ in `changed` only: the topology is made
   * from the last by what changed, and only the notes and threads changed (with the threads and
   * notes beside them) are indexed again and their springs matched. O(changed).
   */
  private applyModel(before: TopologyBoard, next: TopologyBoard, changed: Changed): void {
    this.model = next
    if (before === next) return
    if (this.catching !== null) this.view.setState({ drawn: next.notes })
    advanceTopology(before, next, changed)
    const ids = new Set<string>()
    const removed: string[] = []
    // What focus mode's membership is patched from (`BoardDiff`).
    const addedNotes: string[] = []
    const threads: Array<BoardDiff['threads'][number]> = []
    /** Notes that came or went: their threads' segments change. */
    const cameOrWent: string[] = []
    if (before.notes !== next.notes) {
      for (const id of changed.notes) {
        const n = next.notes.get(id)
        const old = before.notes.get(id)
        if (n === old) continue
        if (n === undefined) {
          ids.add(id)
          removed.push(id)
          cameOrWent.push(id)
          continue
        }
        if (old === undefined) {
          addedNotes.push(id)
          cameOrWent.push(id)
        }
        if (!(old !== undefined && samePaper(old, n))) ids.add(id)
        // A print's caption band comes and goes with its text, which moves nothing else: the
        // pyramid redraws its card, and without one the card overview, which draws from the
        // yarn's static cache, is told of the note as of a paper that changed.
        else if (n.style === 'print' && (old.text.trim() === '') !== (n.text.trim() === '')) {
          if (this.pyramid !== null) this.pyramidNotes.add(id)
          else ids.add(id)
        }
      }
    }
    const yarns = new Set<string>()
    if (before.yarns !== next.yarns) {
      for (const id of changed.yarns) {
        const y = next.yarns.get(id)
        const old = before.yarns.get(id)
        if (y === old) continue
        yarns.add(id)
        if (y === undefined) threads.push({ id, before: old as NonNullable<typeof old> })
        else threads.push(old === undefined ? { id, after: y } : { id, before: old, after: y })
        // A colour or a label moves no pin: only a change of its notes or pins re-indexes them.
        if (y !== undefined && old !== undefined && sameThreading(old, y)) {
          if (this.pyramid !== null && y.color !== old.color) {
            for (const ref of this.topology.byYarn.get(id) ?? []) this.pyramidSegs.add(ref.key)
          }
          continue
        }
        for (const n of y?.noteIds ?? []) ids.add(n)
        for (const n of old?.noteIds ?? []) ids.add(n)
      }
    }
    if (removed.length > 0) this.forget(removed)
    // Focus follows a change of membership (never typing, a drag or a colour), at once.
    if (this.focusMode.boardChanged({ addedNotes, removedNotes: removed, threads })) {
      this.afterBoardFocus()
    }
    if (ids.size === 0 && yarns.size === 0) return
    const topo = this.topology
    for (const id of cameOrWent) for (const y of topo.yarnsOf.get(id) ?? []) yarns.add(y)
    this.reindex(next, ids)
    const s = this.board()
    const endsOf = (ref: SegmentRef) => this.attachOf(s).ends(ref)
    this.motion.sync(next, endsOf, yarns)
    // Their neighbours' edge pins face them, so those segments move too. The threads in view
    // spring to their new rest; any others (the far ends of a select-all that moved) settle at
    // once: nothing the size of the change animates, and nothing off screen is worth a spring.
    const inView = this.inView()
    const near: SegmentRef[] = []
    const far: SegmentRef[] = []
    const moved = this.motion.segmentsOf(withNeighbours(topo, ids))
    for (const ref of moved) {
      ;(inView(ref) ? near : far).push(ref)
    }
    this.motion.retarget(near, endsOf)
    this.motion.retarget(far, endsOf, { snap: true })
    if (yarns.size > 0 || cameOrWent.length > 0) {
      this.yarn.invalidateStatic()
      this.recullDue = true
    } else {
      // Notes moved, turned or resized, no thread changed (a nudge, a remote move): the yarn's
      // static layer is patched where they were and are, and the view culled again only when
      // what it holds, or its order, changed. O(changed).
      this.yarn.invalidateStatic({ segments: moved.map((ref) => ref.key), notes: ids })
      if (!this.cullStands(before.notes, next.notes, ids, moved)) this.recullDue = true
    }
    this.loop.request()
    for (const id of removed) for (const fn of [...this.removedListeners]) fn(id)
  }

  /**
   * Which segments are in view: the culled ones, or (drawn from the pyramid, which culls none)
   * those whose indexed bounds touch the cull rect.
   */
  private inView(): (ref: SegmentRef) => boolean {
    if (!this.pyramidOn) {
      this.segmentKeys ??= new Set(this.segments.map((ref) => ref.key))
      const keys = this.segmentKeys
      return (ref) => keys.has(ref.key)
    }
    const r = cullRect(this.camera.get(), this.viewport)
    return (ref) => {
      const b = this.index.segment(ref.key)
      return (
        b !== undefined &&
        b.minX <= r.x + r.w &&
        r.x <= b.maxX &&
        b.minY <= r.y + r.h &&
        r.y <= b.maxY
      )
    }
  }

  /**
   * Catch up with `s`, a board swapped in whole (loaded again, restored, imported), or with a told
   * change too large to take at once (`told`): a slice at a time, each by
   * 8 ms ({@link CATCH_UP_BUDGET_MS}), the notes in view first ({@link CatchUp}). Until it is done the
   * canvas draws the model, with the store's records patched in as they are taken: every frame
   * one board. Commits meanwhile are taken at once. Then `s` is the model, with the topology made
   * on the way.
   */
  private catchUp(s: BoardState, told?: Changed): void {
    const was = this.catching
    const view = cullRect(this.camera.get(), this.viewport)
    this.catching = {
      // In overview every note is in view: the walk finds them, nearest or not.
      first: this.lodMode === 'overview' ? [] : this.index.notesIn(view),
      // A told change met mid catch-up: what the walk under way had still to look at comes first.
      walk:
        told === undefined
          ? idsToCatchUp(s, this.model)
          : was === null || was.walked
            ? idsTold(told)
            : chain(was.walk, idsTold(told)),
      walked: false,
      // What an earlier catch-up found and has not taken yet is still to look at.
      later: was === null ? [] : was.later.slice(was.next),
      next: 0,
      soon: was === null ? [] : was.soon,
      deferred: was === null ? new Set() : was.deferred,
      view,
      step: was?.step ?? 0,
    }
    this.view.setState({ drawn: this.model.notes })
    this.recullDue = true
    this.renderDue = true
    this.loop.request()
    if (was === null) void this.catchUpSlices()
  }

  private async catchUpSlices(): Promise<void> {
    while (this.catching !== null && !this.disposed) {
      await pagePace.yield()
      if (this.disposed || this.catching === null) return
      const start = performance.now()
      this.sliceTook = { steps: 0, notes: 0, yarns: 0, shown: 0 }
      this.catchUpSlice(start + CATCH_UP_BUDGET_MS)
      const own = performance.now() - start
      // Measured to the end of the task: the notes drawn render (React's, a microtask queued as
      // the slice set them) before this continuation runs.
      await Promise.resolve()
      performance.measure?.('papertie:catch-up', {
        start,
        detail: { ...this.sliceTook, own: Math.round(own * 10) / 10 },
      })
    }
  }

  /**
   * Catch up in steps until `end` (performance.now ms): a step starts only while there is time
   * for one as costly as the last, or a costlier one just before (at least one is taken). True once caught up: the store's board
   * is the model from then on.
   */
  private catchUpSlice(end: number): boolean {
    const c = this.catching
    if (c === null) return true
    this.refocusCatchUp(c)
    for (;;) {
      const began = performance.now()
      const over = this.catchUpStep(c)
      if (this.catching !== c) return this.catching === null
      if (over) {
        const s = this.store.getState()
        adoptTopology(s, this.topology)
        this.model = s
        this.catching = null
        this.drawnMemo = null
        this.attachCache = null
        this.view.setState({ drawn: null })
        this.recullDue = true
        this.renderDue = true
        this.loop.request()
        return true
      }
      const now = performance.now()
      // The guess: the last step's cost, or a costlier one's not long before (slowly forgotten).
      c.step = Math.max(now - began, c.step * 0.8)
      if (now + c.step >= end) return false
    }
  }

  /**
   * The camera has gone elsewhere and settled while catching up: the notes in the new view (as
   * the model has them) are looked at next, before the walk goes on.
   */
  private refocusCatchUp(c: CatchUp): void {
    if (this.camera.moving || this.lodMode === 'overview') return
    const view = cullRect(this.camera.get(), this.viewport)
    const v = c.view
    if (view.x === v.x && view.y === v.y && view.w === v.w && view.h === v.h) return
    c.view = view
    c.first.push(...this.index.notesIn(view))
  }

  /**
   * Gathers what to take into the model in one go: a note with the threads naming it (here or in
   * the store), a thread with its notes. A thread naming more than `long` notes is not taken with
   * them: with a catch-up (`c`) its notes are queued first and it after them, alone; without one
   * (`takeNow`) it is left to the catch-up, drawn as the model has it, through notes it has.
   */
  private gatherer(s: BoardState, c: CatchUp | null, long: number) {
    const model = this.model
    const notes = new Set<string>()
    const yarns = new Set<string>()
    const g = { notes, yarns, weight: 0, takeNote, takeYarn, threadsOf: threadsAround }
    const differs = (kind: Kind, id: string) =>
      kind === 'note'
        ? model.notes.get(id) !== s.notes.get(id)
        : model.yarns.get(id) !== s.yarns.get(id)
    const topo = this.topology
    // The store's threads by note: core's index, kept with every yarn map core makes. A board
    // built otherwise (a plain map) would have it built whole here: its new threads come with the
    // walk instead.
    const indexed = s.yarns instanceof PMap
    function threadsAround(id: string): void {
      for (const y of topo.yarnsOf.get(id) ?? []) takeYarn(y)
      if (indexed && s.notes.has(id)) for (const y of threadsOf(s, id)) takeYarn(y.id)
    }
    function takeYarn(id: string, asked = false): void {
      if (yarns.has(id) || !differs('yarn', id)) return
      const after = s.yarns.get(id)?.noteIds ?? []
      const before = model.yarns.get(id)?.noteIds ?? []
      if (after.length + before.length > 2 * long) {
        if (c === null || (c.deferred.has(id) && !asked)) return
        const all = [...new Set([...after, ...before])]
        // Its notes taken in this very step are not in the model yet: it waits for the next.
        if (all.some((n) => notes.has(n))) {
          c.deferred.add(id)
          c.soon.push(['yarn', id])
          return
        }
        const behind = all.filter((n) => differs('note', n))
        if (behind.length > 0) {
          c.deferred.add(id)
          c.soon.push(['yarn', id])
          for (const n of behind.reverse()) c.soon.push(['note', n])
          return
        }
        c.deferred.delete(id)
        yarns.add(id)
        g.weight += THREAD_WEIGHT + Math.ceil((after.length + before.length) / 8)
        return
      }
      yarns.add(id)
      g.weight += THREAD_WEIGHT
      for (const n of after) takeNote(n, false)
      for (const n of before) takeNote(n, false)
    }
    /** `withThreads`: its threads too (`always`: even when the note itself is the same). */
    function takeNote(id: string, withThreads: boolean | 'always'): void {
      if (notes.has(id)) return
      if (!differs('note', id)) {
        if (withThreads === 'always') threadsAround(id)
        return
      }
      notes.add(id)
      g.weight++
      if (withThreads !== false) threadsAround(id)
    }
    return g
  }

  /**
   * While catching up, take these notes (with their threads) into the model at once: an edit is
   * about to be built from them, and must start from the store's record, never a stale drawn one.
   * A note the store no longer has goes from the board drawn. Nothing to do once caught up.
   */
  private takeNow(ids: Iterable<string>): void {
    if (this.catching === null) return
    const s = this.store.getState()
    const g = this.gatherer(s, null, TAKE_NOW_THREAD)
    for (const id of ids) g.takeNote(id, 'always')
    if (g.notes.size + g.yarns.size > 0) this.take(s, { notes: g.notes, yarns: g.yarns })
  }

  /**
   * One step of catching up: what differs among the notes in view (and their threads), then the
   * ids walked (those in view taken, the rest kept for later), then, once walked, what was kept.
   * True once there is nothing left to look at.
   */
  private catchUpStep(c: CatchUp): boolean {
    const s = this.store.getState()
    const model = this.model
    const g = this.gatherer(s, c, LONG_THREAD)
    const differs = (kind: Kind, id: string) =>
      kind === 'note'
        ? model.notes.get(id) !== s.notes.get(id)
        : model.yarns.get(id) !== s.yarns.get(id)
    const inView = (id: string) => {
      const n = s.notes.get(id) ?? model.notes.get(id)
      return n !== undefined && rectsIntersect(noteBounds(n), c.view)
    }
    // The notes in view, and their threads even where the notes are the same.
    while (g.weight < CATCH_UP_TAKE && c.first.length > 0) {
      g.takeNote(c.first.pop() as string, 'always')
    }
    while (g.weight < CATCH_UP_TAKE && c.soon.length > 0) {
      const [kind, id] = c.soon.pop() as readonly [Kind, string]
      if (kind === 'note') g.takeNote(id, true)
      else {
        const left = c.soon.length
        g.takeYarn(id, true)
        // Put back to wait for a step whose notes are in: no more this step.
        if (c.soon.length > left && c.soon.at(-1)?.[1] === id) break
      }
    }
    let looked = 0
    while (!c.walked && g.weight < CATCH_UP_TAKE && looked < CATCH_UP_LOOK) {
      const r = c.walk.next()
      if (r.done) {
        c.walked = true
        break
      }
      looked++
      if (r.value === null) continue
      const [kind, id] = r.value
      if (!differs(kind, id)) continue
      if (kind === 'note' && inView(id)) g.takeNote(id, true)
      else c.later.push(r.value)
    }
    if (c.walked) {
      // Many kept may have been taken since with a note or thread beside them: looking costs too.
      while (g.weight < CATCH_UP_TAKE && c.next < c.later.length && looked < CATCH_UP_LOOK) {
        const [kind, id] = c.later[c.next++] as readonly [Kind, string]
        looked++
        if (kind === 'note') g.takeNote(id, true)
        else g.takeYarn(id)
      }
    }
    const t = this.sliceTook
    t.steps++
    t.notes += g.notes.size
    t.yarns += g.yarns.size
    for (const id of g.notes) if (this.noteEls.has(id)) t.shown++
    if (g.notes.size + g.yarns.size > 0) this.take(s, { notes: g.notes, yarns: g.yarns })
    return c.walked && c.first.length === 0 && c.soon.length === 0 && c.next >= c.later.length
  }

  /**
   * The board the canvas draws and is pointed at: the store's, except while catching up, when
   * its notes and threads are the model's (the store's records patched in as they are taken), so
   * every frame and every hit is one board.
   */
  private board(): BoardState {
    const s = this.store.getState()
    if (this.catching === null) return s
    const m = this.drawnMemo
    if (m !== null && m.s === s && m.model === this.model) return m.board
    const board = { ...s, notes: this.model.notes, yarns: this.model.yarns }
    this.drawnMemo = { s, model: this.model, board }
    return board
  }

  /**
   * The board changed what focus shows. Inside the store's notification nothing is committed: a
   * note being written on that is now hidden ends its writing just after (flushing the field),
   * and focus left with nothing to show ends.
   */
  private afterBoardFocus(): void {
    this.pruneHidden()
    this.recullDue = true
    this.renderDue = true
    this.loop.request()
    queueMicrotask(() => {
      if (this.focusMode.result?.notes.size === 0) this.setFocus(null, { fit: false })
      if (this.edit !== null && !this.focusMode.shown(this.edit.noteId)) {
        this.stopEditing()
        this.holdKeys()
      }
    })
  }

  /**
   * Notes that left the board (a remote delete, mostly): a gesture on one ends, committing
   * nothing, and no selection, height, hover or override keeps their ids. The editor on one
   * closes, committing nothing either (this runs inside a store notification): what was typed
   * is in the batch the sync client reports as dropped.
   */
  private forget(removed: readonly string[]): void {
    const gone = new Set(removed)
    if (this.edit !== null && gone.has(this.edit.noteId)) {
      this.edit = null
      this.view.setState({ editing: null })
      this.history?.seal()
      this.syncFocusMark()
      this.holdKeys()
    }
    for (const id of gone) {
      if (this.toolActive?.holds?.(id) || this.stage?.holds(id)) {
        this.cancelGesture()
        break
      }
    }
    for (const id of gone) {
      this.measuredH.delete(id)
      this.pendingNotes.delete(id)
      this.overrides.delete(id)
    }
    if (removed.some((id) => this.selection.has(id))) {
      this.applySelection(new Set([...this.selection].filter((id) => !gone.has(id))))
    }
    if (this.hoverPin !== null && gone.has(this.hoverPin.noteId)) this.setHoverPin(null)
    if (this.hoverCard !== undefined && gone.has(this.hoverCard)) this.setHoverCard(undefined)
  }

  private reindex(s: TopologyBoard, ids: ReadonlySet<string>): void {
    const { tilt: rotation } = prefsStore.getState()
    if (ids.size > REBUILD_SHARE * Math.max(1, s.notes.size)) {
      this.index.rebuild(s, this.measuredH, rotation)
    } else this.index.updateNotes(s, ids, this.measuredH, rotation)
  }

  /** The tilt turns every edge pin: re-index all segments and settle their springs there. */
  private reattach(): void {
    const s = this.board()
    this.index.rebuild(this.model, this.measuredH, prefsStore.getState().tilt)
    const endsOf = (ref: SegmentRef) => this.attachOf(s).ends(ref)
    this.motion.retarget(this.motion.segmentsOf(this.model.notes.keys()), endsOf, { snap: true })
    this.recullDue = true
  }

  private measure(): Size {
    const r = this.els.root.getBoundingClientRect()
    this.origin = { x: r.left, y: r.top }
    return { width: this.els.root.clientWidth, height: this.els.root.clientHeight }
  }

  /** Size both canvases to viewport x DPR (which clears them) and have the yarn redrawn. */
  private sizeCanvases(): void {
    const { width, height } = this.viewport
    for (const canvas of [this.els.yarnCanvas, this.els.pinCanvas]) {
      const w = Math.round(width * this.currentDpr)
      const h = Math.round(height * this.currentDpr)
      if (canvas.width !== w) canvas.width = w
      if (canvas.height !== h) canvas.height = h
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
    }
    this.yarn.resize(this.viewport, this.currentDpr)
    this.renderDue = true
  }

  /**
   * While the seam beside the board is dragged (`holdSize`): the most the board can take in that
   * drag, its canvases kept at their size meanwhile. `null`: they follow the root.
   */
  private sizeHeld: { reach: number } | null = null

  /**
   * The seam's drag (the split view): with `reach` (the widest the board can be in this
   * drag), the board keeps its canvases and the yarn's layers at the size they have, clipped by
   * its root, as the writer's sheet keeps its width; a root grown past them makes them
   * grow once, to `reach`. With `null` (the release) the board takes its root's size, once.
   * Resizing them each frame reallocated some 2,400 × 2,700 px at DPR 2 a frame (the final perf
   * pass: 47–49 fps, the GPU busy the whole drag).
   */
  holdSize(reach: number | null): void {
    if (reach !== null) {
      this.sizeHeld = { reach }
      return
    }
    if (this.sizeHeld === null) return
    this.sizeHeld = null
    this.resize()
  }

  private resize = (): void => {
    const held = this.sizeHeld
    if (held !== null) {
      // The camera's origin is the root's top left, which a drag of the seam never moves.
      const m = this.measure()
      const v = this.viewport
      if (m.width <= v.width && m.height <= v.height && dprNow() === this.currentDpr) return
      this.viewport = {
        width: Math.max(m.width, Math.round(held.reach)),
        height: Math.max(m.height, v.height),
      }
      this.currentDpr = dprNow()
      this.sizeCanvases()
      this.camera.refresh()
      return
    }
    const before = this.viewport
    this.viewport = this.measure()
    this.currentDpr = dprNow()
    this.sizeCanvases()
    const resized = before.width !== this.viewport.width || before.height !== this.viewport.height
    if (before.width * before.height === 0 && this.viewport.width * this.viewport.height > 0) {
      this.camera.set(this.initialCamera())
    } else if (
      resized &&
      this.openFit !== null &&
      !this.camera.moving &&
      sameCamera(this.camera.get(), this.openFit)
    ) {
      // Opened fitted to its notes and not moved since: fitted again to the view as it is now
      // (the book's pane came in beside the board, or the window changed).
      this.camera.set(this.initialCamera())
    }
    this.camera.refresh()
  }

  private wire(): void {
    const { root } = this.els
    const on = <K extends keyof HTMLElementEventMap>(
      target: HTMLElement | Window,
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
      opts?: AddEventListenerOptions,
    ) => {
      target.addEventListener(type, fn as EventListener, opts)
      this.cleanups.push(() => target.removeEventListener(type, fn as EventListener, opts))
    }

    const ro = new ResizeObserver(this.resize)
    ro.observe(root)
    this.cleanups.push(() => ro.disconnect())
    this.watchDpr()

    let tool: Tool = prefsStore.getState().tool
    let drawn: Pick<Prefs, 'layer' | 'tilt'> = prefsStore.getState()
    const html = document.documentElement
    const syncPrefs = (p: Prefs) => {
      root.dataset.tool = p.tool
      root.dataset.layer = p.layer
      html.dataset.motion = p.motion
      // A tool switch ends any gesture, whichever tool owned it.
      if (p.tool !== tool) this.cancelGesture()
      tool = p.tool
      // The layer and the rotation both change what the cached yarn and pins look like.
      if (p.layer !== drawn.layer || p.tilt !== drawn.tilt) {
        if (p.tilt !== drawn.tilt) this.reattach()
        drawn = { layer: p.layer, tilt: p.tilt }
        this.coverVersion = -1
        this.yarn.invalidateStatic()
        this.renderDue = true
      }
      // Rotation may have changed: rewrite overridden notes and the handles.
      this.styledVersion = -1
      this.loop.request()
    }
    syncPrefs(prefsStore.getState())
    this.cleanups.push(prefsStore.subscribe(syncPrefs))
    this.cleanups.push(() => delete html.dataset.motion)

    on(root, 'wheel', this.onWheel, { passive: false })
    const prevent = (e: Event) => e.preventDefault()
    root.addEventListener('gesturestart', prevent)
    root.addEventListener('gesturechange', prevent)
    this.cleanups.push(() => {
      root.removeEventListener('gesturestart', prevent)
      root.removeEventListener('gesturechange', prevent)
    })
    on(root, 'pointerdown', this.onPointerDown, { capture: true })
    on(root, 'pointermove', this.onPointerMove, { capture: true })
    on(root, 'pointerup', this.onPointerEnd, { capture: true })
    on(root, 'pointercancel', this.onPointerEnd, { capture: true })
    // Only the root's own capture: a touch's implicit capture moving to the root fires this on
    // the note it started on.
    on(root, 'lostpointercapture', (e) => {
      if (e.target === root) this.onPointerEnd(e)
    })
    on(root, 'pointerdown', this.onToolDown)
    on(root, 'pointermove', this.onToolMove)
    on(root, 'pointerup', this.onToolUp)
    on(root, 'pointercancel', this.onToolCancel)
    on(root, 'lostpointercapture', this.onToolCancel)
    on(root, 'mousedown', (e) => {
      // The paper around the editor keeps the focus in it (no blur ends the writing).
      if (e.button === 1 || (e.button === 0 && onEditedNote(e.target) && !inEditor(e.target))) {
        e.preventDefault()
      }
    })
    // Two presses on loose ends are a double-click on what reads as cork: it edits no note.
    on(
      root,
      'dblclick',
      (e) => {
        if (performance.now() - this.loosePressAt < LOOSE_DOUBLE_MS) e.stopImmediatePropagation()
      },
      { capture: true },
    )
    on(root, 'focusin', this.onFocusIn)
    on(root, 'focusout', this.onFocusOut)
    on(window, 'keydown', this.onKeyDown)
    on(window, 'keyup', this.onKeyUp)
    // Each can swallow the pointer-up (macOS Ctrl+click opens the menu on mousedown), so a
    // gesture would follow a released mouse and the next click would commit it.
    on(root, 'contextmenu', this.onContextMenu)
    on(window, 'blur', this.abandonInput)
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') this.abandonInput()
    }
    document.addEventListener('visibilitychange', onVisibility)
    this.cleanups.push(() => document.removeEventListener('visibilitychange', onVisibility))
    this.cleanups.push(installCaptureHandlers(root, this))
  }

  private watchDpr(): void {
    if (typeof matchMedia !== 'function') return
    const mq = matchMedia(`(resolution: ${dprNow()}dppx)`)
    const onChange = () => {
      mq.removeEventListener('change', onChange)
      this.resize()
      this.watchDpr()
    }
    mq.addEventListener('change', onChange)
    this.cleanups.push(() => mq.removeEventListener('change', onChange))
  }

  private onWheel = (e: WheelEvent): void => {
    // Over the UI layer (sidebar, strip, HUD, a sheet) the wheel neither pans nor zooms the board;
    // it scrolls what scrolls there. A pinch over it is still not the page's to zoom.
    if (e.target instanceof Element && e.target.closest('.ui')) {
      if (e.ctrlKey || e.metaKey) e.preventDefault()
      return
    }
    e.preventDefault()
    // Under a sheet the board takes nothing, even where the press or wheel reaches it.
    if (this.els.root.hasAttribute('data-covered')) return
    const p = this.toViewport(e.clientX, e.clientY)
    const intent = interpretWheel(e, p, this.viewport.height, prefsStore.getState())
    const c = this.camera.get()
    if (intent.kind === 'pan') this.camera.set(panBy(c, intent.dx, intent.dy))
    else this.camera.set(zoomAt(c, intent.at, c.zoom * intent.factor))
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    // Alt (Option) held while dragging merges a note held beside another; without it, it moves.
    if (e.key === 'Alt') this.merge.allow(true)
    // Only keys of the board's own: from the page itself or inside the board, never from what
    // lies beside it (a book's pane in the split view).
    if (!this.ownsKey(e.target)) return
    if (this.held) return
    if (this.keysHeld()) return
    if (this.toolActive?.key({ key: e.key })) {
      e.preventDefault()
      this.toolPointerId = null
      this.toolActive = null
      this.lastTool = null
      return
    }
    // Esc: an open picker stops it before it gets here, and writing takes it in its field (or
    // the stage, while the field has no focus yet); then focus mode; then the selection (stage).
    if (this.onFocusKey(e)) {
      e.preventDefault()
      return
    }
    if (this.stage?.key(e)) {
      e.preventDefault()
      return
    }
    const step = historyKey(e)
    if (step !== null) {
      e.preventDefault()
      // Mid-drag the gesture owns the notes it holds: the undo is ignored, not queued.
      if (this.toolActive === null) {
        this.merge.settle()
        this.history?.step(step)
      }
      return
    }
    const sel = selectionKey(e)
    if (sel !== null && this.selectionCommand(sel, e.target)) {
      e.preventDefault()
      return
    }
    const cmd = keyCommand(e)
    if (cmd === 'panHold') {
      e.preventDefault()
      this.setSpace(true)
    } else if (cmd !== null) {
      e.preventDefault()
      this.run(cmd)
    } else {
      const tool = toolKey(e)
      // A held key repeats: Yarn's colour picker and the file picker open once per press.
      if (tool === 'yarn' && e.repeat) return
      if (tool !== null) takeUpTool(tool)
      else if (photoKey(e) && !e.repeat) openPhotoPicker()
    }
  }

  /** Whether a key at `target` is the board's at all: the page itself, or inside the board. */
  private ownsKey(target: EventTarget | null): boolean {
    if (!(target instanceof Node)) return true
    if (target === document || target === document.body || target === document.documentElement)
      return true
    return this.els.root.contains(target)
  }

  /** Whether keys at `target` are the board's: the page itself, or the canvas outside its UI. */
  private boardKeyTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return true
    if (target === document.body || target === document.documentElement) return true
    return this.els.root.contains(target) && target.closest('.ui') === null
  }

  /** Run an arrow, Alt+arrow or ⌘A; whether the board took the key. */
  private selectionCommand(cmd: SelectionCommand, target: EventTarget | null): boolean {
    // Writing has the arrows (and ⌘A) even while its field is not yet focused; a press under way
    // owns the notes it holds.
    if (this.edit !== null || this.pressing || !this.boardKeyTarget(target)) return false
    if (cmd.kind === 'all') {
      this.selectAll()
      return true
    }
    return cmd.kind === 'move'
      ? this.moveSelection(cmd.dir)
      : this.nudgeSelection(cmd.dir, cmd.step)
  }

  /** The drawn height of a note (its measured content may exceed `h`). */
  private heightOf = (n: Note): number => Math.max(n.h, this.measuredH.get(n.id) ?? 0)

  /**
   * Arrow key: select, focus and bring into view the nearest note that way from the one last
   * selected (an rbush query around it). With nothing selected the arrow starts from the note
   * nearest the middle of the view. Whether the key was taken (false: nothing to move on from).
   */
  private moveSelection(dir: Direction): boolean {
    const s = this.board()
    const from = this.anchorNote()
    if (from === undefined) {
      const first = this.nearestToCentre()
      if (first === undefined) return false
      this.goTo(first)
      return true
    }
    const to = this.nearestShown(s, from, dir)
    if (to !== null) this.goTo(to)
    return true
  }

  /**
   * The nearest note `dir` of `from` that is shown. With focus off, the index's bands. With focus
   * on, the hidden notes must not be read: while the focus holds at most half the board, its
   * own set is scanned once (O(|focus|)); a larger focus leaves fewer hidden notes than shown
   * ones, so the bands over the filtered index read at most the board, under 2 × |focus|.
   */
  private nearestShown(s: BoardState, from: string, dir: Direction): string | null {
    const focus = this.focusMode.result
    if (focus === null) return nearestInDirection(s, from, dir, this.index, this.heightOf)
    if (2 * focus.notes.size <= s.notes.size) {
      return nearestAmong(s, from, dir, focus.notes, this.heightOf)
    }
    return nearestInDirection(s, from, dir, this.focusIndex(), this.heightOf)
  }

  /** The culled note whose centre is nearest the middle of the viewport, if any. */
  private nearestToCentre(): string | undefined {
    const c = this.camera.get()
    const mid = {
      x: c.x + this.viewport.width / 2 / c.zoom,
      y: c.y + this.viewport.height / 2 / c.zoom,
    }
    const { notes } = this.board()
    let best: { id: string; d: number } | undefined
    for (const id of this.focusIndex().notesIn(cullRect(c, this.viewport))) {
      const n = notes.get(id)
      if (n === undefined) continue
      const d = Math.hypot(n.x + n.w / 2 - mid.x, n.y + this.heightOf(n) / 2 - mid.y)
      if (best === undefined || d < best.d || (d === best.d && id < best.id)) best = { id, d }
    }
    return best?.id
  }

  /** Make `id` the selection, bring it into view and give it the keyboard (once it mounts). */
  private goTo(id: string): void {
    this.takeNow([id])
    this.selectNotes([id], 'replace')
    const r = this.notesRect([id])
    const to = r === null ? null : revealCamera(this.camera.target(), this.viewport, r)
    if (to !== null) this.camera.animateTo(to, this.reducedMotion())
    const el = this.noteEls.get(id)
    if (el !== undefined) el.focus({ preventScroll: true })
    // Overview mounts no notes: the outline is all there is to move.
    else if (this.lodMode !== 'overview') this.wantFocus = id
  }

  /**
   * Alt+arrow: move the selection `step` world px, one batch labelled and coalesced as `nudge`.
   * Nudges less than `NUDGE_WINDOW_MS` apart on the same selection are one undo step, and one
   * announcement, said when they stop.
   */
  private nudgeSelection(dir: Direction, step: number): boolean {
    if (this.selection.size === 0) return false
    const dx = dir === 'left' ? -step : dir === 'right' ? step : 0
    const dy = dir === 'up' ? -step : dir === 'down' ? step : 0
    this.takeNow(this.selection)
    const ops = nudgeOps(this.board().notes, this.selection, dx, dy)
    if (ops.length === 0) return true
    const now = performance.now()
    const prev = this.nudged
    if (prev === null || now - prev.at > NUDGE_WINDOW_MS || prev.of !== this.selection) {
      this.history?.seal()
    }
    this.nudged = { at: now, of: this.selection }
    try {
      this.store.commit(ops, { coalesceKey: NUDGE, label: NUDGE })
    } catch {
      // The board is not what the selection was (a note went meanwhile): nothing moved.
      return true
    }
    clearTimeout(this.nudgeSaid)
    this.nudgeSaid = setTimeout(() => announce(movedCopy(ops.length)), NUDGE_WINDOW_MS)
    return true
  }

  /** F focuses the selection; Esc leaves focus. Not while writing or mid-gesture. */
  private onFocusKey(e: KeyboardEvent): boolean {
    const cmd = focusKey(e)
    if (cmd === null || this.edit !== null || this.live !== null || this.toolActive !== null) {
      return false
    }
    if (cmd === 'focus') return this.focusSelection()
    if (this.focusMode.state === null) return false
    this.setFocus(null)
    return true
  }

  /**
   * A touch or pen held still opens the context menu: on the board that long press is the
   * marquee's, so it opens none and ends nothing. A mouse's (macOS Ctrl+click opens it on
   * mousedown, swallowing the pointer-up) ends every gesture.
   */
  private onContextMenu = (e: MouseEvent): void => {
    const type = (e as Partial<PointerEvent>).pointerType
    if (this.touches.size > 0 || type === 'touch' || type === 'pen') {
      if (!(e.target instanceof Element && e.target.closest('.ui'))) e.preventDefault()
      return
    }
    this.abandonInput()
  }

  /** End every gesture and the Space hold, committing nothing. */
  private abandonInput = (): void => {
    this.merge.allow(false)
    this.cancelGesture()
    this.endPan()
    this.setSpace(false)
  }

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.key === 'Alt') this.merge.allow(this.holdMerges)
    if (e.code === 'Space' || e.key === ' ') this.setSpace(false)
  }

  private setSpace(held: boolean): void {
    if (this.spaceHeld === held) return
    this.spaceHeld = held
    if (held) this.els.root.dataset.space = ''
    else delete this.els.root.dataset.space
  }

  private onPointerDown = (e: PointerEvent): void => {
    this.keyHoldUntil = 0
    this.merge.settle()
    if (e.target instanceof Element && e.target.closest('.ui, .note-ink, .note-ref-edit')) return
    if (this.els.root.hasAttribute('data-covered')) return
    // A press anywhere but on the note being written on ends writing (as the blur that follows
    // it does).
    const writing = e.button === 0 && onEditedNote(e.target)
    if (this.edit !== null && e.button === 0 && !writing) this.stopEditing()
    const p = this.toViewport(e.clientX, e.clientY)
    if (e.pointerType === 'touch') {
      this.touches.set(e.pointerId, p)
      if (this.touches.size === 2) {
        this.endPan()
        this.cancelGesture()
        const [a, b] = [...this.touches.entries()] as [[number, Point], [number, Point]]
        this.pinch = { ids: [a[0], b[0]], prev: [a[1], b[1]] }
        e.stopPropagation()
        return
      }
      if (this.touches.size > 2) return
    }
    const wantsPan = e.button === 1 || (e.button === 0 && this.spaceHeld)
    // On the note being written on the press places the caret or selects: no pin, yarn or tool
    // takes it. Beside the text (the paper's margins), the caret goes to the end.
    if (writing && !wantsPan) {
      if (!inEditor(e.target)) this.caretToEnd()
      return
    }
    if (wantsPan) {
      if (this.pan !== null) return
      e.preventDefault()
      e.stopPropagation()
      this.startPan(e.pointerId, p)
      return
    }
    // A loose end expands the focus; it is drawn on the pin layer, above the yarn.
    if (e.button === 0 && this.pressLooseEnd(p)) {
      e.preventDefault()
      e.stopPropagation()
      return
    }
    // Pins and yarn sit above the notes: a press they take never reaches the note or the tool.
    if (this.stage?.down(e)) e.stopPropagation()
  }

  /**
   * The paper under a press lifts (note.css, `data-pressed`): one attribute on one mounted note,
   * set at the press and taken off at its end, so no other note is restyled or rendered.
   */
  private setPressed(noteId: string | null): void {
    const el = noteId === null ? null : (this.noteEls.get(noteId) ?? null)
    if (el === this.pressedEl) return
    this.pressedEl?.removeAttribute('data-pressed')
    el?.setAttribute('data-pressed', '')
    this.pressedEl = el
  }

  /** Pan with pointer `id`; `fromCork`: a press on bare cork, a click until it travels. */
  private startPan(id: number, at: Point, fromCork = false): void {
    try {
      this.els.root.setPointerCapture(id)
    } catch {
      // The pointer is already gone; panning still follows it if it moves.
    }
    this.pan = fromCork ? { id, last: at, from: at } : { id, last: at }
    // A press on cork shows the hand once it moves: a click there is no pan.
    if (!fromCork) this.els.root.dataset.panning = ''
  }

  private endPan(): void {
    clearTimeout(this.longPress)
    if (this.pan === null) return
    const { id } = this.pan
    this.pan = null
    delete this.els.root.dataset.panning
    releaseCapture(this.els.root, id)
  }

  private onPointerMove = (e: PointerEvent): void => {
    const p = this.toViewport(e.clientX, e.clientY)
    if (this.touches.has(e.pointerId)) this.touches.set(e.pointerId, p)
    const pinch = this.pinch
    if (pinch?.ids.includes(e.pointerId)) {
      const a = this.touches.get(pinch.ids[0])
      const b = this.touches.get(pinch.ids[1])
      if (a && b) {
        const next: [Point, Point] = [a, b]
        this.camera.set(pinchCamera(this.camera.get(), pinch.prev, next))
        pinch.prev = next
      }
      e.stopPropagation()
      return
    }
    if (this.pan === null || this.pan.id !== e.pointerId) {
      this.hoverLooseEnd(e)
      this.stage?.move(e)
      return
    }
    if (releasedMouse(e)) {
      this.endPan()
      return
    }
    e.stopPropagation()
    const { from } = this.pan
    if (from !== undefined) {
      if (Math.hypot(p.x - from.x, p.y - from.y) < DRAG_THRESHOLD_PX) return
      this.pan.from = undefined
      clearTimeout(this.longPress)
      this.els.root.dataset.panning = ''
    }
    const dx = p.x - this.pan.last.x
    const dy = p.y - this.pan.last.y
    this.pan.last = p
    this.camera.set(panBy(this.camera.get(), dx, dy))
  }

  private onPointerEnd = (e: PointerEvent): void => {
    this.stage?.end(e)
    this.touches.delete(e.pointerId)
    if (this.pinch?.ids.includes(e.pointerId)) {
      this.pinch = null
      // The finger left on the board carries on as a pan, as a drag on the cork does.
      const rest = [...this.touches.entries()][0]
      if (rest) this.startPan(rest[0], rest[1])
      return
    }
    if (this.pan?.id !== e.pointerId) return
    // A press on cork that never travelled is a click there: it clears the selection.
    const click = this.pan.from !== undefined && e.type === 'pointerup'
    this.endPan()
    if (click) this.clearSelection()
  }

  /** A pointer event as the tools see it, mapped through the drawn camera. */
  toolPointer(e: PointerEvent): ToolPointer {
    const screen = this.toViewport(e.clientX, e.clientY)
    return {
      screen,
      world: screenToWorld(this.drawnCamera(), screen),
      button: e.button,
      shiftKey: e.shiftKey,
      target: toolTarget(e.target),
    }
  }

  /**
   * Bubble phase: reached only when the capture-phase dispatch let the press through (the yarn
   * tool's work on notes, pins and threads is all in the capture phase). With any tool, a press
   * on bare cork pans the board (a click there clears the selection) and with Shift rubber-bands
   * a marquee that adds to the selection; with the select tool, a press on a note selects,
   * drags or resizes it.
   */
  private onToolDown = (e: PointerEvent): void => {
    if (this.toolPointerId !== null || this.pan !== null) return
    if (e.target instanceof Element && e.target.closest('.ui, .note-ink, .note-ref-edit')) return
    if (this.els.root.hasAttribute('data-covered')) return
    if (onEditedNote(e.target)) return
    if (e.pointerType === 'touch' && this.touches.size > 1) return
    let p = this.toolPointer(e)
    // Overview mounts no notes: a press on a card is a press on its note.
    if (this.lodMode === 'overview' && p.target.noteId === undefined) {
      const noteId = this.noteAt(p.world)
      if (noteId !== undefined) p = { ...p, target: { noteId } }
    }
    const pressed = p.target.noteId
    if (pressed !== undefined && this.catching !== null) {
      // A gesture on a note (and the selection it may move) starts from the store's records. A
      // note a restore removed goes now, and the press with it.
      this.takeNow([pressed, ...this.selection])
      if (!this.board().notes.has(pressed)) {
        this.recullDue = true
        this.loop.request()
        return
      }
    }
    const cork = pressed === undefined
    if (cork && !e.shiftKey) {
      if (e.button !== 0) return
      this.startPan(e.pointerId, p.screen, true)
      if (e.pointerType === 'touch' || e.pointerType === 'pen') this.armLater(e.pointerId, p)
      return
    }
    let tool: ToolHandlers | null = cork ? this.marqueeTool : null
    if (!cork && prefsStore.getState().tool === 'select') tool = this.selectTool
    if (tool === null) return
    // Touch and pen have no Alt: there the hold beside a note alone merges.
    this.holdMerges = e.pointerType === 'touch' || e.pointerType === 'pen'
    this.merge.allow(e.altKey || this.holdMerges)
    tool.pointerDown(p)
    if (e.button !== 0) return
    if (tool === this.selectTool && pressed !== undefined) this.setPressed(pressed)
    // On touch, a card held still beside the book offers Copy · Move.
    if (tool === this.selectTool && pressed !== undefined && e.pointerType !== 'mouse') {
      this.holdCard(e.pointerId, pressed, e.clientX, e.clientY)
    }
    this.pressFrom = p.screen
    this.travelled = false
    this.toolPointerId = e.pointerId
    this.toolActive = tool
    this.lastTool = p
    try {
      // Moves and the release reach the root wherever the pointer goes.
      this.els.root.setPointerCapture(e.pointerId)
    } catch {
      // Not an active pointer (synthetic events): they still bubble to the root.
    }
  }

  /**
   * Touch and pen have no Shift: a press on bare cork held `LONG_PRESS_MS` without travelling
   * turns from a pan into the marquee, adding to the selection as Shift does. The band's corner
   * shows at the press as it arms.
   */
  private armLater(id: number, press: ToolPointer): void {
    clearTimeout(this.longPress)
    this.longPress = setTimeout(() => {
      this.longPress = undefined
      const pan = this.pan
      if (pan === null || pan.id !== id || pan.from === undefined || this.toolPointerId !== null) {
        return
      }
      // The pointer stays captured: its moves now draw the band.
      this.pan = null
      const p = { ...press, shiftKey: true }
      this.marqueeTool.pointerDown(p)
      this.pressFrom = p.screen
      this.travelled = false
      this.toolPointerId = id
      this.toolActive = this.marqueeTool
      this.lastTool = p
      this.overlay.armBand(p.screen)
    }, LONG_PRESS_MS)
  }

  private holdCard(id: number, noteId: string, x: number, y: number): void {
    clearTimeout(this.cardHold)
    if (this.seamDrop?.press === undefined) return
    this.cardHold = setTimeout(() => {
      if (this.toolPointerId === id && !this.travelled) this.seamDrop?.press?.(noteId, x, y)
    }, LONG_PRESS_MS)
  }

  private onToolMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.toolPointerId) return
    if (releasedMouse(e)) {
      this.cancelGesture()
      return
    }
    // Over the book: the drag is the book's to show (no bridge forms, the board's drag waits).
    const seam = this.seamIds(e)
    this.merge.allow((e.altKey || this.holdMerges) && seam === null)
    if (seam !== null) {
      this.seamOver = true
      ;(this.seamDrop as SeamDrop).hover(e.clientX, e.clientY, seam, e.altKey)
      return
    }
    this.seamLeave()
    const p = this.toolPointer(e)
    this.lastTool = p
    const from = this.pressFrom
    if (from && Math.hypot(p.screen.x - from.x, p.screen.y - from.y) >= DRAG_THRESHOLD_PX) {
      this.travelled = true
      clearTimeout(this.cardHold)
    }
    this.toolActive?.pointerMove(p)
  }

  private onToolUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.toolPointerId) return
    clearTimeout(this.cardHold)
    const seam = this.seamIds(e)
    if (seam !== null) {
      // Into the book: the board's drag ends committing nothing, then the book takes the cards.
      const target = this.seamDrop as SeamDrop
      this.seamOver = false
      this.cancelGesture()
      target.drop(e.clientX, e.clientY, seam, e.altKey)
      return
    }
    this.seamLeave()
    this.setPressed(null)
    // A merge only with Alt still held at the release (its keyup may have gone elsewhere).
    this.merge.allow(e.altKey || this.holdMerges)
    const tool = this.toolActive
    this.toolPointerId = null
    this.toolActive = null
    this.lastTool = null
    tool?.pointerUp(this.toolPointer(e))
    this.overlay.armBand(null)
  }

  private onToolCancel = (e: PointerEvent): void => {
    if (e.pointerId !== this.toolPointerId) return
    if (e.type === 'lostpointercapture' && e.target !== this.els.root) return
    this.cancelGesture()
  }
}
