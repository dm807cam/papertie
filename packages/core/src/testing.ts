/**
 * Seams for tests that must replay exactly: ids' random bits and the maps' split seed.
 * A subpath of its own (`@papertie/core/testing`), so the app's code cannot reach them:
 * biome forbids the import under `apps/*\/src`.
 */
export { setIdRandomness } from './ids'
export { setSplitSeed } from './pmap'
