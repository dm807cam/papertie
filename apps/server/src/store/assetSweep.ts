import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import type { Op } from '@papertie/core'
import type { QuotaTracker } from '../assets/quota'
import { ulidTimeMs } from '../ids'
import { ASSET_GRACE_MS } from '../limits'
import type { Logger } from '../log'
import { assetDirIds, removeAssetFiles } from './assetFiles'
import { listBackups } from './backups'
import type { BoardStore } from './boardStore'
import { SLICE_MS, Slicer } from './compact'
import { isEnoent } from './durable'
import { StoreError } from './errors'
import { type Faults, noFaults } from './faults'
import { JOURNAL_FILE } from './journal'
import { boardDir } from './paths'

export interface AssetSweepResult {
  /** The asset records this run took off the board. Their files stay for a later run. */
  removed: string[]
  /** The bytes of the record-less asset directories this run deleted, credited to the quota. */
  freedBytes: number
  /** The board was not loaded, so nothing was read or done: it is swept after its next load. */
  deferred?: true
}

export interface AssetSweepDeps {
  quota: QuotaTracker
  faults?: Faults
}

/** An image reference as the server writes it (`"assetId":"asset_…"`), spaces allowed. */
const REF_RE = /"assetId"\s*:\s*"(asset_[0-9A-HJKMNP-TV-Z]{26})"/g
/**
 * An asset record (on its own line, or inside an `asset.add` op) with its `createdAt`, or an
 * `asset.remove` op: one pattern, so a journal's adds and removes come in the order they were made.
 */
const RECORD_RE =
  /"type":"asset","id":"(asset_[0-9A-HJKMNP-TV-Z]{26})"[^}]*?"createdAt":"([^"]*)"|"op":"asset\.remove","id":"(asset_[0-9A-HJKMNP-TV-Z]{26})"/g
/** Chars of one chunk kept for the next, so a match cut by a chunk boundary is still found. */
const OVERLAP = 1024

interface Found {
  /** Called with each asset id an image reference names. */
  ref(id: string): void
  /** Called with each asset record and its `createdAt`, and with `null` for an `asset.remove`. */
  record?(id: string, createdAt: string | null): void
  /** True once nothing more needs to be read. */
  done(): boolean
}

/**
 * Stream the JSONL at `path` (a snapshot, a journal or a backup) and report what it names. Read in
 * 64 KiB chunks with no JSON parse, so a line of any length costs nothing extra, and yielding to
 * the event loop at least every `SLICE_MS`. A file that is not there names nothing.
 */
async function scanFile(path: string, found: Found): Promise<void> {
  const stream = createReadStream(path, { encoding: 'utf8', highWaterMark: 65_536 })
  const s = await Slicer.start(SLICE_MS)
  let tail = ''
  try {
    for await (const chunk of stream as AsyncIterable<string>) {
      const text = tail + chunk
      for (const m of text.matchAll(REF_RE)) found.ref(m[1] as string)
      if (found.record) {
        for (const m of text.matchAll(RECORD_RE)) {
          if (m[3] !== undefined) found.record(m[3], null)
          else found.record(m[1] as string, m[2] as string)
        }
      }
      if (found.done()) return
      tail = text.slice(-OVERLAP)
      if (s.due()) await s.pause()
    }
  } catch (e) {
    if (!isEnoent(e)) throw e
  } finally {
    stream.destroy()
  }
}

/**
 * The ids among `ids` that a retained backup of the board in `dir` names, by an image reference
 * or an asset record: the reference check the sweep makes before it deletes files (`scanFile`,
 * streamed and sliced), stopping as soon as every id is found. An import's rollback asks it too,
 * so it never deletes a photo that restoring a backup would show.
 */
export async function namedInBackups(dir: string, ids: ReadonlySet<string>): Promise<Set<string>> {
  const found = new Set<string>()
  const see = (id: string) => {
    if (ids.has(id)) found.add(id)
  }
  for (const b of await listBackups(dir)) {
    if (found.size === ids.size) break
    await scanFile(join(dir, 'backups', b.file), {
      ref: see,
      record: (id) => see(id),
      done: () => found.size === ids.size,
    })
  }
  return found
}

/**
 * Commit `asset.remove` for `ids` (none: no commit) through `submit`, which is false when the
 * board is no longer loaded. Resolves to the ids taken off, `[]` when the batch was refused (a
 * note shows one of them again, an undone delete say: the next run tries again), or null when the
 * board was not loaded.
 */
async function removeRecords(
  ids: string[],
  submit: (ops: Op[]) => Promise<boolean>,
  log: Logger,
  faults: Faults,
): Promise<string[] | null> {
  if (ids.length === 0) return ids
  try {
    if (!(await submit(ids.map((id) => ({ op: 'asset.remove', id }))))) return null
  } catch (e) {
    if (!(e instanceof StoreError && e.code === 'rejected')) throw e
    log.warn('asset sweep skipped', { count: ids.length })
    return []
  }
  faults.hit('asset-sweep:after-commit')
  log.info('asset records removed', { count: ids.length })
  return ids
}

/** When `id`'s asset was made: the later of the time in its id and its record's `createdAt`. */
function madeAt(id: string, createdAt: string | undefined): number {
  const recorded = createdAt === undefined ? Number.NaN : Date.parse(createdAt)
  const t = ulidTimeMs(id)
  return Number.isNaN(recorded) ? t : Math.max(t, recorded)
}

/**
 * Collect the board's assets nothing needs any more (ADR-0001 Asset sweep).
 * An asset is collected once it is `ASSET_GRACE_MS` old (by the later of its record's `createdAt`
 * and the time in its id), no note on the board shows it and no note in a retained backup does.
 * Collection takes two runs, so files are never deleted in the run whose commit freed them:
 *
 * - **Its record** goes first: one server batch of `asset.remove` for the candidates that have a
 *   record (`submitServerIfCached`). The writer applies it after the commits queued before it,
 *   and the op's invariant re-checks there that no note shows any of them; if one does by then,
 *   the batch is refused whole and the next run tries again. A record whose directory is
 *   already gone goes the same way.
 * - **Its directory** goes on a later run (`AssetSweeper` keeps a board's runs about a day
 *   apart), once it has no record: then the directory is deleted and its bytes credited to the
 *   quota (`QuotaTracker.credit`), the only place the quota is credited. That run reads every
 *   retained backup again, including one a compaction installed after the commit, so a backup
 *   that still shows the photo always keeps its files. An upload that died before its commit
 *   leaves such a directory too.
 *
 * Only a board that is loaded is swept: anything else returns `deferred` at once, having read
 * nothing (a load is an unsliced parse; the server sweeps the board after its next load instead).
 * Reading happens outside the board's writer, streamed (`scanFile`): `journal.jsonl`, then
 * `board.jsonl`, then each retained backup, newest first, stopping once nothing is left. A board
 * with no asset directory past the grace period reads no more than `assets/`. Logs only counts and
 * bytes.
 */
export async function sweepAssets(
  dataDir: string,
  userId: string,
  boardId: string,
  now: Date,
  store: BoardStore,
  log: Logger,
  deps: AssetSweepDeps,
): Promise<AssetSweepResult> {
  const none: AssetSweepResult = { removed: [], freedBytes: 0 }
  const deferred: AssetSweepResult = { ...none, deferred: true }
  if (!store.isCached(userId, boardId)) return deferred
  const dir = boardDir(dataDir, userId, boardId)
  const cutoff = now.getTime() - ASSET_GRACE_MS
  const onDisk = new Set(await assetDirIds(dir))
  if (![...onDisk].some((id) => ulidTimeMs(id) <= cutoff)) return none

  // The journal before the snapshot: a compaction renames its new board.jsonl into place before it
  // rotates the journal, so whichever side of either step each read lands on, the journal read
  // first holds every commit after the board.jsonl read second (or the same ones again). Its adds
  // and removes come after the snapshot's records, so its last word on an id stands. An image
  // reference in it counts even when a later commit deleted that note: that only keeps the asset
  // until the journal is compacted.
  const shown = new Set<string>()
  const journal = new Map<string, string | null>()
  const records = new Map<string, string>()
  await scanFile(join(dir, JOURNAL_FILE), {
    ref: (id) => shown.add(id),
    record: (id, at) => journal.set(id, at),
    done: () => false,
  })
  await scanFile(join(dir, 'board.jsonl'), {
    ref: (id) => shown.add(id),
    record: (id, at) => {
      if (at !== null) records.set(id, at)
    },
    done: () => false,
  })
  for (const [id, at] of journal) {
    if (at === null) records.delete(id)
    else records.set(id, at)
  }
  const left = new Set(
    [...onDisk, ...records.keys()].filter(
      (id) => !shown.has(id) && madeAt(id, records.get(id)) <= cutoff,
    ),
  )
  for (const b of await listBackups(dir)) {
    if (left.size === 0) break
    await scanFile(join(dir, 'backups', b.file), {
      ref: (id) => left.delete(id),
      done: () => left.size === 0,
    })
  }
  if (left.size === 0) return none

  const removed = await removeRecords(
    [...left].filter((id) => records.has(id)).sort(),
    async (ops) => (await store.submitServerIfCached(userId, boardId, ops)) !== null,
    log,
    deps.faults ?? noFaults,
  )
  if (removed === null) return deferred

  // Directories with no record when the board was read: the commit of theirs was an earlier run's.
  const orphans = [...left].filter((id) => !records.has(id) && onDisk.has(id)).sort()
  let freedBytes = 0
  for (const id of orphans) {
    freedBytes += await deps.quota.credit(userId, () => removeAssetFiles(dir, id))
  }
  if (orphans.length > 0)
    log.info('asset files deleted', { count: orphans.length, bytes: freedBytes })
  return { removed, freedBytes }
}
