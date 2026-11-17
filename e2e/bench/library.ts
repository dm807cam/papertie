import type { Asset } from '../../packages/core/src'
import { CLUSTERED_LIFETIME, generateClusteredBoard } from '../../tools/src/genBoard'
import { genLibrary, type Library } from '../../tools/src/genBook'

/**
 * The lifetime library on the lifetime board: `genLibrary` at seed 1 (its long book "A lifetime"
 * is genBook's 200,000 words at seed 1, the book ADR-0007 measured), seeded beside the board so
 * every row runs with the 50 books present.
 */

const LIBRARY_SEED = 1

/** The board the rows seed: the clustered lifetime board. */
export const BENCH_BOARD = CLUSTERED_LIFETIME
/** Photos uploaded with the board. */
export const BENCH_PHOTOS = 12

/** Every this many of the bench board's notes is a card the library's long books are made from. */
const CARD_EVERY = 200

/**
 * The bench board's cards and photo the library's long books are made from: every
 * 200th note of the board the bench seeds (generated again, the same ids), and its first photo.
 */
function libraryLinks(assets: readonly Asset[]): { cards: string[]; asset?: string } {
  const notes = [...generateClusteredBoard({ ...BENCH_BOARD, photoAssets: assets }).notes.keys()]
  return { cards: notes.filter((_, i) => i % CARD_EVERY === 0), asset: assets[0]?.id }
}

/** The library, as generated (its ids do not depend on `now`), made from the board's cards. */
export const benchLibrary = (now: string, assets: readonly Asset[]): Library =>
  genLibrary({ seed: LIBRARY_SEED, now, ...libraryLinks(assets) })
