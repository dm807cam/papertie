import { expect, type Page, test } from '@playwright/test'
import type { Cam, Pt } from './hooks'
import { armYarn, yarnPicker } from './yarnTool'

const VIEW = { width: 1280, height: 720 }
test.use({ viewport: VIEW })

/*
 * Yarn's colour picker, winding, extending, a selected thread's Delete and keyboard connect, on
 * the empty dev board with four notes of our own:
 *
 *   A (140,100)                  B (1020,100)
 *   D (140,400)                  C (1020,400)
 */
const nid = (n: number) => `note_${String(n).padStart(26, '0')}`
const [A, B, C, D] = [nid(1), nid(2), nid(3), nid(4)]
const TEXT: Record<string, string> = { [A]: 'Alpha', [B]: 'Beta', [C]: 'Gamma', [D]: 'Delta' }
const AT: Record<string, Pt> = {
  [A]: { x: 140, y: 100 },
  [B]: { x: 1020, y: 100 },
  [C]: { x: 1020, y: 400 },
  [D]: { x: 140, y: 400 },
}
const CAM: Cam = { x: 0, y: 0, zoom: 1 }

const idle = (page: Page) =>
  page.waitForFunction(() => window.__papertie.runtime.loop.running === false)

async function open(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await page.goto('/bench?board=empty')
  await page.waitForFunction(() => window.__papertie?.ready === true)
  await page.evaluate(
    ([ids, text, at]) => {
      const store = window.__papertie.store as unknown as { commit(ops: unknown[]): void }
      const now = new Date().toISOString()
      store.commit(
        ids.map((id, i) => ({
          op: 'note.create',
          note: {
            type: 'note',
            id,
            x: at[id]?.x,
            y: at[id]?.y,
            w: 240,
            h: 160,
            z: i + 1,
            paper: 'cream',
            style: 'rustic',
            text: text[id],
            image: null,
            createdAt: now,
            updatedAt: now,
          },
        })),
      )
    },
    [[A, B, C, D], TEXT, AT] satisfies [string[], Record<string, string>, Record<string, Pt>],
  )
  await page.evaluate((c) => window.__papertie.debug.setCamera(c), CAM)
  for (const id of [A, B, C, D]) {
    await page.locator(`article.note[data-note-id="${id}"]`).waitFor()
  }
  await idle(page)
  return errors
}

const pin = async (page: Page, id: string): Promise<Pt> => {
  const p = await page.evaluate((id) => window.__papertie.debug.pinScreen(id), id)
  if (p === undefined) throw new Error(`no pin for ${id}`)
  return p
}

/** The middle of a note's paper on screen. */
const centre = async (page: Page, id: string): Promise<Pt> => {
  const box = await page.locator(`article.note[data-note-id="${id}"] .note-paper`).boundingBox()
  if (box === null) throw new Error(`no box for ${id}`)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

const threads = (page: Page) =>
  page.evaluate(() =>
    [...window.__papertie.store.getState().yarns.entries()].map(([id, y]) => ({
      id,
      ...(y as unknown as { noteIds: string[]; color: string; label: string }),
    })),
  )

const noteIdsOf = async (page: Page) => (await threads(page)).map((t) => t.noteIds)

const selectedYarn = (page: Page) => page.evaluate(() => window.__papertie.debug.selectedYarn())

const motion = (page: Page) => page.evaluate(() => window.__papertie.debug.motion())

/**
 * With the Yarn tool, drag from a note's hanging pin to the middle of another, Shift held or not;
 * then back to Select, unless the thread winds on.
 */
async function dragTie(page: Page, from: string, to: string, shift = false) {
  await armYarn(page)
  const start = await pin(page, from)
  const drop = await centre(page, to)
  if (shift) await page.keyboard.down('Shift')
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(drop.x, drop.y, { steps: 12 })
  await page.mouse.up()
  if (shift) await page.keyboard.up('Shift')
  else await page.keyboard.press('v')
}

const sidebar = (page: Page) => page.getByRole('toolbar', { name: 'Tools' })

/** The sidebar's selection section. */
const selection = (page: Page) => sidebar(page).getByRole('group', { name: 'Selection' })

/** Click a thread to select it. */
async function selectThread(page: Page, yarnId: string, seg = 0) {
  const p = await page.evaluate(
    ([id, seg]) => window.__papertie.debug.yarnPointScreen(id, seg, 0.5),
    [yarnId, seg] as const,
  )
  if (p === undefined) throw new Error(`no curve for ${yarnId}`)
  await page.mouse.click(p.x, p.y)
  await expect.poll(() => selectedYarn(page)).toBe(yarnId)
}

test('shift-drop winds A, B, C and D into one thread', async ({ page }) => {
  const errors = await open(page)
  // Shift on release: A is tied to B, and the thread goes on from B with no button down.
  await dragTie(page, A, B, true)
  await expect.poll(() => noteIdsOf(page)).toEqual([[A, B]])
  await expect(page.locator('[data-live-region]')).toHaveText(
    /Winding on from “Beta”\. Click notes to add, Esc to finish\./,
  )
  const c = await centre(page, C)
  await page.mouse.move(c.x, c.y, { steps: 8 })
  // A click on C with Shift winds it on and goes on again; a click on D without Shift ends it.
  await page.keyboard.down('Shift')
  await page.mouse.click(c.x, c.y)
  await page.keyboard.up('Shift')
  await expect.poll(() => noteIdsOf(page)).toEqual([[A, B, C]])
  const d = await centre(page, D)
  await page.mouse.move(d.x, d.y, { steps: 8 })
  await page.mouse.click(d.x, d.y)
  await expect.poll(() => noteIdsOf(page)).toEqual([[A, B, C, D]])
  // It ended: the pointer moving about no longer draws a live thread.
  await page.mouse.move(d.x + 200, d.y + 100, { steps: 4 })
  await idle(page)
  expect(await noteIdsOf(page)).toEqual([[A, B, C, D]])
  expect(errors).toEqual([])
})

test('Esc and a drop on cork end a winding thread; what was wound stays', async ({ page }) => {
  const errors = await open(page)
  await dragTie(page, A, B, true)
  await expect.poll(() => noteIdsOf(page)).toEqual([[A, B]])
  const commits = await page.evaluate(() => window.__papertie.store.commits)
  await page.keyboard.press('Escape')
  await page.mouse.click(1100, 600)
  await idle(page)
  expect(await noteIdsOf(page)).toEqual([[A, B]])
  expect(await page.evaluate(() => window.__papertie.store.commits)).toBe(commits)

  await dragTie(page, B, C, true)
  await expect
    .poll(() => noteIdsOf(page))
    .toEqual([
      [A, B],
      [B, C],
    ])
  await page.mouse.click(1100, 650)
  await idle(page)
  expect(await noteIdsOf(page)).toEqual([
    [A, B],
    [B, C],
  ])
  expect(errors).toEqual([])
})

test('tying two notes already on a same-colour thread selects and pulses it', async ({ page }) => {
  const errors = await open(page)
  await dragTie(page, A, B)
  await expect.poll(() => noteIdsOf(page)).toEqual([[A, B]])
  const [first] = await threads(page)
  await idle(page)
  expect(await selectedYarn(page)).toBeUndefined()
  const commits = await page.evaluate(() => window.__papertie.store.commits)

  await dragTie(page, A, B)
  await expect.poll(() => selectedYarn(page)).toBe(first?.id)
  expect((await threads(page)).length).toBe(1)
  expect(await page.evaluate(() => window.__papertie.store.commits)).toBe(commits)
  // The pulse is an 800 ms animation of its own; it ends by itself.
  expect((await motion(page)).activeAnimations).toBeGreaterThan(0)
  await expect.poll(async () => (await motion(page)).activeAnimations).toBe(0)
  await idle(page)
  expect(errors).toEqual([])
})

test('under reduced motion the existing thread is selected without a pulse', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const errors = await open(page)
  expect(await page.evaluate(() => window.__papertie.runtime.reducedMotion())).toBe(true)
  await dragTie(page, A, B)
  await expect.poll(() => noteIdsOf(page)).toEqual([[A, B]])
  const [first] = await threads(page)
  await expect.poll(async () => (await motion(page)).activeAnimations).toBe(0)
  await dragTie(page, B, A)
  await expect.poll(() => selectedYarn(page)).toBe(first?.id)
  expect((await motion(page)).activeAnimations).toBe(0)
  expect(errors).toEqual([])
})

test('C opens Connect to…; Enter ties and says so', async ({ page }) => {
  const errors = await open(page)
  await page.evaluate((id) => window.__papertie.runtime.selectNote(id), A)
  await page.keyboard.press('c')
  const picker = page.getByRole('dialog', { name: 'Connect to…' })
  await expect(picker).toBeVisible()
  // The note itself is not offered.
  await expect(picker.getByRole('option', { name: /Alpha/ })).toHaveCount(0)
  await picker.getByRole('combobox').fill('Beta')
  await expect(picker.getByRole('option')).toHaveCount(1)
  await page.keyboard.press('Enter')
  await expect(picker).toHaveCount(0)
  await expect.poll(() => noteIdsOf(page)).toEqual([[A, B]])
  await expect(page.locator('[data-live-region]')).toHaveText(
    /Tied “Alpha” to “Beta” with crimson yarn/,
  )
  expect(errors).toEqual([])
})

test('C then Esc ties nothing and gives the keys back to the board', async ({ page }) => {
  const errors = await open(page)
  await page.evaluate((id) => window.__papertie.runtime.selectNote(id), A)
  await page.keyboard.press('c')
  const picker = page.getByRole('dialog', { name: 'Connect to…' })
  await expect(picker).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(picker).toHaveCount(0)
  expect(await noteIdsOf(page)).toEqual([])
  expect(errors).toEqual([])
})

test('Yarn opens its colour picker; a colour arms the tool, and threads are tied in it', async ({
  page,
}) => {
  const errors = await open(page)
  const yarn = sidebar(page).getByRole('button', { name: 'Yarn' })
  await yarn.click()
  const picker = yarnPicker(page)
  await expect(picker).toBeVisible()
  await expect(yarn).toHaveAttribute('aria-expanded', 'true')
  // Quietly marked while its sheet is open, as "+" is.
  const tint = await yarn.evaluate((el) => getComputedStyle(el).backgroundColor)
  expect(tint).not.toBe('rgba(0, 0, 0, 0)')
  // Not armed until a colour is chosen; it opens on the last one (crimson), focused.
  await expect(yarn).toHaveAttribute('aria-pressed', 'false')
  const dyes = picker.getByRole('group', { name: 'Colour' }).getByRole('radio')
  await expect(dyes).toHaveCount(8)
  await expect(picker.getByRole('radio', { name: 'Crimson' })).toBeChecked()
  await expect(picker.getByRole('radio', { name: 'Crimson' })).toBeFocused()
  // Beside the panel, never inside it.
  const panel = await sidebar(page).boundingBox()
  const box = await picker.boundingBox()
  if (panel === null || box === null) throw new Error('no box')
  expect(box.x).toBeGreaterThanOrEqual(panel.x + panel.width)

  // One press chooses: the picker goes and Yarn is the tool, in indigo.
  await picker.getByRole('radio', { name: 'Indigo' }).click()
  await expect(picker).toHaveCount(0)
  await expect(yarn).toHaveAttribute('aria-pressed', 'true')
  const start = await pin(page, A)
  const drop = await centre(page, B)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(drop.x, drop.y, { steps: 12 })
  await page.mouse.up()
  await expect.poll(async () => (await threads(page)).map((t) => t.color)).toEqual(['indigo'])
  await expect(page.locator('[data-live-region]')).toHaveText(/with indigo yarn/)

  // Armed, Yarn opens it again (on indigo) for the next threads; Esc keeps the tool and colour.
  await yarn.click()
  await expect(picker.getByRole('radio', { name: 'Indigo' })).toBeChecked()
  await page.keyboard.press('Escape')
  await expect(picker).toHaveCount(0)
  await expect(yarn).toBeFocused()
  await expect(yarn).toHaveAttribute('aria-pressed', 'true')

  // Y does the same by the keys: the arrows move, Enter chooses.
  await page.keyboard.press('v')
  await page.keyboard.press('y')
  await expect(picker.getByRole('radio', { name: 'Indigo' })).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(picker).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(picker).toHaveCount(0)
  await dragTie(page, C, D)
  await expect
    .poll(async () => (await threads(page)).map((t) => t.color))
    .toEqual(['indigo', 'sage'])

  // C ties in the colour chosen too.
  await page.evaluate((id) => window.__papertie.runtime.selectNote(id), B)
  await page.keyboard.press('c')
  const connect = page.getByRole('dialog', { name: 'Connect to…' })
  await connect.getByRole('combobox').fill('Gamma')
  await expect(connect.getByRole('option')).toHaveCount(1)
  await page.keyboard.press('Enter')
  await expect
    .poll(async () => (await threads(page)).map((t) => t.color))
    .toEqual(['indigo', 'sage', 'sage'])
  await expect(page.locator('[data-live-region]')).toHaveText(/with moss yarn/)
  expect(errors).toEqual([])
})

test('folded to the mark, Y opens the colour picker beside it; the thread is tied in the colour chosen', async ({
  page,
}) => {
  const errors = await open(page)
  const mark = sidebar(page).getByRole('button', { name: 'Papertie — hide tools' })
  await mark.click()
  const folded = sidebar(page).getByRole('button', { name: 'Papertie — show tools' })
  await expect(folded).toBeVisible()
  await page.keyboard.press('y')
  const picker = yarnPicker(page)
  await expect(picker).toBeVisible()
  const at = await folded.boundingBox()
  const sheet = await picker.boundingBox()
  if (at === null || sheet === null) throw new Error('no box')
  expect(sheet.x).toBeGreaterThanOrEqual(at.x + at.width)
  expect(sheet.y).toBeLessThanOrEqual(at.y + at.height)
  await picker.getByRole('radio', { name: 'Ochre' }).click()
  await expect(picker).toHaveCount(0)
  const start = await pin(page, A)
  const drop = await centre(page, B)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(drop.x, drop.y, { steps: 12 })
  await page.mouse.up()
  await expect.poll(async () => (await threads(page)).map((t) => t.color)).toEqual(['ochre'])
  // Still folded: only the mark shows.
  await expect(folded).toBeVisible()
  await expect(sidebar(page).getByRole('button', { name: 'New note' })).toBeHidden()
  expect(await page.evaluate(() => localStorage.getItem('papertie.prefs'))).toContain('"folded"')
  expect(errors).toEqual([])
})

for (const width of [320, 375]) {
  test(`on a ${width} px phone the mini-bar's colour picker gives every dye a finger's 44 px`, async ({
    page,
  }) => {
    const errors = await open(page)
    // The notes are found at the desktop size; the phone's mini-bar takes over as it narrows.
    await page.setViewportSize({ width, height: 700 })
    await expect(sidebar(page)).toHaveClass('minibar')
    await sidebar(page).getByRole('button', { name: 'Yarn' }).click()
    const picker = yarnPicker(page)
    await expect(picker).toBeVisible()
    await expect(picker).toBeInViewport({ ratio: 1 })
    const dyes = picker.locator('.picker-dye')
    await expect(dyes).toHaveCount(8)
    for (const dye of await dyes.all()) {
      const r = await dye.boundingBox()
      if (r === null) throw new Error('a dye has no box')
      // Layout lands on sub-pixels (43.99997 for a 44 px box), so allow a hair under 44.
      expect(r.width).toBeGreaterThanOrEqual(43.99)
      expect(r.height).toBeGreaterThanOrEqual(43.99)
      expect(r.x).toBeGreaterThanOrEqual(0)
      expect(r.x + r.width).toBeLessThanOrEqual(width)
    }
    await picker.getByRole('radio', { name: 'Moss' }).click()
    await expect(picker).toHaveCount(0)
    await expect(sidebar(page).getByRole('button', { name: 'Yarn' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(errors).toEqual([])
  })
}

test('a selected thread has no popover: the sidebar offers only Delete, which unties (undo restores)', async ({
  page,
}) => {
  const errors = await open(page)
  await dragTie(page, A, B)
  await expect.poll(() => noteIdsOf(page)).toEqual([[A, B]])
  const [yarn] = await threads(page)
  if (yarn === undefined) throw new Error('no thread')
  await idle(page)
  await selectThread(page, yarn.id)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const del = selection(page).getByRole('button', { name: 'Delete' })
  await expect(selection(page).getByRole('button')).toHaveCount(1)
  await expect(del).toBeInViewport({ ratio: 1 })
  await expect(del).toHaveAttribute('title', 'Delete (⌫)')

  // Esc deselects; the section folds away.
  await page.keyboard.press('Escape')
  expect(await selectedYarn(page)).toBeUndefined()
  await expect(selection(page)).toHaveAttribute('inert', '')

  await selectThread(page, yarn.id)
  await del.click()
  await expect.poll(() => noteIdsOf(page)).toEqual([])
  expect(await selectedYarn(page)).toBeUndefined()
  await expect(page.locator('[data-live-region]')).toHaveText(/Untied the thread/)
  await expect.poll(async () => (await motion(page)).activeAnimations).toBe(0)
  // One undo step brings it back, and the keys are the board's again.
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => noteIdsOf(page)).toEqual([[A, B]])
  expect(errors).toEqual([])
})

test('dragging from the end pin of the selected thread extends it', async ({ page }) => {
  const errors = await open(page)
  await dragTie(page, A, B)
  await expect.poll(() => noteIdsOf(page)).toEqual([[A, B]])
  const [yarn] = await threads(page)
  if (yarn === undefined) throw new Error('no thread')
  await idle(page)
  await selectThread(page, yarn.id)

  // The far end's edge pin, on B: a drag from it winds C on instead of tying a new thread.
  const end = await page.evaluate((id) => window.__papertie.debug.attachScreen(id, 0, 'b'), yarn.id)
  if (end === undefined) throw new Error('no end pin')
  expect(await page.evaluate((p) => window.__papertie.debug.hitAt(p), end)).toMatchObject({
    kind: 'pin',
    noteId: B,
    edge: { yarnId: yarn.id, segIndex: 0, end: 'b' },
  })
  const drop = await centre(page, C)
  await page.mouse.move(end.x, end.y)
  await page.mouse.down()
  await page.mouse.move(drop.x, drop.y, { steps: 12 })
  await page.mouse.up()
  await expect.poll(() => noteIdsOf(page)).toEqual([[A, B, C]])

  // The first note's end pin extends the other way.
  const head = await page.evaluate(
    (id) => window.__papertie.debug.attachScreen(id, 0, 'a'),
    yarn.id,
  )
  if (head === undefined) throw new Error('no head pin')
  const toD = await centre(page, D)
  await page.mouse.move(head.x, head.y)
  await page.mouse.down()
  await page.mouse.move(toD.x, toD.y, { steps: 12 })
  await page.mouse.up()
  await expect.poll(() => noteIdsOf(page)).toEqual([[D, A, B, C]])
  expect(errors).toEqual([])
})
