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
    // Each slice's CPU is a timing row's (`journalSliced.timing.test.ts`).
    expect(got).toEqual(parseJournal(buf))
  }, 60_000)

  it('the same lines, damage and torn tail as parseJournal, however the bytes run', async () => {
    const good = journalOf(40, 30)
    const nl = good.indexOf(0x0a, 500)
    const variants = [
      good,
      Buffer.concat([good, Buffer.from('{"rev":41,"ops"')]),
      Buffer.concat([good.subarray(0, nl), Buffer.from([0xe7, 0xb5]), good.subarray(nl)]),
      Buffer.concat([Buffer.from('\n\n'), good, Buffer.from('not json\n')]),
      Buffer.from(''),
      Buffer.from('torn'),
    ]
    for (const buf of variants) {
      const s = await Slicer.start(SLICE_MS)
      expect(await parseJournalSliced(buf, s, 7)).toEqual(parseJournal(buf))
    }
  })
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
  })
})
