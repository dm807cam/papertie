/**
 * How the stage digest paces itself on the page (`pagePace`): a visible tab hands the page a task
 * between steps, by the scheduler or a MessageChannel, never a timer (timers are throttled in a
 * hidden tab, to one a second and then one a minute); a hidden tab, or no page at all, has no
 * frames to keep and takes every step at once.
 */
import { pagePace, taskPace } from '../../src/sync/pace'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('pagePace', () => {
  it('is hidden with no document (a worker, a test) and as the document says otherwise', () => {
    vi.stubGlobal('document', undefined)
    expect(pagePace.hidden()).toBe(true)
    vi.stubGlobal('document', { hidden: false })
    expect(pagePace.hidden()).toBe(false)
    vi.stubGlobal('document', { hidden: true })
    expect(pagePace.hidden()).toBe(true)
  })

  it("yields through the page's scheduler where there is one", async () => {
    const y = vi.fn(async () => {})
    vi.stubGlobal('scheduler', { yield: y })
    await pagePace.yield()
    expect(y).toHaveBeenCalledTimes(1)
  })

  it('else through a MessageChannel: no timer, so fake time need not move', async () => {
    vi.stubGlobal('scheduler', undefined)
    vi.useFakeTimers()
    const posted = vi.spyOn(MessagePort.prototype, 'postMessage')
    await pagePace.yield()
    expect(posted).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('taskPace', () => {
  it('always a posted task, behind what is queued: never a scheduler continuation', async () => {
    const y = vi.fn(async () => {})
    vi.stubGlobal('scheduler', { yield: y })
    const posted = vi.spyOn(MessagePort.prototype, 'postMessage')
    await taskPace.yield()
    expect(y).not.toHaveBeenCalled()
    expect(posted).toHaveBeenCalledTimes(1)
  })
})
