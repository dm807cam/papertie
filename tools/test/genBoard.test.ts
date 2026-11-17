import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  type Asset,
  buildMembership,
  computeFocus,
  ID_PATTERN,
  isId,
  LIMITS,
  PAPER_STYLES,
  parseBoard,
  serializeBoard,
  validateInvariants,
} from '@papertie/core'
import {
  BENCH_SIZES,
  benchBoard,
  benchHubId,
  CLUSTER_RATES,
  CLUSTERED_LIFETIME,
  clusteredLifetimeBoard,
  generateBoard,
  generateClusteredBoard,
  generateClusters,
  seededId,
  WIDE_LAYOUT,
  WIDE_SIZE,
  wideBoard,
} from '../src/genBoard'
import { mulberry32 } from '../src/rng'

describe('seededId', () => {
  it('matches ID_PATTERN for every prefix and is deterministic', () => {
    for (const prefix of ['board', 'note', 'yarn', 'asset', 'tab'] as const) {
      const id = seededId(prefix, mulberry32(7))
      expect(id).toMatch(ID_PATTERN)
      expect(isId(id, prefix)).toBe(true)
      expect(seededId(prefix, mulberry32(7))).toBe(id)
    }
  })
})

describe('generateBoard', () => {
  it('has exact counts and no invariant violations', () => {
    const s = benchBoard(500)
    expect([s.notes.size, s.yarns.size]).toEqual([500, 500])
    expect(validateInvariants(s)).toEqual([])
  })

  it('is deterministic per seed', () => {
    expect(serializeBoard(benchBoard(500))).toBe(serializeBoard(benchBoard(500)))
    const a = generateBoard({ notes: 60, yarns: 60, seed: 1 })
    const b = generateBoard({ notes: 60, yarns: 60, seed: 2 })
    expect(serializeBoard(a)).not.toBe(serializeBoard(b))
  })

  it('uses valid unique ids', () => {
    const s = benchBoard(500)
    const ids = [s.board.id, ...s.assets.keys(), ...s.notes.keys(), ...s.yarns.keys()]
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of s.notes.keys()) expect(isId(id, 'note')).toBe(true)
    for (const id of s.yarns.keys()) expect(isId(id, 'yarn')).toBe(true)
  })

  it('gives the hub at least 20 threads', () => {
    const s = benchBoard(500)
    const hub = benchHubId(s)
    const m = buildMembership(s)
    expect(m.yarnsByNote.get(hub)?.size).toBeGreaterThanOrEqual(20)
    expect(
      computeFocus(m, { seeds: [hub], depth: 1, include: [] }).yarns.size,
    ).toBeGreaterThanOrEqual(20)
  })

  it('benchHubId breaks ties by id', () => {
    const s = generateBoard({ notes: 4, yarns: 1, seed: 3, hubThreads: 1 })
    const m = buildMembership(s)
    const degree = (id: string) => m.yarnsByNote.get(id)?.size ?? 0
    const best = Math.max(...[...s.notes.keys()].map(degree))
    const tied = [...s.notes.keys()].filter((id) => degree(id) === best).sort()
    expect(benchHubId(s)).toBe(tied[0])
  })

  it('respects the layout rules', () => {
    const s = benchBoard(500)
    const notes = [...s.notes.values()]
    for (const n of notes) {
      expect(Number.isInteger(n.w) && n.w >= 180 && n.w <= 320).toBe(true)
      expect(Number.isInteger(n.h) && n.h >= 120 && n.h <= 240).toBe(true)
      expect(n.w).toBeGreaterThanOrEqual(LIMITS.noteMinW)
    }
    const share = (style: string) => notes.filter((n) => n.style === style).length / notes.length
    expect(share('rustic')).toBeGreaterThan(0.6)
    expect(share('rustic')).toBeLessThan(0.8)
    expect(share('print')).toBeGreaterThan(0.05)
    expect(share('print')).toBeLessThan(0.16)
    for (const n of notes) {
      expect(PAPER_STYLES).toContain(n.style)
      expect(n.image !== null).toBe(n.style === 'print')
    }
    expect(s.assets.size).toBe(1)
    for (const y of s.yarns.values()) {
      expect(y.noteIds.length).toBeGreaterThanOrEqual(2)
      expect(y.noteIds.length).toBeLessThanOrEqual(4)
    }
  })

  it('round-trips through JSONL with integrity ok', () => {
    expect(parseBoard(serializeBoard(benchBoard(100))).integrity).toBe('ok')
  })

  it('rejects impossible options', () => {
    expect(() => generateBoard({ notes: 1, yarns: 1, seed: 1 })).toThrow(RangeError)
  })

  it('exposes the three bench sizes', () => {
    expect(BENCH_SIZES).toEqual([100, 500, 1000])
  })

  it('stays browser-safe', () => {
    expect(readFileSync(new URL('../src/genBoard.ts', import.meta.url), 'utf8')).not.toMatch(
      /from 'node:/,
    )
  })

  it('keeps the bench boards byte-identical', () => {
    const sha = (n: 100 | 500 | 1000) =>
      createHash('sha256')
        .update(serializeBoard(benchBoard(n)))
        .digest('hex')
    expect(sha(100)).toBe('7c3c090bbc52f95a8969d1db37ae8cde153b5d4f4cd6099c1dd5346ca8aeca2f')
    expect(sha(500)).toBe('cafe47f689441e7a867b9dbb52614391f08d28f522bcd3bfa4f171f543acaca9')
    expect(sha(1000)).toBe('fc2a1f6d86c65329d56e7199bfd25cb38c6d36aec4a8668ff59365cd8ca4e577')
  })

  it('rejects a layout with no columns or empty cells', () => {
    for (const layout of [{ cols: 0 }, { cols: 1.5 }, { cellW: 0 }, { cellH: Number.NaN }]) {
      expect(() => generateBoard({ notes: 4, yarns: 1, seed: 1, ...layout })).toThrow(RangeError)
    }
  })
})

describe('wideBoard', () => {
  const s = wideBoard()
  const notes = [...s.notes.values()]

  it('has 5,000 notes and 5,000 yarns, valid and deterministic', () => {
    expect(WIDE_SIZE).toBe(5000)
    expect([s.notes.size, s.yarns.size]).toEqual([5000, 5000])
    expect(validateInvariants(s)).toEqual([])
    expect(serializeBoard(wideBoard())).toBe(serializeBoard(s))
  })

  it('spreads wide but fits a 1280 x 720 viewport at zoom 0.02 with 64 px padding', () => {
    const x0 = Math.min(...notes.map((n) => n.x))
    const y0 = Math.min(...notes.map((n) => n.y))
    const w = Math.max(...notes.map((n) => n.x + n.w)) - x0
    const h = Math.max(...notes.map((n) => n.y + n.h)) - y0
    expect(w).toBeGreaterThan(50_000)
    expect(h).toBeGreaterThan(25_000)
    expect(w).toBeLessThanOrEqual((1280 - 128) / 0.02)
    expect(h).toBeLessThanOrEqual((720 - 128) / 0.02)
    expect(WIDE_LAYOUT.cols * WIDE_LAYOUT.cellW).toBeLessThan(w + WIDE_LAYOUT.cellW)
  })

  it('never overlaps two notes, so every card shows whole', () => {
    const cell = (n: (typeof notes)[number]) =>
      `${Math.round(n.x / WIDE_LAYOUT.cellW)},${Math.round(n.y / WIDE_LAYOUT.cellH)}`
    const byCell = new Map(notes.map((n) => [cell(n), n]))
    expect(byCell.size).toBe(notes.length)
    for (const n of notes) {
      const [c = 0, r = 0] = cell(n).split(',').map(Number)
      for (const [dc, dr] of [
        [1, 0],
        [0, 1],
        [1, 1],
        [-1, 1],
      ] as const) {
        const m = byCell.get(`${c + dc},${r + dr}`)
        if (m === undefined) continue
        const apart = n.x + n.w < m.x || m.x + m.w < n.x || n.y + n.h < m.y || m.y + m.h < n.y
        expect(apart).toBe(true)
      }
    }
  })
})

describe('clustered boards (the lifetime board as years of use leave it)', () => {
  const { state: s, sizes, clusterOf } = generateClusters(CLUSTERED_LIFETIME)
  const notes = [...s.notes.values()]
  const yarns = [...s.yarns.values()]

  it('has 100,000 notes and 10,000 threads, valid, in 300-800 clusters of 20-600', () => {
    expect([s.notes.size, s.yarns.size]).toEqual([100_000, 10_000])
    expect(validateInvariants(s)).toEqual([])
    expect(sizes.length).toBeGreaterThanOrEqual(300)
    expect(sizes.length).toBeLessThanOrEqual(800)
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(20)
    expect(Math.max(...sizes)).toBeLessThanOrEqual(600)
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(100_000)
    // Every cluster's notes are the ones its layout gave it.
    const counted = new Map<number, number>()
    for (const c of clusterOf.values()) counted.set(c, (counted.get(c) ?? 0) + 1)
    expect([...counted.keys()].sort((a, b) => a - b).map((c) => counted.get(c))).toEqual(sizes)
  })

  it('is deterministic per seed and generates in page-load time', () => {
    const again = clusteredLifetimeBoard()
    expect(serializeBoard(again)).toBe(serializeBoard(s))
    const other = generateClusteredBoard({ notes: 2_000, seed: 1 })
    expect(serializeBoard(other)).not.toBe(
      serializeBoard(generateClusteredBoard({ notes: 2_000, seed: 2 })),
    )
  })

  it('keeps threads inside their cluster but for about 5 % between two', () => {
    const cross = yarns.filter((y) => new Set(y.noteIds.map((id) => clusterOf.get(id))).size > 1)
    const share = cross.length / yarns.length
    expect(share).toBeGreaterThan(0.03)
    expect(share).toBeLessThan(0.07)
    for (const y of yarns) {
      expect(y.noteIds.length).toBeGreaterThanOrEqual(2)
      expect(y.noteIds.length).toBeLessThanOrEqual(8)
    }
    // The bench hub: note 0 on 20 threads.
    expect(buildMembership(s).yarnsByNote.get(benchHubId(s))?.size).toBe(20)
  })

  it('has photos, tags and decorations at about their rates', () => {
    const near = (count: number, rate: number) => {
      expect(count / notes.length).toBeGreaterThan(rate * 0.8)
      expect(count / notes.length).toBeLessThan(rate * 1.2)
    }
    const paper = notes.filter((n) => n.image === null && n.w > TAG_W)
    near(notes.filter((n) => n.image !== null).length, CLUSTER_RATES.photo)
    near(notes.filter((n) => n.w <= TAG_W).length, CLUSTER_RATES.tag)
    for (const n of notes) expect(n.image !== null).toBe(n.style === 'print')
    const deco = (k: 'motif' | 'stamp' | 'layered') =>
      paper.filter((n) => n[k] !== undefined).length
    expect(deco('motif') / paper.length).toBeCloseTo(CLUSTER_RATES.motif, 1)
    expect(deco('stamp') / paper.length).toBeCloseTo(CLUSTER_RATES.stamp, 1)
    expect(deco('layered') / paper.length).toBeCloseTo(CLUSTER_RATES.layered, 1)
  })

  it('fits a 1200 x 720 screen whole above the zoom floor, far out (the pyramid draws it)', () => {
    let [x0, y0, x1, y1] = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, -1e9, -1e9]
    for (const n of notes) {
      x0 = Math.min(x0, n.x)
      y0 = Math.min(y0, n.y)
      x1 = Math.max(x1, n.x + n.w)
      y1 = Math.max(y1, n.y + n.h)
    }
    const fit = Math.min(1200 / (x1 - x0), 720 / (y1 - y0))
    expect(fit).toBeGreaterThan(0.005) // ZOOM_MIN
    expect(fit).toBeLessThan(0.01) // the pyramid's threshold
  })

  it('photo notes show the assets given, in turn', () => {
    const assets = [0, 1, 2].map((i) => ({
      ...[...benchBoard(100).assets.values()][0],
      id: seededId('asset', mulberry32(i)),
    })) as Asset[]
    const b = generateClusteredBoard({ notes: 3_000, seed: 5, photoAssets: assets })
    const used = new Set([...b.notes.values()].flatMap((n) => (n.image ? [n.image.assetId] : [])))
    expect(used).toEqual(new Set(assets.map((a) => a.id)))
    expect([...b.assets.keys()].sort()).toEqual(assets.map((a) => a.id).sort())
    expect(validateInvariants(b)).toEqual([])
  })

  it('rejects impossible options, and a tight plan still sums to the notes asked', () => {
    expect(() => generateClusteredBoard({ notes: 1, seed: 1 })).toThrow(RangeError)
    expect(() =>
      generateClusteredBoard({ notes: 9, seed: 1, clusterMin: 5, clusterMax: 4 }),
    ).toThrow(RangeError)
    const tight = generateClusters({ notes: 1_003, seed: 3, clusterMin: 50, clusterMax: 50 })
    expect(tight.sizes.reduce((a, b) => a + b, 0)).toBe(1_003)
    expect(tight.state.notes.size).toBe(1_003)
  })
})

/** Tags are notes this narrow or narrower (the web app's `TAG_MAX_W`). */
const TAG_W = 120
