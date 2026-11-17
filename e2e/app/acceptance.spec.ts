import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { newId } from '../../packages/core/src'
import { armYarn } from '../yarnTool'
import { axeFor, axeViolations } from './a11y-exceptions'
import { APP_URL, apiFor, type Desktop, expect, runningFor, test } from './helpers/app'
import { idle, noteEl, paperPoint, pin, saved } from './helpers/board'
import { bookBlocks, opsOn, seedBook, uploadFigure } from './helpers/books'
import { seedBoard } from './helpers/lifetime'
import {
  exportJsonl,
  firstRun,
  onlyBoard,
  openBoard,
  revisionOf,
  serverBoard,
} from './helpers/server'
import { board30, settle, tools, writing } from './helpers/states'
import { unzip } from './helpers/zip'

/**
 * The acceptance criteria of `docs/acceptance.md`: one test per criterion, titled with its text
 * verbatim. Each names the tests and suites that prove it in full (the `PROVEN_*` tables, also
 * put on the test as annotations) and runs a cheap version of the check here, in the desktop app.
 */

const ROOT = join(__dirname, '../..')

/** The criteria of one section of `docs/acceptance.md`: the list between its markers. */
function criteria(section: string): string[] {
  const text = readFileSync(join(ROOT, 'docs/acceptance.md'), 'utf8')
  const from = text.indexOf(`<!-- ${section}-criteria:start -->`)
  const to = text.indexOf(`<!-- ${section}-criteria:end -->`)
  return text
    .slice(from, to)
    .split('\n')
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim())
}

/** The tests this file registers through `fn`: each `fn(` call at a line's start. */
function registered(fn: string): { modifier: string | undefined; title: string }[] {
  const call = new RegExp(`^${fn}(\\.\\w+)?\\(\\s*(['"])(.*?)\\2,`, 'gm')
  return [...readFileSync(__filename, 'utf8').matchAll(call)].map((m) => ({
    modifier: m[1],
    title: m[3] as string,
  }))
}

/**
 * Name the proof on the running test, and check that the section is covered: the title is one of
 * its criteria word for word, there is one test per criterion and no other, none skipped, and a
 * proof for each.
 */
function proven(
  section: string,
  fn: string,
  prefix: string,
  proofs: Record<string, string[]>,
): void {
  const title = test.info().title.slice(prefix.length)
  const all = criteria(section).sort()
  expect(all.length, `the ${section} criteria read from docs/acceptance.md`).toBeGreaterThan(0)
  expect(all, 'the title is a criterion, verbatim').toContain(title)
  const tests = registered(fn)
  expect(
    tests.filter((t) => t.modifier !== undefined),
    'no test skipped or focused',
  ).toEqual([])
  expect(tests.map((t) => t.title).sort(), 'the test titles are the criteria, each once').toEqual(
    all,
  )
  expect(Object.keys(proofs).sort(), 'a proof is named for each criterion').toEqual(all)
  for (const d of proofs[title] ?? [])
    test.info().annotations.push({ type: 'proven by', description: d })
}

/** What proves each of the board's criteria in full: test files and names, and their suites. */
const PROVEN_BY: Record<string, string[]> = {
  'Notes can be created, edited, moved, resized, and deleted.': [
    'e2e/app/journey.spec.ts: steps 2 (create, write, move, resize) and 6 (delete, undo)',
    'e2e/app/keyboard.spec.ts: steps 2–4 (create, write, Alt+arrow move)',
    'e2e/sidebar.spec.ts, e2e/canvas-drag.spec.ts, e2e/note-editor.spec.ts (proto)',
    'apps/web/test/selectTool.test.ts, drag.test.ts (pnpm test)',
  ],
  'Text and images persist correctly after reload.': [
    'e2e/app/journey.spec.ts: step 5 (reload: text, motif and the uploaded photo)',
    'e2e/app/keyboard.spec.ts: step 9 (reload)',
    'apps/server/test/assets.test.ts, store.test.ts (pnpm test:server)',
  ],
  'Notes retain their positions and styling.': [
    'e2e/app/journey.spec.ts: step 5 (every note equal after reload, paper and motif on the server)',
    'packages/core/test/serialize.test.ts, properties.test.ts (pnpm test)',
  ],
  'Yarn can connect notes and maintain its connections when notes move.': [
    'e2e/app/journey.spec.ts: step 4 (Yarn tool, Shift-drop winds on)',
    'e2e/canvas-yarn.spec.ts, e2e/yarn-flows.spec.ts, e2e/canvas-drag.spec.ts (proto)',
    'e2e/app/shared-pins.spec.ts: "threads tied at one pin are saved so, and drawn at it after a reload"',
  ],
  'Multi-note collections behave according to the documented model.': [
    'docs/adr/0002-yarn-semantics.md (one thread pin to pin; the whole thread is one group)',
    'packages/core/test/focus.test.ts, threadIndex.test.ts, invariants.test.ts (pnpm test)',
    'e2e/yarn-flows.spec.ts: "shift-drop winds A, B, C and D into one thread" (proto)',
  ],
  'Yarn animation is smooth, restrained, and does not materially impair interaction.': [
    'e2e/canvas-motion.spec.ts: "a new thread draws in over 350 ms, then the loop goes idle within 1 s", "the board is idle when nothing moves: no frame callback for 3 s" (proto)',
    'e2e/desktop/desktop.bench.ts: "desktop drag 20 threads" (pnpm bench:desktop)',
  ],
  'Focus mode displays the selected network and expands by connection depth.': [
    'e2e/focus.spec.ts (proto); packages/core/test/focus.test.ts (pnpm test)',
    'e2e/app/journey.spec.ts step 7; e2e/app/keyboard.spec.ts step 6',
  ],
  'Exiting focus mode restores the full board without changing its underlying data.': [
    'e2e/app/journey.spec.ts step 7 (the board file unchanged); e2e/app/keyboard.spec.ts step 6',
    'e2e/focus.spec.ts: "hidden yarn is gone from the yarn layer and back after focus" (proto)',
  ],
  'Autosave, backup, and recovery behaviour has been tested.': [
    'apps/server/test/backups.test.ts, backups-routes.test.ts, recovery.test.ts (pnpm test:server)',
    'apps/server/test/crash/recovery.crash.test.ts (pnpm test:crash)',
    'e2e/desktop/desktop.spec.ts: "opens straight on the board; a note, a thread and the window outlive a quit"',
  ],
  'Malformed records and interrupted writes do not cause silent corruption.': [
    'apps/server/test/crash/crash.test.ts, corruption.test.ts, journal.crash.test.ts, import.crash.test.ts (pnpm test:crash)',
    'packages/core/test/parse.test.ts (the eof checksum, torn lines; pnpm test)',
    'apps/server/test/import.test.ts (a damaged file names its line; pnpm test:server)',
  ],
  'The minimal sidebar is the only persistent navigation structure; no top navigation bar is present.':
    [
      'e2e/sidebar.spec.ts: "the floating sidebar sits on the left in the UI layer, in its fixed order" (proto)',
      'e2e/settings-sidebar.spec.ts (proto)',
    ],
  'The interface stays readable and responsive.': [
    'Readability: the contrast checks in e2e/app/a11y.spec.ts and apps/web/test/styles',
    'Responsiveness: e2e/desktop/desktop.bench.ts (pnpm bench:desktop)',
    'The look: e2e/app/gallery.spec.ts (docs/screenshots)',
  ],
  'Performance and accessibility are checked against documented test cases.': [
    'tools/budgets.json (pnpm budget); pnpm bench, bench:desktop, bench:report',
    'e2e/app/a11y.spec.ts (axe, every state); e2e/app/keyboard.spec.ts; docs/a11y/voiceover-walkthrough.md',
  ],
}

const provenBy = () => proven('board', 'test', '', PROVEN_BY)

/** The 30-note board, open on `page` at reading zoom. */
async function board30On(page: Page) {
  const seeded = board30()
  const boardId = await seedBoard(apiFor(page), seeded.ops)
  await openBoard(page)
  await saved(page)
  await page.evaluate(() => window.__papertie.debug.setCamera({ x: -60, y: -60, zoom: 0.8 }))
  await idle(page)
  return { boardId, ids: seeded.notes.map((n) => n.id), seeded }
}

/**
 * Watch the page for long tasks from now on, and return the time it started watching. Chromium
 * hands long tasks only to a `PerformanceObserver` (`getEntriesByType('longtask')` is always
 * empty), so one is installed here, before the gesture, as placement.spec.ts does.
 */
const watchLongTasks = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { acceptLongTasks: { start: number; ms: number }[] }
    w.acceptLongTasks = []
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) w.acceptLongTasks.push({ start: e.startTime, ms: e.duration })
    }).observe({ type: 'longtask', buffered: true })
    return performance.now()
  })

/** The long tasks seen since `since`, in whole ms, once the observer has had a turn to report. */
async function longTasksSince(page: Page, since: number) {
  await page.evaluate(
    () =>
      new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50))),
      ),
  )
  return page.evaluate(
    (since) =>
      (window as unknown as { acceptLongTasks: { start: number; ms: number }[] }).acceptLongTasks
        .filter((e) => e.start >= since)
        .map((e) => Math.round(e.ms)),
    since,
  )
}

const localNote = (page: Page, id: string) =>
  page.evaluate((id) => {
    const n = window.__papertie.store.getState().notes.get(id) as unknown as
      | Record<string, unknown>
      | undefined
    return n === undefined
      ? undefined
      : { x: n.x, y: n.y, w: n.w, h: n.h, text: n.text, paper: n.paper, style: n.style }
  }, id)

const noteIds = (page: Page) =>
  page.evaluate(() => [...window.__papertie.store.getState().notes.keys()])

/** Write `words` over a note's text through the keyboard, and leave the editor. */
async function write(page: Page, id: string, words: string) {
  await idle(page)
  const p = await paperPoint(page, id)
  await page.mouse.dblclick(p.x, p.y)
  await expect(page.locator('[contenteditable]').first()).toBeFocused()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type(words)
  await page.keyboard.press('Escape')
}

/** A small PNG drawn in the page, pasted onto the board as a screenshot would be. */
const pastePng = (page: Page) =>
  page.evaluate(async () => {
    const c = document.createElement('canvas')
    c.width = 240
    c.height = 160
    const g = c.getContext('2d') as CanvasRenderingContext2D
    g.fillStyle = '#2e4b7a'
    g.fillRect(0, 0, 240, 160)
    const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b as Blob), 'image/png'))
    const dt = new DataTransfer()
    dt.items.add(new File([blob], 'photo.png', { type: 'image/png' }))
    ;(document.activeElement as HTMLElement | null)?.blur()
    document.body.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
    )
  })

test('Notes can be created, edited, moved, resized, and deleted.', async ({ page }) => {
  provenBy()
  test.setTimeout(90_000)
  const { boardId } = await board30On(page)
  const before = await noteIds(page)
  // Create with "+" and Pin, then write.
  await page
    .getByRole('toolbar', { name: 'Tools' })
    .getByRole('button', { name: 'New note' })
    .click()
  await page
    .getByRole('dialog', { name: 'New note' })
    .getByRole('button', { name: 'Pin note' })
    .click()
  await expect(page.locator('[contenteditable]').first()).toBeFocused()
  await page.keyboard.type('Acceptance draft')
  await page.keyboard.press('Escape')
  const id = (await noteIds(page)).find((k) => !before.includes(k)) as string
  expect(id).toBeDefined()
  await saved(page)
  expect((await serverBoard(apiFor(page), boardId)).notes.get(id)?.text).toBe('Acceptance draft')
  // Edit.
  await write(page, id, 'Acceptance note')
  await saved(page)
  expect((await serverBoard(apiFor(page), boardId)).notes.get(id)?.text).toBe('Acceptance note')
  // Move: the note keeps the focus after Esc; Shift+Alt+→ moves it 10 world px a press.
  await expect(noteEl(page, id)).toBeFocused()
  const placed = (await localNote(page, id)) as { x: number; w: number }
  for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+Alt+ArrowRight')
  await saved(page)
  expect((await serverBoard(apiFor(page), boardId)).notes.get(id)?.x).toBe(placed.x + 30)
  // Resize by the selection's corner handle.
  await idle(page)
  const handle = page.locator(`.overlay .selection[data-note-id="${id}"] [data-handle="se"]`)
  await expect(handle).toBeVisible()
  const hb = (await handle.boundingBox()) as { x: number; y: number; width: number; height: number }
  const zoom = await page.evaluate(() => window.__papertie.debug.camera().zoom)
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
  await page.mouse.down()
  await page.mouse.move(hb.x + hb.width / 2 + 64, hb.y + hb.height / 2 + 40, { steps: 8 })
  await page.mouse.up()
  await saved(page)
  expect((await serverBoard(apiFor(page), boardId)).notes.get(id)?.w).toBe(
    Math.round(placed.w + 64 / zoom),
  )
  // Delete.
  await noteEl(page, id).focus()
  await page.keyboard.press('Delete')
  await expect(noteEl(page, id)).toHaveCount(0)
  await saved(page)
  expect((await serverBoard(apiFor(page), boardId)).notes.has(id)).toBe(false)
})

test('Text and images persist correctly after reload.', async ({ page }) => {
  provenBy()
  test.setTimeout(90_000)
  const { boardId, ids } = await board30On(page)
  const words = 'Inn booked, 2 nights — Zürich → Bergen'
  await write(page, ids[2] as string, words)
  await page.keyboard.press('Escape')
  await pastePng(page)
  const added = async () => (await noteIds(page)).find((k) => !ids.includes(k))
  await expect.poll(added, { timeout: 15_000 }).toBeDefined()
  const photo = (await added()) as string
  await expect
    .poll(async () => (await serverBoard(apiFor(page), boardId)).notes.get(photo)?.image, {
      timeout: 30_000,
    })
    .not.toBeNull()
  await saved(page)
  const before = {
    text: await localNote(page, ids[2] as string),
    photo: await localNote(page, photo),
  }
  await openBoard(page)
  await saved(page)
  expect(await localNote(page, ids[2] as string)).toEqual(before.text)
  expect(await localNote(page, photo)).toEqual(before.photo)
  await expect(noteEl(page, ids[2] as string)).toContainText(words)
  const img = noteEl(page, photo).locator('img')
  await expect(img).toBeVisible()
  await expect
    .poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 15_000 })
    .toBeGreaterThan(0)
  expect((await serverBoard(apiFor(page), boardId)).notes.get(ids[2] as string)?.text).toBe(words)
})

test('Notes retain their positions and styling.', async ({ page }) => {
  provenBy()
  const { boardId, seeded } = await board30On(page)
  const want = seeded.notes.map((n) => ({
    id: n.id,
    x: n.x,
    y: n.y,
    w: n.w,
    paper: n.paper,
    style: n.style,
  }))
  const read = async () =>
    Promise.all(
      want.map(async (n) => {
        const l = (await localNote(page, n.id)) as Record<string, unknown>
        return { id: n.id, x: l.x, y: l.y, w: l.w, paper: l.paper, style: l.style }
      }),
    )
  expect(await read()).toEqual(want)
  await openBoard(page)
  expect(await read()).toEqual(want)
  for (const n of want.slice(0, 8))
    await expect(noteEl(page, n.id)).toHaveAttribute('data-paper', n.paper)
  const server = await serverBoard(apiFor(page), boardId)
  for (const n of want)
    expect(server.notes.get(n.id)).toMatchObject({ x: n.x, y: n.y, paper: n.paper })
})

test('Yarn can connect notes and maintain its connections when notes move.', async ({ page }) => {
  provenBy()
  test.setTimeout(90_000)
  const { boardId, ids } = await board30On(page)
  const [a, b] = [ids[7] as string, ids[8] as string]
  // Tie two untied notes with the Yarn tool: a drag from a's pin onto b.
  await armYarn(page)
  const from = await pin(page, a)
  const onto = await paperPoint(page, b)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(onto.x, onto.y, { steps: 10 })
  await page.mouse.up()
  await page.keyboard.press('v')
  await saved(page)
  const tied = (await serverBoard(apiFor(page), boardId)).yarns.find(
    (y) => y.noteIds.includes(a) && y.noteIds.includes(b),
  )
  expect(tied?.noteIds).toEqual([a, b])
  const yarnId = tied?.id as string
  // Move b: the thread's end follows it (it stays on b's paper, at whichever edge faces a),
  // and the thread still ties the same notes.
  await idle(page)
  const endOf = () =>
    page.evaluate(([y]) => window.__papertie.debug.attachScreen(y, 0, 'b'), [yarnId] as const)
  const paperOf = async () =>
    (await noteEl(page, b).locator('.note-paper').boundingBox()) as {
      x: number
      y: number
      width: number
      height: number
    }
  const near = (p: { x: number; y: number } | undefined, r: Awaited<ReturnType<typeof paperOf>>) =>
    p !== undefined &&
    p.x >= r.x - 24 &&
    p.x <= r.x + r.width + 24 &&
    p.y >= r.y - 24 &&
    p.y <= r.y + r.height + 24
  const box0 = await paperOf()
  const end0 = await endOf()
  expect(near(end0, box0), `the end ${JSON.stringify(end0)} on b ${JSON.stringify(box0)}`).toBe(
    true,
  )
  const grab = await paperPoint(page, b)
  await page.mouse.move(grab.x, grab.y)
  await page.mouse.down()
  await page.mouse.move(grab.x + 260, grab.y + 180, { steps: 10 })
  await page.mouse.up()
  await idle(page)
  const box1 = await paperOf()
  const end1 = await endOf()
  expect(box1.x - box0.x).toBeCloseTo(260, -1)
  expect(near(end1, box1), `the end ${JSON.stringify(end1)} on b ${JSON.stringify(box1)}`).toBe(
    true,
  )
  expect(near(end1, box0), 'the end left with the note').toBe(false)
  await saved(page)
  await openBoard(page)
  const after = await serverBoard(apiFor(page), boardId)
  expect(after.yarns.find((y) => y.id === yarnId)?.noteIds).toEqual([a, b])
  expect(
    await page.evaluate(([y]) => window.__papertie.store.getState().yarns.get(y)?.noteIds, [
      yarnId,
    ] as const),
  ).toEqual([a, b])
})

test('Multi-note collections behave according to the documented model.', async ({ page }) => {
  provenBy()
  const { boardId, ids } = await board30On(page)
  // board30's thread through notes 10, 11 and 17: one record, its notes in order (one thread,
  // pin to pin: decision 3).
  const [n10, n11, n17] = [ids[10], ids[11], ids[17]] as [string, string, string]
  const thread = (await serverBoard(apiFor(page), boardId)).yarns.filter((y) =>
    y.noteIds.includes(n10),
  )
  expect(thread.map((y) => y.noteIds)).toEqual([[n10, n11, n17]])
  // The whole thread is one group (decision 9): focus on its first note at one step shows all
  // three, though 17 is two pins along.
  await page.evaluate(([id]) => window.__papertie.debug.focusCamera(id, 0.8), [n10] as const)
  await idle(page)
  const p = await paperPoint(page, n10)
  await page.mouse.click(p.x, p.y)
  await page.keyboard.press('f')
  await expect(page.getByRole('toolbar', { name: 'Focus' })).toContainText('1 step')
  await expect
    .poll(() => page.evaluate(() => [...(window.__papertie.runtime.focus?.notes ?? [])].sort()))
    .toEqual([n10, n11, n17].sort())
  await page.keyboard.press('Escape')
})

test('Yarn animation is smooth, restrained, and does not materially impair interaction.', async ({
  page,
}) => {
  provenBy()
  test.setTimeout(90_000)
  const { ids } = await board30On(page)
  const [a, b, c] = [ids[13], ids[14], ids[15]] as string[]
  await armYarn(page)
  const from = await pin(page, a as string)
  const onto = await paperPoint(page, b as string)
  const longBefore = await watchLongTasks(page)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(onto.x, onto.y, { steps: 10 })
  await page.mouse.up()
  // While the new thread draws in, a click on another note selects it at once.
  await page.keyboard.press('v')
  const q = await paperPoint(page, c as string)
  await page.mouse.click(q.x, q.y)
  await expect
    .poll(() => page.evaluate(() => [...window.__papertie.runtime.selection]), { timeout: 1000 })
    .toEqual([c])
  // Restrained: the loop settles and stops by itself (canvas-motion: idle within 1 s).
  await expect
    .poll(() => page.evaluate(() => window.__papertie.runtime.loop.running), { timeout: 2000 })
    .toBe(false)
  const frames = await page.evaluate(() => window.__papertie.runtime.loop.framesDrawn)
  await page.waitForTimeout(1000)
  expect(await page.evaluate(() => window.__papertie.runtime.loop.framesDrawn)).toBe(frames)
  // Smooth: no long task in the page through the tie and the click.
  const long = await longTasksSince(page, longBefore)
  expect(long).toEqual([])
})

test('Focus mode displays the selected network and expands by connection depth.', async ({
  page,
}) => {
  provenBy()
  const { ids } = await board30On(page)
  // board30's chain: 1–2, 2–3, 3–4.
  const p = await paperPoint(page, ids[1] as string)
  await page.mouse.click(p.x, p.y)
  await page.keyboard.press('f')
  const chip = page.getByRole('toolbar', { name: 'Focus' })
  const shown = () =>
    page.evaluate(() => [...(window.__papertie.runtime.focus?.notes ?? [])].sort())
  await expect(chip).toContainText('1 step')
  await expect.poll(shown).toEqual([ids[1], ids[2]].sort())
  await chip.getByRole('button', { name: 'More steps' }).click()
  await expect(chip).toContainText('2 steps')
  await expect.poll(shown).toEqual([ids[1], ids[2], ids[3]].sort())
  await chip.getByRole('button', { name: 'More steps' }).click()
  await expect.poll(shown).toEqual([ids[1], ids[2], ids[3], ids[4]].sort())
  // The rest of the board is out of the way: not in the accessibility tree.
  await expect(page.getByRole('article', { name: 'Old churches', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
})

test('Exiting focus mode restores the full board without changing its underlying data.', async ({
  page,
}) => {
  provenBy()
  const { boardId, ids } = await board30On(page)
  const file = await exportJsonl(apiFor(page), boardId)
  const revision = await revisionOf(apiFor(page), boardId)
  const p = await paperPoint(page, ids[1] as string)
  await page.mouse.click(p.x, p.y)
  await page.keyboard.press('f')
  const chip = page.getByRole('toolbar', { name: 'Focus' })
  await chip.getByRole('button', { name: 'More steps' }).click()
  await expect(chip).toContainText('2 steps')
  await page.keyboard.press('Escape')
  await expect.poll(() => page.evaluate(() => window.__papertie.runtime.focusState)).toBeNull()
  await expect(chip).toHaveCount(0)
  await idle(page)
  await expect(page.getByRole('article', { name: 'Old churches', exact: true })).toBeVisible()
  expect(await revisionOf(apiFor(page), boardId)).toBe(revision)
  expect(await exportJsonl(apiFor(page), boardId)).toBe(file)
})

test('Autosave, backup, and recovery behaviour has been tested.', async ({ page }) => {
  provenBy()
  test.setTimeout(90_000)
  const { boardId, ids } = await board30On(page)
  const id = ids[8] as string
  const original = (await serverBoard(apiFor(page), boardId)).notes.get(id)?.text
  // The board's first commit took a backup of its hour.
  const listed = async () =>
    (
      (await (await apiFor(page).get(`/api/boards/${boardId}/backups`)).json()) as {
        backups: { id: string; damaged: boolean }[]
      }
    ).backups
  await expect.poll(async () => (await listed()).length, { timeout: 15_000 }).toBeGreaterThan(0)
  const backups = await listed()
  expect(backups.every((b) => !b.damaged)).toBe(true)
  // Autosave: an edit reaches the server with nothing pressed.
  await write(page, id, 'Written after the backup')
  await saved(page)
  expect((await serverBoard(apiFor(page), boardId)).notes.get(id)?.text).toBe(
    'Written after the backup',
  )
  // Recovery: the backup restored, the open page takes the board back, and the edit
  // is kept in a new backup.
  const res = await apiFor(page).post(
    `/api/boards/${boardId}/backups/${encodeURIComponent(backups[0]?.id as string)}/restore`,
    { headers: { Origin: APP_URL }, data: {} },
  )
  expect(res.status(), await res.text()).toBe(200)
  await expect
    .poll(
      () => page.evaluate((id) => window.__papertie?.store.getState().notes.get(id)?.text, id),
      {
        timeout: 15_000,
      },
    )
    .toBe(original)
  expect((await serverBoard(apiFor(page), boardId)).notes.get(id)?.text).toBe(original)
  // The board as it was before the restore is kept as a backup of its own (History can undo it).
  expect((await listed()).length).toBeGreaterThan(backups.length)
})

test('Malformed records and interrupted writes do not cause silent corruption.', async ({
  page,
}) => {
  provenBy()
  const { boardId } = await board30On(page)
  const file = await exportJsonl(apiFor(page), boardId)
  const revision = await revisionOf(apiFor(page), boardId)
  const settings = page.getByRole('dialog', { name: 'Settings' })
  /** Choose `text` as the file to import, in Settings' Export. */
  const importing = async (text: string) => {
    await page.goto(`${APP_URL}/settings/export?bench`)
    const choosing = page.waitForEvent('filechooser')
    await settings.getByRole('button', { name: 'Import…' }).click()
    await (await choosing).setFiles({
      name: 'board.jsonl',
      mimeType: 'application/x-ndjson',
      buffer: Buffer.from(text),
    })
  }
  // An interrupted write: the board file cut off part-way through a line, then imported. It is
  // refused out loud, naming what is wrong, never asked about; the board is as it was.
  await importing(file.slice(0, Math.floor(file.length * 0.6)))
  await expect(
    settings.getByText(/^This board file is damaged \(line \d+\)\. Nothing was changed\.$/),
  ).toBeVisible()
  await expect(settings.getByRole('alertdialog')).toHaveCount(0)
  expect(await revisionOf(apiFor(page), boardId)).toBe(revision)
  expect(await exportJsonl(apiFor(page), boardId)).toBe(file)
  // A malformed record (the fourth line's note without its id) is refused the same way.
  const lines = file.trimEnd().split('\n')
  await importing(
    `${lines.map((l, i) => (i === 3 ? l.replace(/"id":"[^"]+",?/, '') : l)).join('\n')}\n`,
  )
  await expect(
    settings.getByText('This board file is damaged (line 4). Nothing was changed.'),
  ).toBeVisible()
  await expect(settings.getByRole('alertdialog')).toHaveCount(0)
  expect(await revisionOf(apiFor(page), boardId)).toBe(revision)
  expect(await exportJsonl(apiFor(page), boardId)).toBe(file)
})

test('The minimal sidebar is the only persistent navigation structure; no top navigation bar is present.', async ({
  page,
}) => {
  provenBy()
  await board30On(page)
  await settle(page)
  const tools = page.getByRole('toolbar', { name: 'Tools' })
  await expect(tools).toBeVisible()
  await expect(
    page.locator('nav, header, [role="navigation"], [role="banner"], [role="menubar"]'),
  ).toHaveCount(0)
  // Nothing else persistent spans the top of the window: no bar across it.
  const bars = await page.evaluate(() =>
    [...document.querySelectorAll('body *')]
      .filter((el) => {
        const s = getComputedStyle(el)
        if (s.visibility === 'hidden' || s.display === 'none') return false
        if (!['fixed', 'sticky', 'absolute'].includes(s.position)) return false
        const r = el.getBoundingClientRect()
        return (
          r.top < 80 && r.width > innerWidth * 0.5 && r.height > 0 && r.height < innerHeight * 0.5
        )
      })
      .map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`),
  )
  expect(bars).toEqual([])
  // The sidebar on the left, taller than wide.
  const box = (await tools.boundingBox()) as { x: number; width: number; height: number }
  expect(box.x).toBeLessThan(80)
  expect(box.height).toBeGreaterThan(box.width)
})

test('The interface stays readable and responsive.', async ({ page }) => {
  provenBy()
  // Readability, as axe's contrast rule
  // reads it on the board, and responsiveness, as a pan at reading zoom with no long task.
  await board30On(page)
  await settle(page)
  const contrast = await axeFor(page).withRules(['color-contrast']).analyze()
  expect(contrast.violations.map((v) => v.nodes.map((n) => n.target.join(' ')))).toEqual([])
  const since = await watchLongTasks(page)
  await page.evaluate(async () => {
    const d = window.__papertie.debug
    const c = d.camera()
    for (let i = 1; i <= 60; i++) {
      d.setCamera({ ...c, x: c.x + i * 8 })
      await new Promise((r) => requestAnimationFrame(r))
    }
  })
  await idle(page)
  const long = await longTasksSince(page, since)
  expect(long).toEqual([])
})

test('Performance and accessibility are checked against documented test cases.', async ({
  page,
}) => {
  provenBy()
  // The documented cases exist: the recorded bundle sizes (`pnpm budget`) and the VoiceOver
  // walkthrough.
  const budgets = JSON.parse(readFileSync(join(ROOT, 'tools/budgets.json'), 'utf8'))
  const sizes = Object.keys(budgets).filter((k) => typeof budgets[k] === 'number')
  expect(sizes.length).toBeGreaterThan(0)
  expect(
    readFileSync(join(ROOT, 'docs/a11y/voiceover-walkthrough.md'), 'utf8').length,
  ).toBeGreaterThan(0)
  // And the cheap version of the a11y pass: axe, with the pass's configuration, on the board.
  await board30On(page)
  await settle(page)
  expect(await axeViolations(page)).toEqual([])
})

// ── Books, the shelf and the writer ──────────────────────────────────────────────────────────────

/** What proves each of the books' criteria in full. */
const PROVEN_BOOKS: Record<string, string[]> = {
  'A new book appears on the wooden shelf at once, with a generated ink cover that stays when the book is renamed.':
    [
      'e2e/app/shelf.spec.ts: "Books opens the shelf over the board and goes back; a new book is made and kept"',
      'apps/web/test/book/cover.test.tsx, shelf.test.tsx (pnpm test)',
      'packages/core/test/book/records.test.ts (a random seed, fixed)',
    ],
  'A book opens into the writer, its chapters, sections, quotes and lists set in the agreed typography.':
    [
      'e2e/app/writer.spec.ts: "typing "# On collecting" makes a chapter with its label and rule…"',
      'e2e/app/gallery.spec.ts: books chapter-page (docs/screenshots/books)',
    ],
  'Formatting has one visible home, the writing tools in the sidebar, and the typed shortcuts are their accelerators.':
    [
      'e2e/app/writer.spec.ts: "a multi-paragraph paste …; the sidebar formats"',
      'apps/web/test/app/writerSidebar.test.tsx (pnpm test: the sidebar’s writing tools)',
      'apps/web/test/book/blockEngine.test.tsx (pnpm test)',
    ],
  'Writing is saved like the board, and is there when Papertie opens again.': [
    'packages/core/test/book/ops.test.ts, rekey.test.ts (the block ops; undo and redo fitted to the book)',
    'apps/server/test/books.test.ts (pnpm test:server)',
    'apps/web/test/sync/books/ (pnpm test)',
    'e2e/desktop/desktop.spec.ts: "a book is opened and written in, and the words outlive a quit"',
  ],
  "Undo in the writer goes through the board's one history.": [
    'e2e/app/writer.spec.ts: "Enter splits keeping the paragraph’s id, Backspace merges, ⌘Z undoes through the board’s history"',
    'apps/web/test/history/sessionUndo.test.ts, UndoStack.test.ts (pnpm test)',
  ],
  'A deleted book can be put back from Recently deleted.': [
    'apps/web/test/book/shelf.test.tsx (Recently deleted), apps/web/test/sync/books/putBackLate.test.ts (pnpm test)',
    'apps/server/test/books.test.ts (the purge after 30 days)',
  ],
  'Papertie opens where you left off: in the book, at the same place.': [
    'e2e/app/writer-scale.spec.ts: "reopening Papertie after writing lands in the book at the caret"',
    'apps/web/test/app/screenMemory.test.ts, bootRemembered.test.tsx (pnpm test)',
  ],
  'The board and its books are one unit for the export and the import.': [
    'apps/server/test/export.test.ts, import.test.ts, backups.test.ts (pnpm test:server)',
    'docs/adr/0001-storage.md (served text without blocks; one file, one unit)',
  ],
}

const provenBooks = () => proven('books', 'books', 'Books: ', PROVEN_BOOKS)

/** The app as on a first run, its board open; the board's id. */
async function firstBoard(page: Page): Promise<string> {
  await firstRun(apiFor(page))
  await openBoard(page)
  return onlyBoard(apiFor(page))
}

const writerBlocks = (page: Page) => page.locator('.writer [data-id]')

/** Put the caret at the end of block `i`, as a click there leaves it. */
async function caretEnd(page: Page, i: number): Promise<void> {
  await writerBlocks(page).nth(i).click()
  await page.evaluate((i) => {
    const el = document.querySelectorAll<HTMLElement>('.writer [data-id]')[i] as HTMLElement
    const r = document.createRange()
    r.selectNodeContents(el)
    r.collapse(false)
    document.getSelection()?.removeAllRanges()
    document.getSelection()?.addRange(r)
  }, i)
}

/** The book's texts as the store holds them, once they match `texts`. */
async function serverHas(page: Page, boardId: string, bookId: string, texts: string[]) {
  await expect
    .poll(async () => (await bookBlocks(page, boardId, bookId)).map((b) => b.text), {
      timeout: 15_000,
    })
    .toEqual(texts)
}

/**
 * A books criterion's test (titled with it), registered beside the board's tests and told apart
 * from them by this name: `registered('test')` reads only `test(` at a line's start.
 */
type Fixtures = { page: Page; desktop: Desktop }
const books = (title: string, body: (f: Fixtures) => Promise<void> | void) =>
  test(`Books: ${title}`, body)

books(
  'A new book appears on the wooden shelf at once, with a generated ink cover that stays when the book is renamed.',
  async ({ page }) => {
    provenBooks()
    const boardId = await firstBoard(page)
    await tools(page).getByRole('button', { name: 'Books' }).click()
    const shelf = page.getByRole('dialog', { name: 'Books' })
    await expect(shelf).toBeVisible()
    await shelf.getByRole('button', { name: 'New book' }).click()
    await expect(page).toHaveURL(/\/book\/book_\w+$/)
    const bookId = new URL(page.url()).pathname.split('/').at(-1) as string
    await expect(page.getByRole('textbox', { name: 'Title' })).toBeFocused()
    await page.keyboard.type('Winter notes')
    await page.keyboard.press('Escape')
    const book = shelf.locator(`li[data-book-id="${bookId}"]`)
    await expect(book.getByRole('button', { name: 'Winter notes', exact: true })).toBeVisible()
    const cover = book.locator('.cover svg').first()
    await expect(cover).toBeVisible()
    // The wood behind it: the shelf's light wood (`--wood`), its wall of boards drawn in grain
    // and joints (repeating gradients), and a plank under the books.
    const wood = await shelf.evaluate((el) => ({
      fill: getComputedStyle(el).backgroundColor,
      wall: getComputedStyle(el.querySelector('.shelf-wall') as HTMLElement).backgroundImage,
    }))
    expect(wood.fill).toBe('rgb(217, 191, 152)')
    expect(wood.wall).toMatch(/repeating-linear-gradient/)
    // The cover is drawn ink (paths), from the book's seed; a rename keeps it.
    const drawn = await cover.innerHTML()
    expect(drawn).toMatch(/<path/)
    // The title saved first (the rename after it, not racing it).
    await expect
      .poll(
        async () => (await exportJsonl(apiFor(page), boardId)).includes('"title":"Winter notes"'),
        {
          timeout: 15_000,
        },
      )
      .toBe(true)
    await opsOn(page, boardId, [{ op: 'book.update', id: bookId, set: { title: 'Letters' } }])
    await expect(book.getByRole('button', { name: 'Letters', exact: true })).toBeVisible()
    expect(await book.locator('.cover svg').first().innerHTML()).toBe(drawn)
  },
)

books(
  'A book opens into the writer, its chapters, sections, quotes and lists set in the agreed typography.',
  async ({ page }) => {
    provenBooks()
    const boardId = await firstBoard(page)
    const bookId = await seedBook(page, boardId, {
      title: 'Field notes',
      blocks: [
        { kind: 'h1', text: 'On collecting' },
        { text: 'Who writes thinks twice.' },
        { kind: 'quote', text: 'To remember is to connect.' },
        { kind: 'h2', text: 'The card' },
        { kind: 'li', text: 'a card for every thought' },
      ],
    })
    await page.goto(`${APP_URL}/book/${bookId}`)
    const h1 = page.locator('.writer h1.bk-h1')
    await expect(h1).toHaveText('On collecting')
    const look = await page.evaluate(() => {
      const font = (sel: string) =>
        getComputedStyle(document.querySelector(sel) as HTMLElement).fontFamily
      const h1 = document.querySelector('.writer h1.bk-h1') as HTMLElement
      return {
        h1: font('.writer h1.bk-h1'),
        h2: font('.writer h2.bk-h2'),
        p: font('.writer p.bk'),
        quote: font('.writer blockquote'),
        label: getComputedStyle(h1, '::before').content,
        rule: getComputedStyle(h1, '::after').backgroundColor,
        li: document.querySelectorAll('.writer .bk-li').length,
        count: document.querySelector('.writer-count')?.textContent ?? '',
      }
    })
    expect(look.h1).toContain('Newsreader')
    expect(look.h2).toContain('Newsreader')
    expect(look.quote).toContain('Newsreader')
    expect(look.p).toContain('Instrument Sans')
    expect(look.label).toBe('"Chapter 1"')
    expect(look.rule).toBe('rgb(184, 54, 74)')
    expect(look.li).toBe(1)
    expect(look.count).toMatch(/\d+ words?/)
  },
)

books(
  'Formatting has one visible home, the writing tools in the sidebar, and the typed shortcuts are their accelerators.',
  async ({ page }) => {
    provenBooks()
    const boardId = await firstBoard(page)
    const bookId = await seedBook(page, boardId, { title: 'Format', blocks: [{ text: '' }] })
    await page.goto(`${APP_URL}/book/${bookId}`)
    await expect(writerBlocks(page).first()).toBeVisible()
    await writerBlocks(page).first().click()
    // Formatting's one home is the sidebar's writing tools.
    const pop = writing(page)
    await page.keyboard.type('## The card')
    await page.keyboard.press('Enter')
    await page.keyboard.type('A plain thought')
    // While typing nothing is selected: Bold waits; `## ` made a section.
    await expect(pop.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-disabled', 'true')
    await expect(page.locator('.writer h2.bk-h2')).toHaveText('The card')
    await page.evaluate(() => {
      const t = document.querySelectorAll('.writer [data-id]')[1]?.firstChild as Text
      document.getSelection()?.setBaseAndExtent(t, 2, t, 7)
    })
    for (const name of ['Text style', 'Bold', 'Italic'])
      await expect(pop.getByRole('button', { name })).not.toHaveAttribute('aria-disabled', 'true')
    await pop.getByRole('button', { name: 'Text style' }).click()
    const kinds = page.getByRole('dialog', { name: 'Text style' })
    for (const name of ['Paragraph', 'Chapter', 'Section', 'Quote', 'List'])
      await expect(kinds.getByRole('radio', { name })).toBeVisible()
    await page.keyboard.press('Escape')
    await pop.getByRole('button', { name: 'Bold' }).click()
    await expect(writerBlocks(page).nth(1).locator('strong')).toHaveText('plain')
    await expect
      .poll(async () => (await bookBlocks(page, boardId, bookId))[1]?.marks, { timeout: 15_000 })
      .toEqual([{ t: 'b', from: 2, to: 7 }])
  },
)

books(
  'Writing is saved like the board, and is there when Papertie opens again.',
  async ({ page, desktop }) => {
    provenBooks()
    const boardId = await firstBoard(page)
    const bookId = await seedBook(page, boardId, {
      title: 'One desk',
      blocks: [{ text: 'middle' }],
    })
    await page.goto(`${APP_URL}/book/${bookId}`)
    await expect(writerBlocks(page).first()).toHaveText('middle')
    // Words typed are saved with nothing pressed, as a note's are on the board.
    await caretEnd(page, 0)
    await page.keyboard.type(' right')
    await serverHas(page, boardId, bookId, ['middle right'])
    // And they are there when Papertie is opened again.
    const running = runningFor(page)
    await desktop.quit(running)
    const again = await desktop.launch({ userData: running.userData })
    await again.page.goto(`${APP_URL}/book/${bookId}`)
    await expect(writerBlocks(again.page).first()).toHaveText('middle right')
    expect(again.errors).toEqual([])
  },
)

books("Undo in the writer goes through the board's one history.", async ({ page }) => {
  provenBooks()
  const boardId = await firstBoard(page)
  const bookId = await seedBook(page, boardId, { title: 'Undo', blocks: [{ text: 'Kept' }] })
  // On the board first: the welcome note moved one step (a board action).
  const noteId = (await page.locator('article.note').first().getAttribute('data-note-id')) as string
  const xOf = async () => (await serverBoard(apiFor(page), boardId)).notes.get(noteId)?.x
  const x0 = await xOf()
  await page.evaluate((id) => window.__papertie.runtime.selectNote(id), noteId)
  await page.keyboard.press('Alt+ArrowRight')
  await expect.poll(xOf, { timeout: 15_000 }).not.toBe(x0)
  await page.keyboard.press('Escape')
  // Then into the book, in the same page (one history), and words typed.
  await tools(page).getByRole('button', { name: 'Books' }).click()
  await page
    .getByRole('dialog', { name: 'Books' })
    .getByRole('button', { name: 'Undo', exact: true })
    .click()
  await caretEnd(page, 0)
  await page.keyboard.type(' and more')
  await serverHas(page, boardId, bookId, ['Kept and more'])
  await page.waitForTimeout(800)
  // ⌘Z in the writer: the words, then the board's move before them: one history for both.
  await page.keyboard.press('ControlOrMeta+z')
  await expect(writerBlocks(page).first()).toHaveText('Kept')
  await serverHas(page, boardId, bookId, ['Kept'])
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(xOf, { timeout: 15_000 }).toBe(x0)
  await serverHas(page, boardId, bookId, ['Kept'])
})

books('A deleted book can be put back from Recently deleted.', async ({ page }) => {
  provenBooks()
  const boardId = await firstBoard(page)
  const bookId = await seedBook(page, boardId, {
    title: 'Recipes',
    blocks: [{ text: 'Miso, slowly.' }],
  })
  await page.goto(`${APP_URL}/shelf`)
  const shelf = page.getByRole('dialog', { name: 'Books' })
  await shelf.getByRole('button', { name: 'Recipes', exact: true }).hover()
  await shelf.getByRole('button', { name: 'Options for Recipes' }).click()
  await page
    .getByRole('dialog', { name: 'Recipes' })
    .getByRole('button', { name: 'Delete' })
    .click()
  const ask = page.getByRole('alertdialog')
  await expect(ask).toContainText('You can put it back for 30 days.')
  await ask.getByRole('button', { name: 'Delete' }).click()
  await expect(shelf.getByRole('button', { name: 'Recipes', exact: true })).toHaveCount(0)
  await shelf.getByRole('button', { name: 'Recently deleted' }).click()
  const trash = page.getByRole('dialog', { name: 'Recently deleted' })
  await trash.getByRole('button', { name: 'Put it back' }).click()
  // The sheet closes by itself once nothing is left in it, or with Done.
  await trash
    .getByRole('button', { name: 'Done' })
    .click({ timeout: 2000 })
    .catch(() => {})
  await expect(trash).toHaveCount(0)
  await shelf.getByRole('button', { name: 'Recipes', exact: true }).click()
  await expect(writerBlocks(page).first()).toHaveText('Miso, slowly.')
  expect((await bookBlocks(page, boardId, bookId)).map((b) => b.text)).toEqual(['Miso, slowly.'])
})

books(
  'Papertie opens where you left off: in the book, at the same place.',
  async ({ page, desktop }) => {
    provenBooks()
    const boardId = await firstBoard(page)
    const lines = Array.from({ length: 120 }, (_, i) => ({
      text: `Paragraph ${i + 1}: a line of the long book, kept where it was left.`,
    }))
    const bookId = await seedBook(page, boardId, { title: 'Long', blocks: lines })
    await page.goto(`${APP_URL}/book/${bookId}`)
    await expect(writerBlocks(page).first()).toBeVisible()
    // A paragraph far in: on screen, the caret four characters into it, a word typed.
    const target = writerBlocks(page).nth(80)
    await target.scrollIntoViewIfNeeded()
    const id = (await target.getAttribute('data-id')) as string
    await target.click()
    await page.evaluate((id) => {
      const t = (document.querySelector(`[data-id="${id}"]`) as HTMLElement).firstChild as Text
      document.getSelection()?.setBaseAndExtent(t, 4, t, 4)
    }, id)
    await page.keyboard.type('ink ')
    // The place is remembered; Papertie quit, and opened again.
    await page.waitForTimeout(3000)
    const running = runningFor(page)
    await desktop.quit(running)
    const { page: again } = await desktop.launch({ userData: running.userData })
    await expect(again).toHaveURL(new RegExp(`/book/${bookId}$`))
    const el = again.locator(`[data-id="${id}"]`)
    await expect(el).toBeInViewport()
    await expect(el).toHaveText(/^.{4}ink /)
  },
)

books('The board and its books are one unit for the export and the import.', async ({ page }) => {
  provenBooks()
  const boardId = await firstBoard(page)
  const bookId = await seedBook(page, boardId, {
    title: 'Exported',
    blocks: [{ kind: 'h1', text: 'One' }, { text: 'The text travels with the board.' }],
  })
  const file = await exportJsonl(apiFor(page), boardId)
  const records = file
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as { type: string; id?: string; bookId?: string })
  expect(records.some((r) => r.type === 'book' && r.id === bookId)).toBe(true)
  expect(records.filter((r) => r.type === 'block' && r.bookId === bookId)).toHaveLength(2)
  // Changed, then the export imported back: the book as it was exported.
  await opsOn(page, boardId, [{ op: 'book.update', id: bookId, set: { title: 'Changed' } }])
  const preview = await apiFor(page).post(`/api/boards/${boardId}/import`, {
    headers: { Origin: APP_URL },
    multipart: {
      file: { name: 'board.jsonl', mimeType: 'application/x-ndjson', buffer: Buffer.from(file) },
    },
  })
  expect(preview.status(), await preview.text()).toBe(200)
  const { importId } = (await preview.json()) as { importId: string }
  const commit = await apiFor(page).post(`/api/boards/${boardId}/import/${importId}/commit`, {
    headers: { Origin: APP_URL },
    data: {},
  })
  expect(commit.status(), await commit.text()).toBe(200)
  expect((await bookBlocks(page, boardId, bookId)).map((b) => b.text)).toEqual([
    'One',
    'The text travels with the board.',
  ])
  const after = (await exportJsonl(apiFor(page), boardId))
    .split('\n')
    .filter((l) => l.includes(`"id":"${bookId}"`))
  expect(after[0]).toContain('"title":"Exported"')
})

// ── The board and the book as one ───────────────────────────────────────────────────────────────

/** What proves each criterion of the board beside the book in full. */
const PROVEN_TOGETHER: Record<string, string[]> = {
  'The board and an open book sit side by side, the seam can be dragged, and one key toggles the board beside the book.':
    [
      'e2e/app/split.spec.ts (the split, the seam kept, ⌘\\, below 1024 px)',
      'apps/web/test/app/split*.test.tsx, test/book/bookScreen.test.tsx (pnpm test)',
      'docs/adr/0008-split-view.md',
    ],
  'A card dragged into the book lands at once as a paragraph, a quote or a prompt, chosen at the drop without slowing it.':
    [
      'e2e/app/seam.spec.ts: "a card dropped into the book is a copy with its pin; …"',
      'apps/web/test/book/cardDrop.test.tsx, dropChooser.test.tsx, dropForms.test.ts (pnpm test)',
    ],
  'An image card dragged into the book becomes a figure with its caption.': [
    'apps/web/test/book/cardBlocks.test.ts: "an image card makes a figure with its asset and card, captioned with its text"',
  ],
  'Alt-drag moves a card into the book, and one undo brings it back.': [
    'e2e/app/seam.spec.ts (⌥ at the drop moves …; one undo brings both back)',
    'apps/server/test/sync/sync.test.ts (a move racing an edit of the card loses no words)',
  ],
  'Selected text dragged onto the board becomes a card that remembers its book.': [
    'e2e/app/seam.spec.ts: "a selection dragged out of the book onto the board …"',
    'apps/web/test/book/toCard.test.ts, selectionDrag.test.tsx (pnpm test)',
  ],
  'A paragraph from a card carries a pin that shows the card and finds it on the board, through rewriting, splitting and merging.':
    [
      'e2e/app/provenance.spec.ts: "a pin beside text from a card: …"',
      'packages/core/test/book (card marks kept through edits, splits and merges)',
      'apps/web/test/book/pins.test.ts, pinLayer.test.tsx (pnpm test)',
    ],
  'A card used in a book shows a mark on the board that lists the books.': [
    'e2e/app/provenance.spec.ts: "the reverse mark lists the shelf books using the card …"',
    'apps/server/test/books.test.ts (the server stamps `cards`), apps/web/test/book/cardUses.test.tsx',
  ],
  'Every drag has a keyboard path: ⌘K inserts a card, and Pin to board makes one.': [
    'apps/web/test/book/insertCard.test.tsx (pnpm test)',
    'e2e/app/seam.spec.ts: "Pin to board makes the card at the view’s centre; …"',
  ],
  'Find in the writer finds text anywhere in the book.': [
    'e2e/app/writer-scale.spec.ts: "Enter jumps to a match 150,000 words away and selects it", "axe: no serious violations with the find bar"',
    'apps/web/test/book/find.test.ts, findBar.test.tsx (pnpm test)',
  ],
}

const provenTogether = () => proven('together', 'together', 'Board and book: ', PROVEN_TOGETHER)

const together = (title: string, body: (f: Fixtures) => Promise<void> | void) =>
  test(`Board and book: ${title}`, body)

const WIDE = { width: 1440, height: 900 }

type Rec = { type: string; id: string; x: number; y: number; rev?: number }

/**
 * A first run on a wide window: its board with a card ("Lantern festival") beside the
 * welcome card, and a book of two paragraphs ("River notes").
 */
async function splitBoard(page: Page) {
  await page.setViewportSize(WIDE)
  const boardId = await firstBoard(page)
  const welcome = (await exportJsonl(apiFor(page), boardId))
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Rec)
    .find((r) => r.type === 'note') as Rec
  const { rev: _rev, ...base } = welcome
  const card = newId('note')
  await opsOn(page, boardId, [
    { op: 'note.create', note: { ...base, id: card, x: base.x + 320, text: 'Lantern festival' } },
  ])
  const bookId = await seedBook(page, boardId, {
    title: 'River notes',
    blocks: [{ text: 'The first paragraph.' }, { text: 'The last paragraph.' }],
  })
  return { boardId, bookId, card, base }
}

/** The book beside the board, its page shown and the app ready. */
async function besideBoard(page: Page, bookId: string): Promise<void> {
  await page.goto(`${APP_URL}/book/${bookId}?bench`)
  await expect(page.locator('.writer-body[data-shown] [data-id]').first()).toBeVisible({
    timeout: 60_000,
  })
  await expect(page.locator('.board-split')).toHaveAttribute('data-layout', 'split')
  await page.waitForFunction(() => window.__papertie?.ready === true)
}

/** Card `id` in the board's view at zoom 1, dragged to the gap below block `blockId`. */
async function dragCardBelow(page: Page, id: string, blockId: string, alt = false) {
  await page.evaluate(
    (id) => (window.__papertie.debug.focusCamera as (id: string, z: number) => void)(id, 1),
    id,
  )
  await page.waitForTimeout(600)
  const at = await paperPoint(page, id)
  const box = await page.locator(`.writer [data-id="${blockId}"]`).boundingBox()
  if (box === null) throw new Error(`block ${blockId} not shown`)
  const to = { x: box.x + box.width / 2, y: box.y + box.height * 0.8 }
  await page.mouse.move(at.x, at.y)
  await page.mouse.down()
  await page.mouse.move(at.x + 40, at.y + 10, { steps: 4 })
  await page.mouse.move(to.x, to.y, { steps: 12 })
  await expect(page.locator('.bk-drop-gap')).toHaveAttribute('data-after', blockId)
  if (alt) {
    await page.keyboard.down('Alt')
    await page.mouse.move(to.x, to.y + 1)
  }
  await page.mouse.up()
  if (alt) await page.keyboard.up('Alt')
  await saved(page)
}

const bookTexts = async (page: Page, boardId: string, bookId: string) =>
  (await bookBlocks(page, boardId, bookId)).map((b) => [b.kind, b.text])

together(
  'The board and an open book sit side by side, the seam can be dragged, and one key toggles the board beside the book.',
  async ({ page }) => {
    provenTogether()
    test.setTimeout(120_000)
    const { bookId } = await splitBoard(page)
    await besideBoard(page, bookId)
    // Side by side: the board's viewport and the book's pane, neither over the other.
    const board = await page.locator('main.viewport').boundingBox()
    const pane = await page.locator('.book-pane').boundingBox()
    if (board === null || pane === null) throw new Error('no board or pane')
    expect(board.x + board.width).toBeLessThanOrEqual(pane.x + 1)
    // The seam, dragged: the board grows.
    const seam = page.getByRole('separator', { name: 'Book width' })
    const s = await seam.boundingBox()
    const y = (s?.y ?? 0) + 300
    await page.mouse.move((s?.x ?? 0) + 6, y)
    await page.mouse.down()
    await page.mouse.move((s?.x ?? 0) + 160, y, { steps: 8 })
    await page.mouse.up()
    await expect
      .poll(async () => (await page.locator('main.viewport').boundingBox())?.width ?? 0)
      .toBeGreaterThan(board.width + 100)
    // One key: full width, then beside the board again.
    await page.locator('.writer [data-id]').first().click()
    await page.keyboard.press('ControlOrMeta+Backslash')
    await expect(page.locator('.board-split')).toHaveAttribute('data-layout', 'full')
    await page.keyboard.press('ControlOrMeta+Backslash')
    await expect(page.locator('.board-split')).toHaveAttribute('data-layout', 'split')
  },
)

together(
  'A card dragged into the book lands at once as a paragraph, a quote or a prompt, chosen at the drop without slowing it.',
  async ({ page }) => {
    provenTogether()
    test.setTimeout(120_000)
    const { boardId, bookId, card } = await splitBoard(page)
    await besideBoard(page, bookId)
    const [first] = await bookBlocks(page, boardId, bookId)
    await dragCardBelow(page, card, first?.id as string)
    // At once, as its likely form (a paragraph); the chooser offers the three.
    await expect
      .poll(() => bookTexts(page, boardId, bookId))
      .toEqual([
        ['p', 'The first paragraph.'],
        ['p', 'Lantern festival'],
        ['p', 'The last paragraph.'],
      ])
    const chooser = page.getByRole('radiogroup', { name: 'Add as' })
    await expect(chooser.getByRole('radio')).toHaveText([/Paragraph/, /Quote/, /Prompt/])
    // 3: a prompt, in place.
    await page.keyboard.press('3')
    await saved(page)
    await expect.poll(async () => (await bookBlocks(page, boardId, bookId))[1]?.kind).toBe('prompt')
  },
)

together(
  'An image card dragged into the book becomes a figure with its caption.',
  async ({ page }) => {
    provenTogether()
    test.setTimeout(120_000)
    const { boardId, bookId, base } = await splitBoard(page)
    const assetId = await uploadFigure(page, boardId)
    const photo = newId('note')
    await opsOn(page, boardId, [
      {
        op: 'note.create',
        note: {
          ...base,
          id: photo,
          x: base.x + 640,
          style: 'print',
          text: 'The harbour at dawn',
          image: { assetId, frame: 'print' },
        },
      },
    ])
    await besideBoard(page, bookId)
    const [first] = await bookBlocks(page, boardId, bookId)
    await dragCardBelow(page, photo, first?.id as string)
    await expect
      .poll(async () => (await bookBlocks(page, boardId, bookId))[1])
      .toMatchObject({ kind: 'figure', text: 'The harbour at dawn' })
    const fig = (await bookBlocks(page, boardId, bookId))[1] as unknown as {
      image: { assetId: string; card: string }
    }
    expect(fig.image).toEqual({ assetId, card: photo })
    await expect(page.locator(`.writer [data-id] img`).first()).toBeVisible()
  },
)

together('Alt-drag moves a card into the book, and one undo brings it back.', async ({ page }) => {
  provenTogether()
  test.setTimeout(120_000)
  const { boardId, bookId, card } = await splitBoard(page)
  await besideBoard(page, bookId)
  const [first] = await bookBlocks(page, boardId, bookId)
  await dragCardBelow(page, card, first?.id as string, true)
  await expect
    .poll(async () => (await serverBoard(apiFor(page), boardId)).notes.has(card))
    .toBe(false)
  expect((await bookTexts(page, boardId, bookId))[1]).toEqual(['p', 'Lantern festival'])
  await page.keyboard.press('Escape')
  await page.keyboard.press('ControlOrMeta+z')
  await saved(page)
  await expect
    .poll(async () => (await serverBoard(apiFor(page), boardId)).notes.has(card))
    .toBe(true)
  expect(await bookTexts(page, boardId, bookId)).toEqual([
    ['p', 'The first paragraph.'],
    ['p', 'The last paragraph.'],
  ])
})

/** Characters `from`–`to` of block `blockId` selected, the caret's paragraph clicked first. */
async function selectText(page: Page, blockId: string, from: number, to: number) {
  await page.locator(`.writer [data-id="${blockId}"]`).click()
  await page.evaluate(
    ({ blockId, from, to }) => {
      const t = document.querySelector(`.writer [data-id="${blockId}"]`)?.firstChild as Text
      document.getSelection()?.setBaseAndExtent(t, from, t, to)
    },
    { blockId, from, to },
  )
}

/** The cards on the server's board that remember a book. */
const fromBooks = async (page: Page, boardId: string) =>
  [...(await serverBoard(apiFor(page), boardId)).notes.values()].filter((n) => n.from !== undefined)

together(
  'Selected text dragged onto the board becomes a card that remembers its book.',
  async ({ page }) => {
    provenTogether()
    test.setTimeout(120_000)
    const { boardId, bookId } = await splitBoard(page)
    await besideBoard(page, bookId)
    const [first] = await bookBlocks(page, boardId, bookId)
    await selectText(page, first?.id as string, 4, 9)
    const words = await page.evaluate(() => {
      const r = document.getSelection()?.getRangeAt(0).getClientRects()[0]
      return r ? { x: r.left + 8, y: r.top + r.height / 2 } : null
    })
    const view = await page.locator('main.viewport').boundingBox()
    if (words === null || view === null) throw new Error('no selection or board')
    await page.mouse.move(words.x, words.y)
    await page.mouse.down()
    await page.mouse.move(words.x - 30, words.y, { steps: 4 })
    await page.mouse.move(view.x + 160, view.y + view.height - 160, { steps: 16 })
    await page.mouse.up()
    await saved(page)
    await expect.poll(async () => (await fromBooks(page, boardId)).length).toBe(1)
    const [made] = await fromBooks(page, boardId)
    expect(made?.text).toBe('first')
    expect(made?.from).toEqual({ book: bookId, block: first?.id })
  },
)

together(
  'A paragraph from a card carries a pin that shows the card and finds it on the board, through rewriting, splitting and merging.',
  async ({ page }) => {
    provenTogether()
    test.setTimeout(120_000)
    const { boardId, card } = await splitBoard(page)
    const marked = await seedBook(page, boardId, {
      title: 'Pinned',
      blocks: [
        { text: 'An opening line.' },
        { text: 'Lantern festival by the river', marks: [{ t: `c:${card}`, from: 0, to: 29 }] },
      ],
    })
    await besideBoard(page, marked)
    const pins = page.locator('.bk-pin')
    await expect(pins).toHaveCount(1)
    const [, para] = await bookBlocks(page, boardId, marked)
    const el = page.locator(`.writer [data-id="${para?.id}"]`)
    // Rewritten inside, then split in the middle: both halves keep their pin.
    await el.click()
    await page.evaluate((id) => {
      const t = document.querySelector(`.writer [data-id="${id}"]`)?.firstChild as Text
      document.getSelection()?.setBaseAndExtent(t, 7, t, 7)
    }, para?.id as string)
    await page.keyboard.type(' paper')
    await page.keyboard.press('Enter')
    await expect(pins).toHaveCount(2)
    // Merged back: one pin.
    await page.keyboard.press('Backspace')
    await expect(pins).toHaveCount(1)
    await saved(page)
    // The pin shows the card, and finds it on the board.
    await pins.first().hover()
    await expect(page.locator('.card-peek')).toContainText('Lantern festival')
    await pins.first().click()
    // The board's own card (the peek draws one too).
    await expect(page.locator(`main.viewport article.note[data-note-id="${card}"]`)).toHaveClass(
      /note--selected/,
    )
  },
)

together(
  'A card used in a book shows a mark on the board that lists the books.',
  async ({ page }) => {
    provenTogether()
    test.setTimeout(120_000)
    const { boardId, card } = await splitBoard(page)
    await seedBook(page, boardId, {
      title: 'Used here',
      blocks: [{ text: 'Lantern festival', marks: [{ t: `c:${card}`, from: 0, to: 16 }] }],
    })
    await page.goto(`${APP_URL}/?bench`)
    await page.waitForFunction(() => window.__papertie?.ready === true)
    await page.evaluate(
      (id) => (window.__papertie.debug.focusCamera as (id: string, z: number) => void)(id, 1),
      card,
    )
    const ink = noteEl(page, card).locator('.note-ink')
    await expect(ink).toHaveAttribute('data-ink', 'used')
    await ink.click()
    const pop = page.getByRole('dialog', { name: 'Card uses' })
    await expect(pop.getByRole('group', { name: 'Used in' }).getByRole('button')).toHaveText([
      'Used here',
    ])
  },
)

together(
  'Every drag has a keyboard path: ⌘K inserts a card, and Pin to board makes one.',
  async ({ page }) => {
    provenTogether()
    test.setTimeout(120_000)
    const { boardId, bookId } = await splitBoard(page)
    await besideBoard(page, bookId)
    const [first] = await bookBlocks(page, boardId, bookId)
    // ⌘K: the card after the caret's paragraph.
    await page.locator(`.writer [data-id="${first?.id}"]`).click()
    await page.keyboard.press('ControlOrMeta+k')
    const field = page.getByRole('dialog', { name: 'Insert a card' }).getByRole('combobox')
    await field.fill('Lantern')
    await expect(page.getByRole('option').first()).toContainText('Lantern festival')
    await field.press('Enter')
    await saved(page)
    await expect
      .poll(async () => (await bookTexts(page, boardId, bookId)).map(([, t]) => t))
      .toEqual(['The first paragraph.', 'Lantern festival', 'The last paragraph.'])
    await page.keyboard.press('Escape')
    // Pin to board: a card of the selection.
    await selectText(page, first?.id as string, 4, 9)
    await writing(page).getByRole('button', { name: 'Pin to board' }).click()
    await saved(page)
    await expect
      .poll(async () => (await fromBooks(page, boardId)).map((n) => n.text))
      .toEqual(['first'])
  },
)

together('Find in the writer finds text anywhere in the book.', async ({ page }) => {
  provenTogether()
  test.setTimeout(120_000)
  const boardId = await firstBoard(page)
  // 600 paragraphs: the one with the word is far past the page's window.
  const bookId = await seedBook(page, boardId, {
    title: 'Long enough',
    blocks: Array.from({ length: 600 }, (_, k) => ({
      text: k === 560 ? 'Here at last is the Quillwort.' : `Paragraph ${k} of quiet prose.`,
    })),
  })
  await page.goto(`${APP_URL}/book/${bookId}`)
  await expect(page.locator('.writer .bk-book [data-id]').first()).toBeVisible()
  await page.getByRole('button', { name: 'Find' }).click()
  const field = page.getByRole('searchbox', { name: 'Find in the book' })
  await field.fill('quillwort')
  await expect(page.locator('.find-count')).toHaveText('1 of 1')
  const far = (await bookBlocks(page, boardId, bookId))[560]?.id as string
  await expect(page.locator(`.writer [data-id="${far}"]`)).toBeInViewport()
  await field.press('Escape')
  expect(await page.evaluate(() => document.getSelection()?.toString())).toBe('Quillwort')
})

// ── References, footnotes and export ─────────────────────────────────────────────────────────────

/** What proves each criterion of references, footnotes and export in full. */
const PROVEN_SOURCES: Record<string, string[]> = {
  'A note can carry a free-text reference at its bottom, shown under a hairline.': [
    'e2e/app/ref.spec.ts (Add reference, the field, the hairline, search, axe, CSP)',
    'apps/web/test/notes/noteRef.test.tsx; packages/core/test/ref.test.ts (pnpm test)',
    'docs/screenshots/sources (ref-note, ref-edit)',
  ],
  'A card with a reference drops into the book as a quote with the reference as its footnote.': [
    'e2e/app/seam.spec.ts (a card with a ref dropped as a quote with its footnote, one undo)',
    'apps/web/test/book/cardBlocks.test.ts, dropChooser.test.tsx, pinLayer.test.tsx (pnpm test)',
  ],
  'Footnotes can be written by hand, from the sidebar or `^[`, and filled from a card’s reference with ⌘K.':
    [
      'e2e/app/writer.spec.ts: "footnotes: …"',
      'apps/web/test/book/footnotes.test.tsx, blockEngine.test.tsx (pnpm test)',
      'packages/core/test/book/footnotes.test.ts (5,000-run convergence)',
    ],
  'A book exports to Markdown with its images and to Word with real footnotes.': [
    'apps/server/test/bookExport.test.ts (the whole .md, every docx part parsed)',
    'e2e/app/export.spec.ts (the downloads unzip)',
    'apps/web/test/book/bookPopover.test.tsx (pnpm test)',
    'docs/screenshots/sources (docx-preview.png through Quick Look)',
  ],
  'Prompts and pins are never exported.': [
    'apps/server/test/bookExport.test.ts: "prompts and pins are never exported"',
  ],
}

const provenSources = () => proven('sources', 'sources', 'Sources and export: ', PROVEN_SOURCES)

const sources = (title: string, body: (f: Fixtures) => Promise<void> | void) =>
  test(`Sources and export: ${title}`, body)

const WALDEN_REF = 'Thoreau, Walden, 1854'

/** `boardId`'s welcome card, as a base for new cards beside it. */
async function welcomeOf(page: Page, boardId: string) {
  const welcome = (await exportJsonl(apiFor(page), boardId))
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Rec)
    .find((r) => r.type === 'note') as Rec
  const { rev: _rev, ...base } = welcome
  return base
}

/** A card with a ref beside the welcome card. */
async function reffedCard(page: Page, boardId: string, text = 'Walden'): Promise<string> {
  const base = await welcomeOf(page, boardId)
  const id = newId('note')
  await opsOn(page, boardId, [
    { op: 'note.create', note: { ...base, id, x: base.x + 700, text, ref: WALDEN_REF } },
  ])
  return id
}

sources(
  'A note can carry a free-text reference at its bottom, shown under a hairline.',
  async ({ page }) => {
    provenSources()
    await page.setViewportSize(WIDE)
    const boardId = await firstBoard(page)
    const id = await reffedCard(page, boardId)
    await page.goto(`${APP_URL}/?bench`)
    await page.waitForFunction(() => window.__papertie?.ready === true)
    await page.evaluate(
      (id) => (window.__papertie.debug.focusCamera as (id: string, z: number) => void)(id, 1),
      id,
    )
    const card = page.locator(`main.viewport article.note[data-note-id="${id}"]`)
    const ref = card.getByRole('note', { name: 'Reference' })
    await expect(ref).toHaveText(WALDEN_REF)
    expect(await ref.evaluate((e) => getComputedStyle(e).borderTopStyle)).toBe('solid')
  },
)

sources(
  'A card with a reference drops into the book as a quote with the reference as its footnote.',
  async ({ page }) => {
    provenSources()
    const { boardId, bookId, card } = await splitBoard(page)
    await opsOn(page, boardId, [{ op: 'note.update', id: card, set: { ref: WALDEN_REF } }])
    await besideBoard(page, bookId)
    const first = (await bookBlocks(page, boardId, bookId))[0]?.id as string
    await dragCardBelow(page, card, first)
    await expect
      .poll(async () =>
        (await bookBlocks(page, boardId, bookId)).map((b) => [b.kind, b.text] as const),
      )
      .toEqual([
        ['p', 'The first paragraph.'],
        ['quote', 'Lantern festival'],
        ['footnote', 'Thoreau, Walden, 1854'],
        ['p', 'The last paragraph.'],
      ])
    await expect(page.locator('.writer .bk-footnote[data-n="1"]')).toBeVisible()
  },
)

sources(
  'Footnotes can be written by hand, from the sidebar or `^[`, and filled from a card’s reference with ⌘K.',
  async ({ page }) => {
    provenSources()
    await page.setViewportSize(WIDE)
    const boardId = await firstBoard(page)
    await reffedCard(page, boardId)
    await page.evaluate(() =>
      localStorage.setItem('papertie.split', JSON.stringify({ ratio: 0.5, board: false })),
    )
    const bookId = await seedBook(page, boardId, {
      title: 'Notes',
      blocks: [{ text: 'Walden is a book.' }, { text: 'The pond' }],
    })
    await page.goto(`${APP_URL}/book/${bookId}`)
    await expect(writerBlocks(page).first()).toBeVisible()
    // The sidebar's Footnote over a selection, written by hand.
    await caretEnd(page, 0)
    await page.evaluate(() => {
      const t = document.querySelector('.writer [data-id]')?.firstChild as Text
      document.getSelection()?.setBaseAndExtent(t, 0, t, 6)
    })
    await writing(page).getByRole('button', { name: 'Footnote' }).click()
    await page.keyboard.type('By hand.')
    // `^[` after the last word, then ⌘K fills it from a card's ref.
    await caretEnd(page, 2)
    await page.keyboard.type('^[')
    await page.keyboard.press('ControlOrMeta+k')
    await expect(page.getByRole('dialog', { name: 'Insert a reference' })).toBeVisible()
    await page.keyboard.type('walden')
    await expect(page.getByRole('option').first()).toBeVisible()
    await page.keyboard.press('Enter')
    await serverHas(page, boardId, bookId, [
      'Walden is a book.',
      'By hand.',
      'The pond',
      'Thoreau, Walden, 1854',
    ])
    await expect(page.locator('.writer .bk-footnote[data-n="2"]')).toHaveText(
      'Thoreau, Walden, 1854',
    )
  },
)

/** A book with a chapter, a footnote, a figure, a prompt and a pin (a card's mark). */
async function exportedBook(page: Page) {
  await page.setViewportSize(WIDE)
  const boardId = await firstBoard(page)
  const base = await welcomeOf(page, boardId)
  const assetId = await uploadFigure(page, boardId)
  const fn = newId('block')
  const bookId = await seedBook(page, boardId, {
    title: 'Pond letters',
    blocks: [
      { kind: 'h1', text: 'The pond' },
      {
        text: 'Walden is deep and clear.',
        marks: [
          { t: `c:${base.id}`, from: 0, to: 25 },
          { t: `n:${fn}`, from: 0, to: 6 },
        ],
      },
      { kind: 'footnote', text: 'Thoreau, Walden, 1854.', id: fn },
      { kind: 'prompt', text: 'PROMPT-NEVER-EXPORTED' },
      { kind: 'figure', text: 'The cove', image: { assetId } },
    ],
  })
  return { boardId, bookId, assetId, card: base.id }
}

const exported = async (page: Page, boardId: string, bookId: string, format: 'md' | 'docx') => {
  const res = await apiFor(page).get(
    `/api/boards/${boardId}/books/${bookId}/export?format=${format}`,
  )
  expect(res.status()).toBe(200)
  return unzip(await res.body())
}

sources(
  'A book exports to Markdown with its images and to Word with real footnotes.',
  async ({ page }) => {
    provenSources()
    const { boardId, bookId, assetId } = await exportedBook(page)
    const md = await exported(page, boardId, bookId, 'md')
    expect([...md.keys()]).toEqual(['pond-letters.md', `images/${assetId}.webp`])
    const text = md.get('pond-letters.md')?.toString('utf8') ?? ''
    expect(text).toContain(`![The cove](images/${assetId}.webp)`)
    expect(text).toContain('[^1]: Thoreau, Walden, 1854.')
    const docx = await exported(page, boardId, bookId, 'docx')
    expect(docx.get('word/document.xml')?.toString('utf8')).toContain(
      '<w:footnoteReference w:id="1"/>',
    )
    expect(docx.get('word/footnotes.xml')?.toString('utf8')).toContain('Thoreau, Walden, 1854.')
    expect([...docx.keys()].some((k) => k.startsWith('word/media/'))).toBe(true)
  },
)

sources('Prompts and pins are never exported.', async ({ page }) => {
  provenSources()
  const { boardId, bookId, card } = await exportedBook(page)
  const md = await exported(page, boardId, bookId, 'md')
  const docx = await exported(page, boardId, bookId, 'docx')
  for (const [name, data] of [...md, ...docx]) {
    if (!/\.(md|xml|rels)$/.test(name)) continue
    const s = data.toString('utf8')
    expect(s, name).not.toContain('PROMPT-NEVER-EXPORTED')
    expect(s, name).not.toContain(card)
    expect(s, name).not.toContain('c:note_')
  }
})
