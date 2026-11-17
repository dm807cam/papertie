const MIB = 1_048_576

/** Size and count limits (Global Constraints). 1 MB = 1,048,576 bytes. */
export const SERVER_LIMITS = {
  opsBodyBytes: MIB,
  jsonBodyBytes: 65_536,
  uploadFileBytes: 25 * MIB,
  uploadBodyBytes: 25 * MIB + 65_536,
  /** Photo storage per user: 64 GB, a lifetime of photos. */
  quotaBytes: 68_719_476_736,
  /**
   * Bytes all imports may hold on disk while staged: one lifetime board's photos and text. Free
   * disk less 2 GB bounds it as well.
   */
  importStagingBytes: 68_719_476_736 + 1_073_741_824,
  maxBoardsPerUser: 50,
  imageMaxInputPixels: 64_000_000,
  imageQuality: 82,
  imageConcurrency: 2,
  clientMarkMaxAgeMs: 90 * 86_400_000,
  stageMaxParts: 64,
  stagePartBytes: MIB,
  stagePartOps: 500,
  stageBytesPerBoard: 64 * MIB,
  stageBytesServer: 256 * MIB,
  stageIdleMs: 300_000,
} as const

/**
 * Journal compaction (ADR-0001, Snapshot + journal): a fresh snapshot once the journal passes
 * either size, or after this long without a commit while it holds any.
 */
export const JOURNAL_MAX_BYTES = 4 * MIB
export const JOURNAL_MAX_COMMITS = 2000
export const COMPACT_IDLE_MS = 60_000

/**
 * A deleted book (`trashedAt` set) is purged once it has been deleted this long (`bookPurge.ts`):
 * until then "Put it back" brings it back whole.
 */
export const BOOK_TRASH_MS = 30 * 86_400_000

/**
 * Whether a book deleted at `trashedAt` is past its window at `nowMs`: due for the purge (or being
 * purged), and so no longer put back (never a book missing its purged paragraphs).
 */
export const pastTrash = (trashedAt: string | null | undefined, nowMs: number): boolean =>
  trashedAt != null && nowMs - Date.parse(trashedAt) > BOOK_TRASH_MS

/** Long edge, in px, of each stored WebP variant. */
export const ASSET_SIZES = [2560, 1024, 256] as const
export type AssetSize = (typeof ASSET_SIZES)[number]

/**
 * An asset is collected only once it is this old, and only when no
 * note on the board or in a retained backup shows it (`store/assetSweep.ts`).
 */
export const ASSET_GRACE_MS = 30 * 24 * 3600 * 1000
