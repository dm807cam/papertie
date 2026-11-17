import { type Note, newId, type Op } from '../../packages/core/src'
import { apiFor, expect, test } from './helpers/app'
import { idle, saved } from './helpers/board'
import { seedBoard } from './helpers/lifetime'
import { firstRun, openBoard } from './helpers/server'

/**
 * "+" over a deep pile (the bound on a new note's placement): 2,000 notes heaped in
 * view, and the placement reads a bounded few papers per spot it weighs, so pinning a note
 * there has no long task (the production build, as the app runs).
 */

const NOW = '2026-11-07T00:00:00.000Z'

test('"+" over a pile of 2,000 notes in view pins its note with no long task', async ({ page }) => {
  test.setTimeout(120_000)
  await firstRun(apiFor(page))
  const ops: Op[] = Array.from({ length: 2000 }, (_, i): Op => {
    const note: Note = {
      type: 'note',
      id: newId('note'),
      x: (i % 40) * 3,
      y: Math.floor(i / 40) * 3,
      w: 220,
      h: 160,
      z: i + 1,
      paper: 'cream',
      style: 'smooth',
      text: '',
      image: null,
      createdAt: NOW,
      updatedAt: NOW,
    }
    return { op: 'note.create', note }
  })
  await seedBoard(apiFor(page), ops)
  await openBoard(page)
  await saved(page)
  await page.evaluate(() => window.__papertie.debug.setCamera({ x: -500, y: -300, zoom: 1 }))
  await idle(page)

  // The placement on its own, timed.
  const took = await page.evaluate(() => {
    const rt = window.__papertie.runtime as unknown as {
      placeNear(size: { w: number; h: number }): unknown
    }
    const t = performance.now()
    rt.placeNear({ w: 240, h: 160 })
    return performance.now() - t
  })
  expect(took).toBeLessThan(50)

  // And "+" with Pin note, watched for long tasks until the note is open for writing.
  await page.evaluate(() => {
    const w = window as unknown as { longTasks: number[] }
    w.longTasks = []
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) w.longTasks.push(e.duration)
    }).observe({ type: 'longtask' })
  })
  await page
    .getByRole('toolbar', { name: 'Tools' })
    .getByRole('button', { name: 'New note' })
    .click()
  await page
    .getByRole('dialog', { name: 'New note' })
    .getByRole('button', { name: 'Pin note' })
    .click()
  await expect(page.locator('[contenteditable]').first()).toBeFocused()
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  )
  const long = await page.evaluate(() => (window as unknown as { longTasks: number[] }).longTasks)
  test.info().annotations.push({
    type: 'pile',
    description: `placeNear ${took.toFixed(1)} ms, long tasks [${long.map((d) => d.toFixed(0)).join(', ')}]`,
  })
  console.info(
    `"+" over a 2,000-note pile: placeNear ${took.toFixed(1)} ms, long tasks [${long.join(', ')}]`,
  )
  expect(long).toEqual([])
})
