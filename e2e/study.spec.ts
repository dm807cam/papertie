import path from 'node:path'
import { expect, type Page, test } from '@playwright/test'

const ORIGIN = 'http://localhost:5174/'
const SECTIONS = [
  'cork',
  'papers',
  'type',
  'yarn',
  'pins',
  'mockup',
  'decor',
  'palette',
  'covers',
] as const

test.use({ viewport: { width: 2100, height: 1200 }, deviceScaleFactor: 2 })

async function openStudy(page: Page) {
  const errors: string[] = []
  const responses: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('response', (r) => {
    if (r.ok()) responses.push(r.url())
  })
  await page.goto('/study')
  await expect(page.getByTestId('study')).toBeVisible()
  await page.waitForLoadState('networkidle')
  await page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    await document.fonts.ready
    await Promise.all([...document.images].map((img) => img.decode().catch(() => undefined)))
  })
  return { errors, responses }
}

test('study page loads its fonts and textures from self, with no console errors', async ({
  page,
}) => {
  const { errors, responses } = await openStudy(page)

  const checks = await page.evaluate(() =>
    (
      [
        ['italic 16px "Cormorant Garamond"', 'Papertie'],
        ['16px "Newsreader"', 'Papertie'],
        ['16px "Patrick Hand"', 'objection'],
        ['16px "Instrument Sans"', 'Papertie'],
      ] as const
    ).map(([font, text]) => document.fonts.check(font, text)),
  )
  expect(checks).toEqual([true, true, true, true])

  // Each face's files come from the app itself: the Latin and Latin Extended subsets only.
  const fonts = responses.filter((u) => /\.woff2$/.test(u))
  for (const face of ['newsreader', 'patrick-hand', 'instrument-sans', 'cormorant-garamond']) {
    expect(fonts.filter((u) => u.includes(`/${face}-latin-`)).length).toBeGreaterThanOrEqual(1)
  }
  expect(fonts.filter((u) => !/-latin-(ext-)?\d+-(normal|italic)\.woff2$/.test(u))).toEqual([])

  const resources = await page.evaluate(() =>
    performance.getEntriesByType('resource').map((e) => e.name),
  )
  expect(resources.length).toBeGreaterThan(0)
  expect(resources.filter((name) => !name.startsWith(ORIGIN))).toEqual([])

  const images = await page
    .getByTestId('paper-grid')
    .locator('img')
    .evaluateAll((els) =>
      els.map((el) => {
        const img = el as HTMLImageElement
        return { src: img.currentSrc, w: img.naturalWidth }
      }),
    )
  expect(images).toHaveLength(8)
  for (const img of images) {
    expect(img.src).toBe(`${ORIGIN}textures/print-sample-1024.webp`)
    expect(img.w).toBe(1024)
  }

  expect(errors).toEqual([])
})

test('the deckle strip uses all eight masks', async ({ page }) => {
  const { responses } = await openStudy(page)
  const masks = await page
    .getByTestId('deckle-strip')
    .locator('article.note')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-mask')))
  expect(masks).toEqual(['1', '2', '3', '4', '5', '6', '7', '8'])
  const requested = new Set(
    // The masks are the deckle SVGs drawn as bitmaps (note.css, ADR-0003).
    responses.map((u) => /\/textures\/deckle-(\d)\.webp$/.exec(u)?.[1]).filter(Boolean),
  )
  expect([...requested].sort()).toEqual(['1', '2', '3', '4', '5', '6', '7', '8'])
})

test('long unbroken text keeps the note at 220 px and wraps inside it', async ({ page }) => {
  await openStudy(page)
  const note = page.getByTestId('long-note').locator('article.note')
  const m = await note.evaluate((el) => {
    const paper = el.querySelector('.note-paper') as HTMLElement
    return {
      width: (el as HTMLElement).offsetWidth,
      overflow: paper.scrollWidth - paper.clientWidth,
      height: paper.offsetHeight,
    }
  })
  expect(Math.abs(m.width - 220)).toBeLessThanOrEqual(1)
  expect(m.overflow).toBeLessThanOrEqual(0)
  expect(m.height).toBeGreaterThan(400)
})

test('canvases are DPR-aware and the pin centre reads as brass', async ({ page }) => {
  await openStudy(page)
  const yarn = await page.getByTestId('yarn-canvas').evaluate((el) => {
    const c = el as HTMLCanvasElement
    return { w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight, dpr: devicePixelRatio }
  })
  expect(yarn.dpr).toBe(2)
  expect([yarn.cw, yarn.ch]).toEqual([960, 440])
  expect([yarn.w, yarn.h]).toEqual([960 * yarn.dpr, 440 * yarn.dpr])

  const pixels = await page.getByTestId('pin-canvas').evaluate((el) => {
    const c = el as HTMLCanvasElement
    const ratio = c.width / c.clientWidth
    const ctx = c.getContext('2d') as CanvasRenderingContext2D
    const pins = JSON.parse(c.dataset.pins ?? '[]') as Array<{ x: number; y: number }>
    return pins.map((p) =>
      Array.from(ctx.getImageData(Math.round(p.x * ratio), Math.round(p.y * ratio), 1, 1).data),
    )
  })
  // Hanging pins on cork and paper, and edge pins, at three zooms each.
  expect(pixels).toHaveLength(9)
  for (const [r = 0, g = 0, b = 0, a = 0] of pixels) {
    expect(a).toBe(255)
    expect(r).toBeGreaterThan(150)
    expect(r).toBeGreaterThan(g)
    expect(g).toBeGreaterThan(b)
  }
})

test('mockup notes: typography, motifs, stamp, layered sheet, tilted print and tag hook', async ({
  page,
}) => {
  const { errors } = await openStudy(page)
  const panel = page.getByTestId('mockup-notes')
  await panel.scrollIntoViewIfNeeded()

  const fonts = await page.evaluate(() => [
    document.fonts.check('italic 21px "Cormorant Garamond"', 'Spring Journey'),
    document.fonts.check('600 30px "Newsreader"', 'Spring trip'),
    document.fonts.check('500 17px "Newsreader"', 'Orchard in bloom'),
  ])
  expect(fonts).toEqual([true, true, true])

  const spring = panel.locator('article.note[data-motif="fold"]')
  const text = await spring.evaluate((el) => {
    const css = (sel: string) => {
      const n = el.querySelector(sel) as HTMLElement
      const s = getComputedStyle(n)
      return { text: n.textContent, family: s.fontFamily, style: s.fontStyle, size: s.fontSize }
    }
    return {
      title: css('.note-title'),
      subtitle: css('.note-subtitle'),
      bullets: [...el.querySelectorAll('.note-bullets > li')].map((li) => li.textContent),
      bulletFamily: getComputedStyle(el.querySelector('.note-bullets') as HTMLElement).fontFamily,
    }
  })
  expect(text.title).toMatchObject({ text: 'Spring trip', style: 'normal', size: '30px' })
  expect(text.title.family).toMatch(/^Newsreader,/)
  expect(text.subtitle).toMatchObject({ text: 'Spring Journey', style: 'italic' })
  expect(text.subtitle.family).toMatch(/^"Cormorant Garamond"/)
  expect(text.bullets).toEqual(['Orchard in bloom', 'Old town streets', 'The paper shop'])
  expect(text.bulletFamily).toMatch(/^Newsreader,/)

  // Each decoration is drawn by CSS on an element of its own and the stamp is an inline drawing:
  // nothing is fetched for them, nothing is blended, and none takes the pointer.
  const decor = await panel.locator('.note-decor').evaluateAll((els) =>
    els.map((el) => ({
      motifs: [...el.querySelectorAll('.note-motif')].map((m) => ({
        cls: m.className,
        image: getComputedStyle(m).backgroundImage,
      })),
      stamp: el.querySelector('svg.note-stamp path') !== null,
      images: el.querySelectorAll('img').length,
      events: getComputedStyle(el).pointerEvents,
      blend: getComputedStyle(el).mixBlendMode,
      hidden: el.getAttribute('aria-hidden'),
    })),
  )
  const drawn = decor.flatMap((d) => d.motifs)
  for (const m of ['fold', 'margin', 'dots', 'perforation']) {
    const of = drawn.filter((d) => d.cls.includes(`note-motif--${m}`))
    expect(of.length).toBeGreaterThan(0)
    for (const d of of) {
      expect(d.image).toContain('gradient(')
      expect(d.image).not.toContain('url(')
    }
  }
  expect(decor.filter((d) => d.stamp)).toHaveLength(1)
  for (const d of decor) {
    expect(d.images).toBe(0)
    expect(d.events).toBe('none')
    expect(d.blend).toBe('normal')
    expect(d.hidden).toBe('true')
  }
  // The folded corner is cut out of its paper.
  expect(
    await spring.evaluate(
      (el) => getComputedStyle(el.querySelector('.note-paper') as HTMLElement).clipPath,
    ),
  ).toMatch(/^polygon\(/)

  // The layered sheet: its own paper and mask, larger than the note, never hit.
  const sheet = await spring.evaluate((el) => {
    const s = el.querySelector('.note-sheet') as HTMLElement
    const paper = el.querySelector('.note-paper') as HTMLElement
    const sp = s.querySelector('.note-sheet-paper') as HTMLElement
    return {
      events: getComputedStyle(s).pointerEvents,
      extra: [s.offsetWidth - paper.offsetWidth, s.offsetHeight - paper.offsetHeight],
      mask: s.dataset.sheetMask !== (el as HTMLElement).dataset.mask,
      bg: getComputedStyle(sp).backgroundColor,
      paperBg: getComputedStyle(paper).backgroundColor,
      maskImage: getComputedStyle(sp).getPropertyValue('-webkit-mask-box-image-source'),
    }
  })
  expect(sheet.events).toBe('none')
  expect(sheet.extra[0]).toBeGreaterThanOrEqual(30)
  expect(sheet.extra[1]).toBeGreaterThanOrEqual(30)
  expect(sheet.mask).toBe(true)
  expect(sheet.bg).not.toBe(sheet.paperBg)
  expect(sheet.maskImage).toMatch(/textures\/deckle-\d\.webp/)

  // The print tilts past the paper's ±1°.
  const tilt = await panel.locator('article.note--print:not(.note--tag)').evaluate((el) => {
    const m = new DOMMatrix(getComputedStyle(el).transform)
    return (Math.atan2(m.b, m.a) * 180) / Math.PI
  })
  expect(Math.abs(tilt)).toBeGreaterThanOrEqual(2.5)
  expect(Math.abs(tilt)).toBeLessThanOrEqual(5)

  // Tags hang from a brass hook: its eyelet and the shank above it read as brass.
  const hooks = await page.getByTestId('mockup-canvas').evaluate((el) => {
    const c = el as HTMLCanvasElement
    const ratio = c.width / c.clientWidth
    const ctx = c.getContext('2d') as CanvasRenderingContext2D
    const pins = JSON.parse(c.dataset.pins ?? '[]') as Array<{ x: number; y: number; hook?: true }>
    const px = (x: number, y: number) =>
      Array.from(ctx.getImageData(Math.round(x * ratio), Math.round(y * ratio), 1, 1).data)
    return pins.filter((p) => p.hook).map((p) => [px(p.x, p.y), px(p.x, p.y - 16)])
  })
  expect(hooks).toHaveLength(2)
  for (const pair of hooks) {
    for (const [r = 0, g = 0, b = 0, a = 0] of pair) {
      expect(a).toBe(255)
      expect(r).toBeGreaterThan(150)
      expect(r).toBeGreaterThan(g)
      expect(g).toBeGreaterThan(b)
    }
  }
  const tags = await panel.locator('article.note--tag').count()
  expect(tags).toBe(2)

  expect(errors).toEqual([])
})

/**
 * Every line of text on the decorated notes of a study panel, with the lowest contrast its ink
 * has against any pixel behind it.
 */
async function decoratedLines(page: Page, testId: string) {
  const panel = page.getByTestId(testId)
  await panel.scrollIntoViewIfNeeded()
  const lines = await panel.locator('article.note:has(.note-decor)').evaluateAll((els) =>
    els.flatMap((el) => {
      const note = (el as HTMLElement).dataset
      const blocks = el.querySelectorAll(
        '.note-title, .note-subtitle, .note-bullets > li, .note-body',
      )
      return [...blocks].flatMap((b) => {
        const range = document.createRange()
        range.selectNodeContents(b)
        const subtitle = b.classList.contains('note-subtitle')
        return [...range.getClientRects()].map((r) => ({
          note: `${note.motif ?? 'stamp'} on ${note.paper}`,
          text: b.textContent ?? '',
          ink: getComputedStyle(b).color,
          min: subtitle ? 4.5 : 7,
          x: r.left,
          y: r.top,
          w: r.width,
          h: r.height,
        }))
      })
    }),
  )
  const box = await panel.boundingBox()
  if (box === null) throw new Error(`no ${testId} panel`)
  // The background behind each line: the same pixels with the text made transparent.
  const hidden = await page.addStyleTag({
    // Pins are drawn above the paper but clear of the glyphs: they are not what the text sits on.
    content:
      '.note-text, .note-text *, .note-text *::before { color: transparent !important; }' +
      ' .cork-panel .pin-layer { visibility: hidden; }',
  })
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  )
  // The whole panel, taller than the window: clipped out of the full page, in page coordinates.
  const scroll = await page.evaluate(() => ({ x: scrollX, y: scrollY }))
  const png = await page.screenshot({
    clip: { ...box, x: box.x + scroll.x, y: box.y + scroll.y },
    fullPage: true,
    animations: 'disabled',
  })
  await hidden.evaluate((el) => (el as Element).remove())
  return page.evaluate(
    async ({ b64, lines, box }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
      const ratio = bmp.width / box.width
      if (Math.abs(bmp.height - box.height * ratio) > 2) throw new Error('the panel was cropped')
      const ctx = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d')
      if (ctx === null) throw new Error('no 2d context')
      ctx.drawImage(bmp, 0, 0)
      const lin = (c: number) => {
        const v = c / 255
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
      }
      const lum = (r: number, g: number, b: number) =>
        0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
      return lines.map((l) => {
        // `rgb(r, g, b)` in 0-255, or `color(srgb r g b)` in 0-1 for a color-mix() ink.
        const nums = (l.ink.match(/\d+(\.\d+)?/g) ?? []).map(Number)
        const scale = l.ink.startsWith('color(') ? 255 : 1
        const [r = 0, g = 0, b = 0] = nums.map((n) => n * scale)
        const inkL = lum(r, g, b)
        const x0 = Math.round((l.x - box.x) * ratio)
        const y0 = Math.round((l.y - box.y) * ratio)
        const w = Math.max(1, Math.round(l.w * ratio))
        const h = Math.max(1, Math.round(l.h * ratio))
        const px = ctx.getImageData(x0, y0, w, h).data
        let ratioMin = Number.POSITIVE_INFINITY
        for (let i = 0; i < px.length; i += 4) {
          const bg = lum(px[i] ?? 0, px[i + 1] ?? 0, px[i + 2] ?? 0)
          const c = (Math.max(bg, inkL) + 0.05) / (Math.min(bg, inkL) + 0.05)
          if (c < ratioMin) ratioMin = c
        }
        return { note: l.note, text: l.text, min: l.min, ratio: Math.round(ratioMin * 100) / 100 }
      })
    },
    { b64: png.toString('base64'), lines, box },
  )
}

test('text over a decoration keeps 7:1 against the ink (a subtitle 4.5:1)', async ({ page }) => {
  await openStudy(page)
  // The second panel has the dot grid, the one decoration under text, on all eight papers.
  const worst = [
    ...(await decoratedLines(page, 'decor-notes')),
    ...(await decoratedLines(page, 'mockup-notes')),
  ]
  expect(worst.length).toBeGreaterThan(80)
  const dotted = new Set(worst.filter((l) => l.note.startsWith('dots on ')).map((l) => l.note))
  expect(dotted.size).toBe(8)
  const byNote: Record<string, number> = {}
  for (const l of worst) {
    const k = `${l.note}, ${l.min < 7 ? 'subtitle' : 'text'}`
    byNote[k] = Math.min(byNote[k] ?? Number.POSITIVE_INFINITY, l.ratio)
  }
  test
    .info()
    .annotations.push({ type: 'lowest contrast per note', description: JSON.stringify(byNote) })
  const failing = worst.filter((l) => l.ratio < l.min)
  expect(failing).toEqual([])
})

test('screenshots, one per section', async ({ page }) => {
  await openStudy(page)
  for (const id of SECTIONS) {
    const section = page.locator(`[data-section="${id}"]`)
    await section.scrollIntoViewIfNeeded()
    const clip = await section.evaluate((el) => {
      let { left, top, right, bottom } = el.getBoundingClientRect()
      for (const child of el.querySelectorAll('.study-bleed > *')) {
        const r = child.getBoundingClientRect()
        left = Math.min(left, r.left - 32)
        right = Math.max(right, r.right + 32)
      }
      const x = Math.max(0, left + scrollX - 40)
      return {
        x,
        y: top + scrollY - 24,
        width: right + scrollX + 40 - x,
        height: bottom - top + 48,
      }
    })
    await page.screenshot({
      path: path.join(__dirname, 'artifacts', `study-${id}.png`),
      clip,
      fullPage: true,
      animations: 'disabled',
    })
  }
})

test('palette tuner flags low contrast, persists overrides and exports JSON', async ({ page }) => {
  await openStudy(page)
  const tuner = page.getByTestId('palette-tuner')
  const ink = tuner.locator('tr[data-token="ink"]')
  await expect(ink.locator('.tuner-ratio')).not.toHaveClass(/is-low/)

  await ink.getByLabel('ink paper').fill('#9a9a9a')
  await expect(ink.locator('.tuner-ratio')).toHaveClass(/is-low/)
  await expect(ink.locator('.tuner-flag')).toHaveText('below 7:1')
  const root = () =>
    page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--paper-ink').trim(),
    )
  expect(await root()).toBe('#9A9A9A')
  const stored = await page.evaluate(() => localStorage.getItem('papertie.proto.palette'))
  expect(JSON.parse(stored ?? 'null')).toEqual({ ink: { paper: '#9A9A9A' } })

  await page.reload()
  await expect(page.getByTestId('study')).toBeVisible()
  expect(await root()).toBe('#9A9A9A')

  await tuner.getByRole('button', { name: 'Copy JSON' }).click()
  const json = JSON.parse((await page.getByTestId('palette-json').textContent()) ?? '{}')
  expect(Object.keys(json)).toHaveLength(8)
  expect(json.ink).toEqual({ paper: '#9A9A9A', yarn: '#2B2A28' })
  expect(json.cream).toEqual({ paper: '#F3EBDD', yarn: '#EDE4D3' })

  await tuner.getByRole('button', { name: 'Reset to core palette' }).click()
  expect(await root()).toBe('#34312E')
  expect(await page.evaluate(() => localStorage.getItem('papertie.proto.palette'))).toBeNull()
})
