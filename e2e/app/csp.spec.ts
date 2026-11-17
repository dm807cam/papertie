import type { Page, Response, Worker } from '@playwright/test'
import { type Note, newId, type Op } from '../../packages/core/src'
import { APP_URL, apiFor, expect, test } from './helpers/app'
import { seedBook, seedBooks, uploadFigure } from './helpers/books'
import { seedBoard } from './helpers/lifetime'
import { exportJsonl, firstRun, onlyBoard, openBoard } from './helpers/server'
import { writing } from './helpers/states'

/**
 * The app under the headers its own routes answer with runs whole without a
 * Content Security Policy violation: a board past the far-zoom threshold (its parse, search and
 * pyramid workers, each a module worker from `/assets`), ⌘K, a pasted photo (a `blob:` preview,
 * then the served WebP), Settings with an import preview, and the Data section. Every response
 * of the origin carries the strict CSP, `Referrer-Policy: no-referrer` and `nosniff`.
 *
 * The app falls back quietly when a worker cannot start (parse on the page, search on the page,
 * the card overview), so the workers are watched starting, not only the violations counted.
 */

/** The policy (as in `apps/server/test/http.test.ts`): strict, no inline script or style. */
const SPEC_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ')

/** Past `PYRAMID_ABOVE` (5,000): the far-zoom pyramid is made for this board. */
const NOTES = 5_200
const NEEDLE = 'knot-CSP-check'

interface Violation {
  directive: string
  blocked: string
  source: string
}

/** How a worker's watcher says a violation: a console line of its own, read by the test. */
const SAID = 'csp-violation '

interface Watch {
  /** Every `securitypolicyviolation`, in the document or a worker. */
  violations: Violation[]
  /** Console lines that speak of the policy. */
  cspConsole: string[]
  errors: string[]
  /** The workers started. */
  workers: Worker[]
}

/**
 * Everything the policy blocks in the window: each `securitypolicyviolation` in its document (an
 * init script, across navigations) and in each worker's own scope (a worker's violations are
 * dispatched there only: a listener, set as the worker is found and before its module script is
 * in, says each on the worker's console), every console line that speaks of the policy, and what
 * the page throws.
 */
async function watch(page: Page): Promise<Watch> {
  const seen: Watch = { violations: [], cspConsole: [], errors: [], workers: [] }
  const line = (text: string) => {
    if (text.startsWith(SAID)) seen.violations.push(JSON.parse(text.slice(SAID.length)))
    else if (/content security policy|refused to/i.test(text)) seen.cspConsole.push(text)
  }
  await page.exposeBinding('__cspViolation', (_source, v: Violation) => {
    seen.violations.push(v)
  })
  await page.addInitScript(() => {
    const report = (window as unknown as { __cspViolation(v: unknown): void }).__cspViolation
    document.addEventListener('securitypolicyviolation', (e) => {
      report({
        directive: e.effectiveDirective,
        blocked: e.blockedURI,
        source: `${e.sourceFile}:${e.lineNumber}`,
      })
    })
  })
  page.on('pageerror', (e) => seen.errors.push(e.message))
  page.on('console', (m) => line(m.text()))
  page.on('worker', (w) => {
    seen.workers.push(w)
    w.on('console', (m) => line(m.text()))
    // A worker that has ended already has nothing more to say.
    void w
      .evaluate((said) => {
        self.addEventListener('securitypolicyviolation', (e) => {
          const v = e as SecurityPolicyViolationEvent
          console.warn(
            said +
              JSON.stringify({
                directive: `worker ${v.effectiveDirective}`,
                blocked: v.blockedURI,
                source: `${v.sourceFile}:${v.lineNumber}`,
              }),
          )
        })
      }, SAID)
      .catch(() => {})
  })
  return seen
}

/** A note of the seeded grid; one of them carries the needle. */
function seededNote(i: number, at: string): Note {
  return {
    type: 'note',
    id: newId('note'),
    x: (i % 80) * 300,
    y: Math.floor(i / 80) * 240,
    w: 240,
    h: 160,
    z: i + 2,
    paper: 'cream',
    style: 'rustic',
    text: i === 2_345 ? NEEDLE : `memo ${i} cork thread`,
    image: null,
    createdAt: at,
    updatedAt: at,
  }
}

/** The one board, filled with `NOTES` notes through the API. */
function seed(page: Page): Promise<string> {
  const at = new Date().toISOString()
  return seedBoard(
    apiFor(page),
    Array.from({ length: NOTES }, (_, i): Op => ({ op: 'note.create', note: seededNote(i, at) })),
  )
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
    const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b as Blob), 'image/png'))
    const dt = new DataTransfer()
    dt.items.add(new File([blob], 'screenshot.png', { type: 'image/png' }))
    ;(document.activeElement as HTMLElement | null)?.blur()
    document.body.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
    )
  })

/** The board is whole (no longer opening) with the test hooks installed. */
const whole = (page: Page) =>
  page.waitForFunction(
    () => {
      const h = window.__papertie as unknown as
        | { ready?: boolean; session?: { opening?: { open: boolean } } }
        | undefined
      return h?.ready === true && h.session?.opening?.open === false
    },
    undefined,
    { timeout: 120_000 },
  )

const pyramidOn = (page: Page) =>
  page.waitForFunction(
    () =>
      (
        window.__papertie as unknown as { debug: { pyramid(): { on: boolean } | null } }
      ).debug.pyramid()?.on === true,
    undefined,
    { timeout: 120_000 },
  )

test('the app runs under its CSP: no violation, every worker starts, every response has the headers', async ({
  page,
}) => {
  test.setTimeout(300_000)
  const seen = await watch(page)
  const started = (script: RegExp) => seen.workers.some((w) => script.test(w.url()))
  const responses: Response[] = []
  page.on('response', (r) => {
    if (r.url().startsWith(APP_URL)) responses.push(r)
  })

  // 1–2. The board, filled past the pyramid's threshold before the app first opens it, so its
  // first load is whole: through the parse worker.
  const boardId = await seed(page)
  await page.goto(`${APP_URL}/`)
  await expect(page).toHaveURL(/\/$/)
  await expect.poll(() => started(/\/assets\/parseWorker-[\w-]+\.js$/)).toBe(true)

  // 3. With the test hooks: the whole board fitted (overview), drawn from the pyramid.
  await page.goto(`${APP_URL}/?bench`)
  await whole(page)
  await pyramidOn(page)
  expect(await page.evaluate(() => window.__papertie?.debug.lod())).toBe('overview')
  expect(started(/\/assets\/worker-[\w-]+\.js$/)).toBe(true)

  // 4. ⌘K finds the needle (the search worker's index).
  await page.keyboard.press('ControlOrMeta+k')
  const palette = page.getByRole('dialog', { name: 'Search notes' })
  await expect(palette).toBeVisible()
  await page.getByRole('combobox').pressSequentially('CSP-check', { delay: 40 })
  await expect(page.getByRole('option')).toHaveCount(1, { timeout: 60_000 })
  await expect(page.getByRole('option')).toContainText(NEEDLE)
  expect(started(/\/assets\/index\.worker-[\w-]+\.js$/)).toBe(true)
  await page.keyboard.press('Escape')
  await expect(palette).toBeHidden()

  // 5. A pasted photo: its preview (blob:), its upload, then the served WebP, close up and in
  // the far-zoom picture.
  await pastePng(page)
  await expect
    .poll(
      async () => {
        const lines = (await exportJsonl(apiFor(page), boardId)).split('\n')
        return lines.some((l) => l.includes('"image":{"assetId"'))
      },
      { timeout: 30_000 },
    )
    .toBe(true)
  const print = await page.evaluate(
    () =>
      [...window.__papertie.store.getState().notes.values()].find(
        (n) => (n as unknown as { image: unknown }).image !== null,
      )?.id,
  )
  if (print === undefined) throw new Error('no print note')
  await page.evaluate((id) => window.__papertie.debug.focusCamera(id, 1), print)
  await expect(page.locator(`article.note[data-note-id="${print}"] img`)).toBeVisible({
    timeout: 30_000,
  })
  await page.keyboard.press('Escape')
  await page.keyboard.press('Shift+Digit1')
  await pyramidOn(page)

  // 6. Settings: every section, and an import previewed then kept away.
  const tools = page.getByRole('toolbar', { name: 'Tools' })
  await tools.getByRole('button', { name: 'Settings' }).click()
  const settings = page.getByRole('dialog', { name: 'Settings' })
  await expect(settings).toBeVisible()
  for (const name of ['History', 'Preferences', 'Data', 'Export']) {
    await settings.getByRole('link', { name }).click()
    await expect(settings.getByRole('link', { name })).toHaveAttribute('aria-current', 'page')
  }
  // The board with its photo: a `.papertie` (a plain JSONL showing a photo is refused).
  const archive = await apiFor(page).get(`/api/boards/${boardId}/export?format=papertie`)
  expect(archive.status()).toBe(200)
  const choosing = page.waitForEvent('filechooser')
  await settings.getByRole('button', { name: 'Import…' }).click()
  await (await choosing).setFiles({
    name: 'board.papertie',
    mimeType: 'application/zip',
    buffer: await archive.body(),
  })
  const ask = settings.getByRole('alertdialog')
  await expect(ask).toBeVisible({ timeout: 60_000 })
  await ask.getByRole('button', { name: 'Keep current' }).click()
  await expect(ask).toBeHidden()

  // 7. The Data section, asked and left: nothing is deleted.
  await settings.getByRole('link', { name: 'Data' }).click()
  await settings.getByRole('button', { name: 'Delete all data…' }).click()
  await settings.getByRole('button', { name: 'Cancel' }).click()
  expect(await onlyBoard(apiFor(page))).toBe(boardId)

  // Nothing the policy blocked, in a document or a worker; nothing thrown.
  expect(seen.violations).toEqual([])
  expect(seen.cspConsole).toEqual([])
  expect(seen.errors).toEqual([])

  // Every response of the origin: scripts, workers, styles, fonts, API answers, photos, errors.
  const kinds = new Set<string>()
  for (const r of responses) {
    const h = await r.allHeaders()
    const what = `${r.request().method()} ${new URL(r.url()).pathname} ${r.status()}`
    kinds.add(r.request().resourceType())
    expect(h['content-security-policy'], what).toBe(SPEC_CSP)
    expect(h['referrer-policy'], what).toBe('no-referrer')
    expect(h['x-content-type-options'], what).toBe('nosniff')
  }
  for (const k of ['script', 'stylesheet', 'fetch', 'image']) {
    expect([...kinds], k).toContain(k)
  }
  // The document and the workers' scripts (the window reports no response for a navigation of
  // the app's protocol, nor for a worker's script): each asked again.
  const asked = ['/', ...new Set(seen.workers.map((w) => new URL(w.url()).pathname))]
  expect(asked.length).toBeGreaterThanOrEqual(4)
  for (const path of asked) {
    const h = (await apiFor(page).get(path)).headers()
    expect(h['content-security-policy'], path).toBe(SPEC_CSP)
    expect(h['referrer-policy'], path).toBe('no-referrer')
    expect(h['x-content-type-options'], path).toBe('nosniff')
  }

  // The watch is a real one: a worker is under the policy, and what it is refused is seen.
  const worker = seen.workers.findLast((w) => /\/assets\/index\.worker-/.test(w.url()))
  if (worker === undefined) throw new Error('no search worker')
  await worker.evaluate(() => fetch('https://csp.invalid/').catch(() => {}))
  await expect.poll(() => seen.violations.length).toBeGreaterThan(0)
  for (const v of seen.violations) {
    expect(v).toMatchObject({ directive: 'worker connect-src', blocked: 'https://csp.invalid/' })
  }
})

test('the shelf raises no CSP violation', async ({ page }) => {
  test.setTimeout(120_000)
  const seen = await watch(page)
  await firstRun(apiFor(page))
  await openBoard(page)
  const boardId = await onlyBoard(apiFor(page))
  await seedBooks(page, boardId, 8)

  // The shelf from Books: its wood, the covers (their filters, the stamp image), a new book.
  await page.reload()
  const tools = page.getByRole('toolbar', { name: 'Tools' })
  await tools.getByRole('button', { name: 'Books' }).click()
  const shelf = page.getByRole('dialog', { name: 'Books' })
  await expect(shelf.locator('.cover')).toHaveCount(8)
  await shelf.getByRole('button', { name: 'New book' }).click()
  await expect(page.getByRole('textbox', { name: 'Title' })).toBeFocused()
  await page.keyboard.type('Pressed flowers')
  await page.keyboard.press('Escape')
  // A popover's New cover and Language, a delete and its putting back.
  await shelf.getByRole('button', { name: 'Options for Field notes' }).click()
  await page
    .getByRole('dialog', { name: 'Field notes' })
    .getByRole('button', { name: 'New cover' })
    .click()
  await shelf.getByRole('button', { name: 'Options for Field notes' }).click()
  await page
    .getByRole('dialog', { name: 'Field notes' })
    .getByRole('radio', { name: 'German' })
    .check()
  await page.keyboard.press('Escape')
  await shelf.getByRole('button', { name: 'Options for Winter letters' }).click()
  await page
    .getByRole('dialog', { name: 'Winter letters' })
    .getByRole('button', { name: 'Delete' })
    .click()
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click()
  await shelf.getByRole('button', { name: 'Recently deleted' }).click()
  await page
    .getByRole('dialog', { name: 'Recently deleted' })
    .getByRole('button', { name: 'Put it back' })
    .click()
  // Keyboard reorder.
  await shelf.getByRole('button', { name: 'Field notes', exact: true }).focus()
  await page.keyboard.press('Alt+ArrowRight')
  await expect(shelf).toBeVisible()
  await page.evaluate(() => document.fonts.ready)

  expect(seen.violations).toEqual([])
  expect(seen.cspConsole).toEqual([])
  expect(seen.errors).toEqual([])
})

test('the split view raises no CSP violation', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  const seen = await watch(page)
  await firstRun(apiFor(page))
  await openBoard(page)
  const boardId = await onlyBoard(apiFor(page))
  const bookId = await seedBook(page, boardId, {
    title: 'Beside',
    blocks: [{ text: 'Beside the board.' }],
  })
  await page.goto(`${APP_URL}/book/${bookId}`)
  await expect(page.locator('.board-split')).toHaveAttribute('data-layout', 'split')
  // The seam dragged (its share and the frozen sheet width set through the CSSOM), its keys,
  // ⌘\ to full width and back.
  const seam = page.getByRole('separator', { name: 'Book width' })
  const box = await seam.boundingBox()
  await page.mouse.move((box?.x ?? 0) + 6, 300)
  await page.mouse.down()
  await page.mouse.move(500, 300, { steps: 5 })
  await page.mouse.up()
  await seam.focus()
  await page.keyboard.press('ArrowRight')
  await page.locator('.writer [data-id]').first().click()
  await page.keyboard.press('ControlOrMeta+Backslash')
  await expect(page.locator('.board-split')).toHaveAttribute('data-layout', 'full')
  await page.keyboard.press('ControlOrMeta+Backslash')
  await expect(page.locator('.board-split')).toHaveAttribute('data-layout', 'split')
  expect(seen.violations).toEqual([])
  expect(seen.cspConsole).toEqual([])
  expect(seen.errors).toEqual([])
})

test('the writer raises no CSP violation', async ({ page }) => {
  test.setTimeout(120_000)
  const seen = await watch(page)
  await firstRun(apiFor(page))
  await openBoard(page)
  const boardId = await onlyBoard(apiFor(page))
  // A prompt in the margin (its top set through the CSSOM) and a figure (its box's
  // aspect too), after the two paragraphs typed into below.
  const assetId = await uploadFigure(page, boardId)
  const bookId = await seedBook(page, boardId, {
    title: 'Field notes',
    blocks: [
      { text: 'First paragraph, plain.' },
      { text: '' },
      { kind: 'prompt', text: 'A note in the margin.' },
      { kind: 'figure', text: 'A caption', image: { assetId } },
    ],
  })
  await page.goto(`${APP_URL}/book/${bookId}`)
  const blocks = page.locator('.writer [data-id]')
  await expect(blocks).toHaveCount(4)
  await expect(blocks.nth(3).locator('img')).toBeVisible()
  // Every kind and mark from its accelerator, typography, Enter, a merge, an undo.
  await blocks.nth(1).click()
  await page.keyboard.type('# A chapter')
  await page.keyboard.press('Enter')
  await page.keyboard.type('## A section')
  await page.keyboard.press('Enter')
  await page.keyboard.type('> "Quoted" -- said...')
  await page.keyboard.press('Enter')
  await page.keyboard.type('- an item with *italic* and **bold**')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('ControlOrMeta+z')
  // The sidebar's Bold on a selection, and a paste of styled HTML (its styles dropped, never
  // applied).
  await blocks.first().dblclick({ position: { x: 10, y: 10 } })
  await writing(page).getByRole('button', { name: 'Bold' }).click()
  await page.keyboard.press('End')
  await page.evaluate(() => {
    const d = new DataTransfer()
    d.setData(
      'text/html',
      '<p style="color:red;font-weight:700">Styled <span style="font-style:italic">text</span></p><img src="data:image/png;base64,AAAA" onerror="alert(1)">',
    )
    d.setData('text/plain', 'Styled text')
    document
      .getSelection()
      ?.focusNode?.parentElement?.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: d, bubbles: true, cancelable: true }),
      )
  })
  await expect(page.locator('.writer')).toContainText('Styled text')
  await page.evaluate(() => document.fonts.ready)

  expect(seen.violations).toEqual([])
  expect(seen.cspConsole).toEqual([])
  expect(seen.errors).toEqual([])
})
