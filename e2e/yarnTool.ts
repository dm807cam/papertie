import { expect, type Page } from '@playwright/test'

/** The Yarn tool's colour picker (the sidebar's, or the mini-bar's). */
export const yarnPicker = (page: Page) => page.getByRole('dialog', { name: 'New thread' })

/**
 * Take the Yarn tool up by its key: Y opens its colour picker on the colour last chosen, and
 * Enter chooses it, which gives the keys back to the board. With `ui: 'hidden'` (a spec that hides
 * the UI layer, whose picker then takes no focus) a click on that colour chooses it instead.
 */
export async function armYarn(
  page: Page,
  { ui = 'shown' }: { ui?: 'shown' | 'hidden' } = {},
): Promise<void> {
  await page.keyboard.press('y')
  const picker = page.locator('.yarn-picker')
  if (ui === 'hidden') {
    await picker.locator('input:checked').dispatchEvent('click')
  } else {
    await expect(yarnPicker(page)).toBeVisible()
    await page.keyboard.press('Enter')
  }
  await expect(picker).toHaveCount(0)
}
