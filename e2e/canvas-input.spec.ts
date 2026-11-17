import { expect, type Page, test } from '@playwright/test'
import { DEMO_IDS } from '../apps/web/src/dev/demoBoard'
import type { Cam, Pt } from './hooks'
import { armYarn } from './yarnTool'

const VIEW = { width: 1280, height: 720 }
test.use({ viewport: VIEW })

const HUB = DEMO_IDS.hub
/** The hub's centre in world px (x 1040, y 560, 280 × 200). */
const HUB_CENTRE = { x: 1180, y: 660 }
const HUB_CAM: Cam = {
  x: HUB_CENTRE.x - VIEW.width / 2,
  y: HUB_CENTRE.y - VIEW.height / 2,
  zoom: 1,
}
/** The whole demo board at zoom 0.5. */
const BOARD_CAM: Cam = { x: 0, y: 0, zoom: 0.5 }
/** Not on any thread from the hub. */
const LONE = `note_01JBDEM0${'13'.padStart(18, '0')}`

async function open(page: Page, cam: Cam = HUB_CAM) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await page.goto('/bench?board=demo')
  await page.waitForFunction(() => window.__papertie?.ready === true)
  await page.evaluate((c) => window.__papertie.debug.setCamera(c), cam)
  await idle(page)
  // The pointer id of the latest press, for synthetic follow-up events.
  await page.evaluate(() => {
    const w = window as unknown as { __pid?: number }
    document
      .querySelector('.viewport')
      ?.addEventListener('pointerdown', (e) => (w.__pid = (e as PointerEvent).pointerId), true)
  })
  return errors
}

const idle = (page: Page) =>
  page.waitForFunction(() => window.__papertie.runtime.loop.running === false)

const note = (page: Page, id = HUB) =>
  page.evaluate((id) => {
    const n = window.__papertie.store.getState().notes.get(id)
    if (n === undefined) throw new Error(`no note ${id}`)
    return { x: n.x, y: n.y, w: n.w, h: n.h, z: n.z }
  }, id)

const commits = (page: Page) => page.evaluate(() => window.__papertie.store.commits)
const yarnCount = (page: Page) => page.evaluate(() => window.__papertie.store.getState().yarns.size)
const camera = (page: Page) => page.evaluate(() => window.__papertie.debug.camera())
const noteEl = (page: Page, id = HUB) => page.locator(`article.note[data-note-id="${id}"]`)
const handle = (page: Page, h: string, id = HUB) =>
  page.locator(`.overlay .selection[data-note-id="${id}"] [data-handle="${h}"]`)
const root = (page: Page) => page.locator('.viewport')

async function box(page: Page, id = HUB) {
  const b = await noteEl(page, id).boundingBox()
  if (b === null) throw new Error(`note ${id} has no box`)
  return b
}

async function centre(page: Page, h: string): Promise<Pt> {
  const b = await handle(page, h).boundingBox()
  if (b === null) throw new Error(`no ${h} handle`)
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}

/** A point on the note's paper, below its pin and threads. */
async function grabPoint(page: Page, id = HUB): Promise<Pt> {
  const b = await box(page, id)
  return { x: b.x + b.width / 2, y: b.y + b.height * 0.7 }
}

/** Whether the root still holds the latest press's pointer capture. */
const rootHasCapture = (page: Page) =>
  page.evaluate(() => {
    const id = (window as unknown as { __pid: number }).__pid
    return (document.querySelector('.viewport') as HTMLElement).hasPointerCapture(id)
  })

/** Start dragging the hub by (+120, +30) and wait until its DOM node follows. */
async function startDrag(page: Page) {
  const box0 = await box(page)
  const p = await grabPoint(page)
  await page.mouse.move(p.x, p.y)
  await page.mouse.down()
  await page.mouse.move(p.x + 120, p.y + 30, { steps: 12 })
  await expect.poll(async () => (await box(page)).x - box0.x).toBeCloseTo(120, 0)
  return { box0, p }
}

/** The hub's pin as a press point, and a release point on a note it has no thread to. */
async function connectPoints(page: Page) {
  const pin = await page.evaluate((id) => window.__papertie.debug.pinScreen(id), HUB)
  if (pin === undefined) throw new Error('no hub pin')
  expect(await page.evaluate((p) => window.__papertie.debug.hitAt(p), pin)).toEqual({
    kind: 'pin',
    noteId: HUB,
  })
  return { pin, drop: await grabPoint(page, LONE) }
}

test('I1: the s handle of a note drawn taller than its h grows from the drawn height', async ({
  page,
}) => {
  const errors = await open(page)
  await page.mouse.click(...xy(await grabPoint(page)))
  await expect(handle(page, 's')).toBeVisible()
  // Shrink the stored h well below the text: the paper stays at its content height.
  const s0 = await centre(page, 's')
  await page.mouse.move(s0.x, s0.y)
  await page.mouse.down()
  await page.mouse.move(s0.x, s0.y - 190, { steps: 10 })
  await page.mouse.up()
  await idle(page)
  const shrunk = await note(page)
  const drawn = await noteEl(page).evaluate((el) => (el as HTMLElement).offsetHeight)
  expect(shrunk.h).toBeLessThan(drawn - 10)

  const s1 = await centre(page, 's')
  const c0 = await commits(page)
  await page.mouse.move(s1.x, s1.y)
  await page.mouse.down()
  await page.mouse.move(s1.x, s1.y + 20, { steps: 5 })
  // No dead zone: the paper and the handle follow the pointer from the first pixels.
  await expect
    .poll(() => noteEl(page).evaluate((el) => (el as HTMLElement).offsetHeight))
    .toBe(drawn + 20)
  expect((await centre(page, 's')).y).toBeCloseTo(s1.y + 20, 0)
  await page.mouse.up()
  await expect.poll(() => commits(page)).toBe(c0 + 1)
  expect(await note(page)).toMatchObject({ ...shrunk, h: drawn + 20 })
  expect(errors).toEqual([])
})

for (const how of ['contextmenu', 'blur', 'hidden', 'released mouse'] as const) {
  test(`I2: ${how} mid-drag cancels it; the stray release and the next click commit nothing`, async ({
    page,
  }) => {
    const errors = await open(page)
    const before = await note(page)
    const c0 = await commits(page)
    const { box0, p } = await startDrag(page)

    await page.evaluate(
      ({ how, at }) => {
        const el = document.querySelector('.viewport') as HTMLElement
        const pointerId = (window as unknown as { __pid: number }).__pid
        if (how === 'contextmenu') {
          // What macOS Ctrl+click sends on mousedown; the menu then takes the mouseup.
          el.dispatchEvent(
            new MouseEvent('contextmenu', { bubbles: true, cancelable: true, ...at, button: 2 }),
          )
        } else if (how === 'blur') window.dispatchEvent(new Event('blur'))
        else if (how === 'hidden') {
          Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            get: () => 'hidden',
          })
          document.dispatchEvent(new Event('visibilitychange'))
          delete (document as unknown as { visibilityState?: string }).visibilityState
        } else {
          // The button came up where the page could not see it.
          el.dispatchEvent(
            new PointerEvent('pointermove', {
              bubbles: true,
              pointerId,
              pointerType: 'mouse',
              buttons: 0,
              ...at,
            }),
          )
        }
      },
      { how, at: { clientX: p.x + 140, clientY: p.y + 30 } },
    )
    await expect.poll(async () => (await box(page)).x).toBeCloseTo(box0.x, 0)
    expect(await rootHasCapture(page)).toBe(false)

    // The rest of the old gesture, then a click on cork: nothing commits, nothing moves.
    await page.mouse.move(p.x + 260, p.y + 80, { steps: 5 })
    await page.mouse.up()
    await page.mouse.click(40, 700)
    await idle(page)
    expect((await box(page)).x).toBeCloseTo(box0.x, 0)
    expect(await commits(page)).toBe(c0)
    expect(await note(page)).toEqual(before)

    // And the next drag works normally.
    const q = await grabPoint(page)
    await page.mouse.move(q.x, q.y)
    await page.mouse.down()
    await page.mouse.move(q.x + 50, q.y, { steps: 5 })
    await page.mouse.up()
    await expect.poll(() => commits(page)).toBe(c0 + 1)
    expect((await note(page)).x).toBe(before.x + 50)
    expect(errors).toEqual([])
  })
}

for (const how of ['contextmenu', 'released mouse'] as const) {
  test(`I2: ${how} mid-connect drops the live thread; the release creates no yarn`, async ({
    page,
  }) => {
    const errors = await open(page, BOARD_CAM)
    const { pin, drop } = await connectPoints(page)
    const y0 = await yarnCount(page)
    const c0 = await commits(page)
    // The Yarn tool ties from a pin.
    await armYarn(page)
    await page.mouse.move(pin.x, pin.y)
    await page.mouse.down()
    await page.mouse.move((pin.x + drop.x) / 2, (pin.y + drop.y) / 2, { steps: 8 })
    await expect(root(page)).toHaveAttribute('data-hover', 'pin')
    await page.evaluate(
      ({ how, at }) => {
        const el = document.querySelector('.viewport') as HTMLElement
        const pointerId = (window as unknown as { __pid: number }).__pid
        const init = { bubbles: true, cancelable: true, ...at }
        if (how === 'contextmenu') el.dispatchEvent(new MouseEvent('contextmenu', init))
        else
          el.dispatchEvent(
            new PointerEvent('pointermove', {
              ...init,
              pointerId,
              pointerType: 'mouse',
              buttons: 0,
            }),
          )
      },
      { how, at: { clientX: drop.x, clientY: drop.y } },
    )
    expect(await rootHasCapture(page)).toBe(false)
    await expect(root(page)).not.toHaveAttribute('data-hover', 'pin')
    await page.mouse.move(drop.x, drop.y, { steps: 5 })
    await page.mouse.up()
    await page.mouse.click(drop.x, drop.y)
    await idle(page)
    expect(await yarnCount(page)).toBe(y0)
    expect(await commits(page)).toBe(c0)
    expect(errors).toEqual([])
  })
}

test('I2: window blur mid-pan ends the pan; later moves leave the camera alone', async ({
  page,
}) => {
  const errors = await open(page)
  await page.mouse.move(640, 400)
  await page.mouse.down({ button: 'middle' })
  await page.mouse.move(600, 380, { steps: 4 })
  await expect(root(page)).toHaveAttribute('data-panning', '')
  await page.evaluate(() => window.dispatchEvent(new Event('blur')))
  await expect(root(page)).not.toHaveAttribute('data-panning', '')
  const c = await camera(page)
  await page.mouse.move(500, 300, { steps: 4 })
  await idle(page)
  expect(await camera(page)).toEqual(c)
  await page.mouse.up({ button: 'middle' })
  expect(errors).toEqual([])
})

test('M2: a yarn crossing a selection handle does not take the press; the handle resizes', async ({
  page,
}) => {
  const errors = await open(page, BOARD_CAM)
  // A thread not tied to the hub, at a point on screen.
  const target = await page.evaluate((hub) => {
    const h = window.__papertie
    for (const [id, y] of h.store.getState().yarns) {
      if (y.noteIds.includes(hub)) continue
      const p = h.debug.yarnPointScreen(id, 0, 0.5)
      if (p && p.x > 300 && p.x < 1100 && p.y > 200 && p.y < 650) return p
    }
    return null
  }, HUB)
  if (target === null) throw new Error('no free thread on screen')

  // Select the hub and drop it so its se handle sits on that thread.
  await page.mouse.click(...xy(await grabPoint(page)))
  await expect(handle(page, 'se')).toBeVisible()
  const se0 = await centre(page, 'se')
  const g = await grabPoint(page)
  await page.mouse.move(g.x, g.y)
  await page.mouse.down()
  await page.mouse.move(g.x + target.x - se0.x, g.y + target.y - se0.y, { steps: 12 })
  await page.mouse.up()
  await idle(page)
  const at = await centre(page, 'se')
  expect((await page.evaluate((p) => window.__papertie.debug.hitAt(p), at)).kind).toBe('yarn')

  const before = await note(page)
  const c0 = await commits(page)
  await page.mouse.move(at.x, at.y)
  await page.mouse.down()
  await page.mouse.move(at.x + 30, at.y + 20, { steps: 6 })
  await page.mouse.up()
  await expect.poll(() => commits(page)).toBe(c0 + 1)
  expect(await note(page)).toMatchObject({ x: before.x, y: before.y, w: before.w + 60 })
  expect(await page.evaluate(() => [...window.__papertie.runtime.selection])).toEqual([HUB])
  expect(await page.evaluate(() => window.__papertie.debug.selectedYarn())).toBeUndefined()
  expect(errors).toEqual([])
})

test('M3: a wheel pan mid-drag keeps the note under the still pointer', async ({ page }) => {
  const errors = await open(page)
  const before = await note(page)
  await startDrag(page)
  const held = await box(page)
  const c0 = await camera(page)
  for (let i = 0; i < 4; i++) await page.mouse.wheel(40, 60)
  await expect.poll(async () => (await camera(page)).y).toBeGreaterThan(c0.y)
  await idle(page)
  const panned = await camera(page)
  // The pointer has not moved: neither has the note on screen.
  const b = await box(page)
  expect(b.x).toBeCloseTo(held.x, 0)
  expect(b.y).toBeCloseTo(held.y, 0)
  await page.mouse.up()
  await idle(page)
  const after = await note(page)
  expect(after.x).toBe(before.x + 120 + Math.round(panned.x - c0.x))
  expect(after.y).toBe(before.y + 30 + Math.round(panned.y - c0.y))
  expect(errors).toEqual([])
})

test('M4: tool keys and Space leave a focused select alone; = still zooms', async ({ page }) => {
  const errors = await open(page)
  const canvas = page.getByTestId('canvas')
  await expect(canvas).toHaveAttribute('data-tool', 'select')
  const layer = page.getByLabel('Yarn layer')
  await layer.focus()
  for (const k of ['v', 'y']) await page.keyboard.press(k)
  await expect(canvas).toHaveAttribute('data-tool', 'select')
  await expect(layer).toHaveValue('over')
  const z0 = (await camera(page)).zoom
  await page.keyboard.press('=')
  await expect.poll(async () => (await camera(page)).zoom).toBeCloseTo(z0 * 1.25, 9)

  // Space on a focused button presses the button, and holds no pan.
  await page.locator('.sidebar [data-tool="select"]').focus()
  await page.keyboard.down(' ')
  await expect(root(page)).not.toHaveAttribute('data-space', '')
  await page.keyboard.up(' ')
  // A letter still switches tools there: a click leaves the focus on the sidebar button.
  await armYarn(page)
  await expect(canvas).toHaveAttribute('data-tool', 'yarn')

  // On the canvas, Space held makes a drag pan.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.down(' ')
  await expect(root(page)).toHaveAttribute('data-space', '')
  await page.keyboard.up(' ')
  expect(errors).toEqual([])
})

test('M5: after a click on the tilt checkbox, tool keys and = / - still work; Space toggles it', async ({
  page,
}) => {
  const errors = await open(page)
  const canvas = page.getByTestId('canvas')
  const tilt = page.getByLabel('Paper rotation')
  await tilt.click()
  await expect(tilt).toBeFocused()
  await expect(tilt).not.toBeChecked()
  const z0 = (await camera(page)).zoom
  await page.keyboard.press('=')
  await expect.poll(async () => (await camera(page)).zoom).toBeCloseTo(z0 * 1.25, 9)
  await page.keyboard.press('-')
  await expect.poll(async () => (await camera(page)).zoom).toBeCloseTo(z0, 9)
  // Space is the checkbox's own: it toggles the tilt back on and holds no pan.
  await page.keyboard.down(' ')
  await expect(root(page)).not.toHaveAttribute('data-space', '')
  await page.keyboard.up(' ')
  await expect(tilt).toBeChecked()
  await expect(tilt).toBeFocused()
  // The tool keys work from there too (Y by Yarn's colour picker, which takes the focus).
  await armYarn(page)
  await expect(canvas).toHaveAttribute('data-tool', 'yarn')
  await page.keyboard.press('v')
  await expect(canvas).toHaveAttribute('data-tool', 'select')
  expect(errors).toEqual([])
})

const xy = (p: Pt): [number, number] => [p.x, p.y]
