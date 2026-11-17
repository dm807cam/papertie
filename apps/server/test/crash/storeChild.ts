/**
 * A BoardStore in its own process, driven over stdin/stdout, so crash tests can SIGKILL it at a
 * fault point and restart it on the same data.
 *
 * Child (run as `node --import tsx test/crash/storeChild.ts`): env `PAPERTIE_DATA`,
 * `PAPERTIE_FAULT=<point>@<n>`, and (test-only) `PAPERTIE_TEST_NOW`, the
 * store clock's fixed time. Reads one JSON command per line; writes `{ready: true}` once, then one
 * `{id, ok, result | error}` line per command, only after its promise settled. Logs go to stderr.
 *
 * Parent: `spawnStore` starts a child and resolves once it is ready.
 */
import { type ChildProcess, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { Op } from '@papertie/core'
import type { BoardSummary, CommitAck, SubmitInput } from '../../src/store/boardStore'

export type Command =
  | { cmd: 'create'; userId: string; name?: string }
  | { cmd: 'submit'; userId: string; boardId: string; input: SubmitInput }
  | { cmd: 'server'; userId: string; boardId: string; ops: Op[] }
  | { cmd: 'read'; userId: string; boardId: string }
  | { cmd: 'compact'; userId: string; boardId: string }
  | { cmd: 'restore'; userId: string; boardId: string; file: string }
  /** What a stream resuming from `since` is sent: its commits, or `full` (a `reset`). */
  | { cmd: 'since'; userId: string; boardId: string; since: number }
  /** `sweepAssets` on the board at the store clock's time, with the child's faults. */
  | { cmd: 'sweepAssets'; userId: string; boardId: string }
  /** Test-only: set the store clock. */
  | { cmd: 'clock'; now: string }

export interface ReadResult {
  revision: number
  text: string
  recovered: boolean
  /** The recovery notice's kind, or null without one. */
  integrity: string | null
}

export type Reply =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { code: string } }

export interface StoreChild {
  /** Send one command; resolves with its reply, rejects if the child exits first. */
  send(cmd: Command): Promise<Reply>
  /** Send several commands in ONE stdin write, so the child reads them in the same I/O turn. */
  sendAll(cmds: Command[]): Promise<Reply>[]
  /** Every reply line received so far. */
  readonly replies: Reply[]
  /** Everything the child wrote to stderr (its log lines). */
  readonly stderr: string[]
  /** Resolves with the signal that ended the child (null for a normal exit). */
  exited: Promise<NodeJS.Signals | null>
  /** SIGKILL. */
  kill(): void
  /** End stdin: the child closes its store and exits normally. */
  close(): Promise<void>
}

export const STORE_CHILD = fileURLToPath(import.meta.url)
const SERVER_ROOT = fileURLToPath(new URL('../..', import.meta.url))

export interface SpawnOptions {
  fault?: string
  /** The child's fixed clock (`PAPERTIE_TEST_NOW`). */
  now?: string
}

export function spawnStore(dataDir: string, opts: SpawnOptions = {}): Promise<StoreChild> {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PAPERTIE_DATA: dataDir,
  }
  delete env.PAPERTIE_FAULT
  if (opts.fault) env.PAPERTIE_FAULT = opts.fault
  if (opts.now) env.PAPERTIE_TEST_NOW = opts.now
  const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', STORE_CHILD], {
    cwd: SERVER_ROOT,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const replies: Reply[] = []
  const stderr: string[] = []
  const waiting = new Map<number, { resolve(r: Reply): void; reject(e: Error): void }>()
  let nextId = 1
  let exitedWith: NodeJS.Signals | null | undefined
  let markReady: () => void = () => {}
  let failReady: (e: Error) => void = () => {}
  const ready = new Promise<void>((resolve, reject) => {
    markReady = resolve
    failReady = reject
  })

  const exited = new Promise<NodeJS.Signals | null>((resolve) => {
    child.on('exit', (_code, signal) => {
      exitedWith = signal
      const err = new Error(`store child exited (${signal ?? _code}) before replying`)
      for (const w of waiting.values()) w.reject(err)
      waiting.clear()
      failReady(new Error(`store child exited before ready: ${stderr.join('')}`))
      resolve(signal)
    })
  })

  let out = ''
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    out += chunk
    for (let nl = out.indexOf('\n'); nl >= 0; nl = out.indexOf('\n')) {
      const line = out.slice(0, nl)
      out = out.slice(nl + 1)
      if (!line) continue
      const msg = JSON.parse(line) as Reply | { ready: true }
      if ('ready' in msg) {
        markReady()
        continue
      }
      replies.push(msg)
      waiting.get(msg.id)?.resolve(msg)
      waiting.delete(msg.id)
    }
  })
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => stderr.push(chunk))
  // A write to a child that was just killed fails with EPIPE; its reply promise rejects anyway.
  child.stdin?.on('error', () => {})

  const sendAll = (cmds: Command[]): Promise<Reply>[] => {
    const lines: string[] = []
    const promises = cmds.map((cmd) => {
      const id = nextId++
      lines.push(JSON.stringify({ id, ...cmd }))
      if (exitedWith !== undefined) return Promise.reject(new Error('store child has exited'))
      return new Promise<Reply>((resolve, reject) => waiting.set(id, { resolve, reject }))
    })
    child.stdin?.write(`${lines.join('\n')}\n`)
    return promises
  }

  const handle: StoreChild = {
    send: (cmd) => sendAll([cmd])[0] as Promise<Reply>,
    sendAll,
    replies,
    stderr,
    exited,
    kill: () => {
      child.kill('SIGKILL')
    },
    close: async () => {
      child.stdin?.end()
      await exited
    },
  }
  return ready.then(() => handle)
}

/** The `result` of an `ok` reply; throws with the error code otherwise. */
export function resultOf<T>(r: Reply): T {
  if (!r.ok) throw new Error(`store child replied ${r.error.code}`)
  return r.result as T
}

// ---- child ------------------------------------------------------------------------------------

async function runChild(): Promise<void> {
  const { createInterface } = await import('node:readline')
  const { createLogger } = await import('../../src/log')
  const { QuotaTracker } = await import('../../src/assets/quota')
  const { sweepAssets } = await import('../../src/store/assetSweep')
  const { BoardStore } = await import('../../src/store/boardStore')
  const { StoreError } = await import('../../src/store/errors')
  const { faultsFromEnv } = await import('../../src/store/faults')
  const { FakeClock } = await import('../helpers/clock')

  const env = process.env
  const dataDir = env.PAPERTIE_DATA
  if (!dataDir) throw new Error('PAPERTIE_DATA is required')
  const clock = new FakeClock(env.PAPERTIE_TEST_NOW ?? new Date().toISOString())
  const log = createLogger((line) => process.stderr.write(`${line}\n`))
  const faults = faultsFromEnv(env)
  const quota = new QuotaTracker(dataDir)
  const store = new BoardStore({
    dataDir,
    clock,
    log,
    faults,
    cacheSize: 32,
    idleEvictMs: 600_000,
    ringCommits: 512,
    ringBytes: 16_777_216,
    maxBoardsPerUser: 50,
    // Compaction runs only when a test sends `compact`.
    compactIdleMs: 3_600_000,
    compactEveryHour: false,
  })

  const run = async (c: Command): Promise<unknown> => {
    switch (c.cmd) {
      case 'create':
        return (await store.createBoard(c.userId, c.name ?? 'Crash board')) satisfies BoardSummary
      case 'submit':
        return (await store.submit(c.userId, c.boardId, c.input)) satisfies CommitAck
      case 'server':
        return (await store.submitServer(c.userId, c.boardId, c.ops)) satisfies CommitAck
      case 'read': {
        const v = await store.read(c.userId, c.boardId)
        return {
          revision: v.revision,
          text: v.text,
          recovered: v.recovery !== null,
          integrity: v.recovery?.integrity ?? null,
        } satisfies ReadResult
      }
      case 'compact':
        return await store.compact(c.userId, c.boardId)
      case 'restore':
        return await store.restoreBackup(c.userId, c.boardId, c.file)
      case 'since':
        return await store.since(c.userId, c.boardId, c.since)
      case 'sweepAssets':
        return await sweepAssets(dataDir, c.userId, c.boardId, clock.now(), store, log, {
          quota,
          faults,
        })
      case 'clock':
        clock.set(c.now)
        return { now: clock.now().toISOString() }
    }
  }

  const reply = (r: Reply) => process.stdout.write(`${JSON.stringify(r)}\n`)
  const rl = createInterface({ input: process.stdin })
  // Commands are dispatched as they are read (not one after another), so commands that arrive in
  // one stdin chunk reach the store in the same turn.
  rl.on('line', (line) => {
    if (!line.trim()) return
    const msg = JSON.parse(line) as Command & { id: number }
    run(msg).then(
      (result) => reply({ id: msg.id, ok: true, result }),
      (e: unknown) =>
        reply({
          id: msg.id,
          ok: false,
          error: {
            code: e instanceof StoreError ? e.code : e instanceof Error ? e.name : 'unknown',
          },
        }),
    )
  })
  rl.on('close', () => {
    void store.close().then(() => process.exit(0))
  })
  process.stdout.write(`${JSON.stringify({ ready: true })}\n`)
}

if (process.argv[1] === STORE_CHILD) await runChild()
