import AxeBuilder from '@axe-core/playwright'
import type { Locator, Page } from '@playwright/test'
import { readZip } from '../../apps/server/test/helpers/zip'
import type { Pt } from '../hooks'
import { armYarn, yarnPicker } from '../yarnTool'
import { APP_URL, apiFor, download, expect, test } from './helpers/app'
import { idle, noteEl, paperPoint, pin, saved } from './helpers/board'
import {
  boardIds,
  exportJsonl,
  firstRun,
  onlyBoard,
  openBoard,
  serverBoard,
  waitReady,
} from './helpers/server'

/**
 * The first hour with Papertie, in the built app: open on the welcome note,
 * pin a note of a chosen paper and motif with "+", write, move and resize it, paste a photo, wind
 * a thread, reload, delete and undo, focus and leave focus, export, run axe on the board and
 * Settings, and delete all data.
 */

const WELCOME = 'Use + to pin a thought'

/** The board as the page holds it: what the board file has once the save dot rests. */
const localNotes = (page: Page) =>
  page.evaluate(() =>
    Object.fromEntries(
      [...window.__papertie.store.getState().notes.entries()].map(([id, n]) => {
        const { x, y, w, h, text, paper, motif, image } = n as unknown as {
          x: number
          y: number
          w: number
          h: number
          text: string
          paper: string
          motif?: string
          image: { assetId: string } | null
        }
        return [id, { x, y, w, h, text, paper, motif, asset: image?.assetId ?? null }]
      }),
    ),
  )

const localYarns = (page: Page) =>
  page.evaluate(() =>
    [...window.__papertie.store.getState().yarns.values()].map((y) => [...y.noteIds]),
  )

/** A spot of bare cork in the view, at least `clear` px from every note. */
async function bareCork(page: Page, clear = 120): Promise<Pt> {
  const p = await page.evaluate((clear) => {
    const boxes = [...document.querySelectorAll('article.note .note-paper')].map((el) =>
      el.getBoundingClientRect(),
    )
    for (let y = 160; y < innerHeight - 160; y += 40) {
      for (let x = 260; x < innerWidth - 200; x += 40) {
        const far = boxes.every(
          (b) =>
            x < b.left - clear || x > b.right + clear || y < b.top - clear || y > b.bottom + clear,
        )
        if (far && window.__papertie.debug.hitAt({ x, y }).kind === 'none') return { x, y }
      }
    }
    return null
  }, clear)
  if (p === null) throw new Error('no bare cork in view')
  return p
}

/**
 * A new note from "+" (its design chosen in the picker by `choose`), pinned at the middle of the
 * view, written on, and then hung at `at` on bare cork.
 */
async function pinNote(
  page: Page,
  text: string,
  at: Pt,
  choose: (picker: Locator) => Promise<void> = async () => {},
): Promise<string> {
  const before = Object.keys(await localNotes(page))
  await page
    .getByRole('toolbar', { name: 'Tools' })
    .getByRole('button', { name: 'New note' })
    .click()
  const picker = page.getByRole('dialog', { name: 'New note' })
  await choose(picker)
  await picker.getByRole('button', { name: 'Pin note' }).click()
  await expect(page.locator('[contenteditable]').first()).toBeFocused()
  await page.keyboard.type(text)
  await page.keyboard.press('Escape')
  await idle(page)
  const id = Object.keys(await localNotes(page)).find((k) => !before.includes(k))
  if (id === undefined) throw new Error('no new note')
  const grab = await paperPoint(page, id)
  await page.mouse.move(grab.x, grab.y)
  await page.mouse.down()
  await page.mouse.move(at.x, at.y, { steps: 12 })
  await page.mouse.up()
  await idle(page)
  return id
}

/** Serious and critical axe findings on the page as it is now. */
async function axeSerious(page: Page) {
  const { violations } = await new AxeBuilder({ page }).setLegacyMode().analyze()
  return violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map((n) => n.target.join(' ')) }))
}

/** A small PNG drawn in the page, pasted onto the board as a screenshot would be. */
const pastePng = (page: Page) =>
  page.evaluate(async () => {
    const c = document.createElement('canvas')
    c.width = 320
    c.height = 200
    const g = c.getContext('2d') as CanvasRenderingContext2D
    g.fillStyle = '#2e4b7a'
    g.fillRect(0, 0, 320, 200)
    g.fillStyle = '#f4dedc'
    g.beginPath()
    g.arc(160, 100, 60, 0, Math.PI * 2)
    g.fill()
    const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b as Blob), 'image/png'))
    const dt = new DataTransfer()
    dt.items.add(new File([blob], 'screenshot.png', { type: 'image/png' }))
    ;(document.activeElement as HTMLElement | null)?.blur()
    document.body.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
    )
  })

test('a first run: write, pin a photo, wind a thread, reload, focus, export, delete all data', async ({
  page,
}) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  // 1. A first run: the board opens on the welcome note, with no sign-in of any kind.
  await firstRun(apiFor(page))
  await page.goto(`${APP_URL}/`)
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('article', { name: WELCOME })).toBeVisible()
  const boardId = await onlyBoard(apiFor(page))

  await openBoard(page)
  await saved(page)
  // A new board opens at 100 %, its lone welcome note not blown up to fill the view.
  expect(await page.evaluate(() => window.__papertie.debug.camera().zoom)).toBe(1)
  const welcome = (await page.locator('article.note').first().getAttribute('data-note-id')) ?? ''
  expect(Object.keys(await localNotes(page))).toEqual([welcome])

  // 2. A note from "+" on rose paper with the fold decoration (its design for good):
  // write on it, hang it on bare cork, move it and resize it.
  const at = await bareCork(page)
  const paris = await pinNote(page, 'Morning in Paris', at, async (picker) => {
    await picker.getByRole('radio', { name: 'Rose' }).first().check()
    await picker
      .getByRole('group', { name: 'Decoration' })
      .getByRole('radio', { name: 'Fold' })
      .check()
  })
  expect((await localNotes(page))[paris]?.text).toBe('Morning in Paris')
  await expect(noteEl(page, paris)).toHaveAttribute('data-paper', 'rose')
  await expect(noteEl(page, paris)).toHaveAttribute('data-motif', 'fold')

  const placed = (await localNotes(page))[paris]
  const zoom = await page.evaluate(() => window.__papertie.debug.camera().zoom)
  const grab = await paperPoint(page, paris)
  await page.mouse.move(grab.x, grab.y)
  await page.mouse.down()
  await page.mouse.move(grab.x + 120, grab.y + 60, { steps: 12 })
  await page.mouse.up()
  await expect
    .poll(async () => (await localNotes(page))[paris]?.x)
    .toBeCloseTo((placed?.x ?? 0) + 120 / zoom, 0)

  await page.mouse.click(grab.x + 120, grab.y + 60)
  const handle = page.locator(`.overlay .selection[data-note-id="${paris}"] [data-handle="se"]`)
  await expect(handle).toBeVisible()
  const hb = await handle.boundingBox()
  if (hb === null) throw new Error('no resize handle')
  const h0 = { x: hb.x + hb.width / 2, y: hb.y + hb.height / 2 }
  const sized = (await localNotes(page))[paris]
  await page.mouse.move(h0.x, h0.y)
  await page.mouse.down()
  await page.mouse.move(h0.x + 80, h0.y + 50, { steps: 10 })
  await page.mouse.up()
  await expect
    .poll(async () => (await localNotes(page))[paris]?.w)
    .toBe(Math.round((sized?.w ?? 0) + 80 / zoom))

  // Selected, it offers its actions in the sidebar and nothing that changes its design.
  await expect(
    page.getByRole('toolbar', { name: 'Tools' }).getByRole('group', { name: 'Selection' }),
  ).toBeVisible()
  await expect(page.getByRole('radio')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await saved(page)

  // 3. A pasted PNG becomes a print note, its photo uploaded.
  await pastePng(page)
  await expect.poll(async () => Object.keys(await localNotes(page)).length).toBe(3)
  const print = Object.keys(await localNotes(page)).find((id) => id !== welcome && id !== paris)
  if (print === undefined) throw new Error('no print note')
  await expect
    .poll(async () => (await serverBoard(apiFor(page), boardId)).notes.get(print)?.image, {
      timeout: 30_000,
    })
    .not.toBeNull()
  await expect(noteEl(page, print).locator('img')).toBeVisible()
  // It landed at the middle of the view, over the welcome note: hang it beside the others.
  await page.keyboard.press('Escape')
  await idle(page)
  const lift = await paperPoint(page, print)
  const room = await bareCork(page, 160)
  await page.mouse.move(lift.x, lift.y)
  await page.mouse.down()
  await page.mouse.move(room.x, room.y, { steps: 12 })
  await page.mouse.up()
  await idle(page)

  // 4. With the Yarn tool (its colour chosen first, in its picker), a Shift-drop from the welcome
  // note's pin onto Paris winds on; a click on the print ends it.
  await page.keyboard.press('Escape')
  await idle(page)
  const tools = page.getByRole('toolbar', { name: 'Tools' })
  await tools.getByRole('button', { name: 'Yarn' }).click()
  await yarnPicker(page).getByRole('radio', { name: 'Indigo' }).click()
  await expect(yarnPicker(page)).toHaveCount(0)
  const from = await pin(page, welcome)
  const onto = await paperPoint(page, paris)
  await page.keyboard.down('Shift')
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(onto.x, onto.y, { steps: 12 })
  await page.mouse.up()
  await page.keyboard.up('Shift')
  await expect.poll(() => localYarns(page)).toEqual([[welcome, paris]])
  const last = await paperPoint(page, print)
  await page.mouse.move(last.x, last.y, { steps: 8 })
  await page.mouse.click(last.x, last.y)
  await expect.poll(() => localYarns(page)).toEqual([[welcome, paris, print]])
  await page.keyboard.press('Escape')
  await tools.getByRole('button', { name: 'Select' }).click()

  // A fourth note on a thread of its own from the print: two steps away from the welcome note.
  const spot = await bareCork(page, 140)
  const milan = await pinNote(page, 'Milan', spot)
  await page.keyboard.press('Escape')
  await armYarn(page)
  const tail = await pin(page, print)
  const end = await paperPoint(page, milan)
  await page.mouse.move(tail.x, tail.y)
  await page.mouse.down()
  await page.mouse.move(end.x, end.y, { steps: 12 })
  await page.mouse.up()
  await page.keyboard.press('v')
  const threads = [
    [welcome, paris, print],
    [print, milan],
  ]
  await expect.poll(() => localYarns(page)).toEqual(threads)
  await saved(page)

  // 5. Reload: everything came back from the board file, the motif chosen at creation included.
  const before = await localNotes(page)
  await openBoard(page)
  await saved(page)
  expect(await localNotes(page)).toEqual(before)
  expect(await localYarns(page)).toEqual(threads)
  await expect(noteEl(page, paris)).toHaveAttribute('data-motif', 'fold')
  await expect(noteEl(page, paris)).toContainText('Morning in Paris')
  await expect(noteEl(page, print).locator('img')).toBeVisible()
  const onServer = await serverBoard(apiFor(page), boardId)
  expect(onServer.notes.get(paris)).toMatchObject({
    text: 'Morning in Paris',
    paper: 'rose',
    motif: 'fold',
  })
  expect(onServer.yarns.map((y) => y.noteIds)).toEqual(threads)
  // Both in the colour chosen in Yarn's picker: Y opened it again on that colour.
  expect(onServer.yarns.map((y) => y.color)).toEqual(['indigo', 'indigo'])

  // 6. Delete the print, then undo: the note and its place in the thread come back.
  const p = await paperPoint(page, print)
  await page.mouse.click(p.x, p.y)
  await page.keyboard.press('Delete')
  await expect(noteEl(page, print)).toHaveCount(0)
  await saved(page)
  expect((await serverBoard(apiFor(page), boardId)).notes.has(print)).toBe(false)
  await page.keyboard.press('ControlOrMeta+z')
  await expect(noteEl(page, print)).toHaveCount(1)
  await saved(page)
  const undone = await serverBoard(apiFor(page), boardId)
  expect(undone.notes.has(print)).toBe(true)
  expect(undone.yarns.map((y) => y.noteIds)).toEqual(threads)

  // 7. Focus on the welcome note at one step (its thread), then two (Milan too), then leave: the
  // board file is unchanged.
  await page.keyboard.press('Escape')
  const jsonl = await exportJsonl(apiFor(page), boardId)
  const w = await paperPoint(page, welcome)
  await page.mouse.click(w.x, w.y)
  await page.keyboard.press('f')
  const chip = page.getByRole('toolbar', { name: 'Focus' })
  await expect(chip).toContainText('1 step')
  await expect.poll(() => page.evaluate(() => window.__papertie.runtime.focus?.notes.size)).toBe(3)
  await chip.getByRole('button', { name: 'More steps' }).click()
  await expect(chip).toContainText('2 steps')
  await expect.poll(() => page.evaluate(() => window.__papertie.runtime.focus?.notes.size)).toBe(4)
  await page.keyboard.press('Escape')
  await expect.poll(() => page.evaluate(() => window.__papertie.runtime.focusState)).toBeNull()
  await idle(page)
  await saved(page)
  expect(await exportJsonl(apiFor(page), boardId)).toBe(jsonl)

  // 8. Export .papertie from Settings: the archive lists the manifest, the board and the photo.
  await page
    .getByRole('toolbar', { name: 'Tools' })
    .getByRole('button', { name: 'Settings' })
    .click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await expect(settings).toBeVisible()
  await settings.getByRole('link', { name: 'Export' }).click()
  const file = await download(page, () =>
    settings.getByRole('link', { name: 'Download .papertie' }).click(),
  )
  expect(file.name).toMatch(/\.papertie$/)
  const asset = (await serverBoard(apiFor(page), boardId)).notes.get(print)?.image?.assetId
  expect(
    readZip(file.bytes)
      .map((e) => e.name)
      .sort(),
  ).toEqual(['board.jsonl', 'manifest.json', `assets/${asset}.webp`].sort())

  // 9. axe on Settings and the board: nothing serious or critical.
  expect(await axeSerious(page)).toEqual([])
  await page.keyboard.press('Escape')
  await expect(settings).toHaveCount(0)
  await waitReady(page)
  expect(await axeSerious(page)).toEqual([])

  // Delete all data opens afresh on the empty board that is left; then axe on that.
  await page
    .getByRole('toolbar', { name: 'Tools' })
    .getByRole('button', { name: 'Settings' })
    .click()
  await settings.getByRole('link', { name: 'Data' }).click()
  await settings.getByRole('button', { name: 'Delete all data…' }).click()
  await settings.getByLabel('Type delete to confirm').fill('delete')
  const reloaded = page.waitForEvent('load')
  await settings.getByRole('button', { name: 'Delete all data', exact: true }).click()
  await reloaded
  await expect(page).toHaveURL(/\/$/)
  await expect(page.locator('article.note')).toHaveCount(0)
  expect(await boardIds(apiFor(page))).not.toContain(boardId)
  expect(await axeSerious(page)).toEqual([])
  expect(errors).toEqual([])
})
