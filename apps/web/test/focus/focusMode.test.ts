// @vitest-environment jsdom
import { buildMembership, type ClientOp, type Membership } from '@papertie/core'
import type { CanvasRuntime } from '../../src/canvas/runtime'
import {
  bindFocusHash,
  type FocusState,
  focusHash,
  parseFocusHash,
} from '../../src/focus/focusMode'
import { installCanvasStubs } from '../helpers/domCanvas'
import { note, T0 } from '../helpers/fakeServer'
import { A, B, C, centreOf, chainRuntime, D, E, F, G, H, LETTERS, Y1, Y2, Y3, Y5 } from './board'

let restore: () => void = () => {}
const runtimes: CanvasRuntime[] = []

function open() {
  const made = chainRuntime()
  runtimes.push(made.rt)
  return made
}

/** Long enough for the camera's ease (320 ms) and the fade (250 ms) to end. */
const settle = () => vi.advanceTimersByTime(600)

const focusOn = (seeds: string[], depth: FocusState['depth'] = 1, include: string[] = []) => ({
  seeds,
  depth,
  include,
})

const pointer = (type: string, p: { x: number; y: number }) =>
  new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    pointerType: 'mouse',
    button: 0,
    buttons: type === 'pointerup' ? 0 : 1,
    clientX: p.x,
    clientY: p.y,
  })

function click(rt: CanvasRuntime, p: { x: number; y: number }) {
  rt.els.root.dispatchEvent(pointer('pointerdown', p))
  rt.els.root.dispatchEvent(pointer('pointerup', p))
}

/** A membership as plain sorted data, so two built in different orders compare equal. */
function shape(m: Membership | null) {
  if (m === null) return null
  return {
    notes: [...m.yarnsByNote].map(([id, ys]) => [id, [...ys].sort()] as const).sort(),
    yarns: [...m.notesByYarn].map(([id, ns]) => [id, [...ns]] as const).sort(),
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(T0))
  restore = installCanvasStubs()
  history.replaceState(null, '', '/')
})
afterEach(() => {
  for (const rt of runtimes.splice(0)) rt.dispose()
  document.body.replaceChildren()
  restore()
  vi.useRealTimers()
  history.replaceState(null, '', '/')
})

describe('focus mode', () => {
  it('depth 1 shows seed, direct thread mates and the yarns among them', () => {
    const { rt } = open()
    rt.setFocus(focusOn([A]))
    const f = rt.focus
    expect(f).not.toBeNull()
    expect([...(f?.notes ?? [])].sort()).toEqual([A, B, C])
    expect([...(f?.yarns ?? [])]).toEqual([Y1])
    expect(f?.looseEnds).toEqual([{ yarnId: Y2, noteId: C }])
    expect(rt.focusState).toEqual(focusOn([A]))
  })

  it('F focuses the selection at depth 1, and Esc leaves focus before it clears the selection', () => {
    const { rt } = open()
    rt.selectNote(B)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', bubbles: true }))
    expect(rt.focusState).toEqual(focusOn([B]))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(rt.focus).toBeNull()
    expect([...rt.selection]).toEqual([B])
  })

  it('exit restores every note visible and the camera, and the board state object is unchanged', () => {
    const { rt, store } = open()
    const before = store.getState()
    const commits = store.commits
    rt.camera.set({ x: -300, y: -500, zoom: 0.5 })
    settle()
    const camera = rt.camera.get()

    rt.setFocus(focusOn([A]))
    settle()
    // The camera eased to the focused notes, A–C: zoomed in from 0.5.
    expect(rt.camera.get()).not.toEqual(camera)
    expect(rt.noteEls.get(D)?.getAttribute('aria-hidden')).toBe('true')

    rt.setFocus(null)
    settle()
    expect(rt.focus).toBeNull()
    expect(rt.camera.get()).toEqual(camera)
    for (const id of LETTERS) {
      const el = rt.noteEls.get(id)
      expect(el?.hasAttribute('aria-hidden')).toBe(false)
      expect(el?.hasAttribute('inert')).toBe(false)
      expect(el?.dataset.focusOut).toBeUndefined()
      expect(rt.noteAt(centreOf(id))).toBe(id)
    }
    expect(rt.els.root.dataset.focus).toBeUndefined()
    // Focus is a view: the board is the very same object, and nothing was committed.
    expect(store.getState()).toBe(before)
    expect(store.commits).toBe(commits)
  })

  it('hidden notes are aria-hidden and not hit-testable', () => {
    const { rt } = open()
    rt.setFocus(focusOn([A]))
    settle()
    for (const id of [D, E, F, G, H]) {
      const el = rt.noteEls.get(id)
      expect(el?.getAttribute('aria-hidden')).toBe('true')
      expect(el?.hasAttribute('inert')).toBe(true)
      expect(el?.dataset.focusOut).toBe('')
      // No tool finds it by place, and its pin takes no press.
      expect(rt.noteAt(centreOf(id))).toBeUndefined()
      const pin = rt.pinScreen(id)
      expect(pin && rt.hitTest(pin)).toEqual({ kind: 'none' })
    }
    for (const id of [A, B, C]) {
      expect(rt.noteEls.get(id)?.hasAttribute('aria-hidden')).toBe(false)
      expect(rt.noteAt(centreOf(id))).toBe(id)
    }
    // The hidden thread between D and E takes no press either.
    const mid = rt.yarnProbe(Y3, 0, 0.5, 0)
    expect(mid && rt.hitTest(mid)).toEqual({ kind: 'none' })
    // A note mounted later (the camera panning to it) mounts hidden.
    rt.noteEls.delete(E)
    const el = document.createElement('article')
    rt.noteEls.set(E, el)
    rt.noteMounted(E, el)
    expect(el.getAttribute('aria-hidden')).toBe('true')
  })

  it('loose end click expands', () => {
    const { rt } = open()
    rt.setFocus(focusOn([A]))
    settle()
    // Y2 leads from C to the hidden D: a few px along it from C's edge pin is its loose end.
    const stub = rt.yarnProbe(Y2, 0, 0.04, 0)
    if (stub === undefined) throw new Error('no curve for Y2')
    click(rt, stub)
    expect(rt.focusState?.depth).toBe(2)
    expect(rt.focus?.notes.has(D)).toBe(true)

    // At the whole component a loose end brings in the note across it, and only that one.
    rt.setFocus(focusOn([A], 'all', [G]))
    settle()
    expect(rt.focus?.looseEnds).toEqual([{ yarnId: Y5, noteId: G }])
    const fromG = rt.yarnProbe(Y5, 0, 0.04, 0)
    if (fromG === undefined) throw new Error('no curve for Y5')
    click(rt, fromG)
    expect(rt.focusState).toEqual(focusOn([A], 'all', [G, H]))
    expect(rt.focus?.notes.has(H)).toBe(true)
  })

  it('a press past the loose end, on the hidden span, does nothing', () => {
    const { rt } = open()
    rt.setFocus(focusOn([A]))
    settle()
    const far = rt.yarnProbe(Y2, 0, 0.6, 0)
    if (far === undefined) throw new Error('no curve for Y2')
    click(rt, far)
    expect(rt.focusState?.depth).toBe(1)
  })

  it('hiding the note being written on ends the writing first', () => {
    const { rt } = open()
    rt.setFocus(focusOn([A], 2))
    settle()
    expect(rt.startEditing(D)).toBe(true)
    rt.setFocus(focusOn([A], 1))
    expect(rt.editing).toBeNull()
    expect(rt.selection.has(D)).toBe(false)
  })

  it('selecting a hidden note (a search jump) brings it into the focus', () => {
    const { rt } = open()
    rt.setFocus(focusOn([A]))
    settle()
    rt.selectNote(G)
    expect(rt.focusState?.include).toEqual([G])
    expect(rt.focus?.notes.has(G)).toBe(true)
    expect(rt.focus?.notes.has(H)).toBe(false)
    expect(rt.noteEls.get(G)?.hasAttribute('aria-hidden')).toBe(false)
  })

  it('a thread tied on the board is followed at once; typing recomputes nothing', () => {
    const { rt, store } = open()
    rt.setFocus(focusOn([A]))
    const shown = rt.focus
    store.commit([{ op: 'note.update', id: B, set: { text: 'typed' } }])
    // Not a change of threads or notes: the very same result.
    expect(rt.focus).toBe(shown)
    store.commit([
      {
        op: 'yarn.create',
        yarn: {
          type: 'yarn',
          id: 'yarn_00000000000000000000000009',
          noteIds: [A, G],
          color: 'indigo',
          label: '',
          createdAt: T0,
          updatedAt: T0,
        },
      },
    ])
    expect(rt.focus?.notes.has(G)).toBe(true)
    expect(rt.noteEls.get(G)?.hasAttribute('aria-hidden')).toBe(false)
  })

  it('a structural commit while focused patches the membership; it is never rebuilt', () => {
    const { rt, store } = open()
    rt.setFocus(focusOn([A]))
    expect(rt.membershipBuilds).toBe(1)
    const tie: ClientOp = {
      op: 'yarn.create',
      yarn: {
        type: 'yarn',
        id: 'yarn_00000000000000000000000009',
        noteIds: [A, G],
        color: 'indigo',
        label: '',
        createdAt: T0,
        updatedAt: T0,
      },
    }
    store.commit([tie])
    expect(rt.focus?.notes.has(G)).toBe(true)
    store.commit([{ op: 'yarn.delete', id: Y1 }])
    expect(rt.focus?.notes.has(B)).toBe(false)
    store.commit([{ op: 'note.delete', id: G }])
    store.commit([{ op: 'yarn.update', id: Y2, set: { label: 'dye', color: 'apricot' } }])
    expect(rt.membershipBuilds).toBe(1)
    // Leaving and entering again reuses it too: it is kept patched with focus off.
    rt.setFocus(null)
    store.commit([{ op: 'yarn.delete', id: Y3 }])
    rt.setFocus(focusOn([C], 'all'))
    expect([...(rt.focus?.notes ?? [])].sort()).toEqual([C, D])
    expect(rt.membershipBuilds).toBe(1)
  })

  it('the patched membership equals a fresh one after random ties, unties and deletes', () => {
    const { rt, store } = open()
    rt.setFocus(focusOn([A]))
    let seed = 7
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % n
    }
    let made = 100
    let applied = 0
    const pick = <T>(xs: readonly T[]): T | undefined => xs[rand(Math.max(1, xs.length))]
    for (let step = 0; step < 300; step++) {
      const s = store.getState()
      const notes = [...s.notes.keys()]
      const yarns = [...s.yarns.values()]
      const yarn = pick(yarns)
      const a = pick(notes)
      const b = pick(notes)
      const ops: ClientOp[] = []
      switch (rand(7)) {
        case 0:
          if (a && b && a !== b)
            ops.push({
              op: 'yarn.create',
              yarn: {
                type: 'yarn',
                id: `yarn_${String(made++).padStart(26, '0')}`,
                noteIds: [a, b],
                color: 'indigo',
                label: '',
                createdAt: T0,
                updatedAt: T0,
              },
            })
          break
        case 1:
          if (yarn) ops.push({ op: 'yarn.delete', id: yarn.id })
          break
        case 2:
          if (yarn && a && !yarn.noteIds.includes(a))
            ops.push({ op: 'yarn.insertNote', id: yarn.id, noteId: a, afterNoteId: null })
          break
        case 3:
          if (yarn?.noteIds[0])
            ops.push({ op: 'yarn.removeNote', id: yarn.id, noteId: yarn.noteIds[0] })
          break
        case 4:
          if (a && notes.length > 3) ops.push({ op: 'note.delete', id: a })
          break
        case 5:
          ops.push({ op: 'note.create', note: note(`note_${String(made++).padStart(26, '0')}`) })
          break
        default:
          if (yarn) ops.push({ op: 'yarn.update', id: yarn.id, set: { label: `l${step}` } })
      }
      if (ops.length === 0) continue
      try {
        store.commit(ops)
      } catch {
        continue
      }
      applied++
      expect(shape(rt.focusMembership)).toEqual(shape(buildMembership(store.getState())))
    }
    expect(applied).toBeGreaterThan(100)
    expect(rt.membershipBuilds).toBe(1)
  })

  it('hash round-trips and reload restores focus', () => {
    const f = focusOn([A, B], 2, [G])
    expect(focusHash(f)).toBe(`#focus=${A},${B}&d=2&in=${G}`)
    expect(parseFocusHash(focusHash(f))).toEqual(f)
    expect(parseFocusHash(focusHash(focusOn([C], 'all')))).toEqual(focusOn([C], 'all'))
    expect(focusHash(null)).toBe('')
    expect(parseFocusHash('')).toBeNull()
    expect(parseFocusHash('#d=2')).toBeNull()
    // Ids that are not ids are dropped; an unknown depth is 1.
    expect(parseFocusHash(`#focus=nope,${A},${A}&d=9&in=<x>`)).toEqual(focusOn([A]))

    // A reload: the hash is read when the board opens, and every change is written back.
    history.replaceState(null, '', `/?board=demo${focusHash(focusOn([A], 2))}`)
    const { rt } = open()
    const unbind = bindFocusHash(rt)
    expect(rt.focusState).toEqual(focusOn([A], 2))
    expect(rt.focus?.notes.has(D)).toBe(true)
    // Restored at once: no fade, and the camera already on the focused notes.
    expect(rt.noteEls.get(E)?.getAttribute('aria-hidden')).toBe('true')
    rt.setFocus(focusOn([A], 3))
    expect(location.hash).toBe(`#focus=${A}&d=3`)
    expect(location.search).toBe('?board=demo')
    rt.setFocus(null)
    expect(location.hash).toBe('')
    expect(location.href.endsWith('?board=demo')).toBe(true)

    // Ids no longer on the board are ignored.
    history.replaceState(null, '', `/#focus=${F.replace(/6$/, '9')}&d=1`)
    const other = open().rt
    const unbindOther = bindFocusHash(other)
    expect(other.focus).toBeNull()
    unbindOther()
    unbind()
  })

  it('reduced motion hides at once', () => {
    const { rt } = open()
    vi.spyOn(rt, 'reducedMotion').mockReturnValue(true)
    rt.setFocus(focusOn([A]))
    expect(rt.focusPaint?.fade ?? null).toBeNull()
    expect(rt.noteEls.get(D)?.getAttribute('aria-hidden')).toBe('true')
  })

  it('the fade runs 250 ms over the rest of the board, then stops', () => {
    const { rt } = open()
    rt.setFocus(focusOn([A]))
    const paint = rt.focusPaint
    expect(paint?.shown(A)).toBe(true)
    expect(paint?.shown(D)).toBe(false)
    expect(paint?.fade?.has(D)).toBe(true)
    expect(paint?.fade?.has(A)).toBe(false)
    vi.advanceTimersByTime(100)
    const mid = rt.focusPaint?.fade?.alpha ?? -1
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(1)
    vi.advanceTimersByTime(300)
    expect(rt.focusPaint?.fade).toBeNull()
    // The static layer's key is kept: the end of the fade does not redraw the yarn cache.
    expect(rt.focusPaint?.key).toBe(paint?.key)
  })
})
