/**
 * The sliced journal reads' CPU per slice (`journalSliced.test.ts` keeps their untimed proofs:
 * the same lines and the same board as the whole reads): the timing project runs them, a file
 * at a time (`vitest.config.ts`).
 */
import { commitBatch, emptyBoardState, newId, posKeysBetween, serializeBoard } from '@papertie/core'
import { describe, expect, it } from 'vitest'
import { SLICE_MS, Slicer } from '../src/store/compact'
import {
  encodeCommit,
  parseJournal,
  parseJournalSliced,
  replay,
  replaySliced,
} from '../src/store/journal'
import { blockCreate, blockRecord, bookCreate, bookRecord, edit, ins } from './helpers/books'

/** A journal of `n` one-note commits, `textLength` characters of text each. */
function journalOf(n: number, textLength: number): Buffer {
  const text = 'ễ'.repeat(textLength)
  const lines: string[] = []
  for (let rev = 1; rev <= n; rev++) {
    lines.push(
      encodeCommit({
        rev,
        ops: [{ op: 'note.update', id: newId('note'), set: { text } }],
        now: '2026-10-27T10:00:00.000Z',
        origin: null,
      }),
    )
  }
  return Buffer.from(`${lines.join('\n')}\n`)
}

describe('parseJournalSliced', () => {
  it('a journal far past its 4 MiB limit is decoded and checked in slices, as parseJournal reads it', async () => {
    // About 48 MB: compaction failing for a long while (a full disk) lets a journal grow so.
    const buf = journalOf(16_000, 1000)
    const s = await Slicer.start(SLICE_MS)
    const got = await parseJournalSliced(buf, s)
    s.note()
    console.info(
      `parseJournalSliced, ${(buf.length / 1e6).toFixed(0)} MB: ${s.slices} slices, ` +
        `longest ${s.maxMs.toFixed(1)} ms (${s.maxCpuMs.toFixed(1)} ms CPU)`,
    )
    expect(got).toEqual(parseJournal(buf))
    expect(s.maxCpuMs).toBeLessThanOrEqual(2 * SLICE_MS)
  }, 60_000)
})

describe('replaySliced', () => {
  it('replaySliced replays in slices what replay does, a large commit too', async () => {
    const book = bookRecord()
    const at = '2026-10-27T10:00:00.000Z'
    const base = commitBatch(
      emptyBoardState('board_01JBPR0T0SAMP1E000000BRD01', 'b', at),
      [bookCreate(book)],
      at,
      null,
    )
    const keys = posKeysBetween(null, null, 3_000)
    const lines: string[] = []
    let rev = base.board.revision
    const blocks = keys.map((k, i) => blockRecord(book.id, k, `p${i}`))
    lines.push(encodeCommit({ rev: ++rev, ops: blocks.map(blockCreate), now: at, origin: null }))
    for (const b of blocks.slice(0, 600)) {
      lines.push(
        encodeCommit({
          rev: ++rev,
          ops: [edit(book.id, b.id, [ins(0, 'x')])],
          now: at,
          origin: null,
        }),
      )
    }
    const buf = Buffer.from(`${lines.join('\n')}\n`)
    const want = replay(parseJournal(buf), base)
    const s = await Slicer.start(SLICE_MS)
    const got = await replaySliced(parseJournal(buf), base, s)
    s.note()
    expect(got.applied).toBe(want.applied)
    expect(serializeBoard(got.state)).toBe(serializeBoard(want.state))
    expect(s.maxCpuMs).toBeLessThanOrEqual(2 * SLICE_MS)
  })
})
