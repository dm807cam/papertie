/**
 * A test-only well-formedness check of an XML document (no dependency): one root, every tag
 * closed in order, attributes quoted and unique, every `&` an entity, no `<` or `>` loose in text,
 * no character XML forbids. Throws with the offset of the first fault. Not a validator.
 */
const TAG =
  /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/y
const ATTR = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/g
const ENTITY = /&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/y
// biome-ignore lint/suspicious/noControlCharactersInRegex: the characters XML 1.0 forbids
const FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/

function checkText(s: string, at: number): void {
  if (FORBIDDEN.test(s)) throw new Error(`forbidden character near ${at}`)
  if (s.includes('>')) throw new Error(`loose > near ${at}`)
  for (let i = s.indexOf('&'); i >= 0; i = s.indexOf('&', i + 1)) {
    ENTITY.lastIndex = i
    if (!ENTITY.test(s)) throw new Error(`bad entity near ${at + i}`)
  }
}

export function assertWellFormed(xml: string): void {
  let i = 0
  if (xml.startsWith('<?xml')) {
    i = xml.indexOf('?>') + 2
    if (i < 2) throw new Error('unterminated prolog')
  }
  const stack: string[] = []
  let roots = 0
  while (i < xml.length) {
    const lt = xml.indexOf('<', i)
    const text = xml.slice(i, lt < 0 ? xml.length : lt)
    if (stack.length === 0 && text.trim() !== '') throw new Error(`text outside the root at ${i}`)
    checkText(text, i)
    if (lt < 0) break
    TAG.lastIndex = lt
    const m = TAG.exec(xml)
    if (!m) throw new Error(`bad tag at ${lt}: ${xml.slice(lt, lt + 40)}`)
    const [whole, close, name, attrs, selfClose] = m as unknown as [
      string,
      string,
      string,
      string,
      string,
    ]
    if (close) {
      if (attrs || selfClose) throw new Error(`bad end tag at ${lt}`)
      if (stack.pop() !== name) throw new Error(`mismatched </${name}> at ${lt}`)
    } else {
      if (stack.length === 0 && ++roots > 1) throw new Error(`a second root at ${lt}`)
      const seen = new Set<string>()
      for (const a of attrs.matchAll(ATTR)) {
        if (seen.has(a[1] as string)) throw new Error(`duplicate attribute ${a[1]} at ${lt}`)
        seen.add(a[1] as string)
        checkText(a[2] ?? a[3] ?? '', lt)
      }
      if (!selfClose) stack.push(name)
    }
    i = lt + whole.length
  }
  if (stack.length > 0) throw new Error(`unclosed <${stack.at(-1)}>`)
  if (roots !== 1) throw new Error('no root element')
}
