import { readFileSync } from 'node:fs'
import { PALETTE, PALETTE_TOKENS } from '@papertie/core'
import { STATIONERY_CSS_VARS } from '../../src/styles/stationery'

/** A stylesheet under src/, comments removed. */
export function sheet(path: string): string {
  return readFileSync(new URL(`../../src/${path}`, import.meta.url), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  )
}

/**
 * `css` as a desktop pointer with no other preference sees it: the blocks of every at-rule but
 * `@media (hover: hover)` dropped (narrow screens, short screens, reduced motion, more contrast).
 */
export function base(css: string): string {
  let out = ''
  let i = 0
  while (i < css.length) {
    const at = css.indexOf('@', i)
    if (at < 0) {
      out += css.slice(i)
      break
    }
    out += css.slice(i, at)
    const open = css.indexOf('{', at)
    const head = css.slice(at, open).trim()
    let depth = 1
    let j = open + 1
    while (depth > 0 && j < css.length) {
      if (css[j] === '{') depth++
      else if (css[j] === '}') depth--
      j++
    }
    if (head === '@media (hover: hover)') out += css.slice(open + 1, j - 1)
    else if (head.startsWith('@keyframes') || head.startsWith('@property')) out += ''
    i = j
  }
  return out
}

/** Every rule as [selectors, body], rules inside an at-rule included (the at-rule's own text is not). */
export function rules(css: string): Array<[string[], string]> {
  const out: Array<[string[], string]> = []
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (m[1] as string)
      .split(',')
      .map((s) => s.replace(/\s+/g, ' ').trim())
      .filter((s) => s !== '')
    out.push([selectors, m[2] as string])
  }
  return out
}

/**
 * The bodies of every rule whose selector list holds `selector` exactly, in source order, as one
 * body: `decl` then reads the last declaration of a property, as the cascade would.
 */
export function rule(css: string, selector: string): string {
  const found = rules(css).filter(([sels]) => sels.includes(selector))
  if (found.length === 0) throw new Error(`no rule ${selector}`)
  return found.map(([, body]) => body).join(';\n')
}

/** The value of the last `prop` declared in `body`. */
export function decl(body: string, prop: string): string | undefined {
  const all = [...body.matchAll(new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+);`, 'g'))]
  return all.at(-1)?.[1]?.replace(/\s+/g, ' ').trim()
}

/** Custom properties declared in `body`. */
export function customProps(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out[m[1] as string] = (m[2] as string).replace(/\s+/g, ' ').trim()
  }
  return out
}

/** The page's own colours: the palette and the stationery, as main.tsx installs them on :root. */
export function rootVars(): Record<string, string> {
  const vars: Record<string, string> = { ...STATIONERY_CSS_VARS }
  for (const t of PALETTE_TOKENS) {
    vars[`--paper-${t}`] = PALETTE[t].paper
    vars[`--ink-${t}`] = PALETTE[t].ink
    vars[`--yarn-${t}`] = PALETTE[t].yarn
  }
  // tokens.css's own :root (the first one: the media overrides come after it).
  const tokens = base(sheet('styles/tokens.css'))
  const root = rules(tokens).find(([s]) => s.includes(':root'))
  Object.assign(vars, customProps(root?.[1] ?? ''))
  return vars
}

export type Rgba = [number, number, number, number]

function hex(h: string): Rgba {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(h)
  if (!m) throw new Error(`not a colour: ${h}`)
  let d = m[1] as string
  if (d.length === 3) d = [...d].map((c) => c + c).join('')
  const n = Number.parseInt(d, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1]
}

/** Split on commas outside parentheses. */
function args(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let from = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++
    else if (s[i] === ')') depth--
    else if (s[i] === ',' && depth === 0) {
      out.push(s.slice(from, i).trim())
      from = i + 1
    }
  }
  out.push(s.slice(from).trim())
  return out
}

/** A percentage, or `var(--x)` naming one. */
function percent(s: string, vars: Record<string, string>): number {
  const v = /^var\((--[\w-]+)\)$/.exec(s)
  const t = v ? vars[v[1] as string] : s
  const m = /^([\d.]+)%$/.exec(t ?? '')
  if (!m) throw new Error(`not a percentage: ${s}`)
  return Number(m[1]) / 100
}

/**
 * A CSS colour expression as the page computes it: hex, `transparent`, `rgb(r g b / a)`,
 * `var(--x)` and `color-mix(in srgb, a [p%], b [q%])` (premultiplied, as CSS mixes).
 */
export function colour(expr: string, vars: Record<string, string>): Rgba {
  const e = expr.trim().replace(/\(\s+/g, '(').replace(/\s+\)/g, ')')
  if (e === 'transparent') return [0, 0, 0, 0]
  if (e.startsWith('#')) return hex(e)
  if (e === 'white') return [255, 255, 255, 1]
  const v = /^var\((--[\w-]+)\)$/.exec(e)
  if (v) {
    const val = vars[v[1] as string]
    if (val === undefined) throw new Error(`unset: ${v[1]}`)
    return colour(val, vars)
  }
  const rgb = /^rgb\((\d+) (\d+) (\d+)(?: \/ ([\d.]+))?\)$/.exec(e)
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), Number(rgb[4] ?? 1)]
  const mix = /^color-mix\(in srgb, (.*)\)$/.exec(e)
  if (mix) {
    const [a, b] = args(mix[1] as string)
    const part = (s: string) => {
      const m = /^(.*?)(?:\s+((?:[\d.]+%)|(?:var\(--[\w-]+\))))?$/.exec(s) as RegExpExecArray
      const p = m[2] === undefined ? undefined : percent(m[2], vars)
      return { c: colour(m[1] as string, vars), p }
    }
    const A = part(a as string)
    const B = part(b as string)
    const pa = A.p ?? (B.p === undefined ? 0.5 : 1 - B.p)
    const pb = B.p ?? 1 - pa
    const alpha = A.c[3] * pa + B.c[3] * pb
    const ch = (i: 0 | 1 | 2) =>
      alpha === 0 ? 0 : (A.c[i] * A.c[3] * pa + B.c[i] * B.c[3] * pb) / alpha
    return [ch(0), ch(1), ch(2), alpha]
  }
  throw new Error(`cannot resolve colour: ${e}`)
}

/** `top` laid over the opaque `ground`. */
export function over(top: Rgba, ground: Rgba): Rgba {
  const a = top[3]
  const ch = (i: 0 | 1 | 2) => top[i] * a + ground[i] * (1 - a)
  return [ch(0), ch(1), ch(2), 1]
}

export function toHex(c: Rgba): string {
  return `#${[c[0], c[1], c[2]].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`
}
