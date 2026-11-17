import { atIdle as pageIdle } from './atIdle'

/**
 * Chrome on macOS asks the window server which modifier keys are held (`GetCurrentKeyModifiers`)
 * the first time a renderer needs to know: for its fake mouse move after a layout under a known
 * pointer. That first ask connects the renderer to the window server (a permission check and the
 * display set-up): 30 to 50 ms of native work, once per renderer process. Left to itself it lands
 * in the frame of the first key typed after a click, whose layout is the first under the pointer
 * (a native sample of the renderer in that frame).
 *
 * So once per page, once the pointer is on it (its first `pointermove`), one layout-dirtying
 * write at idle: a 0×0 sentinel's width from 0 to 1 px, laid out by the next frame (nothing reads
 * it back, so no layout is forced). That idle frame's fake mouse move makes the first ask. No
 * focus moves, no field is made, and a page whose book already has the focus is warmed alike. A
 * press or a key before that frame has drawn pre-empts it: it is asked again at the next move.
 */

interface Env {
  atIdle(fn: () => void): () => void
  frame(fn: () => void): void
}

let done = false

const pageEnv: Env = {
  atIdle: pageIdle,
  frame: (fn) => {
    requestAnimationFrame(() => fn())
  },
}

/** Prepay the first hover move at idle once the pointer is on the page; returns the undo. */
export function prepayHover(env: Env = pageEnv): () => void {
  if (done || typeof window === 'undefined') return () => {}
  let stopped = false
  let cancelIdle: (() => void) | null = null
  /** The write's frames are still to draw. */
  let pending = false
  let preempted = false

  const arm = () => {
    if (stopped || done) return
    addEventListener('pointermove', onMove, { passive: true, once: true })
  }
  const onMove = () => {
    if (stopped || done) return
    preempted = false
    cancelIdle = env.atIdle(write)
  }
  const onInput = () => {
    if (cancelIdle !== null) {
      // Not written yet: dropped, and asked again at the next move.
      cancelIdle()
      cancelIdle = null
      arm()
    } else if (pending) preempted = true
  }
  const write = () => {
    cancelIdle = null
    if (stopped || done) return
    const el = document.createElement('div')
    el.dataset.hoverWarm = ''
    el.setAttribute('aria-hidden', 'true')
    el.style.cssText =
      'position:fixed;left:0;top:0;width:0;height:0;overflow:hidden;pointer-events:none;contain:strict'
    document.body.append(el)
    el.style.width = '1px'
    pending = true
    // The next frame lays it out (the ask happens there); the one after takes it away.
    env.frame(() =>
      env.frame(() => {
        pending = false
        el.remove()
        if (stopped) return
        if (preempted) arm()
        else finish()
      }),
    )
  }
  const finish = () => {
    done = true
    removeEventListener('pointerdown', onInput, true)
    removeEventListener('keydown', onInput, true)
  }
  addEventListener('pointerdown', onInput, { capture: true, passive: true })
  addEventListener('keydown', onInput, { capture: true, passive: true })
  arm()
  return () => {
    stopped = true
    cancelIdle?.()
    cancelIdle = null
    removeEventListener('pointermove', onMove)
    removeEventListener('pointerdown', onInput, true)
    removeEventListener('keydown', onInput, true)
  }
}
