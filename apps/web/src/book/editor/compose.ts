import type { EditorChange, EditorSplice } from './BookEditor'
import { mapCaret } from './dom'
import { type BookModel, diffText } from './model'

/**
 * A composition (or a dead key) while remote changes arrive (ADR-0007): what each change held to
 * its end did to where the composed text lives, and that text rebased past them all at the end.
 */

/** What a remote change did to the composition's block, kept to rebase the composed text. */
export type Held =
  | { t: 'splices'; splices: EditorSplice[] }
  | { t: 'split'; at: number; newId: string; tail: boolean }
  | { t: 'merge'; into: string; shift: number }
  | { t: 'delete'; index: number }

export interface Comp {
  /** The composing element's block; its DOM is left alone until the composition ends. */
  id: string
  /** Its text when the composition started. */
  base: string
  /** What the composition replaces of `base`: `[start, end)`, the selection it began over. */
  start: number
  end: number
  /** Composing inside the one host (a selection across blocks was deleted first). */
  span: boolean
  /** Where the composition's text lives in the model now, and its `start` there. */
  target: string
  pos: number
  gone: boolean
  ops: Held[]
  /** Blocks whose DOM waits for the end: the composing one and any a held change named. */
  stale: Set<string>
  touched: boolean
}

export const idsOf = (c: EditorChange): string[] => {
  switch (c.t) {
    case 'merge':
      return [c.from, c.into]
    case 'split':
      return [c.id, c.newId]
    case 'create':
      return c.after === null ? [c.id] : [c.id, c.after]
    default:
      return [c.id]
  }
}

/**
 * A remote change while composing, to a block whose DOM waits for the end: into the model now,
 * noting what it did to where the composition's text lives.
 */
export function hold(model: BookModel, k: Comp, c: EditorChange): void {
  const shift = c.t === 'merge' ? (model.get(c.into)?.text.length ?? 0) : 0
  const index = c.t === 'delete' ? model.indexOf(c.id) : -1
  if (!model.apply(c)) return
  k.touched = true
  for (const id of idsOf(c)) k.stale.add(id)
  if (k.gone) return
  if (c.t === 'edit' && c.id === k.target) {
    for (const s of c.splices) k.pos = mapCaret(k.pos, s)
    k.ops.push({ t: 'splices', splices: c.splices })
  } else if (c.t === 'split' && c.id === k.target) {
    // Exactly at the split's point, the composition stays with the head, where it is shown.
    const tail = k.pos > c.at
    if (tail) {
      k.pos -= c.at
      k.target = c.newId
    }
    k.ops.push({ t: 'split', at: c.at, newId: c.newId, tail })
  } else if (c.t === 'merge' && c.from === k.target) {
    k.pos += shift
    k.target = c.into
    k.ops.push({ t: 'merge', into: c.into, shift })
  } else if (c.t === 'delete' && c.id === k.target) {
    k.gone = true
    k.ops.push({ t: 'delete', index })
  }
}

/**
 * What the composition did to its block's text: from where it began, `[start, end)` of the base
 * replaced by what the block shows there now (the DOM outside it is left alone while it runs);
 * or, when the rest of the block changed too (the browser's own correction), the plain diff.
 */
export function composed(k: Comp, text: string, caret: number | undefined): EditorSplice | null {
  const tail = k.base.length - k.end
  const insLen = text.length - k.start - tail
  if (
    insLen >= 0 &&
    text.slice(0, k.start) === k.base.slice(0, k.start) &&
    text.slice(text.length - tail) === k.base.slice(k.end)
  ) {
    const ins = text.slice(k.start, k.start + insLen)
    return ins === '' && k.end === k.start ? null : { at: k.start, del: k.end - k.start, ins }
  }
  return diffText(k.base, text, caret)
}

/**
 * Where the composed splice `mine` goes past the held changes: its block (`target`; `gone`, the
 * index the block had, when it was deleted meanwhile), and its range `[at, end)` there.
 */
export function rebaseComposed(
  k: Comp,
  mine: EditorSplice | null,
): { target: string; gone: number; at: number; end: number } {
  let target = k.id
  let gone = -1
  let at = mine?.at ?? k.pos
  let end = mine === null ? at : mine.at + mine.del
  for (const op of k.ops) {
    if (op.t === 'splices')
      for (const s of op.splices) {
        at = mapCaret(at, s)
        end = Math.max(at, mapCaret(end, s))
      }
    else if (op.t === 'split') {
      if (op.tail) {
        at = Math.max(0, at - op.at)
        end = Math.max(at, end - op.at)
        target = op.newId
      } else end = Math.min(end, op.at)
    } else if (op.t === 'merge') {
      at += op.shift
      end += op.shift
      target = op.into
    } else gone = op.index
  }
  return { target, gone, at, end }
}
