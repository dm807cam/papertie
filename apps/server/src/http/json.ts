import type { Context } from 'hono'
import type { AppEnv } from './env'
import { ApiError } from './errors'

/** The request body as a JSON object and its size in bytes; malformed JSON or a non-object is 400 `invalid`. */
export async function readJsonSized(
  c: Context<AppEnv>,
): Promise<{ body: Record<string, unknown>; bytes: number }> {
  const text = await c.req.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new ApiError(400, 'invalid')
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ApiError(400, 'invalid')
  }
  return { body: body as Record<string, unknown>, bytes: Buffer.byteLength(text) }
}

/** The request body as a JSON object; malformed JSON or a non-object is 400 `invalid`. */
export async function readJson(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  return (await readJsonSized(c)).body
}
