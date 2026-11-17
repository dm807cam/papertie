import type { CanvasElements } from '../../src/canvas/runtime'

/**
 * A 2D context that takes anything: every property and call answers itself (a gradient, a
 * pattern, `measureText`), and it reads as 0 in arithmetic. Frames draw into it and nothing shows.
 */
function anyContext(): CanvasRenderingContext2D {
  const fn = () => {}
  const any: unknown = new Proxy(fn, {
    get: (_t, prop) => (prop === Symbol.toPrimitive ? () => 0 : any),
    apply: () => any,
    set: () => true,
  })
  return any as CanvasRenderingContext2D
}

/** The viewport jsdom pretends to have: it lays nothing out, so every box is 0 x 0 otherwise. */
export const VIEWPORT = { width: 1200, height: 800 }

/**
 * What `CanvasRuntime` needs from a browser that jsdom lacks: 2D contexts (a stand-in),
 * `ResizeObserver` and a laid-out viewport size. Returns the function that removes them.
 */
export function installCanvasStubs(): () => void {
  const spies = [
    vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation(() => anyContext() as never),
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(VIEWPORT.width),
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(VIEWPORT.height),
  ]
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  return () => {
    for (const s of spies) s.mockRestore()
    vi.unstubAllGlobals()
  }
}

/** The layer stack `CanvasView` renders, attached to the document. */
export function canvasElements(): CanvasElements {
  const div = (className: string) => {
    const el = document.createElement('div')
    el.className = className
    return el
  }
  const root = document.createElement('main')
  const els: CanvasElements = {
    root,
    cork: div('cork'),
    world: div('world'),
    yarnCanvas: document.createElement('canvas'),
    pinCanvas: document.createElement('canvas'),
    overlay: div('overlay'),
  }
  root.append(els.cork, els.world, els.yarnCanvas, els.pinCanvas, els.overlay)
  document.body.append(root)
  return els
}
