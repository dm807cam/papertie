/**
 * Seeded generator returning floats in [0, 1): a copy of `tools/src/rng.ts`'s, the same sequence
 * (`@papertie/tools` is only a devDependency of the app, so the app keeps its own). It lives with the
 * covers, not in `lib/seed.ts`: that module is in the initial chunk, and an export there that only
 * the lazy shelf uses is kept in the initial JS for it.
 */
export function mulberry32(seed: number): () => number {
  let a = seed | 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
