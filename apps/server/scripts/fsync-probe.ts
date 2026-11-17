// Measures whether Node's FileHandle.sync() does a full flush on this machine.
// On macOS libuv's fsync issues fcntl(F_FULLFSYNC) (src/unix/fs.c, uv__fs_fsync), which costs
// milliseconds; a plain fsync(2) returns in microseconds without flushing the drive cache.
// Run: pnpm --filter @papertie/server exec tsx scripts/fsync-probe.ts
import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ITERATIONS = 200
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0
const ms = (start: bigint) => Number(process.hrtime.bigint() - start) / 1e6

const dir = await mkdtemp(join(tmpdir(), 'papertie-fsync-'))
try {
  const block = Buffer.alloc(4096, 0x61)
  const writeOnly: number[] = []
  const writeSync: number[] = []

  const a = await open(join(dir, 'write-only'), 'w', 0o600)
  for (let i = 0; i < ITERATIONS; i++) {
    const t = process.hrtime.bigint()
    await a.write(block)
    writeOnly.push(ms(t))
  }
  await a.close()

  const b = await open(join(dir, 'write-sync'), 'w', 0o600)
  for (let i = 0; i < ITERATIONS; i++) {
    const t = process.hrtime.bigint()
    await b.write(block)
    await b.sync()
    writeSync.push(ms(t))
  }
  await b.close()

  let dirResult = 'ok'
  const dirTimes: number[] = []
  try {
    // Dirty the directory each round (new entry) so there is something to flush.
    const d = await open(dir, 'r')
    for (let i = 0; i < 50; i++) {
      await (await open(join(dir, `entry-${i}`), 'w', 0o600)).close()
      const t = process.hrtime.bigint()
      await d.sync()
      dirTimes.push(ms(t))
    }
    await d.close()
  } catch (e) {
    dirResult = `error ${(e as NodeJS.ErrnoException).code ?? String(e)}`
  }

  const fixed = (n: number) => n.toFixed(3)
  console.log(`node ${process.version} uv ${process.versions.uv} on ${process.platform}`)
  console.log(`write only      median ${fixed(median(writeOnly))} ms (n=${ITERATIONS})`)
  console.log(`write + sync    median ${fixed(median(writeSync))} ms (n=${ITERATIONS})`)
  console.log(
    `dir fsync       ${dirResult}, median ${fixed(median(dirTimes))} ms (n=${dirTimes.length})`,
  )
  const flushed = median(writeSync) >= 1
  console.log(
    flushed
      ? 'RESULT: sync median >= 1 ms, consistent with a full flush (F_FULLFSYNC).'
      : 'RESULT: sync median < 1 ms, NOT consistent with a full flush.',
  )
} finally {
  await rm(dir, { recursive: true, force: true })
}
