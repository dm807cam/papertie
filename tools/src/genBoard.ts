import {
  type Asset,
  type Board,
  type BoardState,
  buildMembership,
  type IdPrefix,
  LIMITS,
  MOTIFS,
  type Note,
  PALETTE_TOKENS,
  stateFromRecords,
  type Yarn,
} from '@papertie/core'
import { mulberry32 } from './rng'

/** The prototype's placeholder asset; the web app serves one sample print for every id. */
export const PROTO_ASSET_ID = 'asset_01JBPR0T0SAMP1E000000PR1NT'

/** Crockford base32, the alphabet core's ids use. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** A valid, deterministic id: `prefix_` plus 26 Crockford base32 characters drawn from `rng`. */
export function seededId(prefix: IdPrefix, rng: () => number): string {
  let out = `${prefix}_`
  for (let i = 0; i < 26; i++) out += ALPHABET[Math.floor(rng() * 32)]
  return out
}

export interface GenOptions {
  notes: number
  yarns: number
  seed: number
  /** Threads that all contain note 0. Default `min(20, yarns)`. */
  hubThreads?: number
  /** Timestamped on every record. Default `2026-10-27T00:00:00.000Z`. */
  now?: string
  /** Grid columns. Default `ceil(sqrt(notes))`. */
  cols?: number
  /** Grid cell size in world px. Default 340 x 300. */
  cellW?: number
  cellH?: number
}

const CELL_W = 340
const CELL_H = 300
const JITTER = 40

const CORPUS = [
  'Books to read at the weekend',
  'Call the framer about the print',
  'A knot ties thoughts together',
  'Idea: group by season, not by topic',
  'To borrow from the library',
  'Why does the second draft always read better?',
  'Thought of on the morning walk',
  'Reply to Anna before Friday',
  'On the fibres of handmade paper',
  'Three questions for the workshop',
  'Next month: the trip, two cities',
  'Keep it small. Pin it. Move on.',
]

const PROTO_ASSET = (now: string): Asset => ({
  type: 'asset',
  id: PROTO_ASSET_ID,
  mime: 'image/webp',
  width: 1024,
  height: 683,
  bytes: 7094,
  sha256: '351c1ad4796ac7ebf8154d34dbc584abe03df9ae182ce2a6fcfb8073c96a630a',
  createdAt: now,
})

/**
 * A deterministic board on a jittered grid (`cols` wide, `cellW` x `cellH` cells) for tests and
 * benchmarks. Note 0 is the hub of the first `hubThreads` yarns; every other yarn links 2 to 4
 * notes within two grid cells. Runs in linear time and imports nothing from Node, so the browser
 * can call it at page load.
 */
export function generateBoard(o: GenOptions): BoardState {
  const { notes: n, yarns: m, seed } = o
  const now = o.now ?? '2026-10-27T00:00:00.000Z'
  if (!Number.isInteger(n) || n < 1 || !Number.isInteger(m) || m < 0) {
    throw new RangeError('generateBoard: notes must be >= 1 and yarns >= 0, both integers')
  }
  if (m > 0 && n < 2) throw new RangeError('generateBoard: a yarn needs at least 2 notes')
  const cols = o.cols ?? Math.ceil(Math.sqrt(n))
  const cellW = o.cellW ?? CELL_W
  const cellH = o.cellH ?? CELL_H
  if (!Number.isInteger(cols) || cols < 1 || !(cellW > 0) || !(cellH > 0)) {
    throw new RangeError('generateBoard: cols must be an integer >= 1 and cells non-empty')
  }
  const hubThreads = Math.min(o.hubThreads ?? 20, m)

  const rng = mulberry32(seed)
  const idRng = mulberry32(seed ^ 0x5bd1e995)
  const int = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1))

  const board: Board = {
    type: 'board',
    schemaVersion: 6,
    id: seededId('board', idRng),
    name: `Benchmark ${n}/${m}`,
    revision: 0,
    clients: {},
    createdAt: now,
    updatedAt: now,
  }

  const noteList: Note[] = []
  let printCount = 0
  for (let i = 0; i < n; i++) {
    const roll = rng()
    const style = roll < 0.7 ? 'rustic' : roll < 0.9 ? 'smooth' : 'print'
    if (style === 'print') printCount++
    noteList.push({
      type: 'note',
      id: seededId('note', idRng),
      x: (i % cols) * cellW + int(-JITTER, JITTER),
      y: Math.floor(i / cols) * cellH + int(-JITTER, JITTER),
      w: int(180, 320),
      h: int(120, 240),
      z: i,
      paper: PALETTE_TOKENS[int(0, PALETTE_TOKENS.length - 1)] as Note['paper'],
      style,
      text: CORPUS[int(0, CORPUS.length - 1)] as string,
      image: style === 'print' ? { assetId: PROTO_ASSET_ID, frame: 'print' } : null,
      createdAt: now,
      updatedAt: now,
    })
  }

  /** Indices within `reach` grid cells of note `i`, nearest rows first, excluding `i`. */
  const around = (i: number, reach: number): number[] => {
    const c = i % cols
    const r = Math.floor(i / cols)
    const out: number[] = []
    for (let dr = -reach; dr <= reach; dr++) {
      for (let dc = -reach; dc <= reach; dc++) {
        const cc = c + dc
        const rr = r + dr
        if ((dr === 0 && dc === 0) || cc < 0 || cc >= cols || rr < 0) continue
        const j = rr * cols + cc
        if (j < n) out.push(j)
      }
    }
    return out
  }

  /** `count` distinct entries of `pool` (which is reordered), fewer if the pool is short. */
  const take = (pool: number[], count: number): number[] => {
    const k = Math.min(count, pool.length)
    for (let i = 0; i < k; i++) {
      const j = int(i, pool.length - 1)
      const tmp = pool[i] as number
      pool[i] = pool[j] as number
      pool[j] = tmp
    }
    return pool.slice(0, k)
  }

  const yarnList: Yarn[] = []
  for (let y = 0; y < m; y++) {
    let members: number[]
    if (y < hubThreads) {
      members = [0, ...take(around(0, 1), int(1, 2))]
    } else {
      const anchor = int(0, n - 1)
      members = [anchor, ...take(around(anchor, 2), int(1, 3))]
    }
    yarnList.push({
      type: 'yarn',
      id: seededId('yarn', idRng),
      noteIds: members.map((i) => (noteList[i] as Note).id),
      color: PALETTE_TOKENS[int(0, PALETTE_TOKENS.length - 1)] as Yarn['color'],
      label: '',
      createdAt: now,
      updatedAt: now,
    })
  }

  return stateFromRecords(board, [
    ...(printCount > 0 ? [PROTO_ASSET(now)] : []),
    ...noteList,
    ...yarnList,
  ])
}

export const BENCH_SIZES = [100, 500, 1000] as const
export type BenchSize = (typeof BENCH_SIZES)[number]

/** The benchmark board of a given size: that many notes and yarns, seeded by the size. */
export function benchBoard(size: BenchSize): BoardState {
  return generateBoard({ notes: size, yarns: size, seed: size })
}

/** The note on the most yarns; ties go to the smaller id. Empty string for an empty board. */
export function benchHubId(state: BoardState): string {
  let best = ''
  let bestDegree = -1
  for (const [id, yarns] of buildMembership(state).yarnsByNote) {
    if (yarns.size > bestDegree || (yarns.size === bestDegree && id < best)) {
      best = id
      bestDegree = yarns.size
    }
  }
  return best
}

/** The wide board's size: notes and yarns. */
export const WIDE_SIZE = 5000

/**
 * The wide board's grid: 100 x 50 cells of 540 x 520 world px, about 53,900 x 25,800 in all, so
 * fit-all shows it whole on a 1280 x 720 viewport at zoom 0.0214 (just above `ZOOM_MIN` 0.02).
 * Cells are wider than any note plus its jitter, so no two notes overlap.
 */
export const WIDE_LAYOUT = { cols: 100, cellW: 540, cellH: 520 } as const

/** 5,000 notes and 5,000 yarns spread wide (`WIDE_LAYOUT`), seeded by the size. */
export function wideBoard(): BoardState {
  return generateBoard({ notes: WIDE_SIZE, yarns: WIDE_SIZE, seed: WIDE_SIZE, ...WIDE_LAYOUT })
}

/**
 * The lifetime board: `LIMITS.maxNotes` notes and 10,000 threads on genBoard's grid
 * (317 columns of 340 × 300 world px cells, about 108,000 × 95,000 world px).
 */
export const LIFETIME_SIZE = { notes: 100_000, yarns: 10_000 } as const

/** The lifetime board, seeded as the e2e lifetime helper seeds it. */
export function lifetimeBoard(): BoardState {
  return generateBoard({ ...LIFETIME_SIZE, seed: 4242 })
}

// --- A board as a lifetime of use leaves it: clusters of related notes. --------------------------

export interface ClusterOptions {
  notes: number
  seed: number
  /** Threads. Default a tenth of the notes. */
  yarns?: number
  /** Notes per cluster, fewest and most. Default 20 and 600. */
  clusterMin?: number
  clusterMax?: number
  /** The share of threads that join two clusters. Default 0.05. */
  between?: number
  /** Threads that all contain note 0 (the bench hub). Default `min(20, yarns)`. */
  hubThreads?: number
  /**
   * The assets photo notes show, in turn (a server seed passes the ones it uploaded). Default the
   * prototype's placeholder print.
   */
  photoAssets?: readonly Asset[]
  /** Timestamped on every record. Default `2026-10-27T00:00:00.000Z`. */
  now?: string
}

/**
 * How often each kind of note turns up on a board in long use: mostly paper notes, a photo now and then, a few tags, and some decorated.
 */
export const CLUSTER_RATES = {
  photo: 0.05,
  tag: 0.04,
  /** Of the paper notes that are not tags; the rest are smooth. */
  rustic: 0.75,
  motif: 0.06,
  stamp: 0.02,
  layered: 0.03,
} as const

/** A cluster's cells, world px; notes are 160-280 x 110-220, so neighbours rarely overlap. */
const CLUSTER_CELL_W = 300
const CLUSTER_CELL_H = 260
const CLUSTER_JITTER = 24
/** Empty cork between clusters, world px. */
const CLUSTER_GAP = { min: 500, max: 1600 } as const
/** The packing aspect: rows of a square board stretched by its root (shelves land at about 1.8). */
const BOARD_ASPECT = 2

/**
 * A deterministic board in clusters of related notes, as years of use leave one: cluster sizes
 * are log-uniform in [`clusterMin`, `clusterMax`] (300-800 clusters at 100,000 notes), each a
 * rough disc of notes on a jittered grid, packed in rows with cork between. Threads stay inside
 * a cluster but for `between` of them, which join a cluster to its neighbour on the board (or,
 * one in five, to any). Photos, tags and decorations come at `CLUSTER_RATES`. Note 0 is
 * the hub of the first `hubThreads` threads. Imports nothing from Node.
 */
export function generateClusteredBoard(o: ClusterOptions): BoardState {
  return generateClusters(o).state
}

/** A clustered board and its plan: each cluster's size, and the cluster of each note by id. */
export interface ClusteredBoard {
  state: BoardState
  sizes: readonly number[]
  clusterOf: ReadonlyMap<string, number>
}

/** {@link generateClusteredBoard}, with the clusters it drew (for tests). */
export function generateClusters(o: ClusterOptions): ClusteredBoard {
  const n = o.notes
  const m = o.yarns ?? Math.round(n / 10)
  const lo = o.clusterMin ?? 20
  const hi = o.clusterMax ?? 600
  const between = o.between ?? 0.05
  const now = o.now ?? '2026-10-27T00:00:00.000Z'
  const photos = o.photoAssets ?? [PROTO_ASSET(now)]
  if (!Number.isInteger(n) || n < 2 || !Number.isInteger(m) || m < 0) {
    throw new RangeError('generateClusteredBoard: notes must be >= 2 and yarns >= 0, integers')
  }
  if (!Number.isInteger(lo) || lo < 2 || !Number.isInteger(hi) || hi < lo) {
    throw new RangeError('generateClusteredBoard: clusters need 2 <= clusterMin <= clusterMax')
  }
  if (photos.length === 0) throw new RangeError('generateClusteredBoard: photoAssets is empty')
  const hubThreads = Math.min(o.hubThreads ?? 20, m)

  const rng = mulberry32(o.seed)
  const idRng = mulberry32(o.seed ^ 0x5bd1e995)
  const int = (a: number, b: number) => a + Math.floor(rng() * (b - a + 1))
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)] as T

  // 1. Cluster sizes, log-uniform, summing to n. A remainder too small for a cluster of its own
  //    is shared out one note at a time to clusters with room.
  const sizes: number[] = []
  let left = n
  while (left > 0) {
    const s = Math.min(left, Math.round(lo * (hi / lo) ** rng()))
    if (left - s > 0 && left - s < lo) {
      sizes.push(s)
      left -= s
      for (let i = 0; i < sizes.length && left > 0; i++) {
        const room = Math.min(left, hi - (sizes[i] as number))
        sizes[i] = (sizes[i] as number) + room
        left -= room
      }
      // Every cluster full (clusterMin = clusterMax): the remainder is a small cluster.
      if (left > 0) sizes.push(left)
      left = 0
    } else {
      sizes.push(s)
      left -= s
    }
  }

  // 2. Each cluster's cells: the `size` nearest a centre, by a noisy distance (a rough disc).
  interface Cluster {
    start: number
    size: number
    /** Cell (col, row) of each of its notes, in note order, relative to the cluster's corner. */
    cells: Array<[number, number]>
    cols: number
    rows: number
    x: number
    y: number
    /** Note index by `row * cols + col`. */
    at: Map<number, number>
  }
  const clusters: Cluster[] = []
  let start = 0
  for (const size of sizes) {
    const side = Math.ceil(Math.sqrt(size * 1.6)) + 1
    const c = (side - 1) / 2
    const all: Array<[number, number, number]> = []
    for (let r = 0; r < side; r++) {
      for (let q = 0; q < side; q++) all.push([q, r, Math.hypot(q - c, r - c) + rng() * 1.5])
    }
    all.sort((a, b) => a[2] - b[2])
    const chosen = all.slice(0, size)
    const minQ = Math.min(...chosen.map((p) => p[0]))
    const minR = Math.min(...chosen.map((p) => p[1]))
    const cells = chosen.map((p): [number, number] => [p[0] - minQ, p[1] - minR])
    const cols = Math.max(...cells.map((p) => p[0])) + 1
    const rows = Math.max(...cells.map((p) => p[1])) + 1
    const at = new Map<number, number>()
    for (const [i, [q, r]] of cells.entries()) at.set(r * cols + q, start + i)
    clusters.push({ start, size, cells, cols, rows, x: 0, y: 0, at })
    start += size
  }

  // 3. Pack the clusters in shelves, tallest first, each row √BOARD_ASPECT times as wide as the
  //    side of a square of their area. `placed` is the order on the board, which neighbouring
  //    threads follow.
  const gap = () => int(CLUSTER_GAP.min, CLUSTER_GAP.max)
  const avgGap = (CLUSTER_GAP.min + CLUSTER_GAP.max) / 2
  const area = clusters.reduce(
    (a, k) => a + (k.cols * CLUSTER_CELL_W + avgGap) * (k.rows * CLUSTER_CELL_H + avgGap),
    0,
  )
  const rowWidth = Math.sqrt(area * BOARD_ASPECT)
  const placed = [...clusters.keys()].sort(
    (a, b) => (clusters[b] as Cluster).rows - (clusters[a] as Cluster).rows || a - b,
  )
  const rankOf = new Int32Array(clusters.length)
  placed.forEach((ci, rank) => {
    rankOf[ci] = rank
  })
  let cx = 0
  let cy = 0
  let rowH = 0
  for (const ci of placed) {
    const k = clusters[ci] as Cluster
    const w = k.cols * CLUSTER_CELL_W
    if (cx > 0 && cx + w > rowWidth) {
      cx = 0
      cy += rowH + gap()
      rowH = 0
    }
    k.x = cx
    k.y = cy + int(0, CLUSTER_GAP.min)
    cx += w + gap()
    rowH = Math.max(rowH, k.rows * CLUSTER_CELL_H + (k.y - cy))
  }

  // 4. Notes, cluster by cluster (z is creation order, as a board grows).
  const board: Board = {
    type: 'board',
    schemaVersion: 6,
    id: seededId('board', idRng),
    name: `Clusters ${n}/${m}`,
    revision: 0,
    clients: {},
    createdAt: now,
    updatedAt: now,
  }
  const noteList: Note[] = []
  let photoCount = 0
  const text = () => {
    const lines = rng() < 0.15 ? int(2, 4) : 1
    return Array.from({ length: lines }, () => pick(CORPUS)).join('\n')
  }
  for (const k of clusters) {
    for (const [q, r] of k.cells) {
      const roll = rng()
      const x = k.x + q * CLUSTER_CELL_W + int(-CLUSTER_JITTER, CLUSTER_JITTER)
      const y = k.y + r * CLUSTER_CELL_H + int(-CLUSTER_JITTER, CLUSTER_JITTER)
      const base = {
        type: 'note' as const,
        id: seededId('note', idRng),
        x,
        y,
        z: noteList.length,
        paper: pick(PALETTE_TOKENS) as Note['paper'],
        createdAt: now,
        updatedAt: now,
      }
      let note: Note
      if (roll < CLUSTER_RATES.photo) {
        const asset = photos[photoCount++ % photos.length] as Asset
        note = {
          ...base,
          w: int(200, 280),
          h: int(150, 210),
          style: 'print',
          text: '',
          image: { assetId: asset.id, frame: 'print' },
        }
      } else if (roll < CLUSTER_RATES.photo + CLUSTER_RATES.tag) {
        note = {
          ...base,
          w: LIMITS.noteMinW,
          h: int(220, 250),
          style: 'rustic',
          text: pick(CORPUS),
          image: null,
        }
      } else {
        note = {
          ...base,
          w: int(160, 280),
          h: int(110, 220),
          style: rng() < CLUSTER_RATES.rustic ? 'rustic' : 'smooth',
          text: text(),
          image: null,
        }
        const d = rng()
        if (d < CLUSTER_RATES.motif) note.motif = pick(MOTIFS)
        else if (d < CLUSTER_RATES.motif + CLUSTER_RATES.stamp) note.stamp = true
        else if (d < CLUSTER_RATES.motif + CLUSTER_RATES.stamp + CLUSTER_RATES.layered)
          note.layered = pick(PALETTE_TOKENS) as Note['paper']
      }
      noteList.push(note)
    }
  }

  // 5. Threads. Within a cluster: an anchor and 1-3 notes within two cells, or (one in ten) a
  //    chain of 5-8 notes walking neighbour to neighbour. Between clusters: an anchor and a note
  //    of the next cluster on the board, or of any cluster.
  const clusterOf = new Int32Array(n)
  for (const [ci, k] of clusters.entries()) clusterOf.fill(ci, k.start, k.start + k.size)
  /** Notes of cluster `k` within `reach` cells of its note `i`. */
  const near = (k: Cluster, i: number, reach: number): number[] => {
    const [q, r] = k.cells[i - k.start] as [number, number]
    const out: number[] = []
    for (let dr = -reach; dr <= reach; dr++) {
      for (let dq = -reach; dq <= reach; dq++) {
        const qq = q + dq
        const rr = r + dr
        if ((dq === 0 && dr === 0) || qq < 0 || qq >= k.cols || rr < 0 || rr >= k.rows) continue
        const j = k.at.get(rr * k.cols + qq)
        if (j !== undefined) out.push(j)
      }
    }
    return out
  }
  const takeFrom = (pool: number[], count: number): number[] => {
    const out: number[] = []
    while (out.length < count && pool.length > 0) {
      out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0] as number)
    }
    return out
  }
  /** Any note: its cluster is drawn weighted by size (threads come with notes). */
  const anyNote = () => int(0, n - 1)
  const yarnList: Yarn[] = []
  for (let y = 0; y < m; y++) {
    let members: number[]
    if (y < hubThreads) {
      members = [0, ...takeFrom(near(clusters[0] as Cluster, 0, 1), int(1, 2))]
    } else if (rng() < between && clusters.length > 1) {
      const a = anyNote()
      const ca = clusterOf[a] as number
      const next = placed[((rankOf[ca] as number) + 1) % clusters.length] as number
      const cb = rng() < 0.8 ? next : int(0, clusters.length - 1)
      const kb = clusters[cb === ca ? next : cb] as Cluster
      members = [a, kb.start + int(0, kb.size - 1)]
    } else {
      const a = anyNote()
      const k = clusters[clusterOf[a] as number] as Cluster
      if (rng() < 0.1) {
        members = [a]
        for (let len = int(5, 8); members.length < len; ) {
          const next = near(k, members.at(-1) as number, 1).filter((j) => !members.includes(j))
          if (next.length === 0) break
          members.push(pick(next))
        }
      } else members = [a, ...takeFrom(near(k, a, 2), int(1, 3))]
      if (members.length < 2) {
        const b = k.start + ((a - k.start + 1) % k.size)
        members = [a, b === a ? (a + 1) % n : b]
      }
    }
    yarnList.push({
      type: 'yarn',
      id: seededId('yarn', idRng),
      noteIds: members.map((i) => (noteList[i] as Note).id),
      color: pick(PALETTE_TOKENS) as Yarn['color'],
      label: '',
      createdAt: now,
      updatedAt: now,
    })
  }

  const state = stateFromRecords(board, [
    ...(photoCount > 0 ? photos : []),
    ...noteList,
    ...yarnList,
  ])
  const byId = new Map<string, number>()
  for (const [i, note] of noteList.entries()) byId.set(note.id, clusterOf[i] as number)
  return { state, sizes, clusterOf: byId }
}

/** The clustered lifetime board's size and seed: `LIMITS.maxNotes` notes, 10,000 threads. */
export const CLUSTERED_LIFETIME = { notes: 100_000, yarns: 10_000, seed: 4243 } as const

/** The lifetime board as years of use leave it (the bench board). */
export function clusteredLifetimeBoard(): BoardState {
  return generateClusteredBoard(CLUSTERED_LIFETIME)
}
