/**
 * How long work on the page (the stage digest) may hold it: a step at a time with a task between
 * steps while the tab is visible, so frames and input go on; all at once while it is hidden (no
 * frames to keep), since a hidden tab throttles timers to one a second, then one a minute.
 */
export interface DigestPace {
  /** No frames to keep: the tab is hidden, or there is no page (a worker, a test). */
  hidden(): boolean
  /** A task boundary that a hidden tab does not throttle like a timer. */
  yield(): Promise<void>
}

type Scheduler = { yield?: () => Promise<void> }

const pageHidden = () => {
  const doc = (globalThis as { document?: { hidden?: boolean } }).document
  return doc === undefined || doc.hidden === true
}

/** A task of its own, by a MessageChannel message: queued behind the tasks already waiting. */
const postedTask = () =>
  new Promise<void>((resolve) => {
    const { port1, port2 } = new MessageChannel()
    port1.onmessage = () => {
      port1.close()
      resolve()
    }
    port2.postMessage(null)
  })

/** The page's own pace: `scheduler.yield()` where there is one, else a MessageChannel message. */
export const pagePace: DigestPace = {
  hidden: pageHidden,
  yield: () => {
    const s = (globalThis as { scheduler?: Scheduler }).scheduler
    if (typeof s?.yield === 'function') return s.yield()
    return postedTask()
  },
}

/**
 * A pace for work that may wait its turn: always a task of its own, behind what is already queued
 * (a fetch's answer), never a `scheduler.yield()` continuation, which runs ahead of
 * every queued task. The writer's first window grows so beside the board, whose opening reads its
 * kept tiles meanwhile (the final perf pass: the growth's continuations held their answers 70 ms).
 */
export const taskPace: DigestPace = { hidden: pageHidden, yield: postedTask }

/** A pace with the clock its slices are timed by (default `performance.now`). */
export type SlicePace = DigestPace & { clock?: () => number }

/**
 * Work in slices of at most `budget` ms: `await` the function it returns between pieces of work,
 * and it yields to the page (a task boundary) once the slice has run its course. Never while the
 * tab is hidden (no frames to keep; a hidden tab throttles its tasks).
 */
export function slicer(pace: SlicePace = pagePace, budget = 4): () => Promise<void> {
  const clock = pace.clock ?? (() => performance.now())
  const hidden = pace.hidden()
  let end = clock() + budget
  return async () => {
    if (hidden || clock() < end) return
    await pace.yield()
    end = clock() + budget
  }
}
