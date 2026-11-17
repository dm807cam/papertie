import { readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ID_PATTERN } from '@papertie/core'
import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from './http/env'
import { serverId } from './ids'
import type { Logger } from './log'
import { fsyncDir, isEnoent, writeFileDurable } from './store/durable'
import { noFaults } from './store/faults'
import { trashDir } from './store/paths'

/** Where the user's id is kept, in the data dir: `{"id":"user_…"}`. */
export const USER_FILE = 'local-user.json'

const isUserId = (v: unknown): v is string =>
  typeof v === 'string' && ID_PATTERN.test(v) && v.startsWith('user_')

/**
 * The one user's id (Papertie has no accounts: a data dir is one person's). Made on the first start and written
 * atomically (fsynced, then renamed), so every later start, and the boards under `users/<id>/`,
 * keep the same one. A file that does not hold a user id stops the start: a fresh id would leave the
 * boards behind under the old one.
 */
export async function userIdOf(dataDir: string): Promise<string> {
  const path = join(dataDir, USER_FILE)
  let text: string | null = null
  try {
    text = await readFile(path, 'utf8')
  } catch (e) {
    if (!isEnoent(e)) throw e
  }
  if (text !== null) {
    let id: unknown
    try {
      id = (JSON.parse(text) as { id?: unknown } | null)?.id
    } catch {
      id = undefined
    }
    if (!isUserId(id)) throw new Error(`the user file (${USER_FILE}) is damaged`)
    return id
  }
  const id = serverId('user')
  await writeFileDurable(path, `${JSON.stringify({ id })}\n`, noFaults, 'local-user')
  return id
}

/** Every request is the one user's: there are no sessions to check. Sets `c.var.user`. */
export function asUser(userId: string): MiddlewareHandler<AppEnv> {
  const user = { id: userId }
  return async (c, next) => {
    c.set('user', user)
    await next()
  }
}

/**
 * The start-up repair of `trash/`: what is there is a "delete all data" that stopped after it
 * moved the data aside, so it is finished (removed).
 */
export async function sweepTrash(dataDir: string, log: Logger): Promise<void> {
  const trash = trashDir(dataDir)
  const names = await readdir(trash).catch((e: unknown) => {
    if (isEnoent(e)) return [] as string[]
    throw e
  })
  if (names.length === 0) return
  for (const name of names) await rm(join(trash, name), { recursive: true, force: true })
  await fsyncDir(trash)
  log.info('trash sweep', { count: names.length })
}
