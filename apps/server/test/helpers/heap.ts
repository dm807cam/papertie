import v8 from 'node:v8'

/** The old generation's spaces: what a major (mark-compact) collection has to trace and sweep. */
const OLD = new Set([
  'old_space',
  'large_object_space',
  'code_space',
  'code_large_object_space',
  'trusted_space',
  'trusted_large_object_space',
])

/** `v8.getHeapSpaceStatistics()` spells its fields in snake case, `GCProfiler` in camel case. */
type Space = {
  space_name?: string
  space_used_size?: number
  spaceName?: string
  spaceUsedSize?: number
}

const oldGenBytes = (spaces: ReadonlyArray<Space>) => {
  let bytes = 0
  for (const s of spaces) {
    if (OLD.has(s.space_name ?? s.spaceName ?? ''))
      bytes += s.space_used_size ?? s.spaceUsedSize ?? 0
  }
  return bytes
}

/**
 * The bytes `fn` put into V8's old generation (promoted by a scavenge, or allocated there directly
 * as a large object), whether they are still held at the end or a major collection freed them
 * meanwhile. Garbage there is what drives the major collections whose pauses, at a 100,000-note
 * board's heap, held a Raspberry Pi's loop for 38–67 ms. Buffers'
 * bytes live outside the V8 heap and are not counted. A full collection runs first (needs
 * `--expose-gc`, which the suite has), unless the caller ran one itself (`collected`): one inside
 * a window whose iterations are timed would be taken for the code's.
 */
export async function oldGenAllocated<T>(
  fn: () => Promise<T>,
  { collected = false } = {},
): Promise<{ result: T; mb: number; heldMb: number; majorGcs: number }> {
  if (!collected) (globalThis as { gc?: () => void }).gc?.()
  const before = oldGenBytes(v8.getHeapSpaceStatistics())
  const profiler = new v8.GCProfiler()
  profiler.start()
  let result: T
  let stats: ReturnType<v8.GCProfiler['stop']>
  try {
    result = await fn()
  } finally {
    stats = profiler.stop()
  }
  const after = oldGenBytes(v8.getHeapSpaceStatistics())
  let freed = 0
  let majorGcs = 0
  for (const g of stats.statistics) {
    const d =
      oldGenBytes(g.beforeGC.heapSpaceStatistics as Space[]) -
      oldGenBytes(g.afterGC.heapSpaceStatistics as Space[])
    if (d > 0) freed += d
    if (g.gcType === 'MarkSweepCompact') majorGcs++
  }
  return { result, mb: (after - before + freed) / 1e6, heldMb: (after - before) / 1e6, majorGcs }
}
