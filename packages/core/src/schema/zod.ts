import { z } from 'zod'

/**
 * zod, set up for where the schemas run. In a browser (a document, or a worker's scope) the app
 * runs under a CSP without `'unsafe-eval'`, so zod may not compile parsers with `new Function`;
 * without `jitless` it still tries once (a probe it swallows), and the browser reports that try
 * as a CSP violation on every page and in the parse worker. `jitless` skips the probe and the
 * compile, which the CSP refuses anyway. The server, where nothing forbids it, keeps them.
 * Every schema module imports `z` from here, so this runs before any schema is built.
 */
const scope = globalThis as { document?: unknown; WorkerGlobalScope?: unknown }
if (scope.document !== undefined || scope.WorkerGlobalScope !== undefined) {
  z.config({ jitless: true })
}

export { z }
