import { loadavg } from 'node:os'
import type { Page } from '@playwright/test'
import { type Note, newId, type Op, type Yarn } from '../../packages/core/src'
import { APP_URL, apiFor, expect, test } from './helpers/app'
import { idle, saved } from './helpers/board'
import { seedBoard } from './helpers/lifetime'
import { firstRun, openBoard } from './helpers/server'

/**
 * The notes' "Tied to … by … yarn." descriptions on a dense board at lite zoom: about
 * 2,000 notes mounted at 33 %, most on two or three threads of 50 to 200 notes. A nudge held
 * down, typing below a tied note's first line and typing in an untied note recompute no
 * description; typing in a tied note's first line (its name) recomputes only the mounted
 * descriptions that list it, not every mounted note tied to it. The time the descriptions take per key (`debug.tied().spentMs`) stays far under a
 * long task's 50 ms on a quiet machine (load under 4).
 *
 * No long task (over 50 ms) on a quiet machine, at about 2,000 notes mounted (33 %) and about
 * 3,600 (16 %), in any of the watched stretches: the yarn's static layer and
 * the view's culling follow what a commit or a settling spring changed, and the patched yarn is
 * checked to be the pixels a whole redraw gives.
 */
const ZOOMS = process.env.TIED_SCALE_ZOOM ? [Number(process.env.TIED_SCALE_ZOOM)] : [0.33, 0.16]

const COLS = 60
const ROWS = 60
/** The top rows are on no thread; every row below is on a row thread and a column thread. */
const FREE_ROWS = 4
const TIED_ROWS = ROWS - FREE_ROWS
const NOW = '2026-11-01T00:00:00.000Z'

function denseBoard(): { ops: Op[]; ids: string[] } {
  const notes: Note[] = []
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      notes.push({
        type: 'note',
        id: newId('note'),
        x: c * 135,
        y: r * 95,
        w: 120,
        h: 80,
        z: r * COLS + c,
        paper: 'cream',
        style: 'rustic',
        text: `Note ${r}-${c}\nwith a second line of body text that runs on a while`,
        image: null,
        createdAt: NOW,
        updatedAt: NOW,
      })
    }
  }
  /** The note at row `r` of the tied rows, column `c`. */
  const at = (r: number, c: number) => (notes[(FREE_ROWS + r) * COLS + c] as Note).id
  const yarn = (noteIds: string[], color: Yarn['color']): Yarn => ({
    type: 'yarn',
    id: newId('yarn'),
    noteIds,
    color,
    label: '',
    createdAt: NOW,
    updatedAt: NOW,
  })
  const yarns: Yarn[] = []
  for (let r = 0; r < TIED_ROWS; r++) {
    yarns.push(
      yarn(
        Array.from({ length: COLS }, (_, c) => at(r, c)),
        'indigo',
      ),
    )
  }
  for (let c = 0; c < COLS; c++) {
    yarns.push(
      yarn(
        Array.from({ length: TIED_ROWS }, (_, r) => at(r, c)),
        'apricot',
      ),
    )
  }
  // Twelve threads of 200 (the most a thread may hold), each over fifty notes of four rows.
  for (let k = 0; k < 12; k++) {
    const ids: string[] = []
    for (let i = 0; i < 200; i++) ids.push(at((4 * k + Math.floor(i / 50)) % TIED_ROWS, i % 50))
    yarns.push(yarn(ids, 'sage'))
  }
  const ops: Op[] = [
    ...notes.map((note): Op => ({ op: 'note.create', note })),
    ...yarns.map((y): Op => ({ op: 'yarn.create', yarn: y })),
  ]
  return { ops, ids: notes.map((n) => n.id) }
}

/**
 * Long tasks from now on, and the long animation frames' scripts (what ran in them, by function:
 * a long task's cause, named without a trace).
 */
const watchLong = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __long: number[]; __frames: string[]; __watch?: () => void }
    w.__watch?.()
    w.__long = []
    w.__frames = []
    const tasks = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__long.push(Math.round(e.duration))
    })
    tasks.observe({ type: 'longtask' })
    const frames = new PerformanceObserver((list) => {
      for (const e of list.getEntries() as unknown as Array<{
        duration: number
        renderStart: number
        startTime: number
        styleAndLayoutStart: number
        scripts: Array<{ invoker: string; sourceFunctionName: string; duration: number }>
      }>) {
        if (e.duration <= 50) continue
        const scripts = e.scripts
          .map((x) => `${x.invoker} ${x.sourceFunctionName} ${Math.round(x.duration)}`)
          .join('; ')
        w.__frames.push(
          `${Math.round(e.duration)} ms (render ${Math.round(e.startTime + e.duration - e.renderStart)}, style and layout ${Math.round(e.startTime + e.duration - e.styleAndLayoutStart)}): ${scripts}`,
        )
      }
    })
    frames.observe({ type: 'long-animation-frame' })
    w.__watch = () => {
      tasks.disconnect()
      frames.disconnect()
    }
  })
const longTasks = (page: Page) =>
  page.evaluate(() => (window as unknown as { __long: number[] }).__long)
const longFrames = (page: Page) =>
  page.evaluate(() => (window as unknown as { __frames: string[] }).__frames)

/**
 * A pixel of the patched static layers further than this (of 255, premultiplied) from a whole
 * redraw's is wrong at 16 %: a thread or pin missing, or left where it was, is 100 or more.
 * Nearer, it is the GPU canvas's own there: two whole redraws of the board, before and after 30
 * nudges, differ at about 400 pixels far from the nudged note, by up to 31 (threads that lie on
 * one another rastered a step of coverage differently). At 33 % the patched layers are the very
 * bytes of a whole redraw, and nothing less is accepted there.
 */
const PIXEL_OFF = 64

/**
 * At 33 % the scattered batches' residue is stroke raster where two threads lie on one another:
 * 0–10 pixels differ over the 25 runs measured, and the patch's candidates are
 * exactly a full scan's (`yarnRenderer.test.ts`). One strand left out of one area made 52–60
 * pixels differ (3 runs). So more than this many pixels differing is a strand drawn wrong.
 */
const SCATTERED_DIFFER = 20

/**
 * The check of `patchedAsRedrawn`'s answer: byte for byte where the patch is (`exact`: at 33 %,
 * after the nudges and the drag), else no pixel further than `PIXEL_OFF`, and with `maxDiffer`
 * (the scattered batches at 33 %) no more than that many pixels differing at all: there the
 * residue is a few pixels of stroke raster (clipped against whole) where two threads lie on one
 * another, at 12–65 of 255.
 */
function expectAsRedrawn(
  zoom: number,
  what: string,
  pixels: { differ: number; off: number; max: number; pixels: number; where: string[] },
  exact: boolean,
  maxDiffer?: number,
) {
  const line =
    `the patched yarn at ${zoom * 100} % ${what}, against a whole redraw: ${pixels.differ} pixels ` +
    `differ, by ${pixels.max} of 255 at most; ${pixels.off} by more than ${PIXEL_OFF}`
  console.log(line)
  test.info().annotations.push({ type: 'pixels', description: line })
  expect(pixels.pixels).toBeGreaterThan(0)
  if (exact) expect(pixels.differ, `${what}: pixels unlike a whole redraw's`).toBe(0)
  else
    expect(
      pixels.off,
      `${what}: pixels unlike a whole redraw's, at ${pixels.where.join('; ')}`,
    ).toBe(0)
  if (maxDiffer !== undefined)
    expect(
      pixels.differ,
      `${what}: how many pixels differ from a whole redraw`,
    ).toBeLessThanOrEqual(maxDiffer)
}

/**
 * Whether the yarn's static layers (thread and pin) as the patches left them are the pixels a
 * whole redraw gives: read, then redrawn whole and read again; how many differ, by how much, and
 * where those off by more than `PIXEL_OFF` are.
 */
const patchedAsRedrawn = (page: Page) =>
  page.evaluate(async (OFF) => {
    const rt = window.__papertie.runtime as unknown as {
      yarn: {
        invalidateStatic(): void
        staticYarn: OffscreenCanvas | HTMLCanvasElement
        staticPins: OffscreenCanvas | HTMLCanvasElement
      }
      requestYarn(): void
    }
    const read = () =>
      [rt.yarn.staticYarn, rt.yarn.staticPins].map((c) =>
        (c.getContext('2d') as CanvasRenderingContext2D).getImageData(0, 0, c.width, c.height),
      )
    const next = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    await next()
    const patched = read()
    rt.yarn.invalidateStatic()
    rt.requestYarn()
    await next()
    const whole = read()
    // Compared premultiplied (as the canvas holds them): a pixel almost clear says little of its
    // colour, so its read-back colour can jump by half the range for one step of coverage.
    let differ = 0
    let off = 0
    let max = 0
    let pixels = 0
    const where: string[] = []
    patched.forEach((a, k) => {
      const b = whole[k] as ImageData
      pixels += a.width * a.height
      for (let i = 0; i < a.data.length; i += 4) {
        const aa = a.data[i + 3] as number
        const ba = b.data[i + 3] as number
        let d = Math.abs(aa - ba)
        for (let c = 0; c < 3; c++) {
          const pa = ((a.data[i + c] as number) * aa) / 255
          const pb = ((b.data[i + c] as number) * ba) / 255
          d = Math.max(d, Math.abs(pa - pb))
        }
        if (d < 1) continue
        differ++
        max = Math.max(max, d)
        if (d <= OFF) continue
        off++
        const p = i >> 2
        if (where.length < 8)
          where.push(`${k === 0 ? 'yarn' : 'pins'} ${p % a.width},${Math.floor(p / a.width)}`)
      }
    })
    return { differ, off, max: Math.round(max), pixels, where }
  }, PIXEL_OFF)

/** The descriptions' work so far, read after the next frame (what a key changed has rendered). */
const tiedWork = (page: Page) =>
  page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    return window.__papertie.debug.tied()
  })

/** Press `key` `times` times; the most description time one press took, and what it computed. */
async function pressEach(page: Page, key: string, times: number) {
  let worst = 0
  const start = await tiedWork(page)
  for (let i = 0; i < times; i++) {
    const before = await tiedWork(page)
    await page.keyboard.press(key)
    const after = await tiedWork(page)
    worst = Math.max(worst, after.spentMs - before.spentMs)
  }
  const end = await tiedWork(page)
  return { worstMs: worst, computed: end.computed - start.computed }
}

for (const ZOOM of ZOOMS)
  test(`the tied descriptions keep a dense lite view’s keys cheap, at ${ZOOM * 100} %`, async ({
    page,
  }) => {
    test.setTimeout(300_000)
    await firstRun(apiFor(page))
    const { ops, ids } = denseBoard()
    const boardId = await seedBoard(apiFor(page), ops)
    // TIED_SCALE_CPU=1: the yarn's static canvases on CPU raster (the test-only switch).
    if (process.env.TIED_SCALE_CPU === '1')
      await page.addInitScript(() => {
        ;(globalThis as { __papertieTest?: unknown }).__papertieTest = { yarnCpuRaster: true }
      })
    // Opened where it was left: the dense top left, at lite zoom.
    await page.goto(`${APP_URL}/api/health`)
    await page.evaluate(
      ([key, zoom]) =>
        localStorage.setItem(key as string, JSON.stringify({ x: -20, y: -20, zoom })),
      [`papertie.camera.${boardId}`, ZOOM] as const,
    )
    await openBoard(page)
    await saved(page)
    await idle(page)
    expect(await page.evaluate(() => window.__papertie.debug.lod())).toBe('lite')
    const mounted = await page.locator('article.note').count()
    expect(mounted).toBeGreaterThan(ZOOM < 0.2 ? 2500 : 1200)
    await page.waitForTimeout(1000)

    // Both in view at the top left: a free note, and one on two threads and one of the 200s.
    const untied = ids[2 * COLS + 6] as string
    const tied = ids[(FREE_ROWS + 3) * COLS + 6] as string
    const noteOf = (id: string) => page.locator(`article.note[data-note-id="${id}"]`)
    /** The mounted notes that share a thread with `id`. */
    const tiedToIt = (id: string) =>
      page.evaluate((id) => {
        const others = new Set<string>()
        for (const y of window.__papertie.store.getState().yarns.values()) {
          if (y.noteIds.includes(id)) for (const m of y.noteIds) if (m !== id) others.add(m)
        }
        return [...document.querySelectorAll<HTMLElement>('article.note')].filter((el) =>
          others.has(el.dataset.noteId ?? ''),
        ).length
      }, id)
    const results: Record<
      string,
      { worstMs: number; computed: number; long: number[]; frames: string[] }
    > = {}

    // A nudge held down on a tied note.
    await noteOf(tied).focus()
    await watchLong(page)
    const nudged = await pressEach(page, 'Shift+Alt+ArrowRight', 30)
    await idle(page)
    results.nudge = { ...nudged, long: await longTasks(page), frames: await longFrames(page) }
    // The yarn's static layer followed the nudges and the springs by patches: the same pixels as
    // a whole redraw.
    expectAsRedrawn(ZOOM, 'after the nudges', await patchedAsRedrawn(page), ZOOM >= 0.3)

    // A drag's live drawing in lite, as the drag tools set it (`setDynamicNotes`, which a press
    // can't reach here: at this zoom a tied note's paper is all within reach of its threads, so a
    // press takes a thread). Its pin and threads leave the cache by a patch while it is live, and
    // go back by a patch when it is dropped.
    const dragged = ids[(FREE_ROWS + 9) * COLS + 9] as string
    // The check above (a whole redraw, then reading and comparing two layers in a frame's
    // callback: about 50 ms of the test's own) has ended before the watching starts.
    await page.waitForTimeout(500)
    await watchLong(page)
    await page.evaluate(async (id) => {
      const rt = window.__papertie.runtime as unknown as {
        setDynamicNotes(ids: Iterable<string>): void
      }
      const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)))
      rt.setDynamicNotes([id])
      for (let f = 0; f < 10; f++) await frame()
      rt.setDynamicNotes([])
      for (let f = 0; f < 4; f++) await frame()
    }, dragged)
    await idle(page)
    results['a drag drawn live'] = {
      worstMs: 0,
      computed: 0,
      long: await longTasks(page),
      frames: await longFrames(page),
    }
    expectAsRedrawn(ZOOM, 'after a drag drawn live', await patchedAsRedrawn(page), ZOOM >= 0.3)

    // A batch of moves in one commit, of notes scattered over the view, ten times: each about
    // 250 segments and pins to patch, in many places at once.
    const scattered = [2, 8, 14].flatMap((r) =>
      [3, 12, 21].map((c) => ids[(FREE_ROWS + r) * COLS + c] as string),
    )
    await page.waitForTimeout(500)
    await watchLong(page)
    // Count the frames whose yarn render patched its cache, and those that redrew it whole.
    await page.evaluate(() => {
      const y = (
        window.__papertie.runtime as unknown as {
          yarn: { render(i: unknown): { patched?: unknown; staticRedrawn: boolean } }
        }
      ).yarn
      const w = window as unknown as { __renders: { patched: number; whole: number } }
      w.__renders = { patched: 0, whole: 0 }
      const was = y.render.bind(y)
      y.render = (i) => {
        const out = was(i)
        if (out.patched !== undefined) w.__renders.patched++
        if (out.staticRedrawn) w.__renders.whole++
        return out
      }
    })
    for (let k = 0; k < 10; k++) {
      await page.evaluate(async (chosen) => {
        const m = window.__papertie as unknown as {
          store: {
            getState(): { notes: Map<string, { x: number }> }
            commit(ops: unknown[]): void
          }
        }
        const notes = m.store.getState().notes
        m.store.commit(
          chosen.map((id) => ({
            op: 'note.update',
            id,
            set: { x: (notes.get(id)?.x ?? 0) + 3 },
          })),
        )
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      }, scattered)
    }
    await idle(page)
    results['a scattered batch'] = {
      worstMs: 0,
      computed: 0,
      long: await longTasks(page),
      frames: await longFrames(page),
    }
    // Patched, not redrawn whole (more than 256 things, or 40 % of the layer, would redraw).
    const renders = await page.evaluate(
      () => (window as unknown as { __renders: { patched: number; whole: number } }).__renders,
    )
    expect(renders.patched).toBeGreaterThanOrEqual(10)
    expect(renders.whole).toBe(0)
    expectAsRedrawn(
      ZOOM,
      'after the scattered batches',
      await patchedAsRedrawn(page),
      false,
      ZOOM >= 0.3 ? SCATTERED_DIFFER : undefined,
    )

    const write = async (id: string, where: 'name' | 'body', what: string) => {
      await noteOf(id).focus()
      await page.keyboard.press('Enter')
      await expect(page.locator('[contenteditable]').first()).toBeFocused()
      await page.keyboard.press(
        where === 'name' ? 'ControlOrMeta+ArrowUp' : 'ControlOrMeta+ArrowDown',
      )
      await watchLong(page)
      let worst = 0
      let computed = 0
      for (const ch of 'words') {
        const r = await pressEach(page, ch, 1)
        worst = Math.max(worst, r.worstMs)
        computed += r.computed
      }
      results[what] = {
        worstMs: worst,
        computed,
        long: await longTasks(page),
        frames: await longFrames(page),
      }
      await page.keyboard.press('Escape')
      await idle(page)
    }
    await write(tied, 'body', 'typing below a tied note’s name')
    await write(untied, 'name', 'typing an untied note’s name')
    const neighbours = await tiedToIt(tied)
    await write(tied, 'name', 'typing a tied note’s name')

    const load = (loadavg()[0] ?? 0).toFixed(2)
    for (const [what, r] of Object.entries(results)) {
      console.log(
        `${what} at ${mounted} mounted lite notes: descriptions ${r.computed} computed, worst key ` +
          `${r.worstMs.toFixed(2)} ms of description work; long tasks [${r.long.join(', ')}], load ${load}` +
          (r.frames.length > 0 ? `; long frames: ${r.frames.join(' | ')}` : ''),
      )
    }
    expect(results.nudge?.computed).toBe(0)
    expect(results['typing below a tied note’s name']?.computed).toBe(0)
    expect(results['typing an untied note’s name']?.computed).toBe(0)
    // Each key of the name tells only the descriptions that list it (five notes a colour), never
    // all the mounted notes tied to it.
    expect(neighbours).toBeGreaterThan(50)
    const renamed = results['typing a tied note’s name']?.computed ?? 0
    expect(renamed).toBeGreaterThan(0)
    expect(renamed).toBeLessThan(5 * neighbours)
    if ((loadavg()[0] ?? 0) < 4) {
      for (const [what, r] of Object.entries(results)) {
        expect(r.worstMs).toBeLessThan(16)
        expect(r.long, `long tasks, ${what}: ${r.frames.join(' | ')}`).toEqual([])
      }
    } else test.info().annotations.push({ type: 'warning', description: `timed at load ${load}` })
  })
