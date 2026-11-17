import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const src = new URL('../src/', import.meta.url).pathname
const read = (p: string) => readFileSync(p, 'utf8')

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return cssFiles(p)
    return p.endsWith('.css') ? [p] : []
  })
}

describe('the stage colour behind the cork', () => {
  const token = /--stage:\s*(#[0-9a-f]{6});/i.exec(read(join(src, 'styles/tokens.css')))?.[1]

  it('is one token, painted on the page itself', () => {
    expect(token?.toLowerCase()).toBe('#8b6b47')
    expect(read(join(src, 'styles/tokens.css'))).toMatch(/html {\s*background: var\(--stage\);/)
  })

  it('is painted before the app CSS loads, by a same-origin stylesheet (CSP style-src self)', () => {
    const html = read(new URL('../index.html', import.meta.url).pathname)
    expect(html).toContain('<link rel="stylesheet" href="/stage.css" />')
    expect(html).not.toMatch(/<style|style="/)
    const first = read(new URL('../public/stage.css', import.meta.url).pathname)
    expect(/html {\s*background: (#[0-9a-f]{6});/i.exec(first)?.[1]?.toLowerCase()).toBe(
      token?.toLowerCase(),
    )
  })

  it('is never written as a literal elsewhere in the app CSS', () => {
    for (const file of cssFiles(src)) {
      if (file.endsWith('tokens.css')) continue
      expect(read(file).toLowerCase(), file).not.toContain('#8b6b47')
    }
  })
})
