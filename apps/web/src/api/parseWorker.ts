/// <reference lib="webworker" />
import type { ParseMessage } from './boardParse'
import { parseAndPost } from './parsePost'

/** The board parse worker ({@link parseAndPost}): one board's bytes in, its records out. */
const scope = self as unknown as DedicatedWorkerGlobalScope

scope.onmessage = (e: MessageEvent<ArrayBuffer>) => {
  parseAndPost(e.data, (m: ParseMessage) => scope.postMessage(m))
}
