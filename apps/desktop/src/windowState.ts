import { readFileSync, renameSync, writeFileSync } from 'node:fs'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** The window as it was left: its normal bounds (a position only when it is on a screen). */
export interface WindowState {
  width: number
  height: number
  x?: number
  y?: number
  maximized: boolean
  fullScreen: boolean
}

export const MIN_WIDTH = 720
export const MIN_HEIGHT = 480
export const DEFAULT_STATE: WindowState = {
  width: 1280,
  height: 800,
  maximized: false,
  fullScreen: false,
}

/** How much of the window must lie on some screen for its place to be kept. */
const ON_SCREEN = 64

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v)

const overlap = (a: Rect, b: Rect) =>
  Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) >= ON_SCREEN &&
  Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) >= ON_SCREEN

/**
 * The state to open with, from what was saved (anything: a missing or damaged file is the
 * default). The size is kept within the minimum and the largest screen; the place only while
 * enough of the window is on one of `screens` (their work areas), else it is centred.
 */
export function parseWindowState(raw: unknown, screens: readonly Rect[]): WindowState {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_STATE }
  const r = raw as Record<string, unknown>
  const maxW = Math.max(MIN_WIDTH, ...screens.map((s) => s.width))
  const maxH = Math.max(MIN_HEIGHT, ...screens.map((s) => s.height))
  const width = isInt(r.width) ? Math.min(Math.max(r.width, MIN_WIDTH), maxW) : DEFAULT_STATE.width
  const height = isInt(r.height)
    ? Math.min(Math.max(r.height, MIN_HEIGHT), maxH)
    : DEFAULT_STATE.height
  const state: WindowState = {
    width,
    height,
    maximized: r.maximized === true,
    fullScreen: r.fullScreen === true,
  }
  if (isInt(r.x) && isInt(r.y)) {
    const rect = { x: r.x, y: r.y, width, height }
    if (screens.some((s) => overlap(rect, s))) {
      state.x = r.x
      state.y = r.y
    }
  }
  return state
}

/** The saved state, read from `file` and checked against `screens`. */
export function readWindowState(file: string, screens: readonly Rect[]): WindowState {
  let raw: unknown = null
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    raw = null
  }
  return parseWindowState(raw, screens)
}

/** Saves `state` to `file` whole or not at all (a temporary file renamed over it). */
export function writeWindowState(file: string, state: WindowState): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state)}\n`)
  renameSync(tmp, file)
}
