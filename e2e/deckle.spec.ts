import path from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import type { Cam, Pt } from './hooks'

const VIEW = { width: 1280, height: 720 }
test.use({ viewport: VIEW })

/** The tea note: sage fibre paper, 260 × 190 at (1520, 560), tilted 0.86°. */
const TEA = `note_01JBDEM0${'5'.padStart(18, '0')}`
const MASKS = [1, 2, 3, 4, 5, 6, 7, 8] as const
/**
 * Includes the raster scales where Chrome's tiled (`round`) SVG slices went blank, up to the
 * closest zoom (2×; 3 and 4 were checked while the camera went to 4).
 */
const ZOOMS = [1, 1.25, 1.45, 1.5, 1.6, 2]
/** Hides the paper-coloured seam backing, so only the mask decides what paper shows. */
const NO_BACKING = '.note-shadow { background: none !important }'
/** The deepest bite of the torn edge (tools `DECKLE_MAX_BITE`) and the 9-slice band. */
const MAX_BITE = 8
const SLICE = 12

async function open(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/bench?board=demo')
  await page.waitForFunction(() => window.__papertie?.ready === true)
  await page.evaluate(() => document.fonts.ready)
  await page.mouse.move(VIEW.width - 4, VIEW.height - 4)
  return errors
}

const idle = (page: Page) =>
  page.waitForFunction(() => window.__papertie.runtime.loop.running === false)

/** Give the tea note mask `m` and put its bottom-right corner at the viewport centre. */
async function frame(page: Page, m: number, zoom: number) {
  const n = await page.evaluate((id) => {
    const n = window.__papertie.store.getState().notes.get(id)
    if (n === undefined) throw new Error('no tea note')
    return { x: n.x, y: n.y, w: n.w, h: n.h }
  }, TEA)
  const cam: Cam = { x: n.x + n.w - 640 / zoom, y: n.y + n.h - 360 / zoom, zoom }
  await page.evaluate((c) => window.__papertie.debug.setCamera(c), cam)
  await idle(page)
  await page.evaluate(
    ({ id, m }) => {
      const el = document.querySelector(`article.note[data-note-id="${id}"]`) as HTMLElement
      el.dataset.mask = String(m)
    },
    { id: TEA, m },
  )
  // Let the new mask decode and paint.
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  )
}

/** Distances back from the bottom-right corner: past the 12 px corner, clear of the toolbar. */
const BACK = [24, 36, 48, 60]

/**
 * Screen points of note-local points (rotation included), found with zero-size probes placed
 * inside the note. `inset` is measured from the right and bottom edges of the drawn paper.
 */
const edgeBand = (page: Page, inset: number) =>
  page.evaluate(
    ({ id, inset, BACK }) => {
      const el = document.querySelector(`article.note[data-note-id="${id}"]`) as HTMLElement
      const paper = el.querySelector('.note-paper') as HTMLElement
      const w = paper.offsetWidth
      const h = paper.offsetHeight
      const local: [number, number][] = [
        ...BACK.map((d): [number, number] => [w - inset, h - d]),
        ...BACK.map((d): [number, number] => [w - d, h - inset]),
      ]
      const at = ([x, y]: [number, number]) => {
        const p = document.createElement('i')
        p.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:0;height:0`
        el.append(p)
        const r = p.getBoundingClientRect()
        p.remove()
        return { x: r.x, y: r.y }
      }
      return { band: local.map(at), inside: at([w - 60, h - 30]) }
    },
    { id: TEA, inset, BACK },
  )

/** Luminance (0-255) of the 3 × 3 device px around each viewport point, in one screenshot. */
async function lumAt(page: Page, pts: Pt[]): Promise<number[]> {
  const png = (await page.screenshot({ animations: 'disabled' })).toString('base64')
  return page.evaluate(
    async ({ png, pts }) => {
      const blob = await (await fetch(`data:image/png;base64,${png}`)).blob()
      const bmp = await createImageBitmap(blob)
      const ctx = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d')
      if (ctx === null) throw new Error('no 2d context')
      ctx.drawImage(bmp, 0, 0)
      const s = bmp.width / innerWidth
      return pts.map((p) => {
        const d = ctx.getImageData(Math.round(p.x * s) - 1, Math.round(p.y * s) - 1, 3, 3).data
        let sum = 0
        for (let i = 0; i < d.length; i += 4)
          sum += 0.299 * (d[i] ?? 0) + 0.587 * (d[i + 1] ?? 0) + 0.114 * (d[i + 2] ?? 0)
        return sum / 9
      })
    },
    { png, pts },
  )
}

test('the deckle masks have a 128 px intrinsic size, so slices and bites never scale', async ({
  page,
}) => {
  await page.goto('/bench?board=demo')
  const sizes = await page.evaluate(() =>
    Promise.all(
      [1, 2, 3, 4, 5, 6, 7, 8].map(async (m) => {
        const img = new Image()
        img.src = `/textures/deckle-${m}.svg`
        await img.decode()
        return [img.naturalWidth, img.naturalHeight]
      }),
    ),
  )
  expect(sizes).toEqual(MASKS.map(() => [128, 128]))
  // The bitmaps note.css masks with: the same SVGs at 4 px a unit, so its 48 px slice is the
  // SVG's 12 and the bites keep their size.
  const bitmaps = await page.evaluate(() =>
    Promise.all(
      [1, 2, 3, 4, 5, 6, 7, 8].map(async (m) => {
        const img = new Image()
        img.src = `/textures/deckle-${m}.webp`
        await img.decode()
        return [img.naturalWidth, img.naturalHeight]
      }),
    ),
  )
  expect(bitmaps).toEqual(MASKS.map(() => [512, 512]))
  const slice = await page.evaluate(() => {
    const probe = document.createElement('div')
    probe.className = 'note note--rustic'
    probe.dataset.mask = '1'
    probe.innerHTML = '<div class="note-paper"></div>'
    document.body.append(probe)
    const cs = getComputedStyle(probe.querySelector('.note-paper') as Element)
    const out = {
      slice: cs.getPropertyValue('-webkit-mask-box-image-slice'),
      width: cs.getPropertyValue('-webkit-mask-box-image-width'),
    }
    probe.remove()
    return out
  })
  expect(slice).toEqual({ slice: '48 fill', width: '12px' })
})

test('a paper shadow box sits behind the deepest bite, and its backing 1 px further in', async ({
  page,
}) => {
  const errors = await open(page)
  await page.getByLabel('Paper rotation').uncheck()
  await page.evaluate(() => window.__papertie.debug.setCamera({ x: 1000, y: 520, zoom: 1 }))
  await idle(page)
  const gaps = await page.evaluate((id) => {
    const el = document.querySelector(`article.note[data-note-id="${id}"]`) as HTMLElement
    const paper = (el.querySelector('.note-paper') as HTMLElement).getBoundingClientRect()
    const shadow = el.querySelector('.note-shadow') as HTMLElement
    const box = shadow.getBoundingClientRect()
    const cs = getComputedStyle(shadow)
    const pad = (side: string) => Number.parseFloat(cs.getPropertyValue(`padding-${side}`))
    const inset = {
      top: box.top - paper.top,
      right: paper.right - box.right,
      bottom: paper.bottom - box.bottom,
      left: box.left - paper.left,
    }
    const backing = {
      top: inset.top + pad('top'),
      right: inset.right + pad('right'),
      bottom: inset.bottom + pad('bottom'),
      left: inset.left + pad('left'),
    }
    return { inset, backing }
  }, TEA)
  // A box edge outside the deepest bite shows as a straight line on the cork; the backing must
  // stay inside the tear too, yet cover the slice seams 12 px in.
  for (const v of Object.values(gaps.inset)) expect(v).toBeGreaterThanOrEqual(MAX_BITE)
  const b = MAX_BITE + 1
  expect(gaps.backing).toEqual({ top: b, right: b, bottom: b, left: b })
  expect(b).toBeLessThan(SLICE)
  expect(errors).toEqual([])
})

test('every deckle mask keeps the paper inside its torn edge at every zoom and tilt', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const errors = await open(page)
  await page.addStyleTag({ content: NO_BACKING })
  const failures: string[] = []
  for (const zoom of ZOOMS) {
    for (const m of MASKS) {
      await frame(page, m, zoom)
      // Past the deepest bite and short of the 12 px slice seam is always paper.
      const { band, inside } = await edgeBand(page, MAX_BITE + 2)
      const [ref, ...lums] = await lumAt(page, [inside, ...band])
      const worst = Math.max(...lums.map((l) => (ref ?? 0) - l))
      if (worst > 30) failures.push(`mask ${m} at zoom ${zoom}: ${worst.toFixed(0)} darker`)
    }
  }
  expect(failures).toEqual([])
  expect(errors).toEqual([])
})

test('screenshot: the 8 deckle masks on a tilted note at zoom 1, 1.5 and 2', async ({ page }) => {
  test.setTimeout(120_000)
  const errors = await open(page)
  const cells: string[] = []
  for (const zoom of [1, 1.5, 2]) {
    for (const m of MASKS) {
      await frame(page, m, zoom)
      const r = 12 * zoom + 16
      const scale = 240 / (4 * r)
      const shot = await page.screenshot({
        clip: { x: 640 - 3 * r, y: 360 - 3 * r, width: 4 * r, height: 4 * r },
        animations: 'disabled',
      })
      cells.push(
        `<figure><img src="data:image/png;base64,${shot.toString('base64')}" style="zoom:${scale}"><figcaption>mask ${m} · zoom ${zoom}</figcaption></figure>`,
      )
    }
  }
  expect(errors).toEqual([])
  await page.setContent(
    `<body style="margin:8px;background:#fff;font:11px system-ui;display:grid;grid-template-columns:repeat(8,auto);gap:6px">${cells.join('')}</body>`,
  )
  await page.addStyleTag({
    content: 'figure{margin:0}img{display:block;image-rendering:pixelated}',
  })
  await page.screenshot({
    path: path.join(__dirname, 'artifacts', 'deckle-masks.png'),
    fullPage: true,
  })
})

test('the fibre texture: baked into the paper, or the overlay blended over it', async ({
  page,
}) => {
  await page.goto('/bench?board=demo')
  await page.waitForFunction(() => window.__papertie?.ready === true)
  const fibre = await page.evaluate(() => {
    const probe = (paper: string, attrs: string[]) => {
      const el = document.createElement('article')
      el.className = 'note note--rustic'
      el.dataset.paper = paper
      for (const a of attrs) el.setAttribute(a, '')
      el.innerHTML = '<div class="note-paper"></div>'
      document.body.append(el)
      const p = el.querySelector('.note-paper') as Element
      const after = getComputedStyle(p, '::after')
      const out = {
        baked: getComputedStyle(p).backgroundImage.includes(`fibre-${paper}.webp`),
        overlay: after.content === 'none' ? null : `${after.mixBlendMode} ${after.opacity}`,
      }
      el.remove()
      return out
    }
    return {
      cream: probe('cream', []),
      creamPhoto: probe('cream', ['data-photo']),
      creamDecor: probe('cream', ['data-motif']),
      ink: probe('ink', []),
      inkPhoto: probe('ink', ['data-photo']),
      inkDecor: probe('ink', ['data-motif']),
      inkPhotoDecor: probe('ink', ['data-photo', 'data-motif']),
    }
  })
  // The overlay is drawn only over a photo (on ink, screened); a decoration is drawn on the
  // baked sheet.
  expect(fibre).toEqual({
    cream: { baked: true, overlay: null },
    creamPhoto: { baked: false, overlay: 'multiply 0.55' },
    creamDecor: { baked: true, overlay: null },
    ink: { baked: true, overlay: null },
    inkPhoto: { baked: false, overlay: 'screen 0.25' },
    inkDecor: { baked: true, overlay: null },
    inkPhotoDecor: { baked: false, overlay: 'screen 0.25' },
  })
})
