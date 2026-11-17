import { expect, type Page, test } from '@playwright/test'
import './hooks'
import { armYarn, yarnPicker } from './yarnTool'

const VIEW = { width: 1280, height: 720 }
test.use({ viewport: VIEW })

async function open(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await page.goto('/bench?board=demo')
  await page.waitForFunction(() => window.__papertie?.ready === true)
  await page.waitForFunction(() => window.__papertie.runtime.loop.running === false)
  return errors
}

const sidebar = (page: Page) => page.getByRole('toolbar', { name: 'Tools' })
const canvas = (page: Page) => page.getByTestId('canvas')

test('the floating sidebar sits on the left in the UI layer, in its fixed order', async ({
  page,
}) => {
  const errors = await open(page)
  const bar = sidebar(page)
  await expect(bar).toBeVisible()
  expect(await bar.evaluate((el) => el.parentElement?.classList.contains('ui'))).toBe(true)
  const box = await bar.boundingBox()
  if (box === null) throw new Error('no sidebar box')
  expect(box.x).toBeGreaterThan(4)
  expect(box.x).toBeLessThan(40)
  expect(box.width).toBeLessThan(100)
  // The strip ends just under its last tool (Settings), however tall the window.
  const end = async () => {
    const s = await bar.getByRole('button', { name: 'Settings' }).boundingBox()
    const b = await bar.boundingBox()
    if (s === null || b === null) throw new Error('no box')
    return b.y + b.height - (s.y + s.height)
  }
  expect(await end()).toBeLessThan(24)
  await page.setViewportSize({ width: VIEW.width, height: 1100 })
  expect(await end()).toBeLessThan(24)
  expect((await bar.boundingBox())?.height).toBeLessThan(1100 * 0.6)
  await page.setViewportSize(VIEW)
  const style = await bar.evaluate((el) => {
    const sheet = getComputedStyle(el.querySelector('.sidebar-sheet') as Element)
    const shade = getComputedStyle(el.querySelector('.sidebar-shade') as Element)
    return { radius: Number.parseFloat(sheet.borderTopLeftRadius), shadow: shade.boxShadow }
  })
  expect(style.radius).toBeGreaterThanOrEqual(12)
  expect(style.shadow).not.toBe('none')

  // One control per action: no pan, marquee, text tool or palette (the cork, Shift and "+").
  const names = await bar
    .getByRole('button')
    .evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')))
  expect(names).toEqual([
    'Papertie — hide tools',
    'New note',
    'Select',
    'Yarn',
    'Photo',
    'Search',
    'Books',
    'Settings',
  ])
  // Fine-line icons: inline SVG, stroked about 1.5 px with round caps.
  const icon = await bar
    .getByRole('button', { name: 'Yarn' })
    .locator('svg')
    .evaluate((el) => {
      const s = getComputedStyle(el)
      return { width: Number.parseFloat(s.strokeWidth), cap: s.strokeLinecap }
    })
  expect(icon.width).toBeGreaterThanOrEqual(1.25)
  expect(icon.width).toBeLessThanOrEqual(2)
  expect(icon.cap).toBe('round')
  expect(errors).toEqual([])
})

test('Select and Yarn set the tool and show the active pill; V and Y follow, H, N, M do not', async ({
  page,
}) => {
  const errors = await open(page)
  const bar = sidebar(page)
  const btn = (name: string) => bar.getByRole('button', { name, exact: true })
  await expect(btn('Select')).toHaveAttribute('aria-pressed', 'true')
  const pill = async (name: string) =>
    btn(name).evaluate((el) => getComputedStyle(el).backgroundColor)
  const idleBg = await pill('Yarn')
  expect(await pill('Select')).not.toBe(idleBg)

  for (const [name, tool] of [
    ['Yarn', 'yarn'],
    ['Select', 'select'],
  ] as const) {
    await btn(name).click()
    // Yarn takes its colour first, in its picker.
    if (tool === 'yarn') await yarnPicker(page).getByRole('radio', { name: 'Indigo' }).click()
    await expect(canvas(page)).toHaveAttribute('data-tool', tool)
    await expect(btn(name)).toHaveAttribute('aria-pressed', 'true')
  }
  const count = () => page.evaluate(() => window.__papertie.store.getState().notes.size)
  const n0 = await count()
  for (const [key, name] of [
    ['y', 'Yarn'],
    ['h', 'Yarn'],
    ['n', 'Yarn'],
    ['m', 'Yarn'],
    ['v', 'Select'],
  ] as const) {
    // Y opens Yarn's colour picker on the last colour; Enter chooses it.
    if (key === 'y') await armYarn(page)
    else await page.keyboard.press(key)
    await expect(btn(name)).toHaveAttribute('aria-pressed', 'true')
    await expect(bar.locator('[aria-pressed="true"]')).toHaveCount(1)
  }
  // N made no note.
  expect(await count()).toBe(n0)
  expect(errors).toEqual([])
})

test('+ opens the paper picker; Pin makes a note of that design by the centre, on free cork, ready to write', async ({
  page,
}) => {
  const errors = await open(page)
  const bar = sidebar(page)
  for (const name of ['New note', 'Photo', 'Search', 'Settings']) {
    await expect(bar.getByRole('button', { name })).not.toHaveAttribute('aria-disabled', /.*/)
  }
  await bar.getByRole('button', { name: 'Search' }).click()
  await expect(page.getByRole('dialog', { name: 'Search notes' })).toBeVisible()
  await page.keyboard.press('Escape')

  const before = await page.evaluate(() => [...window.__papertie.store.getState().notes.keys()])
  const plus = bar.getByRole('button', { name: 'New note' })
  // The disc stays crimson under the pointer and while its picker is open.
  const disc = () =>
    plus.evaluate((el) => {
      // Through a canvas, whatever space the computed colour is in (srgb, oklab).
      const g2 = document.createElement('canvas').getContext('2d') as CanvasRenderingContext2D
      g2.fillStyle = getComputedStyle(el).backgroundColor
      g2.fillRect(0, 0, 1, 1)
      const [r = 0, g = 0, b = 0] = g2.getImageData(0, 0, 1, 1).data
      return { r, g, b }
    })
  await plus.hover()
  const hovered = await disc()
  expect(hovered.r).toBeGreaterThan(hovered.g + 60)
  await plus.click()
  const picker = page.getByRole('dialog', { name: 'New note' })
  await expect(picker).toBeVisible()
  await expect(plus).toHaveAttribute('aria-expanded', 'true')
  await page.mouse.move(700, 700)
  const pressed = await disc()
  expect(pressed.r).toBeGreaterThan(pressed.g + 60)
  // Beside the panel, never over it.
  const pb = await picker.boundingBox()
  const sb = await bar.boundingBox()
  if (pb === null || sb === null) throw new Error('no box')
  expect(pb.x).toBeGreaterThan(sb.x + sb.width)
  // The sheet colours unfold only for a layered sheet.
  const sheet = picker.getByRole('group', { name: 'Sheet' })
  await expect(sheet).toBeHidden()
  await picker.getByRole('radio', { name: 'Indigo' }).first().check()
  await picker.getByRole('radio', { name: 'Smooth' }).check()
  await picker.getByRole('radio', { name: 'Layered sheet' }).check()
  await expect(sheet).toBeVisible()
  await sheet.getByRole('radio', { name: 'Ochre' }).check()
  const expected = await expectedSpot(page)
  await page.keyboard.press('Enter')
  await expect(picker).toHaveCount(0)

  await expect(page.locator('.note-edit')).toBeVisible()
  const made = await page.evaluate((was) => {
    const notes = window.__papertie.store.getState().notes as unknown as Map<
      string,
      Record<string, unknown>
    >
    return [...notes.entries()].filter(([id]) => !was.includes(id)).map(([, n]) => n)
  }, before)
  expect(made).toHaveLength(1)
  expect(made[0]).toMatchObject({ paper: 'indigo', style: 'smooth', layered: 'ochre' })
  // By the middle of the view, on free cork: the nearest free spot to it, as asked before.
  await onFreeCork(page, String(made[0]?.id))
  expect(made[0]).toMatchObject({
    x: Math.round(expected.spot.x - 120),
    y: Math.round(expected.spot.y - 80),
  })

  // Opened again, it remembers the design.
  await page.keyboard.type('kept')
  await page.mouse.click(700, 700)
  await plus.click()
  await expect(picker.getByRole('radio', { name: 'Smooth' })).toBeChecked()
  await expect(picker.getByRole('radio', { name: 'Layered sheet' })).toBeChecked()
  await page.keyboard.press('Escape')
  await expect(picker).toHaveCount(0)
  await expect(plus).toBeFocused()
  expect(errors).toEqual([])
})

test('a selected note offers Duplicate, Focus and Delete in the sidebar, and no design controls', async ({
  page,
}) => {
  const errors = await open(page)
  const bar = sidebar(page)
  const section = bar.getByRole('group', { name: 'Selection' })
  await expect(section).toBeHidden()
  const tools = await bar.getByRole('button', { name: 'Search' }).boundingBox()

  const note = page.locator('article[data-note-id]').first()
  const id = await note.getAttribute('data-note-id')
  await note.click({ position: { x: 30, y: 60 } })
  await expect(section).toBeVisible()
  // The tools above never move for it.
  expect(await bar.getByRole('button', { name: 'Search' }).boundingBox()).toEqual(tools)
  // No bar over the note, and nowhere a paper, style or decoration control for it.
  await expect(page.getByTestId('context-bar')).toHaveCount(0)
  await expect(page.getByRole('radio')).toHaveCount(0)
  await expect(
    page.getByRole('button', { name: /\bPaper\b|Decoration|Connect|Palette/ }),
  ).toHaveCount(0)
  const mod = process.platform === 'darwin' ? '⌘D' : 'Ctrl+D'
  await expect(section.getByRole('button', { name: 'Duplicate' })).toHaveAttribute(
    'title',
    `Duplicate (${mod})`,
  )
  await expect(section.getByRole('button', { name: 'Focus' })).toHaveAttribute('title', 'Focus (F)')
  await expect(section.getByRole('button', { name: 'Delete' })).toHaveAttribute(
    'title',
    'Delete (⌫)',
  )

  const count = () => page.evaluate(() => window.__papertie.store.getState().notes.size)
  const n0 = await count()
  await section.getByRole('button', { name: 'Duplicate' }).click()
  await expect.poll(count).toBe(n0 + 1)
  const copy = await page.evaluate(() => [...window.__papertie.runtime.selection][0])
  expect(copy).not.toBe(id)
  const design = (nid: string | null | undefined) =>
    page.evaluate((k) => {
      const n = window.__papertie.store.getState().notes.get(k as string) as unknown as Record<
        string,
        unknown
      >
      return [n.paper, n.style, n.motif, n.stamp, n.layered]
    }, nid)
  // The copy wears the design of its note.
  expect(await design(copy)).toEqual(await design(id))

  await section.getByRole('button', { name: 'Focus' }).click()
  await expect
    .poll(() => page.evaluate(() => window.__papertie.runtime.focusState !== null))
    .toBe(true)
  await page.keyboard.press('Escape')

  await page.evaluate((k) => window.__papertie.runtime.selectNotes([k as string]), copy)
  await section.getByRole('button', { name: 'Delete' }).click()
  await expect.poll(count).toBe(n0)
  await expect(section).toBeHidden()
  // The focus went to the board, not <body>.
  expect(await page.evaluate(() => document.activeElement?.className)).toContain('viewport')
  expect(errors).toEqual([])
})

test('the mark folds the panel to itself and unrolls it; a reload keeps it folded', async ({
  page,
}) => {
  const errors = await open(page)
  const bar = sidebar(page)
  const full = await bar.boundingBox()
  const mark = bar.getByRole('button', { name: 'Papertie — hide tools' })
  await expect(mark).toHaveAttribute('aria-expanded', 'true')
  await mark.click()
  const folded = bar.getByRole('button', { name: 'Papertie — show tools' })
  await expect(folded).toHaveAttribute('aria-expanded', 'false')
  await expect(bar.getByRole('button', { name: 'Settings' })).toBeHidden()
  await page.waitForTimeout(500)
  // What shows is the tile: the paper clipped to it, its own shadow; the panel's frame is where
  // it was, and lets presses below the tile through to the board.
  const tile = await bar.locator('.sidebar-shade--tile').boundingBox()
  if (full === null || tile === null) throw new Error('no box')
  expect(tile.height).toBeLessThan(110)
  expect(tile.width).toBe(full.width)
  expect(tile.y).toBe(full.y)
  expect(await bar.boundingBox()).toEqual(full)
  // The whole tile takes presses (only the mark acts): beside the mark is the sidebar's.
  const onTile = { x: tile.x + 8, y: tile.y + tile.height / 2 }
  expect(
    await page.evaluate(
      (p) => document.elementFromPoint(p.x, p.y)?.closest('.sidebar') != null,
      onTile,
    ),
  ).toBe(true)
  const t0 = await page.evaluate(() => window.__papertie.debug.camera())
  await page.mouse.move(onTile.x, onTile.y)
  await page.mouse.down()
  await page.mouse.move(onTile.x + 40, onTile.y + 30, { steps: 4 })
  await page.mouse.up()
  expect(await page.evaluate(() => window.__papertie.debug.camera())).toEqual(t0)
  await expect(bar.getByRole('button', { name: 'Papertie — show tools' })).toBeVisible()
  const below = { x: full.x + full.width / 2, y: full.y + 300 }
  expect(
    await page.evaluate((p) => document.elementFromPoint(p.x, p.y)?.closest('.sidebar'), below),
  ).toBeNull()
  const c0 = await page.evaluate(() => window.__papertie.debug.camera())
  await page.mouse.move(below.x, below.y)
  await page.mouse.down()
  await page.mouse.move(below.x + 40, below.y, { steps: 4 })
  await page.mouse.up()
  expect((await page.evaluate(() => window.__papertie.debug.camera())).x).not.toBe(c0.x)

  // The board stays in use by its keys. Folded, Y opens Yarn's colour picker beside the mark,
  // and the panel stays folded.
  await page.keyboard.press('y')
  const picker = yarnPicker(page)
  await expect(picker).toBeVisible()
  const at = await folded.boundingBox()
  const sheet = await picker.boundingBox()
  if (at === null || sheet === null) throw new Error('no box')
  expect(sheet.x).toBeGreaterThanOrEqual(at.x + at.width)
  expect(sheet.y).toBeLessThanOrEqual(at.y + at.height)
  // Esc: nothing chosen, the focus back on the mark.
  await page.keyboard.press('Escape')
  await expect(picker).toHaveCount(0)
  await expect(folded).toBeFocused()
  await expect(canvas(page)).toHaveAttribute('data-tool', 'select')
  await armYarn(page)
  await expect(canvas(page)).toHaveAttribute('data-tool', 'yarn')
  await expect(folded).toBeVisible()
  await expect(bar.getByRole('button', { name: 'New note' })).toBeHidden()
  await page.keyboard.press('v')

  await page.reload()
  await page.waitForFunction(() => window.__papertie?.ready === true)
  await expect(bar.getByRole('button', { name: 'Papertie — show tools' })).toBeVisible()
  await expect(bar.getByRole('button', { name: 'New note' })).toBeHidden()
  await bar.getByRole('button', { name: 'Papertie — show tools' }).click()
  await expect(bar.getByRole('button', { name: 'Settings' })).toBeVisible()
  await page.waitForTimeout(500)
  expect((await bar.getByRole('button', { name: 'Settings' }).boundingBox())?.y).toBeLessThan(
    full.y + full.height,
  )
  expect(errors).toEqual([])
})

test('folded, an offline save dot rests on the tile under the mark, and takes its press', async ({
  page,
}) => {
  const errors = await open(page)
  const bar = sidebar(page)
  // What a server board's save dot is while offline (bench boards have none).
  await bar.evaluate((el) => {
    const foot = document.createElement('div')
    foot.className = 'sidebar-foot'
    foot.innerHTML =
      '<button type="button" class="save-dot" data-testid="save-dot" data-status="offline"' +
      ' data-shown="true" aria-label="Offline — kept on this device">' +
      '<span class="save-dot-ink"></span></button>'
    const tail = el.querySelector('.sidebar-tail')
    tail?.parentElement?.insertBefore(foot, tail)
  })
  await bar.getByRole('button', { name: 'Papertie — hide tools' }).click()
  await page.waitForTimeout(500)
  const tile = await bar.locator('.sidebar-shade--tile').boundingBox()
  const dot = bar.getByTestId('save-dot')
  await expect(dot).toBeVisible()
  const d = await dot.boundingBox()
  const mark = await bar.getByRole('button', { name: 'Papertie — show tools' }).boundingBox()
  if (tile === null || d === null || mark === null) throw new Error('no box')
  expect(d.y).toBeGreaterThan(mark.y + mark.height - 8)
  expect(d.y + d.height).toBeLessThanOrEqual(tile.y + tile.height)
  const centre = { x: d.x + d.width / 2, y: d.y + d.height / 2 }
  expect(
    await page.evaluate(
      (p) => document.elementFromPoint(p.x, p.y)?.closest('.save-dot') !== null,
      centre,
    ),
  ).toBe(true)
  // Saved again, the tile is the mark alone.
  await dot.evaluate((el) => el.setAttribute('data-status', 'saved'))
  await expect(dot).toBeHidden()
  await page.waitForTimeout(500)
  expect((await bar.locator('.sidebar-shade--tile').boundingBox())?.height).toBeLessThan(
    tile.height,
  )
  expect(errors).toEqual([])
})

test('presses on the sidebar never reach the canvas; the A/B strip is top-right, toolless', async ({
  page,
}) => {
  const errors = await open(page)
  const box = await sidebar(page).boundingBox()
  if (box === null) throw new Error('no sidebar box')
  const c0 = await page.evaluate(() => window.__papertie.debug.camera())
  // A drag on the panel's bare edge (beside the buttons) neither pans nor selects.
  const x = box.x + 6
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down({ button: 'middle' })
  await page.mouse.move(x + 200, y + 40, { steps: 5 })
  await page.mouse.up({ button: 'middle' })
  await page.mouse.click(x, y)
  // A wheel over the panel neither pans nor zooms the board (plain and ctrl+wheel).
  await page.mouse.wheel(0, 240)
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -120)
  await page.keyboard.up('Control')
  await page.waitForFunction(() => window.__papertie.runtime.loop.running === false)
  expect(await page.evaluate(() => window.__papertie.debug.camera())).toEqual(c0)
  expect(await page.evaluate(() => window.__papertie.runtime.selection.size)).toBe(0)

  const strip = page.getByRole('toolbar', { name: 'Canvas controls' })
  await expect(strip.locator('[data-tool]')).toHaveCount(0)
  for (const label of ['Yarn layer', 'Paper rotation', 'Motion', 'Wheel']) {
    await expect(strip.getByLabel(label)).toBeVisible()
  }
  await expect(strip.locator('[data-board="demo"]')).toBeVisible()
  await expect(strip.locator('[data-pref="hud"]')).toBeVisible()
  const s = await strip.boundingBox()
  if (s === null) throw new Error('no strip box')
  expect(VIEW.width - (s.x + s.width)).toBeLessThan(24)
  expect(s.y).toBeLessThan(24)
  expect(s.x).toBeGreaterThan(box.x + box.width)
  expect(errors).toEqual([])
})

test('below 768 px the sidebar is the mini-bar: a bottom-left pill of 44 px targets', async ({
  page,
}) => {
  await page.setViewportSize({ width: 600, height: 800 })
  const errors = await open(page)
  const bar = sidebar(page)
  await expect(bar).toHaveClass('minibar')
  const box = await bar.boundingBox()
  if (box === null) throw new Error('no mini-bar box')
  expect(box.x).toBeLessThan(24)
  expect(800 - (box.y + box.height)).toBeLessThan(24)
  const names = await bar
    .getByRole('button')
    .evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')))
  expect(names).toEqual(['New note', 'Select', 'Yarn', 'Photo', 'Search', 'Books', 'Settings'])
  for (const b of await bar.getByRole('button').all()) {
    const r = await b.boundingBox()
    if (r === null) throw new Error('a mini-bar button has no box')
    expect(r.width).toBeGreaterThanOrEqual(44)
    expect(r.height).toBeGreaterThanOrEqual(44)
  }
  await expect(bar.getByRole('button', { name: 'Settings' })).toBeInViewport({ ratio: 1 })

  // A selection's row unfolds above the tools, which stay where they are.
  const tools = await bar.getByRole('button', { name: 'Yarn' }).boundingBox()
  const id = await page.evaluate(() => [...window.__papertie.store.getState().notes.keys()][0])
  await page.evaluate((k) => window.__papertie.runtime.selectNotes([k as string]), id)
  const row = bar.getByRole('group', { name: 'Selection' })
  // Duplicate, Focus and Delete.
  await expect(row.getByRole('button')).toHaveCount(3)
  await expect(row.getByRole('button', { name: 'Focus' })).toBeInViewport({ ratio: 1 })
  await expect(row.getByRole('button', { name: 'Delete' })).toBeInViewport({ ratio: 1 })
  await page.waitForTimeout(400)
  expect(await bar.getByRole('button', { name: 'Yarn' }).boundingBox()).toEqual(tools)
  const r = await row.getByRole('button', { name: 'Duplicate' }).boundingBox()
  if (r === null || tools === null) throw new Error('no box')
  expect(r.y + r.height).toBeLessThanOrEqual(tools.y)
  expect(r.width).toBeGreaterThanOrEqual(44)
  expect(errors).toEqual([])
})

test('on a short viewport every sidebar button, Settings included, stays on screen', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 480 })
  const errors = await open(page)
  const bar = sidebar(page)
  const box = await bar.boundingBox()
  if (box === null) throw new Error('no sidebar box')
  expect(box.y + box.height).toBeLessThanOrEqual(480)
  for (const b of await bar.getByRole('button').all()) {
    const r = await b.boundingBox()
    if (r === null) throw new Error('a sidebar button has no box')
    // Wholly inside the panel and the viewport: nothing is clipped by the panel's rounded box.
    expect(r.y).toBeGreaterThanOrEqual(box.y)
    expect(r.y + r.height).toBeLessThanOrEqual(box.y + box.height)
  }
  await expect(bar.getByRole('button', { name: 'Settings' })).toBeInViewport({ ratio: 1 })
  expect(errors).toEqual([])
})

/** What a server board adds at the panel's foot: the save dot's 28 px room (bench boards have none). */
async function addFoot(page: Page) {
  await sidebar(page).evaluate((bar) => {
    const foot = document.createElement('div')
    foot.className = 'sidebar-foot'
    foot.innerHTML = '<span style="display:block;width:28px;height:28px"></span>'
    const tail = bar.querySelector('.sidebar-tail')
    tail?.parentElement?.insertBefore(foot, tail)
  })
}

for (const [width, height] of [
  [1366, 768],
  [1366, 650],
  [1280, 621],
  [1024, 480],
] as const) {
  test(`with the save dot at its foot, Settings stays inside the panel at ${width}x${height}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height })
    const errors = await open(page)
    await addFoot(page)
    const bar = sidebar(page)
    const box = await bar.boundingBox()
    const settings = await bar.getByRole('button', { name: 'Settings' }).boundingBox()
    if (box === null || settings === null) throw new Error('no box')
    expect(settings.y + settings.height).toBeLessThanOrEqual(box.y + box.height)
    expect(await bar.evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true)
    expect(errors).toEqual([])
  })
}

test('⌘K opens search on the board with nothing selected (the selection group folded inert)', async ({
  page,
}) => {
  const errors = await open(page)
  await expect(page.locator('[inert]').first()).toBeAttached()
  await page.keyboard.press('ControlOrMeta+k')
  const search = page.getByRole('dialog', { name: 'Search notes' })
  await expect(search).toBeVisible()
  await expect(search.getByRole('combobox')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(search).toHaveCount(0)
  await expect(page.getByRole('main', { name: 'Board' })).toBeFocused()
  expect(errors).toEqual([])
})

test('⌘K replaces an open "+" or yarn sheet; Esc then gives the board the focus', async ({
  page,
}) => {
  const errors = await open(page)
  const tools = sidebar(page)
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

/**
 * The note's paper on screen meets no other paper and lies in the view, right of the sidebar
 * (a new note goes to the nearest free spot by the middle of the view).
 */
async function onFreeCork(page: Page, id: string): Promise<void> {
  const out = await page.evaluate((id) => {
    const box = (el: Element | null) => {
      const r = el?.getBoundingClientRect()
      return r && { l: r.left, r: r.right, t: r.top, b: r.bottom }
    }
    const mine = box(document.querySelector(`article[data-note-id="${id}"] .note-paper`))
    const others = [...document.querySelectorAll<HTMLElement>('article.note')]
      .filter((el) => el.dataset.noteId !== id)
      .map((el) => box(el.querySelector('.note-paper')))
    const tools = box(document.querySelector('[role="toolbar"][aria-label="Tools"]'))
    return { mine, others, tools, w: innerWidth, h: innerHeight }
  }, id)
  const m = out.mine
  if (!m) throw new Error('the new note is not drawn')
  const meets = out.others.filter((o) => o && o.l < m.r && m.l < o.r && o.t < m.b && m.t < o.b)
  expect(meets).toEqual([])
  expect(m.l).toBeGreaterThanOrEqual(out.tools?.r ?? 0)
  expect(m.r).toBeLessThanOrEqual(out.w)
  expect(m.t).toBeGreaterThanOrEqual(0)
  expect(m.b).toBeLessThanOrEqual(out.h)
}

/**
 * Where "+" will put a note of `w` × `h`, asked before it is made: the nearest free spot to the
 * middle of the view's free part (`CanvasRuntime.placeNear`), as a world centre, and that middle.
 */
const expectedSpot = (page: Page, w = 240, h = 160) =>
  page.evaluate(
    ([w, h]) => {
      const rt = window.__papertie.runtime as unknown as {
        placeNear(size: { w: number; h: number }): { x: number; y: number }
        safeViewport(): { x: number; y: number; w: number; h: number }
      }
      const v = rt.safeViewport()
      const middle = window.__papertie.debug.screenToWorld({ x: v.x + v.w / 2, y: v.y + v.h / 2 })
      return { spot: rt.placeNear({ w: w as number, h: h as number }), middle }
    },
    [w, h],
  )
