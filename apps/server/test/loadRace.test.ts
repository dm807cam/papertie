import { renameSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serializeBoard } from '@papertie/core'
import { afterEach, describe, expect, it } from 'vitest'
import { serverId } from '../src/ids'
import { createLogger } from '../src/log'
import { BoardStore } from '../src/store/boardStore'
import { slicedCpuMs, yieldTurn } from '../src/store/compact'
import { noFaults } from '../src/store/faults'
import { hugeState } from './helpers/boards'
import { FakeClock } from './helpers/clock'

/**
 * A cold load takes seconds on a Raspberry Pi, in slices: `board.jsonl` edited meanwhile (by hand, a sync
 * tool) must not be taken for the file the load read. Otherwise the
 * handle keeps the old state under the new file's stamp, no check ever sees the edit, and the next
 * compaction renames over it.
 */

let dataDir: string | null = null
afterEach(async () => {
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
  dataDir = null
})

describe('a board edited while it loads', () => {
  it('the edit is seen, not overwritten', async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'papertie-load-race-'))
    const opts = {
      dataDir,
      clock: new FakeClock(),
      log: createLogger(() => {}),
      faults: noFaults,
      cacheSize: 4,
      idleEvictMs: 600_000,
      ringCommits: 64,
      ringBytes: 1_048_576,
      maxBoardsPerUser: 5,
      compactIdleMs: 3_600_000,
      compactEveryHour: false,
    }
    const user = serverId('user')
    let store = new BoardStore(opts)
    const { id } = await store.createBoard(user, 'Board')
    await store.close()
    const file = join(dataDir, 'users', user, 'boards', id, 'board.jsonl')
    // Big enough that the load runs over many slices.
    await writeFile(file, serializeBoard(hugeState(id, 20_000)))
    const edited = serializeBoard(hugeState(id, 7))

    store = new BoardStore(opts)
    const sliced = slicedCpuMs()
    const reading = store.read(user, id)
    // Once the load is parsing (its bytes read), the file is replaced, as an editor saves it.
    while (slicedCpuMs() === sliced) await yieldTurn()
    writeFileSync(`${file}.edit`, edited)
    renameSync(`${file}.edit`, file)
    await reading
    // The board is the edited file now (loaded through recovery as an edit made while cached).
    const after = await store.read(user, id)
    expect(after.state.notes.size).toBe(7)
    await store.compact(user, id)
    await store.close()
    store = new BoardStore(opts)
    expect((await store.read(user, id)).state.notes.size).toBe(7)
    await store.close()
  }, 60_000)
})
