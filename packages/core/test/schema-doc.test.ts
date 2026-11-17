import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildSchemaDocument } from '../scripts/gen-schema'
import { parseBoard, serializeBoard } from '../src/index'

const SCHEMA_FILE = fileURLToPath(
  new URL('../../../docs/schema/board-v1.schema.json', import.meta.url),
)

describe('generated JSON Schema', () => {
  it('matches the committed docs/schema/board-v1.schema.json', () => {
    const onDisk = JSON.parse(readFileSync(SCHEMA_FILE, 'utf8'))
    expect(buildSchemaDocument()).toEqual(onDisk)
  })

  it('has the expected envelope', () => {
    const doc = buildSchemaDocument()
    expect(doc.$id).toBe('https://papertie.local/schema/board-v1.json')
    expect(Object.keys(doc)).toEqual(['$id', 'line', 'op'])
  })

  it('is stored pretty-printed with a trailing newline', () => {
    const text = readFileSync(SCHEMA_FILE, 'utf8')
    expect(text).toBe(`${JSON.stringify(buildSchemaDocument(), null, 2)}\n`)
  })
})

describe('docs/schema/board-v1.md', () => {
  it('has an annotated example that parses with integrity ok and no issues', () => {
    const md = readFileSync(
      fileURLToPath(new URL('../../../docs/schema/board-v1.md', import.meta.url)),
      'utf8',
    )
    const match = /```jsonl\n([\s\S]*?)```/.exec(md)
    expect(match).not.toBeNull()
    const example = match?.[1] ?? ''
    const parsed = parseBoard(example)
    expect(parsed.integrity).toBe('ok')
    expect(parsed.issues).toEqual([])
    expect(parsed.state).not.toBeNull()
    // The example is canonical: re-serializing it reproduces it byte for byte.
    if (parsed.state) expect(serializeBoard(parsed.state)).toBe(example)
  })
})
