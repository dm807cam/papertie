/**
 * The web faces as the app ships them. A Fontsource stylesheet (`<weight>.css`) declares one
 * `@font-face` per subset, each with its unicode-range and a `woff2` and a `woff` file. The app
 * ships the Latin and Latin Extended subsets as `woff2`: a Vite transform passes every Fontsource
 * stylesheet through `shippedStylesheet` (`apps/web/vite.config.ts`), so nothing else is built in.
 */

/** The subsets the app ships of every face. */
export const SHIPPED_SUBSETS = ['latin', 'latin-ext'] as const

/** One `@font-face` of a Fontsource stylesheet, with the comment that names it. */
export interface Face {
  /** `<package>-<subset>-<weight>-<style>`, as Fontsource names it. */
  name: string
  family: string
  text: string
  ranges: Array<[number, number]>
}

/** The `@font-face` rules of a stylesheet, each with its unicode-range parsed. */
export function facesOf(css: string): Face[] {
  const out: Face[] = []
  const re = /(?:\/\* ([^*]+?) \*\/\s*)?@font-face\s*\{([^}]*)\}/g
  for (let m = re.exec(css); m !== null; m = re.exec(css)) {
    const body = m[2] as string
    const family = /font-family:\s*['"]?([^;'"]+)['"]?/.exec(body)?.[1]?.trim() ?? ''
    const range = /unicode-range:\s*([^;]+)/.exec(body)?.[1] ?? ''
    const ranges = range
      .split(',')
      .map((p) => p.trim().replace(/^U\+/i, ''))
      .filter((p) => p !== '')
      .map((p): [number, number] => {
        const [a, b] = p.split('-')
        const lo = Number.parseInt(a as string, 16)
        return [lo, b === undefined ? lo : Number.parseInt(b, 16)]
      })
    out.push({ name: m[1]?.trim() ?? '', family, text: m[0], ranges })
  }
  return out
}

const SHIPPED = new RegExp(`-(${SHIPPED_SUBSETS.join('|')})-\\d+-(normal|italic)$`)

/** Whether a Fontsource face is one of the subsets the app ships. */
export const isShipped = (f: Face): boolean => SHIPPED.test(f.name)

/** A Fontsource stylesheet without its `woff` fallbacks: Chromium reads the `woff2`. */
export const woff2Only = (css: string): string =>
  css.replace(/,\s*url\([^)]*\.woff\)\s*format\((['"])woff\1\)/g, '')

/** A Fontsource stylesheet cut to what the app ships: {@link SHIPPED_SUBSETS}, `woff2` only. */
export function shippedStylesheet(css: string): string {
  return woff2Only(
    facesOf(css)
      .filter(isShipped)
      .map((f) => f.text)
      .join('\n'),
  )
}
