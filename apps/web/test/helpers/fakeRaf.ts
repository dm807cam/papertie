/** A manual requestAnimationFrame and clock for driving a `FrameLoop` in tests. */
export function fakeRaf(start = 1000) {
  let queue: Array<(t: number) => void> = []
  let t = start
  const raf = (cb: (t: number) => void) => {
    queue.push(cb)
    return queue.length
  }
  return {
    raf,
    now: () => t,
    get pending() {
      return queue.length
    },
    /** Advance the clock by `ms`, then run the frame callbacks queued so far. */
    frame(ms = 16) {
      t += ms
      const run = queue
      queue = []
      for (const cb of run) cb(t)
    },
    /** Run frames `ms` apart until nothing is queued or `max` frames ran; returns the count. */
    drain(ms = 16, max = 1000) {
      let n = 0
      while (queue.length > 0 && n < max) {
        this.frame(ms)
        n++
      }
      return n
    },
  }
}
