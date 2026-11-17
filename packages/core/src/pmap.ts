/**
 * Persistent maps: an edit copies a few small pieces and shares everything
 * else with the version it came from, so a board of 100,000 notes is never copied to change
 * one of them, while reads stay close to a native `Map`.
 *
 * A {@link PMap} spreads its keys over a root array of buckets by a cheap hash of the key's
 * last characters (an id's random tail). Each bucket is a small native `Map` from key to leaf,
 * so a read is one slot and one native lookup, which uses the hash V8 keeps on the string. A
 * written version copies the root (at most 4,096 slots) and the buckets it touches (about 25
 * keys each at 100,000), never the rest. Keys that share a tail (chosen so, or regularly spaced)
 * would pile into one bucket, so a bucket that reaches {@link SPLIT_AT} keys is split 32 ways
 * by a seeded hash of the whole key, level by level: a write never copies more than that.
 *
 * Each leaf also sits in a persistent 32-way vector, in insertion order, as `Map` keeps its
 * entries, because serialization and line order depend on it: a new key is appended, a changed
 * value replaces its leaf in place, and a deleted key leaves a hole. The vector is rebuilt
 * without holes when more than half of it is holes: O(n), but only after as many deletes as
 * there are entries. Keys compare as `Map` keys do (SameValueZero).
 *
 * A {@link TransientMap} changes the pieces it copied in place, so a batch of edits copies each
 * piece once; {@link TransientMap.persist} freezes it into a `PMap`.
 */

const BITS = 5
const WIDTH = 1 << BITS
const MASK = WIDTH - 1

/** The transient that may change a piece in place; `null` for a piece no transient owns. */
type Edit = object | null

/** A key and its value, and its slot in the vector. Never changed once shared. */
class Leaf<K, V> {
  constructor(
    readonly k: K,
    public v: V,
    readonly i: number,
  ) {}
}

type Bucket<K, V> = Map<K, Leaf<K, V>>

/** A vector node: leaves (or `null` holes) at shift 0, child nodes above. */
class VNode {
  constructor(
    public edit: Edit,
    public a: unknown[],
  ) {}
}

type Slot<K, V> = Leaf<K, V> | null

const objectIds = new WeakMap<object, number>()
let lastObjectId = 0

/** Per process, so keys cannot be chosen to share a split bucket on purpose. */
const PROCESS_SEED = Math.floor(Math.random() * 0x40000000)
/** The split hash's seed: the process's own, unless a test set one ({@link setSplitSeed}). */
let SEED = PROCESS_SEED
/** A bucket of this process was split: one is read with the seed it was split by. */
let splitOnce = false

/**
 * For a test that must replay exactly: the split hash's seed (`null`: the process's
 * own, random), set before any bucket of the process was split. After one was, changing it
 * throws: that map could no longer find its keys. The app never calls it.
 */
export function setSplitSeed(seed: number | null): void {
  const next = seed === null ? PROCESS_SEED : (seed >>> 0) & 0x3fffffff
  if (next === SEED) return
  if (splitOnce) throw new Error('setSplitSeed: a bucket was split under the seed in force')
  SEED = next
}

/** A key as the text its hashes read: itself for a string, a stable stand-in otherwise. */
function keyText(k: unknown): string {
  if (typeof k === 'string') return k
  if ((typeof k === 'object' && k !== null) || typeof k === 'function') {
    let id = objectIds.get(k)
    if (id === undefined) {
      id = ++lastObjectId
      objectIds.set(k, id)
    }
    return `#${id}`
  }
  // String(-0) is '0', so the keys SameValueZero treats as one hash alike.
  return String(k)
}

const avalanche = (x: number) => {
  let h = x ^ (x >>> 16)
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  return (h ^ (h >>> 16)) & 0x3fffffff
}

/** The root slot hash: the key's length and last four characters (an id's random tail). */
export function hashKey(k: unknown): number {
  const s = typeof k === 'string' ? k : keyText(k)
  const n = s.length
  let h = Math.imul(n, 0x9e3779b1)
  for (let i = n > 4 ? n - 4 : 0; i < n; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return (h ^ (h >>> 15)) & 0x3fffffff
}

/** The split hash: every character, two at a time (FNV-1a on 32-bit words), seeded. */
function fullHash(k: unknown): number {
  const s = keyText(k)
  const n = s.length
  let h = SEED ^ n
  let i = 0
  for (; i + 1 < n; i += 2) {
    h = Math.imul(h ^ (s.charCodeAt(i) | (s.charCodeAt(i + 1) << 16)), 0x01000193)
  }
  if (i < n) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return avalanche(h)
}

const ownV = (edit: Edit, n: VNode) => (n.edit === edit ? n : new VNode(edit, n.a.slice()))

/** The leaf array holding slot `i`. */
function vLeaf(root: VNode, shift: number, i: number): unknown[] {
  let n = root
  for (let s = shift; s > 0; s -= BITS) n = n.a[(i >>> s) & MASK] as VNode
  return n.a
}

/** `node` with slot `i` set to `v`, creating the path when it is new. */
function vSet(edit: Edit, node: VNode | undefined, shift: number, i: number, v: unknown): VNode {
  const n = node === undefined ? new VNode(edit, []) : ownV(edit, node)
  if (shift === 0) n.a[i & MASK] = v
  else {
    const j = (i >>> shift) & MASK
    n.a[j] = vSet(edit, n.a[j] as VNode | undefined, shift - BITS, i, v)
  }
  return n
}

/** A vector of `slots`, built bottom-up. */
function vBuild(edit: Edit, slots: unknown[]): { vec: VNode; shift: number } {
  const chunk = (xs: unknown[]) => {
    const out: VNode[] = []
    for (let i = 0; i < xs.length; i += WIDTH) out.push(new VNode(edit, xs.slice(i, i + WIDTH)))
    return out
  }
  let level = slots.length === 0 ? [new VNode(edit, [])] : chunk(slots)
  let shift = 0
  while (level.length > 1) {
    level = chunk(level)
    shift += BITS
  }
  return { vec: level[0] as VNode, shift }
}

const MAX_ROOT_BITS = 12

/** The root's size in bits for a map of `n` entries: about 25 keys a bucket, 32 to 4,096 buckets. */
const rootBitsFor = (n: number) =>
  Math.min(MAX_ROOT_BITS, Math.max(5, Math.ceil(Math.log2(n + 1)) - 4))

/** A bucket's size limit: one that reaches it is split before it takes another key. */
export const SPLIT_AT = 128

/** A bucket split 32 ways by 5 bits of the whole-key hash; 30 bits allow six levels. */
class Split<K, V> {
  constructor(
    public edit: Edit,
    readonly a: Array<Cell<K, V>>,
  ) {}
}

type Cell<K, V> = Bucket<K, V> | Split<K, V> | undefined

/** The bucket `key` belongs in, if there is one yet. */
function bucketOf<K, V>(root: Array<Cell<K, V>>, key: K): Bucket<K, V> | undefined {
  let c = root[hashKey(key) & (root.length - 1)]
  if (c === undefined || c instanceof Map) return c
  const h = fullHash(key)
  for (let shift = 0; c instanceof Split; shift += BITS) c = c.a[(h >>> shift) & MASK]
  return c
}

/** The parts of one version of a map. */
interface Parts<K, V> {
  root: Array<Cell<K, V>>
  /** The transient that may change `root` in place. */
  rootEdit: Edit
  /** Buckets the transient that made them may change in place. */
  owned: WeakSet<Bucket<K, V>> | null
  vec: VNode
  /** The vector's height, as the shift of its root. */
  shift: number
  /** Slots in the vector, holes included. */
  length: number
  size: number
  holes: number
}

const findLeaf = <K, V>(p: Parts<K, V>, key: K): Leaf<K, V> | undefined =>
  bucketOf(p.root, key)?.get(key)

/** `bucket` (at split level `shift`) spread over a new split by the whole-key hash. */
function split<K, V>(
  edit: Edit,
  bucket: Bucket<K, V>,
  shift: number,
  owned: WeakSet<Bucket<K, V>> | null,
): Split<K, V> {
  splitOnce = true
  const a = new Array<Cell<K, V>>(WIDTH).fill(undefined)
  for (const [k, leaf] of bucket) {
    const j = (fullHash(k) >>> shift) & MASK
    let b = a[j] as Bucket<K, V> | undefined
    if (b === undefined) {
      b = new Map()
      owned?.add(b)
      a[j] = b
    }
    b.set(k, leaf)
  }
  return new Split(edit, a)
}

/**
 * A copy of `bucket` (empty for none), entry by entry: `new Map(bucket)` walks it with an iterator,
 * making an entry array and a result object per key, which in an opening that shows 100,000 notes a
 * tile at a time was most of the maps' garbage (by a heap profile).
 */
function copyBucket<K, V>(bucket: Bucket<K, V> | undefined): Bucket<K, V> {
  const copy: Bucket<K, V> = new Map()
  bucket?.forEach((leaf, k) => {
    copy.set(k, leaf)
  })
  return copy
}

/**
 * The bucket `key` belongs in, writable by `edit`: the root, splits and bucket on its path are
 * copied on their first write (`owned` holds the buckets already copied), or, while building a
 * map (`owned` null), are all new and changed in place. A full bucket is split first.
 */
function writableBucket<K, V>(
  p: Parts<K, V>,
  key: K,
  edit: Edit,
  owned: WeakSet<Bucket<K, V>> | null,
): Bucket<K, V> {
  if (owned && p.rootEdit !== edit) {
    p.root = p.root.slice()
    p.rootEdit = edit
  }
  let cells = p.root
  let j = hashKey(key) & (cells.length - 1)
  let shift = 0
  let h = -1
  for (;;) {
    let c = cells[j]
    if (c instanceof Map && c.size >= SPLIT_AT && shift < 30 && !c.has(key)) {
      c = split(edit, c, shift, owned)
      cells[j] = c
    }
    if (c instanceof Split) {
      if (owned && c.edit !== edit) {
        c = new Split(edit, c.a.slice())
        cells[j] = c
      }
      if (h < 0) h = fullHash(key)
      cells = c.a
      j = (h >>> shift) & MASK
      shift += BITS
      continue
    }
    if (c === undefined || (owned && !owned.has(c))) {
      c = copyBucket(c)
      owned?.add(c)
      cells[j] = c
    }
    return c
  }
}

/** A fresh map's parts holding `entries`: a repeated key keeps its first place and last value. */
function build<K, V>(edit: Edit, entries: Iterable<readonly [K, V]>): Parts<K, V> {
  const list = Array.isArray(entries) ? (entries as ReadonlyArray<readonly [K, V]>) : [...entries]
  const p: Parts<K, V> = {
    root: new Array<Cell<K, V>>(1 << rootBitsFor(list.length)).fill(undefined),
    rootEdit: edit,
    owned: null,
    vec: new VNode(edit, []),
    shift: 0,
    length: 0,
    size: 0,
    holes: 0,
  }
  const slots: Array<Leaf<K, V>> = []
  for (const [key, value] of list) {
    const bucket = writableBucket(p, key, edit, null)
    const found = bucket.get(key)
    // Leaves made here are not shared yet, so a repeat may change its value in place.
    if (found) found.v = value
    else {
      // A native Map stores -0 as 0; the leaf matches it.
      const leaf = new Leaf(Object.is(key, -0) ? (0 as K) : key, value, slots.length)
      bucket.set(key, leaf)
      slots.push(leaf)
    }
  }
  const { vec, shift } = vBuild(edit, slots)
  return { ...p, vec, shift, length: slots.length, size: slots.length }
}

/** Iterates the leaves of a vector in order, skipping holes, giving `pick(leaf)`. */
class SlotIterator<K, V, T> implements MapIterator<T> {
  private leaf: Array<Slot<K, V>> = []
  private at = 0
  private base = -WIDTH

  constructor(
    private readonly p: Parts<K, V>,
    private readonly pick: (leaf: Leaf<K, V>) => T,
  ) {}

  next(): IteratorResult<T, undefined> {
    for (;;) {
      if (this.at < this.leaf.length) {
        const s = this.leaf[this.at++]
        if (s) return { done: false, value: this.pick(s) }
        continue
      }
      this.base += WIDTH
      if (this.base >= this.p.length) return { done: true, value: undefined }
      this.leaf = vLeaf(this.p.vec, this.p.shift, this.base) as Array<Slot<K, V>>
      this.at = 0
    }
  }

  [Symbol.iterator](): this {
    return this
  }
}

// Like a native Map iterator, so iterator helpers (`map`, `toArray`, …) work where the runtime has them.
const IteratorPrototype = (globalThis as { Iterator?: { prototype: object } }).Iterator?.prototype
if (IteratorPrototype) Object.setPrototypeOf(SlotIterator.prototype, IteratorPrototype)

const pickKey = <K, V>(l: Leaf<K, V>) => l.k
const pickValue = <K, V>(l: Leaf<K, V>) => l.v
const pickEntry = <K, V>(l: Leaf<K, V>): [K, V] => [l.k, l.v]

let partsOf: <K, V>(m: MapView<K, V>) => Parts<K, V>

/** The reading half of `ReadonlyMap`, shared by both kinds of map. Internals stay private. */
abstract class MapView<K, V> implements ReadonlyMap<K, V> {
  readonly #p: Parts<K, V>

  constructor(p: Parts<K, V>) {
    this.#p = p
  }

  static {
    partsOf = <K, V>(m: MapView<K, V>) => m.#p
  }

  get size(): number {
    return this.#p.size
  }

  get(key: K): V | undefined {
    return bucketOf(this.#p.root, key)?.get(key)?.v
  }

  has(key: K): boolean {
    return bucketOf(this.#p.root, key)?.has(key) ?? false
  }

  forEach(fn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    const { vec, shift, length } = this.#p
    for (let i = 0; i < length; i += WIDTH) {
      for (const s of vLeaf(vec, shift, i) as Array<Slot<K, V>>) {
        if (s) fn.call(thisArg, s.v, s.k, this)
      }
    }
  }

  entries(): MapIterator<[K, V]> {
    return new SlotIterator(this.#p, pickEntry)
  }

  keys(): MapIterator<K> {
    return new SlotIterator(this.#p, pickKey)
  }

  values(): MapIterator<V> {
    return new SlotIterator(this.#p, pickValue)
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.entries()
  }
}

let makePMap: <K, V>(p: Parts<K, V>) => PMap<K, V>
let makeTransient: <K, V>(p: Parts<K, V>) => TransientMap<K, V>

/** A persistent map: `set` and `delete` return a new map and never change this one. */
export class PMap<K, V> extends MapView<K, V> {
  static {
    makePMap = (p) => new PMap(p)
  }

  /** A map of `entries`, in their order; a repeated key keeps its first place and last value. */
  static from<K, V>(entries: Iterable<readonly [K, V]> = []): PMap<K, V> {
    return new PMap(build(null, entries))
  }

  /**
   * An empty map with its root sized for about `n` entries: a transient filled from it up to that
   * size never widens its root (an O(n) rebuild each time, at ~1k, 4k, 16k and 65k entries).
   */
  static sized<K, V>(n: number): PMap<K, V> {
    const p = build<K, V>(null, [])
    p.root = new Array<Cell<K, V>>(1 << rootBitsFor(Math.max(0, n))).fill(undefined)
    return new PMap(p)
  }

  private constructor(p: Parts<K, V>) {
    super(p)
  }

  /** This map with `key` set to `value`: this same map when it already holds that value. */
  set(key: K, value: V): PMap<K, V> {
    const found = findLeaf(partsOf(this), key)
    if (found && Object.is(found.v, value)) return this
    return this.asTransient().set(key, value).persist()
  }

  /** This map without `key`: this same map when it has no such key. */
  delete(key: K): PMap<K, V> {
    if (!this.has(key)) return this
    const t = this.asTransient()
    t.delete(key)
    return t.persist()
  }

  /** A transient starting from this map; this map is never changed by it. */
  asTransient(): TransientMap<K, V> {
    return makeTransient({ ...partsOf(this), rootEdit: null, owned: null })
  }

  get [Symbol.toStringTag](): string {
    return 'PMap'
  }
}

/**
 * A map changed in place, cheaply, until {@link TransientMap.persist}; it must not be written
 * after that. Iterating it while writing it is not supported.
 */
export class TransientMap<K, V> extends MapView<K, V> {
  /** The token on the pieces this transient may change in place; `null` once persisted. */
  #edit: Edit = {}

  static {
    makeTransient = (p) => new TransientMap(p)
  }

  private constructor(p: Parts<K, V>) {
    super(p)
  }

  #writable(): Edit {
    if (this.#edit === null) throw new Error('TransientMap written after persist()')
    return this.#edit
  }

  /** The bucket for `key`, copied on its first write by this transient; created if absent. */
  #bucket(edit: Edit, key: K): Bucket<K, V> {
    const p = partsOf(this)
    p.owned ??= new WeakSet()
    return writableBucket(p, key, edit, p.owned)
  }

  set(key: K, value: V): this {
    const edit = this.#writable()
    const p = partsOf(this)
    const found = findLeaf(p, key)
    if (found) {
      const leaf = new Leaf(found.k, value, found.i)
      this.#bucket(edit, key).set(key, leaf)
      p.vec = vSet(edit, p.vec, p.shift, found.i, leaf)
      return this
    }
    const leaf = new Leaf(Object.is(key, -0) ? (0 as K) : key, value, p.length)
    this.#bucket(edit, key).set(key, leaf)
    if (p.length === WIDTH << p.shift) {
      p.vec = new VNode(edit, [p.vec])
      p.shift += BITS
    }
    p.vec = vSet(edit, p.vec, p.shift, p.length, leaf)
    p.length++
    p.size++
    // A map grown by writes gets a wider root, as a hash table grows: O(n), at ~1k, 4k, 16k, 65k.
    if (p.size > 32 * p.root.length && p.root.length < 1 << MAX_ROOT_BITS) {
      Object.assign(p, build(edit, [...this.entries()]))
    }
    return this
  }

  /** Whether `key` was there. */
  delete(key: K): boolean {
    const edit = this.#writable()
    const p = partsOf(this)
    const found = findLeaf(p, key)
    if (found === undefined) return false
    this.#bucket(edit, key).delete(key)
    p.vec = vSet(edit, p.vec, p.shift, found.i, null)
    p.size--
    p.holes++
    // Rebuild without holes: O(n), and only after deletes have left more holes than entries.
    if (p.holes * 2 > p.length) Object.assign(p, build(edit, [...this.entries()]))
    return true
  }

  /** The finished map. This transient must not be written again. */
  persist(): PMap<K, V> {
    this.#writable()
    this.#edit = null
    return makePMap({ ...partsOf(this), rootEdit: null, owned: null })
  }

  get [Symbol.toStringTag](): string {
    return 'TransientMap'
  }
}

/** What changed from one map to another: keys new or with another value, and keys gone. */
export interface MapChanges<K> {
  readonly set: K[]
  readonly deleted: K[]
}

/**
 * The keys `after` sets (new, or to a value that is not `Object.is` the one in `before`) and
 * deletes, or null once more than `limit` keys have changed, or once finding out would cost more
 * than about that many keys' work. Two versions of one {@link PMap} share every vector node an
 * edit left alone, so only the nodes on the paths of changed slots are visited: O(changes ×
 * log n), whatever the size. Two that share little (a board loaded again, a rebuild) are given up
 * on after O(limit × log n), never walked whole; with no limit (`Infinity`) they cost O(n), and
 * the answer is the same. Plain `Map`s are walked (O(n)), and answer null only past `limit`
 * changes.
 */
export function mapChangesWithin<K, V>(
  before: ReadonlyMap<K, V>,
  after: ReadonlyMap<K, V>,
  limit: number,
): MapChanges<K> | null {
  return changesUpTo(before, after, Math.max(0, limit))
}

/** Thrown inside the walk to stop it: past the limit. */
const PAST = Symbol('past the limit')

function changesUpTo<K, V>(
  before: ReadonlyMap<K, V>,
  after: ReadonlyMap<K, V>,
  limit: number,
): MapChanges<K> | null {
  const set: K[] = []
  const deleted: K[] = []
  if (before === after) return { set, deleted }
  if (!(before instanceof PMap && after instanceof PMap)) {
    for (const [k, v] of after) {
      if (before.has(k) && Object.is(before.get(k), v)) continue
      set.push(k)
      if (set.length > limit) return null
    }
    for (const k of before.keys()) {
      if (after.has(k)) continue
      deleted.push(k)
      if (set.length + deleted.length > limit) return null
    }
    return { set, deleted }
  }
  const a = partsOf(before as PMap<K, V>)
  const b = partsOf(after as PMap<K, V>)
  // Leaves in a slot that differs: a leaf is never changed once shared and always sits in its
  // own slot, so a key whose value differs has a different leaf there in at least one version.
  // A changed key shows at most two such leaves (its old and its new); a leaf that only moved
  // slot (a rebuild) shows two that are no change, so the leaves looked at are capped as well.
  const most = limit === Number.POSITIVE_INFINITY ? limit : 4 * limit + 64
  let seen = 0
  const look = (p: Leaf<K, V> | undefined, q: Leaf<K, V> | undefined) => {
    if (q) {
      const was = findLeaf(a, q.k)
      if (was === undefined || !Object.is(was.v, q.v)) set.push(q.k)
    }
    if (p && findLeaf(b, p.k) === undefined) deleted.push(p.k)
    seen += (p ? 1 : 0) + (q ? 1 : 0)
    if (set.length + deleted.length > limit || seen > most) throw PAST
  }
  // A vector that grew a level keeps its old root as the first child: lift the lower one.
  let x: VNode | undefined = a.vec
  let y: VNode | undefined = b.vec
  for (let s = a.shift; s < b.shift; s += BITS) x = new VNode(null, [x])
  for (let s = b.shift; s < a.shift; s += BITS) y = new VNode(null, [y])
  const walk = (x: VNode | undefined, y: VNode | undefined, shift: number): void => {
    if (x === y) return
    const xs = x?.a ?? []
    const ys = y?.a ?? []
    const n = Math.max(xs.length, ys.length)
    for (let j = 0; j < n; j++) {
      const p = xs[j]
      const q = ys[j]
      if (p === q) continue
      if (shift > 0) walk(p as VNode | undefined, q as VNode | undefined, shift - BITS)
      else look(p as Leaf<K, V> | undefined, q as Leaf<K, V> | undefined)
    }
  }
  try {
    walk(x, y, Math.max(a.shift, b.shift))
  } catch (e) {
    if (e === PAST) return null
    throw e
  }
  return { set, deleted }
}

/** The most keys any one bucket of `map` holds. For tests: a write copies at most this many. */
export function largestBucket<K, V>(map: PMap<K, V>): number {
  let most = 0
  const walk = (cells: ReadonlyArray<Cell<K, V>>): void => {
    for (const c of cells) {
      if (c instanceof Split) walk(c.a)
      else if (c) most = Math.max(most, c.size)
    }
  }
  walk(partsOf(map).root)
  return most
}
