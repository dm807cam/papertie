import { expect, type Page, test } from '@playwright/test'
import { emptyBoardState, serializeBoard } from '../packages/core/src'
import './hooks'
import { yarnPicker } from './yarnTool'

/**
 * Settings over the board, in a real browser (jsdom cannot hit-test): the sidebar, the save dot's
 * popover and the notice slips stay reachable by pointer beside the sheet, and the board takes no
 * wheel or press in the gutters around the sidebar. The `proto` project has no server, so the
 * API is answered here from `page.route`; the session is a stand-in whose feed the test drives. The stubs below follow
 * `apps/web/src/api/*` and `app/bootstrap.ts`.
 */
const VIEW = { width: 1280, height: 800 }
test.use({ viewport: VIEW })

const BOARD_ID = 'board_01JBX0000000000000000000AA'
const NOW = '2026-10-30T09:00:00.000Z'

async function stubServer(page: Page) {
  const json = (body: unknown) => ({ contentType: 'application/json', body: JSON.stringify(body) })
  await page.route('**/api/boards', (r) =>
    r.fulfill(
      json([
        {
          id: BOARD_ID,
          name: 'My board',
          revision: 1,
          createdAt: NOW,
          updatedAt: NOW,
          recovered: false,
        },
      ]),
    ),
  )
  await page.route(`**/api/boards/${BOARD_ID}`, (r) =>
    r.fulfill({
      contentType: 'application/x-ndjson',
      headers: { 'X-Papertie-Revision': '1', 'X-Papertie-Now': NOW },
      body: serializeBoard(emptyBoardState(BOARD_ID, 'My board', NOW)),
    }),
  )
  // The event stream answers `hello` and ends; the client reconnects quietly.
  await page.route(`**/api/boards/${BOARD_ID}/events**`, (r) =>
    r.fulfill({
      contentType: 'text/event-stream',
      body: 'event: hello\ndata: {"revision":1}\n\n',
    }),
  )
  await page.route(`**/api/boards/${BOARD_ID}/meta`, (r) =>
    r.fulfill(
      json({
        id: BOARD_ID,
        name: 'My board',
        revision: 1,
        recovery: null,
        notes: 0,
        extent: null,
      }),
    ),
  )
  // The catch-up a resumed board asks for (`GET /ops?since`): nothing since.
  await page.route(
    (url) => url.pathname === `/api/boards/${BOARD_ID}/ops` && url.searchParams.has('since'),
    (r) =>
      r.fulfill({
        ...json({ revision: 1, commits: [] }),
        headers: { 'X-Papertie-Now': NOW },
      }),
  )
}

async function openSettings(page: Page) {
  await stubServer(page)
  await page.goto('/settings/preferences')
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
  await page.waitForFunction(() => window.__papertie?.ready === true)
}

/** The element a pointer at (x, y) would land on, as a class list. */
const hit = (page: Page, x: number, y: number) =>
  page.evaluate(
    ([px, py]) => document.elementFromPoint(px as number, py as number)?.className ?? null,
    [x, y],
  )

const camera = (page: Page) => page.evaluate(() => window.__papertie.debug.camera())

test('the board takes no wheel or press in the gutters around the sidebar', async ({ page }) => {
  await openSettings(page)
  const before = await camera(page)
  // x 0-14 and 66-80 above, beside and below the sidebar's pill (14-66 px wide).
  for (const [x, y] of [
    [7, 300],
    [73, 300],
    [40, 10],
    [40, VIEW.height - 8],
  ] as const) {
    expect(String(await hit(page, x, y))).toContain('settings-veil')
    await page.mouse.move(x, y)
    await page.mouse.wheel(0, 240)
    await page.mouse.down()
    await page.mouse.move(x + 60, y + 40)
    await page.mouse.up()
    // A press on the veil closes the sheet: open it again for the next point.
    await page.goto('/settings/preferences')
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
    await page.waitForFunction(() => window.__papertie?.ready === true)
  }
  expect(await camera(page)).toEqual(before)
})

test('the sidebar, the save popover and the notice slips can be clicked beside the sheet', async ({
  page,
}) => {
  await openSettings(page)
  // Something to say: the dot shows, and a refused change leaves a slip and a line in the popover.
  await page.evaluate(() => {
    const hooks = window.__papertie as unknown as {
      session: { feed: { status(s: string): void; notice(n: object): void } }
    }
    hooks.session.feed.status('offline')
    hooks.session.feed.notice({ kind: 'rejected', count: 1, message: '1 change couldn’t be saved' })
  })
  const dot = page.getByRole('button', { name: /not saved yet/i })
  await dot.click()
  const popover = page.getByRole('dialog', { name: 'Save status' })
  await expect(popover).toBeVisible()
  // The popover overlaps the sheet: its button takes the click, and Settings stays open.
  const box = await popover.getByRole('button', { name: 'Download unsaved changes' }).boundingBox()
  if (box === null) throw new Error('no download button')
  // Waiting for the store, the download is the popover's quiet text button (the ink one is Couldn't save's).
  expect(String(await hit(page, box.x + box.width / 2, box.y + box.height / 2))).toContain(
    'sync-text-button',
  )
  await popover.getByRole('button', { name: 'Clear' }).click({ trial: true })
  await expect(page).toHaveURL(/\/settings\/preferences$/)

  // The notice slip at the foot takes its dismiss click; Settings stays.
  await page.getByRole('button', { name: 'Dismiss' }).click()
  await expect(page).toHaveURL(/\/settings\/preferences$/)

  // The sidebar: Settings is pressed, and its second click closes the sheet.
  const settings = page
    .getByRole('toolbar', { name: 'Tools' })
    .getByRole('button', { name: 'Settings' })
  await expect(settings).toHaveAttribute('aria-pressed', 'true')
  await settings.click()
  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0)
})

test('a tool of the sidebar closes the sheet and takes effect', async ({ page }) => {
  await openSettings(page)
  await page.getByRole('toolbar', { name: 'Tools' }).getByRole('button', { name: 'Yarn' }).click()
  await expect(page).toHaveURL(/\/$/)
  // Yarn takes its colour first.
  await yarnPicker(page).getByRole('radio', { name: 'Moss' }).click()
  await expect(
    page.getByRole('toolbar', { name: 'Tools' }).getByRole('button', { name: 'Yarn' }),
  ).toHaveAttribute('aria-pressed', 'true')
})

test('⌘K does nothing under Settings', async ({ page }) => {
  await openSettings(page)
  await page.keyboard.press('ControlOrMeta+k')
  await page.waitForTimeout(200)
  await expect(page.getByRole('dialog', { name: 'Search notes' })).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
})

test('the mark folds the panel and leaves the sheet open', async ({ page }) => {
  await openSettings(page)
  await page
    .getByRole('toolbar', { name: 'Tools' })
    .getByRole('button', { name: 'Papertie — hide tools' })
    .click()
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
  await expect(
    page.getByRole('toolbar', { name: 'Tools' }).getByRole('button', { name: 'Settings' }),
  ).toBeHidden()
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test('the Settings tabs show the open one whole, and fade where the strip runs on', async ({
    page,
  }) => {
    await openSettings(page)
    const nav = page.getByRole('navigation', { name: 'Settings' })
    const read = () =>
      nav.evaluate((el) => {
        const box = el.getBoundingClientRect()
        const inside = (r: DOMRect) => r.left >= box.left - 0.5 && r.right <= box.right + 0.5
        const current = el.querySelector('[aria-current="page"]')?.getBoundingClientRect()
        const tabs = [...el.querySelectorAll('.settings-tab')].map((t) => t.getBoundingClientRect())
        return {
          whole: current !== undefined && inside(current),
          cutStart: tabs.some((r) => r.left < box.left - 0.5),
          cutEnd: tabs.some((r) => r.right > box.right + 0.5),
          clip: (el as HTMLElement).dataset.clip ?? '',
          mask: getComputedStyle(el).maskImage,
        }
      })
    // Preferences, near the end of the strip, is open: whole in view.
    let s = await read()
    expect(s.whole).toBe(true)
    // Wherever the strip runs past its edge, that edge fades (and says so), never a cut glyph.
    expect(s.clip).toBe([s.cutStart && 'start', s.cutEnd && 'end'].filter(Boolean).join(' '))
    if (s.cutStart || s.cutEnd) expect(s.mask).toContain('linear-gradient')
    // From the first tab, the same.
    await page.goto('/settings/export')
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()
    s = await read()
    expect(s.whole).toBe(true)
    expect(s.clip).toBe([s.cutStart && 'start', s.cutEnd && 'end'].filter(Boolean).join(' '))
  })
})
