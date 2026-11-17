import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test as base, type ElectronApplication, expect, type Page } from '@playwright/test'
import { freshUserData, launch } from '../../desktop/helpers'

/*
 * The `app` specs run in Papertie itself: the built desktop app, launched for each test on a data
 * folder of its own. `page` is its window, `api` the app's own routes (asked from the main
 * process, through the app's protocol, so a read never waits on the page).
 */

/** The app's one origin. */
export const APP_URL = 'papertie://app'

/** The window's content size unless a test asks for another. */
export const VIEWPORT = { width: 1280, height: 800 }

export interface ApiResponse {
  status(): number
  ok(): boolean
  headers(): Record<string, string>
  text(): Promise<string>
  json(): Promise<unknown>
  body(): Promise<Buffer>
}

/** A file in a multipart body. */
export interface ApiFile {
  name: string
  mimeType: string
  buffer: Buffer
}

export interface ApiInit {
  headers?: Record<string, string>
  /** A JSON body. */
  data?: unknown
  /** A form body: text fields and files. */
  multipart?: Record<string, string | ApiFile>
}

/** The app's routes, by path (`/api/…`). */
export interface Api {
  get(path: string, init?: ApiInit): Promise<ApiResponse>
  post(path: string, init?: ApiInit): Promise<ApiResponse>
  put(path: string, init?: ApiInit): Promise<ApiResponse>
  delete(path: string, init?: ApiInit): Promise<ApiResponse>
}

/** One launched Papertie. */
export interface Running {
  app: ElectronApplication
  page: Page
  api: Api
  /** Its data folder (`userData`). */
  userData: string
  /** Page errors seen since launch. */
  errors: string[]
}

export interface LaunchOptions {
  /** The window's content size ({@link VIEWPORT} when left out). */
  viewport?: { width: number; height: number }
  /** A data folder to launch on (one a quit Papertie left); a fresh one when left out. */
  userData?: string
  /** More of the app's command line (a file to open, say). */
  args?: string[]
}

export interface Desktop {
  /** The test's Papertie, launched at first use. */
  main(): Promise<Running>
  /** Another Papertie, on data of its own unless `userData` names a quit one's. */
  launch(o?: LaunchOptions): Promise<Running>
  /** Quit `running`, its writes finished; its data folder stays for a launch on it. */
  quit(running: Running): Promise<void>
}

interface Wire {
  status: number
  headers: Record<string, string>
  body: string
}

type WirePart = string | { name: string; mimeType: string; base64: string }

function apiOf(app: ElectronApplication): Api {
  const ask = async (method: string, path: string, init: ApiInit = {}): Promise<ApiResponse> => {
    const parts: Record<string, WirePart> | null = init.multipart
      ? Object.fromEntries(
          Object.entries(init.multipart).map(([k, v]): [string, WirePart] => [
            k,
            typeof v === 'string'
              ? v
              : { name: v.name, mimeType: v.mimeType, base64: v.buffer.toString('base64') },
          ]),
        )
      : null
    const wire: Wire = await app.evaluate(
      async ({ net }, a) => {
        const headers = new Headers(a.headers)
        let body: string | FormData | undefined
        if (a.parts) {
          const form = new FormData()
          for (const [k, v] of Object.entries(a.parts)) {
            if (typeof v === 'string') form.set(k, v)
            else {
              const bytes = Buffer.from(v.base64, 'base64')
              form.set(k, new Blob([bytes], { type: v.mimeType }), v.name)
            }
          }
          body = form
        } else if (a.json !== null) {
          body = a.json
          if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
        }
        const res = await net.fetch(a.url, { method: a.method, headers, body })
        return {
          status: res.status,
          headers: Object.fromEntries(res.headers.entries()),
          body: Buffer.from(await res.arrayBuffer()).toString('base64'),
        }
      },
      {
        url: `${APP_URL}${path}`,
        method,
        headers: init.headers ?? {},
        json: init.data === undefined ? null : JSON.stringify(init.data),
        parts,
      },
    )
    const bytes = Buffer.from(wire.body, 'base64')
    return {
      status: () => wire.status,
      ok: () => wire.status >= 200 && wire.status < 300,
      headers: () => wire.headers,
      text: async () => bytes.toString('utf8'),
      json: async () => JSON.parse(bytes.toString('utf8')) as unknown,
      body: async () => bytes,
    }
  }
  return {
    get: (path, init) => ask('GET', path, init),
    post: (path, init) => ask('POST', path, init),
    put: (path, init) => ask('PUT', path, init),
    delete: (path, init) => ask('DELETE', path, init),
  }
}

const runs = new WeakMap<Page, Running>()

/** The Papertie whose window `page` is. */
export function runningFor(page: Page): Running {
  const running = runs.get(page)
  if (!running) throw new Error('not a window of a launched Papertie')
  return running
}

/** The routes of the Papertie whose window `page` is. */
export const apiFor = (page: Page): Api => runningFor(page).api

/**
 * The file `start` makes the app download (an export): its name and bytes. The app would ask
 * where to save it; here it goes to a folder of the test's, with no dialog.
 */
export async function download(
  page: Page,
  start: () => Promise<unknown>,
): Promise<{ name: string; bytes: Buffer }> {
  const { app } = runningFor(page)
  const dir = mkdtempSync(join(tmpdir(), 'papertie-e2e-download-'))
  try {
    await app.evaluate(({ session }, dir) => {
      const g = globalThis as { __download?: Promise<{ name: string; path: string }> }
      g.__download = new Promise((resolve, reject) => {
        session.defaultSession.once('will-download', (_event, item) => {
          const name = item.getFilename()
          const path = `${dir}/${name}`
          item.setSavePath(path)
          item.once('done', (_e, state) =>
            state === 'completed' ? resolve({ name, path }) : reject(new Error(state)),
          )
        })
      })
    }, dir)
    await start()
    const { name, path } = (await app.evaluate(
      () => (globalThis as { __download?: Promise<{ name: string; path: string }> }).__download,
    )) as { name: string; path: string }
    return { name, bytes: readFileSync(path) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** A {@link Desktop}, and its end: every Papertie it launched quit, the data folders it made removed. */
function newDesktop(): { desktop: Desktop; end(): Promise<void> } {
  const live = new Set<Running>()
  const dirs: Array<() => void> = []
  let first: Promise<Running> | null = null
  const start = async (o: LaunchOptions = {}): Promise<Running> => {
    let userData = o.userData
    if (userData === undefined) {
      const fresh = freshUserData()
      dirs.push(fresh.dispose)
      userData = fresh.dir
    }
    const { app, page, errors } = await launch(userData, o.args)
    await page.setViewportSize(o.viewport ?? VIEWPORT)
    const running: Running = { app, page, api: apiOf(app), userData, errors }
    runs.set(page, running)
    live.add(running)
    return running
  }
  const quit = async (running: Running) => {
    if (!live.delete(running)) return
    await running.app.close()
  }
  return {
    desktop: {
      main: () => {
        first ??= start()
        return first
      },
      launch: start,
      quit,
    },
    end: async () => {
      for (const running of [...live]) await quit(running).catch(() => {})
      for (const dispose of dirs) dispose()
    },
  }
}

/**
 * A {@link Desktop} for tests that share one Papertie (a `serial` describe): made in its
 * `beforeAll`, ended in its `afterAll`. A test's own is the `desktop` fixture.
 */
export const sharedDesktop = newDesktop

export const test = base.extend<{ desktop: Desktop; page: Page; api: Api }>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright reads a fixture's needs from this pattern.
  desktop: async ({}, use) => {
    const { desktop, end } = newDesktop()
    await use(desktop)
    await end()
  },
  page: async ({ desktop }, use) => {
    await use((await desktop.main()).page)
  },
  api: async ({ desktop }, use) => {
    await use((await desktop.main()).api)
  },
})

export { expect }
