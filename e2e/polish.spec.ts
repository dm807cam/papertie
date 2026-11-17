import path from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { DEMO_MOCKUP } from '../apps/web/src/dev/demoBoard'
import { CORK_FINE_RAMP } from '../tools/src/textures/cork'
import type { Cam, Pt } from './hooks'

/** The size the screenshots are taken at. */
const VIEW = { width: 1672, height: 941 }
test.use({ viewport: VIEW, deviceScaleFactor: 1 })

const ART = path.join(__dirname, 'artifacts')

async function open(page: Page, board: string) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await page.goto(`/bench?board=${board}`)
  await page.waitForFunction(() => window.__papertie?.ready === true)
  await settle(page)
  return errors
}

/** The loop idle, two more frames, every image decoded and the fonts in. */
async function settle(page: Page) {
  await page.waitForFunction(() => window.__papertie.runtime.loop.running === false)
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.all([...document.images].map((i) => i.decode().catch(() => undefined)))
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  })
}

const setCamera = async (page: Page, c: Cam) => {
  await page.evaluate((c) => window.__papertie.debug.setCamera(c), c)
  await settle(page)
}

/** The camera at `zoom` with world point `w` at the viewport centre. */
const centredOn = (w: Pt, zoom: number): Cam => ({
  x: w.x - VIEW.width / 2 / zoom,
  y: w.y - VIEW.height / 2 / zoom,
  zoom,
})

/** A screenshot once the compositor has caught up with the last camera change. */
async function stableShot(page: Page, file?: string): Promise<Buffer> {
  let last = await page.screenshot()
  let same = 1
  for (let k = 0; k < 30 && same < 2; k++) {
    await page.waitForTimeout(100)
    const next = await page.screenshot()
    same = next.equals(last) ? same + 1 : 1
    last = next
  }
  if (file !== undefined) await page.screenshot({ path: path.join(ART, file) })
  return last
}

/** The world centre of a note's rect. */
const noteCentre = (page: Page, id: string) =>
  page.evaluate((id) => {
    const n = window.__papertie.store.getState().notes.get(id)
    if (n === undefined) throw new Error(`no ${id}`)
    return { x: n.x + n.w / 2, y: n.y + n.h / 2 }
  }, id)

/** WCAG relative luminance of an sRGB colour, 0-255 channels. */
const luminance = ([r, g, b]: number[]) => {
  const c = (v: number) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * c(r ?? 0) + 0.7152 * c(g ?? 0) + 0.0722 * c(b ?? 0)
}

const contrast = (a: number[], b: number[]) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** RGB of screenshot pixels at viewport points (decoded in the page: no PNG decoder in Node). */
const pixels = (page: Page, shot: Buffer, pts: Pt[]): Promise<number[][]> =>
  page.evaluate(
    async ({ b64, pts }) => {
      const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob()
      const bmp = await createImageBitmap(blob)
      const c = new OffscreenCanvas(bmp.width, bmp.height)
      const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D
      ctx.drawImage(bmp, 0, 0)
      return pts.map((p) => [...ctx.getImageData(Math.round(p.x), Math.round(p.y), 1, 1).data])
    },
    { b64: shot.toString('base64'), pts },
  )

/** Column and row luma profiles of a screenshot: mean |difference| across each pixel boundary. */
const seamProfile = (page: Page, shot: Buffer) =>
  page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob()
    const bmp = await createImageBitmap(blob)
    const c = new OffscreenCanvas(bmp.width, bmp.height)
    const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D
    ctx.drawImage(bmp, 0, 0)
    const { data, width: w, height: h } = ctx.getImageData(0, 0, bmp.width, bmp.height)
    const L = (x: number, y: number) => {
      const i = 4 * (y * w + x)
      return 0.299 * (data[i] ?? 0) + 0.587 * (data[i + 1] ?? 0) + 0.114 * (data[i + 2] ?? 0)
    }
    const cols: number[] = []
    for (let x = 1; x < w; x++) {
      let s = 0
      for (let y = 0; y < h; y++) s += Math.abs(L(x, y) - L(x - 1, y))
      cols.push(s / h)
    }
    const rows: number[] = []
    for (let y = 1; y < h; y++) {
      let s = 0
      for (let x = 0; x < w; x++) s += Math.abs(L(x, y) - L(x, y - 1))
      rows.push(s / w)
    }
    const median = (a: number[]) => [...a].sort((p, q) => p - q)[Math.floor(a.length / 2)] ?? 0
    return {
      colMax: Math.max(...cols),
      colMedian: median(cols),
      rowMax: Math.max(...rows),
      rowMedian: median(rows),
    }
  }, shot.toString('base64'))

test('screenshots at zoom 0.1, 0.35, 1 and 2 and in overview', async ({ page, browser }) => {
  test.setTimeout(120_000)
  const errors = await open(page, 'demo')
  // Zoom 1 is the demo's own 1:1 framing.
  await stableShot(page, 'polish-1.png')
  const hub = await noteCentre(page, DEMO_MOCKUP.centre)
  await setCamera(page, centredOn(hub, 0.35))
  expect(await page.evaluate(() => window.__papertie.debug.lod())).toBe('full')
  await stableShot(page, 'polish-0.35.png')
  // Zoom 2 on the crimson thread and the materials sheet: cord, twist, pins and paper up close.
  const materials = await noteCentre(page, DEMO_MOCKUP.materials)
  await setCamera(page, centredOn({ x: (hub.x + materials.x) / 2, y: hub.y + 20 }, 2))
  await stableShot(page, 'polish-2.png')
  expect(errors).toEqual([])

  // 0.1 is overview: the 1,000 board, where it has something to show.
  const dense = await browser.newPage({ viewport: VIEW, deviceScaleFactor: 1 })
  const denseErrors = await open(dense, '1000')
  const rect = await dense.evaluate(() => window.__papertie.debug.notesRect())
  if (rect === null) throw new Error('empty board')
  await setCamera(dense, centredOn({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 }, 0.1))
  expect(await dense.evaluate(() => window.__papertie.debug.lod())).toBe('overview')
  await stableShot(dense, 'polish-0.1.png')
  expect(denseErrors).toEqual([])
  await dense.close()

  // The whole 5,000-note board at its fit.
  const wide = await browser.newPage({ viewport: VIEW, deviceScaleFactor: 1 })
  const wideErrors = await open(wide, '5000')
  expect(await wide.evaluate(() => window.__papertie.debug.lod())).toBe('overview')
  await stableShot(wide, 'polish-overview.png')
  expect(wideErrors).toEqual([])
  await wide.close()
})

test('selection is a graphite line with a cream halo, 3:1 on cork and paper; hover lifts', async ({
  page,
}) => {
  const errors = await open(page, 'demo')
  const id = DEMO_MOCKUP.centre
  const note = page.locator(`article.note[data-note-id="${id}"]`)
  const shadowOf = (sel: string) =>
    page.evaluate(
      (sel) => getComputedStyle(document.querySelector(sel) as Element).boxShadow,
      `${sel} .note-shadow`,
    )
  const rest = await shadowOf(`article.note[data-note-id="${id}"]`)

  // Hover with the select tool: the sheet lifts (a deeper shadow), short of the selected lift.
  const box = await note.boundingBox()
  if (box === null) throw new Error('no box')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.7)
  await settle(page)
  const hover = await shadowOf(`article.note[data-note-id="${id}"]`)
  expect(hover).not.toBe(rest)
  // Space held to pan does not lift.
  await page.keyboard.down(' ')
  expect(await shadowOf(`article.note[data-note-id="${id}"]`)).toBe(rest)
  await page.keyboard.up(' ')

  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.7)
  await settle(page)
  expect(await page.evaluate(() => [...window.__papertie.runtime.selection])).toEqual([id])
  const selected = await shadowOf(`article.note[data-note-id="${id}"]`)
  expect(selected).not.toBe(rest)
  expect(selected).not.toBe(hover)

  // Never a blue UI ring: the line is the ink colour.
  const ring = await page.evaluate(() => {
    const el = document.querySelector('.overlay > .selection') as HTMLElement
    const s = getComputedStyle(el, '::before')
    return { color: s.borderTopColor, width: s.borderTopWidth, style: s.borderTopStyle }
  })
  expect(ring.style).toBe('solid')
  // 1.5 CSS px: 3 device px at DPR 2; Chrome draws it 1 px wide at DPR 1.
  expect(Number.parseFloat(ring.width)).toBeGreaterThanOrEqual(1)
  const [r = 0, g = 0, b = 0] = (ring.color.match(/[\d.]+/g) ?? []).map(Number)
  expect(b).toBeLessThanOrEqual(Math.max(r, g))

  // Move the pointer off the note, then measure the drawn line against what it lies on.
  await page.mouse.move(VIEW.width - 40, VIEW.height - 40)
  await settle(page)
  const shot = await stableShot(page, 'polish-selected.png')
  const frame = await page.locator('.overlay > .selection').boundingBox()
  if (frame === null) throw new Error('no frame')
  // Along the bottom edge's middle third (the note's tilt is under 1.5 degrees), 2-8 px below
  // the paper: the ink line (the darkest pixel) and its cream halo (the lightest). Two tones,
  // so one of them stands at least 3:1 off whatever is next to it: ink against the paper and
  // the halo, the halo against the cork 12 px below.
  const xs = [0.4, 0.5, 0.6].map((f) => frame.x + frame.width * f)
  const bottom = frame.y + frame.height
  const byLum = (px: number[][]) => [...px].sort((a, b) => luminance(a) - luminance(b))
  const measured: string[] = []
  for (const x of xs) {
    const column = byLum(
      await pixels(
        page,
        shot,
        [2, 3, 4, 5, 6, 7, 8].map((d) => ({ x, y: bottom + d })),
      ),
    )
    const ink = column[0] ?? []
    const halo = column.at(-1) ?? []
    const [cork = [], paper = []] = await pixels(page, shot, [
      { x, y: bottom + 12 },
      { x, y: bottom - 6 },
    ])
    measured.push(
      `x ${x.toFixed(0)}: ink/paper ${contrast(ink, paper).toFixed(2)}, ink/halo ` +
        `${contrast(ink, halo).toFixed(2)}, halo/cork ${contrast(halo, cork).toFixed(2)}`,
    )
    expect.soft(contrast(ink, paper), `ink vs paper at x ${x}`).toBeGreaterThanOrEqual(3)
    expect.soft(contrast(ink, halo), `ink vs halo at x ${x}`).toBeGreaterThanOrEqual(3)
    expect.soft(contrast(halo, cork), `halo vs cork at x ${x}`).toBeGreaterThanOrEqual(3)
  }
  test.info().annotations.push({ type: 'selection contrast', description: measured.join('\n') })
  expect(errors).toEqual([])
})

test('keyboard focus shows an ink ring on the sidebar and the strip', async ({ page }) => {
  const errors = await open(page, 'demo')
  await page.keyboard.press('Tab')
  const focused = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement
    const s = getComputedStyle(el)
    return {
      inUi: el.closest('.ui') !== null,
      style: s.outlineStyle,
      width: s.outlineWidth,
      color: s.outlineColor,
    }
  })
  expect(focused.inUi).toBe(true)
  expect(focused.style).toBe('solid')
  expect(focused.width).toBe('2px')
  // The base `:focus-visible` ring is indigo's yarn dye, read from the palette vars main.tsx
  // installs on :root (the sidebar and the strip draw theirs in ink).
  const ring = await page.evaluate(() => {
    const colorOf = (v: string) => {
      const probe = document.createElement('div')
      probe.style.color = v
      document.body.append(probe)
      const c = getComputedStyle(probe).color
      probe.remove()
      return c
    }
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--yarn-indigo').trim()
    return { raw, ring: colorOf('var(--focus-ring)'), indigo: colorOf('var(--yarn-indigo)') }
  })
  expect(ring.raw).not.toBe('')
  expect(ring.ring).toBe(ring.indigo)
  const ink = (focused.color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
  // Against the panel's cream, as computed, and the light end of the cork's granule ramp.
  const panel = await page.evaluate(() => {
    const c = getComputedStyle(document.querySelector('.sidebar-sheet') as Element).backgroundColor
    const v = (c.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number)
    return c.startsWith('color(') ? v.map((x) => x * 255) : v
  })
  const light = CORK_FINE_RAMP.light
  const granule = [(light >> 16) & 255, (light >> 8) & 255, light & 255]
  expect(contrast(ink, panel)).toBeGreaterThanOrEqual(3)
  expect(contrast(ink, granule)).toBeGreaterThanOrEqual(3)
  test.info().annotations.push({
    type: 'focus contrast',
    description: `panel ${contrast(ink, panel).toFixed(2)}, granule ${contrast(ink, granule).toFixed(2)}`,
  })
  const strip = page.locator('.controls-btn[data-board="demo"]')
  await strip.focus()
  await page.keyboard.press('Tab')
  expect(
    await page.evaluate(() => getComputedStyle(document.activeElement as Element).outlineStyle),
  ).toBe('solid')
  expect(errors).toEqual([])
})

test('the empty board shows a pinned hint card; a drag through it pans, "+" replaces it', async ({
  page,
}) => {
  const errors = await open(page, 'empty')
  const hint = page.getByTestId('empty-hint')
  await expect(hint).toBeVisible()
  await expect(hint).toContainText('Press + to pin a thought')
  expect(await page.evaluate(() => window.__papertie.store.getState().notes.size)).toBe(0)
  const box = await hint.boundingBox()
  if (box === null) throw new Error('no box')
  // Centred in the view, and it lets presses through to the board.
  expect(Math.abs(box.x + box.width / 2 - VIEW.width / 2)).toBeLessThan(4)
  expect(Math.abs(box.y + box.height / 2 - VIEW.height / 2)).toBeLessThan(4)
  expect(await hint.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none')
  await stableShot(page, 'polish-empty.png')

  const c0 = await page.evaluate(() => window.__papertie.debug.camera())
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 4 })
  await page.mouse.up()
  await settle(page)
  expect((await page.evaluate(() => window.__papertie.debug.camera())).x).toBeCloseTo(
    c0.x - 60 / c0.zoom,
    6,
  )
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2)
  expect(await page.evaluate(() => window.__papertie.store.getState().notes.size)).toBe(0)

  await page.getByRole('button', { name: 'New note' }).click()
  await page.getByRole('dialog', { name: 'New note' }).press('Enter')
  await settle(page)
  expect(await page.evaluate(() => window.__papertie.store.getState().notes.size)).toBe(1)
  await expect(hint).toHaveCount(0)
  expect(errors).toEqual([])
})

test('the cork shows no seam or gap at zoom 0.02, 0.1, 0.35, 1 and 2', async ({ page }) => {
  test.setTimeout(120_000)
  const errors = await open(page, 'empty')
  await page.addStyleTag({ content: '.viewport > :not(.cork) { visibility: hidden !important }' })
  const rows: string[] = []
  for (const zoom of [0.02, 0.1, 0.35, 1, 2]) {
    // Sub-pixel offsets, so tile edges land between device pixels too.
    await setCamera(page, { x: -1234.37 / zoom, y: 987.61 / zoom, zoom })
    const p = await seamProfile(page, await stableShot(page))
    rows.push(
      `zoom ${zoom}: columns max ${p.colMax.toFixed(2)} median ${p.colMedian.toFixed(2)}, ` +
        `rows max ${p.rowMax.toFixed(2)} median ${p.rowMedian.toFixed(2)}`,
    )
    // A seam or gap is one pixel boundary across the whole view far busier than the grain.
    expect.soft(p.colMax, `zoom ${zoom} columns`).toBeLessThan(2 * p.colMedian + 2)
    expect.soft(p.rowMax, `zoom ${zoom} rows`).toBeLessThan(2 * p.rowMedian + 2)
  }
  test.info().annotations.push({ type: 'cork seams', description: rows.join('\n') })
  expect(errors).toEqual([])
})
