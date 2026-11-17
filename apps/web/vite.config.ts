import { fileURLToPath } from 'node:url'
import { shippedStylesheet } from '@papertie/tools/ui-fonts'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/**
 * The faces' stylesheets as the app ships them (tools/src/uiFonts.ts): every Fontsource
 * stylesheet is cut to its Latin and Latin Extended subsets and loses its `woff` fallbacks, so
 * only those `woff2` files are built in. Their `url()`s stay relative to the package's own file.
 */
function shippedFonts(): Plugin {
  return {
    name: 'papertie-shipped-fonts',
    enforce: 'pre',
    transform(code, id) {
      if (!/[\\/]@fontsource[\\/].*\.css(\?|$)/.test(id)) return null
      return { code: shippedStylesheet(code), map: null }
    },
  }
}

/**
 * zod's JSON Schema generator, replaced by a stub (`src/lib/zodNoJsonSchema.ts`) in the page's
 * build and its workers' (the parse worker validates with zod too; `worker.plugins`): every zod
 * schema carries it (some 6 KB of the initial JS, gzip), and the app never makes JSON Schema
 * (core's `gen:schema` does, in Node). That leaves room in
 * the initial chunk, and in the workers.
 */
function zodWithoutJsonSchema(): Plugin {
  const stub = fileURLToPath(new URL('./src/lib/zodNoJsonSchema.ts', import.meta.url))
  return {
    name: 'papertie-zod-without-json-schema',
    apply: 'build',
    enforce: 'pre',
    resolveId(source, importer) {
      const zod = importer !== undefined && /[\\/]zod[\\/]v4[\\/]/.test(importer)
      return zod && /(^|\/)(to-json-schema|json-schema-processors)\.js$/.test(source) ? stub : null
    },
  }
}

export default defineConfig({
  plugins: [react(), shippedFonts(), zodWithoutJsonSchema()],
  worker: { plugins: () => [zodWithoutJsonSchema()] },
  // A constant in every build, so a release build drops the dev routes' chunks (app/router.ts).
  define: { 'import.meta.env.VITE_DEV_ROUTES': JSON.stringify(process.env.VITE_DEV_ROUTES ?? '') },
  build: {
    assetsInlineLimit: 0,
    rolldownOptions: {
      output: { codeSplitting: { groups: [{ name: 'app', tags: ['$initial'] }] } },
    },
  },
})
