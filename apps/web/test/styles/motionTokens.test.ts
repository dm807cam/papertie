import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { EASE_CSS, MOTION } from '../../src/styles/motion'

const SRC = new URL('../../src/', import.meta.url).pathname

function files(dir: string, exts: readonly string[]): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? files(p, exts) : exts.some((e) => n.endsWith(e)) ? [p] : []
  })
}

/** Split on commas outside parentheses. */
function topLevel(value: string): string[] {
  const out: string[] = []
  let depth = 0
  let from = 0
  for (let i = 0; i < value.length; i++) {
    const c = value[i]
    if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === ',' && depth === 0) {
      out.push(value.slice(from, i))
      from = i + 1
    }
  }
  out.push(value.slice(from))
  return out.map((s) => s.trim()).filter((s) => s !== '')
}

/** Tokens of one transition or animation item, `var(...)` and functions kept whole. */
function words(item: string): string[] {
  return item.match(/[\w-]+\([^()]*(?:\([^()]*\)[^()]*)*\)|[^\s]+/g) ?? []
}

const DURATION = /^(?:-?[\d.]+m?s|var\(--[\w-]+\))$/
const EASING =
  /^(?:ease(?:-in|-out|-in-out)?|linear|step-start|step-end|cubic-bezier\(.*\)|steps\(.*\)|linear\(.*\)|var\(--ease\))$/
const isDuration = (w: string) => DURATION.test(w) && !/^var\(--ease\)$/.test(w)

/** The only durations a transition or animation may take: the tokens, or none at all. */
const TOKENS = new Set(['var(--motion-fast)', 'var(--motion-base)', 'var(--motion-slow)'])
const ZERO = /^0m?s$/
/**
 * Named exceptions, each with its source: the focus fade's 250 ms is its own
 * (focus.css), on the shared ease and 0 ms under reduced motion; a photo being added is a wait,
 * not a step of the UI, and its line's one pass is slower than those (photos.css), on the shared
 * ease and still under reduced motion.
 */
const EXCEPTIONS: Record<string, string> = {
  'var(--focus-fade)': 'focus/focus.css',
  'var(--photo-adding)': 'images/photos.css',
}

interface Use {
  file: string
  prop: string
  item: string
}

/** Every transition and animation item declared in a stylesheet under src/. */
function cssUses(): Use[] {
  const uses: Use[] = []
  for (const f of files(SRC, ['.css'])) {
    const css = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const decl =
      /(?:^|[;{\s])((?:transition|animation)(?:-duration|-delay|-timing-function)?)\s*:\s*([^;{}]+);/g
    for (const m of css.matchAll(decl)) {
      for (const item of topLevel(m[2] as string)) {
        uses.push({ file: relative(SRC, f), prop: m[1] as string, item })
      }
    }
  }
  return uses
}

describe('motion tokens', () => {
  const uses = cssUses()

  it('finds the stylesheets’ transitions and animations', () => {
    expect(uses.length).toBeGreaterThan(60)
    expect(uses.some((u) => u.file === 'ui/sidebar.css' && u.prop === 'transition')).toBe(true)
    expect(uses.some((u) => u.prop === 'animation')).toBe(true)
  })

  it('no CSS transition or animation uses a duration or easing outside the motion tokens', () => {
    const bad: string[] = []
    for (const u of uses) {
      if (u.item === 'none') continue
      const ws = words(u.item)
      const durations = ws.filter(isDuration)
      const easings = ws.filter((w) => EASING.test(w))
      // Shorthands: the first time is the duration, the second the delay; the longhands are one.
      const duration =
        u.prop.endsWith('-delay') || u.prop.endsWith('-timing-function') ? undefined : durations[0]
      const delay = u.prop.endsWith('-delay') ? durations[0] : durations[1]
      const ok = (t: string | undefined) =>
        t === undefined ||
        ZERO.test(t) ||
        TOKENS.has(t) ||
        (EXCEPTIONS[t] !== undefined && EXCEPTIONS[t] === u.file)
      if (!ok(duration) || !ok(delay)) bad.push(`${u.file}: ${u.prop}: ${u.item}`)
      for (const e of easings) {
        // A step that takes no time (a visibility flip held back by a delay) has no curve to keep.
        const instant = duration !== undefined && ZERO.test(duration)
        if (e !== 'var(--ease)' && !(e === 'linear' && instant)) {
          bad.push(`${u.file}: ${u.prop}: ${u.item} (easing ${e})`)
        }
      }
    }
    expect(bad).toEqual([])
  })

  it('every animate() call takes its timing from motion.ts', () => {
    const calls: string[] = []
    for (const f of files(SRC, ['.ts', '.tsx'])) {
      // Code only: a comment may name `Element.animate()`.
      const text = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
      for (const m of text.matchAll(/\.animate\(\s*\[([\s\S]*?)\],\s*(\{[\s\S]*?\})\s*,?\s*\)/g)) {
        calls.push(relative(SRC, f))
        const frames = (m[1] as string).match(/\{[^{}]*\}/g)?.length ?? 0
        const opts = m[2] as string
        const duration = /duration:\s*([^,}]+)/.exec(opts)?.[1]?.trim()
        const easing = /easing:\s*([^,}]+)/.exec(opts)?.[1]?.trim()
        // One token a beat: a keyframe list of n + 1 frames may last n of the same token.
        const beat = /^MOTION\.(fast|base|slow)(?:\s*\*\s*(\d+))?$/.exec(duration ?? '')
        expect(beat, `${f}: duration ${duration}`).not.toBeNull()
        expect(Number(beat?.[2] ?? 1), `${f}: beats`).toBeLessThanOrEqual(Math.max(1, frames - 1))
        expect(easing, `${f}: easing`).toBe('EASE_CSS')
      }
      if (/\.animate\(/.test(text) && !calls.includes(relative(SRC, f))) {
        throw new Error(`${relative(SRC, f)}: an animate() call this test cannot read`)
      }
    }
    expect(calls.length).toBeGreaterThan(0)
  })

  it('EASE_CSS is the tokens’ curve, as tokens.css writes it', () => {
    expect(EASE_CSS).toBe('cubic-bezier(.2, .8, .2, 1)')
    expect(MOTION).toEqual({ fast: 120, base: 200, slow: 320 })
  })
})
