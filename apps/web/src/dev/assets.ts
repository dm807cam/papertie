import { type AssetSize, setLocalAssetResolver } from '../lib/assets'

/** Placeholder asset id carried by the prototype's print notes. */
export const PROTO_ASSET_ID = 'asset_01JBPR0T0SAMP1E000000PR1NT'

/** The demo board's generated print illustrations, by subject. */
export const PROTO_ASSETS = {
  /** A lake among hills, 4:3. */
  lake: 'asset_01JBPR0T0PR1NT000000000001',
  /** A writing desk with paper, ink bottle and pen, 4:3. */
  desk: 'asset_01JBPR0T0PR1NT000000000002',
  /** A field under a wide sky, 3:5 portrait. */
  field: 'asset_01JBPR0T0PR1NT000000000003',
} as const

const FILES: ReadonlyMap<string, string> = new Map([
  [PROTO_ASSET_ID, 'print-sample'],
  [PROTO_ASSETS.lake, 'print-lake'],
  [PROTO_ASSETS.desk, 'print-desk'],
  [PROTO_ASSETS.field, 'print-field'],
])

/**
 * URL of a sample print's size variant, or null for any other id. The local boards have no
 * server: the illustration ids map to their files in `/textures` (committed in 256 and 1024; the
 * 2560 size answers with the 1024 file).
 */
export function localAssetUrl(assetId: string, size: AssetSize): string | null {
  const file = FILES.get(assetId)
  return file === undefined ? null : `/textures/${file}-${size === 256 ? 256 : 1024}.webp`
}

// Importing this module is what makes local boards' prints resolve: anything that builds a board
// with these ids imports it. The production board path never does.
setLocalAssetResolver(localAssetUrl)
