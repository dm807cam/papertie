/**
 * The timing rows' measure: the longest gap between heartbeats while work
 * runs is one task's length, never two tasks' that a page would have had a turn between. Node
 * runs a timer due after a posted message's task with no posted message between them, so a
 * heartbeat of posted messages alone read a sliced task and the timer task after it as one. Its
 * upper bound is a wall time: the timing project runs it, a file at a time
 * (`longestTaskOf.test.ts` keeps the row's floors).
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { longestTaskOf } from './longestTask'

const busy = (ms: number) => {
  const end = performance.now() + ms
  while (performance.now() < end) {
    // held: one task of `ms`
  }
}

/** A posted message's task of 6 ms that leaves a timer due as it ends, and the timer's 6 ms. */
const twoTasks = () =>
  new Promise<void>((done) => {
    const { port1, port2 } = new MessageChannel()
    port1.onmessage = () => {
      port1.close()
      setTimeout(() => {
        busy(6)
        done()
      }, 0)
      busy(6)
    }
    port2.postMessage(null)
  })

describe('the longest task while work runs', () => {
  // Node loads its messaging the first time a port is used (some 20 ms): before the rows.
  beforeAll(
    () =>
      new Promise<void>((done) => {
        const { port1, port2 } = new MessageChannel()
        port1.onmessage = () => {
          port1.close()
          done()
        }
        port2.postMessage(null)
      }),
  )

  it('two tasks back to back read as one task of theirs, not as their sum', async () => {
    const { ms, beats } = await longestTaskOf(async () => {
      await twoTasks()
      await new Promise((r) => setTimeout(r, 20)) // and the page's turns after them
    })
    expect(beats).toBeGreaterThan(0)
    expect(ms).toBeGreaterThanOrEqual(6)
    expect(ms).toBeLessThan(11)
  })
})
