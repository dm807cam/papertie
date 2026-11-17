import { PALETTE_TOKENS, type PaletteToken } from '@papertie/core'
import { useStore } from 'zustand'
import { createStore, type StoreApi } from 'zustand/vanilla'
import {
  NOTE_DECORATIONS,
  NOTE_STYLES,
  type NoteDecoration,
  type NoteStyle,
} from '../notes/noteDesign'

export type Tool = 'select' | 'yarn'

/** What the app remembers about how the board is used; never part of a board file. */
export interface Prefs {
  tool: Tool
  motion: 'system' | 'full' | 'reduced'
  wheel: 'pan' | 'zoom'
  /** Paper tilt: each note rests at its own small angle. */
  tilt: boolean
  /** The design last pinned with "+", which the paper picker opens on: its paper colour, */
  noteColor: PaletteToken
  /** its paper style, */
  noteStyle: NoteStyle
  /** its decoration, */
  noteDecoration: NoteDecoration
  /** and the colour of its layered sheet, kept while another decoration is chosen. */
  noteSheet: PaletteToken
  /** The colour the Yarn tool was last armed with, which its picker opens on. */
  yarnColor: PaletteToken
  /** The sidebar unrolled, or folded to its mark. */
  sidebar: 'open' | 'folded'
  /** Dev builds only (A/B strip): where the yarn runs against the notes. */
  layer: 'over' | 'over-fix' | 'under'
  /** Dev builds only: the perf HUD. */
  hud: boolean
}

export const DEFAULT_PREFS: Readonly<Prefs> = {
  tool: 'select',
  motion: 'system',
  wheel: 'pan',
  tilt: true,
  noteColor: 'cream',
  noteStyle: 'rustic',
  noteDecoration: 'none',
  noteSheet: 'rose',
  yarnColor: 'apricot',
  sidebar: 'open',
  layer: 'over',
  hud: false,
}

export const PREFS_KEY = 'papertie.prefs'

/** A stored value outside these loads as the default, and a stored key not here is dropped. */
const CHOICES: { [K in keyof Prefs]: readonly Prefs[K][] } = {
  tool: ['select', 'yarn'],
  motion: ['system', 'full', 'reduced'],
  wheel: ['pan', 'zoom'],
  tilt: [true, false],
  noteColor: PALETTE_TOKENS,
  noteStyle: NOTE_STYLES,
  noteDecoration: NOTE_DECORATIONS,
  noteSheet: PALETTE_TOKENS,
  yarnColor: PALETTE_TOKENS,
  sidebar: ['open', 'folded'],
  layer: ['over', 'over-fix', 'under'],
  hud: [true, false],
}

const DEV_KEYS: readonly (keyof Prefs)[] = ['layer', 'hud']

/** The keys a build keeps: the dev-only ones exist in dev builds only. */
function keptKeys(dev: boolean): (keyof Prefs)[] {
  return (Object.keys(CHOICES) as (keyof Prefs)[]).filter((k) => dev || !DEV_KEYS.includes(k))
}

type PrefsStorage = Pick<Storage, 'getItem' | 'setItem'>

/** The stored prefs, field by field validated. */
function load(storage: PrefsStorage | undefined, dev: boolean): Prefs {
  const prefs: Prefs = { ...DEFAULT_PREFS }
  let stored: unknown
  try {
    stored = JSON.parse(storage?.getItem(PREFS_KEY) ?? 'null')
  } catch {
    // Unreadable or malformed storage: nothing stored.
    return prefs
  }
  if (stored === null || typeof stored !== 'object') return prefs
  for (const k of keptKeys(dev)) {
    const v = (stored as Record<string, unknown>)[k]
    if ((CHOICES[k] as readonly unknown[]).includes(v)) Object.assign(prefs, { [k]: v })
  }
  return prefs
}

/**
 * A prefs store that loads from `storage` once, field by field validated, and saves to it on
 * every change. Dev-only keys (`layer`, `hud`) load and save only when `dev`; otherwise they stay
 * at their defaults.
 */
export function createPrefsStore(
  storage: PrefsStorage | undefined,
  dev: boolean = import.meta.env.DEV,
): StoreApi<Prefs> {
  const store = createStore<Prefs>()(() => load(storage, dev))
  store.subscribe((p) => {
    try {
      const out = Object.fromEntries(keptKeys(dev).map((k) => [k, p[k]]))
      storage?.setItem(PREFS_KEY, JSON.stringify(out))
    } catch {
      // Storage full or blocked: keep the in-memory value.
    }
  })
  return store
}

function browserStorage(): PrefsStorage | undefined {
  try {
    // `window.`: bare `localStorage` warns in Node, where there is none.
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

/** The app's prefs, persisted to `localStorage['papertie.prefs']`. */
export const prefsStore = createPrefsStore(browserStorage())

/** Read a slice of the prefs from React. */
export function usePrefs<T>(selector: (p: Prefs) => T): T {
  return useStore(prefsStore, selector)
}

/** Whether motion should be reduced: the pref wins, "system" follows the media query. */
export function isReducedMotion(p: Prefs, systemReduced: boolean): boolean {
  if (p.motion === 'reduced') return true
  if (p.motion === 'full') return false
  return systemReduced
}

/** The `prefers-reduced-motion` media query, false where it cannot be read. */
export function systemReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}
