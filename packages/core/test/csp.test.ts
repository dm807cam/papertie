import { afterEach, expect, it } from 'vitest'

/**
 * Found by `e2e/app/csp.spec.ts`: zod probes whether it may compile parsers with
 * `new Function("")`. Under the app's CSP (`script-src 'self'`, no `'unsafe-eval'`) the probe is
 * refused and swallowed, but the browser still reports it as a `securitypolicyviolation`, on every
 * page and in the parse worker. In a browser (a document, or a worker's scope) the schemas run
 * without that compile (`jitless`, which the CSP forces anyway), so nothing is ever refused. On
 * the server (no document) they keep it.
 *
 * Each test file runs in a fresh module graph: core is imported here only after the stand-ins.
 */

const realFunction = globalThis.Function
const g = globalThis as { document?: unknown; Function: FunctionConstructor }

afterEach(() => {
  g.Function = realFunction
  delete g.document
})

it('in a browser, loading and using the schemas never asks for eval', async () => {
  const compiled: unknown[][] = []
  g.document = {}
  g.Function = new Proxy(realFunction, {
    construct(target, args, newTarget) {
      compiled.push(args)
      return Reflect.construct(target, args, newTarget)
    },
    apply(target, self, args) {
      compiled.push(args)
      return Reflect.apply(target, self, args)
    },
  })
  const core = await import('../src/index')
  const at = '2026-10-27T10:00:00.000Z'
  const state = core.emptyBoardState(core.newId('board'), 'Board', at)
  const text = core.serializeBoard(state)
  const parsed = core.parseBoard(text)
  expect(parsed.state?.board.name).toBe('Board')
  expect(compiled).toEqual([])
})
