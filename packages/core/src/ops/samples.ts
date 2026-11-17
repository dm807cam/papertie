import { type ClientOp, type Op, OpBatchSchema, OpSchema, SERVER_OPS } from './schema'

const AT = '2026-01-01T00:00:00.000Z'
const NOTE = 'note_01JBPR0T0SAMP1E000000N0TE1'
const NOTE2 = 'note_01JBPR0T0SAMP1E000000N0TE2'
const YARN = 'yarn_01JBPR0T0SAMP1E000000YARN1'
const ASSET = 'asset_01JBPR0T0SAMP1E00000ASSET1'
const BOOK = 'book_01JBPR0T0SAMP1E000000B00K1'
const BLOCK = 'block_01JBPR0T0SAMP1E00000B10CK1'
const BLOCK2 = 'block_01JBPR0T0SAMP1E00000B10CK2'

/**
 * One valid op of every kind. The mapped type makes a new kind of op a type error here until it
 * has its sample, so `primeOpSchemas` always covers every branch of `OpSchema`.
 */
export const OP_SAMPLES: { [K in Op['op']]: Extract<Op, { op: K }> } = {
  'note.create': {
    op: 'note.create',
    note: {
      type: 'note',
      id: NOTE,
      x: 0,
      y: 0,
      w: 240,
      h: 160,
      z: 0,
      paper: 'cream',
      style: 'rustic',
      text: 'a',
      image: { assetId: ASSET, frame: 'none' },
      createdAt: AT,
      updatedAt: AT,
    },
  },
  'note.update': { op: 'note.update', id: NOTE, set: { text: 'b', x: 1 } },
  'note.delete': { op: 'note.delete', id: NOTE },
  'yarn.create': {
    op: 'yarn.create',
    yarn: {
      type: 'yarn',
      id: YARN,
      noteIds: [NOTE, NOTE2],
      color: 'apricot',
      label: '',
      pins: { [NOTE]: 'hanging' },
      createdAt: AT,
      updatedAt: AT,
    },
  },
  'yarn.update': { op: 'yarn.update', id: YARN, set: { label: 'c' } },
  'yarn.insertNote': { op: 'yarn.insertNote', id: YARN, noteId: NOTE, afterNoteId: null },
  'yarn.removeNote': { op: 'yarn.removeNote', id: YARN, noteId: NOTE },
  'yarn.delete': { op: 'yarn.delete', id: YARN },
  'board.update': { op: 'board.update', set: { name: 'd' } },
  'asset.add': {
    op: 'asset.add',
    asset: {
      type: 'asset',
      id: ASSET,
      mime: 'image/webp',
      width: 1,
      height: 1,
      bytes: 1,
      sha256: '0'.repeat(64),
      createdAt: AT,
    },
  },
  'asset.remove': { op: 'asset.remove', id: ASSET },
  'book.create': {
    op: 'book.create',
    book: {
      type: 'book',
      id: BOOK,
      title: 'e',
      lang: 'en',
      shelfPos: 'V',
      cover: { seed: 1, ink: 'indigo', motif: 'overprint' },
      trashedAt: null,
      createdAt: AT,
      updatedAt: AT,
    },
  },
  'book.update': { op: 'book.update', id: BOOK, set: { title: 'f', trashedAt: AT } },
  'block.create': {
    op: 'block.create',
    block: {
      type: 'block',
      id: BLOCK,
      bookId: BOOK,
      pos: 'V',
      kind: 'p',
      text: 'g',
      marks: [{ t: 'b', from: 0, to: 1 }],
    },
    after: BLOCK2,
  },
  'block.delete': { op: 'block.delete', bookId: BOOK, id: BLOCK },
  'block.set': {
    op: 'block.set',
    bookId: BOOK,
    id: BLOCK,
    set: { kind: 'h1', pos: 'W' },
    after: BLOCK2,
  },
  'block.edit': {
    op: 'block.edit',
    bookId: BOOK,
    id: BLOCK,
    splices: [{ at: 0, del: 0, ins: 'h' }],
    takes: [['b']],
    addMarks: [{ t: 'i', from: 0, to: 1 }],
    removeMarks: [{ t: 'b', from: 0, to: 1 }],
  },
  'block.split': {
    op: 'block.split',
    bookId: BOOK,
    id: BLOCK,
    at: 1,
    newId: BLOCK2,
    pos: 'X',
    kind: 'p',
  },
  'block.merge': { op: 'block.merge', bookId: BOOK, from: BLOCK2, into: BLOCK, at: 1 },
  'block.purge': { op: 'block.purge', bookId: BOOK, ids: [BLOCK] },
  'book.purge': { op: 'book.purge', id: BOOK },
  'book.cards': { op: 'book.cards', id: BOOK, add: [NOTE], remove: [NOTE2] },
}

/**
 * Parse every sample once, as an op and as a client's batch: zod compiles each schema at its first
 * parse (1–3 ms a branch on a Mac, some 8–20 ms on a Raspberry Pi), which a server pays here at its
 * start rather than inside the first large batch's commit after it. Returns the kinds
 * whose sample did not parse (none, unless a schema changed under its sample).
 */
export function primeOpSchemas(): string[] {
  const failed: string[] = []
  // Made here, not as the module loads: nothing of this module is in the web app's bundle.
  const serverOnly: ReadonlySet<string> = new Set(SERVER_OPS)
  const clientOps: ClientOp[] = []
  for (const op of Object.values(OP_SAMPLES) as Op[]) {
    if (!OpSchema.safeParse(op).success) failed.push(op.op)
    if (!serverOnly.has(op.op)) clientOps.push(op as ClientOp)
  }
  const batch = {
    clientId: 'tab_01JBPR0T0SAMP1E000000TAB01',
    seq: 1,
    baseRevision: 0,
    ops: clientOps,
  }
  if (!OpBatchSchema.safeParse(batch).success) failed.push('batch')
  return failed
}
