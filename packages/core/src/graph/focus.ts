import type { Membership } from './membership'

export type FocusDepth = 1 | 2 | 3 | 'all'

export interface FocusQuery {
  /** Notes to focus on. Ids that are not on the board are ignored. */
  seeds: string[]
  depth: FocusDepth
  /** Notes pinned into the view by hand. Added with no depth and never expanded from. Unknown ids are ignored. */
  include: string[]
}

export interface LooseEnd {
  yarnId: string
  /** The visible note the loose end hangs from. */
  noteId: string
}

export interface FocusResult {
  notes: Set<string>
  /** Yarns whose notes are all visible. */
  yarns: Set<string>
  /** One per visible note on a not-fully-visible yarn, sorted by (yarnId, noteId). */
  looseEnds: LooseEnd[]
  /** BFS distance from the nearest seed. Seeds are 0; `include`-only notes have no entry. */
  depthOf: Map<string, number>
  canExpand: boolean
}

const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0)

/** Derive the focus neighbourhood from the membership graph. Pure; nothing is stored. */
export function computeFocus(m: Membership, q: FocusQuery): FocusResult {
  const depthOf = new Map<string, number>()
  let frontier: string[] = []
  for (const seed of q.seeds) {
    if (m.yarnsByNote.has(seed) && !depthOf.has(seed)) {
      depthOf.set(seed, 0)
      frontier.push(seed)
    }
  }

  // BFS with yarns as nodes: each yarn is expanded once, so the cost is O(notes + sum of thread lengths).
  const limit = q.depth === 'all' ? Number.POSITIVE_INFINITY : q.depth
  const visitedYarns = new Set<string>()
  for (let dist = 0; dist < limit && frontier.length > 0; dist++) {
    const next: string[] = []
    for (const id of frontier) {
      for (const yarnId of m.yarnsByNote.get(id) ?? []) {
        if (visitedYarns.has(yarnId)) continue
        visitedYarns.add(yarnId)
        for (const other of m.notesByYarn.get(yarnId) ?? []) {
          if (m.yarnsByNote.has(other) && !depthOf.has(other)) {
            depthOf.set(other, dist + 1)
            next.push(other)
          }
        }
      }
    }
    frontier = next
  }

  const notes = new Set(depthOf.keys())
  for (const id of [...q.include].sort(cmp)) {
    if (m.yarnsByNote.has(id)) notes.add(id)
  }

  const candidateYarns = new Set<string>()
  for (const id of notes) for (const y of m.yarnsByNote.get(id) ?? []) candidateYarns.add(y)

  const yarns = new Set<string>()
  const looseEnds: LooseEnd[] = []
  for (const yarnId of [...candidateYarns].sort(cmp)) {
    const members = new Set(m.notesByYarn.get(yarnId) ?? [])
    const visible = [...members].filter((id) => notes.has(id)).sort(cmp)
    if (visible.length === members.size) yarns.add(yarnId)
    else for (const noteId of visible) looseEnds.push({ yarnId, noteId })
  }

  return {
    notes,
    yarns,
    looseEnds,
    depthOf,
    canExpand: looseEnds.length > 0 && q.depth !== 'all',
  }
}
