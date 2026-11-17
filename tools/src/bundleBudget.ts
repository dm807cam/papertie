import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

/**
 * `pnpm budget`: the initial JS for `/`, gzipped. "Initial" is the
 * `/` entry chunk plus its static imports, read from Vite's manifest; dynamic imports (settings,
 * import, the dev routes) and the worker chunks (search, parse, pyramid) load later and are not
 * in it. The CSS the page loads before it renders (the entry's, its static imports', and the
 * page's own stylesheets) is measured beside it.
 *
 *   pnpm budget            build, measure, and fail when the JS is over 250 KB, or the JS or CSS
 *                          is more than 5 % over `tools/budgets.json`
 *   pnpm budget --record   build, measure, and write `tools/budgets.json`
 *
 * The build is the production one (no dev routes), made into a directory of its own, so the
 * app's `dist` is left as it is. A KB is 1,000 bytes; gzip is level 9. Each run's result goes to
 * `e2e/bench/results/<time>-budget.json`, where `pnpm bench:report` reads it.
 */

/** The ceiling, and how far over the size recorded (`tools/budgets.json`) a build may go. */
export const BUDGET = {
  ceilingKb: 250,
  overRecorded: 0.05,
  target: 'initial JS for `/` ≤ 250 KB gzip, and no more than 5 % above the recorded size',
} as const

/** One chunk of Vite's `.vite/manifest.json`. */
export interface ManifestChunk {
  file: string
  src?: string
  isEntry?: boolean
  isDynamicEntry?: boolean
  imports?: string[]
  dynamicImports?: string[]
  css?: string[]
}

export type Manifest = Record<string, ManifestChunk>

/** `tools/budgets.json`. */
export interface Budget {
  initialJsGzipKb: number
  initialCssGzipKb: number
  measuredAt: string
  commit: string
}

/** The JS and CSS files `/` loads before it runs: the entry chunk and its static imports. */
export function initialFiles(
  manifest: Manifest,
  entry = 'index.html',
): { js: string[]; css: string[] } {
  if (manifest[entry] === undefined) throw new Error(`the manifest has no ${entry} entry`)
  const seen = new Set<string>()
  const js: string[] = []
  const css = new Set<string>()
  const walk = (key: string) => {
    if (seen.has(key)) return
    seen.add(key)
    const chunk = manifest[key]
    if (chunk === undefined) throw new Error(`the manifest has no chunk ${key}`)
    js.push(chunk.file)
    for (const c of chunk.css ?? []) css.add(c)
    for (const k of chunk.imports ?? []) walk(k)
  }
  walk(entry)
  return { js, css: [...css] }
}

/**
 * What dynamic entry `key` (a lazy screen) loads beyond `entry`'s initial files: its own chunk
 * and its static imports that the initial files do not hold, and their CSS. Its own dynamic
 * imports load later still and are left out.
 */
export function lazyFiles(
  manifest: Manifest,
  key: string,
  entry = 'index.html',
): { js: string[]; css: string[] } {
  if (manifest[key] === undefined) throw new Error(`the manifest has no chunk ${key}`)
  const initial = initialFiles(manifest, entry)
  const have = new Set([...initial.js, ...initial.css])
  const seen = new Set<string>()
  const js: string[] = []
  const css: string[] = []
  const walk = (k: string) => {
    if (seen.has(k)) return
    seen.add(k)
    const chunk = manifest[k]
    if (chunk === undefined) throw new Error(`the manifest has no chunk ${k}`)
    if (have.has(chunk.file)) return
    js.push(chunk.file)
    for (const c of chunk.css ?? []) if (!have.has(c) && !css.includes(c)) css.push(c)
    for (const i of chunk.imports ?? []) walk(i)
  }
  walk(key)
  return { js, css }
}

/** The stylesheets `index.html` links, as paths in the build (no leading slash). */
export function stylesheetLinks(html: string): string[] {
  const out: string[] = []
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/\brel=["']?stylesheet\b/i.test(tag)) continue
    const href = /\bhref=["']([^"']+)["']/i.exec(tag)?.[1]
    if (href !== undefined) out.push(href.replace(/^\//, ''))
  }
  return out
}

/**
 * Modules that must never be in the initial JS: `@papertie/tools` (bench
 * boards and generators) and the bench's perf hooks, which only the dev hooks load; and zod's
 * JSON Schema generator, which the browser build stubs (`apps/web/vite.config.ts`).
 * Matched on the build's source-map paths.
 */
const FORBIDDEN_INITIAL = [
  /(^|\/)tools\/src\//,
  /(^|\/)apps\/web\/src\/perf\/perfHooks\.ts$/,
  /(^|\/)apps\/web\/src\/perf\/benchGestures\.ts$/,
  /(^|\/)zod\/v4\/core\/(to-json-schema|json-schema-processors)\.js$/,
]

/** The paths in `sources` (an initial chunk's source map) that may not be in the initial JS. */
export function forbiddenInitial(sources: readonly string[]): string[] {
  return sources.filter((s) => FORBIDDEN_INITIAL.some((re) => re.test(s)))
}

/**
 * The book screens: `apps/web/src/book/**` (the shelf, the writer, covers, their
 * CSS) loads only with them, never with the board. Their always-loaded part is `sync/books/` and
 * a few `app/` modules, which this leaves alone.
 */
const BOOK_MODULES = /(^|\/)apps\/web\/src\/book\//

/** The paths in `sources` (an initial chunk's source map) under `apps/web/src/book/`. */
export const bookModulesIn = (sources: readonly string[]): string[] =>
  sources.filter((s) => BOOK_MODULES.test(s))

/** The book screens, each a dynamic entry of its own: loaded on demand, never with the board. */
export const BOOK_SCREENS = [
  'src/book/ShelfScreen.tsx',
  'src/book/BookScreen.tsx',
  'src/book/uses/CardUses.tsx',
] as const

/** The book screens `manifest` has no dynamic entry for. */
export const unlazyBookScreens = (manifest: Manifest): string[] =>
  BOOK_SCREENS.filter((k) => manifest[k]?.isDynamicEntry !== true)

/** Gzip size at level 9, in KB of 1,000 bytes. */
export const gzipKb = (bytes: Buffer): number => gzipSync(bytes, { level: 9 }).length / 1000

export interface Measured {
  jsGzipKb: number
  cssGzipKb: number
  /** Modules in the initial JS that must not be there ({@link forbiddenInitial}). */
  forbidden: string[]
  /**
   * Initial JS files with no source map beside them: the forbidden-module guard could not look
   * inside them, so the budget fails (closed) rather than pass them unchecked.
   */
  unmapped: string[]
  /** Modules under `apps/web/src/book/` in the initial JS ({@link bookModulesIn}). */
  books: string[]
  /** Book screens that are not dynamic entries of their own ({@link unlazyBookScreens}). */
  notLazy: string[]
  js: Array<{ file: string; gzipKb: number }>
  css: Array<{ file: string; gzipKb: number }>
  /**
   * The book screens' lazy chunks (the shelf and writer chunk sizes recorded beside
   * the budget), by screen: what each loads beyond the initial files ({@link lazyFiles}).
   */
  screens: Record<string, ScreenSize>
}

export interface ScreenSize {
  jsGzipKb: number
  cssGzipKb: number
  js: Array<{ file: string; gzipKb: number }>
  css: Array<{ file: string; gzipKb: number }>
}

/**
 * Whether `file` is the bundler's own runtime chunk (`rolldown-runtime-<hash>.js`, its interop
 * helpers, some 0.7 KB), which the build writes without a source map: tiny and importing
 * nothing, so it can hold no module of ours. Anything else without a map is unmapped.
 */
export function isBundlerRuntime(file: string, code: string): boolean {
  return (
    /(^|\/)rolldown-runtime-[\w-]+\.js$/.test(file) &&
    code.length <= 2048 &&
    !/\bimport\s*[({"'`\w*]/.test(code)
  )
}

/** Measure a build directory with its `.vite/manifest.json`. */
export function measureDist(dist: string): Measured {
  const manifest = JSON.parse(readFileSync(join(dist, '.vite/manifest.json'), 'utf8')) as Manifest
  const files = initialFiles(manifest)
  const css = [
    ...new Set([...stylesheetLinks(readFileSync(join(dist, 'index.html'), 'utf8')), ...files.css]),
  ]
  const sized = (list: readonly string[]) =>
    list.map((file) => ({ file, gzipKb: gzipKb(readFileSync(join(dist, file))) }))
  const js = sized(files.js)
  const cssSized = sized(css)
  const sum = (xs: Array<{ gzipKb: number }>) => xs.reduce((a, x) => a + x.gzipKb, 0)
  // The build writes hidden source maps (no comment in the JS, so the sizes are the shipped ones).
  const forbidden: string[] = []
  const unmapped: string[] = []
  const books: string[] = []
  for (const file of files.js) {
    const map = join(dist, `${file}.map`)
    if (!existsSync(map)) {
      if (!isBundlerRuntime(file, readFileSync(join(dist, file), 'utf8'))) unmapped.push(file)
      continue
    }
    const { sources = [] } = JSON.parse(readFileSync(map, 'utf8')) as { sources?: string[] }
    forbidden.push(...forbiddenInitial(sources))
    books.push(...bookModulesIn(sources))
  }
  const screens: Record<string, ScreenSize> = {}
  for (const key of BOOK_SCREENS) {
    if (manifest[key] === undefined) continue
    const lazy = lazyFiles(manifest, key)
    const sjs = sized(lazy.js)
    const scss = sized(lazy.css)
    screens[key] = { jsGzipKb: sum(sjs), cssGzipKb: sum(scss), js: sjs, css: scss }
  }
  return {
    screens,
    forbidden,
    unmapped,
    books,
    notLazy: unlazyBookScreens(manifest),
    jsGzipKb: sum(js),
    cssGzipKb: sum(cssSized),
    js,
    css: cssSized,
  }
}

/** What misses the budget: over the ceiling, or more than 5 % over the recorded JS or CSS. */
export function judgeBudget(
  m: Pick<Measured, 'jsGzipKb' | 'cssGzipKb'> & {
    forbidden?: readonly string[]
    unmapped?: readonly string[]
    books?: readonly string[]
    notLazy?: readonly string[]
  },
  recorded: Budget | null,
): string[] {
  const kb = (n: number) => `${n.toFixed(1)} KB`
  const out: string[] = []
  if ((m.forbidden?.length ?? 0) > 0)
    out.push(
      `the initial JS holds ${m.forbidden?.length} module(s) only the dev hooks load: ${m.forbidden?.slice(0, 3).join('; ')}`,
    )
  if ((m.books?.length ?? 0) > 0)
    out.push(
      `the initial JS holds ${m.books?.length} book module(s) (src/book/ loads with the book screens only): ${m.books?.slice(0, 3).join('; ')}`,
    )
  for (const k of m.notLazy ?? []) out.push(`${k} is not a lazy chunk of its own (a dynamic entry)`)
  if ((m.unmapped?.length ?? 0) > 0)
    out.push(
      `${m.unmapped?.length} initial JS file(s) have no source map, so the module guard cannot read them: ${m.unmapped?.slice(0, 3).join('; ')}`,
    )
  if (m.jsGzipKb > BUDGET.ceilingKb)
    out.push(`initial JS ${kb(m.jsGzipKb)} > the ${BUDGET.ceilingKb} KB ceiling`)
  if (recorded === null) {
    out.push('no recorded budget (tools/budgets.json): run `pnpm budget --record`')
    return out
  }
  const limit = (n: number) => n * (1 + BUDGET.overRecorded)
  if (m.jsGzipKb > limit(recorded.initialJsGzipKb))
    out.push(
      `initial JS ${kb(m.jsGzipKb)} > ${kb(limit(recorded.initialJsGzipKb))} (recorded ${kb(recorded.initialJsGzipKb)} + 5 %)`,
    )
  if (m.cssGzipKb > limit(recorded.initialCssGzipKb))
    out.push(
      `initial CSS ${kb(m.cssGzipKb)} > ${kb(limit(recorded.initialCssGzipKb))} (recorded ${kb(recorded.initialCssGzipKb)} + 5 %)`,
    )
  return out
}

const repo = join(import.meta.dirname, '../..')

const git = (cmd: string) =>
  execSync(`git ${cmd}`, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()

function main(): void {
  const record = process.argv.includes('--record')
  const out = mkdtempSync(join(tmpdir(), 'papertie-budget-'))
  try {
    const env = { ...process.env }
    delete env.VITE_DEV_ROUTES
    execSync(
      `pnpm --filter @papertie/web exec vite build --manifest --sourcemap hidden --outDir ${JSON.stringify(out)} --emptyOutDir`,
      { cwd: repo, env, stdio: ['ignore', 'ignore', 'inherit'] },
    )
    const m = measureDist(out)
    const commit = git('rev-parse --short HEAD')
    const dirty = git('status --porcelain --untracked-files=no') !== ''
    const at = new Date().toISOString()
    for (const f of [...m.js, ...m.css])
      console.log(`  ${f.gzipKb.toFixed(2).padStart(8)} KB  ${f.file}`)
    console.log(
      `initial JS ${m.jsGzipKb.toFixed(2)} KB gzip, CSS ${m.cssGzipKb.toFixed(2)} KB gzip (${commit}${dirty ? '+dirty' : ''})`,
    )
    // The shelf's and the writer's lazy chunks, for the record (not judged: the budget is the initial JS).
    for (const [key, sz] of Object.entries(m.screens)) {
      console.log(
        `${key}: JS ${sz.jsGzipKb.toFixed(2)} KB gzip, CSS ${sz.cssGzipKb.toFixed(2)} KB gzip (lazy: ${sz.js.map((f) => `${f.file} ${f.gzipKb.toFixed(2)}`).join(', ')})`,
      )
    }
    const file = join(repo, 'tools/budgets.json')
    if (record) {
      const b: Budget = {
        initialJsGzipKb: Math.round(m.jsGzipKb * 100) / 100,
        initialCssGzipKb: Math.round(m.cssGzipKb * 100) / 100,
        measuredAt: at,
        commit: `${commit}${dirty ? '+dirty' : ''}`,
      }
      writeFileSync(file, `${JSON.stringify(b, null, 2)}\n`)
      console.log(`recorded in tools/budgets.json`)
    }
    const recorded = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Budget) : null
    const failures = judgeBudget(m, recorded)
    const dir = join(repo, 'e2e/bench/results')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `${at}-budget.json`),
      `${JSON.stringify(
        {
          run: at,
          budget: {
            untimed: true,
            budget: BUDGET.target,
            machine: { at, commit, dirty },
            initialJsGzipKb: m.jsGzipKb,
            initialCssGzipKb: m.cssGzipKb,
            recorded,
            js: m.js,
            css: m.css,
            bookScreens: m.screens,
            failures,
          },
        },
        null,
        2,
      )}\n`,
    )
    if (failures.length > 0) {
      for (const f of failures) console.error(`MISS ${f}`)
      process.exitCode = 1
    } else console.log('within budget')
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

if (process.argv[1] === import.meta.filename) main()
