/**
 * Edits inside a block: splices of its text, and its marks carried through them.
 */
import type { Mark } from '../schema/records'

/** Replace `del` UTF-16 units at `at` with `ins`, against the text the splices before it left. */
export interface Splice {
  at: number
  del: number
  ins: string
  /**
   * The marks `ins` takes, as the page that typed it saw them; without it, those of
   * the place by the marks' rule. An op says it beside its splices (`block.edit` `takes`:
   * {@link takenSplices}).
   */
  takes?: Mark['t'][]
}

/** What each splice of an edit says its text takes (`block.edit` `takes`). */
export type Takes = (Mark['t'][] | null)[]

/** An edit's `splices`, each with what `takes` says its text takes (by index) on it. */
export function takenSplices(splices: readonly Splice[], takes?: Takes): readonly Splice[] {
  if (!takes) return splices
  return splices.map((s, k) => {
    const t = takes[k]
    return t ? { ...s, takes: t } : s
  })
}

/**
 * `splices` as an edit says them: the splices (these, where none says what it takes), and
 * `takes` beside them where one says it.
 */
export function statedSplices(splices: readonly Splice[]): { splices: Splice[]; takes?: Takes } {
  let said = false
  for (const s of splices) if (s.takes) said = true
  if (!said) return { splices: splices as Splice[] }
  return {
    splices: splices.map(({ at, del, ins }) => ({ at, del, ins })),
    takes: splices.map((s) => s.takes ?? null),
  }
}

/**
 * Work done by {@link editOf} (runs and points visited): what a test bounds, never a clock.
 * Internal; not exported from the package.
 */
export const SPLICE_WORK = { steps: 0 }

/**
 * A run of the edited text, in order. Original text keeps its points: point `p` (the place
 * before original character `p`; point `length` is the end) stays with the character after it.
 * - `o`: original characters `[from, from + n)`, each with its point before it.
 * - `g`: points `[from, from + n)` whose characters were deleted.
 * - `i`: inserted text (`s`), no original points; `t`, the marks its splice says it takes.
 */
type Run =
  | { k: 'o'; from: number; n: number }
  | { k: 'g'; from: number; n: number }
  | { k: 'i'; s: string; t?: Mark['t'][] | undefined }

const charsOf = (r: Run): number => (r.k === 'o' ? r.n : r.k === 'i' ? r.s.length : 0)

/** Runs per block of the edit's run list before the block is split. */
const BLOCK = 32

/** Splices applied to a text, kept as runs: the text, what each deleted, and where points went. */
interface Edit {
  readonly blocks: Run[][]
  /** The characters in each block. */
  readonly chars: number[]
  /** The text each splice deleted, in splice order (with `keep`, else empty strings). */
  readonly deleted: string[]
}

/**
 * `splices` applied in order to a text of `length` (each against the text the one before it
 * left), as runs of the original and inserted text, with each point carried: a point where
 * text is inserted goes after it, and points inside a deletion go where it was, after what
 * replaced it. Runs are kept in blocks of about {@link BLOCK} with their character counts, so a
 * splice finds its place in O(runs / BLOCK + BLOCK) steps: an edit costs O(splices × (splices /
 * BLOCK + BLOCK)) whatever its text or marks. `text`, when given, is the original text, for what
 * each splice deleted. Throws `RangeError` for a splice past the text.
 */
function editOf(length: number, splices: readonly Splice[], text: string | null): Edit {
  const first: Run[] = length > 0 ? [{ k: 'o', from: 0, n: length }] : []
  first.push({ k: 'g', from: length, n: 1 })
  const blocks: Run[][] = [first]
  const chars = [length]
  let total = length
  const deleted: string[] = []
  for (const sp of splices) {
    if (!(sp.at >= 0 && sp.del >= 0 && sp.at + sp.del <= total)) {
      throw new RangeError(`splice at ${sp.at} deleting ${sp.del} is past the text (${total})`)
    }
    // The place right after character `at − 1`, before any points that follow it.
    let bi = 0
    let ri = 0
    if (sp.at > 0) {
      let acc = 0
      while ((chars[bi] as number) === 0 || acc + (chars[bi] as number) < sp.at) {
        acc += chars[bi] as number
        bi++
        SPLICE_WORK.steps++
      }
      const runs = blocks[bi] as Run[]
      for (; ; ri++) {
        SPLICE_WORK.steps++
        const r = runs[ri] as Run
        const c = charsOf(r)
        if (c > 0 && acc + c >= sp.at) {
          const k = sp.at - acc
          if (k < c) runs.splice(ri, 1, ...cut(r, k))
          ri++
          break
        }
        acc += c
      }
    }
    // Delete `del` characters from there on: original ones leave their points behind.
    let rest = sp.del
    let gone = ''
    let b = bi
    let j = ri
    while (rest > 0) {
      const runs = blocks[b] as Run[]
      if (j >= runs.length || (j === 0 && chars[b] === 0)) {
        b++
        j = 0
        SPLICE_WORK.steps++
        continue
      }
      SPLICE_WORK.steps++
      const r = runs[j] as Run
      const c = charsOf(r)
      if (c === 0) {
        j++
        continue
      }
      const take = Math.min(c, rest)
      if (r.k === 'o') {
        if (text !== null) gone += text.slice(r.from, r.from + take)
        const pieces: Run[] = [{ k: 'g', from: r.from, n: take }]
        if (take < c) pieces.push({ k: 'o', from: r.from + take, n: c - take })
        runs.splice(j, 1, ...pieces)
        j += pieces.length
      } else if (r.k === 'i') {
        gone += r.s.slice(0, take)
        if (take < c) runs[j++] = { k: 'i', s: r.s.slice(take), t: r.t }
        else runs.splice(j, 1)
      }
      chars[b] = (chars[b] as number) - take
      rest -= take
    }
    deleted.push(gone)
    if (sp.ins.length > 0) {
      ;(blocks[bi] as Run[]).splice(ri, 0, { k: 'i', s: sp.ins, t: sp.takes })
      chars[bi] = (chars[bi] as number) + sp.ins.length
    }
    total += sp.ins.length - sp.del
    // Split the blocks this splice grew (the later first, so the earlier keeps its index).
    for (const x of b === bi ? [bi] : [b, bi]) {
      const runs = blocks[x] as Run[]
      if (runs.length <= 2 * BLOCK) continue
      const tail = runs.splice(BLOCK)
      let c = 0
      for (const r of tail) c += charsOf(r)
      blocks.splice(x + 1, 0, tail)
      chars.splice(x + 1, 0, c)
      chars[x] = (chars[x] as number) - c
    }
  }
  return { blocks, chars, deleted }
}

/** `r` cut after its first `k` characters (0 < k < its length). */
function cut(r: Run, k: number): [Run, Run] {
  if (r.k === 'i')
    return [
      { k: 'i', s: r.s.slice(0, k), t: r.t },
      { k: 'i', s: r.s.slice(k), t: r.t },
    ]
  return [
    { k: r.k, from: r.from, n: k },
    { k: r.k, from: r.from + k, n: r.n - k },
  ]
}

/** The edited text: O(text + runs). */
function textOf(edit: Edit, text: string): string {
  const out: string[] = []
  for (const runs of edit.blocks) {
    for (const r of runs) {
      if (r.k === 'o') out.push(text.slice(r.from, r.from + r.n))
      else if (r.k === 'i') out.push(r.s)
    }
  }
  return out.join('')
}

/**
 * Where each of `points` (original points, ascending, none past the text's end) went: one sweep
 * of the runs, which hold the original points in order. O(runs + points).
 */
function pointsOf(edit: Edit, points: readonly number[]): number[] {
  const out: number[] = new Array(points.length)
  let p = 0
  let acc = 0
  for (const runs of edit.blocks) {
    for (const r of runs) {
      SPLICE_WORK.steps++
      if (r.k === 'i') {
        acc += r.s.length
        continue
      }
      while (p < points.length && (points[p] as number) < r.from + r.n) {
        SPLICE_WORK.steps++
        out[p] = acc + (r.k === 'o' ? (points[p] as number) - r.from : 0)
        p++
      }
      if (r.k === 'o') acc += r.n
    }
  }
  return out
}

/**
 * The shortest text every splice of `splices` applies to (in order): what an edit needs of a
 * text it is not given.
 */
function lengthFor(splices: readonly Splice[]): number {
  let length = 0
  let grown = 0
  for (const sp of splices) {
    length = Math.max(length, sp.at + sp.del - grown)
    grown += sp.ins.length - sp.del
  }
  return length
}

/**
 * `text` with `splices` applied in order, each against the text the one before it left. Throws
 * `RangeError` for a splice that reaches past the end of the text it applies to. Never a copy
 * of the text per splice: O(text + splices × (splices / 32 + 32)).
 */
export function applySplices(text: string, splices: readonly Splice[]): string {
  if (splices.length === 0) return text
  return textOf(editOf(text.length, splices, null), text)
}

/**
 * `marks` carried through `splices` (applied in order), normalized: text inserted inside a mark
 * or at its end takes it, at its start does not; a mark whose text is all deleted goes (and
 * text typed in its place is plain); same-`t` marks a deletion brings together merge. Each end
 * is carried through the splices once, as a point (a point where text is inserted goes after
 * it, which is the rule for both ends), so the cost is the splices' and a sort of the ends:
 * never splices × marks. Text of a splice that says what it takes (`takes`) takes that instead.
 */
export function mapMarks(marks: readonly Mark[], splices: readonly Splice[]): Mark[] {
  const said = splices.some((s) => s.takes)
  if (splices.length === 0 || (marks.length === 0 && !said)) return normalizeMarks(marks)
  // The text is not given: any length that holds the marks and lets every splice apply will do.
  let length = lengthFor(splices)
  for (const m of marks) length = Math.max(length, m.to)
  const ends = [...new Set(marks.flatMap((m) => [m.from, m.to]))].sort((a, b) => a - b)
  const edit = editOf(length, splices, null)
  const at = pointsOf(edit, ends)
  const moved = new Map<number, number>()
  for (let k = 0; k < ends.length; k++) moved.set(ends[k] as number, at[k] as number)
  let out: Mark[] = []
  for (const m of marks) {
    const from = moved.get(m.from) as number
    const to = moved.get(m.to) as number
    if (from < to) out.push({ t: m.t, from, to })
  }
  if (said) {
    // Each run of said text: every type present off it (card types are open-ended: those of
    // `marks`, which are all `out` can hold), then the ones it takes on.
    const types = typesOf(marks)
    const off: Mark[] = []
    const on: Mark[] = []
    let p = 0
    for (const runs of edit.blocks) {
      for (const r of runs) {
        const n = charsOf(r)
        if (r.k === 'i' && r.t) {
          for (const t of types) off.push({ t, from: p, to: p + n })
          for (const t of r.t) on.push({ t, from: p, to: p + n })
        }
        p += n
      }
    }
    out = [...subtractMarks(out, off), ...on]
  }
  return normalizeMarks(out)
}

/**
 * The mark types `lists` hold, each once, in code-unit order (`'b' < 'c:…' < 'i'`): the types a
 * per-type walk goes over, since card types are not a fixed list. O(marks).
 */
function typesOf(
  ...lists: readonly (readonly Mark[] | readonly Mark['t'][] | undefined)[]
): Mark['t'][] {
  const seen = new Set<Mark['t']>()
  for (const list of lists) {
    if (!list) continue
    for (const m of list) seen.add(typeof m === 'string' ? m : m.t)
  }
  return [...seen].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/**
 * `marks` sorted by `(t, from)`, with same-`t` ranges that overlap or touch merged and empty
 * ranges dropped: the one form a block's marks are stored in, so equal formatting is equal data.
 */
export function normalizeMarks(marks: readonly Mark[]): Mark[] {
  const sorted = marks
    .filter((m) => m.from < m.to)
    .sort((x, y) => (x.t < y.t ? -1 : x.t > y.t ? 1 : x.from - y.from))
  const out: Mark[] = []
  for (const m of sorted) {
    const last = out[out.length - 1]
    if (last !== undefined && last.t === m.t && m.from <= last.to) {
      if (m.to > last.to) out[out.length - 1] = { t: last.t, from: last.from, to: m.to }
    } else out.push({ t: m.t, from: m.from, to: m.to })
  }
  return out
}

/** Whether `marks` are normalized and within a text of `length`: what the invariant asks. */
export function marksSound(marks: readonly Mark[], length: number): boolean {
  for (let k = 0; k < marks.length; k++) {
    const m = marks[k] as Mark
    if (!(m.from >= 0 && m.from < m.to && m.to <= length)) return false
    const p = marks[k - 1]
    if (p !== undefined && !(p.t < m.t || (p.t === m.t && p.to < m.from))) return false
  }
  return true
}

/**
 * `a` without the characters `b` marks, per `t`; normalized. One sweep of both, normalized
 * first: O((a + b) log), never a × b.
 */
export function subtractMarks(a: readonly Mark[], b: readonly Mark[]): Mark[] {
  const xs = normalizeMarks(a)
  const ys = normalizeMarks(b)
  const out: Mark[] = []
  let j = 0
  for (const m of xs) {
    // Past the `b` marks wholly before `m` (of an earlier `t`, or ending at or before it).
    while (j < ys.length) {
      const r = ys[j] as Mark
      if (r.t < m.t || (r.t === m.t && r.to <= m.from)) j++
      else break
    }
    let from = m.from
    for (let k = j; k < ys.length; k++) {
      const r = ys[k] as Mark
      if (r.t !== m.t || r.from >= m.to) break
      if (r.from > from) out.push({ t: m.t, from, to: r.from })
      from = Math.max(from, r.to)
      if (from >= m.to) break
    }
    if (from < m.to) out.push({ t: m.t, from, to: m.to })
  }
  return out
}

/** `marks` within `[from, to)`, moved by `shift` (normalized marks stay normalized). */
export function sliceMarks(
  marks: readonly Mark[],
  from: number,
  to: number,
  shift: number,
): Mark[] {
  const out: Mark[] = []
  for (const m of marks) {
    const a = Math.max(m.from, from)
    const b = Math.min(m.to, to)
    if (a < b) out.push({ t: m.t, from: a + shift, to: b + shift })
  }
  return out
}

/** The splices that undo `splices` applied to `text`: in reverse order, each one turned around. */
export function invertSplices(text: string, splices: readonly Splice[]): Splice[] {
  const { deleted } = editOf(text.length, splices, text)
  const out: Splice[] = splices.map((s, k) => ({
    at: s.at,
    del: s.ins.length,
    ins: deleted[k] as string,
  }))
  return out.reverse()
}

/**
 * `list` with `next` (against the text `list` left) appended, merged into the last splice when it
 * continues it: typing (or deleting forward) right after its inserted text, saying the same of
 * the marks it takes (`takes`), or deleting back into it. Keystrokes in one place stay one splice.
 */
export function appendSplice(list: readonly Splice[], next: Splice): Splice[] {
  if (next.del === 0 && next.ins.length === 0) return [...list]
  const last = list[list.length - 1]
  if (last !== undefined) {
    const end = last.at + last.ins.length
    let merged: Splice | null = null
    if (next.at === end && (!last.ins || !next.ins || String(last.takes) === String(next.takes))) {
      merged = {
        ...(next.ins ? next : last),
        at: last.at,
        del: last.del + next.del,
        ins: last.ins + next.ins,
      }
    } else if (next.ins.length === 0 && next.at < end && next.at + next.del === end) {
      merged =
        next.at >= last.at
          ? { ...last, ins: last.ins.slice(0, next.at - last.at) }
          : { at: next.at, del: last.del + (last.at - next.at), ins: '' }
    }
    if (merged !== null) {
      const head = list.slice(0, -1)
      if (merged.del > 0 || merged.ins.length > 0) head.push(merged)
      return head
    }
  }
  return [...list, next]
}

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff

/**
 * The splice that turns `a` into `b`: everything between their common prefix and suffix, never
 * through the middle of an astral character. None when they are equal. For the `block-stale`
 * recovery (a block's confirmed text against the one fetched).
 */
export function diffSplices(a: string, b: string): Splice[] {
  if (a === b) return []
  const most = Math.min(a.length, b.length)
  let p = 0
  while (p < most && a.charCodeAt(p) === b.charCodeAt(p)) p++
  if (p > 0 && isHigh(a.charCodeAt(p - 1))) p--
  let s = 0
  while (s < most - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++
  if (s > 0 && isLow(a.charCodeAt(a.length - s))) s--
  return [{ at: p, del: a.length - p - s, ins: b.slice(p, b.length - s) }]
}

/**
 * `splices`, an edit of a block whose marks are `marks`, with the marks each one's text takes
 * there by the marks' rule, one per splice (null where it types nothing): what the page
 * says of its typing (`block.edit` `takes`). O(splices × marks).
 */
export function stateTakes(
  marks: readonly Mark[],
  splices: readonly Splice[],
): { splices: Splice[]; takes?: Takes } {
  let now = normalizeMarks(marks)
  const plain = splices.map(({ at, del, ins }) => ({ at, del, ins }))
  const takes = plain.map((sp) => {
    now = mapMarks(now, [sp])
    if (sp.ins.length === 0) return null
    const on = (t: Mark['t']) => now.some((m) => m.t === t && m.from <= sp.at && sp.at < m.to)
    // The types present (card types too), in code-unit order.
    return typesOf(now).filter(on)
  })
  return takes.some((t) => t !== null) ? { splices: plain, takes } : { splices: plain }
}
