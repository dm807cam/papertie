import { postBatch } from '../api/boards'
import type { SyncClient } from './SyncClient'

/**
 * The largest body sent with `fetch(…, {keepalive: true})`. Browsers allow 64 KiB in flight for
 * all of a page's keepalive requests together; this leaves room for the headers.
 */
export const KEEPALIVE_MAX_BYTES = 60_000

export interface UnloadEnv {
  window: EventTarget
  document: EventTarget & { readonly visibilityState: string }
}

/**
 * Send what is pending as the page goes away. On `visibilitychange` to hidden and on `pagehide`
 * the client flushes (typing goes at once). On `pagehide` every edit not yet sent also goes as
 * one request with `keepalive`, which outlives the page, when its body is under
 * {@link KEEPALIVE_MAX_BYTES}. Returns the function that stops listening.
 */
export function installUnload(sync: SyncClient, env: UnloadEnv = { window, document }): () => void {
  const onVisibility = () => {
    if (env.document.visibilityState === 'hidden') void sync.flush()
  }
  const onPagehide = () => {
    const body = sync.keepaliveBatch(KEEPALIVE_MAX_BYTES)
    if (body) postBatch(sync.boardId, body, { keepalive: true }).catch(() => undefined)
    void sync.flush()
  }
  env.document.addEventListener('visibilitychange', onVisibility)
  env.window.addEventListener('pagehide', onPagehide)
  return () => {
    env.document.removeEventListener('visibilitychange', onVisibility)
    env.window.removeEventListener('pagehide', onPagehide)
  }
}
