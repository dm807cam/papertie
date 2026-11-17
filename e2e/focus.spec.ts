import { expect, type Page, test } from '@playwright/test'
import { DEMO_IDS } from '../apps/web/src/dev/demoBoard'
import type { Cam, Pt } from './hooks'

const VIEW = { width: 1280, height: 720 }
test.use({ viewport: VIEW })

const demoId = (prefix: string, n: number) => `${prefix}_01JBDEM0${String(n).padStart(18, '0')}`

/** The print: on the 3-note thread with the hub, which three more threads leave. */
const PRINT = DEMO_IDS.print
const HUB = DEMO_IDS.hub
/** On the hub's 2-note indigo thread: one step past the print's focus. */
const KNOT = DEMO_IDS.knot
const HUB_JP_YARN = demoId('yarn', 2)
/** On a thread of its own, with nothing of the hub's: never in the print's network. */
const CROSSED_LEFT = demoId('note', 8)
/** Where the test notes lie (not the mockup composition the demo opens on). */
const TEST_CAM: Cam = { x: 0, y: 0, zoom: 0.5 }

async function open(page: Page, hash = '') {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await page.goto(`/bench?board=demo${hash}`)
  await page.waitForFunction(() => window.__papertie?.ready === true)
  return errors
}

/** Nothing moving: no frame queued, the camera still and no focus fade under way. */
const settled = (page: Page) =>
  page.waitForFunction(() => {
    const rt = window.__papertie.runtime
    return !rt.loop.running && !rt.camera.moving && (rt.focusPaint?.fade ?? null) === null
  })

const chip = (page: Page) => page.getByRole('toolbar', { name: 'Focus' })

/** Whether a note is out of view: not mounted, or mounted inert and hidden from assistive tech. */
const hiddenNote = (page: Page, id: string) =>
  page.evaluate((id) => {
    const el = document.querySelector<HTMLElement>(`article[data-note-id="${id}"]`)
    return el === null || (el.inert && el.getAttribute('aria-hidden') === 'true')
  }, id)

const shownNote = (page: Page, id: string) =>
  page.evaluate((id) => {
    const el = document.querySelector<HTMLElement>(`article[data-note-id="${id}"]`)
    return el !== null && !el.inert && !el.hasAttribute('aria-hidden')
  }, id)

const centreWorld = (page: Page, id: string) =>
  page.evaluate((id) => {
    const n = window.__papertie.store.getState().notes.get(id)
    if (n === undefined) throw new Error(`no note ${id}`)
    return { x: n.x + n.w / 2, y: n.y + n.h / 2 }
  }, id)

async function focusPrint(page: Page) {
  await page.evaluate((id) => window.__papertie.runtime.selectNote(id), PRINT)
  await page.keyboard.press('f')
  await expect(chip(page)).toContainText('Focus · 1 step')
  await settled(page)
}

test('F focuses the selection: the rest fades out, inert, hidden and not hit-testable', async ({
  page,
}) => {
  const errors = await open(page)
  await page.evaluate((c) => window.__papertie.debug.setCamera(c), TEST_CAM)
  await settled(page)
  const commits = await page.evaluate(() => window.__papertie.store.commits)
  await focusPrint(page)

  expect(await page.evaluate(() => window.__papertie.runtime.focusState)).toEqual({
    seeds: [PRINT],
    depth: 1,
    include: [],
  })
  expect(await shownNote(page, HUB)).toBe(true)
  expect(await hiddenNote(page, KNOT)).toBe(true)
  expect(await hiddenNote(page, CROSSED_LEFT)).toBe(true)
  // No tool finds a hidden note by place.
  const world = await centreWorld(page, CROSSED_LEFT)
  expect(await page.evaluate((w) => window.__papertie.debug.noteAt(w), world)).toBeUndefined()
  // Focus is in the URL, never on the board.
  expect(new URL(page.url()).hash).toBe(`#focus=${PRINT}&d=1`)
  expect(await page.evaluate(() => window.__papertie.store.commits)).toBe(commits)
  expect(errors).toEqual([])
})

test('a loose end expands the focus one step', async ({ page }) => {
  const errors = await open(page)
  await focusPrint(page)
  const commits = await page.evaluate(() => window.__papertie.store.commits)
  // The hub's indigo thread leads to the hidden KNOT note: its loose end hangs from the hub's edge pin.
  const stub = await page.evaluate(
    (id) => window.__papertie.debug.yarnProbe(id, 0, 0.02, 0),
    HUB_JP_YARN,
  )
  if (stub === undefined) throw new Error('no curve for the indigo thread')
  expect(await page.evaluate((p) => window.__papertie.runtime.looseEndAt(p), stub)).toMatchObject({
    yarnId: HUB_JP_YARN,
    noteId: HUB,
    toward: KNOT,
  })
  await page.mouse.move(stub.x, stub.y)
  await expect(page.locator('main.viewport[data-loose]')).toHaveCount(1)
  await page.mouse.click(stub.x, stub.y)
  await expect(chip(page)).toContainText('Focus · 2 steps')
  await settled(page)
  expect(await shownNote(page, KNOT)).toBe(true)
  expect(await hiddenNote(page, CROSSED_LEFT)).toBe(true)
  // The click made no note on what reads as cork.
  expect(await page.evaluate(() => window.__papertie.store.commits)).toBe(commits)
  expect(errors).toEqual([])
})

test('the chip steps the depth; Esc leaves writing, then focus, then the selection', async ({
  page,
}) => {
  const errors = await open(page)
  await page.evaluate((c) => window.__papertie.debug.setCamera(c), TEST_CAM)
  await settled(page)
  const camera = await page.evaluate(() => window.__papertie.debug.camera())
  await focusPrint(page)

  const fewer = chip(page).getByRole('button', { name: 'Fewer steps' })
  await expect(fewer).toHaveAttribute('aria-disabled', 'true')
  await chip(page).getByRole('button', { name: 'More steps' }).click()
  await expect(chip(page)).toContainText('Focus · 2 steps')
  await chip(page).getByRole('button', { name: 'All' }).click()
  await expect(chip(page).getByRole('button', { name: 'All' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await fewer.click()
  await expect(chip(page)).toContainText('Focus · 3 steps')
  expect(new URL(page.url()).hash).toBe(`#focus=${PRINT}&d=3`)
  await settled(page)

  // Writing takes the first Esc; focus the next; the selection the last.
  await page.evaluate((id) => window.__papertie.runtime.startEditing(id), HUB)
  await page.waitForFunction(() => document.activeElement?.closest('.note-edit') !== null)
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => window.__papertie.runtime.editing === null)
  expect(await page.evaluate(() => window.__papertie.runtime.focusState)).not.toBeNull()
  await page.keyboard.press('Escape')
  await expect(chip(page)).toHaveCount(0)
  expect(await page.evaluate(() => [...window.__papertie.runtime.selection])).toEqual([HUB])
  await settled(page)

  // The whole board is back, where the camera was before focus.
  const back = await page.evaluate(() => window.__papertie.debug.camera())
  expect(back.x).toBeCloseTo(camera.x, 3)
  expect(back.y).toBeCloseTo(camera.y, 3)
  expect(back.zoom).toBeCloseTo(camera.zoom, 5)
  await expect(page.locator('article.note[aria-hidden], article.note[inert]')).toHaveCount(0)
  expect(await shownNote(page, CROSSED_LEFT)).toBe(true)
  expect(new URL(page.url()).hash).toBe('')
  await page.keyboard.press('Escape')
  expect(await page.evaluate(() => window.__papertie.runtime.selection.size)).toBe(0)
  expect(errors).toEqual([])
})

test('Bring in… adds a note to the focus without its thread', async ({ page }) => {
  const errors = await open(page)
  await focusPrint(page)
  await chip(page).getByRole('button', { name: 'Bring in…' }).click()
  // By name: the bench route's dev strip has selects (comboboxes, with options) of its own.
  const picker = page.getByRole('dialog', { name: 'Bring into focus' })
  const field = picker.getByRole('combobox')
  await expect(field).toBeFocused()
  await field.fill('Crossed, left')
  await expect(picker.getByRole('option').first()).toContainText('Crossed, left')
  await field.press('Enter')
  await expect
    .poll(() => page.evaluate(() => window.__papertie.runtime.focusState?.include))
    .toEqual([CROSSED_LEFT])
  await field.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(chip(page).getByRole('button', { name: 'Bring in…' })).toBeFocused()
  await settled(page)
  expect(await shownNote(page, CROSSED_LEFT)).toBe(true)
  // Its thread's other note stays out: a note brought in is never expanded from.
  expect(await hiddenNote(page, demoId('note', 9))).toBe(true)
  expect(new URL(page.url()).hash).toBe(`#focus=${PRINT}&d=1&in=${CROSSED_LEFT}`)
  expect(errors).toEqual([])
})

test('reload restores the focus from the hash, with no fade', async ({ page }) => {
  const errors = await open(page, `#focus=${PRINT}&d=2`)
  await expect(chip(page)).toContainText('Focus · 2 steps')
  expect(await page.evaluate(() => window.__papertie.runtime.focusPaint?.fade ?? null)).toBeNull()
  await settled(page)
  expect(await shownNote(page, KNOT)).toBe(true)
  expect(await hiddenNote(page, CROSSED_LEFT)).toBe(true)
  await page.reload()
  await page.waitForFunction(() => window.__papertie?.ready === true)
  await expect(chip(page)).toContainText('Focus · 2 steps')
  expect(errors).toEqual([])
})

test('hidden yarn is gone from the yarn layer and back after focus', async ({ page }) => {
  const errors = await open(page)
  await focusPrint(page)
  // Look at the crossed thread, between two hidden notes.
  await page.evaluate((c) => window.__papertie.debug.setCamera(c), { x: -100, y: 800, zoom: 1 })
  await settled(page)
  const mid = await page.evaluate(
    (id) => window.__papertie.debug.yarnPointScreen(id, 0, 0.5),
    DEMO_IDS.crossed,
  )
  if (mid === undefined) throw new Error('no curve for crossed')
  const inkAt = (p: Pt) =>
    page.evaluate((p) => {
      const c = document.querySelector('canvas.yarn-layer') as HTMLCanvasElement
      const ctx = c.getContext('2d') as CanvasRenderingContext2D
      const d = devicePixelRatio
      return ctx.getImageData(Math.floor(p.x * d), Math.floor(p.y * d), 1, 1).data[3] ?? 0
    }, p)
  expect(await inkAt(mid)).toBe(0)
  await page.keyboard.press('Escape')
  await settled(page)
  // The camera went back to where it was before focus: look at the thread again.
  await page.evaluate((c) => window.__papertie.debug.setCamera(c), { x: -100, y: 800, zoom: 1 })
  await settled(page)
  expect(await inkAt(mid)).toBeGreaterThan(0)
  expect(errors).toEqual([])
})

test('on a phone the chip, the notice slips, the mini-bar and its save dot keep clear', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 })
  const errors = await open(page)
  await focusPrint(page)
  // What a server board adds (bench boards have neither): the save dot in its slot at the pill's
  // end (MiniBar), and a notice slip.
  await page.evaluate(() => {
    const foot = document.createElement('div')
    foot.className = 'minibar-foot'
    foot.innerHTML = '<span class="save-dot" style="display:block"></span>'
    document.querySelector('.minibar-tools')?.append(foot)
    const notices = document.createElement('div')
    notices.className = 'sync-notices'
    notices.innerHTML = '<div class="sync-paper" style="height:48px">slip</div>'
    document.querySelector('.viewport > .ui')?.append(notices)
  })
  // The slips rise above the chip by their eased translate.
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector('.sync-notices') as Element).translate ===
      '0px -56px',
  )
  await page.waitForTimeout(400)
  const boxes = await page.evaluate(() =>
    ['.focus-chip', '.sync-notices > .sync-paper', '.minibar', '.minibar-foot'].map((sel) => {
      const r = (document.querySelector(sel) as Element).getBoundingClientRect()
      return { sel, l: r.left, r: r.right, t: r.top, b: r.bottom }
    }),
  )
  // The dot is in the pill, never out on the board.
  const pill = boxes.find((b) => b.sel === '.minibar')
  const dot = boxes.find((b) => b.sel === '.minibar-foot')
  if (!pill || !dot) throw new Error('no mini-bar')
  expect(dot.t).toBeGreaterThanOrEqual(pill.t)
  expect(dot.b).toBeLessThanOrEqual(pill.b)
  for (const a of boxes) {
    expect(a.l).toBeGreaterThanOrEqual(0)
    expect(a.r).toBeLessThanOrEqual(375)
    for (const b of boxes) {
      if (a === b || (a.sel === '.minibar' && b.sel === '.minibar-foot')) continue
      if (a.sel === '.minibar-foot' && b.sel === '.minibar') continue
      const meet = a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b
      expect(meet, `${a.sel} meets ${b.sel}`).toBe(false)
    }
  }
  expect(errors).toEqual([])
})

/** The shown notes' papers on screen, the chrome's edges and the camera, once focus has settled. */
const framing = (page: Page) =>
  page.evaluate(() => {
    const notes = [
      ...document.querySelectorAll<HTMLElement>('article.note:not([inert]) .note-paper'),
    ]
      .map((el) => el.getBoundingClientRect())
      .map((r) => ({ l: r.left, r: r.right, t: r.top, b: r.bottom }))
    const tools = document
      .querySelector('[role="toolbar"][aria-label="Tools"]')
      ?.getBoundingClientRect()
    const chip = document.querySelector('.focus-chip')?.getBoundingClientRect()
    return {
      notes,
      tools: tools && { r: tools.right, t: tools.top },
      chipTop: chip?.top ?? innerHeight,
      zoom: window.__papertie.debug.camera().zoom,
      lod: window.__papertie.debug.lod(),
    }
  })

test('focus frames its notes clear of the sidebar and the chip, at no more than reading zoom', async ({
  page,
}) => {
  const errors = await open(page)
  await page.evaluate((c) => window.__papertie.debug.setCamera(c), TEST_CAM)
  await settled(page)
  await focusPrint(page)
  const f = await framing(page)
  expect(f.notes.length).toBeGreaterThan(0)
  for (const n of f.notes) {
    expect(n.l).toBeGreaterThanOrEqual((f.tools?.r ?? 0) + 8)
    expect(n.b).toBeLessThanOrEqual(f.chipTop - 8)
  }
  expect(f.zoom).toBeLessThanOrEqual(1)
  expect(f.lod).toBe('full')
  expect(errors).toEqual([])
})

test('on a phone, focus keeps its notes at full detail, the focused one in view above the chip', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 })
  const errors = await open(page)
  await page.evaluate((c) => window.__papertie.debug.setCamera(c), TEST_CAM)
  await settled(page)
  await focusPrint(page)
  const f = await framing(page)
  expect(f.lod).toBe('full')
  // A phone's floor is reading size for its small screen: titles about 18 px.
  expect(f.zoom).toBeGreaterThanOrEqual(0.6)
  const seed = await page.evaluate((id) => {
    const r = document
      .querySelector(`article[data-note-id="${id}"] .note-paper`)
      ?.getBoundingClientRect()
    return r && { l: r.left, r: r.right, t: r.top, b: r.bottom }
  }, PRINT)
  expect(seed).toBeDefined()
  expect(seed?.l ?? -1).toBeGreaterThanOrEqual(0)
  expect(seed?.r ?? 1e9).toBeLessThanOrEqual(375)
  expect(seed?.t ?? -1).toBeGreaterThanOrEqual(0)
  expect(seed?.b ?? 1e9).toBeLessThanOrEqual(f.chipTop - 8)
  // The focused note is centred across the screen; the rest may run off it, cords showing.
  expect(Math.abs(((seed?.l ?? 0) + (seed?.r ?? 0)) / 2 - 375 / 2)).toBeLessThan(24)
  expect(errors).toEqual([])
})
