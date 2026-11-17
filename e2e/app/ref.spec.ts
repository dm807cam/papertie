import type { Page } from '@playwright/test'
import { newId } from '../../packages/core/src'
import { axeViolations } from './a11y-exceptions'
import { APP_URL, apiFor, expect, test } from './helpers/app'
import { saved } from './helpers/board'
import { opsOn } from './helpers/books'
import { exportJsonl, firstRun, onlyBoard, openBoard, serverBoard } from './helpers/server'

/**
 * A note's reference, a free-text field at the note's bottom, in the built app: while a note is
 * written on, "Add reference" at the bottom of its editor opens the ref field; a blur out of the
 * note commits it with the writing; the ref shows at the note's bottom under a hairline; search
 * finds the note by it. Axe finds no serious violation, and nothing breaks the CSP.
 */

const WIDE = { width: 1440, height: 900 }

const noteEl = (page: Page, id: string) =>
  page.locator('main.viewport').locator(`article.note[data-note-id="${id}"]`)

type Rec = { type: string; id: string; x: number; y: number; rev?: number }

/** The board with a card "Simplify, simplify." */
async function seeded(page: Page) {
  await firstRun(apiFor(page))
  await openBoard(page)
  const boardId = await onlyBoard(apiFor(page))
  const welcome = (await exportJsonl(apiFor(page), boardId))
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l) as Rec)
    .find((r) => r.type === 'note') as Rec
  const { rev: _rev, ...base } = welcome
  const card = newId('note')
  await opsOn(page, boardId, [
    {
      op: 'note.create',
      note: { ...base, id: card, x: base.x + 360, text: 'Simplify, simplify.' },
    },
  ])
  return { boardId, card }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __csp: string[] }
    w.__csp = []
    document.addEventListener('securitypolicyviolation', (e) => {
      w.__csp.push(`${e.effectiveDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`)
    })
  })
})

const cspViolations = (page: Page) =>
  page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)

test('a note gets a ref at its bottom: Add reference, the field, the hairline, search, axe and the CSP', async ({
  page,
}) => {
  test.setTimeout(120_000)
  await page.setViewportSize(WIDE)
  const { boardId, card } = await seeded(page)
  await page.goto(`${APP_URL}/?bench`)
  await page.waitForFunction(() => window.__papertie?.ready === true)
  await page.evaluate(
    (id) => (window.__papertie.debug.focusCamera as (id: string, z: number) => void)(id, 1),
    card,
  )
  await page.waitForTimeout(600)
  // No ref: nothing at the note's bottom.
  await expect(noteEl(page, card).locator('.note-ref')).toHaveCount(0)

  // Written on: "Add reference" at the bottom of its editor opens the field, focused.
  await noteEl(page, card).dblclick()
  await expect(noteEl(page, card).getByRole('textbox', { name: 'Note text' })).toBeFocused()
  const add = noteEl(page, card).getByRole('button', { name: 'Add reference' })
  await add.click()
  const field = noteEl(page, card).getByRole('textbox', { name: 'Reference' })
  await expect(field).toBeFocused()
  await page.keyboard.type('Henry David Thoreau, Walden,')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Ticknor and Fields, 1854, p. 92')
  // Back to the note's text: still writing.
  await noteEl(page, card).getByRole('textbox', { name: 'Note text' }).click()
  await expect(noteEl(page, card)).toHaveClass(/note--editing/)
  // A press on the cork ends it: the ref commits with the writing.
  await page.locator('main.viewport').click({ position: { x: 20, y: 20 } })
  const ref = noteEl(page, card).getByRole('note', { name: 'Reference' })
  await expect(ref).toHaveText('Henry David Thoreau, Walden,\nTicknor and Fields, 1854, p. 92')
  await saved(page)
  await expect
    .poll(async () => (await serverBoard(apiFor(page), boardId)).notes.get(card)?.ref)
    .toBe('Henry David Thoreau, Walden,\nTicknor and Fields, 1854, p. 92')
  // Under a hairline.
  expect(
    await ref.evaluate((e) => {
      const s = getComputedStyle(e)
      return [s.borderTopStyle, s.borderTopWidth]
    }),
  ).toEqual(['solid', '1px'])

  await noteEl(page, card).click()
  expect(await axeViolations(page)).toEqual([])

  // Search finds the note by its ref.
  await page.keyboard.press('ControlOrMeta+k')
  await page.keyboard.type('ticknor')
  await expect(page.getByRole('option').first()).toContainText('Ticknor')
  await page.keyboard.press('Escape')

  // Cleared, it goes.
  await noteEl(page, card).dblclick()
  await noteEl(page, card).getByRole('textbox', { name: 'Reference' }).fill('')
  await page.locator('main.viewport').click({ position: { x: 20, y: 20 } })
  await expect(noteEl(page, card).locator('.note-ref')).toHaveCount(0)
  await saved(page)
  await expect
    .poll(async () => (await serverBoard(apiFor(page), boardId)).notes.get(card)?.ref)
    .toBeUndefined()

  expect(await cspViolations(page)).toEqual([])
})
