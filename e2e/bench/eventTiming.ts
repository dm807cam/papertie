import type { BrowserContext, Page } from '@playwright/test'

/** Timing input in a page: Event Timing of typed keys, and the long tasks around them. */

export const percentile = (xs: readonly number[], p: number) =>
  [...xs].sort((a, b) => a - b)[Math.max(0, Math.ceil(p * xs.length) - 1)] ?? Number.NaN

/** Long tasks (over 50 ms) from the first byte, read back with {@link longTasks}. */
export async function watchLongTasks(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const long: Array<{ start: number; ms: number }> = []
    ;(window as unknown as { __longTasks: typeof long }).__longTasks = long
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries())
          long.push({ start: Math.round(e.startTime), ms: Math.round(e.duration) })
      }).observe({ type: 'longtask', buffered: true })
    } catch {
      // no Long Tasks API
    }
  })
}

export const longTasks = (page: Page, since = 0) =>
  page.evaluate(
    (since) =>
      (
        (window as unknown as { __longTasks?: Array<{ start: number; ms: number }> }).__longTasks ??
        []
      ).filter((t) => t.start >= since),
    since,
  )

/**
 * Event Timing of the keys typed from now (entries of 16 ms or more: the API's floor). An entry
 * comes once its frame is presented, so a key pressed just before (the ⌘A that selects a note's
 * text) can be reported after the watch began: only keys whose event began after it count.
 */
async function watchKeys(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __keys: Map<number, number> }
    w.__keys = new Map()
    const since = performance.now()
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as PerformanceEventTiming[]) {
        if (!e.interactionId || !e.name.startsWith('key') || e.startTime < since) continue
        w.__keys.set(e.interactionId, Math.max(w.__keys.get(e.interactionId) ?? 0, e.duration))
      }
    }).observe({ type: 'event', durationThreshold: 16, buffered: false } as PerformanceObserverInit)
  })
}
const keyTimes = (page: Page) =>
  page.evaluate(() => [...(window as unknown as { __keys: Map<number, number> }).__keys.values()])

const TYPED = 'the lifetime board keeps every thought, one key at a time ok'

/** Event Timing over `typed` (`TYPED`: 60 keys, 60 ms apart); keys under 16 ms are not reported (16). */
export async function keysOf(page: Page, typed = TYPED) {
  await watchKeys(page)
  await page.keyboard.type(typed, { delay: 60 })
  await page.waitForTimeout(300)
  const slow = await keyTimes(page)
  const keys = [...slow, ...Array(Math.max(0, typed.length - slow.length)).fill(16)] as number[]
  return { keys: keys.length, p95Ms: percentile(keys, 0.95), maxMs: Math.max(...keys), slow }
}
