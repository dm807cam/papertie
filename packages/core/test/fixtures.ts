import type { Asset, Block, Board, Book, IdPrefix, Membership, Note, Yarn } from '../src/index'
import { hashKey } from '../src/pmap'

export const T0 = '2026-10-27T10:00:00.000Z'

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * Deterministic, schema-valid id: `<prefix>_` + 26 Crockford chars derived from `n`.
 * Same (prefix, n) always yields the same id; different n yields distinct ids.
 */
export function fixtureId(prefix: IdPrefix, n: number): string {
  let rest = Math.trunc(n)
  let tail = ''
  for (let i = 0; i < 26; i++) {
    tail = ALPHABET[rest % 32] + tail
    rest = Math.floor(rest / 32)
  }
  return `${prefix}_${tail}`
}

export function makeBoard(over: Partial<Board> = {}): Board {
  return {
    type: 'board',
    schemaVersion: 6,
    id: fixtureId('board', 1),
    name: 'Test board',
    revision: 0,
    clients: {},
    createdAt: T0,
    updatedAt: T0,
    ...over,
  }
}

export function makeNote(over: Partial<Note> = {}): Note {
  return {
    type: 'note',
    id: fixtureId('note', 1),
    x: 0,
    y: 0,
    w: 240,
    h: 160,
    z: 0,
    paper: 'cream',
    style: 'rustic',
    text: 'hello',
    image: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  }
}

export function makeYarn(noteIds: string[], over: Partial<Yarn> = {}): Yarn {
  return {
    type: 'yarn',
    id: fixtureId('yarn', 1),
    noteIds,
    color: 'apricot',
    label: '',
    createdAt: T0,
    updatedAt: T0,
    ...over,
  }
}

export function makeAsset(over: Partial<Asset> = {}): Asset {
  return {
    type: 'asset',
    id: fixtureId('asset', 1),
    mime: 'image/webp',
    width: 800,
    height: 600,
    bytes: 12_345,
    sha256: 'a'.repeat(64),
    createdAt: T0,
    ...over,
  }
}

export function makeBook(over: Partial<Book> = {}): Book {
  return {
    type: 'book',
    id: fixtureId('book', 1),
    title: 'A book',
    lang: 'en',
    shelfPos: 'V',
    cover: { seed: 7, ink: 'indigo', motif: 'overprint' },
    trashedAt: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  }
}

export function makeBlock(over: Partial<Block> = {}): Block {
  return {
    type: 'block',
    id: fixtureId('block', 1),
    bookId: fixtureId('book', 1),
    pos: 'V',
    kind: 'p',
    text: 'Once upon a time',
    marks: [],
    ...over,
  }
}

/** Two different keys with the same `PMap` hash, found by search (deterministic). */
export function collidingKeys(): [string, string] {
  const seen = new Map<number, string>()
  for (let i = 0; ; i++) {
    const k = `note_${i}`
    const other = seen.get(hashKey(k))
    if (other !== undefined) return [other, k]
    seen.set(hashKey(k), k)
  }
}

/** Notes sharing at least one yarn with `noteId`, excluding the note itself: the focus tests' reference. */
export function neighbours(m: Membership, noteId: string): Set<string> {
  const out = new Set<string>()
  for (const yarnId of m.yarnsByNote.get(noteId) ?? []) {
    for (const other of m.notesByYarn.get(yarnId) ?? []) {
      if (other !== noteId && m.yarnsByNote.has(other)) out.add(other)
    }
  }
  return out
}
