import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import {
  BOOK_SCREENS,
  BUDGET,
  type Budget,
  forbiddenInitial,
  gzipKb,
  initialFiles,
  isBundlerRuntime,
  judgeBudget,
  lazyFiles,
  type Manifest,
  measureDist,
  stylesheetLinks,
  unlazyBookScreens,
} from '../src/bundleBudget'

/**
 * `pnpm budget`: the `/` entry chunk plus its static imports, gzipped,
 * against the 250 KB ceiling and the recorded size (+5 %).
 */

const manifest: Manifest = {
  'index.html': {
    file: 'assets/index-a.js',
    src: 'index.html',
    isEntry: true,
    imports: ['_shared-b.js', '_runtime-c.js'],
    dynamicImports: ['src/settings/Settings.tsx', 'src/dev/BenchRoute.tsx'],
    css: ['assets/index-a.css'],
  },
  '_shared-b.js': { file: 'assets/shared-b.js', imports: ['_runtime-c.js'] },
  '_runtime-c.js': { file: 'assets/runtime-c.js' },
  'src/settings/Settings.tsx': {
    file: 'assets/Settings-d.js',
    isDynamicEntry: true,
    imports: ['_shared-b.js', '_lazyonly-e.js'],
    css: ['assets/Settings-d.css'],
  },
  '_lazyonly-e.js': { file: 'assets/lazyonly-e.js' },
  'src/dev/BenchRoute.tsx': { file: 'assets/BenchRoute-f.js', isDynamicEntry: true },
  'src/search/searchWorker.ts': { file: 'assets/searchWorker-g.js', isEntry: true },
}

describe('initialFiles', () => {
  it('is the entry chunk and its static imports, each once, and their CSS', () => {
    const f = initialFiles(manifest)
    expect(f.js.sort()).toEqual(['assets/index-a.js', 'assets/runtime-c.js', 'assets/shared-b.js'])
    expect(f.css).toEqual(['assets/index-a.css'])
  })

  it('leaves out dynamic imports (settings, dev routes), what only they import, and workers', () => {
    const f = initialFiles(manifest)
    for (const lazy of [
      'assets/Settings-d.js',
      'assets/Settings-d.css',
      'assets/lazyonly-e.js',
      'assets/BenchRoute-f.js',
      'assets/searchWorker-g.js',
    ])
      expect([...f.js, ...f.css]).not.toContain(lazy)
  })

  it('fails on a manifest without the entry', () => {
    expect(() => initialFiles({})).toThrow(/index\.html/)
  })
})

describe('stylesheetLinks', () => {
  it("reads the page's own stylesheets (a public file the manifest does not list)", () => {
    const html =
      '<link rel="icon" href="/favicon.svg" /><link rel="stylesheet" href="/stage.css" />' +
      '<script type="module" crossorigin src="/assets/index-a.js"></script>' +
      '<link rel="modulepreload" crossorigin href="/assets/shared-b.js">' +
      '<link rel="stylesheet" crossorigin href="/assets/index-a.css">'
    expect(stylesheetLinks(html)).toEqual(['stage.css', 'assets/index-a.css'])
  })
})

describe('gzipKb', () => {
  it('is the gzip size at level 9 in KB of 1,000 bytes', () => {
    const bytes = Buffer.from('papertie '.repeat(5000))
    expect(gzipKb(bytes)).toBe(gzipSync(bytes, { level: 9 }).length / 1000)
  })
})

describe('measureDist', () => {
  it("sums the initial files' gzip sizes, the page's own stylesheets with the CSS", () => {
    const dir = mkdtempSync(join(tmpdir(), 'budget-test-'))
    try {
      mkdirSync(join(dir, 'assets'))
      mkdirSync(join(dir, '.vite'))
      const files: Record<string, string> = {
        'assets/index-a.js': 'console.log("entry");'.repeat(300),
        'assets/shared-b.js': 'export const shared = 1;'.repeat(200),
        'assets/runtime-c.js': 'export const r = 2;',
        'assets/Settings-d.js': 'x'.repeat(100_000),
        'assets/index-a.css': '.a{color:red}'.repeat(100),
        'stage.css': 'body{margin:0}'.repeat(50),
      }
      for (const [p, text] of Object.entries(files)) writeFileSync(join(dir, p), text)
      writeFileSync(join(dir, '.vite/manifest.json'), JSON.stringify(manifest))
      writeFileSync(
        join(dir, 'index.html'),
        '<link rel="stylesheet" href="/stage.css" /><link rel="stylesheet" href="/assets/index-a.css">',
      )
      const kb = (p: string) => gzipKb(Buffer.from(files[p] as string))
      const m = measureDist(dir)
      expect(m.jsGzipKb).toBeCloseTo(
        kb('assets/index-a.js') + kb('assets/shared-b.js') + kb('assets/runtime-c.js'),
        6,
      )
      expect(m.cssGzipKb).toBeCloseTo(kb('assets/index-a.css') + kb('stage.css'), 6)
      expect(m.js.map((f) => f.file).sort()).toEqual([
        'assets/index-a.js',
        'assets/runtime-c.js',
        'assets/shared-b.js',
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('judgeBudget', () => {
  const recorded: Budget = {
    initialJsGzipKb: 200,
    initialCssGzipKb: 100,
    measuredAt: '2026-11-07T00:00:00.000Z',
    commit: 'abc1234',
  }

  it('passes at the recorded size and up to 5 % above it', () => {
    expect(judgeBudget({ jsGzipKb: 200, cssGzipKb: 100 }, recorded)).toEqual([])
    expect(judgeBudget({ jsGzipKb: 210, cssGzipKb: 105 }, recorded)).toEqual([])
  })

  it('fails more than 5 % above the recorded JS or CSS', () => {
    expect(judgeBudget({ jsGzipKb: 210.1, cssGzipKb: 100 }, recorded)).toEqual([
      expect.stringMatching(/JS 210\.1 KB > 210\.0 KB/),
    ])
    expect(judgeBudget({ jsGzipKb: 200, cssGzipKb: 105.2 }, recorded)).toEqual([
      expect.stringMatching(/CSS 105\.2 KB > 105\.0 KB/),
    ])
  })

  it('fails over the 250 KB ceiling, whatever was recorded', () => {
    expect(BUDGET.ceilingKb).toBe(250)
    const big = { ...recorded, initialJsGzipKb: 245 }
    expect(judgeBudget({ jsGzipKb: 250, cssGzipKb: 100 }, big)).toEqual([])
    expect(judgeBudget({ jsGzipKb: 250.1, cssGzipKb: 100 }, big)).toEqual([
      expect.stringMatching(/JS 250\.1 KB > the 250 KB ceiling/),
    ])
    expect(judgeBudget({ jsGzipKb: 251, cssGzipKb: 100 }, null)).toEqual([
      expect.stringMatching(/ceiling/),
      expect.stringMatching(/no recorded budget/),
    ])
  })
})

describe('modules never in the initial graph', () => {
  it('names @papertie/tools and the bench perf hooks wherever the source maps put them', () => {
    expect(
      forbiddenInitial([
        '../../../../../checkout/apps/web/src/canvas/CanvasView.tsx',
        '../../../../../checkout/tools/src/genBoard.ts',
        '../../../../../checkout/apps/web/src/perf/perfHooks.ts',
        '../../../../../checkout/apps/web/src/perf/benchGestures.ts',
        '../../../../../checkout/apps/web/src/perf/PerfHud.tsx',
        '../../node_modules/.pnpm/react@19.3.1/node_modules/react/index.js',
      ]),
    ).toEqual([
      '../../../../../checkout/tools/src/genBoard.ts',
      '../../../../../checkout/apps/web/src/perf/perfHooks.ts',
      '../../../../../checkout/apps/web/src/perf/benchGestures.ts',
    ])
  })

  it('names zod’s JSON Schema generator, which the browser build stubs', () => {
    const zod = '../../node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4'
    expect(
      forbiddenInitial([
        `${zod}/core/to-json-schema.js`,
        `${zod}/core/json-schema-processors.js`,
        `${zod}/core/schemas.js`,
        '../../../../../checkout/apps/web/src/lib/zodNoJsonSchema.ts',
      ]),
    ).toEqual([`${zod}/core/to-json-schema.js`, `${zod}/core/json-schema-processors.js`])
  })

  it('measureDist reads the initial chunks’ hidden source maps, and judgeBudget fails on any', () => {
    const dir = mkdtempSync(join(tmpdir(), 'budget-test-'))
    try {
      mkdirSync(join(dir, 'assets'))
      mkdirSync(join(dir, '.vite'))
      for (const f of ['index-a', 'shared-b', 'runtime-c', 'Settings-d']) {
        writeFileSync(join(dir, `assets/${f}.js`), 'x')
      }
      writeFileSync(join(dir, 'assets/index-a.css'), '')
      writeFileSync(
        join(dir, 'assets/shared-b.js.map'),
        JSON.stringify({ version: 3, sources: ['../../tools/src/genBoard.ts', '../../src/a.ts'] }),
      )
      // A lazy chunk may hold them.
      writeFileSync(
        join(dir, 'assets/Settings-d.js.map'),
        JSON.stringify({ version: 3, sources: ['../../apps/web/src/perf/perfHooks.ts'] }),
      )
      writeFileSync(join(dir, '.vite/manifest.json'), JSON.stringify(manifest))
      writeFileSync(join(dir, 'index.html'), '')
      const m = measureDist(dir)
      expect(m.forbidden).toEqual(['../../tools/src/genBoard.ts'])
      expect(judgeBudget({ jsGzipKb: 1, cssGzipKb: 1, forbidden: m.forbidden }, null)).toEqual(
        expect.arrayContaining([expect.stringMatching(/initial JS holds.*genBoard/)]),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('an initial chunk without its source map fails the budget: the guard never passes unchecked', () => {
    const dir = mkdtempSync(join(tmpdir(), 'budget-test-'))
    try {
      mkdirSync(join(dir, 'assets'))
      mkdirSync(join(dir, '.vite'))
      for (const f of ['index-a', 'shared-b', 'runtime-c', 'Settings-d']) {
        writeFileSync(join(dir, `assets/${f}.js`), 'x')
      }
      writeFileSync(join(dir, 'assets/index-a.css'), '')
      for (const f of ['index-a', 'shared-b']) {
        writeFileSync(
          join(dir, `assets/${f}.js.map`),
          JSON.stringify({ version: 3, sources: ['../../src/a.ts'] }),
        )
      }
      writeFileSync(join(dir, '.vite/manifest.json'), JSON.stringify(manifest))
      writeFileSync(join(dir, 'index.html'), '')
      const m = measureDist(dir)
      // The lazy chunk's map is not needed; the initial chunk's is.
      expect(m.unmapped).toEqual(['assets/runtime-c.js'])
      expect(judgeBudget({ jsGzipKb: 1, cssGzipKb: 1, unmapped: m.unmapped }, null)).toEqual(
        expect.arrayContaining([expect.stringMatching(/no source map.*runtime-c/)]),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the bundler’s own runtime chunk needs no map; a large or importing one does', () => {
    const runtime = 'var e=Object.create;export{e as t};'
    expect(isBundlerRuntime('assets/rolldown-runtime-XKyaHtl9.js', runtime)).toBe(true)
    expect(isBundlerRuntime('assets/rolldown-runtime-XKyaHtl9.js', runtime.repeat(100))).toBe(false)
    expect(
      isBundlerRuntime('assets/rolldown-runtime-X.js', `import{a}from"./b.js";${runtime}`),
    ).toBe(false)
    expect(isBundlerRuntime('assets/index-a.js', runtime)).toBe(false)
  })
})

describe('the book screens are lazy only', () => {
  /** A manifest with the shelf and the writer as dynamic entries, and what their maps hold. */
  const books: Manifest = {
    ...manifest,
    'index.html': {
      ...(manifest['index.html'] as Manifest[string]),
      dynamicImports: ['src/book/ShelfScreen.tsx', 'src/book/BookScreen.tsx'],
    },
    'src/book/ShelfScreen.tsx': {
      file: 'assets/ShelfScreen-h.js',
      isDynamicEntry: true,
      imports: ['_shared-b.js'],
    },
    'src/book/BookScreen.tsx': { file: 'assets/BookScreen-i.js', isDynamicEntry: true },
    'src/book/uses/CardUses.tsx': { file: 'assets/CardUses-u.js', isDynamicEntry: true },
  }

  function dist(m: Manifest, initialSources: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'budget-test-'))
    mkdirSync(join(dir, 'assets'))
    mkdirSync(join(dir, '.vite'))
    for (const f of [
      'index-a',
      'shared-b',
      'runtime-c',
      'Settings-d',
      'ShelfScreen-h',
      'BookScreen-i',
      'CardUses-u',
    ]) {
      writeFileSync(join(dir, `assets/${f}.js`), 'x')
    }
    writeFileSync(join(dir, 'assets/index-a.css'), '')
    for (const f of ['index-a', 'runtime-c'])
      writeFileSync(
        join(dir, `assets/${f}.js.map`),
        JSON.stringify({ version: 3, sources: ['../../apps/web/src/a.ts'] }),
      )
    writeFileSync(
      join(dir, 'assets/shared-b.js.map'),
      JSON.stringify({ version: 3, sources: initialSources }),
    )
    // The shelf's own chunk holds the book modules: that is where they belong.
    writeFileSync(
      join(dir, 'assets/ShelfScreen-h.js.map'),
      JSON.stringify({ version: 3, sources: ['../../apps/web/src/book/cover/CoverSvg.tsx'] }),
    )
    writeFileSync(join(dir, '.vite/manifest.json'), JSON.stringify(m))
    writeFileSync(join(dir, 'index.html'), '')
    return dir
  }

  it('a manifest whose initial graph reaches src/book/ fails the budget', () => {
    const clean = dist(books, ['../../apps/web/src/sync/books/bookStore.ts'])
    const leaked = dist(books, [
      '../../apps/web/src/sync/books/bookStore.ts',
      '../../apps/web/src/book/cover/cover.ts',
      '../../apps/web/src/book/shelf.css',
    ])
    try {
      // `sync/books/` is the always-loaded part: allowed. `src/book/` is not.
      const ok = measureDist(clean)
      expect(ok.books).toEqual([])
      expect(ok.notLazy).toEqual([])
      expect(judgeBudget({ ...ok, jsGzipKb: 1, cssGzipKb: 1 }, null)).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/book/)]),
      )
      const bad = measureDist(leaked)
      expect(bad.books).toEqual([
        '../../apps/web/src/book/cover/cover.ts',
        '../../apps/web/src/book/shelf.css',
      ])
      expect(judgeBudget({ ...bad, jsGzipKb: 1, cssGzipKb: 1 }, null)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/initial JS holds 2 book module\(s\).*cover\.ts/),
        ]),
      )
    } finally {
      rmSync(clean, { recursive: true, force: true })
      rmSync(leaked, { recursive: true, force: true })
    }
  })

  it('a manifest whose initial graph reaches src/book/uses fails the budget', () => {
    // The reverse mark's popover is a dynamic entry of its own.
    expect(BOOK_SCREENS).toContain('src/book/uses/CardUses.tsx')
    const leaked = dist(books, [
      '../../apps/web/src/sync/books/cardUses.ts',
      '../../apps/web/src/book/uses/CardUses.tsx',
    ])
    try {
      const bad = measureDist(leaked)
      expect(bad.books).toEqual(['../../apps/web/src/book/uses/CardUses.tsx'])
      expect(judgeBudget({ ...bad, jsGzipKb: 1, cssGzipKb: 1 }, null)).toEqual(
        expect.arrayContaining([expect.stringMatching(/initial JS holds 1 book module.*CardUses/)]),
      )
    } finally {
      rmSync(leaked, { recursive: true, force: true })
    }
    // Folded into the initial chunk, it is no dynamic entry: the budget fails too.
    const { 'src/book/uses/CardUses.tsx': _gone, ...eager } = books
    expect(unlazyBookScreens(eager)).toEqual(['src/book/uses/CardUses.tsx'])
  })

  it('fails when the shelf or the writer is not a dynamic entry of its own', () => {
    expect(unlazyBookScreens(books)).toEqual([])
    // Folded into another chunk: no entry of its own.
    const { 'src/book/BookScreen.tsx': _gone, ...noWriter } = books
    expect(unlazyBookScreens(noWriter)).toEqual(['src/book/BookScreen.tsx'])
    // Imported statically somewhere: an entry, but not a dynamic one.
    const eager: Manifest = {
      ...books,
      'src/book/ShelfScreen.tsx': {
        ...(books['src/book/ShelfScreen.tsx'] as Manifest[string]),
        isDynamicEntry: false,
      },
    }
    expect(unlazyBookScreens(eager)).toEqual(['src/book/ShelfScreen.tsx'])
    expect(
      judgeBudget({ jsGzipKb: 1, cssGzipKb: 1, notLazy: unlazyBookScreens(eager) }, null),
    ).toEqual(
      expect.arrayContaining([expect.stringMatching(/ShelfScreen\.tsx is not a lazy chunk/)]),
    )
  })
})

describe('the shelf and writer chunk sizes', () => {
  const m: Manifest = {
    ...manifest,
    'index.html': {
      ...(manifest['index.html'] as Manifest[string]),
      dynamicImports: ['src/book/ShelfScreen.tsx', 'src/book/BookScreen.tsx'],
    },
    'src/book/ShelfScreen.tsx': {
      file: 'assets/ShelfScreen-h.js',
      isDynamicEntry: true,
      imports: ['_shared-b.js', '_cover-j.js'],
      css: ['assets/ShelfScreen-h.css'],
    },
    '_cover-j.js': { file: 'assets/cover-j.js', css: ['assets/cover-j.css'] },
    'src/book/BookScreen.tsx': {
      file: 'assets/BookScreen-i.js',
      isDynamicEntry: true,
      imports: ['_cover-j.js', '_runtime-c.js'],
      dynamicImports: ['src/book/bookSync.ts'],
    },
    'src/book/bookSync.ts': { file: 'assets/bookSync-k.js', isDynamicEntry: true },
  }

  it('lazyFiles is what a screen loads beyond the initial files: its chunk, its static imports, their CSS', () => {
    expect(lazyFiles(m, 'src/book/ShelfScreen.tsx')).toEqual({
      js: ['assets/ShelfScreen-h.js', 'assets/cover-j.js'],
      css: ['assets/ShelfScreen-h.css', 'assets/cover-j.css'],
    })
    // The writer: its own chunk and the shared cover chunk; not the initial runtime, and not
    // what it imports dynamically (a chunk of its own, fetched later).
    expect(lazyFiles(m, 'src/book/BookScreen.tsx')).toEqual({
      js: ['assets/BookScreen-i.js', 'assets/cover-j.js'],
      css: ['assets/cover-j.css'],
    })
    expect(() => lazyFiles(m, 'src/book/Nowhere.tsx')).toThrow(/no chunk/)
  })

  it('measureDist sizes each book screen it finds', () => {
    const dir = mkdtempSync(join(tmpdir(), 'budget-test-'))
    try {
      mkdirSync(join(dir, 'assets'))
      mkdirSync(join(dir, '.vite'))
      for (const f of [
        'index-a',
        'shared-b',
        'runtime-c',
        'ShelfScreen-h',
        'cover-j',
        'BookScreen-i',
      ])
        writeFileSync(join(dir, `assets/${f}.js`), 'x'.repeat(100))
      for (const f of ['index-a', 'ShelfScreen-h', 'cover-j'])
        writeFileSync(join(dir, `assets/${f}.css`), 'a{}')
      for (const f of ['index-a', 'shared-b', 'runtime-c'])
        writeFileSync(
          join(dir, `assets/${f}.js.map`),
          JSON.stringify({ version: 3, sources: ['../../apps/web/src/a.ts'] }),
        )
      writeFileSync(join(dir, '.vite/manifest.json'), JSON.stringify(m))
      writeFileSync(join(dir, 'index.html'), '')
      const measured = measureDist(dir)
      const kb = (b: string) => gzipSync(Buffer.from(b), { level: 9 }).length / 1000
      const js = kb('x'.repeat(100))
      expect(measured.screens['src/book/ShelfScreen.tsx']).toEqual({
        jsGzipKb: 2 * js,
        cssGzipKb: 2 * kb('a{}'),
        js: [
          { file: 'assets/ShelfScreen-h.js', gzipKb: js },
          { file: 'assets/cover-j.js', gzipKb: js },
        ],
        css: [
          { file: 'assets/ShelfScreen-h.css', gzipKb: kb('a{}') },
          { file: 'assets/cover-j.css', gzipKb: kb('a{}') },
        ],
      })
      expect(measured.screens['src/book/BookScreen.tsx']?.jsGzipKb).toBe(2 * js)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
