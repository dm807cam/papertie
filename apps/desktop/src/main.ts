import { createWriteStream, renameSync, statSync, type WriteStream } from 'node:fs'
import { basename, join } from 'node:path'
import {
  app,
  type BaseWindow,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  protocol,
  type Session,
  screen,
  session,
  shell,
  type WebContents,
} from 'electron'
import { createHostApp, type HostApp } from '../../server/src/host'
import { createBridge } from './bridge'
import {
  FILES_WANTED,
  OPEN_FILE,
  type OpenedFile,
  UPDATE_AVAILABLE,
  UPDATE_DISMISS,
  UPDATE_OPEN,
  UPDATE_SETTING_GET,
  UPDATE_SETTING_SET,
  UPDATES_WANTED,
  type UpdateNotice,
} from './channels'
import { OpenQueue, papertieFiles } from './fileOpen'
import { type HistoryStep, menuTemplate, runHistory } from './menu'
import { OpenedFiles } from './openedFiles'
import { isAppUrl, isWebUrl, SCHEME, START_URL } from './origin'
import {
  type Fetch,
  fetchLatest,
  isReleaseUrl,
  LATEST_URL,
  readUpdateState,
  testUrl,
  Updater,
  writeUpdateState,
} from './updates'
import {
  MIN_HEIGHT,
  MIN_WIDTH,
  readWindowState,
  type WindowState,
  writeWindowState,
} from './windowState'

/*
 * Papertie's desktop app: Papertie's server (apps/server `host.ts`) runs in
 * this process, and the window loads the built web app from `papertie://app/`. Every request of the
 * page goes through `protocol.handle` to the app's `fetch` (`bridge.ts`): no port is opened, so
 * nothing else on the machine reaches the board. The data lives in `userData/data`.
 */

const NAME = 'Papertie'
const COPYRIGHT = '© 2026 The Papertie authors. GPL-3.0-or-later.'
/** The cork's colour before the first paint (`html` in apps/web `public/stage.css`). */
const STAGE = '#8b6b47'
/** The built web app and the icon, beside this file (`scripts/build.mjs` puts them there). */
const WEB_DIST = join(__dirname, 'web')
const ICON = join(__dirname, 'icon.png')
const DEV = !app.isPackaged
const MAC = process.platform === 'darwin'
/** What the page may ask for: writing to the clipboard, and full screen. Nothing else. */
const PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen'])
/** The log is started afresh past this size (the old one is kept once, as `.old`). */
const LOG_MAX_BYTES = 16 * 1_048_576
/** The first update check comes this long after the window is shown; */
const UPDATE_FIRST_MS = 4000
/** then each hour it is asked whether a day has passed since GitHub last answered. */
const UPDATE_TICK_MS = 60 * 60 * 1000
/** The end-to-end tests' stand-in for GitHub (`testUrl`: this machine only). */
const UPDATE_TEST_URL = testUrl(process.env.PAPERTIE_UPDATE_URL)

app.setName(NAME)
// The end-to-end tests run on a `userData` of their own (and so on a lock of their own).
// Their log goes there too, so a packaged app under test leaves the user's own log alone.
if (process.env.PAPERTIE_USER_DATA) {
  app.setPath('userData', process.env.PAPERTIE_USER_DATA)
  app.setAppLogsPath(join(process.env.PAPERTIE_USER_DATA, 'logs'))
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
      codeCache: true,
    },
  },
])

const queue = new OpenQueue()
const opened = new OpenedFiles()
let win: BrowserWindow | null = null
let host: Promise<HostApp> | null = null
/** The page that asked for opened files, while it is the window's page. */
let taker: WebContents | null = null
/** The page that asked to be told of a newer release, while it is the window's page. */
let updateTaker: WebContents | null = null
let updater: Updater | null = null
let updateTimers: Array<ReturnType<typeof setTimeout>> = []

// macOS opens a file (Finder, the Dock icon, `open`) with this event, at launch too: before
// `ready`, so it is listened for at once.
app.on('open-file', (event, path) => {
  event.preventDefault()
  queue.open(path)
  if (app.isReady()) showWindow()
})

if (!app.requestSingleInstanceLock()) {
  // Another Papertie has this data: it is told (`second-instance`, with this line) and comes to
  // the front; this one leaves before it opens anything.
  app.quit()
} else {
  for (const path of papertieFiles(process.argv, process.cwd())) queue.open(path)
  app.on('second-instance', (_event, argv, cwd) => {
    for (const path of papertieFiles(argv, cwd)) queue.open(path)
    showWindow({ steal: true })
  })
  void app.whenReady().then(start)
}

function start(): void {
  const dataDir = join(app.getPath('userData'), 'data')
  host = createHostApp({ dataDir, webDist: WEB_DIST, logSink: logSink() })
  host.catch((e: unknown) => {
    dialog.showErrorBox(
      `${NAME} could not open its data`,
      `${e instanceof Error ? e.message : String(e)}\n\nThe data folder: ${dataDir}`,
    )
    app.quit()
  })
  protocol.handle(SCHEME, createBridge({ app: host.then((l) => l.app), opened }))
  lockDown(session.defaultSession)

  app.setAboutPanelOptions({
    applicationName: NAME,
    applicationVersion: app.getVersion(),
    copyright: COPYRIGHT,
    iconPath: ICON,
  })
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      menuTemplate({
        platform: process.platform,
        dev: DEV,
        name: NAME,
        history,
        showDataFolder: () => void shell.openPath(dataDir),
        about,
        checkForUpdates: () => void checkForUpdates(),
      }),
    ),
  )

  ipcMain.on(FILES_WANTED, (event) => {
    const wc = event.sender
    if (wc !== win?.webContents || !isAppUrl(event.senderFrame?.url ?? '')) return
    taker = wc
    queue.attach((path) => {
      const file: OpenedFile = { url: opened.add(path), name: basename(path) }
      wc.send(OPEN_FILE, file)
      showWindow()
    })
  })

  startUpdates()
  createWindow()
  app.on('activate', () => showWindow())
}

/** Whether a message is the app's own page speaking, in the window: the only one listened to. */
function fromApp(event: { sender: WebContents; senderFrame: { url: string } | null }): boolean {
  return event.sender === win?.webContents && isAppUrl(event.senderFrame?.url ?? '')
}

/**
 * The update check (`updates.ts` has its rules). This process asks GitHub, with Electron's `net`,
 * and tells the page; the page asks no one (its CSP reaches `papertie://app` alone). Papertie
 * checks by itself only as a packaged app on the person's own data: never in development and never
 * under the end-to-end tests (`PAPERTIE_USER_DATA`), unless a test names its own stand-in for
 * GitHub. Nothing is downloaded: "Download" opens the release page in the system browser.
 */
function startUpdates(): void {
  const file = join(app.getPath('userData'), 'updates.json')
  const version = app.getVersion()
  const u = new Updater({
    current: version,
    enabled: UPDATE_TEST_URL !== null || (app.isPackaged && !process.env.PAPERTIE_USER_DATA),
    now: () => Date.now(),
    latest: (signal) =>
      fetchLatest({
        fetch: net.fetch as unknown as Fetch,
        url: UPDATE_TEST_URL ?? LATEST_URL,
        version,
        signal,
      }),
    state: readUpdateState(file),
    save: (state) => writeUpdateState(file, state),
    announce: (update, manual) => {
      if (!updateTaker || updateTaker.isDestroyed()) return
      updateTaker.send(UPDATE_AVAILABLE, { ...update, manual } satisfies UpdateNotice)
    },
  })
  updater = u

  ipcMain.on(UPDATES_WANTED, (event) => {
    if (!fromApp(event)) return
    updateTaker = event.sender
    // A page that comes after the answer (a reload, a window opened again) is told what stands.
    const shown = u.shown
    if (shown) {
      event.sender.send(UPDATE_AVAILABLE, {
        ...shown.update,
        manual: shown.manual,
      } satisfies UpdateNotice)
    }
  })
  ipcMain.on(UPDATE_OPEN, (event) => {
    if (!fromApp(event)) return
    // The address is this process's own, checked when GitHub named it and again here.
    const url = u.take()
    if (url !== null && isReleaseUrl(url)) void shell.openExternal(url)
  })
  ipcMain.on(UPDATE_DISMISS, (event, version: unknown) => {
    if (fromApp(event)) u.dismiss(version)
  })
  ipcMain.handle(UPDATE_SETTING_GET, (event) => (fromApp(event) ? u.auto : false))
  ipcMain.handle(UPDATE_SETTING_SET, (event, on: unknown) => {
    if (!fromApp(event) || typeof on !== 'boolean') return u.auto
    u.setAuto(on)
    if (on) void u.automatic()
    return u.auto
  })
  app.on('before-quit', stopUpdates)
}

/** The automatic check: a moment after the window is first shown, then asked again each hour. */
function scheduleUpdates(): void {
  if (updateTimers.length > 0 || !updater) return
  const u = updater
  const first = setTimeout(() => void u.automatic(), UPDATE_FIRST_MS)
  const hourly = setInterval(() => void u.automatic(), UPDATE_TICK_MS)
  updateTimers = [first, hourly]
  for (const t of updateTimers) t.unref()
}

/** Quitting never waits for GitHub: the timers go, and a request in flight is given up. */
function stopUpdates(): void {
  for (const t of updateTimers) clearTimeout(t)
  updater?.stop()
}

/** The menu's "Check for Updates…": GitHub is asked now, and there is always an answer. */
async function checkForUpdates(): Promise<void> {
  if (!updater) return
  const result = await updater.manual()
  if (result === 'newer') {
    // The page says it, on a slip (told above, or as it loads in a window made again).
    showWindow()
    return
  }
  const options = {
    type: 'info' as const,
    title: NAME,
    message: result === 'current' ? `${NAME} is up to date.` : 'Couldn’t check for updates.',
    detail:
      result === 'current'
        ? `You have version ${app.getVersion()}.`
        : 'Check your connection, or try again later.',
    buttons: ['OK'],
  }
  if (win && !win.isDestroyed()) void dialog.showMessageBox(win, options)
  else void dialog.showMessageBox(options)
}

/**
 * The window to the front, made again if it was closed (macOS keeps the app without one). A
 * second launch was the person asking for Papertie, so on macOS it brings the app forward too.
 */
function showWindow(o: { steal?: boolean } = {}): void {
  if (!app.isReady()) return
  if (!win) {
    createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  if (o.steal && MAC) app.focus({ steal: true })
  win.focus()
}

function createWindow(): void {
  const stateFile = join(app.getPath('userData'), 'window-state.json')
  const state = readWindowState(
    stateFile,
    screen.getAllDisplays().map((d) => d.workArea),
  )
  const w = new BrowserWindow({
    width: state.width,
    height: state.height,
    ...(state.x !== undefined && state.y !== undefined ? { x: state.x, y: state.y } : {}),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    backgroundColor: STAGE,
    title: NAME,
    ...(MAC ? {} : { icon: ICON }),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      spellcheck: true,
    },
  })
  win = w
  w.once('ready-to-show', () => {
    if (state.maximized) w.maximize()
    if (state.fullScreen) w.setFullScreen(true)
    w.show()
    scheduleUpdates()
  })
  keepState(w, stateFile)
  lockNavigation(w.webContents)
  const wc = w.webContents
  // A new page (a reload) asks for files again; until then they wait.
  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument && taker === wc) {
      taker = null
      queue.detach()
    }
    if (details.isMainFrame && !details.isSameDocument && updateTaker === wc) updateTaker = null
  })
  wc.on('render-process-gone', () => {
    if (taker === wc) {
      taker = null
      queue.detach()
    }
    if (updateTaker === wc) updateTaker = null
  })
  w.on('closed', () => {
    if (taker === wc) {
      taker = null
      queue.detach()
    }
    if (updateTaker === wc) updateTaker = null
    if (win === w) win = null
  })
  void w.loadURL(START_URL)
}

/** The window's size and place, saved as it changes (a moment after) and when it closes. */
function keepState(w: BrowserWindow, file: string): void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const save = () => {
    clearTimeout(timer)
    if (w.isDestroyed()) return
    const b = w.getNormalBounds()
    const state: WindowState = {
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      maximized: w.isMaximized(),
      fullScreen: w.isFullScreen(),
    }
    try {
      writeWindowState(file, state)
    } catch {
      // Not saved: the window opens where it opened before.
    }
  }
  const soon = () => {
    clearTimeout(timer)
    timer = setTimeout(save, 400)
  }
  w.on('resize', soon)
  w.on('move', soon)
  w.on('maximize', soon)
  w.on('unmaximize', soon)
  w.on('enter-full-screen', soon)
  w.on('leave-full-screen', soon)
  w.on('close', save)
}

/**
 * The page stays the app: a navigation away from `papertie://app` is stopped (a web link opens in
 * the system browser instead), no other window opens, and no webview attaches.
 */
function lockNavigation(wc: WebContents): void {
  // Every frame's navigation, the page's own included (`will-navigate` comes after this one, and
  // only when it was not stopped here).
  wc.on('will-frame-navigate', (event) => {
    if (isAppUrl(event.url)) return
    event.preventDefault()
    if (event.isMainFrame && isWebUrl(event.url)) void shell.openExternal(event.url)
  })
  wc.on('will-redirect', (event) => {
    if (!isAppUrl(event.url)) event.preventDefault()
  })
  wc.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  wc.on('will-attach-webview', (event) => event.preventDefault())
}

/** The session asks for nothing it does not need. */
function lockDown(s: Session): void {
  s.setPermissionRequestHandler((_wc, permission, answer) => answer(PERMISSIONS.has(permission)))
  s.setPermissionCheckHandler((_wc, permission) => PERMISSIONS.has(permission))
}

function history(step: HistoryStep, byAccelerator: boolean, window: BaseWindow | undefined): void {
  const target =
    window instanceof BrowserWindow ? window : (BrowserWindow.getFocusedWindow() ?? win)
  if (!target || target.isDestroyed()) return
  runHistory(step, target.webContents, byAccelerator, process.platform)
}

function about(): void {
  if (process.platform === 'win32') {
    void dialog.showMessageBox({
      type: 'none',
      title: `About ${NAME}`,
      message: NAME,
      detail: `Version ${app.getVersion()}\nA private cork board and writer.\n${COPYRIGHT}`,
      icon: ICON,
    })
  } else {
    app.showAboutPanel()
  }
}

/** The server's log lines: the terminal in development, a file in the app's log folder otherwise. */
function logSink(): (line: string) => void {
  if (DEV) return (line) => process.stdout.write(`${line}\n`)
  const file = join(app.getPath('logs'), 'papertie.log')
  let out: WriteStream | null = null
  return (line) => {
    if (!out) {
      try {
        if (statSync(file).size > LOG_MAX_BYTES) renameSync(file, `${file}.old`)
      } catch {
        // No log yet.
      }
      out = createWriteStream(file, { flags: 'a' })
      out.on('error', () => {})
    }
    out.write(`${line}\n`)
  }
}

// Quitting waits for the board's writes in flight, then closes the store (`close()`), so the
// data folder is quiet before the process ends.
let closed = false
let closing = false
app.on('will-quit', (event) => {
  if (closed || host === null) return
  event.preventDefault()
  if (closing) return
  closing = true
  void host
    .then((l) => l.close())
    .catch(() => {})
    .finally(() => {
      closed = true
      // In a task of its own: Electron drops a quit asked while it is still sending this
      // `will-quit` (a window open), and a close with nothing to wait for (no board read since
      // the launch) is over in the same turn: the app stayed on, with no window.
      setImmediate(() => app.quit())
    })
})

// Windows and Linux leave with their last window; macOS keeps the app until it is quit.
app.on('window-all-closed', () => {
  if (!MAC) app.quit()
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => app.quit())
