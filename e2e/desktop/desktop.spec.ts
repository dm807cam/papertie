import { readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { noteEl, paperPoint, pin, saved } from '../app/helpers/board'
import { uploadFigure } from '../app/helpers/books'
import { bareCork, expectNoAccountWords, pageNotes, pageYarns, pinNote } from '../app/helpers/page'
import { armYarn } from '../yarnTool'
import {
  exitOf,
  exportPapertie,
  freshUserData,
  inApp,
  type Launched,
  launch,
  launchAgain,
  openBoard,
  serverRecords,
  theBoard,
  windowState,
} from './helpers'

/*
 * The desktop app, built and launched in Electron on a userData of its own:
 * straight onto the board, a note and a thread kept across a quit, a book, a `.papertie` file the
 * system opened, links that leave the app, the menu's undo, and one instance only.
 */

let userData: ReturnType<typeof freshUserData>
const running: Launched[] = []

test.beforeEach(() => {
  userData = freshUserData()
})
test.afterEach(async () => {
  for (const l of running.splice(0)) await l.app.close().catch(() => {})
  userData.dispose()
})

async function start(args: string[] = []): Promise<Launched> {
  const l = await launch(userData.dir, args)
  running.push(l)
  return l
}

async function quit(l: Launched): Promise<void> {
  await l.app.close()
  running.splice(running.indexOf(l), 1)
}

const tools = (page: Page) => page.getByRole('toolbar', { name: 'Tools' })
const notes = (n: number) => `${n} ${n === 1 ? 'note' : 'notes'}`
const ask = (page: Page) => page.getByRole('dialog', { name: 'Settings' }).getByRole('alertdialog')

test('opens straight on the board; a note, a thread and the window outlive a quit', async () => {
  const first = await start()
  const { page, app } = first
  // Straight onto the board: no sign-in, no account, on the app's own scheme.
  await expect(page.getByTestId('canvas')).toBeVisible()
  expect(page.url()).toBe('papertie://app/')
  await expectNoAccountWords(page)

  // The window: the cork's colour behind the first paint, and a page with no Node in it.
  const prefs = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    // Electron's own method (Playwright's types of the module leave it out).
    const wc = w?.webContents as
      | { getLastWebPreferences(): Record<string, unknown> | null }
      | undefined
    const p = wc?.getLastWebPreferences()
    return {
      background: w?.getBackgroundColor(),
      contextIsolation: p?.contextIsolation,
      sandbox: p?.sandbox,
      nodeIntegration: p?.nodeIntegration,
    }
  })
  expect(prefs).toEqual({
    background: '#8B6B47',
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
  })
  expect(
    await page.evaluate(() => ({
      require: typeof (window as { require?: unknown }).require,
      process: typeof (window as { process?: unknown }).process,
      bridge: Object.keys((window as { papertieDesktop?: object }).papertieDesktop ?? {}),
    })),
  ).toEqual({
    require: 'undefined',
    process: 'undefined',
    // Opened files, and the update check: nothing else.
    bridge: [
      'onOpenFile',
      'onUpdateAvailable',
      'openUpdate',
      'dismissUpdate',
      'getUpdateSetting',
      'setUpdateSetting',
    ],
  })

  // The strict CSP holds on the scheme: an inline script is refused, and said to be.
  const csp = await page.evaluate(async () => {
    const refused: string[] = []
    document.addEventListener('securitypolicyviolation', (e) => refused.push(e.violatedDirective))
    const s = document.createElement('script')
    s.textContent = 'window.__inline = 1'
    document.head.append(s)
    await new Promise((r) => setTimeout(r, 100))
    return { refused, inline: (window as { __inline?: number }).__inline ?? null }
  })
  expect(csp).toEqual({ refused: ['script-src-elem'], inline: null })
  const header = await page.evaluate(() =>
    fetch('/').then((r) => r.headers.get('Content-Security-Policy')),
  )
  expect(header).toContain("script-src 'self'")

  // A note and a thread.
  await openBoard(page)
  const paris = await pinNote(page, 'Paris morning', await bareCork(page))
  await page.keyboard.press('Escape')
  const milan = await pinNote(page, 'Milan', await bareCork(page, 140))
  await page.keyboard.press('Escape')
  await armYarn(page)
  const from = await pin(page, paris)
  const onto = await paperPoint(page, milan)
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(onto.x, onto.y, { steps: 12 })
  await page.mouse.up()
  await page.keyboard.press('v')
  await expect.poll(() => pageYarns(page)).toEqual([[paris, milan]])
  await saved(page)
  const notes = await pageNotes(page)

  // The window moved and sized, then quit.
  // Inside the screen's work area, where the system leaves a new window as it is put.
  const bounds = await app.evaluate(({ screen }) => {
    const wa = screen.getPrimaryDisplay().workArea
    return {
      x: wa.x + 40,
      y: wa.y + 30,
      width: Math.min(1100, wa.width - 80),
      height: Math.min(700, wa.height - 60),
    }
  })
  await app.evaluate(
    ({ BrowserWindow }, b) => BrowserWindow.getAllWindows()[0]?.setBounds(b),
    bounds,
  )
  await expect.poll(async () => (await windowState(app))?.bounds).toEqual(bounds)
  expect(first.errors).toEqual([])
  await quit(first)

  // Launched again: the board as it was left, in the window as it was left.
  const again = await start()
  expect((await windowState(again.app))?.bounds).toEqual(bounds)
  await openBoard(again.page)
  await saved(again.page)
  expect(await pageNotes(again.page)).toEqual(notes)
  expect(await pageYarns(again.page)).toEqual([[paris, milan]])
  await expect(noteEl(again.page, paris)).toContainText('Paris morning')
  const boardId = await theBoard(again.page)
  const records = await serverRecords(again.page, boardId)
  expect(records.find((r) => r.id === milan)?.text).toBe('Milan')
  expect(records.filter((r) => r.type === 'yarn').map((r) => r.noteIds)).toEqual([[paris, milan]])
  expect(again.errors).toEqual([])
})

test('a book is opened and written in, and the words outlive a quit', async () => {
  const first = await start()
  const { page } = first
  await openBoard(page)
  const boardId = await theBoard(page)
  await tools(page).getByRole('button', { name: 'Books' }).click()
  const shelf = page.getByRole('dialog', { name: 'Books' })
  await expect(shelf).toBeVisible()
  await shelf.getByRole('button', { name: 'New book' }).click()
  await expect(page).toHaveURL(/\/book\/book_\w+$/)
  const bookId = new URL(page.url()).pathname.split('/').at(-1) as string
  await expect(page.getByRole('textbox', { name: 'Title' })).toBeFocused()
  await page.keyboard.type('Field notes')
  await page.keyboard.press('Escape')
  await shelf.getByRole('button', { name: 'Field notes', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/book/${bookId}$`))
  const blocks = page.locator('.writer [data-id]')
  await blocks.first().click()
  await page.keyboard.type('The first line, written here.')
  const written = async () =>
    (await serverRecords(page, boardId))
      .filter((r) => r.bookId === bookId && r.type !== 'book')
      .map((r) => r.text)
  await expect.poll(written, { timeout: 15_000 }).toEqual(['The first line, written here.'])
  expect(first.errors).toEqual([])
  await quit(first)

  const again = await start()
  await again.page.goto(`papertie://app/book/${bookId}`)
  await expect(again.page.locator('.writer [data-id]').first()).toHaveText(
    'The first line, written here.',
  )
  expect(again.errors).toEqual([])
})

test("a photo goes through sharp, the app's one native part, and is served back", async () => {
  const { page, app, errors } = await start()
  // The build under test: the packaged app when PAPERTIE_DESKTOP_EXE names one.
  expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(!!process.env.PAPERTIE_DESKTOP_EXE)
  await openBoard(page)
  const assetId = await uploadFigure(page, await theBoard(page))
  const served = await page.evaluate(async (id) => {
    const res = await fetch(`/api/assets/${id}/256`)
    return {
      status: res.status,
      type: res.headers.get('Content-Type'),
      bytes: (await res.arrayBuffer()).byteLength,
    }
  }, assetId)
  expect(served).toMatchObject({ status: 200, type: 'image/webp' })
  expect(served.bytes).toBeGreaterThan(0)
  expect(errors).toEqual([])
})

test('a .papertie file the system opens is asked about, then replaces the board', async () => {
  const { page, app, errors } = await start()
  await openBoard(page)
  const boardId = await theBoard(page)
  // A first launch's board: its welcome note, if it was sent before the page reloaded.
  const welcome = Object.keys(await pageNotes(page))
  const kept = await pinNote(page, 'Kept in the file', await bareCork(page))
  await page.keyboard.press('Escape')
  await saved(page)
  const file = join(userData.dir, 'Garden board.papertie')
  writeFileSync(file, await exportPapertie(page, boardId))
  const later = await pinNote(page, 'Made after', await bareCork(page, 140))
  await page.keyboard.press('Escape')
  await saved(page)
  expect(Object.keys(await pageNotes(page)).sort()).toEqual([...welcome, kept, later].sort())

  // macOS opens a file with `open-file` (Finder, the Dock icon): Settings → Import asks.
  await app.evaluate(({ app }, path) => {
    app.emit('open-file', { preventDefault() {} }, path)
  }, file)
  await expect(page).toHaveURL('papertie://app/settings/export')
  const question = ask(page)
  await expect(question).toBeVisible()
  await expect(question).toContainText(`It has ${notes(welcome.length + 1)} and 0 threads.`)
  // Nothing changed until it is answered.
  expect(Object.keys(await pageNotes(page)).sort()).toEqual([...welcome, kept, later].sort())
  await question.getByRole('button', { name: 'Replace board' }).click()
  await expect(page.getByText('Board replaced. You can undo this from History.')).toBeVisible()
  await expect
    .poll(async () => Object.keys(await pageNotes(page)).sort())
    .toEqual([...welcome, kept].sort())
  await expect
    .poll(async () => (await serverRecords(page, boardId)).filter((r) => r.type === 'note').length)
    .toBe(welcome.length + 1)
  // The board as it was is kept in History (the import's safety backup).
  const backups = await inApp(page, `/api/boards/${boardId}/backups`)
  expect(backups.status).toBe(200)
  const rows = (JSON.parse(backups.text) as { backups: Array<{ notes: number }> }).backups
  expect(rows.map((r) => r.notes)).toContain(welcome.length + 2)
  expect(errors).toEqual([])
})

test('a .papertie file on the command line is asked about at launch; Keep current keeps the board', async () => {
  const first = await start()
  await openBoard(first.page)
  const boardId = await theBoard(first.page)
  const welcome = Object.keys(await pageNotes(first.page))
  await pinNote(first.page, 'In the file', await bareCork(first.page))
  await first.page.keyboard.press('Escape')
  await saved(first.page)
  const file = join(userData.dir, 'Other.papertie')
  writeFileSync(file, await exportPapertie(first.page, boardId))
  await pinNote(first.page, 'Only here', await bareCork(first.page, 140))
  await first.page.keyboard.press('Escape')
  await saved(first.page)
  const before = await serverRecords(first.page, boardId)
  await quit(first)

  // Windows and Linux open a file by launching the app with its path.
  const { page, errors } = await start([file])
  const question = ask(page)
  await expect(question).toBeVisible()
  await expect(question).toContainText(`It has ${notes(welcome.length + 1)} and 0 threads.`)
  await question.getByRole('button', { name: 'Keep current' }).click()
  await expect(question).toHaveCount(0)
  expect(await serverRecords(page, boardId)).toEqual(before)
  expect(errors).toEqual([])
})

test('a web link opens in the system browser, never inside the app', async () => {
  const { page, app, errors } = await start()
  await openBoard(page)
  // The system browser, stood in for: what it was asked to open.
  await app.evaluate(({ shell }) => {
    const opened: string[] = []
    ;(globalThis as { __opened?: string[] }).__opened = opened
    shell.openExternal = async (url: string) => {
      opened.push(url)
    }
  })
  await page.evaluate(() => {
    const a = document.createElement('a')
    a.href = 'https://example.com/linked'
    a.target = '_blank'
    a.textContent = 'a link'
    document.body.append(a)
    a.click()
    window.open('https://example.com/opened')
    const b = document.createElement('a')
    b.href = 'https://example.com/followed'
    document.body.append(b)
    b.click()
  })
  await expect
    .poll(() => app.evaluate(() => (globalThis as { __opened?: string[] }).__opened))
    .toEqual([
      'https://example.com/linked',
      'https://example.com/opened',
      'https://example.com/followed',
    ])
  // A page that is not a web page is not opened anywhere.
  await page.evaluate(() => {
    location.href = 'file:///etc/hosts'
  })
  await page.waitForTimeout(500)
  const state = await windowState(app)
  expect(state?.count).toBe(1)
  expect(state?.url.startsWith('papertie://app/')).toBe(true)
  expect(await app.evaluate(() => (globalThis as { __opened?: string[] }).__opened)).toHaveLength(3)
  // The board is still there (read in the page: Playwright still waits on the stopped navigation).
  expect(await page.evaluate(() => document.querySelector('[data-testid="canvas"]') !== null)).toBe(
    true,
  )
  expect(errors).toEqual([])
})

test("⌘Z is the app's undo, and the menu's Undo and Redo reach it too", async () => {
  const { page, app } = await start()
  await openBoard(page)
  const id = await pinNote(page, 'Undo me', await bareCork(page))
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await saved(page)
  const made = await pageNotes(page)
  expect(Object.keys(made)).toContain(id)
  const now = () => pageNotes(page)
  // The key, as typed: the app's own undo takes it (the page hears it before the menu): the
  // note's last step (its hanging) is undone.
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(now).not.toEqual(made)
  const undone = await now()
  // The menu's items, clicked: the same redo and undo.
  const click = (itemId: string) =>
    app.evaluate(({ Menu }, itemId) => {
      Menu.getApplicationMenu()?.getMenuItemById(itemId)?.click()
    }, itemId)
  await click('redo')
  await expect.poll(now).toEqual(made)
  await click('undo')
  await expect.poll(now).toEqual(undone)
})

test('a second launch brings the first window forward, with its file, and leaves', async () => {
  const first = await start()
  const { page, app } = first
  await openBoard(page)
  const boardId = await theBoard(page)
  const file = join(userData.dir, 'Handed over.papertie')
  writeFileSync(file, await exportPapertie(page, boardId))
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.minimize())
  await expect.poll(async () => (await windowState(app))?.minimized).toBe(true)

  const second = launchAgain(userData.dir, [file])
  expect(await exitOf(second)).toBe(0)
  await expect
    .poll(async () => {
      const s = await windowState(app)
      return s && { count: s.count, visible: s.visible, minimized: s.minimized }
    })
    .toEqual({ count: 1, visible: true, minimized: false })
  await expect.poll(async () => (await windowState(app))?.focused).toBe(true)
  // Its file went to the first window's import, which asks.
  await expect(ask(page)).toBeVisible()
  await ask(page).getByRole('button', { name: 'Keep current' }).click()
  expect(first.errors).toEqual([])
})

test('a quit with no board read since the launch leaves', async () => {
  // A board in the data folder, from a first launch.
  const first = await start()
  await openBoard(first.page)
  await quit(first)
  // Launched again, its window sent at once to a page that reads no board (the server's health):
  // the server has opened its data and holds no board. Quitting then has nothing to wait for.
  const l = await launch(userData.dir, [], (app) =>
    app.evaluate(({ app: electron, webContents }) => {
      const away = (wc: Electron.WebContents) => {
        wc.stop()
        void wc.loadURL('papertie://app/api/health')
      }
      const wc = webContents.getAllWebContents()[0]
      if (wc) away(wc)
      else electron.once('web-contents-created', (_e, made) => away(made))
    }),
  )
  running.push(l)
  await expect.poll(() => l.page.url()).toBe('papertie://app/api/health')
  await expect(l.page.locator('body')).toContainText('ok')
  const exited = new Promise<number | null>((done) => l.app.process().once('exit', done))
  await l.app.evaluate(({ app }) => app.quit())
  const gone = await Promise.race([
    exited,
    new Promise((done) => setTimeout(() => done('still running'), 15_000)),
  ])
  expect(gone).toBe(0)
  running.splice(running.indexOf(l), 1)
})

test('a reload hands its event stream back: a dozen reloads leave the board live', async () => {
  const { page, errors } = await start()
  await openBoard(page)
  const boardId = await theBoard(page)
  // More reloads than the event streams one person may hold at once (12).
  for (let i = 0; i < 14; i++) await openBoard(page)
  const id = await pinNote(page, 'Still live', await bareCork(page))
  await page.keyboard.press('Escape')
  await saved(page)
  expect(Object.keys(await pageNotes(page))).toContain(id)
  // One more stream opens: none of the reloaded pages' streams is still held.
  const status = await page.evaluate(async (path) => {
    const abort = new AbortController()
    const res = await fetch(path, { signal: abort.signal })
    abort.abort()
    return res.status
  }, `/api/boards/${boardId}/events`)
  expect(status).toBe(200)
  expect(errors).toEqual([])
})

/*
 * The update check. GitHub is stood in for by a server of the test's own on this machine
 * (`PAPERTIE_UPDATE_URL`); every other launch in these specs checks nothing. The release page the
 * answer names is still held to github.com/dm807cam/papertie/releases.
 */
const RELEASE_PAGE = 'https://github.com/dm807cam/papertie/releases/tag/v99.0.0'
const release = (over: Record<string, unknown> = {}) => ({
  tag_name: 'v99.0.0',
  html_url: RELEASE_PAGE,
  draft: false,
  prerelease: false,
  ...over,
})

interface FakeGitHub {
  url: string
  /** What the next answers are. */
  answer: { status: number; body: unknown }
  /** Each request received: its method, path and headers. */
  requests: Array<{ method: string; path: string; headers: IncomingHttpHeaders; body: string }>
  close(): Promise<void>
}

async function fakeGitHub(body: unknown = release()): Promise<FakeGitHub> {
  const gh: FakeGitHub = {
    url: '',
    answer: { status: 200, body },
    requests: [],
    close: () => new Promise((done) => server.close(() => done())),
  }
  const server = createServer((req, res) => {
    let sent = ''
    req.on('data', (chunk) => {
      sent += String(chunk)
    })
    req.on('end', () => {
      gh.requests.push({
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        body: sent,
      })
      res.writeHead(gh.answer.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(gh.answer.body))
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  gh.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/latest`
  return gh
}

async function startWithUpdates(gh: FakeGitHub): Promise<Launched> {
  const l = await launch(userData.dir, [], undefined, { PAPERTIE_UPDATE_URL: gh.url })
  running.push(l)
  return l
}

const updateSlip = (page: Page) => page.locator('.sync-updated [data-kind="update"]')
const updateState = () =>
  JSON.parse(readFileSync(join(userData.dir, 'updates.json'), 'utf8')) as {
    auto: boolean
    lastCheck: number
    dismissed: string | null
    latest: { version: string; url: string } | null
  }

/** The system browser and the native message box, stood in for: what each was asked. */
const standIns = (app: Launched['app']) =>
  app.evaluate(({ shell, dialog }) => {
    const g = globalThis as { __opened?: string[]; __boxes?: string[] }
    const opened: string[] = []
    const boxes: string[] = []
    g.__opened = opened
    g.__boxes = boxes
    shell.openExternal = async (url: string) => {
      opened.push(url)
    }
    dialog.showMessageBox = (async (...args: unknown[]) => {
      const o = (args.length > 1 ? args[1] : args[0]) as { message: string }
      boxes.push(o.message)
      return { response: 0, checkboxChecked: false }
    }) as typeof dialog.showMessageBox
  })
const openedPages = (app: Launched['app']) =>
  app.evaluate(() => (globalThis as { __opened?: string[] }).__opened ?? [])
const boxes = (app: Launched['app']) =>
  app.evaluate(() => (globalThis as { __boxes?: string[] }).__boxes ?? [])
const checkFromMenu = (app: Launched['app']) =>
  app.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()?.getMenuItemById('check-updates')?.click()
  })

test('a newer release is said on a slip; Later dismisses it, and the next launch stays quiet', async () => {
  const gh = await fakeGitHub()
  try {
    const first = await startWithUpdates(gh)
    const { page, app, errors } = first
    const version = await app.evaluate(({ app: electron }) => electron.getVersion())
    await expect(page.getByTestId('canvas')).toBeVisible()
    // A few seconds after the window is shown.
    const slip = updateSlip(page)
    await expect(slip).toBeVisible({ timeout: 20_000 })
    await expect(slip).toContainText('Papertie 99.0.0 is available.')
    await expect(slip).toHaveAttribute('role', 'note')
    // Said politely, and the slip takes no focus.
    await expect(page.locator('[data-live-region]')).toHaveText(/Papertie 99\.0\.0 is available\./)
    expect(
      await page.evaluate(() => document.activeElement?.closest('.sync-updated') ?? null),
    ).toBeNull()
    await expect(slip.getByRole('button')).toHaveText(['Download', 'Later'])

    // One request: a GET that says which Papertie asks, and nothing of the person or the board.
    expect(gh.requests).toHaveLength(1)
    const sent = gh.requests[0] as FakeGitHub['requests'][number]
    expect(sent.method).toBe('GET')
    expect(sent.path).toBe('/latest')
    expect(sent.body).toBe('')
    expect(sent.headers['user-agent']).toBe(`Papertie/${version}`)
    expect(sent.headers.accept).toBe('application/vnd.github+json')
    // Not the system's language: a fixed one.
    expect(sent.headers['accept-language']).toBe('en')
    for (const h of ['cookie', 'authorization', 'referer', 'origin']) {
      expect(sent.headers[h], h).toBeUndefined()
    }
    // Every header sent is one of these: none carries an identifier.
    expect(Object.keys(sent.headers).sort()).toEqual([
      'accept',
      'accept-encoding',
      'accept-language',
      'connection',
      'host',
      'sec-fetch-dest',
      'sec-fetch-mode',
      'sec-fetch-site',
      'user-agent',
    ])

    // The slip is there on a reloaded page too, until it is answered.
    await openBoard(page)
    await expect(slip).toBeVisible()
    // Reached by keyboard: Later, pressed with the keys.
    await slip.getByRole('button', { name: 'Later' }).focus()
    await page.keyboard.press('Enter')
    await expect(slip).toHaveCount(0)
    await expect.poll(() => updateState().dismissed).toBe('99.0.0')
    expect(updateState().latest).toEqual({ version: '99.0.0', url: RELEASE_PAGE })
    expect(errors).toEqual([])
    await quit(first)

    // Launched again: within the day GitHub is not asked, and the dismissed version is not said.
    const again = await startWithUpdates(gh)
    await openBoard(again.page)
    await again.page.waitForTimeout(7000)
    await expect(updateSlip(again.page)).toHaveCount(0)
    expect(gh.requests).toHaveLength(1)
    // Asked for through the menu, it is said all the same.
    await checkFromMenu(again.app)
    await expect(updateSlip(again.page)).toContainText('Papertie 99.0.0 is available.')
    expect(gh.requests).toHaveLength(2)
    expect(again.errors).toEqual([])
  } finally {
    await gh.close()
  }
})

test('Download opens the release page on GitHub in the system browser, and nothing else', async () => {
  const gh = await fakeGitHub()
  try {
    const { page, app, errors } = await startWithUpdates(gh)
    await standIns(app)
    const slip = updateSlip(page)
    await expect(slip).toBeVisible({ timeout: 20_000 })
    await slip.getByRole('button', { name: 'Download' }).click()
    await expect.poll(() => openedPages(app)).toEqual([RELEASE_PAGE])
    await expect(slip).toHaveCount(0)
    // The page cannot have another address opened: the bridge takes none, and a second ask
    // finds nothing announced.
    await page.evaluate(() => {
      const bridge = (window as unknown as { papertieDesktop: { openUpdate(url?: string): void } })
        .papertieDesktop
      bridge.openUpdate('https://example.com/not-a-release')
      bridge.openUpdate()
    })
    await page.waitForTimeout(500)
    expect(await openedPages(app)).toEqual([RELEASE_PAGE])
    // Nothing was downloaded or dismissed: the app only pointed at the page.
    expect(updateState().dismissed).toBeNull()
    const state = await windowState(app)
    expect(state?.count).toBe(1)
    expect(state?.url.startsWith('papertie://app/')).toBe(true)
    expect(errors).toEqual([])
  } finally {
    await gh.close()
  }
})

test('a release page that is not on Papertie’s GitHub is never shown or opened', async () => {
  const gh = await fakeGitHub(
    release({ html_url: 'https://example.com/dm807cam/papertie/releases/tag/v99.0.0' }),
  )
  try {
    const { page, app, errors } = await startWithUpdates(gh)
    await standIns(app)
    await openBoard(page)
    await expect.poll(() => gh.requests.length, { timeout: 20_000 }).toBe(1)
    await page.waitForTimeout(1500)
    await expect(updateSlip(page)).toHaveCount(0)
    // An automatic check fails silently; asked for, it says so, and still shows no slip.
    expect(await boxes(app)).toEqual([])
    await checkFromMenu(app)
    await expect.poll(() => boxes(app)).toEqual(['Couldn’t check for updates.'])
    await expect(updateSlip(page)).toHaveCount(0)
    expect(await openedPages(app)).toEqual([])
    expect(errors).toEqual([])
  } finally {
    await gh.close()
  }
})

test('Check for Updates… always answers; the Preferences switch stops the automatic check', async () => {
  const gh = await fakeGitHub()
  try {
    const first = await startWithUpdates(gh)
    const { page, app } = first
    await standIns(app)
    const version = await app.evaluate(({ app: electron }) => electron.getVersion())
    await expect(updateSlip(page)).toBeVisible({ timeout: 20_000 })
    await updateSlip(page).getByRole('button', { name: 'Later' }).click()

    // The same version as this one: up to date.
    gh.answer = { status: 200, body: release({ tag_name: `v${version}` }) }
    await checkFromMenu(app)
    await expect.poll(() => boxes(app)).toEqual(['Papertie is up to date.'])
    // A rate limit, and a redirect: could not check. No slip, no crash.
    gh.answer = { status: 403, body: { message: 'API rate limit exceeded' } }
    await checkFromMenu(app)
    await expect.poll(() => boxes(app)).toHaveLength(2)
    gh.answer = { status: 302, body: release() }
    await checkFromMenu(app)
    await expect.poll(() => boxes(app)).toHaveLength(3)
    expect((await boxes(app)).slice(1)).toEqual([
      'Couldn’t check for updates.',
      'Couldn’t check for updates.',
    ])
    await expect(updateSlip(page)).toHaveCount(0)

    // Settings → Preferences: the switch, on by default, with its one line.
    await page.goto('papertie://app/settings/preferences')
    const group = page.getByRole('group', { name: 'Check for updates automatically' })
    await expect(group.getByRole('radio', { name: 'On' })).toBeChecked()
    await expect(group).toContainText(
      'Once a day, Papertie asks GitHub whether a newer version exists. Nothing about you or your board is sent.',
    )
    await group.getByRole('radio', { name: 'Off' }).check({ force: true })
    await expect.poll(() => updateState().auto).toBe(false)
    await quit(first)

    // Switched off, with a day gone by since the last answer: the next launch asks nothing.
    writeFileSync(
      join(userData.dir, 'updates.json'),
      JSON.stringify({ ...updateState(), lastCheck: 1, dismissed: null }),
    )
    gh.answer = { status: 200, body: release() }
    const asked = gh.requests.length
    const again = await startWithUpdates(gh)
    await standIns(again.app)
    await again.page.goto('papertie://app/settings/preferences')
    const off = again.page
      .getByRole('group', { name: 'Check for updates automatically' })
      .getByRole('radio', { name: 'Off' })
    await expect(off).toBeChecked()
    await again.page.waitForTimeout(7000)
    expect(gh.requests).toHaveLength(asked)
    await expect(updateSlip(again.page)).toHaveCount(0)
    // The menu's check works all the same.
    await checkFromMenu(again.app)
    await expect(updateSlip(again.page)).toContainText('Papertie 99.0.0 is available.')
    expect(gh.requests).toHaveLength(asked + 1)
    expect(updateState().auto).toBe(false)
    expect(again.errors).toEqual([])
  } finally {
    await gh.close()
  }
})

test('quitting does not wait for an update check that has no answer', async () => {
  // A stand-in that never answers.
  const hung = createServer(() => {})
  await new Promise<void>((done) => hung.listen(0, '127.0.0.1', done))
  const url = `http://127.0.0.1:${(hung.address() as AddressInfo).port}/latest`
  try {
    const l = await launch(userData.dir, [], undefined, { PAPERTIE_UPDATE_URL: url })
    running.push(l)
    await openBoard(l.page)
    const connected = () => new Promise<number>((done) => hung.getConnections((_e, n) => done(n)))
    await expect.poll(connected, { timeout: 20_000 }).toBeGreaterThan(0)
    const exited = new Promise<number | null>((done) => l.app.process().once('exit', done))
    const at = Date.now()
    await l.app.evaluate(({ app }) => app.quit())
    const gone = await Promise.race([
      exited,
      new Promise((done) => setTimeout(() => done('still running'), 8000)),
    ])
    expect(gone).toBe(0)
    expect(Date.now() - at).toBeLessThan(8000)
    running.splice(running.indexOf(l), 1)
  } finally {
    hung.closeAllConnections()
    await new Promise((done) => hung.close(done))
  }
})
