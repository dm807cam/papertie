import { expect, type Page, test } from '@playwright/test'
import { DEMO_IDS, DEMO_MOCKUP } from '../apps/web/src/dev/demoBoard'
import type { Cam, Pt } from './hooks'

const VIEW = { width: 1280, height: 720 }
test.use({ viewport: VIEW })

const HUB = DEMO_IDS.hub
/** The demo's loose note at (80, 120); threaded to `print`, the pair spans open cork. */
const LOOSE = `note_01JBDEM0${'12'.padStart(18, '0')}`
const PAIR = [LOOSE, DEMO_IDS.print] as const

async function open(page: Page, cam: Cam) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await page.goto('/bench?board=demo')
  await page.waitForFunction(() => window.__papertie?.ready === true)
  await page.evaluate((c) => window.__papertie.debug.setCamera(c), cam)
  await idle(page)
  return errors
}

/** The hub centred at zoom 1. */
const HUB_CAM: Cam = { x: 1180 - VIEW.width / 2, y: 660 - VIEW.height / 2, zoom: 1 }
/** The top-left of the board, where `PAIR` is threaded. */
const PAIR_CAM: Cam = { x: 0, y: 0, zoom: 1 }

const idle = (page: Page) =>
  page.waitForFunction(() => window.__papertie.runtime.loop.running === false)

const motion = (page: Page) => page.evaluate(() => window.__papertie.debug.motion())

/** A point on the hub's paper, below its pin and threads. */
async function grabPoint(page: Page): Promise<Pt> {
  const b = await page.locator(`article.note[data-note-id="${HUB}"]`).boundingBox()
  if (b === null) throw new Error('hub has no box')
  return { x: b.x + b.width / 2, y: b.y + b.height * 0.7 }
}

/** Drag the hub by (dx, dy) and release. */
async function dragHub(page: Page, dx: number, dy: number) {
  const p = await grabPoint(page)
  await page.mouse.move(p.x, p.y)
  await page.mouse.down()
  await page.mouse.move(p.x + dx, p.y + dy, { steps: 12 })
  await page.mouse.up()
}

/** Collect `awakeCount` on every frame while `during` runs, plus two frames after. */
async function sampleAwake(page: Page, during: () => Promise<void>): Promise<number[]> {
  await page.evaluate(() => {
    const w = window as unknown as { __awake: number[]; __sampling: boolean }
    w.__awake = []
    w.__sampling = true
    const tick = () => {
      if (!w.__sampling) return
      w.__awake.push(window.__papertie.debug.motion().awakeCount)
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  await during()
  return page.evaluate(async () => {
    const w = window as unknown as { __awake: number[]; __sampling: boolean }
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
    w.__sampling = false
    w.__awake.push(window.__papertie.debug.motion().awakeCount)
    return w.__awake
  })
}

test('a new thread draws in over 350 ms, then the loop goes idle within 1 s', async ({ page }) => {
  const errors = await open(page, PAIR_CAM)
  const r = await page.evaluate(
    ([a, b]) =>
      new Promise<{ mid: number; end: number; idleAt: number; animations: number }>((resolve) => {
        const h = window.__papertie
        const id = h.debug.createYarn(a, b)
        const t0 = performance.now()
        let mid = Number.NaN
        let end = Number.NaN
        const tick = () => {
          const e = performance.now() - t0
          if (Number.isNaN(mid) && e >= 175) mid = h.debug.drawInProgress(id)
          if (Number.isNaN(end) && e >= 400) end = h.debug.drawInProgress(id)
          const quiet = h.debug.motion().activeAnimations === 0 && !h.runtime.loop.running
          if ((!Number.isNaN(end) && quiet) || e > 2000) {
            resolve({ mid, end, idleAt: e, animations: h.debug.motion().activeAnimations })
            return
          }
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }),
    PAIR,
  )
  expect(r.mid).toBeGreaterThan(0.3)
  expect(r.mid).toBeLessThan(1)
  expect(r.end).toBe(1)
  expect(r.animations).toBe(0)
  expect(r.idleAt).toBeLessThanOrEqual(1000)
  expect(errors).toEqual([])
})

test('a deleted thread loosens and fades: visible at 50 ms, gone at 260 ms', async ({ page }) => {
  const errors = await open(page, PAIR_CAM)
  const id = await page.evaluate(([a, b]) => window.__papertie.debug.createYarn(a, b), PAIR)
  await idle(page)
  // The vertical column from the rest midpoint down past the loosened midpoint.
  const column = await page.evaluate((id) => {
    const d = window.__papertie.debug
    const mid = d.yarnPointScreen(id, 0, 0.5)
    // The thread hangs between its two edge pins.
    const pa = d.attachScreen(id, 0, 'a')
    const pb = d.attachScreen(id, 0, 'b')
    if (!mid || !pa || !pb) throw new Error('no geometry')
    const restSag = mid.y - (pa.y + pb.y) / 2
    return { x: mid.x, y0: mid.y, y1: mid.y + 0.6 * restSag + 4, restSag }
  }, id)
  expect(column.restSag).toBeGreaterThan(20)

  const r = await page.evaluate(
    ({ id, column }) => {
      const canvas = document.querySelector('canvas.yarn-layer') as HTMLCanvasElement
      const ctx = canvas.getContext('2d') as CanvasRenderingContext2D
      const maxAlpha = () => {
        const d = devicePixelRatio
        const x = Math.floor(column.x * d) - 1
        const y = Math.floor(column.y0 * d)
        const h = Math.ceil((column.y1 - column.y0) * d)
        const px = ctx.getImageData(x, y, 3, h).data
        let max = 0
        for (let i = 3; i < px.length; i += 4) max = Math.max(max, px[i] ?? 0)
        return max
      }
      const before = maxAlpha()
      window.__papertie.debug.deleteYarn(id)
      const t0 = performance.now()
      return new Promise<{ before: number; at50: number; at260: number; t50: number }>(
        (resolve) => {
          let at50 = -1
          let t50 = 0
          const tick = () => {
            const e = performance.now() - t0
            if (at50 < 0 && e >= 50) {
              at50 = maxAlpha()
              t50 = e
            }
            if (e >= 260) {
              resolve({ before, at50, at260: maxAlpha(), t50 })
              return
            }
            requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        },
      )
    },
    { id, column },
  )
  expect(r.before).toBeGreaterThan(0)
  expect(r.t50).toBeLessThan(120)
  expect(r.at50).toBeGreaterThan(0)
  expect(r.at260).toBe(0)
  expect(await page.evaluate((id) => window.__papertie.store.getState().notes.has(id), LOOSE)).toBe(
    true,
  )
  await idle(page)
  expect(await motion(page)).toEqual({ awakeCount: 0, activeAnimations: 0 })
  expect(errors).toEqual([])
})

test('after a drag the threads swing on, then the loop stops within 700 ms', async ({ page }) => {
  const errors = await open(page, HUB_CAM)
  // Count the yarn frames, and those that redrew the static cache, from the release on.
  await page.evaluate(() => {
    const w = window as unknown as { __renders: { all: number; redraws: number } }
    const r = (window.__papertie.runtime as unknown as { yarn: { render(i: unknown): unknown } })
      .yarn
    const render = r.render.bind(r)
    w.__renders = { all: 0, redraws: 0 }
    r.render = (i) => {
      const stats = render(i) as { staticRedrawn: boolean }
      w.__renders.all++
      if (stats.staticRedrawn) w.__renders.redraws++
      return stats
    }
  })
  await dragHub(page, 220, 60)
  const awake = await page.evaluate(() => {
    const w = window as unknown as { __t0: number; __renders: { all: number; redraws: number } }
    w.__t0 = performance.now()
    w.__renders = { all: 0, redraws: 0 }
    return window.__papertie.debug.motion().awakeCount
  })
  expect(awake).toBeGreaterThan(0)
  const stoppedAfter = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const t0 = (window as unknown as { __t0: number }).__t0
        const tick = () => {
          const e = performance.now() - t0
          if (!window.__papertie.runtime.loop.running || e > 2000) resolve(e)
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }),
  )
  expect(stoppedAfter).toBeLessThanOrEqual(700)
  expect(await motion(page)).toEqual({ awakeCount: 0, activeAnimations: 0 })
  // The settling threads draw live; the static cache is redrawn for the commit and once more
  // when they all rest, not on every frame or per spring.
  const renders = await page.evaluate(
    () => (window as unknown as { __renders: { all: number; redraws: number } }).__renders,
  )
  expect(renders.all).toBeGreaterThan(5)
  expect(renders.redraws).toBeLessThanOrEqual(2)
  expect((await page.evaluate(() => window.__papertie.debug.stats())).segmentsDynamic).toBe(0)
  expect(errors).toEqual([])
})

/** Springs snap on every frame of a drag, and a new thread fades in by 120 ms. */
async function expectReducedMotion(page: Page) {
  const samples = await sampleAwake(page, () => dragHub(page, 200, 50))
  expect(samples.length).toBeGreaterThan(5)
  expect(samples.every((n) => n === 0)).toBe(true)
  await idle(page)

  const r = await page.evaluate(
    ([a, b]) =>
      new Promise<{ first: number; firstAlpha: number; at120: number; progress120: number }>(
        (resolve) => {
          const h = window.__papertie
          const id = h.debug.createYarn(a, b)
          const first = h.debug.drawInProgress(id)
          const firstAlpha = h.runtime.motion.alphaOf(id)
          const t0 = performance.now()
          const tick = () => {
            if (performance.now() - t0 >= 120) {
              resolve({
                first,
                firstAlpha,
                at120: h.runtime.motion.alphaOf(id),
                progress120: h.debug.drawInProgress(id),
              })
            } else requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        },
      ),
    [HUB, LOOSE] as const,
  )
  expect(r.first).toBe(1)
  expect(r.firstAlpha).toBeLessThan(1)
  expect(r.at120).toBe(1)
  expect(r.progress120).toBe(1)
  await idle(page)
  expect(await motion(page)).toEqual({ awakeCount: 0, activeAnimations: 0 })
}

test('prefers-reduced-motion (flipped live): springs snap and draw-in is a fade', async ({
  page,
}) => {
  const errors = await open(page, HUB_CAM)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await expectReducedMotion(page)
  expect(errors).toEqual([])
})

test("the 'reduced' motion pref wins over a no-preference system", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.addInitScript(() => {
    localStorage.setItem('papertie.prefs', JSON.stringify({ motion: 'reduced' }))
  })
  const errors = await open(page, HUB_CAM)
  await expectReducedMotion(page)
  expect(errors).toEqual([])
})

/** Counts the page's own `requestAnimationFrame` callbacks from the first script on. */
const COUNT_RAF = () => {
  const w = window as unknown as { __rafCalls: number }
  w.__rafCalls = 0
  const raf = window.requestAnimationFrame.bind(window)
  window.requestAnimationFrame = (cb) =>
    raf((t) => {
      w.__rafCalls++
      cb(t)
    })
}

test('the board is idle when nothing moves: no frame callback for 3 s', async ({ page }) => {
  await page.addInitScript(COUNT_RAF)
  const errors = await open(page, HUB_CAM)
  // 2 s with no input: the opening, the fonts and every settle are over.
  await page.waitForTimeout(2000)
  await idle(page)
  const before = await page.evaluate(() => (window as unknown as { __rafCalls: number }).__rafCalls)
  expect(before).toBeGreaterThan(0)
  await page.waitForTimeout(3000)
  const after = await page.evaluate(() => (window as unknown as { __rafCalls: number }).__rafCalls)
  expect(after - before).toBe(0)
  expect(await motion(page)).toEqual({ awakeCount: 0, activeAnimations: 0 })
  expect(errors).toEqual([])
})

const STAMP_DESIGN = {
  paper: 'cream',
  style: 'rustic',
  decoration: 'stamp',
  sheet: 'rose',
} as const

/** Pin a stamp note at the view's centre; its seal's animations as they stand. */
async function pinStamp(page: Page) {
  return page.evaluate((design) => {
    const id = window.__papertie.runtime.createNoteAtCentre(design)
    if (id === undefined) throw new Error('no note')
    return id
  }, STAMP_DESIGN)
}

const seal = (page: Page, id: string) =>
  page.locator(`article.note[data-note-id="${id}"] .note-stamp`)

/** The seal's running animations: name, duration, easing and its first keyframe. */
const sealAnimations = (page: Page, id: string) =>
  seal(page, id).evaluate((el) =>
    el.getAnimations().map((a) => {
      const effect = a.effect as KeyframeEffect
      const t = effect.getComputedTiming()
      const first = (effect.getKeyframes()[0] ?? {}) as ComputedKeyframe
      return {
        name: (a as CSSAnimation).animationName,
        duration: Number(t.duration),
        // A CSS animation's curve is its keyframes'.
        easing: String(first.easing),
        from: { transform: String(first.transform), opacity: String(first.opacity) },
      }
    }),
  )

const restingSeal = (page: Page, id: string) =>
  seal(page, id).evaluate((el) => {
    const cs = getComputedStyle(el)
    return { opacity: cs.opacity, transform: cs.transform, scale: cs.scale }
  })

/** Records every note whose seal starts the stamp, from the first script on. */
const COUNT_STAMPS = () => {
  const w = window as unknown as { __stamps: string[] }
  w.__stamps = []
  document.addEventListener(
    'animationstart',
    (e) => {
      if (e.animationName !== 'stamp-press') return
      const note = (e.target as Element).closest('article.note') as HTMLElement | null
      w.__stamps.push(note?.dataset.noteId ?? '?')
    },
    true,
  )
}
const stamps = (page: Page) =>
  page.evaluate(() => [...(window as unknown as { __stamps: string[] }).__stamps])

test('a newly pinned stamp presses in over 320 ms: 1.04 to 1, its ink 0.85 to full', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem('papertie.prefs', JSON.stringify({ motion: 'full' }))
  })
  await page.addInitScript(COUNT_STAMPS)
  const errors = await open(page, PAIR_CAM)
  // A stamp already on the board never stamps: the mockup's centre note carries one.
  await page.evaluate((n) => window.__papertie.debug.focusCamera(n, 1), DEMO_MOCKUP.centre)
  await idle(page)
  await expect(seal(page, DEMO_MOCKUP.centre)).toHaveCount(1)
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  )
  expect(await stamps(page)).toEqual([])
  await page.evaluate((c) => window.__papertie.debug.setCamera(c), PAIR_CAM)
  await idle(page)

  const id = await pinStamp(page)
  await expect(seal(page, id)).toHaveCount(1)
  const anims = await sealAnimations(page, id)
  expect(anims).toHaveLength(1)
  expect(anims[0]?.name).toBe('stamp-press')
  expect(anims[0]?.duration).toBe(320)
  expect(anims[0]?.easing).toBe('cubic-bezier(0.2, 0.8, 0.2, 1)')
  // Mid-press, held at 100 ms of the 320: larger than at rest and lighter.
  const mid = await seal(page, id).evaluate((el) => {
    const a = el.getAnimations()[0] as Animation
    a.pause()
    a.currentTime = 100
    const cs = getComputedStyle(el)
    const out = { scale: Number.parseFloat(cs.scale), opacity: Number.parseFloat(cs.opacity) }
    a.play()
    return out
  })
  expect(mid.scale).toBeGreaterThan(1)
  expect(mid.scale).toBeLessThan(1.04)
  expect(mid.opacity).toBeLessThan(0.92)
  expect(mid.opacity).toBeGreaterThan(0.782)
  // At rest once it has run: no animation left, the seal at its own ink.
  await seal(page, id).evaluate((el) =>
    Promise.all(el.getAnimations().map((a) => a.finished)).then(() => undefined),
  )
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(undefined))))
  expect(await sealAnimations(page, id)).toEqual([])
  const after = await restingSeal(page, id)
  expect(after.scale).toBe('none')
  expect(Number.parseFloat(after.opacity)).toBeCloseTo(0.92, 2)
  expect(Number.parseFloat(String(anims[0]?.from.opacity))).toBeCloseTo(
    0.85 * Number.parseFloat(after.opacity),
    2,
  )
  expect(await stamps(page)).toEqual([id])

  // Scrolled away and back, the same note mounts again: it does not stamp twice. (Written on
  // first: a new note left blank goes when its writing ends.)
  await page.keyboard.type('Sealed')
  await page.keyboard.press('Escape')
  await expect(page.locator(`article.note[data-note-id="${id}"]`)).toContainText('Sealed')
  await page.evaluate(() => window.__papertie.debug.setCamera({ x: 40_000, y: 40_000, zoom: 1 }))
  await expect(seal(page, id)).toHaveCount(0)
  await page.evaluate((c) => window.__papertie.debug.setCamera(c), PAIR_CAM)
  await expect(seal(page, id)).toHaveCount(1)
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  )
  expect(await sealAnimations(page, id)).toEqual([])
  expect(await stamps(page)).toEqual([id])
  expect(errors).toEqual([])
})

test("with the 'reduced' motion pref a new stamp is there at once", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('papertie.prefs', JSON.stringify({ motion: 'reduced' }))
  })
  const errors = await open(page, PAIR_CAM)
  const id = await pinStamp(page)
  await expect(seal(page, id)).toHaveCount(1)
  // Within 100 ms of being pinned the seal stands at rest.
  await page.waitForTimeout(100)
  expect((await sealAnimations(page, id)).every((a) => a.duration <= 100)).toBe(true)
  const r = await restingSeal(page, id)
  expect(r.scale).toBe('none')
  expect(Number.parseFloat(r.opacity)).toBeCloseTo(0.92, 2)
  expect(errors).toEqual([])
})

test('a pressed note lifts 1 px and its shadow deepens over 120 ms; nothing else is touched', async ({
  page,
}) => {
  const errors = await open(page, HUB_CAM)
  const hub = page.locator(`article.note[data-note-id="${HUB}"]`)
  // Already selected, so the press itself is all that changes.
  await page.evaluate((id) => window.__papertie.runtime.selectNote(id), HUB)
  await idle(page)
  const p = await grabPoint(page)
  await page.mouse.move(p.x, p.y)
  // Watch the world: every attribute or child change from the press on, and NoteView's renders.
  await page.evaluate(() => {
    const w = window as unknown as { __touched: Set<string>; __renders0: number }
    w.__touched = new Set()
    w.__renders0 = window.__papertie.renders.noteView ?? 0
    const world = document.querySelector('.world') as HTMLElement
    new MutationObserver((list) => {
      for (const m of list) {
        const t = m.target instanceof Element ? m.target : m.target.parentElement
        const note = t?.closest('article.note') as HTMLElement | null
        w.__touched.add(note?.dataset.noteId ?? (t === world ? 'world' : 'other'))
      }
    }).observe(world, { attributes: true, childList: true, subtree: true, characterData: true })
  })
  await page.mouse.down()
  await expect(hub).toHaveAttribute('data-pressed', '')
  // Over the fast token: lifted, the deeper shadow fully in.
  await page.waitForTimeout(200)
  const lifted = await hub.evaluate((el) => ({
    box: getComputedStyle(el).translate,
    translate: getComputedStyle(el.querySelector('.note-paper') as Element).translate,
    deep: getComputedStyle(el.querySelector('.note-shadow') as Element, '::after').opacity,
    deepShadow: getComputedStyle(el.querySelector('.note-shadow') as Element, '::after').boxShadow,
  }))
  // The paper rises off its shadow; the note's own box stays where it is.
  expect(lifted.translate).toBe('0px -1px')
  expect(lifted.box).toBe('none')
  expect(lifted.deep).toBe('1')
  expect(lifted.deepShadow).not.toBe('none')
  const during = await page.evaluate(() => {
    const w = window as unknown as { __touched: Set<string>; __renders0: number }
    return {
      touched: [...w.__touched],
      renders: (window.__papertie.renders.noteView ?? 0) - w.__renders0,
    }
  })
  // The press touched the pressed note's attribute only, and rendered no note.
  expect(during.touched).toEqual([HUB])
  expect(during.renders).toBe(0)
  await page.mouse.up()
  await expect(hub).not.toHaveAttribute('data-pressed', '')
  await page.waitForTimeout(200)
  expect(
    await hub.evaluate(
      (el) => getComputedStyle(el.querySelector('.note-paper') as Element).translate,
    ),
  ).toBe('none')
  expect(errors).toEqual([])
})
