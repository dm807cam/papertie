import { realpathSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { ID_PATTERN } from '@papertie/core'
import { ApiError } from '../http/errors'
import { isEnoent } from './durable'

const notFound = () => new ApiError(404, 'not-found')

/** Id segments become directory names, so they are checked against the raw pattern (user ids too). */
function segment(id: string, prefix: string): string {
  if (typeof id !== 'string' || !ID_PATTERN.test(id) || !id.startsWith(`${prefix}_`)) {
    throw notFound()
  }
  return id
}

/** realpath of the longest existing prefix of `p`, with the missing remainder appended. */
function realpathPrefix(p: string): string {
  const missing: string[] = []
  let cur = resolve(p)
  for (;;) {
    try {
      return join(realpathSync(cur), ...missing.reverse())
    } catch (e) {
      if (!isEnoent(e)) throw notFound()
      const parent = dirname(cur)
      if (parent === cur) throw notFound()
      missing.push(cur.slice(parent.length + 1))
      cur = parent
    }
  }
}

function guarded(dataDir: string, path: string): string {
  const root = realpathPrefix(join(dataDir, 'users'))
  const rel = relative(root, realpathPrefix(path))
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || resolve(rel) === rel) {
    throw notFound()
  }
  return resolve(path)
}

/** `trash/` under the data dir: where a user's directory waits while their deletion completes. */
export const trashDir = (dataDir: string) => join(dataDir, 'trash')

export function userDir(dataDir: string, userId: string): string {
  return guarded(dataDir, join(dataDir, 'users', segment(userId, 'user')))
}

export function boardDir(dataDir: string, userId: string, boardId: string): string {
  return guarded(
    dataDir,
    join(dataDir, 'users', segment(userId, 'user'), 'boards', segment(boardId, 'board')),
  )
}

export function assetDir(
  dataDir: string,
  userId: string,
  boardId: string,
  assetId: string,
): string {
  return guarded(
    dataDir,
    join(
      dataDir,
      'users',
      segment(userId, 'user'),
      'boards',
      segment(boardId, 'board'),
      'assets',
      segment(assetId, 'asset'),
    ),
  )
}
