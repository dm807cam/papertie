/** The types of `sharpTarget.mjs`. */
export const TARGETS_DIR: string
export const BUILDER_OS: Record<'darwin' | 'linux' | 'win32', string>
export function sharpPackages(
  optionalDependencies: Record<string, string>,
  platform: string,
  arch: string,
): Array<{ name: string; version: string }>
export function lockedIntegrity(lockfile: string, name: string, version: string): string
export function matchesIntegrity(bytes: Uint8Array, integrity: string): boolean
export function tarballUrl(registry: string, name: string, version: string): string
export function stageSharp(platform: 'darwin' | 'linux' | 'win32', arch: string): Promise<string>
