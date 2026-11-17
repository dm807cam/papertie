// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

type Mod = typeof import('../../src/app/prepayHover')

/** A fresh module: the warm-up is once per page, and every case is a page of its own. */
async function fresh(): Promise<Mod> {
  vi.resetModules()
  return import('../../src/app/prepayHover')
}

/** The idle queue and the frames, run by hand; what the page saw meanwhile. */
function setup(mod: Mod) {
  const idle: Array<() => void> = []
  const frames: Array<() => void> = []
  const added: string[] = []
  const focusEvents: string[] = []
  const watch = new MutationObserver((rs) => {
    for (const r of rs)
      for (const n of r.addedNodes) if (n instanceof Element) added.push(n.tagName)
  })
  watch.observe(document, { childList: true, subtree: true })
  const onFocus = (e: Event) => focusEvents.push(e.type)
  document.addEventListener('focusin', onFocus)
  document.addEventListener('focusout', onFocus)
  const off = mod.prepayHover({
    atIdle: (fn) => {
      idle.push(fn)
      return () => {
        const i = idle.indexOf(fn)
        if (i >= 0) idle.splice(i, 1)
      }
    },
    frame: (fn) => {
      frames.push(fn)
    },
  })
  const flush = async () => {
    await Promise.resolve()
    added.push(
      ...watch
        .takeRecords()
        .flatMap((r) => [...r.addedNodes].map((n) => (n as Element).tagName ?? '')),
    )
  }
  return {
    idle,
    frames,
    added,
    focusEvents,
    off,
    flush,
    move: () => window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true })),
    runFrames: () => {
      for (const f of frames.splice(0)) f()
    },
    done: () => {
      watch.disconnect()
      document.removeEventListener('focusin', onFocus)
      document.removeEventListener('focusout', onFocus)
      off()
    },
  }
}

const sentinel = () => document.querySelector<HTMLElement>('[data-hover-warm]')

afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('the first hover move prepaid at idle (Important B)', () => {
  it('nothing until the pointer is on the page; then at idle one width write on a 0×0 sentinel, no read, no focus, no form field', async () => {
    const mod = await fresh()
    // The book has the focus already: the warm-up runs all the same.
    const host = document.createElement('p')
    host.contentEditable = 'true'
    host.tabIndex = 0
    document.body.append(host)
    host.focus()
    expect(document.activeElement).toBe(host)
    const s = setup(mod)
    expect(s.idle).toHaveLength(0)
    s.move()
    expect(s.idle).toHaveLength(1)
    expect(sentinel()).toBeNull() // nothing written before idle
    const reads = [
      vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get'),
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get'),
      vi.spyOn(Element.prototype, 'getBoundingClientRect'),
      vi.spyOn(Element.prototype, 'getClientRects'),
      vi.spyOn(window, 'getComputedStyle'),
    ]
    s.idle.shift()?.()
    const el = sentinel() as HTMLElement
    expect(el).not.toBeNull()
    expect(el.getAttribute('aria-hidden')).toBe('true')
    expect(el.style.height).toBe('0px')
    expect(el.style.width).toBe('1px') // laid out by the next frame, from 0
    for (const r of reads) expect(r).not.toHaveBeenCalled()
    // The next frame lays it out; the one after takes it away.
    s.runFrames()
    s.runFrames()
    expect(sentinel()).toBeNull()
    await s.flush()
    expect(s.added.filter((t) => /^(INPUT|TEXTAREA|SELECT|FORM|BUTTON)$/.test(t))).toEqual([])
    expect(s.focusEvents).toEqual([])
    expect(document.activeElement).toBe(host)
    // Once a page: a later move asks nothing.
    s.move()
    expect(s.idle).toHaveLength(0)
    s.done()
  })

  it('pre-empted (a press before its frame): asks again at the next move', async () => {
    const mod = await fresh()
    const s = setup(mod)
    s.move()
    expect(s.idle).toHaveLength(1)
    window.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    expect(s.idle).toHaveLength(0) // its idle write dropped
    s.move()
    expect(s.idle).toHaveLength(1)
    s.idle.shift()?.()
    // A key before the frame laid it out: once more.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    s.runFrames()
    s.runFrames()
    expect(sentinel()).toBeNull()
    s.move()
    expect(s.idle).toHaveLength(1)
    s.idle.shift()?.()
    s.runFrames()
    s.runFrames()
    s.move()
    expect(s.idle).toHaveLength(0)
    s.done()
  })

  it('stopped, asks nothing', async () => {
    const mod = await fresh()
    const s = setup(mod)
    s.off()
    s.move()
    expect(s.idle).toHaveLength(0)
    s.done()
  })
})
