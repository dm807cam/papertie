import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isId, PALETTE_TOKENS, PAPER_STYLES, validateInvariants } from '@papertie/core'
import { PROTO_ASSET_ID as TOOLS_PROTO_ASSET_ID } from '@papertie/tools/gen-board'
import { fitRect } from '../src/canvas/Camera'
import { isTag, noteBounds, pinPosition } from '../src/canvas/geometry'
import { type Point, type Rect, rectContainsPoint, rectsIntersect } from '../src/canvas/types'
import { evalBezier, flattenBezier, restSagPoint, segmentBezier } from '../src/canvas/yarnGeometry'
import { PROTO_ASSET_ID, PROTO_ASSETS } from '../src/dev/assets'
import { DEMO_FRAME, DEMO_IDS, DEMO_MOCKUP, demoBoard } from '../src/dev/demoBoard'
import { assetUrl } from '../src/lib/assets'
import { noteRotationDeg } from '../src/lib/seed'

const NOW = '2026-10-27T00:00:00.000Z'

describe('demoBoard', () => {
  it('is valid and complete', () => {
    const s = demoBoard(NOW)
    expect(validateInvariants(s)).toEqual([])
    expect([s.notes.size, s.yarns.size, s.assets.size]).toEqual([23, 12, 4])
    expect(new Set([...s.notes.values()].map((n) => n.paper))).toEqual(new Set(PALETTE_TOKENS))
    expect(new Set([...s.notes.values()].map((n) => n.style))).toEqual(new Set(PAPER_STYLES))
    expect(s.yarns.get(DEMO_IDS.threeNote)?.noteIds).toHaveLength(3)
    expect(s.assets.has(PROTO_ASSET_ID)).toBe(true)
    for (const id of Object.values(DEMO_IDS)) expect(isId(id)).toBe(true)
  })

  it('stamps every record with now', () => {
    const s = demoBoard('2027-01-02T03:04:05.000Z')
    for (const r of [...s.notes.values(), ...s.yarns.values()]) {
      expect(r.createdAt).toBe('2027-01-02T03:04:05.000Z')
    }
  })

  it('tools and web agree on the placeholder asset id', () => {
    expect(TOOLS_PROTO_ASSET_ID).toBe(PROTO_ASSET_ID)
  })

  it('has the hub on exactly 4 threads, the print note with an image and a one-sentence note', () => {
    const s = demoBoard(NOW)
    const onHub = [...s.yarns.values()].filter((y) => y.noteIds.includes(DEMO_IDS.hub))
    expect(onHub).toHaveLength(4)
    const print = s.notes.get(DEMO_IDS.print)
    expect(print?.style).toBe('print')
    expect(print?.image).toEqual({ assetId: PROTO_ASSET_ID, frame: 'print' })
    expect(s.notes.get(DEMO_IDS.knot)?.text).toBe('A knot ties thoughts together.')
    expect(s.yarns.get(DEMO_IDS.crossed)?.noteIds).toHaveLength(2)
  })

  it('keeps the test notes inside the 2400x1600 world area', () => {
    const mockup = new Set<string>(Object.values(DEMO_MOCKUP))
    for (const n of demoBoard(NOW).notes.values()) {
      if (mockup.has(n.id)) continue
      expect(n.x).toBeGreaterThanOrEqual(0)
      expect(n.y).toBeGreaterThanOrEqual(0)
      expect(n.x + n.w).toBeLessThanOrEqual(2400)
      expect(n.y + n.h).toBeLessThanOrEqual(1600)
    }
  })

  describe('overlap', () => {
    const s = demoBoard(NOW)
    const crossed = s.yarns.get(DEMO_IDS.crossed)
    const [a, b] = (crossed?.noteIds ?? []).map((id) => s.notes.get(id))
    const overlap = s.notes.get(DEMO_IDS.overlap)
    const rects: Rect[] = [...s.notes.values()].map((n) => noteBounds(n))
    const inNote = (p: Point) => rects.some((r) => rectContainsPoint(r, p))

    it('the crossed notes are at least 500 px apart horizontally', () => {
      expect(a && b).toBeTruthy()
      if (!a || !b) return
      expect(Math.abs(pinPosition(a).x - pinPosition(b).x)).toBeGreaterThanOrEqual(500)
    })

    it('sits above the crossed yarn and intersects its rest curve', () => {
      if (!a || !b || !overlap) throw new Error('missing demo notes')
      expect(overlap.z).toBeGreaterThan(a.z)
      expect(overlap.z).toBeGreaterThan(b.z)
      expect(crossed?.noteIds).not.toContain(overlap.id)

      const pa = pinPosition(a)
      const pb = pinPosition(b)
      const curve = segmentBezier(pa, pb, restSagPoint(pa, pb))
      const pts = flattenBezier(curve, 0.5)
      const box = noteBounds(overlap)
      const inset = 40
      const deep: Rect = {
        x: box.x + inset,
        y: box.y + inset,
        w: box.w - 2 * inset,
        h: box.h - 2 * inset,
      }
      expect(pts.some((p) => rectContainsPoint(deep, p))).toBe(true)
      expect(pts.some((p) => !inNote(p))).toBe(true)
      expect(inNote(evalBezier(curve, 0.5))).toBe(false)
    })
  })
})

describe('the mockup composition', () => {
  const s = demoBoard(NOW)
  const M = DEMO_MOCKUP
  const note = (id: string) => {
    const n = s.notes.get(id)
    if (n === undefined) throw new Error(`no note ${id}`)
    return n
  }
  const title = (id: string) => note(id).text.split('\n').slice(0, 2)

  it('has the mockup notes with their titles, papers and decorations', () => {
    expect(title(M.centre)).toEqual(['Paper goods', 'Stationery Design'])
    expect(title(M.spring)).toEqual(['Spring trip', 'Spring Journey'])
    expect(note(M.spring).text).toContain(
      '- Orchard in bloom\n- Old town streets\n- The paper shop',
    )
    expect(title(M.inspiration)).toEqual(['Ideas', 'Inspiration'])
    expect(title(M.experience)).toEqual(['Practice', 'Experience'])
    expect(title(M.materials)).toEqual(['Stock', 'Materials'])
    for (const [id, paper] of [
      [M.centre, 'cream'],
      [M.spring, 'cream'],
      [M.inspiration, 'indigo'],
      [M.experience, 'lilac'],
      [M.materials, 'ochre'],
    ] as const) {
      expect(note(id)).toMatchObject({ paper, style: 'rustic' })
    }
    // The decorations are fields of the records themselves, so they persist with the board.
    const decor = (id: string) => {
      const { motif, stamp, layered } = note(id)
      return { motif, stamp, layered }
    }
    expect(decor(M.centre)).toEqual({ stamp: true })
    expect(decor(M.spring)).toEqual({ motif: 'fold', layered: 'rose' })
    expect(decor(M.inspiration).motif).toBe('margin')
    expect(decor(M.marginTag).motif).toBe('margin')
    expect(decor(M.experience).motif).toBe('perforation')
    expect(decor(M.materials).motif).toBe('dots')
    expect('motif' in note(M.centre)).toBe(false)
    expect('stamp' in note(M.spring)).toBe(false)
  })

  it('has two tags at core width, tall, one of them the field print', () => {
    for (const id of [M.marginTag, M.fieldTag]) {
      const n = note(id)
      expect(isTag(n)).toBe(true)
      expect(n.w).toBe(120)
      expect(n.h).toBeGreaterThanOrEqual(2.4 * n.w)
    }
    expect(note(M.fieldTag).image).toEqual({ assetId: PROTO_ASSETS.field, frame: 'print' })
  })

  it('has the lake and desk prints, tilted as in the mockup', () => {
    expect(note(M.lake)).toMatchObject({
      style: 'print',
      image: { assetId: PROTO_ASSETS.lake },
    })
    expect(note(M.desk)).toMatchObject({ style: 'print', image: { assetId: PROTO_ASSETS.desk } })
    expect(noteRotationDeg(note(M.lake))).toBeGreaterThan(2)
    expect(noteRotationDeg(note(M.desk))).toBeLessThan(-2)
    expect(noteRotationDeg(note(M.fieldTag))).toBeGreaterThan(2)
  })

  it('threads the centre to five notes in the mockup colours', () => {
    const onCentre = [...s.yarns.values()].filter((y) => y.noteIds.includes(M.centre))
    expect(onCentre.map((y) => y.color).sort()).toEqual(
      ['lilac', 'apricot', 'ochre', 'sage', 'rose'].sort(),
    )
    const pairs = onCentre.flatMap((y) =>
      y.noteIds.slice(1).map((b, i) => [y.color, y.noteIds[i], b].join(' ')),
    )
    for (const [color, other] of [
      ['rose', M.spring],
      ['ochre', M.inspiration],
      ['lilac', M.experience],
      ['sage', M.fieldTag],
      ['apricot', M.materials],
      ['apricot', M.desk],
    ] as const) {
      expect(
        pairs.some(
          (p) => p === `${color} ${M.centre} ${other}` || p === `${color} ${other} ${M.centre}`,
        ),
      ).toBe(true)
    }
    const apricot = onCentre.find((y) => y.color === 'apricot')
    if (apricot === undefined) throw new Error('no apricot yarn')
    expect(apricot.noteIds).toEqual([M.materials, M.centre, M.desk])
  })

  it('frames the mockup at the initial fit: 1:1 at 1672x941, the test notes outside it', () => {
    const cam = fitRect(DEMO_FRAME, { width: 1672, height: 941 })
    expect(cam.zoom).toBeCloseTo(1, 9)
    const view: Rect = { x: cam.x, y: cam.y, w: 1672, h: 941 }
    const mockup = new Set<string>(Object.values(M))
    for (const n of s.notes.values()) {
      const r = noteBounds(n)
      if (mockup.has(n.id)) {
        expect(rectContainsPoint(view, { x: r.x + r.w / 2, y: r.y + r.h / 2 })).toBe(true)
      } else {
        // At any viewport aspect the fit keeps the frame; 600 px of margin covers wide screens.
        const wide: Rect = { x: view.x - 600, y: view.y - 300, w: view.w + 1200, h: view.h + 600 }
        expect(rectsIntersect(wide, r)).toBe(false)
      }
    }
  })

  it('records each asset with the bytes, hash and size of its committed 1024 file', () => {
    const root = join(import.meta.dirname, '..', 'public')
    const manifest = JSON.parse(readFileSync(join(root, 'textures', 'manifest.json'), 'utf8')) as {
      files: Array<{ path: string; width: number; height: number }>
    }
    for (const a of s.assets.values()) {
      const url = assetUrl(a.id, 1024)
      const bytes = readFileSync(join(root, url))
      expect(a.bytes).toBe(bytes.length)
      expect(a.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
      const entry = manifest.files.find((f) => `/textures/${f.path}` === url)
      expect([a.width, a.height]).toEqual([entry?.width, entry?.height])
    }
  })
})
