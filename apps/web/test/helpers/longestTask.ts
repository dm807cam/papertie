/**
 * The longest stretch the page was held while `work` runs (the timing rows: a slice's length, a
 * task's): the longest gap between heartbeats, up to the moment `work` is done.
 *
 * A heartbeat in each phase of Node's event loop a task runs in: a posted message, a timer, an
 * immediate. A gap is then one task's, as a page's would be (a browser gives input and frames a
 * turn between any two tasks). A posted-message heartbeat alone read two tasks as one: Node runs
 * a timer that falls due during a posted message's task straight after it, before the
 * heartbeat's next message (a sliced task and the timer task it leaves, read
 * as 7.5–10.6 ms against 9.75, each 5 ms and 2.5 ms of its own).
 */
export async function longestTaskOf<T>(
  work: () => Promise<T>,
): Promise<{ result: T; ms: number; beats: number }> {
  let last = performance.now()
  let worst = 0
  let beats = 0
  let on = true
  const beat = () => {
    const t = performance.now()
    worst = Math.max(worst, t - last)
    last = t
    beats++
  }
  const { port1, port2 } = new MessageChannel()
  port1.onmessage = () => {
    beat()
    if (on) port2.postMessage(null)
  }
  port2.postMessage(null)
  let timer: ReturnType<typeof setTimeout> | null = null
  const onTimer = () => {
    beat()
    if (on) timer = setTimeout(onTimer, 0)
  }
  timer = setTimeout(onTimer, 0)
  let immediate: ReturnType<typeof setImmediate> | null = null
  const onImmediate = () => {
    beat()
    if (on) immediate = setImmediate(onImmediate)
  }
  immediate = setImmediate(onImmediate)
  try {
    const result = await work()
    // The stretch since the last heartbeat held the page too.
    worst = Math.max(worst, performance.now() - last)
    return { result, ms: worst, beats }
  } finally {
    on = false
    port1.close()
    if (timer !== null) clearTimeout(timer)
    if (immediate !== null) clearImmediate(immediate)
  }
}
