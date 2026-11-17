/**
 * The app behind a port (`serverMain.ts`) in its own process, for crash and corruption tests that
 * SIGKILL it or restart it on the same data dir (`PAPERTIE_DATA`). The bound port is parsed from its `listening` log line.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVER_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const MAIN = join(SERVER_ROOT, 'test/crash/serverMain.ts')
const START_TIMEOUT_MS = 30_000

export interface ServerChild {
  url: string
  dataDir: string
  port: number
  /** Every stdout line (the server's JSON log lines) so far. */
  readonly logs: string[]
  /** Resolves with the signal that ended the child (null for a normal exit). */
  exited: Promise<NodeJS.Signals | null>
  /** SIGKILL. */
  kill(): void
  /** SIGTERM (graceful close) and wait for the exit. */
  stop(): Promise<void>
}

/** The data dir's one user (`local-user.json`): the same across restarts. */
export interface User {
  id: string
}

export async function spawnServer(
  dataDir: string,
  opts: { fault?: string } = {},
): Promise<ServerChild> {
  const env: NodeJS.ProcessEnv = { ...process.env, PAPERTIE_DATA: dataDir }
  delete env.PAPERTIE_FAULT
  if (opts.fault) env.PAPERTIE_FAULT = opts.fault
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', MAIN], {
    cwd: SERVER_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const logs: string[] = []
  const errors: string[] = []
  const exited = new Promise<NodeJS.Signals | null>((resolve) => {
    child.on('exit', (_code, signal) => resolve(signal))
  })
  const port = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('server child did not listen')),
      START_TIMEOUT_MS,
    )
    let out = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      out += chunk
      for (let nl = out.indexOf('\n'); nl >= 0; nl = out.indexOf('\n')) {
        const line = out.slice(0, nl)
        out = out.slice(nl + 1)
        if (!line) continue
        logs.push(line)
        try {
          const entry = JSON.parse(line) as { msg?: string; port?: number }
          if (entry.msg === 'listening' && typeof entry.port === 'number') {
            clearTimeout(timer)
            resolve(entry.port)
          }
        } catch {
          // not a log line; kept in `logs` for the assertions to see
        }
      }
    })
    void exited.then((signal) => {
      clearTimeout(timer)
      reject(new Error(`server child exited (${signal}) before listening: ${errors.join('')}`))
    })
  })
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => errors.push(chunk))

  const p = await port
  return {
    url: `http://127.0.0.1:${p}`,
    dataDir,
    port: p,
    logs,
    exited,
    kill: () => {
      child.kill('SIGKILL')
    },
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      await exited
    },
  }
}

/** `fetch` against the child with its Origin (and a JSON content type for string bodies). */
export function call(server: ServerChild, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Origin', server.url)
  if (typeof init.body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }
  return fetch(`${server.url}${path}`, { redirect: 'manual', ...init, headers })
}

const post = (server: ServerChild, path: string, body: unknown) =>
  call(server, path, { method: 'POST', body: JSON.stringify(body) })

/** The data dir's one user, as the child wrote it at its start (`local-user.json`). */
export async function createUser(server: ServerChild): Promise<User> {
  const file = await readFile(join(server.dataDir, 'local-user.json'), 'utf8')
  return { id: (JSON.parse(file) as { id: string }).id }
}

export async function createBoard(
  server: ServerChild,
  _user: User,
  name = 'Board',
): Promise<string> {
  const res = await post(server, '/api/boards', { name })
  if (res.status !== 201) throw new Error(`create board failed: ${res.status}`)
  return ((await res.json()) as { id: string }).id
}

export function postOps(server: ServerChild, _user: User, boardId: string, body: unknown) {
  return post(server, `/api/boards/${boardId}/ops`, body)
}

export function getBoard(server: ServerChild, _user: User, boardId: string) {
  return call(server, `/api/boards/${boardId}`)
}

export const boardDirOf = (dataDir: string, user: User, boardId: string) =>
  join(dataDir, 'users', user.id, 'boards', boardId)

/** Every path under `root` (relative), recursively. */
export async function walk(root: string, rel = ''): Promise<string[]> {
  const out: string[] = []
  for (const e of await readdir(join(root, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name
    out.push(p)
    if (e.isDirectory()) out.push(...(await walk(root, p)))
  }
  return out.sort()
}
