/** The types of `checkPackages.mjs`. */
export interface Target {
  platform: string
  arch: string
}
export interface PackedFile {
  path: string
  unpacked: boolean
}
export const TARGETS: ReadonlyArray<Target & { os: string; dir: string; res: string }>
export function artifacts(version: string): string[]
export function asarFiles(buf: Buffer): PackedFile[]
export function binaryTarget(buf: Buffer): Target | null
export function problems(
  files: readonly PackedFile[],
  target: Target,
  binary: (path: string) => Buffer,
): string[]
