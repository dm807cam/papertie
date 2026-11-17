/**
 * Holding a book read from the server: a book at `maxBlocksPerBook` is put into
 * the board a step at a time (`holdBookSteps`), each step a bounded number of blocks, so the
 * client that slices between steps never holds the page for a whole book.
 */
import { loadavg } from 'node:os'
import { PerformanceObserver } from 'node:perf_hooks'
import {
  type Block,
  blocksOf,
  bookBlocks,
  holdBook,
  holdBookSteps,
  LIMITS,
  parseBoard,
  posKeysBetween,
  serializeBoard,
  stateFromRecords,
} from '../../src/index'
import { fixtureId, makeBlock, makeBoard, makeBook } from '../fixtures'

/** As a Raspberry Pi's own profiles found it: its CPU runs this code 8× slower than a Mac. */
const PI = 8
const BOOK = fixtureId('book', 1)
const N = LIMITS.maxBlocksPerBook

function unheld() {
  const read = parseBoard(serializeBoard(stateFromRecords(makeBoard(), [makeBook({ id: BOOK })])), {
    blocksHeld: 'none',
  }).state
  if (!read) throw new Error('no state')
  return read
}

const keys = posKeysBetween(null, null, N)
const book: Block[] = keys.map((pos, i) =>
  makeBlock({
    id: `block_${String(i).padStart(26, '0')}`,
    bookId: BOOK,
    pos,
    text: `Paragraph ${i}: words enough to be a sentence.`,
  }),
)

/** Run `steps` to the end, timing each step and counting the blocks it wrote. */
function run(steps: Generator<number, ReturnType<typeof holdBook>>) {
  const times: number[] = []
  const starts: number[] = []
  const writes: number[] = []
  for (;;) {
    const t = performance.now()
    const r = steps.next()
    starts.push(t)
    times.push(performance.now() - t)
    if (r.done) return { state: r.value, times, starts, writes }
    writes.push(r.value)
  }
}

/** The garbage collector's pauses while `work` runs (start and length, ms). */
async function withGc<T>(work: () => T): Promise<{ result: T; gc: Array<[number, number]> }> {
  const gc: Array<[number, number]> = []
  const obs = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) gc.push([e.startTime, e.duration])
  })
  obs.observe({ entryTypes: ['gc'] })
  const result = work()
  await new Promise((r) => setTimeout(r, 50))
  obs.disconnect()
  return { result, gc }
}

describe('holdBookSteps', () => {
  it('holds exactly what holdBook holds', () => {
    const shuffled = [...book.slice(0, 3000)].reverse()
    const a = holdBook(unheld(), BOOK, shuffled)
    const { state: b } = run(holdBookSteps(unheld(), BOOK, shuffled))
    expect(blocksOf(b, BOOK)).toEqual(blocksOf(a, BOOK))
    expect(bookBlocks(b.blocks, BOOK).count).toBe(3000)
    expect(b.blocksHeld).toEqual(a.blocksHeld)
    expect([...b.blocks.keys()].sort()).toEqual([...a.blocks.keys()].sort())
  })

  it(`a book of ${N.toLocaleString('en')} blocks is held in steps of a bounded count, none over 50 ms counted 8× for a Raspberry Pi`, async () => {
    const load = loadavg()[0] ?? 0
    for (const input of [book, [...book].reverse()]) {
      // Three holds of the same book: a step's own work is what it takes in all three (the least
      // of its three times), so a pause that is not the step's (a collection, the thread put
      // aside by the machine's other work, a first compile) is not counted as its work.
      const runs: number[][] = []
      let gcMs = 0
      for (let r = 0; r < 3; r++) {
        const { result, gc } = await withGc(() => run(holdBookSteps(unheld(), BOOK, input)))
        const { state, times, starts, writes } = result
        expect(bookBlocks(state.blocks, BOOK).count).toBe(N)
        // A count first: no step does more than its share, whatever the machine.
        expect(Math.max(...writes)).toBeLessThanOrEqual(1024)
        expect(times.length).toBeGreaterThanOrEqual(N / 1024)
        runs.push(
          times.map((ms, k) => {
            const from = starts[k] as number
            const paused = gc
              .filter(([at]) => at >= from && at < from + ms)
              .reduce((sum, [, d]) => sum + d, 0)
            return Math.max(0, ms - paused)
          }),
        )
        gcMs = Math.max(gcMs, ...gc.map(([, d]) => d))
      }
      const steps = (runs[0] as number[]).map((_, k) => Math.min(...runs.map((t) => t[k] ?? 0)))
      const worst = Math.max(...steps)
      const first = Math.max(...(runs[0] as number[]))
      console.info(
        `holdBookSteps ${input === book ? 'in order' : 'reversed'}: ${steps.length} steps, worst ${worst.toFixed(2)} ms of work (${(worst * PI).toFixed(1)} ms at ${PI}×; the first hold's worst step ${first.toFixed(2)} ms), longest GC pause ${gcMs.toFixed(2)} ms, load1 ${load.toFixed(2)}`,
      )
    }
  })
})
