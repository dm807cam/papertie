import type { Page } from '@playwright/test'
import type { Pt } from '../hooks'
import { expect, test } from './helpers/app'
import { idle, saved } from './helpers/board'
import { exportJsonl, firstRun, onlyBoard, openBoard, waitReady } from './helpers/server'

/**
 * Shared pins are kept: two threads tied at one pin of a note (and one at a hanging pin) are
 * written to the board file, and after a reload they are drawn from the same pins. The
 * gestures that make them are the proto spec `shared-pins`.
 */

/** A note id the board has not seen: `note_` and 26 Crockford digits. */
const freshId = (n: number) => `note_01JBSH${String(Date.now() * 10 + n).padStart(20, '0')}`

interface YarnRec {
  id: string
  noteIds: string[]
  pins?: Record<string, string>
}

const yarns = (page: Page) =>
  page.evaluate(
    () => [...window.__papertie.store.getState().yarns.values()] as unknown as YarnRec[],
  )

const attach = async (page: Page, yarnId: string, end: 'a' | 'b'): Promise<Pt> => {
  const p = await page.evaluate(([id, end]) => window.__papertie.debug.attachScreen(id, 0, end), [
    yarnId,
    end,
  ] as const)
  if (p === undefined) throw new Error(`no pin for ${yarnId}`)
  return p
}

const near = (p: Pt, q: Pt, px: number) => Math.hypot(p.x - q.x, p.y - q.y) <= px

test('threads tied at one pin are saved so, and drawn at it after a reload', async ({
  page,
  api,
}) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await firstRun(api)
  await openBoard(page)
  await saved(page)
  const boardId = await onlyBoard(api)

  const [a, b, c] = [freshId(1), freshId(2), freshId(3)]
  // Three notes in the view: A left of B, C below B.
  await page.evaluate(
    ({ a, b, c }) => {
      const m = window.__papertie as unknown as {
        store: { commit(ops: unknown[]): void; now(): string }
        runtime: {
          drawnCamera(): { x: number; y: number; zoom: number }
          yarnFlows: {
            tie(
              from: string,
              to: string,
              color?: string,
              pins?: { from?: unknown; to?: unknown },
            ): { yarnId: string }
          }
        }
      }
      const cam = m.runtime.drawnCamera()
      const now = m.store.now()
      const note = (id: string, x: number, y: number, text: string) => ({
        op: 'note.create',
        note: {
          type: 'note',
          id,
          x: Math.round(cam.x + x / cam.zoom),
          y: Math.round(cam.y + y / cam.zoom),
          w: 220,
          h: 140,
          z: 1000,
          paper: 'cream',
          style: 'rustic',
          text,
          image: null,
          createdAt: now,
          updatedAt: now,
        },
      })
      m.store.commit([note(a, 300, 200, 'A'), note(b, 750, 200, 'B'), note(c, 750, 480, 'C')])
      const ab = m.runtime.yarnFlows.tie(a, b, 'apricot')
      m.runtime.yarnFlows.tie(c, b, 'indigo', {
        from: 'hanging',
        to: { yarnId: ab.yarnId, end: 'b' },
      })
    },
    { a, b, c },
  )
  await saved(page)
  await idle(page)

  const before = await yarns(page)
  const ab = before.find((y) => y.noteIds[0] === a) as YarnRec
  const cb = before.find((y) => y.noteIds[0] === c) as YarnRec
  const key = ab.pins?.[b]
  expect(key).toBe(`y${ab.id.slice(5)}p`)
  expect(cb.pins).toEqual({ [c]: 'hanging', [b]: key })
  const atB = await attach(page, ab.id, 'b')
  expect(near(await attach(page, cb.id, 'b'), atB, 0.5)).toBe(true)

  // The board file holds both maps.
  const file = (await exportJsonl(api, boardId))
    .split('\n')
    .filter((l) => l.includes('"type":"yarn"'))
    .map((l) => JSON.parse(l) as YarnRec)
  expect(file.find((y) => y.id === ab.id)?.pins).toEqual({ [b]: key })
  expect(file.find((y) => y.id === cb.id)?.pins).toEqual({ [c]: 'hanging', [b]: key })

  await page.reload()
  await waitReady(page)
  await idle(page)
  const after = await yarns(page)
  expect(after.find((y) => y.id === ab.id)?.pins).toEqual({ [b]: key })
  expect(after.find((y) => y.id === cb.id)?.pins).toEqual({ [c]: 'hanging', [b]: key })
  const again = await attach(page, ab.id, 'b')
  expect(near(await attach(page, cb.id, 'b'), again, 0.5)).toBe(true)
  const hanging = await page.evaluate((id) => window.__papertie.debug.pinScreen(id), c)
  expect(hanging && near(await attach(page, cb.id, 'a'), hanging, 0.5)).toBe(true)
  expect(errors).toEqual([])
})
