// @vitest-environment jsdom
import {
  applyBatch,
  type BoardState,
  type ClientOp,
  emptyBoardState,
  LIMITS,
  type Note,
  OpError,
} from '@papertie/core'
import type { LodMode } from '../../src/canvas/lod'
import { BRIDGE, MergeWatch } from '../../src/canvas/MergeWatch'
import type { Rect } from '../../src/canvas/types'
import { MERGE } from '../../src/interactions/merge'
import { LIFTED_Z_INDEX } from '../../src/notes/noteStyle'
import type { CommitOptions } from '../../src/store/boardStore'
import { MOTION } from '../../src/styles/motion'
import { BOARD_ID, idOf, note, T0 } from '../helpers/fakeServer'
import { type RecordedCall, recordingContext } from '../helpers/recordingContext'

const D = idOf('note', 1)
const T = idOf('note', 2)
const O = idOf('note', 3)
const X = idOf('note', 4)
const ASSET = `asset_${'0'.repeat(25)}1`
const VIEW = { width: 1200, height: 800 }

interface RigOptions {
  lod?: LodMode
  reduced?: boolean
  hidden?: Set<string>
  text?: string
  /** More of the board, after the three notes and the asset. */
  extra?: ClientOp[]
  /** Replaces the store's commit (a refusal). */
  commit?: (ops: readonly ClientOp[]) => void
  /** False: the runtime never allows merging (no Alt, a mouse drag). */
  allowed?: boolean
}

/** The target at (0, 0), 200 × 120; the dragged note elsewhere; another far away. */
function rig(o: RigOptions = {}) {
  let state: BoardState = applyBatch(
    emptyBoardState(BOARD_ID, 'T', T0),
    [
      { op: 'note.create', note: note(D, { x: 600, y: 0, text: 'moved', z: 1 }) },
      {
        op: 'note.create',
        note: note(T, { x: 0, y: 0, text: o.text ?? 'target', paper: 'rose', z: 2 }),
      },
      { op: 'note.create', note: note(O, { x: 0, y: 2000, z: 3 }) },
      {
        op: 'asset.add',
        asset: {
          type: 'asset',
          id: ASSET,
          mime: 'image/webp',
          width: 100,
          height: 100,
          bytes: 10,
          sha256: 'a'.repeat(64),
          createdAt: T0,
        },
      },
      ...(o.extra ?? []),
    ],
    { now: T0 },
  )
  let now = 1000
  let zoom = 1
  const commits: Array<{ ops: ClientOp[]; o: CommitOptions }> = []
  const selected: string[] = []
  const contexts: ReturnType<typeof recordingContext>[] = []
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
    const c = recordingContext()
    c.ctx.createLinearGradient = () => ({ addColorStop() {} }) as never
    contexts.push(c)
    return c.ctx as never
  })
  const world = document.createElement('div')
  const overlay = document.createElement('div')
  document.body.append(world, overlay)
  const el = document.createElement('article')
  el.className = 'note'
  el.dataset.noteId = D
  el.tabIndex = 0
  el.setAttribute('aria-label', 'moved')
  el.innerHTML = '<div class="note-paper">moved</div>'
  el.style.zIndex = LIFTED_Z_INDEX
  const targetEl = document.createElement('article')
  targetEl.className = 'note'
  targetEl.dataset.noteId = T
  targetEl.style.setProperty('--stack', '2')
  targetEl.innerHTML = '<div class="note-paper">target</div>'
  world.append(targetEl, el)
  const targetPaper = targetEl.querySelector('.note-paper') as HTMLElement
  let requests = 0
  const watch = new MergeWatch({
    board: () => state,
    notesIn: (r: Rect) =>
      [...state.notes.values()]
        .filter(
          (n) =>
            !o.hidden?.has(n.id) &&
            n.x <= r.x + r.w &&
            n.x + n.w >= r.x &&
            n.y <= r.y + r.h &&
            n.y + n.h >= r.y,
        )
        .map((n) => n.id),
    heightOf: (n) => n.h,
    zoom: () => zoom,
    lod: () => o.lod ?? 'full',
    now: () => now,
    reduced: () => o.reduced ?? false,
    mapper: () => (p) => p,
    dpr: () => 1,
    rotation: () => false,
    anchor: () => ({ x: 0, y: 0 }),
    viewport: () => VIEW,
    overlay,
    noteEl: (id) => (id === D ? el : id === T ? targetEl : undefined),
    request: () => {
      requests++
    },
    commit: (ops, c) => {
      o.commit?.(ops)
      commits.push({ ops: [...ops], o: c })
      state = applyBatch(state, ops, { now: T0 })
    },
    select: (id) => selected.push(id),
  })
  // The drag merges only while the runtime allows it (Alt held, or a touch's): here it does.
  if (o.allowed !== false) watch.allow(true)
  const dragged = (x: number, y: number): Note => ({ ...(state.notes.get(D) as Note), x, y })
  /** Run frames `ms` apart until the watch stops asking or `until` ms have passed. */
  const frames = (until: number, step = 16) => {
    const end = now + until
    let more = true
    while (more && now < end) {
      now += step
      more = watch.frame(now)
    }
    return more
  }
  const advance = (ms: number) => {
    now += ms
  }
  const canvas = () => overlay.querySelector('canvas') as HTMLCanvasElement | null
  const fills = () =>
    contexts.flatMap((c) => c.calls).filter((c: RecordedCall) => c.name === 'fill')
  return {
    watch,
    commits,
    selected,
    dragged,
    frames,
    advance,
    canvas,
    fills,
    world,
    el,
    targetPaper,
    contexts,
    setZoom: (z: number) => {
      zoom = z
    },
    get now() {
      return now
    },
    state: () => state,
    setState: (s: BoardState) => {
      state = s
    },
    get requests() {
      return requests
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('MergeWatch', () => {
  it('a note held beside another arms after the dwell, and the release merges in one batch', () => {
    const r = rig()
    r.watch.move(r.dragged(210, 0))
    expect(r.watch.target).toBe(T)
    expect(r.watch.armed).toBe(false)
    expect(r.frames(MERGE.dwellMs - 40)).toBe(true)
    expect(r.watch.armed).toBe(false)
    r.frames(60)
    expect(r.watch.armed).toBe(true)
    expect(r.watch.release(r.dragged(210, 0))).toBe(true)
    expect(r.commits).toHaveLength(1)
    expect(r.commits[0]?.o).toEqual({ label: MERGE.label })
    expect(r.state().notes.has(D)).toBe(false)
    expect(r.state().notes.get(T)?.text).toBe('target\n\nmoved')
    expect(r.selected).toEqual([T])
    expect(document.querySelector('[data-live-region]')?.textContent?.trim()).toBe(
      'Merged into “target”',
    )
  })

  it('a release before the dwell does not merge, and the bridge relaxes away', () => {
    const r = rig()
    r.watch.move(r.dragged(-205, 0))
    r.frames(MERGE.dwellMs / 2)
    expect(r.canvas()?.hidden).toBe(false)
    expect(r.watch.release(r.dragged(-205, 0))).toBe(false)
    r.watch.end()
    expect(r.commits).toEqual([])
    expect(r.frames(MOTION.fast + 40)).toBe(false)
    expect(r.canvas()?.hidden).toBe(true)
  })

  it('a sweep past several notes starts the dwell again at each', () => {
    const r = rig()
    r.watch.move(r.dragged(210, 0))
    r.frames(MERGE.dwellMs - 50)
    // Out of range, then back: the hold starts over.
    r.watch.move(r.dragged(300, 0))
    expect(r.watch.target).toBeUndefined()
    r.watch.move(r.dragged(210, 0))
    r.frames(MERGE.dwellMs - 50)
    expect(r.watch.armed).toBe(false)
    r.frames(80)
    expect(r.watch.armed).toBe(true)
  })

  it('a note moved over another (overlapping) never merges', () => {
    const r = rig()
    r.watch.move(r.dragged(100, 20))
    r.frames(MERGE.dwellMs * 2)
    expect(r.watch.target).toBeUndefined()
    expect(r.watch.release(r.dragged(100, 20))).toBe(false)
    expect(r.canvas()?.hidden ?? true).toBe(true)
  })

  it('leaves out notes focus hides, photos, merges past the text limit, and overview', () => {
    expect(
      (() => {
        const r = rig({ hidden: new Set([T]) })
        r.watch.move(r.dragged(210, 0))
        return r.watch.target
      })(),
    ).toBeUndefined()

    const photo = rig()
    photo.setState(
      applyBatch(
        photo.state(),
        [{ op: 'note.update', id: T, set: { image: { assetId: ASSET, frame: 'print' } } }],
        { now: T0 },
      ),
    )
    photo.watch.move(photo.dragged(210, 0))
    expect(photo.watch.target).toBeUndefined()

    const long = rig({ text: 'x'.repeat(LIMITS.maxTextLength - 3) })
    long.watch.move(long.dragged(210, 0))
    expect(long.watch.target).toBeUndefined()
    const fits = rig({ text: 'x'.repeat(LIMITS.maxTextLength - 7) })
    fits.watch.move(fits.dragged(210, 0))
    expect(fits.watch.target).toBe(T)

    const far = rig({ lod: 'overview' })
    far.watch.move(far.dragged(210, 0))
    expect(far.watch.target).toBeUndefined()
  })

  it('draws the bridge on its own canvas while forming, and stops drawing once settled', () => {
    const r = rig()
    r.watch.move(r.dragged(212, 10))
    expect(r.canvas()).not.toBeNull()
    r.frames(MERGE.dwellMs + 20)
    expect(r.fills().length).toBeGreaterThan(0)
    // Armed and still: the join settles, and then nothing runs (no idle motion).
    expect(r.frames(2000)).toBe(false)
    const drawn = r.fills().length
    expect(r.watch.frame(99_999)).toBe(false)
    expect(r.fills().length).toBe(drawn)
  })

  it('absorbs the dragged paper into the target after the merge, then tidies up', () => {
    const r = rig()
    r.watch.move(r.dragged(210, 0))
    r.frames(MERGE.dwellMs + 20)
    r.watch.release(r.dragged(210, 0))
    r.el.remove()
    const ghost = r.world.querySelector<HTMLElement>('article.note--merging')
    expect(ghost).not.toBeNull()
    expect(ghost?.dataset.noteId).toBeUndefined()
    expect(ghost?.getAttribute('aria-hidden')).toBe('true')
    expect(ghost?.hasAttribute('tabindex')).toBe(false)
    expect(r.frames(MOTION.slow / 2)).toBe(true)
    expect(Number(ghost?.style.opacity)).toBeLessThan(1)
    expect(r.frames(MOTION.slow)).toBe(false)
    expect(ghost?.isConnected).toBe(false)
    expect(r.canvas()?.hidden).toBe(true)
  })

  it('settle() ends the absorb at once', () => {
    const r = rig()
    r.watch.move(r.dragged(210, 0))
    r.frames(MERGE.dwellMs + 20)
    r.watch.release(r.dragged(210, 0))
    r.frames(32)
    r.watch.settle()
    expect(r.world.querySelector('.note--merging')).toBeNull()
    expect(r.canvas()?.hidden).toBe(true)
  })

  it('reduced motion: a calm join with no wobble, and the merge lands with no absorb', () => {
    const r = rig({ reduced: true })
    r.watch.move(r.dragged(210, 0))
    // Nothing animates: frames run only to arm the join when the dwell is up.
    r.advance(MERGE.dwellMs + 1)
    expect(r.watch.frame(MERGE.dwellMs + 1001)).toBe(false)
    expect(r.watch.armed).toBe(true)
    expect(r.watch.neck).toBe(BRIDGE.waistArmed)
    expect(r.watch.release(r.dragged(210, 0))).toBe(true)
    expect(r.world.querySelector('.note--merging')).toBeNull()
    expect(r.canvas()?.hidden).toBe(true)
  })
})

/** A note created at `x`, `y` (200 × 120), as a batch op. */
const create = (id: string, x: number, y: number, over: Partial<Note> = {}): ClientOp => ({
  op: 'note.create',
  note: note(id, { x, y, z: 4, ...over }),
})

describe('MergeWatch: holds, targets and drawing', () => {
  it('holds for 250 ms before a release merges', () => {
    expect(MERGE.dwellMs).toBe(250)
  })

  it.each([
    ['a note', {}],
    ['a photo', { image: { assetId: ASSET, frame: 'print' as const } }],
  ])('lying over %s does not keep it from joining the target beside it', (_, over) => {
    // X lies under where the dragged note is held: (210, 0) is beside the target and over X.
    const r = rig({ extra: [create(X, 300, 40, over)] })
    r.watch.move(r.dragged(210, 0))
    expect(r.watch.target).toBe(T)
    r.frames(MERGE.dwellMs + 20)
    expect(r.watch.armed).toBe(true)
    expect(r.watch.release(r.dragged(210, 0))).toBe(true)
    expect(r.commits).toHaveLength(1)
  })

  it('a note focus hides beneath the dragged one changes nothing', () => {
    const r = rig({ extra: [create(X, 300, 40)], hidden: new Set([X]) })
    r.watch.move(r.dragged(210, 0))
    expect(r.watch.target).toBe(T)
  })

  it('a touch (2 px) of a third note (a photo, never a target itself) still merges', () => {
    const photo = { image: { assetId: ASSET, frame: 'print' as const } }
    const r = rig({ extra: [create(X, 410 - MERGE.touchPx, 0, photo)] })
    r.watch.move(r.dragged(210, 0))
    expect(r.watch.target).toBe(T)
  })

  it('forming stays a narrow neck; armed becomes a full join within the 200 ms token', () => {
    const r = rig()
    r.watch.move(r.dragged(210, 0))
    r.frames(MERGE.dwellMs - 30)
    expect(r.watch.armed).toBe(false)
    expect(r.watch.neck).toBeLessThanOrEqual(0.3)
    expect(r.watch.foot).toBeLessThanOrEqual(0.6)
    r.frames(30 + MOTION.base + 20)
    expect(r.watch.armed).toBe(true)
    expect(r.watch.neck).toBeGreaterThanOrEqual(0.9)
    expect(r.watch.foot).toBe(1)
  })

  it('the absorbing paper stays above the target, and the target’s paper grows over the slow token', () => {
    const r = rig()
    vi.spyOn(r.targetPaper, 'scrollHeight', 'get').mockReturnValue(300)
    r.watch.move(r.dragged(210, 0))
    r.frames(MERGE.dwellMs + 20)
    r.watch.release(r.dragged(210, 0))
    r.el.remove()
    const ghost = r.world.querySelector<HTMLElement>('.note--merging') as HTMLElement
    expect(ghost.style.zIndex).toBe(LIFTED_Z_INDEX)
    r.frames(MOTION.slow / 2)
    expect(Number(ghost.style.opacity)).toBeGreaterThan(0)
    const mid = Number.parseFloat(r.targetPaper.style.maxHeight)
    expect(mid).toBeGreaterThan(120)
    expect(mid).toBeLessThan(300)
    expect(r.targetPaper.style.overflow).toBe('hidden')
    r.frames(MOTION.slow)
    expect(r.targetPaper.style.maxHeight).toBe('')
    expect(r.targetPaper.style.overflow).toBe('')
  })

  it('reduced motion leaves the target’s paper alone', () => {
    const r = rig({ reduced: true })
    vi.spyOn(r.targetPaper, 'scrollHeight', 'get').mockReturnValue(300)
    r.watch.move(r.dragged(210, 0))
    r.advance(MERGE.dwellMs + 1)
    r.watch.frame(r.now)
    r.watch.release(r.dragged(210, 0))
    r.frames(MOTION.slow)
    expect(r.targetPaper.style.maxHeight).toBe('')
  })

  it('a refused merge drops the note as usual and says so', () => {
    const r = rig({
      commit: () => {
        throw new OpError('limit', 'refused')
      },
    })
    r.watch.move(r.dragged(210, 0))
    r.frames(MERGE.dwellMs + 20)
    expect(r.watch.release(r.dragged(210, 0))).toBe(false)
    expect(r.world.querySelector('.note--merging')).toBeNull()
    expect(document.querySelector('[data-live-region]')?.textContent?.trim()).toBe(
      'Couldn’t merge the notes',
    )
    r.watch.end()
    r.frames(MOTION.fast + 40)
    expect(r.canvas()?.hidden).toBe(true)
  })

  it('a bug in the commit is not swallowed', () => {
    const r = rig({
      commit: () => {
        throw new TypeError('bug')
      },
    })
    r.watch.move(r.dragged(210, 0))
    r.frames(MERGE.dwellMs + 20)
    expect(() => r.watch.release(r.dragged(210, 0))).toThrow('bug')
    expect(r.world.querySelector('.note--merging')).toBeNull()
  })

  it.each([
    ['deleted', [{ op: 'note.delete', id: T }]],
    [
      'made a photo',
      [{ op: 'note.update', id: T, set: { image: { assetId: ASSET, frame: 'print' } } }],
    ],
    [
      'filled to the limit',
      [{ op: 'note.update', id: T, set: { text: 'x'.repeat(LIMITS.maxTextLength) } }],
    ],
  ] as Array<[string, ClientOp[]]>)('a target %s under the hold is not merged into', (_, ops) => {
    const r = rig()
    r.watch.move(r.dragged(210, 0))
    r.frames(MERGE.dwellMs + 20)
    r.setState(applyBatch(r.state(), ops, { now: T0 }))
    r.frames(32)
    expect(r.watch.release(r.dragged(210, 0))).toBe(false)
    expect(r.commits).toEqual([])
  })

  it('a zoom that changes the threshold mid-hold takes the target away', () => {
    const r = rig()
    // 15 world px apart: in reach at zoom 1 (15 screen px), out of it at zoom 2 (30).
    r.watch.move(r.dragged(215, 0))
    expect(r.watch.target).toBe(T)
    r.setZoom(2)
    r.watch.move(r.dragged(215, 0))
    expect(r.watch.target).toBeUndefined()
    r.setZoom(0.5)
    r.watch.move(r.dragged(215, 0))
    expect(r.watch.target).toBe(T)
    expect(r.watch.armed).toBe(false)
  })

  it('merging only while allowed (Alt held): let go of Alt, the bridge lets go; held again, it forms again', () => {
    const r = rig()
    r.watch.move(r.dragged(210, 0))
    r.frames(100)
    r.watch.allow(false)
    expect(r.watch.target).toBeUndefined()
    r.frames(MOTION.fast + 40)
    expect(r.canvas()?.hidden).toBe(true)
    r.watch.move(r.dragged(211, 0))
    r.frames(MERGE.dwellMs * 2)
    expect(r.watch.target).toBeUndefined()
    expect(r.watch.release(r.dragged(211, 0))).toBe(false)
    r.watch.allow(true)
    expect(r.watch.target).toBe(T)
    expect(r.watch.armed).toBe(false)
  })

  it('a watch never told to allow merging finds no target, however long the hold (no Alt)', () => {
    const r = rig({ allowed: false })
    r.watch.move(r.dragged(210, 0))
    r.frames(MERGE.dwellMs * 2)
    expect(r.watch.target).toBeUndefined()
    expect(r.canvas()?.hidden ?? true).toBe(true)
    expect(r.watch.release(r.dragged(210, 0))).toBe(false)
    expect(r.commits).toEqual([])
  })

  it('a relaxing bridge collapses into the target’s edge, not where the note was', () => {
    const r = rig()
    r.watch.move(r.dragged(212, 0))
    r.frames(100)
    const before = r.watch.bounds as Rect
    // Swept away fast: the next move is far off.
    r.watch.move(r.dragged(900, 0))
    r.frames(MOTION.fast / 2)
    const mid = r.watch.bounds as Rect
    expect(mid.x + mid.w).toBeLessThan(before.x + before.w)
    expect(mid.x).toBeLessThanOrEqual(200)
  })

  it('draws within the viewport, and frees the canvas once idle', () => {
    const r = rig({ extra: [create(X, 0, 640, { h: 2000 })] })
    // Held below X (0, 640, 200 × 2000): the shared stretch runs far past the viewport.
    const tall = { ...r.dragged(210, 600), h: 2000 }
    r.watch.move(tall)
    r.frames(MERGE.dwellMs + MOTION.base + 40)
    const b = r.watch.bounds as Rect
    expect(b.y).toBeGreaterThanOrEqual(-BRIDGE.pad)
    expect(b.y + b.h).toBeLessThanOrEqual(VIEW.height + BRIDGE.pad + 1)
    expect((r.canvas() as HTMLCanvasElement).height).toBeLessThanOrEqual(
      (VIEW.height + 2 * BRIDGE.pad + 64) * 1,
    )
    r.watch.end()
    r.frames(MOTION.fast + 40)
    expect(r.canvas()?.width).toBe(0)
    expect(r.canvas()?.height).toBe(0)
  })

  it('decodes the fibre off the main thread before making it a pattern', async () => {
    let decoded: () => void = () => {}
    const made: unknown[] = []
    vi.stubGlobal(
      'Image',
      class {
        decoding = ''
        src = ''
        naturalWidth = 512
        complete = true
        decode() {
          return new Promise<void>((resolve) => {
            decoded = resolve
          })
        }
      },
    )
    const r = rig()
    for (const c of r.contexts) c.ctx.createPattern = (...a: unknown[]) => made.push(a) as never
    r.watch.move(r.dragged(210, 0))
    r.frames(48)
    for (const c of r.contexts) c.ctx.createPattern = (...a: unknown[]) => made.push(a) as never
    r.frames(48)
    expect(made).toEqual([])
    decoded()
    await Promise.resolve()
    await Promise.resolve()
    r.watch.move(r.dragged(211, 0))
    r.frames(48)
    expect(made.length).toBe(1)
    vi.unstubAllGlobals()
  })
})

describe('MergeWatch: the bridge and the absorbing paper', () => {
  /** Armed beside the target 10 px away, released: the absorb has begun. */
  function absorbing() {
    const r = rig()
    r.watch.move(r.dragged(210, 0))
    r.frames(MERGE.dwellMs + MOTION.base + 20)
    const calls = () => r.contexts.flatMap((c) => c.calls)
    const before = calls().length
    expect(r.watch.release(r.dragged(210, 0))).toBe(true)
    return { r, since: () => calls().slice(before) }
  }

  it('while it shows, the bridge leaves the absorbing paper out of what it paints', () => {
    const { r, since } = absorbing()
    // 4 ms in: the paper has not crossed the gap yet, so the bridge still shows.
    r.frames(4, 4)
    expect(r.canvas()?.hidden).toBe(false)
    expect(since().some((c) => c.name === 'clip' && c.args[0] === 'evenodd')).toBe(true)
  })

  it('fades as the gap closes, and is gone once the paper reaches the target’s edge', () => {
    const { r } = absorbing()
    r.frames(4, 4)
    expect(r.canvas()?.hidden).toBe(false)
    r.frames(44, 4)
    expect(r.canvas()?.hidden).toBe(true)
    // The paper is still on its way in (and visible) when the bridge has gone.
    const ghost = r.world.querySelector<HTMLElement>('.note--merging') as HTMLElement
    expect(Number(ghost.style.opacity)).toBeGreaterThan(0.9)
  })
})
