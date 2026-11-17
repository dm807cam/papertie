import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { OpSchema } from '../src/ops/schema'
import { BoardLineSchema } from '../src/schema/records'

const OUT_FILE = fileURLToPath(
  new URL('../../../docs/schema/board-v1.schema.json', import.meta.url),
)

export const SCHEMA_ID = 'https://papertie.local/schema/board-v1.json'

/** The JSON Schema document for board lines and ops. Pure: no I/O. */
export function buildSchemaDocument() {
  return {
    $id: SCHEMA_ID,
    line: z.toJSONSchema(BoardLineSchema),
    op: z.toJSONSchema(OpSchema),
  }
}

/** The exact text stored on disk: pretty-printed with a trailing newline. */
export function renderSchemaFile(): string {
  return `${JSON.stringify(buildSchemaDocument(), null, 2)}\n`
}

function main(argv: string[]): number {
  const next = renderSchemaFile()
  if (argv.includes('--check')) {
    let current = ''
    try {
      current = readFileSync(OUT_FILE, 'utf8')
    } catch {
      // a missing file counts as a difference
    }
    if (current !== next) {
      console.error(`${OUT_FILE} is out of date; run: pnpm --filter @papertie/core gen:schema`)
      return 1
    }
    return 0
  }
  writeFileSync(OUT_FILE, next)
  console.log(`wrote ${OUT_FILE}`)
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main(process.argv.slice(2)))
}
