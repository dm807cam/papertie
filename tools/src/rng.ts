/** Seeded generator returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed | 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function mix(h: number): number {
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return (h ^ (h >>> 16)) | 0
}

/** Stateless hash of an integer lattice point, in [0, 1). */
export function latticeHash(ix: number, iy: number, seed: number): number {
  let h = mix(Math.imul(ix | 0, 0x9e3779b1) ^ (seed | 0))
  h = mix(h ^ Math.imul(iy | 0, 0x85ebca77))
  h = mix(h + 0x6a09e667)
  return (h >>> 0) / 4294967296
}
