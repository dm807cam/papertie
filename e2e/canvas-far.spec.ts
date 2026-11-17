import { expect, type Page, test } from '@playwright/test'
import { ANCHOR_REACH_PX, ZOOM_MAX } from '../apps/web/src/canvas/Camera'
import { FAR_IDS, FAR_ORIGIN } from '../apps/web/src/dev/farBoard'
import type { Cam, Pt } from './hooks'
import { armYarn } from './yarnTool'

const VIEW = { width: 1280, height: 720 }
test.use({ viewport: VIEW })

const NOTES = [FAR_IDS.hub, FAR_IDS.print, FAR_IDS.tag, FAR_IDS.smooth]
type EndRef = readonly [yarnId: string, seg: number, end: 'a' | 'b']
const ENDS: EndRef[] = [
  [FAR_IDS.chain, 0, 'a'],
  [FAR_IDS.chain, 0, 'b'],
  [FAR_IDS.chain, 1, 'a'],
  [FAR_IDS.chain, 1, 'b'],
  [FAR_IDS.drop, 0, 'a'],
  [FAR_IDS.drop, 0, 'b'],
]

/** Cameras relative to the cluster's origin: several zooms (one lite), sub-pixel offsets. */
const CAMERAS: Cam[] = [
  { x: -180.37, y: -140.61, zoom: 1 },
  { x: -60.13, y: -40.29, zoom: 2 },
  { x: 20.41, y: -10.77, zoom: ZOOM_MAX },
  { x: 120.123, y: 60.389, zoom: 1.83 },
  { x: -400.5, y: -300.25, zoom: 0.35 },
  { x: -1300.7, y: -900.3, zoom: 0.3 },
  { x: -100.71, y: -100.17, zoom: 1.37 },
]

const shift = (c: Cam, o: Pt): Cam => ({ x: o.x + c.x, y: o.y + c.y, zoom: c.zoom })

async function open(page: Page, board: 'far' | 'far0') {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await page.goto(`/bench?board=${board}`)
  await page.waitForFunction(() => window.__papertie?.ready === true)
  // The strip names the board; everything else on screen must match between the two boards.
  await page.addStyleTag({
    content:
      '.viewport > .ui { visibility: hidden !important }' +
      ' html[data-cork-only] .viewport > :not(.cork) { visibility: hidden !important }',
  })
  await settle(page)
  return errors
}

/** The loop idle, two more frames and every image decoded. */
async function settle(page: Page) {
  await page.waitForFunction(() => window.__papertie.runtime.loop.running === false)
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )
  await page.waitForFunction(() => [...document.images].every((i) => i.complete))
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
}

/**
 * A screenshot once the compositor has caught up: after a camera change it can keep showing
 * tiles rastered at the moving scale for a while (longer on a loaded machine), so shoot until
 * three in a row, 100 ms apart, match.
 */
async function stableShot(page: Page): Promise<Buffer> {
  let last = await page.screenshot()
  let same = 1
  for (let k = 0; k < 30 && same < 3; k++) {
    await page.waitForTimeout(100)
    const next = await page.screenshot()
    same = next.equals(last) ? same + 1 : 1
    last = next
  }
  return last
}

const setCamera = async (page: Page, c: Cam) => {
  await page.evaluate((c) => window.__papertie.debug.setCamera(c), c)
  await settle(page)
}

interface NoteSample {
  /** The note's DOM box, viewport px. */
  box: { left: number; top: number; right: number; bottom: number }
  /** Largest gap between the DOM box and the camera math's box for the rotated paper. */
  boxErr: number
  pin: Pt
  /** Gap between `pinScreen` and the camera math. */
  pinErr: number
}

interface Sample {
  notes: Record<string, NoteSample>
  ends: Array<{ p: Pt }>
}

/**
 * Every mounted note's DOM box and its pin, each with its distance from where the drawn camera's
 * math (world doubles) puts it, and every yarn end as drawn.
 */
const sample = (page: Page): Promise<Sample> =>
  page.evaluate(
    ({ notes, ends }) => {
      const m = window.__papertie
      const dc = m.runtime.drawnCamera()
      const screen = (p: { x: number; y: number }) => ({
        x: (p.x - dc.x) * dc.zoom,
        y: (p.y - dc.y) * dc.zoom,
      })
      const gap = (a: { x: number; y: number }, b: { x: number; y: number }) =>
        Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))
      const out: Sample = { notes: {}, ends: [] }
      for (const id of notes) {
        const el = document.querySelector<HTMLElement>(`article.note[data-note-id="${id}"]`)
        const n = m.store.getState().notes.get(id)
        const pinW = m.runtime.pinWorld(id)
        const pin = m.debug.pinScreen(id)
        if (el === null || n === undefined || pinW === undefined || pin === undefined) continue
        const deg = Number(/rotate\((-?[\d.e+-]+)deg\)/.exec(el.style.transform)?.[1] ?? 0)
        const t = (deg * Math.PI) / 180
        const h = el.offsetHeight
        const corners = [
          [n.x, n.y],
          [n.x + n.w, n.y],
          [n.x + n.w, n.y + h],
          [n.x, n.y + h],
        ].map(([x = 0, y = 0]) => {
          // World doubles relative to the pin, then turned about it, then mapped.
          const dx = x - pinW.x
          const dy = y - pinW.y
          return screen({
            x: pinW.x + dx * Math.cos(t) - dy * Math.sin(t),
            y: pinW.y + dx * Math.sin(t) + dy * Math.cos(t),
          })
        })
        const xs = corners.map((c) => c.x)
        const ys = corners.map((c) => c.y)
        const r = el.getBoundingClientRect()
        const box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
        const boxErr = Math.max(
          Math.abs(box.left - Math.min(...xs)),
          Math.abs(box.right - Math.max(...xs)),
          Math.abs(box.top - Math.min(...ys)),
          Math.abs(box.bottom - Math.max(...ys)),
        )
        out.notes[id] = { box, boxErr, pin, pinErr: gap(pin, screen(pinW)) }
      }
      for (const [yarnId, seg, end] of ends) {
        const p = m.debug.attachScreen(yarnId, seg, end)
        out.ends.push({ p: p ?? { x: Number.NaN, y: Number.NaN } })
      }
      return out
    },
    { notes: NOTES, ends: ENDS },
  )

/** RGBA of a layer canvas at a viewport CSS point. */
const pixel = (page: Page, layer: 'yarn-layer' | 'pin-layer', p: Pt) =>
  page.evaluate(
    ({ layer, p }) => {
      const c = document.querySelector(`canvas.${layer}`) as HTMLCanvasElement
      const ctx = c.getContext('2d') as CanvasRenderingContext2D
      const d = devicePixelRatio
      return Array.from(ctx.getImageData(Math.round(p.x * d), Math.round(p.y * d), 1, 1).data)
    },
    { layer, p },
  )

const onScreen = (p: Pt, pad = 12) =>
  p.x > pad && p.y > pad && p.x < VIEW.width - pad && p.y < VIEW.height - pad

const expectBrass = async (page: Page, p: Pt, what: string) => {
  const [r = 0, g = 0, b = 0, a = 0] = await pixel(page, 'pin-layer', p)
  expect.soft(a, what).toBe(255)
  expect.soft(r > 150 && r > g && g > b, `${what}: brass, got ${[r, g, b]}`).toBe(true)
}

interface Diff {
  /** Share of pixels whose channels differ by more than 40 levels. */
  share: number
  /** The whole-pixel offset (within ±3) that best lines `b` up on `a`, and its share. */
  best: { dx: number; dy: number; share: number }
  /** Bounds of the differing pixels (empty when x1 < x0). */
  box: { x0: number; y0: number; x1: number; y1: number }
}

/** Compare two screenshots in the page (no PNG decoder in Node). */
const diff = (page: Page, a: Buffer, b: Buffer): Promise<Diff> =>
  page.evaluate(
    async ({ a, b }) => {
      const load = async (b64: string) => {
        const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob()
        const bmp = await createImageBitmap(blob)
        const c = new OffscreenCanvas(bmp.width, bmp.height)
        const ctx = c.getContext('2d') as OffscreenCanvasRenderingContext2D
        ctx.drawImage(bmp, 0, 0)
        return ctx.getImageData(0, 0, bmp.width, bmp.height)
      }
      const [A, B] = [await load(a), await load(b)]
      const { width: w, height: h } = A
      const R = 3
      const box = { x0: w, y0: h, x1: -1, y1: -1 }
      const share = (dx: number, dy: number) => {
        let bad = 0
        let all = 0
        for (let y = R; y < h - R; y++) {
          for (let x = R; x < w - R; x++) {
            const i = (y * w + x) * 4
            const j = ((y + dy) * w + (x + dx)) * 4
            all++
            for (let k = 0; k < 3; k++) {
              if (Math.abs((A.data[i + k] ?? 0) - (B.data[j + k] ?? 0)) > 40) {
                bad++
                if (dx === 0 && dy === 0) {
                  box.x0 = Math.min(box.x0, x)
                  box.y0 = Math.min(box.y0, y)
                  box.x1 = Math.max(box.x1, x)
                  box.y1 = Math.max(box.y1, y)
                }
                break
              }
            }
          }
        }
        return bad / all
      }
      let best = { dx: 0, dy: 0, share: share(0, 0) }
      const at0 = best.share
      if (at0 > 0) {
        for (let dy = -R; dy <= R; dy++) {
          for (let dx = -R; dx <= R; dx++) {
            const s = share(dx, dy)
            if (s < best.share) best = { dx, dy, share: s }
          }
        }
      }
      return { share: at0, best, box }
    },
    { a: a.toString('base64'), b: b.toString('base64') },
  )

interface Capture {
  sample: Sample
  shot: Buffer
  cork: Buffer
}

/** Each camera of `CAMERAS` (relative to `origin`) on `board`: sample, screenshot, cork alone. */
async function captureAll(page: Page, board: 'far' | 'far0', origin: Pt): Promise<Capture[]> {
  const errors = await open(page, board)
  const out: Capture[] = []
  for (const rel of CAMERAS) {
    await setCamera(page, shift(rel, origin))
    const s = await sample(page)
    if (rel.zoom >= 0.38) {
      for (const [id, n] of Object.entries(s.notes)) {
        if (onScreen(n.pin)) await expectBrass(page, n.pin, `${board} z${rel.zoom} pin ${id}`)
      }
      for (const [k, e] of s.ends.entries()) {
        if (!onScreen(e.p)) continue
        await expectBrass(page, e.p, `${board} z${rel.zoom} end ${ENDS[k]?.join(' ')}`)
        const [, , , alpha = 0] = await pixel(page, 'yarn-layer', e.p)
        expect
          .soft(alpha, `${board} z${rel.zoom} yarn at end ${ENDS[k]?.join(' ')}`)
          .toBeGreaterThan(0)
      }
    }
    const shot = await stableShot(page)
    await page.evaluate(() => {
      document.documentElement.dataset.corkOnly = ''
    })
    const cork = await stableShot(page)
    await page.evaluate(() => {
      delete document.documentElement.dataset.corkOnly
    })
    out.push({ sample: s, shot, cork })
  }
  expect(errors).toEqual([])
  return out
}

test('far from the origin every layer draws where the camera puts it, as at the origin', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  // Each board in a fresh context, both after a throwaway pass over the same cameras: the browser
  // shares decoded textures between contexts, and a cold load rasters the cork and prints a few
  // anti-aliased pixels differently from a warm one.
  const fresh = () => browser.newPage({ viewport: VIEW })
  const warm = await fresh()
  await captureAll(warm, 'far0', { x: 0, y: 0 })
  await warm.close()
  const page = await fresh()
  const near = await captureAll(page, 'far0', { x: 0, y: 0 })
  const farPage = await fresh()
  const far = await captureAll(farPage, 'far', FAR_ORIGIN)
  const rows: string[] = []
  for (const [i, rel] of CAMERAS.entries()) {
    const n = near[i] as Capture
    const f = far[i] as Capture
    const label = `camera ${i} zoom ${rel.zoom}`
    let boxErr = 0
    let pinErr = 0
    let nearBoxGap = 0
    for (const id of NOTES) {
      const fn = f.sample.notes[id]
      const nn = n.sample.notes[id]
      expect.soft(fn === undefined, `${label}: ${id} mounted on both`).toBe(nn === undefined)
      if (fn === undefined || nn === undefined) continue
      boxErr = Math.max(boxErr, fn.boxErr)
      pinErr = Math.max(pinErr, fn.pinErr)
      nearBoxGap = Math.max(
        nearBoxGap,
        Math.abs(fn.box.left - nn.box.left),
        Math.abs(fn.box.top - nn.box.top),
        Math.abs(fn.box.right - nn.box.right),
        Math.abs(fn.box.bottom - nn.box.bottom),
        Math.abs(fn.pin.x - nn.pin.x),
        Math.abs(fn.pin.y - nn.pin.y),
      )
    }
    let endGap = 0
    for (const [k, e] of f.sample.ends.entries()) {
      const ne = n.sample.ends[k]
      if (ne === undefined) continue
      endGap = Math.max(endGap, Math.abs(e.p.x - ne.p.x), Math.abs(e.p.y - ne.p.y))
    }
    const shot = await diff(page, n.shot, f.shot)
    const cork = await diff(page, n.cork, f.cork)
    rows.push(
      `${label}: note box err ${boxErr.toFixed(3)} px, pin err ${pinErr.toFixed(3)} px, ` +
        `far vs origin: boxes ${nearBoxGap.toFixed(3)} px, ends ${endGap.toFixed(3)} px, ` +
        `screen ${(shot.share * 100).toFixed(3)}% differ (best offset ${shot.best.dx},${shot.best.dy}` +
        ` -> ${(shot.best.share * 100).toFixed(3)}%) in ${JSON.stringify(shot.box)}, ` +
        `cork ${(cork.share * 100).toFixed(3)}%`,
    )
    expect.soft(boxErr, `${label}: DOM boxes vs camera math`).toBeLessThanOrEqual(0.5)
    expect.soft(pinErr, `${label}: pins vs camera math`).toBeLessThanOrEqual(0.5)
    expect.soft(nearBoxGap, `${label}: DOM boxes and pins, far vs origin`).toBeLessThanOrEqual(0.5)
    expect.soft(endGap, `${label}: yarn ends, far vs origin`).toBeLessThanOrEqual(0.5)
    expect.soft(shot.share, `${label}: screenshot, far vs origin`).toBeLessThanOrEqual(0.001)
    expect
      .soft(cork.share, `${label}: cork (no seam or gap), far vs origin`)
      .toBeLessThanOrEqual(0.001)
  }
  test.info().annotations.push({ type: 'measured error', description: rows.join('\n') })
  await test.info().attach('measured error', { body: rows.join('\n'), contentType: 'text/plain' })
  await page.close()
  await farPage.close()
})

/** Overview cameras relative to the cluster's origin, with sub-pixel offsets. */
const OVERVIEW_CAMERAS: Cam[] = [
  { x: -3400.37, y: -2300.61, zoom: 0.1 },
  { x: -6100.13, y: -4400.29, zoom: 0.05 },
  { x: -31000.41, y: -17600.77, zoom: 0.02 },
  { x: -2700.7, y: -1900.3, zoom: 0.137 },
]

/** The yarn and pin layers' pixels, as one string per layer, once two reads a frame apart match. */
const layerPixels = async (page: Page): Promise<string[]> => {
  const read = () =>
    page.evaluate(() =>
      ['canvas.yarn-layer', 'canvas.pin-layer'].map((sel) => {
        const c = document.querySelector(sel) as HTMLCanvasElement
        const d = (c.getContext('2d') as CanvasRenderingContext2D).getImageData(
          0,
          0,
          c.width,
          c.height,
        ).data
        let h = 0
        let out = ''
        // A rolling hash per 4 KB stripe: enough to locate a difference, small to return.
        for (let i = 0; i < d.length; i++) {
          h = (Math.imul(h, 31) + (d[i] ?? 0)) | 0
          if ((i & 4095) === 4095) {
            out += `${h.toString(36)},`
            h = 0
          }
        }
        return out
      }),
    )
  let last = await read()
  for (let k = 0; k < 20; k++) {
    await page.waitForTimeout(100)
    const next = await read()
    if (next.join() === last.join()) return next
    last = next
  }
  return last
}

test('far from the origin the overview cards, pins and threads draw as at the origin', async ({
  browser,
}) => {
  test.setTimeout(120_000)
  const capture = async (board: 'far' | 'far0', origin: Pt) => {
    const page = await browser.newPage({ viewport: VIEW })
    const errors = await open(page, board)
    const out: string[][] = []
    for (const rel of OVERVIEW_CAMERAS) {
      await setCamera(page, shift(rel, origin))
      expect(await page.evaluate(() => window.__papertie.debug.lod())).toBe('overview')
      out.push(await layerPixels(page))
    }
    expect(errors).toEqual([])
    await page.close()
    return out
  }
  const near = await capture('far0', { x: 0, y: 0 })
  const far = await capture('far', FAR_ORIGIN)
  for (const [i, rel] of OVERVIEW_CAMERAS.entries()) {
    const [ny = '', np = ''] = near[i] ?? []
    const [fy = '', fp = ''] = far[i] ?? []
    // Something is drawn: not an empty canvas compared with an empty canvas.
    expect(new Set(ny.split(',')).size, `zoom ${rel.zoom}: cards drawn`).toBeGreaterThan(2)
    const stripes = (a: string, b: string) => {
      const x = a.split(',')
      const y = b.split(',')
      return x.filter((v, k) => v !== y[k]).length
    }
    expect.soft(stripes(ny, fy), `zoom ${rel.zoom}: yarn layer stripes differ`).toBe(0)
    expect.soft(stripes(np, fp), `zoom ${rel.zoom}: pin layer stripes differ`).toBe(0)
  }
})

/**
 * Points `d` px inside (positive) or outside each edge midpoint of a note's paper, and its centre.
 */
const edgeProbes = (page: Page, id: string, d: number) =>
  page.evaluate(
    ({ id, d }) => {
      const m = window.__papertie
      const dc = m.runtime.drawnCamera()
      const el = document.querySelector<HTMLElement>(`article.note[data-note-id="${id}"]`)
      const n = m.store.getState().notes.get(id)
      const pinW = m.runtime.pinWorld(id)
      if (el === null || n === undefined || pinW === undefined) throw new Error(`no ${id}`)
      const t =
        (Number(/rotate\((-?[\d.e+-]+)deg\)/.exec(el.style.transform)?.[1] ?? 0) * Math.PI) / 180
      const h = el.offsetHeight
      // Local paper point (u, v) from its top-left, to the screen.
      const at = (u: number, v: number) => {
        const dx = n.x + u - pinW.x
        const dy = n.y + v - pinW.y
        return {
          x: (pinW.x + dx * Math.cos(t) - dy * Math.sin(t) - dc.x) * dc.zoom,
          y: (pinW.y + dx * Math.sin(t) + dy * Math.cos(t) - dc.y) * dc.zoom,
        }
      }
      const k = d / dc.zoom
      return {
        centre: at(n.w / 2, h / 2),
        edges: [at(k, h / 2), at(n.w - k, h / 2), at(n.w / 2, k), at(n.w / 2, h - k)],
      }
    },
    { id, d },
  )

const noteAtPoint = (page: Page, p: Pt) =>
  page.evaluate(
    (p) =>
      document.elementFromPoint(p.x, p.y)?.closest<HTMLElement>('article.note')?.dataset.noteId,
    p,
  )

test('far from the origin a press lands on the pin, the edge pin and the note under it', async ({
  page,
}) => {
  const errors = await open(page, 'far')
  for (const zoom of [1, ZOOM_MAX]) {
    const pinW = await page.evaluate((id) => window.__papertie.runtime.pinWorld(id), FAR_IDS.hub)
    if (pinW === undefined) throw new Error('no hub pin')
    await setCamera(page, {
      x: pinW.x - VIEW.width / 2 / zoom + 0.37,
      y: pinW.y - VIEW.height / 3 / zoom + 0.61,
      zoom,
    })
    const pin = await page.evaluate((id) => window.__papertie.debug.pinScreen(id), FAR_IDS.hub)
    if (pin === undefined) throw new Error('no hub pin on screen')
    expect(await page.evaluate((p) => window.__papertie.debug.hitAt(p), pin)).toEqual({
      kind: 'pin',
      noteId: FAR_IDS.hub,
    })
    // The Yarn tool shows a pin to pull from.
    await armYarn(page, { ui: 'hidden' })
    await page.mouse.move(pin.x, pin.y)
    await expect(page.locator('.viewport')).toHaveAttribute('data-hover', 'pin')
    await page.mouse.move(5, VIEW.height - 5)
    await page.keyboard.press('v')

    // The smooth note (crisp edges): probes 1.5 px inside its edges hit it, 1.5 px outside miss.
    const sw = await page.evaluate((id) => {
      const n = window.__papertie.store.getState().notes.get(id)
      return n && { x: n.x + n.w / 2, y: n.y + n.h / 2 }
    }, FAR_IDS.smooth)
    if (sw === undefined) throw new Error('no smooth note')
    await setCamera(page, {
      x: sw.x - VIEW.width / 2 / zoom + 0.29,
      y: sw.y - VIEW.height / 2 / zoom + 0.83,
      zoom,
    })
    const inside = await edgeProbes(page, FAR_IDS.smooth, 1.5)
    const outside = await edgeProbes(page, FAR_IDS.smooth, -1.5)
    for (const [k, p] of inside.edges.entries()) {
      if (!onScreen(p, 2)) continue
      expect.soft(await noteAtPoint(page, p), `zoom ${zoom} inside edge ${k}`).toBe(FAR_IDS.smooth)
      const q = outside.edges[k] as Pt
      expect
        .soft(await noteAtPoint(page, q), `zoom ${zoom} outside edge ${k}`)
        .not.toBe(FAR_IDS.smooth)
    }
    await page.mouse.click(inside.centre.x, inside.centre.y)
    expect(await page.evaluate(() => [...window.__papertie.runtime.selection])).toEqual([
      FAR_IDS.smooth,
    ])
    await page.keyboard.press('Escape')

    // The drop thread's edge pin on the smooth note.
    const end = await page.evaluate(
      (id) => window.__papertie.debug.attachScreen(id, 0, 'b'),
      FAR_IDS.drop,
    )
    if (end !== undefined && onScreen(end)) {
      const hit = await page.evaluate((p) => window.__papertie.debug.hitAt(p), end)
      expect(hit).toMatchObject({ kind: 'pin', edge: { yarnId: FAR_IDS.drop, segIndex: 0 } })
    }
  }
  expect(errors).toEqual([])
})

const anchorOf = (page: Page) => page.evaluate(() => window.__papertie.debug.anchor())
const noteViewRenders = (page: Page) => page.evaluate(() => window.__papertie.renders.noteView ?? 0)

/**
 * The camera at `zoom` centred near `around`, with the anchor about `reach` to the right of it
 * (rebased far right, then to just inside the reach, then back): a pan of a few px to the left
 * crosses the reach and rebases. Returns that anchor and the reach in world px.
 */
async function armRebase(page: Page, around: Pt, zoom: number) {
  const reach = ANCHOR_REACH_PX / Math.max(1, zoom)
  const centred = (p: Pt): Cam => ({
    x: p.x - VIEW.width / 2 / zoom,
    y: p.y - VIEW.height / 2 / zoom,
    zoom,
  })
  await setCamera(page, centred({ x: around.x + 3 * reach, y: around.y }))
  await setCamera(page, centred({ x: around.x + reach - 40, y: around.y }))
  const a = await anchorOf(page)
  await setCamera(page, centred({ x: a.x - reach + 10, y: around.y }))
  expect(await anchorOf(page)).toEqual(a)
  return { a, reach }
}

const panLeft = async (page: Page, screenPx: number) => {
  const c = await page.evaluate(() => window.__papertie.debug.camera())
  await setCamera(page, { ...c, x: c.x - screenPx / c.zoom })
}

test('a pan across an anchor rebase moves every layer by exactly the pan', async ({ page }) => {
  const errors = await open(page, 'far')
  const zoom = ZOOM_MAX
  const pinW = await page.evaluate((id) => window.__papertie.runtime.pinWorld(id), FAR_IDS.hub)
  if (pinW === undefined) throw new Error('no hub pin')
  const { a } = await armRebase(page, pinW, zoom)
  // 15 screen px (7.5 world px) a step to the left: the reach is crossed at the second step.
  let prev = await sample(page)
  const renders = await noteViewRenders(page)
  let rebased = 0
  for (let k = 0; k < 10; k++) {
    await panLeft(page, 15)
    const next = await sample(page)
    if ((await anchorOf(page)).x !== a.x) rebased++
    for (const [id, n] of Object.entries(next.notes)) {
      const p = prev.notes[id]
      if (p === undefined) continue
      expect.soft(n.boxErr, `step ${k} ${id} box`).toBeLessThanOrEqual(0.5)
      expect
        .soft(Math.abs(n.box.left - p.box.left - 15), `step ${k} ${id} moved`)
        .toBeLessThan(0.51)
      expect.soft(Math.abs(n.pin.x - p.pin.x - 15), `step ${k} ${id} pin moved`).toBeLessThan(0.51)
      expect.soft(Math.abs(n.box.top - p.box.top), `step ${k} ${id} stayed`).toBeLessThan(0.01)
    }
    prev = next
  }
  expect(rebased).toBeGreaterThan(0)
  // The rebase re-placed the notes outside React: not one NoteView rendered.
  expect(await noteViewRenders(page)).toBe(renders)
  expect(errors).toEqual([])
})

const boxOf = async (page: Page, id: string) => {
  const s = await sample(page)
  const n = s.notes[id]
  if (n === undefined) throw new Error(`${id} not mounted`)
  return n
}

test('a note dragged across an anchor rebase stays under the pointer and commits once', async ({
  page,
}) => {
  const errors = await open(page, 'far')
  const sw = await page.evaluate((id) => {
    const n = window.__papertie.store.getState().notes.get(id)
    return n && { x: n.x + n.w / 2, y: n.y + n.h / 2 }
  }, FAR_IDS.smooth)
  if (sw === undefined) throw new Error('no smooth note')
  const { a } = await armRebase(page, sw, 1)
  const commits = await page.evaluate(() => window.__papertie.store.commits)
  const start = await boxOf(page, FAR_IDS.smooth)
  const grab = { x: (start.box.left + start.box.right) / 2, y: start.box.bottom - 30 }
  await page.mouse.move(grab.x, grab.y)
  await page.mouse.down()
  const held = { x: grab.x + 40, y: grab.y + 12 }
  await page.mouse.move(grab.x + 20, grab.y + 6)
  await page.mouse.move(held.x, held.y)
  await settle(page)
  const before = await boxOf(page, FAR_IDS.smooth)
  expect(before.box.left - start.box.left).toBeCloseTo(40, 0)
  // The camera pans under the still pointer, across the reach: the note keeps its place on screen.
  for (let k = 0; k < 4; k++) {
    await panLeft(page, 20)
    const now = await boxOf(page, FAR_IDS.smooth)
    expect.soft(Math.abs(now.box.left - before.box.left), `step ${k} x`).toBeLessThanOrEqual(0.5)
    expect.soft(Math.abs(now.box.top - before.box.top), `step ${k} y`).toBeLessThanOrEqual(0.5)
  }
  expect((await anchorOf(page)).x).not.toBe(a.x)
  await page.mouse.up()
  await settle(page)
  expect(await page.evaluate(() => window.__papertie.store.commits)).toBe(commits + 1)
  // Committed where it was shown, and drawn where the camera math puts it.
  const after = await boxOf(page, FAR_IDS.smooth)
  expect(after.boxErr).toBeLessThanOrEqual(0.5)
  expect(Math.abs(after.box.left - before.box.left)).toBeLessThanOrEqual(0.5)
  expect(Math.abs(after.box.top - before.box.top)).toBeLessThanOrEqual(0.5)
  expect(errors).toEqual([])
})

test('a connect dragged across an anchor rebase lands on the note under the pointer', async ({
  page,
}) => {
  const errors = await open(page, 'far')
  const pinW = await page.evaluate((id) => window.__papertie.runtime.pinWorld(id), FAR_IDS.smooth)
  if (pinW === undefined) throw new Error('no smooth pin')
  const { a } = await armRebase(page, { x: pinW.x + 300, y: pinW.y - 100 }, 1)
  const counts = () =>
    page.evaluate(() => ({
      commits: window.__papertie.store.commits,
      yarns: [...window.__papertie.store.getState().yarns.values()].map((y) => y.noteIds.join()),
    }))
  const c0 = await counts()
  const pin = await page.evaluate((id) => window.__papertie.debug.pinScreen(id), FAR_IDS.smooth)
  if (pin === undefined) throw new Error('no smooth pin on screen')
  await armYarn(page, { ui: 'hidden' })
  await page.mouse.move(pin.x, pin.y)
  await page.mouse.down()
  await page.mouse.move(pin.x + 60, pin.y - 40)
  for (let k = 0; k < 4; k++) await panLeft(page, 20)
  expect((await anchorOf(page)).x).not.toBe(a.x)
  // The tag where it is drawn now, after the rebase.
  const tag = await boxOf(page, FAR_IDS.tag)
  await page.mouse.move((tag.box.left + tag.box.right) / 2, (tag.box.top + tag.box.bottom) / 2)
  await page.mouse.up()
  await settle(page)
  const c1 = await counts()
  expect(c1.commits).toBe(c0.commits + 1)
  expect(c1.yarns.filter((y) => !c0.yarns.includes(y))).toEqual([
    `${FAR_IDS.smooth},${FAR_IDS.tag}`,
  ])
  expect(errors).toEqual([])
})
