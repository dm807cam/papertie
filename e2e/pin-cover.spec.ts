import { expect, type Page, test } from '@playwright/test'
import { newId } from '../packages/core/src'

/**
 * A note's hanging pin under another note's paper: the paper on top hides
 * it, as a real pin cannot pass through paper, and a press there is not the hidden pin's; a pin a
 * thread is tied at stays, so the cord never ends in the air.
 */

test.use({ viewport: { width: 1280, height: 800 } })

const NOW = '2026-11-07T00:00:00.000Z'
const A = newId('note')
const B = newId('note')
const C = newId('note')
const Y = newId('yarn')

const note = (id: string, x: number, y: number, z: number) => ({
  type: 'note',
  id,
  x,
  y,
  w: 220,
  h: 160,
  z,
  paper: 'cream',
  style: 'rustic',
  text: id === B ? 'On top' : 'Beneath',
  image: null,
  createdAt: NOW,
  updatedAt: NOW,
})

async function open(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/bench?board=empty')
  await page.waitForFunction(() => window.__papertie?.ready === true)
  await page.evaluate(() => window.__papertie.debug.setCamera({ x: -200, y: -200, zoom: 1 }))
  return errors
}

const commit = (page: Page, ops: unknown[]) =>
  page.evaluate((ops) => {
    ;(window.__papertie.store as unknown as { commit(ops: unknown[]): void }).commit(ops)
  }, ops)

/** Pins drawn now (hanging and edge, cached and live), once the board is at rest. */
async function pinsDrawn(page: Page): Promise<number> {
  await page.waitForFunction(() => {
    const rt = window.__papertie.runtime
    return !rt.loop.running && !rt.camera.moving
  })
  return page.evaluate(() => window.__papertie.debug.stats().pins)
}

test('the paper on top hides the pin of the note beneath, and takes the press there', async ({
  page,
}) => {
  const errors = await open(page)
  // A and C apart, then B over A's pin (higher z), then B moved away.
  await commit(page, [
    { op: 'note.create', note: note(A, 0, 0, 1) },
    { op: 'note.create', note: note(C, 600, 0, 3) },
  ])
  const apart = await pinsDrawn(page)
  expect(apart).toBe(2)
  await commit(page, [{ op: 'note.create', note: note(B, -40, -50, 2) }])
  expect(await pinsDrawn(page)).toBe(2)
  // A press on A's pin point lands on B's paper, not on A's hidden pin.
  const hit = await page.evaluate((id) => {
    const d = window.__papertie.debug
    const p = d.pinScreen(id)
    return p === undefined ? null : d.hitAt(p)
  }, A)
  expect(hit).not.toEqual({ kind: 'pin', noteId: A })
  await commit(page, [{ op: 'note.update', id: B, set: { x: 300, y: 300 } }])
  expect(await pinsDrawn(page)).toBe(3)
  expect(errors).toEqual([])
})

test('a pin a thread is tied at stays, under paper or not', async ({ page }) => {
  const errors = await open(page)
  await commit(page, [
    { op: 'note.create', note: note(A, 0, 0, 1) },
    { op: 'note.create', note: note(C, 600, 0, 3) },
    { op: 'note.create', note: note(B, 300, 300, 2) },
    {
      op: 'yarn.create',
      yarn: {
        type: 'yarn',
        id: Y,
        noteIds: [A, C],
        color: 'indigo',
        label: '',
        pins: { [A]: 'hanging' },
        createdAt: NOW,
        updatedAt: NOW,
      },
    },
  ])
  const clear = await pinsDrawn(page)
  await commit(page, [{ op: 'note.update', id: B, set: { x: -40, y: -50 } }])
  expect(await pinsDrawn(page)).toBe(clear)
  expect(errors).toEqual([])
})

test('focus on the note beneath shows its pin; leaving focus hides it again', async ({ page }) => {
  const errors = await open(page)
  await commit(page, [
    { op: 'note.create', note: note(A, 0, 0, 1) },
    { op: 'note.create', note: note(C, 600, 0, 3) },
    { op: 'note.create', note: note(B, -40, -50, 2) },
  ])
  expect(await pinsDrawn(page)).toBe(2)
  // Focus on A alone: B is hidden, so its paper covers nothing and A's pin shows.
  await page.evaluate(
    (id) =>
      window.__papertie.runtime.setFocus({ seeds: [id], depth: 1, include: [] }, { instant: true }),
    A,
  )
  await page.waitForFunction(() => (window.__papertie.runtime.focusPaint?.fade ?? null) === null)
  expect(await pinsDrawn(page)).toBe(1)
  // Back to the whole board: B covers A's pin again.
  await page.evaluate(() => window.__papertie.runtime.setFocus(null, { instant: true }))
  await page.waitForFunction(() => (window.__papertie.runtime.focusPaint?.fade ?? null) === null)
  expect(await pinsDrawn(page)).toBe(2)
  expect(errors).toEqual([])
})

test('at equal z, the paper painted later covers, as the board paints them', async ({ page }) => {
  const errors = await open(page)
  // Same z: the board paints by id after z, so the later id is on top.
  const [low, high] = [A, B].sort()
  await commit(page, [
    { op: 'note.create', note: note(low as string, 0, 0, 1) },
    { op: 'note.create', note: note(high as string, -40, -50, 1) },
  ])
  // The lower id's pin, at (110, 14), lies on the later paper: hidden. The later one's shows.
  expect(await pinsDrawn(page)).toBe(1)
  expect(errors).toEqual([])
})
