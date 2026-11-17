import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { loadavg, tmpdir } from 'node:os'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { createInterface } from 'node:readline'
import { type Block, type Book, newId, posKeysBetween, serializeBoard } from '@papertie/core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  LOAD_SLICE_MS,
  longestSliceCpuMs,
  resetLongestSlice,
  stretchSlices,
} from '../src/store/compact'
import {
  boardDir,
  boardFile,
  createBoard,
  hugeState,
  noteCreate,
  postOps,
  tabNow,
} from './helpers/boards'
import { blockCreate, blockRecord, edit, ins, libraryState } from './helpers/books'
import type { TestUser } from './helpers/client'
import { FakeClock } from './helpers/clock'
import { startTestServer, type TestServer } from './helpers/harness'
import { oldGenAllocated } from './helpers/heap'
import { PI, turnLine, turns } from './helpers/turns'
import { readZip } from './helpers/zip'

/**
 * The server's cold load of a 100,000-note board, as a Raspberry Pi's bench row sees it.
 * A Raspberry Pi's CPU is about 5× slower than this Mac: there a load in one piece held the loop for
 * about 4.7 s (c78a629). The timing project runs these rows, a file at a time
 * (`vitest.config.ts`); `coldLoad.test.ts` keeps their untimed proofs (what loads, what is served).
 */

const T0 = '2026-10-27T10:00:00.000Z'
const NOTES = 100_000
/** The ops limit: a batch of this many is one journal commit. */
const BATCH = 500

/** On AC power (always true off macOS, where the gate is load only). */
function onAC(): boolean {
  if (process.platform !== 'darwin') return true
  try {
    return execFileSync('pmset', ['-g', 'ps'], { encoding: 'utf8' }).includes("'AC Power'")
  } catch {
    return false
  }
}

let dataDir: string
let clock: FakeClock
let user: TestUser
let board: string

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'papertie-coldload-'))
  clock = new FakeClock(T0)
  const server = await startTestServer({ clock, dataDir })
  try {
    user = server.user
    board = await createBoard(user)
  } finally {
    await server.close()
  }
  // 98,990 notes in board.jsonl (written as the server writes it), and in the journal ten more one
  // by one, then two batches at the ops limit as a client's large paste or the bench's seed sends
  // them (500 notes, then 500 threads through them): the load parses the snapshot and replays the
  // journal over it. One such commit replayed whole held a Raspberry Pi's loop for 145 ms.
  await unlink(join(boardDir({ dataDir } as TestServer, user.id, board), 'journal.jsonl')).catch(
    () => {},
  )
  await writeFile(
    boardFile({ dataDir } as TestServer, user.id, board),
    serializeBoard(hugeState(board, NOTES - 10 - BATCH)),
  )
  const again = await startTestServer({ clock, dataDir })
  try {
    const clientId = tabNow(again)
    let revision = 0
    for (let seq = 1; seq <= 10; seq++) {
      const res = await postOps({ ...user, request: requestOn(again) }, board, {
        clientId,
        seq,
        baseRevision: revision,
        ops: [noteCreate({ at: T0 })],
      })
      expect(res.status).toBe(200)
      revision = ((await res.json()) as { revision: number }).revision
    }
    const notes = Array.from({ length: BATCH }, (_, i) =>
      noteCreate({ at: T0, text: `pasted ${i}: ${'Kết thread and cork '.repeat(4)}` }),
    )
    const ids = notes.map((n) => n.note.id)
    const yarns = ids.map((id, i) => ({
      op: 'yarn.create',
      yarn: {
        type: 'yarn',
        id: newId('yarn'),
        noteIds: [id, ids[(i + 1) % BATCH], ids[(i + 7) % BATCH]],
        color: 'apricot',
        label: `pasted thread ${i}`,
        createdAt: T0,
        updatedAt: T0,
      },
    }))
    for (const [seq, ops] of [
      [11, notes],
      [12, yarns],
    ] as const) {
      const res = await postOps({ ...user, request: requestOn(again) }, board, {
        clientId,
        seq,
        baseRevision: revision,
        ops,
      })
      expect(res.status).toBe(200)
      revision = ((await res.json()) as { revision: number }).revision
    }
  } finally {
    await again.close()
  }
}, 300_000)

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

/** The user's requests against `server` (its own origin: a restart binds a new port). */
const requestOn =
  (server: TestServer) =>
  (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers)
    headers.set('Origin', server.url)
    if (init.body !== undefined) headers.set('Content-Type', 'application/json')
    return fetch(`${server.url}${path}`, { ...init, headers })
  }

/**
 * `GET url` every 10 ms from a process of its own, as a client on the LAN would (the bench's probe):
 * the longest a probe waited is how long the server's loop was held, plus a round trip.
 */
async function healthProbe(url: string) {
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
      let stop = false, max = 0, n = 0
      process.stdin.on('data', () => { stop = true })
      for (let due = performance.now(); !stop; due = Math.max(due + 10, performance.now())) {
        const early = due - performance.now()
        if (early > 0) await new Promise((r) => setTimeout(r, early))
        await (await fetch(process.argv[1])).arrayBuffer()
        // The first is the connection's (and a fresh server's first answer): not counted.
        if (n++ > 0) max = Math.max(max, performance.now() - due)
        else process.stdout.write('ready\\n')
      }
      process.stdout.write(JSON.stringify({ max, n }) + '\\n')
      `,
      url,
    ],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  )
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  if ((await lines.next()).value !== 'ready') throw new Error('the probe did not start')
  return {
    async stop(): Promise<{ probeMaxMs: number; probes: number }> {
      child.stdin.write('stop\n')
      const { max, n } = JSON.parse((await lines.next()).value as string) as {
        max: number
        n: number
      }
      child.stdin.end()
      return { probeMaxMs: max, probes: n - 1 }
    },
  }
}

/**
 * A cold load: the server started afresh on the data, then `GET /meta` (which loads the board),
 * with the health probe beside it, the loop's delay, and each iteration's CPU time split into the
 * slices' and the rest.
 */
async function coldLoad({ stretched = false, pi = PI, boardId = board } = {}) {
  // The setup's garbage (a 100,000-note board serialized here) collected first, so a pause for it
  // is not taken for the load's; the load's own collections are counted where they land.
  globalThis.gc?.()
  const server = await startTestServer({ clock, dataDir })
  try {
    const request = requestOn(server)
    const delay = monitorEventLoopDelay({ resolution: 1 })
    const loadBefore = loadavg()[0] ?? 0
    const probe = await healthProbe(`${server.url}/api/health`)
    resetLongestSlice()
    delay.enable()
    const t0 = performance.now()
    const t = await turns(() => request(`/api/boards/${boardId}/meta`), { stretched, pi })
    const res = t.result
    const loadMs = performance.now() - t0
    delay.disable()
    const { probeMaxMs, probes } = await probe.stop()
    const meta = (await res.json()) as { revision: number }
    const load1 = Math.max(loadBefore, loadavg()[0] ?? 0)
    const read = await server.deps.store?.read(user.id, boardId)
    const notes = read?.state.notes.size
    const blocks = read?.state.blocks.size
    return {
      status: res.status,
      revision: meta.revision,
      notes,
      blocks,
      loadMs,
      probeMaxMs,
      probes,
      wallMaxMs: delay.max / 1e6,
      maxCpuMs: t.maxCpuMs,
      maxScaledMs: t.maxScaledMs,
      turns: t,
      longestSliceCpuMs: longestSliceCpuMs(),
      load1,
      quiet: load1 < 4 && onAC(),
    }
  } finally {
    await server.close()
  }
}

/** The stretched run's factor: 5× (its per-slice bound holds on a loaded Mac). */
const STRETCH = 5

const line = (what: string, r: Awaited<ReturnType<typeof coldLoad>>) =>
  `${what}: ${r.loadMs.toFixed(0)} ms; health probe waited ${r.probeMaxMs.toFixed(1)} ms at most ` +
  `(${r.probes} probes), loop delay max ${r.wallMaxMs.toFixed(1)} ms, ${turnLine(r.turns)}, ` +
  `longest slice ${r.longestSliceCpuMs.toFixed(1)} ms CPU; ` +
  `load1 ${r.load1.toFixed(2)}, ${onAC() ? 'AC' : 'battery'}` +
  `${r.quiet ? '' : ' (not a quiet run)'}`

/** Not a quiet run: the checks that read wall time, or count the rest 8×, are not made. */
const notQuiet = (r: Awaited<ReturnType<typeof coldLoad>>) =>
  `not a quiet run (load1 ${r.load1.toFixed(2)}, ${onAC() ? 'AC' : 'battery'}): only the per-slice ` +
  'CPU bound and the iteration CPU bound were asserted'

describe('cold load at 100,000 notes', () => {
  it('a cold load never holds the event loop for more than 50 ms', async (ctx) => {
    const r = await coldLoad()
    console.info(line('cold load of 100,000 notes', r))
    expect(r.status).toBe(200)
    expect(r.revision).toBe(12)
    expect(r.notes).toBe(NOTES)
    // Asserted on every run: each slice's own CPU time (it ends at its wall budget, so load cannot
    // push it over) and each iteration's.
    expect(r.longestSliceCpuMs).toBeLessThanOrEqual(2 * LOAD_SLICE_MS)
    expect(r.maxCpuMs).toBeLessThanOrEqual(50)
    if (!r.quiet) ctx.skip(notQuiet(r))
    expect(r.probeMaxMs).toBeLessThanOrEqual(50)
    expect(r.wallMaxMs).toBeLessThanOrEqual(50)
    // As a Raspberry Pi runs it (8× slower; `turns`): each slice its work 8× but at most its
    // budget plus its longest indivisible step 8×, the rest and every GC pause 8×. One journal
    // commit replayed whole (a 500-op batch, 17 ms here) was 145 ms there.
    expect(r.maxScaledMs).toBeLessThanOrEqual(50)
  }, 300_000)

  it(`on a CPU ${STRETCH}× slower too: every slice's work stretched ${STRETCH}×, the rest counted ${STRETCH}×`, async (ctx) => {
    stretchSlices(STRETCH)
    let r: Awaited<ReturnType<typeof coldLoad>>
    try {
      r = await coldLoad({ stretched: true, pi: STRETCH })
    } finally {
      stretchSlices(1)
    }
    console.info(line(`cold load of 100,000 notes, slices stretched ${STRETCH}×`, r))
    expect(r.status).toBe(200)
    expect(r.notes).toBe(NOTES)
    // A stretched slice is its 8 ms budget and the step it ends in, 5× as long. The longest steps
    // on a Mac are a young-generation collection that lands inside one (1–2.5 ms: a piece's
    // decode or a batch's indexing that allocated past the nursery), stretched to 5–12 ms: 13–21 ms
    // in all. Half of an iteration's 50 ms is the bound. (Stretched 8×, a Raspberry Pi's factor, this
    // reading is the machine's load more than the code's: the 8× bound is the unstretched test's,
    // which counts each slice's longest indivisible step 8×.)
    expect(r.longestSliceCpuMs).toBeLessThanOrEqual(25)
    expect(r.maxCpuMs).toBeLessThanOrEqual(50)
    // What is not sliced is counted 5×, and a loaded machine's slower cores inflate it: the
    // count for a slower CPU is a quiet run's.
    if (!r.quiet) ctx.skip(notQuiet(r))
    expect(r.maxScaledMs).toBeLessThanOrEqual(50)
    expect(r.probeMaxMs).toBeLessThanOrEqual(50)
  }, 300_000)
})

/**
 * `GET url` with the user's cookie from a process of its own, the body counted as it comes (and
 * written to `saveTo` when given): the client's own work (an HTTP parse of 43 MB) stays out of
 * this process's iterations.
 */
async function readElsewhere(url: string, headers: Record<string, string>, saveTo?: string) {
  // Spawned before the timed window and started from it: a spawn is a few ms of this process's
  // CPU (up to 7 here), which is the test's, not the server's.
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
      import { createWriteStream } from 'node:fs'
      process.stdout.write('ready\\n')
      await new Promise((r) => process.stdin.once('data', r))
      const res = await fetch(process.argv[1], { headers: JSON.parse(process.argv[2]) })
      const out = process.argv[3] ? createWriteStream(process.argv[3]) : null
      let bytes = 0
      for await (const chunk of res.body) {
        bytes += chunk.length
        if (out && !out.write(chunk)) await new Promise((r) => out.once('drain', r))
      }
      if (out) await new Promise((r) => out.end(r))
      const length = res.headers.get('content-length')
      process.stdout.write(JSON.stringify({ status: res.status, bytes, length }) + '\\n')
      process.exit(0)
      `,
      url,
      JSON.stringify(headers),
      saveTo ?? '',
    ],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  )
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
  if ((await lines.next()).value !== 'ready') throw new Error('the reader did not start')
  return {
    async read() {
      try {
        child.stdin.write('go\n')
        const line = (await lines.next()).value as string
        return JSON.parse(line) as { status: number; bytes: number; length: string | null }
      } finally {
        child.kill()
      }
    },
  }
}

/**
 * A whole-board answer once the board is loaded (`GET /:id`, a page's full load, or an
 * export): each iteration's CPU time while the server serializes the board and sends it, split as
 * in `coldLoad`, and what it put into the old generation.
 */
async function wholeRead(path: string, saveTo?: string) {
  const server = await startTestServer({ clock, dataDir })
  try {
    expect((await requestOn(server)(`/api/boards/${board}/meta`)).status).toBe(200)
    // The load's garbage collected first, outside the timed window.
    globalThis.gc?.()
    const loadBefore = loadavg()[0] ?? 0
    const headers = { Origin: server.url }
    const reader = await readElsewhere(`${server.url}${path}`, headers, saveTo)
    const t = await turns(() => oldGenAllocated(() => reader.read(), { collected: true }))
    const read = t.result.result
    const oldGenMb = t.result.mb
    const { maxCpuMs, maxScaledMs } = t
    const load1 = Math.max(loadBefore, loadavg()[0] ?? 0)
    return { ...read, oldGenMb, maxCpuMs, maxScaledMs, turns: t, load1, quiet: load1 < 4 && onAC() }
  } finally {
    await server.close()
  }
}

const readLine = (what: string, r: Awaited<ReturnType<typeof wholeRead>>) =>
  `${what}: ${r.bytes} bytes; ${turnLine(r.turns)}, ${r.oldGenMb.toFixed(1)} MB into ` +
  `the old generation; load1 ${r.load1.toFixed(2)}, ${onAC() ? 'AC' : 'battery'}` +
  `${r.quiet ? '' : ' (not a quiet run)'}`

/** Not a quiet run: the bound that counts the rest 8× is not checked. */
const readNotQuiet = (r: Awaited<ReturnType<typeof wholeRead>>) =>
  `not a quiet run (load1 ${r.load1.toFixed(2)}, ${onAC() ? 'AC' : 'battery'}): only the ` +
  'iteration CPU bound and the old-generation bound were asserted'

describe('whole-board answers at 100,000 notes', () => {
  it(`GET /:id never holds the loop for more than 50 ms on a CPU ${PI}× slower, nor fills the old generation`, async (ctx) => {
    const r = await wholeRead(`/api/boards/${board}`)
    console.info(readLine('whole-board read of 100,000 notes', r))
    expect(r.status).toBe(200)
    expect(r.bytes).toBeGreaterThan(40_000_000)
    // Its exact size is known: a client can show the load's progress.
    expect(r.length).toBe(String(r.bytes))
    // The text was joined into one string and encoded whole (27–37 ms in one iteration on the
    // Mac, about 250 ms on a Raspberry Pi) and filled the old generation with 64 MB of it: now the
    // serialization's buffers are streamed as they are.
    expect(r.oldGenMb).toBeLessThanOrEqual(8)
    expect(r.maxCpuMs).toBeLessThanOrEqual(50)
    if (!r.quiet) ctx.skip(readNotQuiet(r))
    expect(r.maxScaledMs).toBeLessThanOrEqual(50)
  }, 300_000)

  it('the jsonl export: the same bounds, with its size', async (ctx) => {
    const r = await wholeRead(`/api/boards/${board}/export?format=jsonl`)
    console.info(readLine('jsonl export of 100,000 notes', r))
    expect(r.status).toBe(200)
    expect(r.bytes).toBeGreaterThan(40_000_000)
    expect(r.length).toBe(String(r.bytes))
    expect(r.oldGenMb).toBeLessThanOrEqual(8)
    expect(r.maxCpuMs).toBeLessThanOrEqual(50)
    if (!r.quiet) ctx.skip(readNotQuiet(r))
    expect(r.maxScaledMs).toBeLessThanOrEqual(50)
  }, 300_000)

  it(`the .papertie export: the same bounds, and its board.jsonl is the board's, byte for byte`, async (ctx) => {
    const dir = await mkdtemp(join(tmpdir(), 'papertie-zip-'))
    try {
      const zipFile = join(dir, 'export.papertie')
      const r = await wholeRead(`/api/boards/${board}/export?format=papertie`, zipFile)
      console.info(readLine('.papertie export of 100,000 notes', r))
      expect(r.status).toBe(200)
      const whole = join(dir, 'board.jsonl')
      expect((await wholeRead(`/api/boards/${board}`, whole)).status).toBe(200)
      const entry = readZip(await readFile(zipFile)).find((e) => e.name === 'board.jsonl')
      expect(entry?.data.equals(await readFile(whole))).toBe(true)
      // The entry was one 43 MB buffer: copied whole and checksummed by a pure-JS crc32 in one
      // go (about 180 ms on a Mac, 850 ms on a Raspberry Pi). Now it is streamed piece by piece.
      expect(r.oldGenMb).toBeLessThanOrEqual(8)
      expect(r.maxCpuMs).toBeLessThanOrEqual(50)
      if (!r.quiet) ctx.skip(readNotQuiet(r))
      expect(r.maxScaledMs).toBeLessThanOrEqual(50)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 300_000)
})

describe('cold load of the lifetime library', () => {
  let library: string
  let blocks = 0
  beforeAll(async () => {
    const server = await startTestServer({ clock, dataDir })
    try {
      library = await createBoard({ ...user, request: requestOn(server) })
    } finally {
      await server.close()
    }
    await unlink(
      join(boardDir({ dataDir } as TestServer, user.id, library), 'journal.jsonl'),
    ).catch(() => {})
    const state = libraryState(library, NOTES)
    blocks = state.blocks.size
    await writeFile(boardFile({ dataDir } as TestServer, user.id, library), serializeBoard(state))
    // The journal: edits of the big book, as typing sends them, and a batch at the ops limit of
    // new paragraphs (a paste): the replay rebuilds the block log from them.
    const again = await startTestServer({ clock, dataDir })
    try {
      const big = [...state.books.values()].find((b) => b.title === 'Book 0') as Book
      const first = [...state.blocks.values()].find((b) => b.bookId === big.id) as Block
      const clientId = tabNow(again)
      let revision = 0
      const post = async (seq: number, ops: unknown[]) => {
        // Within the ops rate limit (20 a second).
        clock.advance(100)
        const res = await postOps({ ...user, request: requestOn(again) }, library, {
          clientId,
          seq,
          baseRevision: revision,
          ops,
        })
        expect(res.status, await res.clone().text()).toBe(200)
        revision = ((await res.json()) as { revision: number }).revision
      }
      for (let seq = 1; seq <= 20; seq++)
        await post(seq, [edit(big.id, first.id, [ins(0, 'word ')])])
      const keys = posKeysBetween(null, first.pos, BATCH)
      await post(
        21,
        keys.map((k, i) =>
          blockCreate(blockRecord(big.id, k, `pasted ${i}: ${'a line of prose '.repeat(8)}`)),
        ),
      )
      blocks += BATCH
    } finally {
      await again.close()
    }
  }, 300_000)

  it('cold load, compaction and the book stream of the lifetime library keep every slice within budget', async (ctx) => {
    const r = await coldLoad({ boardId: library })
    console.info(line('cold load of the lifetime library and 100,000 notes', r))
    expect(r.status).toBe(200)
    expect(r.notes).toBe(NOTES)
    expect(r.blocks).toBe(blocks)
    expect(r.longestSliceCpuMs).toBeLessThanOrEqual(2 * LOAD_SLICE_MS)
    expect(r.maxCpuMs).toBeLessThanOrEqual(50)
    if (!r.quiet) ctx.skip(notQuiet(r))
    expect(r.maxScaledMs).toBeLessThanOrEqual(50)
  }, 300_000)
})
