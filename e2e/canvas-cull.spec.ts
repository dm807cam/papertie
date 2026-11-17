import { expect, type Page, test } from '@playwright/test'
import { LOD } from '../apps/web/src/canvas/lod'
import { DEMO_IDS } from '../apps/web/src/dev/demoBoard'
import type { Pt } from './hooks'

const VIEW = { width: 1280, height: 720 }
test.use({ viewport: VIEW })

async function open(page: Page, board: string) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await page.goto(`/bench?board=${board}`)
  await page.waitForFunction(() => window.__papertie?.ready === true)
  await idle(page)
  return errors
}

const idle = (page: Page) =>
  page.waitForFunction(() => window.__papertie.runtime.loop.running === false)

const notes = (page: Page) => page.locator('article.note')

/** Pixel `[r, g, b, a]` of a layer canvas at a viewport CSS point. */
const pixel = (page: Page, layer: 'yarn-layer' | 'pin-layer', p: Pt) =>
  page.evaluate(
    ({ layer, p }) => {
      const c = document.querySelector(`canvas.${layer}`) as HTMLCanvasElement
      const ctx = c.getContext('2d') as CanvasRenderingContext2D
      const d = devicePixelRatio
      return [...ctx.getImageData(Math.floor(p.x * d), Math.floor(p.y * d), 1, 1).data]
    },
    { layer, p },
  )

const inView = (p: Pt | undefined, inset = 12): p is Pt =>
  p !== undefined &&
  p.x >= inset &&
  p.y >= inset &&
  p.x <= VIEW.width - inset &&
  p.y <= VIEW.height - inset

/** Five on-screen pins sample brass, and the crossed yarn's midpoint has ink on the yarn canvas. */
async function expectPinsAndYarn(page: Page) {
  const ids = await page.evaluate(() => [...window.__papertie.store.getState().notes.keys()])
  const pins: Array<{ id: string; p: Pt }> = []
  for (const id of ids) {
    const p = await page.evaluate((id) => window.__papertie.debug.pinScreen(id), id)
    if (inView(p)) pins.push({ id, p })
  }
  expect(pins.length).toBeGreaterThanOrEqual(5)
  for (const { p } of pins.slice(0, 5)) {
    const [r = 0, g = 0, b = 0] = await pixel(page, 'pin-layer', p)
    expect(r).toBeGreaterThan(150)
    expect(r).toBeGreaterThan(g)
    expect(g).toBeGreaterThan(b)
  }
  const mid = await yarnMid(page)
  expect(inView(mid)).toBe(true)
  if (!mid) return
  const [, , , a = 0] = await pixel(page, 'yarn-layer', mid)
  expect(a).toBeGreaterThan(0)
}

const yarnMid = (page: Page) =>
  page.evaluate((id) => window.__papertie.debug.yarnPointScreen(id, 0, 0.5), DEMO_IDS.crossed)

test('the 1000 board mounts only culled notes at zoom 1, every note in lite zoomed out, none in overview', async ({
  page,
}) => {
  const errors = await open(page, '1000')
  await page.evaluate(() => window.__papertie.debug.setCamera({ x: 3000, y: 3000, zoom: 1 }))
  await idle(page)
  const mounted = await notes(page).count()
  expect(mounted).toBeGreaterThan(0)
  expect(mounted).toBeLessThan(80)
  expect(await page.locator('article.note--lite').count()).toBe(0)

  // Fit-all lands in overview (zoom ~0.06): no note is mounted.
  await page.keyboard.press('Shift+Digit1')
  await idle(page)
  expect((await page.evaluate(() => window.__papertie.debug.camera())).zoom).toBeLessThan(
    LOD.overview.enterBelow,
  )
  expect(await page.evaluate(() => window.__papertie.debug.lod())).toBe('overview')
  await expect(notes(page)).toHaveCount(0)

  // Lite's lowest zoom, centred on the board: the cull rect still holds every note.
  await page.evaluate((zoom) => {
    const m = window.__papertie
    const r = m.debug.notesRect()
    if (r === null) return
    m.debug.setCamera({ x: r.x + r.w / 2 - 640 / zoom, y: r.y + r.h / 2 - 360 / zoom, zoom })
  }, LOD.overview.exitAtOrAbove)
  await idle(page)
  expect(await page.evaluate(() => window.__papertie.debug.lod())).toBe('lite')
  await expect(notes(page)).toHaveCount(1000)
  await expect(page.locator('article.note:not(.note--lite)')).toHaveCount(0)
  const masked = await page.locator('article.note, article.note *').evaluateAll(
    (els) =>
      els.filter((el) => {
        const v = getComputedStyle(el).getPropertyValue('-webkit-mask-box-image-source')
        return v !== '' && v !== 'none'
      }).length,
  )
  expect(masked).toBe(0)

  await page.evaluate(() => window.__papertie.debug.setCamera({ x: 3000, y: 3000, zoom: 1 }))
  await idle(page)
  await expect(page.locator('article.note--lite')).toHaveCount(0)
  expect(await notes(page).count()).toBeLessThan(80)
  expect(errors).toEqual([])
})

test('pins are brass and yarn is drawn on the demo board, after a pan (blit) and a zoom (redraw)', async ({
  page,
}) => {
  const errors = await open(page, 'demo')
  // The test notes (and `crossed`) lie outside the mockup framing: the whole of them at 0.5.
  await page.evaluate(() => window.__papertie.debug.setCamera({ x: 0, y: 0, zoom: 0.5 }))
  await idle(page)
  await expectPinsAndYarn(page)

  const before = await yarnMid(page)
  await page.mouse.move(640, 360)
  await page.mouse.wheel((before?.x ?? 0) > VIEW.width / 2 ? 300 : -300, 0)
  await idle(page)
  const stats = await page.evaluate(() => window.__papertie.debug.stats())
  expect(stats.staticRedrawn).toBe(false)
  expect(stats.segmentsStatic).toBeGreaterThan(0)
  await expectPinsAndYarn(page)

  const mid = await yarnMid(page)
  await page.mouse.move(mid?.x ?? 640, mid?.y ?? 360)
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -100)
  await page.keyboard.up('Control')
  await idle(page)
  expect((await page.evaluate(() => window.__papertie.debug.stats())).staticRedrawn).toBe(true)
  await expectPinsAndYarn(page)
  expect(errors).toEqual([])
})

test('picking 500 in the board picker loads the 500-note board', async ({ page }) => {
  await open(page, 'demo')
  await page.locator('[data-board="500"]').click()
  await page.waitForURL(/[?&]board=500/)
  await page.waitForFunction(() => window.__papertie?.ready === true)
  expect(new URL(page.url()).searchParams.get('board')).toBe('500')
  expect(await page.evaluate(() => window.__papertie.store.getState().notes.size)).toBe(500)
})
