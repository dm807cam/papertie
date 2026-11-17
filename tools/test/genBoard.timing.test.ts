import { serializeBoard } from '@papertie/core'
import {
  benchBoard,
  CLUSTERED_LIFETIME,
  clusteredLifetimeBoard,
  generateClusteredBoard,
  generateClusters,
  wideBoard,
} from '../src/genBoard'

describe('generateBoard', () => {
  it('generates the 1000 board quickly', () => {
    const t = performance.now()
    benchBoard(1000)
    expect(performance.now() - t).toBeLessThan(200)
  })
})

describe('wideBoard', () => {
  it('generates quickly enough for page load', () => {
    const t = performance.now()
    wideBoard()
    expect(performance.now() - t).toBeLessThan(1000)
  })
})

describe('clustered boards (the lifetime board as years of use leave it)', () => {
  const t0 = performance.now()
  const { state: s } = generateClusters(CLUSTERED_LIFETIME)
  const genMs = performance.now() - t0

  it('is deterministic per seed and generates in page-load time', () => {
    const again = clusteredLifetimeBoard()
    expect(serializeBoard(again)).toBe(serializeBoard(s))
    const other = generateClusteredBoard({ notes: 2_000, seed: 1 })
    expect(serializeBoard(other)).not.toBe(
      serializeBoard(generateClusteredBoard({ notes: 2_000, seed: 2 })),
    )
    expect(genMs).toBeLessThan(3_000)
  })
})
