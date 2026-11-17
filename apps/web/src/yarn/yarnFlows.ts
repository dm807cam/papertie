import {
  type ClientOp,
  LIMITS,
  type Note,
  newId,
  OpError,
  PALETTE,
  type PaletteToken,
  type PinKey,
  type Yarn,
} from '@papertie/core'
import { announce } from '../app/liveRegion'
import { prefsStore } from '../app/prefs'
import { anchorKey, type End, HANGING, topologyOf } from '../canvas/attach'
import type { BoardStore } from '../store/boardStore'

/**
 * The colour a new thread is tied in, read by the flows and the live strand alike: the one the
 * Yarn tool was last armed with (apricot until another is chosen). Nothing changes a
 * thread's colour afterwards.
 */
export const newYarnColor = (): PaletteToken => prefsStore.getState().yarnColor

/** What notices and undo announcements call these changes. */
export const YARN_LABELS = {
  tie: 'tie',
  wind: 'wind',
  untie: 'untie',
} as const

/**
 * What the canvas does around a yarn change, kept out of the flows so they work on a bare store:
 * select a thread, draw a new one in, pulse one, loosen one about to be deleted. Each is optional.
 */
export interface YarnFx {
  select?(yarnId: string): void
  drawIn?(yarnId: string): void
  pulse?(yarnId: string): void
  /** Called with the thread as it is, just before a commit that deletes it. */
  loosen?(yarn: Yarn): void
}

export interface TieResult {
  yarnId: string
  /** False when `from` and `to` already shared a thread of that colour: it was pulsed instead. */
  created: boolean
}

/** The palette's name for a dye, as it is said aloud: "crimson", "moss". */
export const dyeName = (color: PaletteToken): string => PALETTE[color].yarnName.toLowerCase()

/** Why a thread change was refused, in words for the live region; undefined for a bug. */
export function failureMessage(err: unknown): string | undefined {
  if (!(err instanceof OpError)) return undefined
  if (err.code === 'limit') return `This thread already has ${LIMITS.maxThreadNotes} notes`
  if (err.code === 'not-found') return 'That note is no longer on the board'
  return 'Couldn’t change the thread'
}

/** Say why `err` (a refused thread change) happened; rethrows anything that is not an OpError. */
export function announceFailure(err: unknown): void {
  const message = failureMessage(err)
  if (message === undefined) throw err
  announce(message)
}

/** The end of a thread a note is wound onto. */
export type ThreadEnd = 'first' | 'last'

const NO_FX: YarnFx = {}

/** What a screen reader hears of a note: its first line. */
const LEAD_MAX = 40

export function noteLead(n: Note | undefined, max = LEAD_MAX): string {
  if (n === undefined) return 'Note'
  const line = n.text.split('\n').find((l) => l.trim() !== '')
  const t = line?.replace(/\s+/g, ' ').trim() ?? ''
  if (t === '') return n.image !== null ? 'Picture' : 'Empty note'
  if (t.length <= max) return t
  // Cut on a whole character: never between the halves of a surrogate pair.
  let end = max
  const c = t.charCodeAt(end - 1)
  if (c >= 0xd800 && c <= 0xdbff) end--
  return `${t.slice(0, end)}…`
}

/**
 * A thread of `color` that `from` and `to` are both on, if any. It looks only at the threads
 * touching `from` (the renderer's membership index, `topologyOf`), never at every yarn.
 */
function sharedThread(
  store: BoardStore,
  from: string,
  to: string,
  color: PaletteToken,
): Yarn | undefined {
  const s = store.getState()
  for (const end of topologyOf(s).byNote.get(from) ?? []) {
    const yarn = s.yarns.get(end.ref.yarnId)
    if (yarn?.color === color && yarn.noteIds.includes(to)) return yarn
  }
  return undefined
}

/**
 * An existing pin of a note that a thread end is tied at: its hanging pin, or the pin that holds
 * thread `yarnId`'s end there (`end` of its segment: `'a'` toward the thread's next note, `'b'`
 * toward its previous one; a thread through the note has both), from then on shared by both.
 */
export type PinChoice = typeof HANGING | { yarnId: string; end: End }

/** The existing pins a new thread's ends are tied at; an end without one gets its own edge pin. */
export interface TiePins {
  from?: PinChoice
  to?: PinChoice
}

/**
 * Resolves pin choices to keys while a batch is built. A thread end with no key yet gets the key
 * that names it (`anchorKey`, which keeps the pin where it is), and the `yarn.update` that sets
 * it on that thread (one per thread, however many of its ends are shared) leads the batch.
 * `joined` counts the choices whose pin already held a thread.
 */
function pinKeys(store: BoardStore) {
  const s = store.getState()
  const patches = new Map<string, Record<string, PinKey>>()
  let joined = 0
  const pinsOf = (yarn: Yarn) => patches.get(yarn.id) ?? yarn.pins ?? {}
  const keyFor = (noteId: string, choice: PinChoice): PinKey | undefined => {
    if (choice === HANGING) {
      if (
        topologyOf(s)
          .byNote.get(noteId)
          ?.some((e) => e.pin === HANGING)
      )
        joined++
      return HANGING
    }
    const yarn = s.yarns.get(choice.yarnId)
    if (yarn === undefined || !yarn.noteIds.includes(noteId)) return undefined
    joined++
    const had = pinsOf(yarn)[noteId]
    if (had !== undefined) return had
    const key = anchorKey(yarn.id, choice.end)
    patches.set(yarn.id, { ...pinsOf(yarn), [noteId]: key })
    return key
  }
  const updates = (): ClientOp[] =>
    [...patches].map(([id, pins]) => ({ op: 'yarn.update', id, set: { pins } }))
  return { keyFor, updates, joined: () => joined }
}

/** What a tie or a wind adds to its announcement when it joined pins that held threads. */
const onExisting = (n: number) =>
  n === 0 ? '' : n === 1 ? ', on the existing pin' : ', on the existing pins'

/**
 * Tie `from` to `to` with a new two-note thread of `color`, drawn in; `pins` ties either end at
 * an existing pin of its note instead of an edge pin of its own (one batch, one undo, whatever it
 * changes). When they already share a thread of that colour (not only neighbours: any two notes
 * on it), nothing is created: that thread is selected and pulsed once instead.
 */
export function tie(
  store: BoardStore,
  from: string,
  to: string,
  color: PaletteToken,
  fx: YarnFx = NO_FX,
  pins: TiePins = {},
): TieResult {
  const s = store.getState()
  const [a, b] = [noteLead(s.notes.get(from)), noteLead(s.notes.get(to))]
  const colour = dyeName(color)
  const existing = sharedThread(store, from, to, color)
  if (existing !== undefined) {
    fx.select?.(existing.id)
    fx.pulse?.(existing.id)
    announce(`“${a}” and “${b}” are already tied with ${colour} yarn`)
    return { yarnId: existing.id, created: false }
  }
  const keys = pinKeys(store)
  const tied: Record<string, PinKey> = {}
  for (const [noteId, choice] of [
    [from, pins.from],
    [to, pins.to],
  ] as const) {
    const key = choice && keys.keyFor(noteId, choice)
    if (key !== undefined) tied[noteId] = key
  }
  const shared = Object.keys(tied).length
  const joined = keys.joined()
  const yarnId = newId('yarn')
  const at = store.now()
  store.commit(
    [
      ...keys.updates(),
      {
        op: 'yarn.create',
        yarn: {
          type: 'yarn',
          id: yarnId,
          noteIds: [from, to],
          color,
          label: '',
          ...(shared === 0 ? {} : { pins: tied }),
          createdAt: at,
          updatedAt: at,
        },
      },
    ],
    { label: YARN_LABELS.tie },
  )
  fx.drawIn?.(yarnId)
  announce(`Tied “${a}” to “${b}” with ${colour} yarn${onExisting(joined)}`)
  return { yarnId, created: true }
}

/**
 * Wind `noteId` onto one end of a thread, tied at an edge pin of its own or, with `pin`, at that
 * existing pin of the note. Returns whether the thread changed.
 */
export function extend(
  store: BoardStore,
  yarnId: string,
  fromEnd: ThreadEnd,
  noteId: string,
  pin?: PinChoice,
): boolean {
  const yarn = store.getState().yarns.get(yarnId)
  if (yarn === undefined) return false
  const ops: ClientOp[] = [
    {
      op: 'yarn.insertNote',
      id: yarnId,
      noteId,
      // Null puts it first; the last note puts it last.
      afterNoteId: fromEnd === 'first' ? null : (yarn.noteIds.at(-1) ?? null),
    },
  ]
  const keys = pinKeys(store)
  const key =
    pin === undefined || yarn.noteIds.includes(noteId) ? undefined : keys.keyFor(noteId, pin)
  if (key !== undefined) {
    ops.push(...keys.updates(), {
      op: 'yarn.update',
      id: yarnId,
      set: { pins: { ...yarn.pins, [noteId]: key } },
    })
  }
  const before = store.commits
  store.commit(ops, { label: YARN_LABELS.wind })
  const changed = store.commits !== before
  if (changed) {
    const lead = noteLead(store.getState().notes.get(noteId))
    announce(`Added “${lead}” to the thread${onExisting(keys.joined())}`)
  }
  return changed
}

/** Loosen a thread out, then delete it; an unknown id does nothing. */
export function untie(store: BoardStore, yarnId: string, fx: YarnFx = NO_FX): void {
  const yarn = store.getState().yarns.get(yarnId)
  if (yarn === undefined) return
  fx.loosen?.(yarn)
  store.commit([{ op: 'yarn.delete', id: yarnId }], { label: YARN_LABELS.untie })
  announce('Untied the thread')
}

/**
 * The flows bound to a board and its canvas effects: what the canvas, the `Connect to…` picker
 * and the sidebar's Delete call. Nothing edits a thread once tied: it is wound on, or untied.
 */
export interface YarnFlows {
  /** Tie two notes; the colour is a new thread's (`colorOf`) unless given. */
  tie(from: string, to: string, color?: PaletteToken, pins?: TiePins): TieResult
  extend(yarnId: string, fromEnd: ThreadEnd, noteId: string, pin?: PinChoice): boolean
  untie(yarnId: string): void
}

export function createYarnFlows(
  store: BoardStore,
  fx: YarnFx = NO_FX,
  colorOf: () => PaletteToken = newYarnColor,
): YarnFlows {
  return {
    tie: (from, to, color = colorOf(), pins) => tie(store, from, to, color, fx, pins),
    extend: (yarnId, fromEnd, noteId, pin) => extend(store, yarnId, fromEnd, noteId, pin),
    untie: (yarnId) => untie(store, yarnId, fx),
  }
}
