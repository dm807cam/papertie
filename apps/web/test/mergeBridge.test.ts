import { bridgeOutline, outlinePoints } from '../src/canvas/mergeBridge'

const base = { axis: 'x' as const, from: 100, to: 120, mid: 50, half: 40, inset: 6 }

describe('bridgeOutline', () => {
  it('a full join (waist and feet 1) is a straight band across the whole shared stretch', () => {
    const pts = outlinePoints(bridgeOutline({ ...base, waist: 1, foot: 1 }))
    const ys = pts.map((p) => p.y)
    expect(Math.min(...ys)).toBe(10)
    expect(Math.max(...ys)).toBe(90)
    // Every point lies on the band's two long sides.
    for (const y of ys) expect(y === 10 || y === 90).toBe(true)
  })

  it('a forming neck meets the papers on a narrow stretch only, waist narrower still', () => {
    const cmds = bridgeOutline({ ...base, waist: 0.2, foot: 0.4 })
    const ys = outlinePoints(cmds).map((p) => p.y)
    expect(Math.min(...ys)).toBe(50 - 16)
    expect(Math.max(...ys)).toBe(50 + 16)
    const waist = cmds.filter((c) => c.kind === 'C').map((c) => Math.abs(c.p.y - 50))
    expect(Math.min(...waist)).toBe(8)
  })

  it('runs along y for papers above and below each other', () => {
    const pts = outlinePoints(bridgeOutline({ ...base, axis: 'y', waist: 1, foot: 1 }))
    const xs = pts.map((p) => p.x)
    expect(Math.min(...xs)).toBe(10)
    expect(Math.max(...xs)).toBe(90)
  })
})
