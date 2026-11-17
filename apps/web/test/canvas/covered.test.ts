// @vitest-environment jsdom
import { emptyBoardState } from '@papertie/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_PREFS, prefsStore } from '../../src/app/prefs'
import { openLocalSession } from '../../src/app/session'
import { CanvasRuntime } from '../../src/canvas/runtime'
import { canvasElements, installCanvasStubs } from '../helpers/domCanvas'

let restore: () => void = () => {}
let rt: CanvasRuntime
let els: ReturnType<typeof canvasElements>

beforeEach(() => {
  prefsStore.setState({ ...DEFAULT_PREFS })
  restore = installCanvasStubs()
  const session = openLocalSession({
    kind: 'local',
    state: emptyBoardState('board_01JBX0000000000000000000AA', 'B', '2026-10-30T09:00:00.000Z'),
    label: 'test',
  })
  els = canvasElements()
  rt = new CanvasRuntime(els, session.store)
})
afterEach(() => {
  rt.dispose()
  restore()
  document.body.replaceChildren()
})

const wheel = (target: EventTarget) => {
  const e = new WheelEvent('wheel', {
    deltaY: 100,
    clientX: 103,
    clientY: 300,
    bubbles: true,
    cancelable: true,
  })
  target.dispatchEvent(e)
  return e
}

describe('the board under a sheet (data-covered)', () => {
  it('takes no wheel, whatever it lands on: the sheet has the screen', () => {
    els.root.setAttribute('data-covered', '')
    const before = rt.camera.get()
    // The gutter around the sidebar: the press or wheel lands on the viewport itself.
    wheel(els.root)
    expect(rt.camera.get()).toEqual(before)
    // And it still pans when nothing covers it.
    els.root.removeAttribute('data-covered')
    wheel(els.root)
    expect(rt.camera.get().y).not.toBe(before.y)
  })

  it('takes no press either: a drag on its cork pans nothing', () => {
    els.root.setAttribute('data-covered', '')
    const before = rt.camera.get()
    const down = (type: string, x: number) =>
      els.root.dispatchEvent(
        new MouseEvent(type, {
          clientX: x,
          clientY: 300,
          bubbles: true,
          cancelable: true,
          button: 0,
        }),
      )
    els.root.dispatchEvent(
      Object.assign(
        new MouseEvent('pointerdown', { clientX: 103, clientY: 300, bubbles: true, button: 0 }),
        {
          pointerId: 1,
          pointerType: 'mouse',
        },
      ),
    )
    down('pointermove', 203)
    expect(rt.camera.get()).toEqual(before)
    expect(els.root.hasAttribute('data-panning')).toBe(false)
  })

  it('leaves a wheel over the UI layer unprevented, so a scrollable sheet can scroll', () => {
    const ui = document.createElement('div')
    ui.className = 'ui'
    const scroller = document.createElement('div')
    ui.append(scroller)
    els.root.append(ui)
    expect(wheel(scroller).defaultPrevented).toBe(false)
    // A pinch (ctrl or meta) over it is still not the page's to zoom.
    const pinch = new WheelEvent('wheel', {
      deltaY: -3,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    })
    scroller.dispatchEvent(pinch)
    expect(pinch.defaultPrevented).toBe(true)
  })
})
