import { LIMITS, NoteRecordSchema } from '@papertie/core'
import { isTag } from '../src/canvas/geometry'
import { MOCKUP_NOTES } from '../src/study/MockupNotes'

describe('mockup note specimens', () => {
  it('are notes a real board can hold', () => {
    for (const n of Object.values(MOCKUP_NOTES)) {
      expect(NoteRecordSchema.safeParse(n).success).toBe(true)
    }
  })

  it('draw tags at the narrowest width core allows, tall and narrow', () => {
    for (const n of [MOCKUP_NOTES.tag, MOCKUP_NOTES.printTag]) {
      expect(n.w).toBe(LIMITS.noteMinW)
      expect(isTag(n)).toBe(true)
      expect(n.h).toBeGreaterThanOrEqual(2.4 * n.w)
    }
  })
})
