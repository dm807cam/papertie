import { ApiError } from './http'

/** The wait a 429 asks for (`Retry-After`), in ms; a minute when the server gave none. */
const waitMs = (e: ApiError): number => e.retryAfterMs ?? 60_000

/** The words for a failure any request can meet: a rate limit, no answer, anything else. */
export function failureText(e: unknown): string {
  if (e instanceof ApiError && e.status === 429)
    return `Too many tries — wait ${Math.ceil(waitMs(e) / 1000)} s.`
  if (e instanceof ApiError && e.code === 'network')
    return 'Can’t reach Papertie — check your connection.'
  return 'Something went wrong. Try again in a moment.'
}
