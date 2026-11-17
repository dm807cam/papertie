/**
 * Read-side microbenchmark for `PMap` against a native `Map`.
 * `pnpm --filter @papertie/core exec tsx scripts/bench-pmap.ts`. Best of 7 runs per row, in ms;
 * results only count as benchmarks from a quiet machine on AC power, so load1 is printed.
 */
import { loadavg } from 'node:os'
import { newId, PMap, parseBoard, serializeBoard, stateFromRecords } from '../src/index'
import { largestBucket } from '../src/pmap'
import type { Note } from '../src/schema/records'

const T0 = '2026-11-02T10:00:00.000Z'

function best(fn: () => unknown, runs = 7): number {
  let ms = Number.POSITIVE_INFINITY
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    fn()
    ms = Math.min(ms, performance.now() - t0)
  }
  return ms
}

function note(id: string, i: number): Note {
  return {
    type: 'note',
    id,
    x: i % 1000,
    y: Math.floor(i / 1000),
    w: 200,
    h: 120,
    z: i,
    paper: 'cream',
    style: 'rustic',
    text: `note ${i}`,
    image: null,
    createdAt: T0,
    updatedAt: T0,
  }
}

const N = 100_000
// Through JSON, as ids arrive from a parsed board: flat strings, not concatenations.
const ids: string[] = JSON.parse(
  JSON.stringify(Array.from({ length: N }, (_, i) => newId('note', 1_700_000_000_000 + i))),
)
const entries = ids.map((id, i): [string, number] => [id, i])
const native = new Map(entries)
const pmap = PMap.from(entries)
let sink = 0

const rows: Array<[string, number, number]> = []
const row = (name: string, a: () => unknown, b: () => unknown) => {
  for (let i = 0; i < 3; i++) {
    a()
    b()
  }
  rows.push([name, best(a), best(b)])
}

row(
  `get × ${N}`,
  () => {
    for (const id of ids) sink += native.get(id) as number
  },
  () => {
    for (const id of ids) sink += pmap.get(id) as number
  },
)
row(
  `iterate values() × ${N}`,
  () => {
    for (const v of native.values()) sink += v
  },
  () => {
    for (const v of pmap.values()) sink += v
  },
)
row(
  `iterate entries × ${N}`,
  () => {
    for (const [, v] of native) sink += v
  },
  () => {
    for (const [, v] of pmap) sink += v
  },
)
row(
  `from(${N})`,
  () => new Map(entries),
  () => PMap.from(entries),
)
const visible = ids.filter((_, i) => i % 20 === 0)
row(
  `cull-like: ${visible.length} gets`,
  () => {
    for (const id of visible) sink += native.get(id) as number
  },
  () => {
    for (const id of visible) sink += pmap.get(id) as number
  },
)

for (const [name, a, b] of rows) {
  console.info(
    `${name.padEnd(28)} Map ${a.toFixed(2).padStart(7)} ms   PMap ${b.toFixed(2).padStart(7)} ms   ×${(b / a).toFixed(1)}`,
  )
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const head = (n: number) =>
  Array.from({ length: 4 }, (_, i) => CROCKFORD[(n >>> (5 * (3 - i))) & 31]).join('')
const keySets: Array<[string, string[]]> = [
  ['random ids', ids],
  ['same-tail ids', Array.from({ length: N }, (_, i) => `note_${head(i)}${'Z'.repeat(22)}`)],
  ['spaced fixture ids', Array.from({ length: N }, (_, i) => fixtureLike(i * 4096))],
]
function fixtureLike(n: number): string {
  let rest = n
  let tail = ''
  for (let i = 0; i < 26; i++) {
    tail = CROCKFORD[rest % 32] + tail
    rest = Math.floor(rest / 32)
  }
  return `note_${tail}`
}
for (const [name, keys] of keySets) {
  const kv = keys.map((k, i): [string, number] => [k, i])
  const m = PMap.from(kv)
  const from = best(() => PMap.from(kv), 3)
  const get = best(() => {
    for (const k of keys) sink += m.get(k) as number
  })
  let i = 0
  const set = best(() => {
    for (let j = 0; j < 100; j++) m.set(keys[(i++ * 7919) % N] as string, -1)
  })
  console.info(
    `${name.padEnd(20)} from ${from.toFixed(1)} ms   get × ${N} ${get.toFixed(2)} ms   ` +
      `set ${((set / 100) * 1000).toFixed(1)} µs   largest bucket ${largestBucket(m)}`,
  )
}

for (const n of [5_000, N]) {
  const board = stateFromRecords(
    {
      type: 'board',
      schemaVersion: 6,
      id: newId('board'),
      name: 'b',
      revision: 1,
      clients: {},
      createdAt: T0,
      updatedAt: T0,
    },
    ids.slice(0, n).map(note),
  )
  const text = serializeBoard(board)
  parseBoard(text)
  console.info(`parseBoard(${n})${' '.repeat(16)} ${best(() => parseBoard(text), 3).toFixed(1)} ms`)
}
console.info(`load1 ${loadavg()[0]?.toFixed(2)} (sink ${sink > 0})`)
