import { expect, type Page, test } from '@playwright/test'
import { DEMO_IDS, DEMO_MOCKUP } from '../apps/web/src/dev/demoBoard'
import './hooks'

async function open(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await page.goto('/bench?board=demo')
  await page.waitForFunction(() => window.__papertie?.ready === true)
  await idle(page)
  return errors
}

const idle = (page: Page) =>
  page.waitForFunction(() => window.__papertie.runtime.loop.running === false)

const renders = (page: Page) => page.evaluate(() => window.__papertie.renders.canvasView ?? 0)

const hud = (page: Page) => page.getByTestId('perf-hud')
const cell = (page: Page, k: string) => page.locator(`[data-hud="${k}"]`)

test('the HUD toggles with backtick and the Controls button, without re-rendering the canvas', async ({
  page,
}) => {
  const errors = await open(page)
  await expect(hud(page)).toHaveCount(0)
  const r0 = await renders(page)

  await page.keyboard.press('Backquote')
  await expect(hud(page)).toBeVisible()
  await expect(page.locator('[data-pref="hud"]')).toHaveAttribute('aria-pressed', 'true')
  await expect(cell(page, 'loop')).toHaveText('idle')
  const total = await page.evaluate(() => window.__papertie.store.getState().notes.size)
  await expect(cell(page, 'notes')).toHaveText(new RegExp(`^\\d+ / ${total}$`))
  await expect(cell(page, 'zoom')).toHaveText(/^\d+\.\d\d (full|lite)$/)

  await page.mouse.move(640, 360)
  for (let i = 0; i < 20; i++) await page.mouse.wheel(0, 20)
  await expect(cell(page, 'fps')).toHaveText(/^\d+\.\d$/)
  await idle(page)
  await expect(cell(page, 'loop')).toHaveText('idle')
  expect(await renders(page)).toBe(r0)

  await page.locator('[data-pref="hud"]').click()
  await expect(hud(page)).toHaveCount(0)
  expect(await renders(page)).toBe(r0)
  expect(errors).toEqual([])
})

test('__papertiePerf runs a short scripted pan, zoom and drag through the real input paths', async ({
  page,
}) => {
  const errors = await open(page)
  expect(
    await page.evaluate((id) => window.__papertie.debug.focusCamera(id, 1), DEMO_IDS.hub),
  ).toBe(true)
  await idle(page)
  const c0 = await page.evaluate(() => window.__papertie.debug.camera())
  const pan = await page.evaluate(() => window.__papertiePerf.runGesture('pan', 300))
  expect(pan.frames).toBeGreaterThan(5)
  expect(pan.fps).toBeGreaterThan(0)
  const c1 = await page.evaluate(() => window.__papertie.debug.camera())
  expect(c1.y).not.toBe(c0.y)

  const zoom = await page.evaluate(() => window.__papertiePerf.runGesture('zoom', 300))
  expect(zoom.frames).toBeGreaterThan(5)
  const z = (await page.evaluate(() => window.__papertie.debug.camera())).zoom
  expect(z).toBeGreaterThanOrEqual(0.25 * 0.96)
  expect(z).toBeLessThanOrEqual(2 / 0.96)

  // The drag gesture presses the board's best-connected note: on the demo, the mockup centre.
  await page.evaluate((id) => window.__papertie.debug.focusCamera(id, 1), DEMO_MOCKUP.centre)
  await idle(page)
  const commits = await page.evaluate(() => window.__papertie.store.commits)
  const positions = () =>
    page.evaluate(() =>
      [...window.__papertie.store.getState().notes.values()].map((n) => `${n.x},${n.y}`),
    )
  const before = await positions()
  const drag = await page.evaluate(() => window.__papertiePerf.runGesture('drag', 300))
  expect(drag.frames).toBeGreaterThan(5)
  expect(await page.evaluate(() => window.__papertie.store.commits)).toBe(commits + 1)
  const after = await positions()
  expect(after.filter((p, i) => p !== before[i])).toHaveLength(1)

  await page.evaluate(() => window.__papertiePerf.record())
  await page.mouse.move(640, 360)
  await page.mouse.wheel(0, 200)
  await page.waitForTimeout(200)
  expect((await page.evaluate(() => window.__papertiePerf.stop())).frames).toBeGreaterThan(0)
  await idle(page)
  expect(await page.evaluate(() => window.__papertiePerf.loopRunning())).toBe(false)
  expect(errors).toEqual([])
})

test('__papertiePerf bench extensions: a middle-button grab (held and released), a zoom band, zoomTo, and a drag in overview', async ({
  page,
}) => {
  const errors = await open(page)
  await page.evaluate((id) => window.__papertie.debug.focusCamera(id, 1), DEMO_MOCKUP.centre)
  await idle(page)
  const commits = () => page.evaluate(() => window.__papertie.store.commits)
  const c0 = await commits()
  const cam0 = await page.evaluate(() => window.__papertie.debug.camera())
  const panning = () => page.getByTestId('canvas').getAttribute('data-panning')

  // The grab pans the board with the middle button: the root is marked panning until it ends.
  const grab = page.evaluate(() => window.__papertiePerf.runGesture('grab', 300))
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="canvas"]')?.hasAttribute('data-panning'),
  )
  expect((await grab).frames).toBeGreaterThan(5)
  expect(await panning()).toBeNull()
  expect(await page.evaluate(() => window.__papertie.debug.camera())).not.toEqual(cam0)
  expect(await commits()).toBe(c0)
  await idle(page)

  // With hold, the grab ends still pressed; release lets go and waits two frames.
  await page.evaluate(() => window.__papertiePerf.runGesture('grab', 200, { hold: true }))
  expect(await panning()).toBe('')
  await expect(page.evaluate(() => window.__papertiePerf.runGesture('pan', 100))).rejects.toThrow(
    /not released/,
  )
  await page.evaluate(() => window.__papertiePerf.release())
  expect(await panning()).toBeNull()
  await page.evaluate(() => window.__papertiePerf.release())
  expect(await commits()).toBe(c0)
  await idle(page)

  const zoom = await page.evaluate(() =>
    window.__papertiePerf.runGesture('zoom', 300, { zoomMin: 0.5, zoomMax: 0.8 }),
  )
  expect(zoom.frames).toBeGreaterThan(5)
  const z = (await page.evaluate(() => window.__papertie.debug.camera())).zoom
  expect(z).toBeGreaterThanOrEqual(0.5 * 0.96)
  expect(z).toBeLessThanOrEqual(0.8 / 0.96)
  await idle(page)

  // zoomTo wheels down to the zoom (at most one 4 % step past it) and records until it settled.
  const to = await page.evaluate(() => window.__papertiePerf.zoomTo(0.3))
  expect(to.frames).toBeGreaterThan(5)
  const z1 = (await page.evaluate(() => window.__papertie.debug.camera())).zoom
  expect(z1).toBeLessThanOrEqual(0.3)
  expect(z1).toBeGreaterThan(0.3 * 0.95)
  expect(await page.evaluate(() => window.__papertie.debug.lod())).toBe('lite')
  await idle(page)

  // Overview mounts no notes: the drag presses the hub's card through noteAt.
  await page.evaluate((id) => window.__papertie.debug.focusCamera(id, 0.1), DEMO_MOCKUP.centre)
  await page.waitForFunction(() => window.__papertie.debug.lod() === 'overview')
  await idle(page)
  const positions = () =>
    page.evaluate(() =>
      [...window.__papertie.store.getState().notes.values()].map((n) => `${n.x},${n.y}`),
    )
  const before = await positions()
  const c1 = await commits()
  const drag = await page.evaluate(() => window.__papertiePerf.runGesture('drag', 300))
  expect(drag.frames).toBeGreaterThan(5)
  expect(await commits()).toBe(c1 + 1)
  expect((await positions()).filter((p, i) => p !== before[i])).toHaveLength(1)
  await idle(page)
  expect(errors).toEqual([])
})
