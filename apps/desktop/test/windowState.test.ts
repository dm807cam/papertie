import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_STATE,
  MIN_HEIGHT,
  MIN_WIDTH,
  parseWindowState,
  readWindowState,
  writeWindowState,
} from '../src/windowState'

const LAPTOP = { x: 0, y: 25, width: 1512, height: 920 }
const LEFT = { x: -1920, y: 0, width: 1920, height: 1080 }

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

describe('window state', () => {
  it('keeps the size and place it was left at, on a screen', () => {
    const saved = { x: 100, y: 80, width: 1200, height: 760, maximized: false, fullScreen: false }
    expect(parseWindowState(saved, [LAPTOP])).toEqual(saved)
    expect(parseWindowState({ ...saved, x: -1500, y: 40 }, [LAPTOP, LEFT])).toMatchObject({
      x: -1500,
      y: 40,
    })
    expect(parseWindowState({ ...saved, maximized: true }, [LAPTOP]).maximized).toBe(true)
  })

  it('a place on a screen that is gone is dropped (the window is centred); the size stays', () => {
    const s = parseWindowState({ x: -1500, y: 40, width: 1200, height: 760 }, [LAPTOP])
    expect(s.x).toBeUndefined()
    expect(s.y).toBeUndefined()
    expect(s).toMatchObject({ width: 1200, height: 760 })
    // Only a sliver on screen is as good as gone.
    expect(parseWindowState({ x: 1490, y: 40, width: 800, height: 600 }, [LAPTOP]).x).toBe(
      undefined,
    )
  })

  it('a size is kept within the minimum and the largest screen', () => {
    expect(parseWindowState({ width: 10, height: 10 }, [LAPTOP])).toMatchObject({
      width: MIN_WIDTH,
      height: MIN_HEIGHT,
    })
    expect(parseWindowState({ width: 9000, height: 9000 }, [LAPTOP, LEFT])).toMatchObject({
      width: 1920,
      height: 1080,
    })
  })

  it('nothing saved, or anything damaged, is the default', () => {
    for (const raw of [null, undefined, 'x', 42, [], { width: 'wide', x: 1.5, y: Number.NaN }]) {
      const s = parseWindowState(raw, [LAPTOP])
      expect(s).toMatchObject({ width: DEFAULT_STATE.width, height: DEFAULT_STATE.height })
      expect(s.x).toBeUndefined()
    }
  })

  it('is written whole and read back; a damaged file reads as the default', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'papertie-window-'))
    dirs.push(dir)
    const file = join(dir, 'window-state.json')
    expect(readWindowState(file, [LAPTOP])).toEqual(DEFAULT_STATE)
    const state = { x: 10, y: 40, width: 1000, height: 700, maximized: false, fullScreen: true }
    writeWindowState(file, state)
    expect(readWindowState(file, [LAPTOP])).toEqual(state)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(state)
    await writeFile(file, '{"width": 1000, "hei')
    expect(readWindowState(file, [LAPTOP])).toEqual(DEFAULT_STATE)
  })
})
