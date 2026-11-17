import { expect, type Page, test } from '@playwright/test'
import { DEMO_IDS, DEMO_MOCKUP } from '../apps/web/src/dev/demoBoard'

async function open(page: Page, board: string) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await page.goto(`/bench?board=${board}`)
  await page.waitForFunction(() => window.__papertie?.ready === true)
  await settle(page)
  return errors
}

/** The loop idle, two more frames, every image decoded and the fonts in. */
async function settle(page: Page) {
  await page.waitForFunction(() => window.__papertie.runtime.loop.running === false)
  await page.evaluate(async () => {
    await document.fonts.ready
    await Promise.all([...document.images].map((i) => i.decode().catch(() => undefined)))
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  })
}

/** A screenshot of `clip` once two in a row match. */
async function stableShot(
  page: Page,
  clip: { x: number; y: number; width: number; height: number },
) {
  let last = await page.screenshot({ clip })
  let same = 1
  for (let k = 0; k < 30 && same < 2; k++) {
    await page.waitForTimeout(80)
    const next = await page.screenshot({ clip })
    same = next.equals(last) ? same + 1 : 1
    last = next
  }
  return last
}

/** Pixels whose colour differs by more than a hair between two same-sized PNGs. */
function changedPixels(page: Page, a: Buffer, b: Buffer): Promise<number> {
  return page.evaluate(
    async ([a, b]) => {
      const pixels = async (s: string) => {
        const blob = await (await fetch(`data:image/png;base64,${s}`)).blob()
        const img = await createImageBitmap(blob)
        const c = new OffscreenCanvas(img.width, img.height)
        const g = c.getContext('2d') as OffscreenCanvasRenderingContext2D
        g.drawImage(img, 0, 0)
        return g.getImageData(0, 0, img.width, img.height).data
      }
      const [pa, pb] = await Promise.all([pixels(a), pixels(b)])
      let changed = 0
      for (let i = 0; i < pa.length; i += 4) {
        let d = 0
        for (let c = 0; c < 3; c++) d += Math.abs((pa[i + c] ?? 0) - (pb[i + c] ?? 0))
        if (d > 24) changed++
      }
      return changed
    },
    [a.toString('base64'), b.toString('base64')] as [string, string],
  )
}

const paperBox = (page: Page, id: string) =>
  page.evaluate((id) => {
    const el = document.querySelector(`article[data-note-id="${id}"] .note-paper`)
    const r = (el as HTMLElement).getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height }
  }, id)

const focusNote = async (page: Page, id: string) => {
  await page.evaluate((id) => window.__papertie.debug.focusCamera(id, 1), id)
  await settle(page)
}

const textOf = (page: Page, id: string) =>
  page.evaluate((id) => window.__papertie.store.getState().notes.get(id)?.text ?? '', id)

/** The rect of a rendered or edited title line's glyphs (its first character's line box). */
const titleRect = (page: Page, id: string) =>
  page.evaluate((id) => {
    const t = document.querySelector(`article[data-note-id="${id}"] .note-title`)?.firstChild
    if (!(t instanceof Text)) return null
    const r = document.createRange()
    r.setStart(t, 0)
    r.setEnd(t, 1)
    const b = r.getBoundingClientRect()
    return { left: b.left, top: b.top, bottom: b.bottom }
  }, id)

const field = (page: Page) => page.locator('.note-edit')

/** A new note from the sidebar's "+", pinned with Enter at the middle of the view. */
async function pinNote(page: Page) {
  await page.getByRole('button', { name: 'New note' }).click()
  await page.getByRole('dialog', { name: 'New note' }).press('Enter')
}

/** The text the field holds. */
const fieldText = (page: Page) =>
  field(page).evaluate((ed) =>
    [...ed.childNodes]
      .map((n) => ((n as HTMLElement).dataset?.mark ?? '') + (n.textContent ?? ''))
      .join('\n'),
  )

test('writing keeps the note as it was: paper, title baseline and glyphs', async ({ page }) => {
  // Dozens of stable screenshots, turned and straight: slow by design, not by a hang.
  test.slow()
  const errors = await open(page, 'demo')
  // The caret blinks, and the selection frame is not the note: neither is compared. Nor is
  // "Add reference", the control writing shows in the paper's bottom padding (its place and
  // its taking no height are checked here; it is a control, not the note's glyphs).
  const quiet = await page.addStyleTag({
    content:
      '.note-edit { caret-color: transparent } .overlay { visibility: hidden } .note-ref-add { visibility: hidden }',
  })
  const rows: string[] = []
  // Turned (the default), then straight. Pixels are compared straight only: Chrome anti-aliases
  // an editable field in a turned note a shade differently, its glyphs where they were.
  for (const turned of [true, false]) {
    if (!turned) {
      await page.getByRole('checkbox', { name: 'Paper rotation' }).uncheck()
      // The keys back to the board.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    }
    // A title, subtitle and bullets; a title, gap and body; a heading; a print's caption.
    for (const id of [DEMO_MOCKUP.spring, DEMO_IDS.hub, DEMO_MOCKUP.centre, DEMO_IDS.print]) {
      await focusNote(page, id)
      await page.evaluate((id) => window.__papertie.runtime.selectNote(id), id)
      await page.mouse.move(5, 5)
      await settle(page)
      const before = await paperBox(page, id)
      const title = await titleRect(page, id)
      const clip = {
        x: before.x - 24,
        y: before.y - 24,
        width: before.w + 48,
        height: before.h + 48,
      }
      const shown = await stableShot(page, clip)
      await page.keyboard.press('Enter')
      await expect(field(page)).toBeFocused()
      await settle(page)
      // "Add reference" is there while writing, inside the paper, a Tab from the text.
      const add = page.locator(`article[data-note-id="${id}"] .note-ref-add`)
      await expect(add).toHaveCount(1)
      const a = await add.boundingBox()
      if (a === null) throw new Error(`no Add reference box on ${id}`)
      if (!turned) {
        expect(a.y, `${id} Add reference inside the paper`).toBeGreaterThanOrEqual(before.y)
        expect(a.y + a.height, `${id} Add reference inside the paper`).toBeLessThanOrEqual(
          before.y + before.h + 1,
        )
      }
      const after = await paperBox(page, id)
      for (const k of ['x', 'y', 'w', 'h'] as const) {
        expect(Math.abs(after[k] - before[k]), `${id} paper ${k}`).toBeLessThanOrEqual(1)
      }
      const edited = await titleRect(page, id)
      if (title !== null) {
        if (edited === null) throw new Error(`no title line in the editor of ${id}`)
        const dy = Math.abs(edited.bottom - title.bottom)
        rows.push(
          `${turned ? 'turned' : 'straight'} ${id}: title baseline moved ${dy.toFixed(2)} px`,
        )
        expect(dy, `${id} title baseline`).toBeLessThanOrEqual(1)
        expect(Math.abs(edited.left - title.left), `${id} title left`).toBeLessThanOrEqual(1)
      }
      if (!turned) {
        const changed = await changedPixels(page, shown, await stableShot(page, clip))
        rows.push(`straight ${id}: ${changed} px changed entering edit`)
        expect(changed, `${id} glyphs`).toBe(0)
      }
      await page.keyboard.press('Escape')
      await expect(field(page)).toHaveCount(0)
      await settle(page)
      // Back to the rendered text, pixel for pixel.
      expect(await changedPixels(page, shown, await stableShot(page, clip))).toBe(0)
    }
  }
  // A note with a ref keeps its height and its ref's lines too: one ref wrapping over lines, one
  // with line breaks (straight, as the rotation is off by now).
  const refs: Record<string, string> = {
    [DEMO_MOCKUP.centre]:
      'Henry David Thoreau, Walden; or, Life in the Woods, Ticknor and Fields, Boston, 1854, p. 92',
    [DEMO_IDS.hub]: 'Walden,\nTicknor and Fields, 1854,\np. 92',
  }
  await page.evaluate((refs) => {
    const store = window.__papertie.store as unknown as { commit(ops: unknown[]): void }
    store.commit(Object.entries(refs).map(([id, ref]) => ({ op: 'note.update', id, set: { ref } })))
  }, refs)
  const refLines = (page: Page, id: string) =>
    page.evaluate((id) => {
      const el = document.querySelector(
        `article[data-note-id="${id}"] :is(.note-ref, .note-ref-input)`,
      ) as HTMLElement
      const s = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      return {
        top: r.top + Number.parseFloat(s.paddingTop),
        left: r.left + Number.parseFloat(s.paddingLeft),
        h: r.height - Number.parseFloat(s.paddingTop) - Number.parseFloat(s.paddingBottom),
      }
    }, id)
  for (const id of Object.keys(refs)) {
    await focusNote(page, id)
    await page.evaluate((id) => window.__papertie.runtime.selectNote(id), id)
    await page.mouse.move(5, 5)
    await settle(page)
    const before = await paperBox(page, id)
    const shownRef = await refLines(page, id)
    await page.keyboard.press('Enter')
    await expect(field(page)).toBeFocused()
    await expect(page.getByRole('textbox', { name: 'Reference' })).toBeVisible()
    await settle(page)
    const after = await paperBox(page, id)
    for (const k of ['x', 'y', 'w', 'h'] as const) {
      expect(Math.abs(after[k] - before[k]), `${id} with a ref: paper ${k}`).toBeLessThanOrEqual(1)
    }
    const editedRef = await refLines(page, id)
    for (const k of ['top', 'left', 'h'] as const) {
      expect(Math.abs(editedRef[k] - shownRef[k]), `${id} ref ${k}`).toBeLessThanOrEqual(1)
    }
    rows.push(`ref ${id}: paper h ${before.h.toFixed(2)} → ${after.h.toFixed(2)}`)
    await page.keyboard.press('Escape')
    await expect(field(page)).toHaveCount(0)
    await settle(page)
  }
  // "Add reference" by the keyboard: a Tab from the text, still writing; Enter opens the field.
  await quiet.evaluate((e) => e.parentNode?.removeChild(e))
  await focusNote(page, DEMO_MOCKUP.spring)
  await page.evaluate((id) => window.__papertie.runtime.selectNote(id), DEMO_MOCKUP.spring)
  await page.keyboard.press('Enter')
  await expect(field(page)).toBeFocused()
  await page.keyboard.press('Tab')
  const add = page.getByRole('button', { name: 'Add reference' })
  await expect(add).toBeFocused()
  await expect(field(page)).toHaveCount(1)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('textbox', { name: 'Reference' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(field(page)).toHaveCount(0)
  test.info().annotations.push({ type: 'edit vs display', description: rows.join('\n') })
  console.log(rows.join('\n'))
  expect(errors).toEqual([])
})

test("the caret in a title line is the title's height, on its glyphs", async ({ page }) => {
  const errors = await open(page, 'demo')
  const id = DEMO_MOCKUP.spring
  await focusNote(page, id)
  const probe = await page.evaluate((id) => {
    const t = document.querySelector(`article[data-note-id="${id}"] .note-title`)
      ?.firstChild as Text
    const r = document.createRange()
    r.setStart(t, 1)
    r.setEnd(t, 2)
    const b = r.getBoundingClientRect()
    return {
      x: b.left + b.width * 0.2,
      y: b.top + b.height / 2,
      top: b.top,
      bottom: b.bottom,
      left: b.left,
    }
  }, id)
  await page.mouse.dblclick(probe.x, probe.y)
  await expect(field(page)).toBeFocused()
  const caret = await page.evaluate(() => {
    const r = (document.getSelection() as Selection).getRangeAt(0)
    const b = r.getClientRects()[0] ?? r.getBoundingClientRect()
    return { left: b.left, top: b.top, bottom: b.bottom, height: b.height }
  })
  test.info().annotations.push({ type: 'caret', description: JSON.stringify({ probe, caret }) })
  // The glyph box of the 30 px display serif line (Newsreader's ascent and descent make one em),
  // not the 16 px body's.
  expect(caret.height).toBeGreaterThan(29)
  expect(Math.abs(caret.left - probe.left)).toBeLessThanOrEqual(1)
  expect(caret.top).toBeLessThanOrEqual(probe.top + 1)
  expect(caret.bottom).toBeGreaterThanOrEqual(probe.bottom - 1)
  expect(errors).toEqual([])
})

test('a double-click puts the caret on the clicked character', async ({ page }) => {
  const errors = await open(page, 'demo')
  for (const [id, block, k] of [
    [DEMO_IDS.knot, '.note-title', 2],
    [DEMO_IDS.hub, '.note-body', 11],
    [DEMO_MOCKUP.spring, 'li', 1],
  ] as const) {
    await focusNote(page, id)
    const probe = await page.evaluate(
      ([id, block, k]) => {
        const el = document.querySelector(`article[data-note-id="${id}"] ${block}`) as HTMLElement
        const t = el.firstChild as Text
        const r = document.createRange()
        r.setStart(t, k)
        r.setEnd(t, k + 1)
        const rect = r.getBoundingClientRect()
        const text = window.__papertie.store.getState().notes.get(id)?.text ?? ''
        // The character's leading part: the caret goes before it.
        return {
          x: rect.left + rect.width * 0.2,
          y: rect.top + rect.height / 2,
          at: text.indexOf(t.data) + k,
          text,
        }
      },
      [id, block, k] as const,
    )
    await page.mouse.dblclick(probe.x, probe.y)
    await expect(field(page)).toBeFocused()
    await page.keyboard.type('|')
    expect(await textOf(page, id)).toBe(
      `${probe.text.slice(0, probe.at)}|${probe.text.slice(probe.at)}`,
    )
    await page.keyboard.press('Escape')
    await settle(page)
  }
  expect(errors).toEqual([])
})

test('typing, Enter and Backspace edit the lines in their own type', async ({ page }) => {
  const errors = await open(page, 'empty')
  await pinNote(page)
  await expect(field(page)).toBeFocused()
  await page.keyboard.type('Plan')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Weekend')
  await page.keyboard.press('Enter')
  await page.keyboard.type('- paper')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Shift+ArrowLeft')
  await page.keyboard.type('E')
  const id = await page.evaluate(
    () => [...window.__papertie.store.getState().notes.keys()][0] as string,
  )
  expect(await textOf(page, id)).toBe('Plan\nWeekend\n- papE')
  // Each line carries its role's class, as the rendering does.
  expect(await field(page).evaluate((ed) => [...ed.children].map((c) => c.className))).toEqual([
    'note-title',
    'note-subtitle',
    'note-edit-bullet note-edit-bullet--first',
  ])
  // The field's own undo, a step at a time: the replaced letter, then the deleted one.
  await page.keyboard.press('ControlOrMeta+z')
  expect(await textOf(page, id)).toBe('Plan\nWeekend\n- pape')
  await page.keyboard.press('ControlOrMeta+z')
  expect(await textOf(page, id)).toBe('Plan\nWeekend\n- paper')
  expect(errors).toEqual([])
})

test('an IME composition commits once it ends; Esc and Enter stay the IME’s', async ({ page }) => {
  const errors = await open(page, 'demo')
  const id = DEMO_IDS.knot
  await focusNote(page, id)
  await page.evaluate((id) => window.__papertie.runtime.startEditing(id), id)
  await expect(field(page)).toBeFocused()
  const text0 = await textOf(page, id)
  const commits = () => page.evaluate(() => window.__papertie.store.commits)
  const c0 = await commits()
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.imeSetComposition', {
    text: '´e¨ue',
    selectionStart: 5,
    selectionEnd: 5,
  })
  await cdp.send('Input.imeSetComposition', { text: 'éü', selectionStart: 2, selectionEnd: 2 })
  expect(await fieldText(page)).toBe(`${text0}éü`)
  expect(await commits()).toBe(c0)
  await cdp.send('Input.insertText', { text: 'éü' })
  await expect.poll(() => textOf(page, id)).toBe(`${text0}éü`)
  expect(await commits()).toBe(c0 + 1)
  await expect(field(page)).toBeFocused()
  // Typing goes on after it, as typed.
  await page.keyboard.type('!')
  await expect.poll(() => textOf(page, id)).toBe(`${text0}éü!`)
  expect(errors).toEqual([])
})

/** One IME word: the reading composed, then the conversion committed. */
async function composeWord(page: Page, reading: string, word: string) {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.imeSetComposition', {
    text: reading,
    selectionStart: reading.length,
    selectionEnd: reading.length,
  })
  await cdp.send('Input.insertText', { text: word })
  await cdp.detach()
}

const lineClasses = (page: Page) =>
  field(page).evaluate((ed) => [...ed.children].map((c) => c.className))

test('IME words at an empty bullet stay in the bullet', async ({ page }) => {
  const errors = await open(page, 'empty')
  await pinNote(page)
  await expect(field(page)).toBeFocused()
  await page.keyboard.type('Plan')
  await page.keyboard.press('Enter')
  await page.keyboard.type('- ')
  await composeWord(page, '´e', 'é')
  await composeWord(page, '¨ue', 'ü')
  await page.keyboard.type('x')
  const id = await page.evaluate(
    () => [...window.__papertie.store.getState().notes.keys()][0] as string,
  )
  await expect.poll(() => textOf(page, id)).toBe('Plan\n- éüx')
  expect(await lineClasses(page)).toEqual([
    'note-title',
    'note-edit-bullet note-edit-bullet--first',
  ])
  expect(errors).toEqual([])
})

test("IME words at the start of a bullet's text stay in the bullet", async ({ page }) => {
  const errors = await open(page, 'demo')
  const id = DEMO_MOCKUP.spring
  await focusNote(page, id)
  const probe = await page.evaluate((id) => {
    const t = document.querySelector(`article[data-note-id="${id}"] li`)?.firstChild as Text
    const r = document.createRange()
    r.setStart(t, 0)
    r.setEnd(t, 1)
    const b = r.getBoundingClientRect()
    return { x: b.left + b.width * 0.15, y: b.top + b.height / 2 }
  }, id)
  await page.mouse.dblclick(probe.x, probe.y)
  await expect(field(page)).toBeFocused()
  const before = await textOf(page, id)
  await composeWord(page, '´e', 'é')
  await composeWord(page, '¨ue', 'ü')
  await page.keyboard.type('x')
  await expect
    .poll(() => textOf(page, id))
    .toBe(before.replace('- Orchard in bloom', '- éüxOrchard in bloom'))
  const classes = await lineClasses(page)
  expect(classes[2]).toBe('note-edit-bullet note-edit-bullet--first')
  expect(errors).toEqual([])
})

/** A new note on the empty board with `lines` typed into it; its id. */
async function writeNote(page: Page, lines: string[]): Promise<string> {
  await pinNote(page)
  await expect(field(page)).toBeFocused()
  for (const [i, line] of lines.entries()) {
    if (i > 0) await page.keyboard.press('Enter')
    await page.keyboard.type(line)
  }
  return page.evaluate(() => [...window.__papertie.store.getState().notes.keys()][0] as string)
}

/** Select from the start of line `from`'s text to the end of line `to`'s. */
const selectLines = (page: Page, from: number, to: number) =>
  field(page).evaluate(
    (ed, [from, to]) => {
      const a = ed.children[from] as HTMLElement
      const b = ed.children[to] as HTMLElement
      const bt = b.lastChild as Node
      ;(document.getSelection() as Selection).setBaseAndExtent(
        a.firstChild as Node,
        0,
        bt,
        bt.nodeType === 3 ? (bt as Text).length : 0,
      )
    },
    [from, to] as const,
  )

test('cut and paste of bullet lines keeps them bullets', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const errors = await open(page, 'empty')
  const id = await writeNote(page, ['Plan', '- Milan', '- Turin', 'end'])
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('ControlOrMeta+c')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    'Plan\n- Milan\n- Turin\nend',
  )
  // The two bullets cut, then pasted back after "end": a list reordered.
  await selectLines(page, 1, 2)
  await page.keyboard.press('ControlOrMeta+x')
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('- Milan\n- Turin')
  await field(page).evaluate((ed) => {
    const last = (ed.lastElementChild as HTMLElement).firstChild as Text
    ;(document.getSelection() as Selection).collapse(last, last.length)
  })
  await page.keyboard.press('Enter')
  await page.keyboard.press('ControlOrMeta+v')
  await expect.poll(() => textOf(page, id)).toBe('Plan\n\nend\n- Milan\n- Turin')
  expect((await lineClasses(page)).slice(-2)).toEqual([
    'note-edit-bullet note-edit-bullet--first',
    'note-edit-bullet',
  ])
  expect(errors).toEqual([])
})

test('a drag of a bullet line inside the field moves it as written', async ({ page }) => {
  const errors = await open(page, 'empty')
  const id = await writeNote(page, ['Plan', '- Milan', 'end'])
  // The whole bullet line, as a triple-click selects it (up to the next line's start), dragged
  // to the start of the note.
  const at = await field(page).evaluate((ed) => {
    const milan = (ed.children[1] as HTMLElement).firstChild as Text
    const end = ed.children[2] as HTMLElement
    ;(document.getSelection() as Selection).setBaseAndExtent(milan, 0, end.firstChild as Node, 0)
    const rect = (n: Node, a: number, b: number) => {
      const r = document.createRange()
      r.setStart(n, a)
      r.setEnd(n, b)
      return r.getBoundingClientRect()
    }
    const g = rect(milan, 0, 1)
    const d = rect((ed.children[0] as HTMLElement).firstChild as Node, 0, 1)
    return {
      from: { x: g.left + g.width / 2, y: g.top + g.height / 2 },
      // On the glyph's leading part (drag events carry whole px), so the drop lands before it.
      to: { x: d.left + d.width * 0.25, y: d.top + d.height / 2 },
    }
  })
  // The drag as the browser sends it (Playwright's mouse drag does not start one on text).
  await field(page).evaluate((ed, at) => {
    const dt = new DataTransfer()
    const ev = (type: string, p: { x: number; y: number }) =>
      new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: p.x,
        clientY: p.y,
        dataTransfer: dt,
      })
    ed.dispatchEvent(ev('dragstart', at.from))
    if (dt.getData('text/plain') !== '- Milan\n') {
      throw new Error(`dragged ${JSON.stringify(dt.getData('text/plain'))}`)
    }
    ed.dispatchEvent(ev('drop', at.to))
    ed.dispatchEvent(ev('dragend', at.to))
  }, at)
  await expect.poll(() => textOf(page, id)).toBe('- Milan\nPlan\nend')
  expect((await lineClasses(page))[0]).toBe('note-edit-bullet note-edit-bullet--first')
  expect(errors).toEqual([])
})

test('a click elsewhere mid-composition keeps the composed text', async ({ page }) => {
  const errors = await open(page, 'empty')
  await pinNote(page)
  await expect(field(page)).toBeFocused()
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.imeSetComposition', {
    text: '´e¨ue',
    selectionStart: 5,
    selectionEnd: 5,
  })
  // On the cork beside the new note.
  const paper = await page.locator('.note--editing .note-paper').boundingBox()
  if (paper === null) throw new Error('no paper')
  await page.mouse.click(Math.max(20, paper.x - 60), Math.max(20, paper.y - 60))
  await expect(field(page)).toHaveCount(0)
  const texts = await page.evaluate(() =>
    [...window.__papertie.store.getState().notes.values()].map((n) => n.text),
  )
  expect(texts).toEqual(['´e¨ue'])
  expect(errors).toEqual([])
})

test('writing past the bottom of the view never scrolls the board', async ({ page }) => {
  const errors = await open(page, 'demo')
  const id = DEMO_IDS.knot
  await page.evaluate((id) => {
    const n = window.__papertie.store.getState().notes.get(id)
    if (n) window.__papertie.debug.setCamera({ x: n.x - 400, y: n.y - 700, zoom: 1 })
  }, id)
  await settle(page)
  await page.evaluate((id) => window.__papertie.runtime.startEditing(id), id)
  await expect(field(page)).toBeFocused()
  for (let i = 0; i < 12; i++) await page.keyboard.press('Enter')
  await page.keyboard.type('end')
  await settle(page)
  const scrolled = await page.evaluate(() => {
    const m = document.querySelector('main.viewport') as HTMLElement
    return [m.scrollLeft, m.scrollTop, window.scrollX, window.scrollY]
  })
  expect(scrolled).toEqual([0, 0, 0, 0])
  expect(errors).toEqual([])
})
