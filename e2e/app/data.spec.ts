import type { Page } from '@playwright/test'
import { readZip } from '../../apps/server/test/helpers/zip'
import { APP_URL, apiFor, download, expect, test } from './helpers/app'
import { idle, saved } from './helpers/board'
import { bareCork, expectNoAccountWords, openEmptyBoard, pageNotes, pinNote } from './helpers/page'
import { boardIds, freshStart, onlyBoard, serverBoard } from './helpers/server'

/**
 * The board's data through Settings, in the built app: exported to a `.papertie` file and imported
 * from it again, and all of it deleted. Each spec starts from an empty board.
 */

/** Every page error from now on, for a check at the end. */
function watch(page: Page): { errors: string[] } {
  const out = { errors: [] as string[] }
  page.on('pageerror', (e) => out.errors.push(e.message))
  return out
}

const tools = (page: Page) => page.getByRole('toolbar', { name: 'Tools' })

async function openSettings(page: Page, tab: string) {
  await tools(page).getByRole('button', { name: 'Settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await expect(settings).toBeVisible()
  await settings.getByRole('link', { name: tab }).click()
  return settings
}

test.beforeEach(async ({ api }) => {
  await freshStart(api)
})

test('export, then import: the board comes back from its .papertie file', async ({ page }) => {
  test.setTimeout(120_000)
  const seen = watch(page)
  await openEmptyBoard(page)
  const boardId = await onlyBoard(apiFor(page))
  const kept = await pinNote(page, 'Kept in the file', await bareCork(page))
  await page.keyboard.press('Escape')
  await saved(page)

  // Export .papertie from Settings.
  const settings = await openSettings(page, 'Export')
  await expectNoAccountWords(page)
  const { name, bytes: file } = await download(page, () =>
    settings.getByRole('link', { name: 'Download .papertie' }).click(),
  )
  expect(name).toMatch(/\.papertie$/)
  expect(
    readZip(file)
      .map((e) => e.name)
      .sort(),
  ).toEqual(['board.jsonl', 'manifest.json'])
  await page.keyboard.press('Escape')
  await expect(settings).toHaveCount(0)

  // A note made after the export, which the import takes away again.
  const later = await pinNote(page, 'Made after', await bareCork(page, 140))
  await page.keyboard.press('Escape')
  await saved(page)
  expect(Object.keys(await pageNotes(page)).sort()).toEqual([kept, later].sort())

  // Import the file from Settings: asked, then replaced.
  await page.goto(`${APP_URL}/settings/export?bench`)
  const sheet = page.getByRole('dialog', { name: 'Settings' })
  const choosing = page.waitForEvent('filechooser')
  await sheet.getByRole('button', { name: 'Import…' }).click()
  await (await choosing).setFiles({
    name: 'board.papertie',
    mimeType: 'application/zip',
    buffer: file,
  })
  const ask = sheet.getByRole('alertdialog')
  await expect(ask).toBeVisible()
  await ask.getByRole('button', { name: 'Replace board' }).click()
  await expect(sheet.getByText('Board replaced. You can undo this from History.')).toBeVisible()
  await expect.poll(async () => Object.keys(await pageNotes(page))).toEqual([kept])
  await expect
    .poll(async () => [...(await serverBoard(apiFor(page), boardId)).notes.keys()])
    .toEqual([kept])
  expect(seen.errors).toEqual([])
})

test('Delete all data, typed, leaves one empty board and the app starts again', async ({
  page,
}) => {
  test.setTimeout(120_000)
  const seen = watch(page)
  await openEmptyBoard(page)
  const old = await onlyBoard(apiFor(page))
  await pinNote(page, 'Soon gone', await bareCork(page))
  await page.keyboard.press('Escape')
  await saved(page)

  const settings = await openSettings(page, 'Data')
  await expectNoAccountWords(page)
  await settings.getByRole('button', { name: 'Delete all data…' }).click()
  const go = settings.getByRole('button', { name: 'Delete all data', exact: true })
  await expect(go).toBeDisabled()
  await settings.getByLabel('Type delete to confirm').fill('delete')
  await go.click()
  // The page loads afresh, at the board.
  await page.waitForURL((u) => u.pathname === '/')
  await expect(page.getByTestId('canvas')).toBeVisible()
  const ids = await boardIds(apiFor(page))
  expect(ids).toHaveLength(1)
  expect(ids[0]).not.toBe(old)
  expect((await serverBoard(apiFor(page), ids[0] as string)).notes.size).toBe(0)
  await openEmptyBoard(page)
  await idle(page)
  expect(await pageNotes(page)).toEqual({})
  expect(seen.errors).toEqual([])
})
