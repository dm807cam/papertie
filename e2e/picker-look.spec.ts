import { expect, type Locator, type Page, test } from '@playwright/test'
import './hooks'
import { yarnPicker } from './yarnTool'

/**
 * The search palette and the "+" and yarn sheets share no classes: each keeps its own look.
 * ⌘K's rows set the paper swatch beside the snippet, on its first line, under a display serif title;
 * the sheets' row titles stay in Patrick Hand.
 */

test.use({ viewport: { width: 1280, height: 720 } })

async function open(page: Page): Promise<string[]> {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/bench?board=demo')
  await page.waitForFunction(() => window.__papertie?.ready === true)
  await page.waitForFunction(() => window.__papertie.runtime.loop.running === false)
  return errors
}

const fontOf = (l: Locator) => l.evaluate((el) => getComputedStyle(el).fontFamily)

test('⌘K rows set the swatch beside the snippet, on its first line', async ({ page }) => {
  const errors = await open(page)
  await page.keyboard.press('ControlOrMeta+k')
  const palette = page.getByRole('dialog', { name: 'Search notes' })
  await expect(palette).toBeVisible()
  await expect(palette).not.toHaveAttribute('data-waiting', /.*/)
  const rows = palette.getByRole('option')
  await expect(rows.first()).toBeVisible()
  const count = await rows.count()
  expect(count).toBeGreaterThan(0)
  for (let i = 0; i < count; i++) {
    const [swatch, text] = await rows
      .nth(i)
      .evaluate((row) =>
        ['.picker-swatch', '.picker-text'].map((s) =>
          (row.querySelector(s) as HTMLElement).getBoundingClientRect().toJSON(),
        ),
      )
    // Side by side, the swatch's top within the snippet's first line (its 4 px drop sets it
    // on the line's ink), never on a line of its own above it.
    expect(swatch.right).toBeLessThanOrEqual(text.left)
    expect(Math.abs(swatch.top - text.top)).toBeLessThanOrEqual(6)
  }
  // The palette's own title: display serif, not a sheet's hand.
  expect(await fontOf(palette.locator('.picker-title'))).toContain('Newsreader')
  await page.keyboard.press('Escape')
  expect(errors).toEqual([])
})

test('⌘K replaces an open "+" or yarn sheet; Esc then gives the board the focus', async ({
  page,
}) => {
  const errors = await open(page)
  const tools = page.getByRole('toolbar', { name: 'Tools' })
  const search = page.getByRole('dialog', { name: 'Search notes' })
  for (const [button, sheet] of [
    ['New note', page.getByRole('dialog', { name: 'New note' })],
    ['Yarn', yarnPicker(page)],
  ] as const) {
    await tools.getByRole('button', { name: button, exact: true }).click()
    await expect(sheet).toBeVisible()
    await page.keyboard.press('ControlOrMeta+k')
    await expect(search).toBeVisible()
    await expect(sheet).toHaveCount(0)
    await expect(search.getByRole('combobox')).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(search).toHaveCount(0)
    await expect(page.getByRole('main', { name: 'Board' })).toBeFocused()
  }
  expect(errors).toEqual([])
})

test('the "+" and yarn sheets keep their Patrick Hand row titles', async ({ page }) => {
  const errors = await open(page)
  await page
    .getByRole('toolbar', { name: 'Tools' })
    .getByRole('button', { name: 'New note' })
    .click()
  const note = page.getByRole('dialog', { name: 'New note' })
  await expect(note).toBeVisible()
  const titles = note.locator('.sheet-title')
  expect(await titles.count()).toBeGreaterThan(0)
  for (const f of await titles.evaluateAll((els) =>
    els.map((e) => getComputedStyle(e).fontFamily),
  )) {
    expect(f).toContain('Patrick Hand')
  }
  await page.keyboard.press('Escape')
  await expect(note).toHaveCount(0)

  await page
    .getByRole('toolbar', { name: 'Tools' })
    .getByRole('button', { name: 'Yarn', exact: true })
    .click()
  const yarn = yarnPicker(page)
  await expect(yarn).toBeVisible()
  const yarnTitles = yarn.locator('.sheet-title')
  expect(await yarnTitles.count()).toBeGreaterThan(0)
  expect(await fontOf(yarnTitles.first())).toContain('Patrick Hand')
  await page.keyboard.press('Escape')
  expect(errors).toEqual([])
})
