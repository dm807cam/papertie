import type { Page } from '@playwright/test'
import { newId } from '../../packages/core/src'
import { APP_URL, apiFor, download, expect, test } from './helpers/app'
import { seedBook } from './helpers/books'
import { firstRun, onlyBoard, openBoard } from './helpers/server'
import { unzip } from './helpers/zip'

/**
 * Export in the app: a book's options on the shelf offer Markdown and Word, which
 * come down from the server's export route as files. Each download is read back here: unzipped,
 * its text the book's.
 */

async function account(page: Page, _tag: string): Promise<string> {
  await firstRun(apiFor(page))
  await openBoard(page)
  return onlyBoard(apiFor(page))
}

async function seeded(page: Page, tag: string): Promise<{ boardId: string; bookId: string }> {
  const boardId = await account(page, tag)
  const note = newId('block')
  const bookId = await seedBook(page, boardId, {
    title: 'Pond letters',
    blocks: [
      { kind: 'h1', text: 'The pond' },
      { text: 'Walden is deep and clear.', marks: [{ t: `n:${note}`, from: 0, to: 6 }] },
      { kind: 'footnote', text: 'Thoreau, Walden, 1854.', id: note },
      { kind: 'prompt', text: 'Never exported prompt' },
      { kind: 'h1', text: 'Winter' },
      { text: 'Ice on the water.' },
    ],
  })
  return { boardId, bookId }
}

const options = async (page: Page, title: string) => {
  await page.goto(`${APP_URL}/shelf`)
  const shelf = page.getByRole('dialog', { name: 'Books' })
  await shelf.getByRole('button', { name: `Options for ${title}` }).click()
  const pop = page.getByRole('dialog', { name: title })
  await pop.getByRole('button', { name: 'Export' }).click()
  return pop.getByRole('group', { name: 'Export as' })
}

test('the Markdown and Word downloads arrive and unzip, with the book’s text inside', async ({
  page,
}) => {
  await seeded(page, 'export-files')
  const choices = await options(page, 'Pond letters')
  await expect(choices.getByRole('link')).toHaveText(['Markdown', 'Word'])

  const md = await download(page, () => choices.getByRole('link', { name: 'Markdown' }).click())
  expect(md.name).toBe('pond-letters.zip')
  const mdZip = unzip(md.bytes)
  const text = mdZip.get('pond-letters.md')?.toString('utf8') ?? ''
  expect(text).toContain('# Pond letters')
  expect(text).toContain('## The pond')
  expect(text).toContain('Walden[^1] is deep and clear.')
  expect(text).toContain('[^1]: Thoreau, Walden, 1854.')
  expect(text).not.toContain('Never exported prompt')

  // The popover is still there after a download (the link is not taken away under the click).
  const again = page.getByRole('group', { name: 'Export as' })
  const docx = await download(page, () => again.getByRole('link', { name: 'Word' }).click())
  expect(docx.name).toBe('pond-letters.docx')
  const parts = unzip(docx.bytes)
  const doc = parts.get('word/document.xml')?.toString('utf8') ?? ''
  expect(doc).toContain('Ice on the water.')
  expect(doc).toContain('w:footnoteReference')
  expect(parts.get('word/footnotes.xml')?.toString('utf8')).toContain('Thoreau, Walden, 1854.')
  expect(doc).not.toContain('Never exported prompt')
})
