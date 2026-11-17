import { type AssetSize, assetUrl as serverAssetUrl } from '../api/assets'

export type { AssetSize }

type LocalResolver = (assetId: string, size: AssetSize) => string | null

let local: LocalResolver | null = null

/**
 * Lets local dev boards (no server) show their sample prints: `dev/assets` registers itself here
 * when it is loaded, so this module never imports it and the samples stay out of the production
 * board's bundle.
 */
export function setLocalAssetResolver(resolver: LocalResolver | null): void {
  local = resolver
}

/** URL of an asset's size variant: a local sample print if one is registered for it, else the server's. */
export function assetUrl(assetId: string, size: AssetSize): string {
  return local?.(assetId, size) ?? serverAssetUrl(assetId, size)
}
