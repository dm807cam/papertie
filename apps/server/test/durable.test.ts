import { randomInt } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ApiError } from '../src/http/errors'
import {
  appendLineDurable,
  copyDurable,
  fsyncDir,
  stampOf,
  writeAll,
  writeFileDurable,
} from '../src/store/durable'
import { type FaultPoint, type Faults, faultsFromEnv, noFaults } from '../src/store/faults'
import { KeyedMutex } from '../src/store/mutex'
import { assetDir, boardDir, userDir } from '../src/store/paths'

const USER = `user_${'0'.repeat(26)}`
const BOARD = `board_${'Z'.repeat(26)}`
const ASSET = `asset_${'1'.repeat(26)}`

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'papertie-durable-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

class Boom extends Error {}
function throwAt(point: FaultPoint, seen: FaultPoint[] = []): Faults {
  return {
    hit(p) {
      seen.push(p)
      if (p === point) throw new Boom(p)
    },
  }
}

describe('writeFileDurable', () => {
  it('writes the exact bytes, leaves no tmp, and returns the stamp of the new inode', async () => {
    const path = join(dir, 'board.jsonl')
    await writeFile(path, 'old')
    const before = await stampOf(path)
    const stamp = await writeFileDurable(path, 'héllo\n', noFaults, 'snapshot')
    expect((await readFile(path)).toString('utf8')).toBe('héllo\n')
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([])
    expect(stamp).toEqual(await stampOf(path))
    expect(stamp.size).toBe(Buffer.byteLength('héllo\n'))
    expect(stamp.ino).not.toBe(before?.ino)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('accepts bytes', async () => {
    const path = join(dir, 'a.webp')
    await writeFileDurable(path, new Uint8Array([1, 2, 3]), noFaults, 'asset')
    expect([...(await readFile(path))]).toEqual([1, 2, 3])
  })

  it('syncs the tmp file before renaming (fault after tmp fsync leaves original intact)', async () => {
    const path = join(dir, 'board.jsonl')
    await writeFile(path, 'original')
    await expect(
      writeFileDurable(path, 'replacement', throwAt('snapshot:after-tmp-fsync'), 'snapshot'),
    ).rejects.toBeInstanceOf(Boom)
    expect(await readFile(path, 'utf8')).toBe('original')
    expect(await readFile(`${path}.tmp`, 'utf8')).toBe('replacement')
  })

  it('fires the snapshot points in order', async () => {
    const seen: FaultPoint[] = []
    await writeFileDurable(join(dir, 'b'), 'abcd', throwAt('backup:after-write', seen), 'snapshot')
    expect(seen).toEqual([
      'snapshot:partial-tmp',
      'snapshot:after-tmp-write',
      'snapshot:after-tmp-fsync',
      'snapshot:after-rename',
      'snapshot:after-dir-fsync',
    ])
  })

  it('has exactly floor(len/2) bytes in tmp at partial-tmp', async () => {
    const path = join(dir, 'board.jsonl')
    let size = -1
    const faults: Faults = {
      hit(p) {
        if (p === 'snapshot:partial-tmp') {
          size = readFileSync(`${path}.tmp`).length
          throw new Boom(p)
        }
      },
    }
    await expect(writeFileDurable(path, 'x'.repeat(11), faults, 'snapshot')).rejects.toBeInstanceOf(
      Boom,
    )
    expect(size).toBe(5)
    expect((await stat(`${path}.tmp`)).size).toBe(5)
  })

  it('fires no fault points for assets', async () => {
    const seen: FaultPoint[] = []
    await writeFileDurable(join(dir, 'a'), 'abcd', throwAt('asset:after-files', seen), 'asset')
    expect(seen).toEqual([])
  })
})

describe('fsyncDir / copyDurable / appendLineDurable / stampOf', () => {
  it('fsyncDir succeeds on a directory', async () => {
    await expect(fsyncDir(dir)).resolves.toBeUndefined()
  })

  it('copyDurable makes a byte-exact file of its own, never a link', async () => {
    const src = join(dir, 'src')
    const bytes = Buffer.from([0x7b, 0xff, 0x00, 0xe7, 0xb5, 0x90, 0x0a]) // not valid UTF-8
    await writeFile(src, bytes, { mode: 0o600 })
    await copyDurable(src, join(dir, 'dest'))
    const dest = await stat(join(dir, 'dest'))
    expect(dest.ino).not.toBe((await stat(src)).ino)
    expect(dest.nlink).toBe(1)
    expect(await readFile(join(dir, 'dest'))).toEqual(bytes)
    await writeFile(src, 'changed in place')
    expect(await readFile(join(dir, 'dest'))).toEqual(bytes)
    expect(await readdir(dir)).toEqual(['dest', 'src'])
  })

  it('copyDurable never replaces an existing file', async () => {
    const src = join(dir, 'src')
    await writeFile(src, 'new')
    await writeFile(join(dir, 'dest'), 'kept')
    await expect(copyDurable(src, join(dir, 'dest'))).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(join(dir, 'dest'), 'utf8')).toBe('kept')
    expect(await readdir(dir)).toEqual(['dest', 'src'])
  })

  it('appendLineDurable appends newline-terminated lines with mode 0600', async () => {
    const path = join(dir, 'repairs.jsonl')
    await appendLineDurable(path, '{"a":1}')
    await appendLineDurable(path, '{"b":2}')
    expect(await readFile(path, 'utf8')).toBe('{"a":1}\n{"b":2}\n')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('stampOf returns null for a missing file and rethrows other errors', async () => {
    expect(await stampOf(join(dir, 'nope'))).toBeNull()
    await writeFile(join(dir, 'f'), '')
    await expect(stampOf(join(dir, 'f', 'child'))).rejects.toThrow()
  })
})

describe('writeAll', () => {
  const fake = (chunk: number) => {
    const out: number[] = []
    return {
      out,
      write: async (buf: Uint8Array, offset: number, length: number) => {
        const n = Math.min(chunk, length)
        out.push(...buf.subarray(offset, offset + n))
        return { bytesWritten: n }
      },
    }
  }

  it('loops over short writes until every byte is written, in order', async () => {
    const fh = fake(3)
    await writeAll(fh, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 2, 8)
    expect(fh.out).toEqual([3, 4, 5, 6, 7, 8])
  })

  it('throws when a write makes no progress', async () => {
    await expect(writeAll(fake(0), new Uint8Array([1, 2]), 0, 2)).rejects.toThrow('no progress')
  })

  it('does nothing for an empty range', async () => {
    const fh = fake(0)
    await writeAll(fh, new Uint8Array(), 0, 0)
    expect(fh.out).toEqual([])
  })
})

describe('paths', () => {
  it('builds paths under users/', () => {
    expect(userDir(dir, USER)).toBe(join(dir, 'users', USER))
    expect(boardDir(dir, USER, BOARD)).toBe(join(dir, 'users', USER, 'boards', BOARD))
    expect(assetDir(dir, USER, BOARD, ASSET)).toBe(
      join(dir, 'users', USER, 'boards', BOARD, 'assets', ASSET),
    )
  })

  it.each([
    '../x',
    'board_short',
    '',
    `board_${'z'.repeat(26)}`,
    `${BOARD}/..`,
    `user_${'0'.repeat(26)}`,
  ])('rejects bad board id %j with 404', (bad) => {
    try {
      boardDir(dir, USER, bad)
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError)
      expect((e as ApiError).status).toBe(404)
      expect((e as ApiError).code).toBe('not-found')
    }
  })

  it('rejects bad user and asset ids and wrong prefixes', () => {
    expect(() => userDir(dir, '../evil')).toThrow(ApiError)
    expect(() => userDir(dir, `board_${'0'.repeat(26)}`)).toThrow(ApiError)
    expect(() => boardDir(dir, USER, `asset_${'0'.repeat(26)}`)).toThrow(ApiError)
    expect(() => assetDir(dir, USER, BOARD, `board_${'0'.repeat(26)}`)).toThrow(ApiError)
  })

  it('rejects a users/<id> symlink that points outside dataDir', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'papertie-outside-'))
    try {
      await mkdir(join(dir, 'users'))
      await symlink(outside, join(dir, 'users', USER))
      expect(() => userDir(dir, USER)).toThrow(ApiError)
      expect(() => boardDir(dir, USER, BOARD)).toThrow(ApiError)
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('allows a dataDir that is itself reached through a symlink', async () => {
    const link = join(dir, 'link')
    await mkdir(join(dir, 'real'))
    await symlink(join(dir, 'real'), link)
    expect(boardDir(link, USER, BOARD)).toBe(join(link, 'users', USER, 'boards', BOARD))
  })
})

describe('KeyedMutex', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  it('never overlaps work for one key', async () => {
    const m = new KeyedMutex()
    let inside = 0
    let max = 0
    const order: number[] = []
    await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        m.run('k', async () => {
          inside++
          max = Math.max(max, inside)
          await sleep(randomInt(0, 3))
          order.push(i)
          inside--
        }),
      ),
    )
    expect(max).toBe(1)
    expect(order).toEqual(Array.from({ length: 100 }, (_, i) => i))
  })

  it('runs different keys concurrently', async () => {
    const m = new KeyedMutex()
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const a = m.run('a', () => gate)
    const b = await m.run('b', async () => 'b-done')
    expect(b).toBe('b-done')
    release()
    await a
  })

  it('keeps going after a rejection and returns the value', async () => {
    const m = new KeyedMutex()
    await expect(m.run('k', () => Promise.reject(new Boom('x')))).rejects.toBeInstanceOf(Boom)
    await expect(m.run('k', async () => 7)).resolves.toBe(7)
  })

  it('deletes idle entries', async () => {
    const m = new KeyedMutex()
    await m.run('k', async () => {})
    expect(m.size).toBe(0)
  })
})

describe('faultsFromEnv', () => {
  const kill = () => {
    throw new Boom('kill')
  }

  it('is a no-op when unset', () => {
    expect(() => faultsFromEnv({}, kill).hit('snapshot:after-rename')).not.toThrow()
  })

  it('kills on the n-th hit of the named point only', () => {
    const f = faultsFromEnv({ PAPERTIE_FAULT: 'snapshot:after-rename@3' }, kill)
    f.hit('snapshot:after-rename')
    f.hit('snapshot:after-tmp-write')
    f.hit('snapshot:after-rename')
    f.hit('snapshot:after-tmp-write')
    expect(() => f.hit('snapshot:after-rename')).toThrow(Boom)
  })

  it('rejects malformed specs', () => {
    for (const bad of ['snapshot:after-rename', 'nope@1', 'snapshot:after-rename@0', '@1']) {
      expect(() => faultsFromEnv({ PAPERTIE_FAULT: bad }, kill)).toThrow()
    }
  })
})
