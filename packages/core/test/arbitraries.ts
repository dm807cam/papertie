/**
 * Shared fast-check generators for @papertie/core: random valid board states and abstract op
 * scripts that `toOps` resolves into ops that are valid at their point in the sequence.
 * Reused by the cross-module property suite and by later sync tests.
 */
import fc from 'fast-check'
import {
  type ApplyCtx,
  type Asset,
  applyOp,
  type Board,
  type BoardState,
  type ClientMark,
  type IdPrefix,
  IMAGE_FRAMES,
  type ImageFrame,
  LIMITS,
  MOTIFS,
  type Motif,
  type Note,
  type NotePatch,
  type Op,
  PALETTE_TOKENS,
  PAPER_STYLES,
  type PaletteToken,
  type PaperStyle,
  type PinKey,
  type Yarn,
  type YarnPatch,
} from '../src/index'

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'.split('')

// ---------------------------------------------------------------------------------------------
// Field generators
// ---------------------------------------------------------------------------------------------

/** A schema-valid id with a random 26-char Crockford tail (covers the whole sort space). */
export function arbId(prefix: IdPrefix): fc.Arbitrary<string> {
  return fc
    .string({ unit: fc.constantFrom(...CROCKFORD), minLength: 26, maxLength: 26 })
    .map((tail) => `${prefix}_${tail}`)
}

/** ISO-8601 UTC timestamps with millisecond precision, years 2000–2099. */
export const arbIso: fc.Arbitrary<string> = fc
  .date({
    min: new Date('2000-01-01T00:00:00.000Z'),
    max: new Date('2099-12-31T23:59:59.999Z'),
    noInvalidDate: true,
  })
  .map((d) => d.toISOString())

/**
 * Full-Unicode text (any code point, lone surrogates included). `maxCodePoints` counts code
 * points, which can be two UTF-16 units each, so schema limits (in units) need half of it.
 * Lengths mix fast-check's default (short, ≤ ~20) with the full range up to the maximum.
 */
export function arbText(maxCodePoints: number, minCodePoints = 0): fc.Arbitrary<string> {
  const c = { unit: 'binary', minLength: minCodePoints, maxLength: maxCodePoints } as const
  return fc.oneof(fc.string(c), fc.string({ ...c, size: 'max' }))
}

/**
 * A finite number in [min, max]: integers and doubles, `-0` included (`fc.double` produces it).
 * Op scripts carry `-0` through to `applyOp`, which stores it as `0`.
 */
function arbNumber(min: number, max: number): fc.Arbitrary<number> {
  return fc.oneof(fc.integer({ min, max }), fc.double({ min, max, noNaN: true }))
}

const arbCoord = arbNumber(-LIMITS.maxCoord, LIMITS.maxCoord)
const arbW = arbNumber(LIMITS.noteMinW, LIMITS.noteMaxW)
const arbH = arbNumber(LIMITS.noteMinH, LIMITS.noteMaxH)
/** Integers, plus `-0` (an integer to the schema, which `fc.integer` never produces). */
const arbZ = fc.oneof(
  { weight: 9, arbitrary: fc.integer() },
  { weight: 1, arbitrary: fc.constant(-0) },
)
const arbPaper: fc.Arbitrary<PaletteToken> = fc.constantFrom(...PALETTE_TOKENS)
const arbStyle: fc.Arbitrary<PaperStyle> = fc.constantFrom(...PAPER_STYLES)
const arbFrame: fc.Arbitrary<ImageFrame> = fc.constantFrom(...IMAGE_FRAMES)
const arbMotif: fc.Arbitrary<Motif> = fc.constantFrom(...MOTIFS)
/** Few distinct keys, so ends of different threads share them. */
const arbPinKey: fc.Arbitrary<PinKey> = fc.constantFrom('hanging', 'p1', 'p2', 'a_-Z9')
/**
 * Shared pins as (index into the thread's notes, key) picks; resolved against the thread, so
 * keys always name notes on it. Absent half the time.
 */
const arbPinPicks = fc.option(
  fc.array(fc.tuple(fc.nat(), arbPinKey), { minLength: 1, maxLength: 4 }),
  {
    nil: undefined,
  },
)
type PinPicks = Array<[number, PinKey]>
const arbNoteText = arbText(200)
const arbLabel = arbText(Math.floor(LIMITS.maxLabelLength / 2))
const arbBoardName = arbText(60, 1)
const arbSha = fc.string({
  unit: fc.constantFrom(...'0123456789abcdef'.split('')),
  minLength: 64,
  maxLength: 64,
})

/** An image reference by index into whatever assets exist when it is resolved. */
export interface ImagePick {
  pick: number
  frame: ImageFrame
}
const arbImagePick: fc.Arbitrary<ImagePick | null> = fc.option(
  fc.record({ pick: fc.nat(), frame: arbFrame }),
  { nil: null },
)

export function arbAsset(): fc.Arbitrary<Asset> {
  return fc.record({
    type: fc.constant('asset' as const),
    id: arbId('asset'),
    mime: fc.constant('image/webp' as const),
    width: fc.integer({ min: 1, max: 20_000 }),
    height: fc.integer({ min: 1, max: 20_000 }),
    bytes: fc.integer({ min: 1, max: 50_000_000 }),
    sha256: arbSha,
    createdAt: arbIso,
  })
}

export function arbBoard(): fc.Arbitrary<Board> {
  const mark: fc.Arbitrary<ClientMark> = fc.record({
    lastSeq: fc.nat(),
    lastRevision: fc.nat(),
    seenAt: arbIso,
  })
  return fc.record({
    type: fc.constant('board' as const),
    schemaVersion: fc.constant(6 as const),
    id: arbId('board'),
    name: arbBoardName,
    revision: fc.nat(),
    // Built from entries (not fc.dictionary) so the object has a normal prototype.
    clients: fc
      .uniqueArray(fc.tuple(arbId('tab'), mark), { maxLength: 2, selector: ([id]) => id })
      .map((entries) => Object.fromEntries(entries)),
    createdAt: arbIso,
    updatedAt: arbIso,
  })
}

/** Every note field except `type`, `id` and `image`, which are resolved later. */
interface NoteDraft {
  x: number
  y: number
  w: number
  h: number
  z: number
  paper: PaletteToken
  style: PaperStyle
  text: string
  image: ImagePick | null
  /** Decorations are absent as often as present. */
  motif?: Motif
  stamp?: true
  layered?: PaletteToken
  createdAt: string
  updatedAt: string
}

const arbNoteDraft: fc.Arbitrary<NoteDraft> = fc.record(
  {
    x: arbCoord,
    y: arbCoord,
    w: arbW,
    h: arbH,
    z: arbZ,
    paper: arbPaper,
    style: arbStyle,
    text: arbNoteText,
    image: arbImagePick,
    motif: arbMotif,
    stamp: fc.constant(true as const),
    layered: arbPaper,
    createdAt: arbIso,
    updatedAt: arbIso,
  },
  {
    requiredKeys: [
      'x',
      'y',
      'w',
      'h',
      'z',
      'paper',
      'style',
      'text',
      'image',
      'createdAt',
      'updatedAt',
    ],
  },
)

function pickFrom<T>(items: readonly T[], i: number): T | undefined {
  return items.length === 0 ? undefined : items[i % items.length]
}

function resolveImage(pick: ImagePick | null, assetIds: readonly string[]): Note['image'] {
  const assetId = pick && pickFrom(assetIds, pick.pick)
  return pick && assetId ? { assetId, frame: pick.frame } : null
}

/** `0` for `-0`, otherwise `v`. */
const plusZero = (v: number) => (v === 0 ? 0 : v)

/**
 * `note` as a stored board holds it: without `-0`. Neither path into a board can store `-0`
 * (`applyOp` normalizes it and the serializer writes it as `0`), so generated states do not
 * hold it either; op scripts keep it, which exercises the normalization.
 */
function storedNote(note: Note): Note {
  const { x, y, w, h, z } = note
  return { ...note, x: plusZero(x), y: plusZero(y), w: plusZero(w), h: plusZero(h), z: plusZero(z) }
}

/** A note record in schema key order. */
function resolveNote(id: string, d: NoteDraft, assetIds: readonly string[]): Note {
  return {
    type: 'note',
    id,
    x: d.x,
    y: d.y,
    w: d.w,
    h: d.h,
    z: d.z,
    paper: d.paper,
    style: d.style,
    text: d.text,
    image: resolveImage(d.image, assetIds),
    // Only the keys that are present, so absent stays absent.
    ...(d.motif === undefined ? {} : { motif: d.motif }),
    ...(d.stamp === undefined ? {} : { stamp: d.stamp }),
    ...(d.layered === undefined ? {} : { layered: d.layered }),
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  }
}

/** `picks` resolved against a thread's notes: a never-empty map, or undefined for none. */
function resolvePins(
  noteIds: readonly string[],
  picks: PinPicks | undefined,
): Record<string, PinKey> | undefined {
  if (picks === undefined) return undefined
  const pins: Record<string, PinKey> = {}
  for (const [i, key] of picks) {
    const id = pickFrom(noteIds, i)
    if (id !== undefined) pins[id] = key
  }
  return Object.keys(pins).length === 0 ? undefined : pins
}

/** Indices into the note list; deduplicated on resolution, so a draft may yield <2 notes. */
function uniquePicks(ids: readonly string[], picks: readonly number[]): string[] {
  const out: string[] = []
  for (const p of picks) {
    const id = pickFrom(ids, p)
    if (id !== undefined && !out.includes(id)) out.push(id)
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Board states
// ---------------------------------------------------------------------------------------------

export interface BoardStateOptions {
  maxNotes?: number
  maxYarns?: number
  maxAssets?: number
}

/**
 * A board state satisfying every schema and invariant: 0–30 notes, 0–10 yarns (2–6 distinct
 * existing notes each), 0–3 assets, note images pointing at existing assets, full-Unicode text.
 * Records are in schema key order, as `parseBoard` produces them, and hold no `-0`.
 */
export function arbBoardState(opts: BoardStateOptions = {}): fc.Arbitrary<BoardState> {
  const { maxNotes = 30, maxYarns = 10, maxAssets = 3 } = opts
  const yarnDraft = fc.record({
    id: arbId('yarn'),
    picks: fc.array(fc.nat(), { minLength: 2, maxLength: 6 }),
    color: arbPaper,
    label: arbLabel,
    pins: arbPinPicks,
    createdAt: arbIso,
    updatedAt: arbIso,
  })
  return fc
    .record({
      board: arbBoard(),
      // size 'max': spread counts over the whole range (fast-check's default caps them at ~10).
      assets: fc.uniqueArray(arbAsset(), {
        maxLength: maxAssets,
        selector: (a) => a.id,
        size: 'max',
      }),
      notes: fc.uniqueArray(fc.tuple(arbId('note'), arbNoteDraft), {
        maxLength: maxNotes,
        selector: ([id]) => id,
        size: 'max',
      }),
      yarns: fc.uniqueArray(yarnDraft, { maxLength: maxYarns, selector: (y) => y.id, size: 'max' }),
    })
    .map(({ board, assets, notes: noteDrafts, yarns: yarnDrafts }) => {
      const assetIds = assets.map((a) => a.id)
      const notes = noteDrafts.map(([id, d]) => storedNote(resolveNote(id, d, assetIds)))
      const noteIds = notes.map((n) => n.id)
      const yarns: Yarn[] = []
      for (const d of yarnDrafts) {
        const ids = uniquePicks(noteIds, d.picks)
        if (ids.length < 2) continue
        const pins = resolvePins(ids, d.pins)
        yarns.push({
          type: 'yarn',
          id: d.id,
          noteIds: ids,
          color: d.color,
          label: d.label,
          ...(pins === undefined ? {} : { pins }),
          createdAt: d.createdAt,
          updatedAt: d.updatedAt,
        })
      }
      return {
        board,
        assets: new Map(assets.map((a) => [a.id, a])),
        notes: new Map(notes.map((n) => [n.id, n])),
        yarns: new Map(yarns.map((y) => [y.id, y])),
        books: new Map(),
        blocks: new Map(),
        blocksHeld: 'all' as const,
      }
    })
}

// ---------------------------------------------------------------------------------------------
// Op scripts
// ---------------------------------------------------------------------------------------------

/** A note patch whose `image` is still an asset index. Never empty. */
type NotePatchDraft = Omit<NotePatch, 'image'> & { image?: ImagePick | null }

/**
 * An abstract edit. `pick`-style fields are indices resolved `% count` against the state the
 * action meets; `ghost` targets an id that is not on the board (a valid no-op for deletes).
 */
export type Action =
  | { kind: 'note.create'; id: string; note: NoteDraft }
  | { kind: 'note.revive'; pick: number; text: string | null }
  | { kind: 'note.update'; pick: number; set: NotePatchDraft }
  | { kind: 'note.delete'; pick: number; ghost: boolean }
  | {
      kind: 'yarn.create'
      id: string
      picks: number[]
      color: PaletteToken
      label: string
      pins: PinPicks | undefined
      createdAt: string
    }
  | {
      kind: 'yarn.update'
      pick: number
      set: YarnPatchDraft
    }
  | {
      kind: 'yarn.insertNote'
      pick: number
      notePick: number
      after: { at: 'start' } | { at: 'member'; pick: number } | { at: 'ghost' }
    }
  | { kind: 'yarn.removeNote'; pick: number; memberPick: number; ghost: boolean }
  | { kind: 'yarn.delete'; pick: number; ghost: boolean }
  | { kind: 'board.update'; name: string }
  | { kind: 'asset.add'; asset: Asset }
  | { kind: 'asset.remove'; pick: number }

export interface OpScriptOptions {
  minLength?: number
  maxLength?: number
  /** Include server-only `asset.add` (default true). Off for client-only scripts. */
  assetAdd?: boolean
  /**
   * Include server-only `asset.remove` (default false) of any asset on the board, shown by a note
   * or not: a script with it can break the invariant, so `applyBatch` of it may throw.
   */
  assetRemove?: boolean
}

const arbNotePatch: fc.Arbitrary<NotePatchDraft> = fc
  .record(
    {
      x: arbCoord,
      y: arbCoord,
      w: arbW,
      h: arbH,
      z: arbZ,
      paper: arbPaper,
      style: arbStyle,
      text: arbNoteText,
      image: arbImagePick,
      // `null` removes the key; setting and removing both appear in scripts.
      motif: fc.option(arbMotif, { nil: null }),
      stamp: fc.constantFrom(true as const, null),
      layered: fc.option(arbPaper, { nil: null }),
    },
    { requiredKeys: [] },
  )
  .filter((p) => Object.keys(p).length > 0)

/** A yarn patch whose `pins` are still picks (null removes them). Never empty. */
type YarnPatchDraft = Omit<YarnPatch, 'pins'> & { pins?: PinPicks | null }

const arbYarnPatch: fc.Arbitrary<YarnPatchDraft> = fc
  .record(
    {
      color: arbPaper,
      label: arbLabel,
      pins: fc.option(fc.array(fc.tuple(fc.nat(), arbPinKey), { minLength: 1, maxLength: 4 }), {
        nil: null,
      }),
    },
    { requiredKeys: [] },
  )
  .filter((p) => Object.keys(p).length > 0)

/** Abstract edit scripts (0–30 actions by default); resolve them with {@link toOps}. */
export function arbOpScript(opts: OpScriptOptions = {}): fc.Arbitrary<Action[]> {
  const { minLength = 0, maxLength = 30, assetAdd = true, assetRemove = false } = opts
  const actions: fc.Arbitrary<Action>[] = [
    fc.record({
      kind: fc.constant('note.create' as const),
      id: arbId('note'),
      note: arbNoteDraft,
    }),
    fc.record({
      kind: fc.constant('note.revive' as const),
      pick: fc.nat(),
      text: fc.option(arbNoteText, { nil: null }),
    }),
    fc.record({ kind: fc.constant('note.update' as const), pick: fc.nat(), set: arbNotePatch }),
    fc.record({ kind: fc.constant('note.delete' as const), pick: fc.nat(), ghost: fc.boolean() }),
    fc.record({
      kind: fc.constant('yarn.create' as const),
      id: arbId('yarn'),
      picks: fc.array(fc.nat(), { minLength: 2, maxLength: 6 }),
      color: arbPaper,
      label: arbLabel,
      pins: arbPinPicks,
      createdAt: arbIso,
    }),
    fc.record({ kind: fc.constant('yarn.update' as const), pick: fc.nat(), set: arbYarnPatch }),
    fc.record({
      kind: fc.constant('yarn.insertNote' as const),
      pick: fc.nat(),
      notePick: fc.nat(),
      after: fc.oneof(
        fc.constant({ at: 'start' as const }),
        fc.record({ at: fc.constant('member' as const), pick: fc.nat() }),
        fc.constant({ at: 'ghost' as const }),
      ),
    }),
    fc.record({
      kind: fc.constant('yarn.removeNote' as const),
      pick: fc.nat(),
      memberPick: fc.nat(),
      ghost: fc.boolean(),
    }),
    fc.record({ kind: fc.constant('yarn.delete' as const), pick: fc.nat(), ghost: fc.boolean() }),
    fc.record({ kind: fc.constant('board.update' as const), name: arbBoardName }),
  ]
  if (assetAdd) {
    actions.push(fc.record({ kind: fc.constant('asset.add' as const), asset: arbAsset() }))
  }
  if (assetRemove) {
    actions.push(fc.record({ kind: fc.constant('asset.remove' as const), pick: fc.nat() }))
  }
  return fc.array(fc.oneof(...actions), { minLength, maxLength, size: 'max' })
}

/** Ids that are never on a generated board: the all-`Z` tail is outside `arbId`'s shrink path. */
const GHOST_NOTE = `note_${'Z'.repeat(26)}`
const GHOST_YARN = `yarn_${'Z'.repeat(26)}`

/** Resolve one action against `s`, or `null` when it cannot apply (nothing to pick, id taken). */
function resolveAction(s: BoardState, a: Action, gone: ReadonlyMap<string, Note>): Op | null {
  const noteIds = [...s.notes.keys()]
  const yarnIds = [...s.yarns.keys()]
  const assetIds = [...s.assets.keys()]

  switch (a.kind) {
    case 'note.create':
      if (s.notes.has(a.id) || gone.has(a.id)) return null
      return { op: 'note.create', note: resolveNote(a.id, a.note, assetIds) }

    case 'note.revive': {
      const prior = pickFrom([...gone.values()], a.pick)
      if (!prior) return null
      // Its image must still resolve (only a script with `asset.remove` can take one away).
      if (prior.image && !s.assets.has(prior.image.assetId)) return null
      return { op: 'note.create', note: a.text === null ? prior : { ...prior, text: a.text } }
    }

    case 'note.update': {
      const id = pickFrom(noteIds, a.pick)
      if (!id) return null
      const { image, ...rest } = a.set
      // A note showing an asset `asset.remove` took away cannot keep that image through an update.
      const shown = s.notes.get(id)?.image
      if (image === undefined && shown && !s.assets.has(shown.assetId)) return null
      const set: NotePatch =
        image === undefined ? rest : { ...rest, image: resolveImage(image, assetIds) }
      return { op: 'note.update', id, set }
    }

    case 'note.delete': {
      const id = a.ghost ? GHOST_NOTE : pickFrom(noteIds, a.pick)
      return id ? { op: 'note.delete', id } : null
    }

    case 'yarn.create': {
      if (s.yarns.has(a.id)) return null
      const ids = uniquePicks(noteIds, a.picks)
      if (ids.length < 2) return null
      const pins = resolvePins(ids, a.pins)
      const yarn: Yarn = {
        type: 'yarn',
        id: a.id,
        noteIds: ids,
        color: a.color,
        label: a.label,
        ...(pins === undefined ? {} : { pins }),
        createdAt: a.createdAt,
        updatedAt: a.createdAt,
      }
      return { op: 'yarn.create', yarn }
    }

    case 'yarn.update': {
      const yarn = pickFrom([...s.yarns.values()], a.pick)
      if (!yarn) return null
      const { pins, ...rest } = a.set
      if (pins === undefined) return { op: 'yarn.update', id: yarn.id, set: rest }
      const set: YarnPatch = { ...rest, pins: pins && (resolvePins(yarn.noteIds, pins) ?? null) }
      return { op: 'yarn.update', id: yarn.id, set }
    }

    case 'yarn.insertNote': {
      const yarn = pickFrom([...s.yarns.values()], a.pick)
      if (!yarn) return null
      const noteId = pickFrom(
        noteIds.filter((id) => !yarn.noteIds.includes(id)),
        a.notePick,
      )
      if (!noteId) return null
      const afterNoteId =
        a.after.at === 'start'
          ? null
          : a.after.at === 'ghost'
            ? GHOST_NOTE
            : (pickFrom(yarn.noteIds, a.after.pick) ?? null)
      return { op: 'yarn.insertNote', id: yarn.id, noteId, afterNoteId }
    }

    case 'yarn.removeNote': {
      const yarn = pickFrom([...s.yarns.values()], a.pick)
      if (a.ghost) {
        return { op: 'yarn.removeNote', id: yarn?.id ?? GHOST_YARN, noteId: GHOST_NOTE }
      }
      const noteId = yarn && pickFrom(yarn.noteIds, a.memberPick)
      return yarn && noteId ? { op: 'yarn.removeNote', id: yarn.id, noteId } : null
    }

    case 'yarn.delete': {
      const id = a.ghost ? GHOST_YARN : pickFrom(yarnIds, a.pick)
      return id ? { op: 'yarn.delete', id } : null
    }

    case 'board.update':
      return { op: 'board.update', set: { name: a.name } }

    case 'asset.add':
      return s.assets.has(a.asset.id) ? null : { op: 'asset.add', asset: a.asset }

    case 'asset.remove': {
      const id = pickFrom(assetIds, a.pick)
      return id ? { op: 'asset.remove', id } : null
    }
  }
}

/**
 * Resolve `actions` sequentially against the evolving state (each op applied with `ctx`),
 * skipping actions that cannot apply. Every returned op is valid at its point in the sequence,
 * so `applyBatch(state, toOps(state, actions, ctx), ctx)` succeeds for an invariant-valid
 * `state` (unless the script has `asset.remove`, which may take away an image a note shows).
 * An op that `applyOp` still rejects is rethrown: that is a generator or core defect,
 * never silently skipped.
 */
export function toOps(state: BoardState, actions: readonly Action[], ctx: ApplyCtx): Op[] {
  const ops: Op[] = []
  /** Notes deleted earlier in this script (last seen content), for `note.revive`. */
  const gone = new Map<string, Note>()
  let s = state
  for (const action of actions) {
    const op = resolveAction(s, action, gone)
    if (!op) continue
    const next = applyOp(s, op, ctx)
    if (op.op === 'note.delete') {
      const prior = s.notes.get(op.id)
      if (prior) gone.set(op.id, prior)
    } else if (op.op === 'note.create') {
      gone.delete(op.note.id)
    }
    ops.push(op)
    s = next
  }
  return ops
}
