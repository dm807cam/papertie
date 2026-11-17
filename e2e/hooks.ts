/** The slice of `window.__papertie` (apps/web `devHooks`) the proto specs read. Types only. */

export interface Pt {
  x: number
  y: number
}

export interface Cam extends Pt {
  zoom: number
}

export interface RenderStats {
  segmentsStatic: number
  segmentsDynamic: number
  pins: number
  staticRedrawn: boolean
}

export interface NoteGeom {
  id: string
  /** The revision the note last changed at, when the store keeps it. */
  rev?: number
  x: number
  y: number
  w: number
  h: number
  z: number
  text: string
}

export type Hit =
  | { kind: 'pin'; noteId: string; edge?: { yarnId: string; segIndex: number; end: 'a' | 'b' } }
  | { kind: 'yarn'; yarnId: string; segIndex: number }
  | { kind: 'none' }

/** What focus mode is asked for (apps/web `FocusState`). */
export interface FocusState {
  seeds: string[]
  depth: 1 | 2 | 3 | 'all'
  include: string[]
}

export interface Hooks {
  ready: boolean
  renders: Record<string, number>
  store: {
    getState(): {
      board: { name: string; revision: number }
      notes: Map<string, NoteGeom>
      yarns: Map<string, { id: string; noteIds: string[] }>
    }
    commits: number
  }
  debug: {
    camera(): Cam
    setCamera(c: Cam): void
    screenToWorld(p: Pt): Pt
    /** A note's hanging pin. */
    pinScreen(noteId: string): Pt | undefined
    /** The edge pin at one end of a yarn's `seg`-th segment. */
    attachScreen(yarnId: string, seg: number, end: 'a' | 'b'): Pt | undefined
    yarnPointScreen(yarnId: string, seg: number, t: number): Pt | undefined
    yarnProbe(yarnId: string, seg: number, t: number, normalOffsetPx: number): Pt | undefined
    hitAt(screen: Pt): Hit
    selectedYarn(): string | undefined
    stats(): RenderStats
    createYarn(aNoteId: string, bNoteId: string): string
    deleteYarn(yarnId: string): void
    motion(): { awakeCount: number; activeAnimations: number }
    drawInProgress(yarnId: string): number
    focusCamera(noteId: string, zoom: number): boolean
    /** The world point the render layers are drawn relative to (floating origin). */
    anchor(): Pt
    /** The level of detail drawn now. */
    lod(): 'full' | 'lite' | 'overview'
    /** The notes' "Tied to …" descriptions: how many were computed, and the time spent on them. */
    tied(): { computed: number; spentMs: number }
    /** World rect of every note (measured heights), or null for an empty board. */
    notesRect(): { x: number; y: number; w: number; h: number } | null
    /** The topmost note whose paper as drawn contains a world point. */
    noteAt(world: Pt): string | undefined
  }
  runtime: {
    loop: { running: boolean; framesDrawn: number }
    selection: ReadonlySet<string>
    camera: { moving: boolean }
    motion: { alphaOf(yarnId: string): number }
    reducedMotion(): boolean
    /** The camera as drawn, device-snapped. */
    drawnCamera(): Cam
    pinWorld(noteId: string): Pt | undefined
    selectNote(id: string | null): void
    selectNotes(ids: string[], mode?: 'replace' | 'add' | 'toggle'): void
    /** Open the editor on a note; the caret at the end. */
    startEditing(noteId: string): boolean
    /** A new note of `design`, centred in the view, selected and open for writing (the "+"). */
    createNoteAtCentre(design?: {
      paper: string
      style: 'rustic' | 'smooth' | 'print'
      decoration: string
      sheet: string
    }): string | undefined
    /** The note being written on, or null. */
    editing: string | null
    /** Focus on `f`, or the whole board for null. */
    setFocus(f: FocusState | null, opts?: { instant?: boolean }): void
    focusState: FocusState | null
    /** What focus shows, or null. */
    focus: {
      notes: Set<string>
      yarns: Set<string>
      looseEnds: Array<{ yarnId: string; noteId: string }>
    } | null
    /** The yarn layer's focus paint: `fade` is set while a fade runs. */
    focusPaint: { fade: { alpha: number } | null } | null
    /** The loose end under a viewport point, if any. */
    looseEndAt(screen: Pt): { yarnId: string; noteId: string; toward: string } | undefined
  }
}

/** `window.__papertiePerf` (apps/web `perfHooks`). */
export interface PerfSnapshot {
  fps: number
  p95FrameMs: number
  maxFrameMs: number
  longFrames: number
  frames: number
}

export type Gesture = 'pan' | 'zoom' | 'drag' | 'grab'

/** Per-row gesture changes (apps/web `GestureOptions`). */
export interface GestureOptions {
  zoomMin?: number
  zoomMax?: number
  sweepSec?: number
  hold?: boolean
  /** Drag with Alt held: no merge. */
  alt?: boolean
}

export interface Perf {
  record(): void
  stop(): PerfSnapshot
  loopRunning(): boolean
  runGesture(kind: Gesture, ms?: number, options?: GestureOptions): Promise<PerfSnapshot>
  zoomTo(zoom: number): Promise<PerfSnapshot>
  release(): Promise<void>
  /** Apply ops as a commit of the store's own; main-thread ms from the event to its frame's end. */
  remoteCommit(ops: unknown[]): Promise<{ eventMs: number; frameMs: number }>
}

declare global {
  interface Window {
    __papertie: Hooks
    __papertiePerf: Perf
  }
}
