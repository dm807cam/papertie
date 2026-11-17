import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron, type ElectronApplication, expect, type Page } from '@playwright/test'
import { saved } from '../app/helpers/board'

/** The desktop app's package: `electron .` there runs `dist/main.cjs`. */
export const DESKTOP_DIR = resolve(__dirname, '..', '..', 'apps', 'desktop')

/**
 * A packaged Papertie to launch instead of the development build: its executable, e.g.
 * `apps/desktop/release/mac-arm64/Papertie.app/Contents/MacOS/Papertie`. It runs its own app, so it
 * is given no app folder.
 */
const PACKAGED = process.env.PAPERTIE_DESKTOP_EXE ? resolve(process.env.PAPERTIE_DESKTOP_EXE) : null

/** What is launched: the packaged executable, or the Electron binary the desktop package installed. */
export const ELECTRON =
  PACKAGED ?? (createRequire(join(DESKTOP_DIR, 'package.json'))('electron') as string)
/**
 * The command line before a launch's own arguments: the app folder, for the development build, and
 * `PAPERTIE_DESKTOP_ARGS` (space-separated) when set. The release workflow launches the Linux app as
 * root in its container, which Chromium allows only with `--no-sandbox`.
 */
const APP_ARGS = [
  ...(PACKAGED ? [] : [DESKTOP_DIR]),
  ...(process.env.PAPERTIE_DESKTOP_ARGS?.split(' ').filter(Boolean) ?? []),
]

if (PACKAGED && !existsSync(PACKAGED)) {
  throw new Error(`No packaged app at PAPERTIE_DESKTOP_EXE (${PACKAGED}).`)
}
if (!PACKAGED && !existsSync(join(DESKTOP_DIR, 'dist', 'main.cjs'))) {
  throw new Error('No built desktop app: run `pnpm e2e:desktop` (it builds first).')
}

/** A fresh `userData` (the app's data, window state and lock), removed by `dispose`. */
export function freshUserData(): { dir: string; dispose(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'papertie-desktop-e2e-'))
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

const envFor = (userData: string, extra: Record<string, string> = {}) => {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env.ELECTRON_RUN_AS_NODE
  // No launch asks GitHub for updates: only a test that names its own stand-in (`extra`) checks.
  delete env.PAPERTIE_UPDATE_URL
  env.PAPERTIE_USER_DATA = userData
  return { ...env, ...extra }
}

export interface Launched {
  app: ElectronApplication
  page: Page
  /** Page errors seen since launch. */
  errors: string[]
}

/**
 * Papertie, launched on `userData` with `args` on its command line; its window, once shown.
 * `beforeWindow` runs as soon as the app is up, before its window is awaited (routes, say). `env`
 * is added to the app's environment.
 */
export async function launch(
  userData: string,
  args: string[] = [],
  beforeWindow?: (app: ElectronApplication) => Promise<void>,
  env: Record<string, string> = {},
): Promise<Launched> {
  const app = await _electron.launch({
    executablePath: ELECTRON,
    args: [...APP_ARGS, ...args],
    cwd: DESKTOP_DIR,
    env: envFor(userData, env),
  })
  await beforeWindow?.(app)
  const page = await app.firstWindow()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible()))
    .toBe(true)
  return { app, page, errors }
}

/** A second launch on the same `userData`, as a plain process: it should hand over and leave. */
export function launchAgain(userData: string, args: string[] = []): ChildProcess {
  return spawn(ELECTRON, [...APP_ARGS, ...args], {
    cwd: DESKTOP_DIR,
    env: envFor(userData),
    stdio: 'ignore',
  })
}

/** The process's exit code, within `ms`. */
export function exitOf(child: ChildProcess, ms = 30_000): Promise<number | null> {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve(child.exitCode)
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('the second launch did not leave'))
    }, ms)
    child.once('exit', (code) => {
      clearTimeout(timer)
      resolve(code)
    })
  })
}

/**
 * The board with the test hooks (`?bench`), drawn and saved: what the first page left unsent (a
 * first launch's welcome note) is in, so the notes read next are settled.
 */
export async function openBoard(page: Page): Promise<void> {
  await page.goto('papertie://app/?bench')
  await page.waitForFunction(() => window.__papertie?.ready === true)
  await saved(page)
}

/** A request of the page's own, through the app's protocol: its status and text. */
export const inApp = (page: Page, path: string, init?: { method?: string; body?: string }) =>
  page.evaluate(
    async ({ path, init }) => {
      const res = await fetch(path, {
        method: init?.method ?? 'GET',
        body: init?.body,
        headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
      })
      return { status: res.status, text: await res.text() }
    },
    { path, init },
  )

/** The one board's id. */
export async function theBoard(page: Page): Promise<string> {
  const res = await inApp(page, '/api/boards')
  expect(res.status).toBe(200)
  const list = JSON.parse(res.text) as Array<{ id: string }>
  expect(list).toHaveLength(1)
  return (list[0] as { id: string }).id
}

/** The board's records on the server, as its JSONL export has them. */
export async function serverRecords(
  page: Page,
  boardId: string,
): Promise<
  Array<{ type: string; id: string; text?: string; bookId?: string; noteIds?: string[] }>
> {
  const res = await inApp(page, `/api/boards/${boardId}/export?format=jsonl`)
  expect(res.status).toBe(200)
  return res.text
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => JSON.parse(l))
}

/** The `.papertie` archive of the board, as the page downloads it, in bytes. */
export async function exportPapertie(page: Page, boardId: string): Promise<Buffer> {
  const bytes = await page.evaluate(async (path) => {
    const res = await fetch(path)
    if (!res.ok) throw new Error(`export: ${res.status}`)
    return [...new Uint8Array(await res.arrayBuffer())]
  }, `/api/boards/${boardId}/export?format=papertie`)
  return Buffer.from(bytes)
}

/** The main window's state, from the main process. */
export const windowState = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => {
    const all = BrowserWindow.getAllWindows()
    const w = all[0]
    if (!w) return null
    return {
      count: all.length,
      visible: w.isVisible(),
      minimized: w.isMinimized(),
      focused: w.isFocused(),
      bounds: w.getBounds(),
      url: w.webContents.getURL(),
    }
  })
