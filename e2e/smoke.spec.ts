import { expect, test } from '@playwright/test'

const ROUTES = [
  { path: '/study', testId: 'study' },
  { path: '/bench?board=demo', testId: 'canvas' },
  { path: '/sign-in', testId: 'app-shell' },
]

for (const { path, testId } of ROUTES) {
  test(`${path} loads without console errors and carries palette vars`, async ({ page }) => {
    const errors: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text())
    })
    page.on('pageerror', (e) => errors.push(e.message))

    await page.goto(path)
    await expect(page.getByTestId(testId)).toBeAttached()
    const cream = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--paper-cream').trim(),
    )
    expect(cream).toBe('#F3EBDD')
    expect(errors).toEqual([])
  })
}

test('/bench?board=demo renders the demo board', async ({ page }) => {
  await page.goto('/bench?board=demo')
  await page.waitForFunction(() => window.__papertie?.ready === true)
  expect(await page.evaluate(() => window.__papertie.store.getState().notes.size)).toBe(23)
})

test('the old /?board= URL redirects to /bench?board= in dev', async ({ page }) => {
  await page.goto('/bench?board=100')
  await page.waitForURL(/\/bench\?board=100$/)
  await page.waitForFunction(() => window.__papertie?.ready === true)
  expect(await page.evaluate(() => window.__papertie.store.getState().notes.size)).toBe(100)
})
