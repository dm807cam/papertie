/**
 * The book export's bench row, run in the final perf pass only (the timing
 * project, a file at a time): the 200,000-word book exported as docx, its zip read to the end,
 * holds no event-loop iteration over 50 ms on a CPU `PI`× slower (a Raspberry Pi included).
 * `bookExport.test.ts` keeps the untimed proof (the export takes more than one slice).
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emptyBoardState, newId, stateFromRecords } from '@papertie/core'
import { describe, expect, it } from 'vitest'
import { exportBook } from '../src/export/bookExport'
import { serverId } from '../src/ids'
import { createLogger } from '../src/log'
import { zipBody } from '../src/routes/export'
import { genBookRecords } from './helpers/books'
import { PI, turns } from './helpers/turns'

const T0 = '2026-11-13T10:00:00.000Z'

describe('book export timing', () => {
  it('export of the 200,000-word book as docx: no event-loop block over 50 ms (a Raspberry Pi included)', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'papertie-book-export-timing-'))
    try {
      const empty = emptyBoardState(newId('board'), 'B', T0)
      const g = genBookRecords(5, 200_000, { title: 'Long' })
      const state = stateFromRecords(empty.board, [g.book, ...g.blocks])
      const log = createLogger(() => {})
      const deps = {
        dataDir,
        userId: serverId('user'),
        boardId: state.board.id,
        log,
        now: new Date(T0),
      }
      const t = await turns(async () => {
        const r = await exportBook(state, g.book.id, 'docx', deps)
        if (!r) throw new Error('no export')
        let bytes = 0
        const reader = zipBody(r.entries, deps.now, log).getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          bytes += value.length
        }
        return bytes
      })
      expect(t.result).toBeGreaterThan(0)
      expect(t.maxScaledMs, JSON.stringify(t.worst)).toBeLessThanOrEqual(50)
      expect(t.pi).toBe(PI)
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })
})
