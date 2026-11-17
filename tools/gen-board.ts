import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { serializeBoard } from '@papertie/core'
import { BENCH_SIZES, type BenchSize, benchBoard, generateBoard } from './src/genBoard'

const USAGE =
  'usage: gen-board (--size 100|500|1000 | --notes N --yarns M [--seed S]) --out <file.jsonl>'

function fail(message: string): never {
  console.error(`gen-board: ${message}\n${USAGE}`)
  process.exit(2)
}

function int(name: string, raw: string | undefined, min: number): number | undefined {
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min) fail(`--${name} must be an integer >= ${min}`)
  return n
}

/** `pnpm run gen-board -- --size 500` forwards the separator itself; drop it. */
const args = process.argv.slice(2).filter((a, i) => !(i === 0 && a === '--'))

const { values } = parseArgs({
  args,
  options: {
    size: { type: 'string' },
    notes: { type: 'string' },
    yarns: { type: 'string' },
    seed: { type: 'string' },
    out: { type: 'string' },
  },
  allowPositionals: false,
  strict: true,
})

if (!values.out) fail('--out is required')
const size = int('size', values.size, 1)
const notes = int('notes', values.notes, 1)
const yarns = int('yarns', values.yarns, 0)
const seed = int('seed', values.seed, 0)

let text: string
if (size !== undefined) {
  if (notes !== undefined || yarns !== undefined || seed !== undefined) {
    fail('--size cannot be combined with --notes, --yarns or --seed')
  }
  if (!BENCH_SIZES.includes(size as BenchSize))
    fail(`--size must be one of ${BENCH_SIZES.join(', ')}`)
  text = serializeBoard(benchBoard(size as BenchSize))
} else {
  if (notes === undefined || yarns === undefined) fail('give --size, or both --notes and --yarns')
  text = serializeBoard(generateBoard({ notes, yarns, seed: seed ?? 1 }))
}

const out = resolve(values.out)
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, text)
console.log(`wrote ${out} (${text.length} bytes)`)
