import { YarnRenderer } from '../../src/canvas/YarnRenderer'

/**
 * A test-only switch: `globalThis.__papertieTest.yarnCpuRaster`
 * gives the yarn's static canvases a CPU-backed context, so a patched layer and a whole redraw can
 * be compared without the GPU canvas's batch-dependent raster. Off, they are as shipped.
 */
function canvases() {
  const asked: unknown[][] = []
  const make = () =>
    ({
      width: 1,
      height: 1,
      getContext: (...a: unknown[]) => {
        asked.push(a)
        return null
      },
    }) as unknown as HTMLCanvasElement
  return { asked, make }
}

describe('the yarn static canvases', () => {
  afterEach(() => {
    delete (globalThis as { __papertieTest?: unknown }).__papertieTest
  })

  it('are asked for a plain 2D context by default', () => {
    const { asked, make } = canvases()
    new YarnRenderer(make(), make(), make)
    // The two on-screen canvases, then the two static ones.
    expect(asked).toEqual([['2d'], ['2d'], ['2d'], ['2d']])
  })

  it('are asked for a CPU-backed context under the test switch, the on-screen ones not', () => {
    ;(globalThis as { __papertieTest?: unknown }).__papertieTest = { yarnCpuRaster: true }
    const { asked, make } = canvases()
    new YarnRenderer(make(), make(), make)
    expect(asked).toEqual([
      ['2d'],
      ['2d'],
      ['2d', { willReadFrequently: true }],
      ['2d', { willReadFrequently: true }],
    ])
  })
})
